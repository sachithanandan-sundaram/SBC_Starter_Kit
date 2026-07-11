"""
ai_inference.py
---------------
Session management and HLS writer for voyager-sdk.

Architecture (MediaMTX-based):
  All sources → MediaMTX (rtsp://127.0.0.1:8554/live)
  Inference reads from RTSP directly via wginference.init
  HLSWriter encodes annotated frames → /tmp/hls/slot-N/

No frame writer, no directory buffer, no GStreamer init issues.
17.5fps proven on RPi5 with RTSP source.
"""

import os
import signal

os.environ.setdefault("AXELERA_FRAMEWORK", os.getenv("SDK_DIR", "/home/voyager-sdk"))
os.environ["GST_PLUGIN_FEATURE_RANK"] = "kmssink:0,waylandsink:0,ximagesink:0,xvimagesink:0"
os.environ["GST_GL_PLATFORM"]         = "egl"
os.environ["GST_GL_XINITTHREADS"]     = "0"
os.environ.pop("DISPLAY", None)

import cv2
import time
import yaml
import logging
import threading
import subprocess
import shutil
from multiprocessing import Process, Queue, Value, Event
from pathlib import Path
from queue import Empty, Full

HLS_ROOT      = os.getenv("HLS_ROOT", "/tmp/hls")
HLS_TIME      = 1
HLS_LIST_SIZE = 5
HLS_QUALITY   = 55
SDK_DIR       = os.getenv("SDK_DIR", "/home/voyager-sdk")
RTSP_URL      = os.getenv("RTSP_URL", "rtsp://127.0.0.1:8554/live")

_active_sessions = Value('i', 0)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
)
logger = logging.getLogger("voyager-inference")

SESSIONS: dict = {}

COCO_CLASS_MAP = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 4: "airplane",
    5: "bus", 6: "train", 7: "truck", 8: "boat", 9: "traffic light",
    10: "fire hydrant", 11: "stop sign", 12: "parking meter", 13: "bench",
    14: "bird", 15: "cat", 16: "dog", 17: "horse", 18: "sheep", 19: "cow",
    20: "elephant", 21: "bear", 22: "zebra", 23: "giraffe", 24: "backpack",
    25: "umbrella", 26: "handbag", 27: "tie", 28: "suitcase", 29: "frisbee",
    30: "skis", 31: "snowboard", 32: "sports ball", 33: "kite",
    34: "baseball bat", 35: "baseball glove", 36: "skateboard", 37: "surfboard",
    38: "tennis racket", 39: "bottle", 40: "wine glass", 41: "cup",
    42: "fork", 43: "knife", 44: "spoon", 45: "bowl", 46: "banana",
    47: "apple", 48: "sandwich", 49: "orange", 50: "broccoli", 51: "carrot",
    52: "hot dog", 53: "pizza", 54: "donut", 55: "cake", 56: "chair",
    57: "couch", 58: "potted plant", 59: "bed", 60: "dining table",
    61: "toilet", 62: "tv", 63: "laptop", 64: "mouse", 65: "remote",
    66: "keyboard", 67: "cell phone", 68: "microwave", 69: "oven",
    70: "toaster", 71: "sink", 72: "refrigerator", 73: "book", 74: "clock",
    75: "vase", 76: "scissors", 77: "teddy bear", 78: "hair drier",
    79: "toothbrush",
}


# ── Class map loader ─────────────────────────────────────────────────────────

def _load_class_map(network_yaml: str) -> dict:
    """
    Parse network YAML → find data_dir_name → load data.yaml → return class map.
    Falls back to COCO_CLASS_MAP if dataset name contains 'coco' or on any error.
    """
    try:
        with open(network_yaml, "r") as f:
            net = yaml.safe_load(f)

        datasets = net.get("datasets", {})
        data_dir_name = None
        for ds_key, ds_val in datasets.items():
            if isinstance(ds_val, dict) and "data_dir_name" in ds_val:
                data_dir_name = ds_val["data_dir_name"]
                logger.info("Found data_dir_name='%s' (key=%s) in %s", data_dir_name, ds_key, network_yaml)
                break

        if not data_dir_name:
            logger.warning("No data_dir_name found in %s — using COCO class map", network_yaml)
            return COCO_CLASS_MAP

        # COCO shortcut
        if "coco" in data_dir_name.lower():
            logger.info("Dataset '%s' is COCO — using hardcoded class map", data_dir_name)
            return COCO_CLASS_MAP

        # Primary path: /home/voyager-sdk/data/{data_dir_name}/data.yaml
        data_root = Path(SDK_DIR) / "data"
        data_yaml_path = data_root / data_dir_name / "data.yaml"
        logger.info("Looking for data.yaml at: %s", data_yaml_path)

        # Fallback: search recursively under data_root for data.yaml in a dir matching name
        if not data_yaml_path.exists():
            logger.warning("Not found at primary path, searching under %s", data_root)
            candidates = list(data_root.rglob("data.yaml"))
            logger.info("data.yaml candidates found: %s", candidates)
            if candidates:
                # Pick the one whose parent dir name matches data_dir_name
                matched = [c for c in candidates if c.parent.name == data_dir_name]
                data_yaml_path = matched[0] if matched else candidates[0]
                logger.info("Using data.yaml: %s", data_yaml_path)
            else:
                logger.warning("No data.yaml found anywhere under %s — using COCO", data_root)
                return COCO_CLASS_MAP

        with open(data_yaml_path, "r") as f:
            dy = yaml.safe_load(f)

        names = dy.get("names", [])
        if isinstance(names, dict):
            names = [names[k] for k in sorted(names.keys())]

        if not names:
            logger.warning("No class names in %s — using COCO class map", data_yaml_path)
            return COCO_CLASS_MAP

        class_map = {i: str(n) for i, n in enumerate(names)}
        logger.info("Loaded class map: %s", class_map)
        return class_map

    except Exception as e:
        logger.warning("Failed to load class map from %s: %s — using COCO", network_yaml, e)
        return COCO_CLASS_MAP


# ── FPS control ───────────────────────────────────────────────────────────────

def _target_fps() -> int:
    return 8


# ── Frame helpers ─────────────────────────────────────────────────────────────

def encode_jpeg(frame, quality=HLS_QUALITY):
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else None


def push_frame(q: Queue, jpeg: bytes):
    try:
        q.put_nowait(jpeg)
    except Full:
        try:
            q.get_nowait()
        except Empty:
            pass
        try:
            q.put_nowait(jpeg)
        except Full:
            pass


# ── HLS Writer ────────────────────────────────────────────────────────────────

class HLSWriter:
    def __init__(self, run_id: str, slot_id: int, frame_queue: Queue):
        self.run_id      = run_id
        self.slot_id     = slot_id
        self.frame_queue = frame_queue
        self.out_dir     = os.path.join(HLS_ROOT, f"slot-{slot_id}")
        self.playlist    = os.path.join(self.out_dir, "index.m3u8")
        self._ffmpeg     = None
        self._thread     = None
        self._stop       = threading.Event()

    def start(self):
        os.makedirs(self.out_dir, exist_ok=True)
        for f in os.listdir(self.out_dir):
            try:
                os.remove(os.path.join(self.out_dir, f))
            except Exception:
                pass

        fps = _target_fps()
        cmd = [
            "ffmpeg", "-loglevel", "warning",
            "-f", "image2pipe", "-vcodec", "mjpeg",
            "-r", str(fps), "-i", "pipe:0",
            "-vsync", "vfr",
            "-vf", "scale=1280:720:force_original_aspect_ratio=decrease",
            "-vcodec", "libx264",
            "-preset", "ultrafast", "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-b:v", "600k",
            "-maxrate", "800k",
            "-bufsize", "1200k",
            "-g", str(fps),
            "-sc_threshold", "0", "-bf", "0",
            "-f", "hls",
            "-hls_time", str(HLS_TIME),
            "-hls_list_size", str(HLS_LIST_SIZE),
            "-hls_flags", "delete_segments+independent_segments+temp_file",
            "-hls_segment_filename", os.path.join(self.out_dir, "seg%05d.ts"),
            self.playlist,
        ]

        self._ffmpeg = subprocess.Popen(
            cmd, stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )

        def _log():
            for line in self._ffmpeg.stderr:
                logger.debug("[HLS:%s] %s", self.run_id, line.decode(errors="replace").rstrip())
        threading.Thread(target=_log, daemon=True).start()

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._pump, daemon=True, name=f"hls-{self.run_id}"
        )
        self._thread.start()
        logger.info("[HLS:%s] started → %s (fps=%d)", self.run_id, self.playlist, fps)

    def _pump(self):
        while not self._stop.is_set():
            if self._ffmpeg.poll() is not None:
                break
            try:
                jpeg = self.frame_queue.get(timeout=1.0)
            except Empty:
                continue
            try:
                self._ffmpeg.stdin.write(jpeg)
                self._ffmpeg.stdin.flush()
            except (BrokenPipeError, OSError):
                break

    def wait_for_playlist(self, timeout: float = 30.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(self.playlist):
                try:
                    with open(self.playlist) as f:
                        if ".ts" in f.read():
                            return True
                except Exception:
                    pass
            time.sleep(0.3)
        return False

    def stop(self):
        self._stop.set()
        if self._ffmpeg:
            try:
                self._ffmpeg.stdin.close()
            except Exception:
                pass
            try:
                self._ffmpeg.terminate()
                self._ffmpeg.wait(timeout=5)
            except Exception:
                try:
                    self._ffmpeg.kill()
                except Exception:
                    pass
            self._ffmpeg = None
        try:
            shutil.rmtree(self.out_dir)
        except Exception:
            pass


# ── Inference worker ──────────────────────────────────────────────────────────

def inference_worker(run_id: str, network_yaml: str, slot_id: int,
                     frame_queue: Queue, stop_event):
    """
    Reads from MediaMTX RTSP stream via wginference.init.
    Proven working at 17.5fps on RPi5.
    No frame buffer, no directory source, no GStreamer init issues.
    """
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    logger.info("[%s] inference worker starting (slot=%d)", run_id, slot_id)

    try:
        import wginference
        from axelera.app import config, yaml_parser, inf_tracers

        # Load class map dynamically from dataset yaml
        class_map = _load_class_map(network_yaml)
        wginference.set_class_map(class_map)
        logger.info("[%s] class map set: %s", run_id, class_map)

        parser       = config.create_inference_argparser(yaml_parser.get_network_yaml_info())
        total_frames = 0

        # GStreamer handle for teardown between stream restarts. Axelera's own
        # inference.py calls stream.stop() + Gst.deinit() in a finally block on
        # every exit; without this the previous pipeline's stream-id stays
        # registered and the next init aborts with
        # "inplace_addstreamid: meta_key already exists".
        try:
            import gi
            gi.require_version("Gst", "1.0")
            from gi.repository import Gst
        except Exception:
            Gst = None

        while not stop_event.is_set():
            stream = None
            try:
                logger.info("[%s] connecting to %s", run_id, RTSP_URL)
                args    = parser.parse_args([
                    network_yaml,
                    RTSP_URL,
                    "--no-display",
                    "--rtsp-latency", "0",
                ])
                tracers = inf_tracers.create_tracers_from_args(args)
                stream  = wginference.init(args, tracers)
                logger.info("[%s] stream initialized", run_id)
                # Track wginference child pids so we only kill OUR process on stop
                _my_wginference_pids = set()
                try:
                    import psutil
                    me = psutil.Process(os.getpid())
                    for c in me.children(recursive=True):
                        if "wginference" in " ".join(c.cmdline()):
                            _my_wginference_pids.add(c.pid)
                except Exception:
                    pass

                for fr in stream:
                    if stop_event.is_set():
                        break
                    if fr is None or fr.image is None:
                        continue

                    frame = fr.image.asarray('BGR').copy()
                    frame, _, _ = wginference.draw_overlays_bgr(frame, fr.meta)
                    jpeg = encode_jpeg(frame)
                    if jpeg:
                        push_frame(frame_queue, jpeg)

                    total_frames += 1
                    if total_frames % 200 == 0:
                        logger.info("[%s] %d frames processed", run_id, total_frames)

                if not stop_event.is_set():
                    logger.info("[%s] stream ended — restarting in 2s", run_id)
                    time.sleep(2)

            except Exception as e:
                if stop_event.is_set():
                    break
                err_str = str(e)
                # MediaMTX down or auth error — wait longer before retry
                if "authentication" in err_str.lower() or "NoneType" in err_str or "connection" in err_str.lower():
                    logger.warning("[%s] MediaMTX unavailable: %s — waiting 8s", run_id, e)
                    for _ in range(16):  # 8s in 0.5s chunks so stop_event is checked
                        if stop_event.is_set():
                            break
                        time.sleep(0.5)
                else:
                    logger.warning("[%s] error: %s — retrying in 3s", run_id, e)
                    for _ in range(6):
                        if stop_event.is_set():
                            break
                        time.sleep(0.5)
            finally:
                # Release the stream and fully tear down GStreamer so the next
                # init starts clean (mirrors inference.py's finally block).
                if stream is not None:
                    try:
                        stream.stop()
                    except Exception as te:
                        logger.debug("[%s] stream.stop() failed: %s", run_id, te)
                if Gst is not None:
                    try:
                        if Gst.is_initialized():
                            Gst.deinit()
                    except Exception as ge:
                        logger.debug("[%s] Gst.deinit() failed: %s", run_id, ge)

    except Exception:
        logger.exception("[%s] inference worker crashed", run_id)
        raise


# ── Session management ────────────────────────────────────────────────────────

def start_session(run_id: str, source_type: str, source: str,
                  network_yaml: str, slot_id: int) -> bool:
    if run_id in SESSIONS:
        raise Exception(f"Session {run_id} already exists")

    with _active_sessions.get_lock():
        _active_sessions.value += 1

    frame_queue = Queue(maxsize=30)
    stop_event  = Event()

    process = Process(
        target=inference_worker,
        args=(run_id, network_yaml, slot_id, frame_queue, stop_event),
        daemon=False,
    )
    process.start()

    # Move process into its own process group and store pgid for clean kill
    pgid = None
    for _ in range(10):
        try:
            os.setpgid(process.pid, process.pid)
            pgid = process.pid
            break
        except OSError:
            time.sleep(0.05)

    hls = HLSWriter(run_id, slot_id, frame_queue)
    hls.start()

    SESSIONS[run_id] = {
        "process":     process,
        "pgid":        pgid,
        "hls":         hls,
        "stop_event":  stop_event,
        "slot_id":     slot_id,
        "source_type": source_type,
        "source":      source,
        "network":     network_yaml,
    }

    # Watchdog: restart the inference process if it crashes (e.g. std::system_error from wginference)
    def _watchdog():
        while not stop_event.is_set():
            proc = SESSIONS.get(run_id, {}).get("process")
            if proc and not proc.is_alive() and not stop_event.is_set():
                exitcode = proc.exitcode
                logger.warning("[%s] process died (exitcode=%s) — restarting", run_id, exitcode)
                # Wait for AIPU to settle
                time.sleep(3)
                if stop_event.is_set():
                    break
                try:
                    new_proc = Process(
                        target=inference_worker,
                        args=(run_id, network_yaml, slot_id, frame_queue, stop_event),
                        daemon=False,
                    )
                    new_proc.start()
                    new_pgid = None
                    for _ in range(10):
                        try:
                            os.setpgid(new_proc.pid, new_proc.pid)
                            new_pgid = new_proc.pid
                            break
                        except OSError:
                            time.sleep(0.05)
                    if run_id in SESSIONS:
                        SESSIONS[run_id]["process"] = new_proc
                        SESSIONS[run_id]["pgid"]    = new_pgid
                    logger.info("[%s] restarted (pid=%d)", run_id, new_proc.pid)
                except Exception as e:
                    logger.error("[%s] watchdog restart failed: %s", run_id, e)
                    break
            time.sleep(1)

    threading.Thread(target=_watchdog, daemon=True, name=f"watchdog-{run_id}").start()

    logger.info("[%s] session started (pid=%d, slot=%d)", run_id, process.pid, slot_id)
    return True


def stop_session(run_id: str) -> bool:
    if run_id not in SESSIONS:
        return False

    session = SESSIONS.pop(run_id)

    with _active_sessions.get_lock():
        _active_sessions.value = max(0, _active_sessions.value - 1)

    session["stop_event"].set()

    proc = session["process"]
    pgid = session.get("pgid")

    if proc.is_alive():
        # Kill entire process group using stored pgid
        if pgid:
            try:
                os.killpg(pgid, signal.SIGKILL)
                logger.info("[%s] killed process group %d", run_id, pgid)
            except Exception as e:
                logger.warning("[%s] killpg failed: %s", run_id, e)
        # Also direct kill as fallback
        try:
            proc.kill()
        except Exception:
            pass
        proc.join(timeout=3)

    # Small pause to let the process fully exit before cleanup
    time.sleep(0.5)

    # Kill only wginference children of THIS session's process group
    # DO NOT pkill -9 all wginference — that kills other active sessions
    if pgid:
        try:
            # Kill any remaining processes in our group
            os.killpg(pgid, signal.SIGKILL)
        except Exception:
            pass

    # Give AIPU driver time to release cores
    time.sleep(3)

    hls = session.get("hls")
    if hls:
        hls.stop()

    logger.info("[%s] session stopped", run_id)
    return True


def get_status() -> list:
    return [
        {
            "run_id":   rid,
            "slot_id":  s["slot_id"],
            "pid":      s["process"].pid,
            "alive":    s["process"].is_alive(),
            "exitcode": s["process"].exitcode,
            "playlist": s["hls"].playlist,
            "source":   s["source"],
            "network":  s["network"],
        }
        for rid, s in SESSIONS.items()
    ]


def shutdown_handler(sig=None, frame=None):
    logger.info("Shutting down all inference sessions")
    for rid in list(SESSIONS.keys()):
        try:
            stop_session(rid)
        except Exception:
            logger.exception("Error stopping session %s", rid)


if threading.current_thread() is threading.main_thread():
    signal.signal(signal.SIGINT,  shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)
