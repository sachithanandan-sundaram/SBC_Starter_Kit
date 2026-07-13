"""
ai_server.py
------------
Voyager SDK inference server.
Endpoints:
  GET  /health
  GET  /deployed-models
  POST /deploy
  GET  /deploy/status
  POST /inference/start
  POST /inference/stop
  GET  /inference/status
  GET  /inference/stream/{slot}   MJPEG live view, annotated (multipart/x-mixed-replace)
  GET  /inference/raw/{slot}      MJPEG live view, raw/pre-overlay
  GET  /hls/slot-{n}/index.m3u8
  GET  /hls/slot-{n}/{segment}
  POST /models/upload-weights
  POST /models/upload-dataset
"""

import asyncio
import json
import os
import re
import queue
import shutil
import subprocess
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path

from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from ai_inference import (
    start_session,
    stop_session,
    get_status,
    get_hub_for_slot,
    get_raw_hub_for_slot,
    shutdown_handler,
    SESSIONS,
)

app = FastAPI(title="Voyager SDK", version="1.0.0")

SDK_DIR    = Path(os.getenv("SDK_DIR", "/home/voyager-sdk"))
LOG_DIR    = SDK_DIR / "deploy_logs"
HLS_ROOT   = Path("/app/data/hls")
STATE_FILE = SDK_DIR / "deployed_models.json"

LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── State ─────────────────────────────────────────────────────────────────────

DEPLOYMENTS:   dict = {}
DEPLOY_LOCK        = threading.Lock()
DEPLOYED_MODELS: dict = {}
DEPLOYED_LOCK      = threading.Lock()


# ── Persistence ───────────────────────────────────────────────────────────────

def _load_deployed_models() -> dict:
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text())
    except Exception as e:
        print(f"[state] Failed to load {STATE_FILE}: {e}")
    return {}


def _save_deployed_models(models: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(models, indent=2))
    except Exception as e:
        print(f"[state] Failed to save {STATE_FILE}: {e}")


DEPLOYED_MODELS = _load_deployed_models()


# ── Schemas ───────────────────────────────────────────────────────────────────

class DeployRequest(BaseModel):
    deploy_id: str
    model_name: str
    yaml_content: str


class InferenceStartRequest(BaseModel):
    run_id: str
    slot_id: int                              # base slot; writer i → slot_id + i
    source_type: str
    source: Optional[str] = None              # legacy single-camera field
    sources: Optional[list[str]] = None        # NEW: multi-camera
    network: str


class InferenceStopRequest(BaseModel):
    run_id: str


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/deployed-models")
def get_deployed_models():
    with DEPLOYED_LOCK:
        return dict(DEPLOYED_MODELS)


def _metis_driver_version() -> Optional[str]:
    """Read the Metis AIPU DKMS driver version if exposed by the host kernel.
    Present on the Metis Compute Board (RK3588 BSP), where the driver is
    installed on the SBC host (not inside this container) per the Metis
    Compute Board User Guide sec. 3.4. Absence just means the sysfs path
    isn't visible here (e.g. no bind mount) — not necessarily an error."""
    for path in ("/sys/class/metis/version", "/sys/class/metis/metis0/version"):
        try:
            p = Path(path)
            if p.exists():
                return p.read_text(encoding="utf-8", errors="ignore").strip()
        except Exception:
            pass
    return None


@app.get("/health")
def health():
    with DEPLOY_LOCK:
        active = sum(
            1 for d in DEPLOYMENTS.values()
            if not d.get("already_deployed") and d["process"] is not None
            and d["process"].poll() is None
        )
    return {
        "status":             "ok",
        "service":            "voyager-sdk",
        "active_deployments": active,
        "active_sessions":    len(SESSIONS),
        "metis_driver_version": _metis_driver_version(),
    }


# ── Deploy ────────────────────────────────────────────────────────────────────

@app.post("/deploy")
def deploy(request: DeployRequest):
    model_name = request.model_name.strip().lower().replace(" ", "_")
    model_dir  = SDK_DIR / "customers" / model_name
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "models").mkdir(exist_ok=True)

    yaml_file = model_dir / f"{model_name}.yaml"
    try:
        yaml_file.write_text(request.yaml_content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(500, f"Failed to write YAML: {e}")

    with DEPLOYED_LOCK:
        if model_name in DEPLOYED_MODELS:
            existing  = DEPLOYED_MODELS[model_name]
            deploy_id = request.deploy_id
            with DEPLOY_LOCK:
                DEPLOYMENTS[deploy_id] = {
                    "process":          None,
                    "queue":            queue.Queue(),
                    "log_path":         existing.get("log_path", ""),
                    "started_at":       datetime.now(),
                    "completed_at":     datetime.now(),
                    "already_deployed": True,
                }
            print(f"[deploy] {model_name} already compiled — skipping")
            return {"status": "already_deployed", "deploy_id": deploy_id, "pid": -1}

    log_path = LOG_DIR / f"{request.deploy_id}.log"
    try:
        log_file = open(log_path, "w")
    except Exception as e:
        raise HTTPException(500, f"Cannot create log file: {e}")

    try:
        process = subprocess.Popen(
            ["python3", "deploy.py", str(yaml_file)],
            cwd=str(SDK_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except Exception as e:
        log_file.close()
        raise HTTPException(500, f"Failed to start deploy.py: {e}")

    log_queue: queue.Queue = queue.Queue()

    with DEPLOY_LOCK:
        DEPLOYMENTS[request.deploy_id] = {
            "process":      process,
            "queue":        log_queue,
            "log_path":     str(log_path),
            "started_at":   datetime.now(),
            "completed_at": None,
        }

    def _read_logs():
        try:
            for line in process.stdout:
                log_queue.put(line)
                try:
                    log_file.write(line)
                    log_file.flush()
                except Exception:
                    pass
        finally:
            log_queue.put(None)
            log_file.close()
            with DEPLOY_LOCK:
                if request.deploy_id in DEPLOYMENTS:
                    DEPLOYMENTS[request.deploy_id]["completed_at"] = datetime.now()

    threading.Thread(target=_read_logs, daemon=True).start()
    return {"status": "deploying", "deploy_id": request.deploy_id, "pid": process.pid}


@app.get("/deploy/status")
def deploy_status(deploy_id: str):
    with DEPLOY_LOCK:
        if deploy_id not in DEPLOYMENTS:
            raise HTTPException(404, "deploy_id not found")
        d = DEPLOYMENTS[deploy_id]

    if d.get("already_deployed"):
        return {
            "deploy_id": deploy_id,
            "done":      True,
            "exit_code": 0,
            "progress":  100.0,
            "stage":     "completed",
            "log":       "Model already compiled — skipped redeployment.",
        }

    log_path = d["log_path"]
    process  = d["process"]

    log_text = ""
    if Path(log_path).exists():
        try:
            log_text = Path(log_path).read_text(errors="replace")
        except Exception as e:
            log_text = f"Error reading log: {e}"

    done      = process.poll() is not None
    exit_code = process.poll()
    progress  = _extract_progress(log_text)
    stage     = _extract_stage(log_text)

    if done and exit_code == 0 and (progress is None or progress < 100):
        progress = 100.0
        stage    = "completed"

    if done and exit_code == 0:
        parts = Path(log_path).stem.rsplit("-", 1)
        if len(parts) == 2:
            model_name = parts[0]
            with DEPLOYED_LOCK:
                if model_name not in DEPLOYED_MODELS:
                    DEPLOYED_MODELS[model_name] = {
                        "deploy_id":   deploy_id,
                        "log_path":    log_path,
                        "deployed_at": datetime.now().isoformat(),
                    }
                    _save_deployed_models(DEPLOYED_MODELS)
                    print(f"[state] saved {model_name} to {STATE_FILE}")

    return {
        "deploy_id": deploy_id,
        "done":      done,
        "exit_code": exit_code,
        "progress":  progress,
        "stage":     stage,
        "log":       log_text[-3000:],
    }


# ── Inference ─────────────────────────────────────────────────────────────────

@app.post("/inference/start")
def inference_start(request: InferenceStartRequest):
    if request.run_id in SESSIONS:
        stop_session(request.run_id)
        time.sleep(0.5)

    if request.sources:
        # New multi-camera path: connect directly to each camera URL.
        sources = request.sources
    elif request.source:
        # Legacy single-source path: voyager-sdk has always read from the
        # MediaMTX relay here regardless of source_type/source (the original
        # inference_worker didn't even accept a `source` arg) — this keeps
        # per-model inference sessions decoupled from the raw input type
        # (USB/file/RTSP are all normalized into MediaMTX upstream of this
        # call). Preserve that behavior exactly for backward compatibility.
        from ai_inference import RTSP_URL
        sources = [RTSP_URL]
    else:
        raise HTTPException(400, "Either 'source' or 'sources' must be provided")

    try:
        start_session(
            run_id=request.run_id,
            source_type=request.source_type,
            sources=sources,
            network_yaml=request.network,
            base_slot=request.slot_id,
        )
    except Exception as e:
        raise HTTPException(400, str(e))

    slots = list(range(request.slot_id, request.slot_id + len(sources)))
    return {
        "status":   "started",
        "run_id":   request.run_id,
        "slot_id":  request.slot_id,
        "slots":    slots,
        "hls_url":  f"/hls/slot-{request.slot_id}/index.m3u8",
        "hls_urls": [f"/hls/slot-{s}/index.m3u8" for s in slots],
    }


@app.post("/inference/stop")
def inference_stop(request: InferenceStopRequest):
    # stop_session() already scopes teardown to THIS session's pgid (a
    # graceful stop_event-driven exit first, so the SDK's own finally block
    # releases the AIPU device cleanly, falling back to os.killpg only if it
    # doesn't exit in time). A blanket `pkill -9 -f wginference` used to run
    # here unconditionally afterward — it would kill every OTHER active
    # session's worker too (e.g. concurrent per-model sessions in the
    # single-camera/multi-model flow), which is exactly what stop_session's
    # own pgid-scoped kill is designed to avoid. Removed.
    if not stop_session(request.run_id):
        raise HTTPException(404, f"Session {request.run_id} not found")

    return {"status": "stopped", "run_id": request.run_id}


@app.get("/inference/status")
def inference_status():
    return {"sessions": get_status()}


# ── MJPEG live view ────────────────────────────────────────────────────────────
#
# HLSWriter (kept running for recording — see recordings.py) is inherently
# high-latency: encode to H.264, segment to disk, wait for the HLS player to
# have enough segments buffered. The inference worker already has the
# annotated JPEG for every frame sitting in a queue — serve those directly as
# multipart/x-mixed-replace instead, which an <img> tag "just works" with.
# Latency drops to about one frame + network, since there's no segmenting or
# re-encode at all. Bandwidth is higher than H.264 (JPEG per frame,
# uncompressed relative to inter-frame coding) — fine at 8fps/720p on a LAN;
# if it's heavy with 4 cameras, lower HLS_QUALITY or _target_fps() in
# ai_inference.py rather than reaching for --frame-rate (crashes mppvideodec).

MJPEG_BOUNDARY   = "frame"
MJPEG_POLL_SECS  = 1.0    # how often the generator yields control back to asyncio
MJPEG_IDLE_LIMIT = 10.0   # give up if the hub itself has produced nothing this long


def _mjpeg_response(hub) -> StreamingResponse:
    # Must be a genuine async generator, NOT a sync generator run in a
    # threadpool. A sync generator blocked in q.get() cannot be interrupted
    # by asyncio task cancellation — Starlette can only stop *awaiting* it,
    # not actually unblock the underlying thread — so when a browser
    # disconnects (tab closed, <img> remounted by MjpegPlayer's retry-on-
    # error), the thread just keeps blocking on q.get(), which keeps
    # returning real frames every ~125ms forever, so the 10s "idle" timeout
    # below never fires either. That leaks one FrameHub subscriber (and one
    # threadpool worker) PER abandoned connection, permanently: FrameHub's
    # per-frame fan-out loop gets slower as the zombie list grows, which
    # backs up frame_queues, which is exactly the mechanism that causes
    # camera-to-screen latency to climb over a session's lifetime. Polling
    # with `await asyncio.to_thread(...)` yields control back to the event
    # loop every MJPEG_POLL_SECS, so a real client disconnect is noticed and
    # cancels this generator (running hub.unsubscribe(q) in the finally)
    # within about a second, regardless of whether frames keep flowing.
    async def _gen():
        q = hub.subscribe()
        idle = 0.0
        try:
            while idle < MJPEG_IDLE_LIMIT:
                try:
                    jpeg = await asyncio.to_thread(q.get, True, MJPEG_POLL_SECS)
                    idle = 0.0
                except queue.Empty:
                    idle += MJPEG_POLL_SECS
                    continue
                yield (
                    b"--" + MJPEG_BOUNDARY.encode() + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                    + jpeg + b"\r\n"
                )
        finally:
            hub.unsubscribe(q)

    return StreamingResponse(
        _gen(),
        media_type=f"multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY}",
        headers={"Cache-Control": "no-store, no-cache"},
    )


@app.get("/inference/stream/{slot}")
async def inference_mjpeg_stream(slot: int):
    hub = get_hub_for_slot(slot)
    if hub is None:
        raise HTTPException(404, f"No active inference stream for slot {slot}")
    return _mjpeg_response(hub)


@app.get("/inference/raw/{slot}")
async def raw_mjpeg_stream(slot: int):
    """Phase 3: per-camera raw (pre-overlay) MJPEG, captured from the same
    frame before draw_overlays_bgr runs — no extra ffmpeg process, and stays
    frame-synced with the annotated tile since both come from the same
    inference_worker iteration."""
    hub = get_raw_hub_for_slot(slot)
    if hub is None:
        raise HTTPException(404, f"No active raw stream for slot {slot}")
    return _mjpeg_response(hub)


# ── HLS file serving ──────────────────────────────────────────────────────────

@app.get("/hls/slot-{slot}/index.m3u8")
def hls_playlist(slot: int):
    playlist = HLS_ROOT / f"slot-{slot}" / "index.m3u8"
    if not playlist.exists():
        raise HTTPException(404, "Playlist not ready")
    return FileResponse(str(playlist), media_type="application/vnd.apple.mpegurl",
                        headers={"Cache-Control": "no-store, no-cache"})


@app.get("/hls/slot-{slot}/{segment}")
def hls_segment(slot: int, segment: str):
    if "/" in segment or segment.startswith("."):
        raise HTTPException(400, "Invalid segment name")
    slot_dir  = (HLS_ROOT / f"slot-{slot}").resolve()
    file_path = (slot_dir / segment).resolve()
    if not str(file_path).startswith(str(slot_dir)):
        raise HTTPException(400, "Path traversal rejected")
    if not file_path.exists():
        raise HTTPException(404, "Segment not found")
    media_type = "video/mp2t" if segment.endswith(".ts") else "application/vnd.apple.mpegurl"
    return FileResponse(str(file_path), media_type=media_type,
                        headers={"Cache-Control": "no-store, no-cache"})


# ── Custom model file upload ──────────────────────────────────────────────────

@app.post("/models/upload-weights")
async def upload_weights(model_name: str = Form(...), file: UploadFile = File(...)):
    """Save uploaded .pt to /home/voyager-sdk/customers/{model_name}/models/"""
    model_name = model_name.strip().lower().replace(" ", "_")
    dest_dir   = SDK_DIR / "customers" / model_name / "models"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path  = dest_dir / f"{model_name}.pt"

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")

    dest_path.write_bytes(data)
    print(f"[upload] weights saved: {dest_path} ({len(data)//1024} KB)")
    return {"status": "ok", "path": str(dest_path)}


@app.post("/models/upload-dataset")
async def upload_dataset(dataset_name: str = Form(...), file: UploadFile = File(...)):
    """Extract YOLO dataset zip to /home/voyager-sdk/data/{dataset_name}/"""
    dataset_name = dataset_name.strip().lower().replace(" ", "_")
    data_root    = SDK_DIR / "data"
    data_root.mkdir(parents=True, exist_ok=True)
    dest_dir     = data_root / dataset_name

    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    zip_data = await file.read()
    if not zip_data:
        raise HTTPException(400, "Empty zip")

    tmp_zip = data_root / f"_tmp_{dataset_name}.zip"
    tmp_zip.write_bytes(zip_data)

    try:
        with zipfile.ZipFile(tmp_zip, "r") as zf:
            members = zf.namelist()
            # Detect common top-level folder prefix to strip (e.g. "model/train/..." → "train/...")
            top_dirs = {m.split("/")[0] for m in members if "/" in m}
            non_root = [m for m in members if not m.endswith("/") and "/" in m]
            # If all files share one top-level folder, strip it
            strip_prefix = ""
            if len(top_dirs) == 1:
                prefix = top_dirs.pop() + "/"
                if all(m.startswith(prefix) or m == prefix.rstrip("/") for m in members):
                    strip_prefix = prefix

            for member in members:
                stripped = member[len(strip_prefix):] if strip_prefix and member.startswith(strip_prefix) else member
                if not stripped or stripped.endswith("/"):
                    continue
                target = dest_dir / stripped
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(target, "wb") as dst:
                    dst.write(src.read())
    except Exception as e:
        raise HTTPException(400, f"Failed to extract zip: {e}")
    finally:
        tmp_zip.unlink(missing_ok=True)

    # Find data.yaml → extract nc + names → write labels.txt
    data_yaml_candidates = list(dest_dir.rglob("data.yaml"))
    labels_path = dest_dir / "labels.txt"
    nc    = 0
    names = []

    if data_yaml_candidates:
        import yaml as _yaml
        try:
            with open(data_yaml_candidates[0]) as f:
                dy = _yaml.safe_load(f)
            nc    = dy.get("nc", 0)
            names = dy.get("names", [])
            if isinstance(names, dict):
                names = [names[k] for k in sorted(names.keys())]
            labels_path.write_text("\n".join(str(n) for n in names))
            print(f"[upload] dataset extracted: {dest_dir} ({nc} classes)")
        except Exception as e:
            print(f"[upload] warning: could not parse data.yaml: {e}")
    else:
        print(f"[upload] warning: no data.yaml found in zip")

    return {
        "status":      "ok",
        "path":        str(dest_dir),
        "nc":          nc,
        "names":       names,
        "labels_path": str(labels_path),
    }


# ── Progress helpers ──────────────────────────────────────────────────────────

def _extract_progress(log: str):
    if not log:                                      return 0.0
    if "Successfully deployed network" in log:       return 100.0
    if "Compiling" in log or "Compile" in log:
        bar_match = re.findall(r"\|[█ ]+\|", log)
        if bar_match:
            last   = bar_match[-1]
            filled = last.count("█")
            total  = filled + last.count(" ")
            if total > 0:
                return round(90 + (filled / total) * 9, 1)
        return 90.0
    if "Successfully prequantized" in log:           return 88.0
    if "Prequantizing" in log:                       return 85.0
    if "Finished quantizing" in log:                 return 82.0
    if "Calibrating" in log:
        pct = re.findall(r"\|\s*(\d+)%", log)
        return round(10 + int(pct[-1]) * 0.7, 1) if pct else 10.0
    if "Loading" in log or "Preparing" in log:       return 5.0
    return 2.0


def _extract_stage(log: str) -> str:
    if not log:                                      return "initializing"
    if "Successfully deployed network" in log:       return "completed"
    if "Compiling" in log or "Compile" in log:       return "compiling"
    if "Successfully prequantized" in log:           return "prequantized"
    if "Prequantizing" in log:                       return "prequantizing"
    if "Finished quantizing" in log:                 return "quantized"
    if "Calibrating" in log:                         return "calibrating"
    if "Loading" in log or "Preparing" in log:       return "loading"
    return "running"


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)