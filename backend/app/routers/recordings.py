"""
recordings.py router
--------------------
FFmpeg-based recording, per camera and per stream type.

Two recording "kinds":
  raw       — the untouched camera feed. Recorded by stream-copying directly
              from the camera's RTSP URL (bypassing MediaMTX/HLS entirely) when
              the active source is RTSP — this is what makes it work in
              multi-camera mode, where MediaMTX isn't used at all. USB / Video
              File sources still record from the MediaMTX raw HLS (slot 1),
              since there's no RTSP URL to copy from directly.
  inference — the annotated feed for a given slot (2-5), copied from the local
              HLS file the backend already has via its bind mount
              (/tmp/hls/slot-N/index.m3u8) — no HTTP round-trip.

Multiple recordings can run concurrently (e.g. raw+inference for several
cameras at once); each gets its own ffmpeg process tracked by session_id.

Endpoints:
  POST   /api/recordings/start          Start a raw or inference recording
  POST   /api/recordings/stop           Stop and finalize MP4
  POST   /api/recordings/pause          Pause recording
  POST   /api/recordings/resume         Resume recording
  GET    /api/recordings/active         List currently-running recordings
  GET    /api/recordings/list           List saved recording files
  GET    /api/recordings/pick-folder    Compatibility endpoint
"""

import asyncio
import logging
import os
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.config import settings
from app.state import get_app_state
from app.routers.stream import INFERENCE_HLS, MEDIAMTX_HLS, _slots, _multi_camera_session

logger = logging.getLogger(__name__)
router = APIRouter(tags=["recordings"])

HOST_ROOT = Path(os.environ.get("HOST_ROOT", "/host"))

_BLOCKED_PREFIXES = [
    "/etc", "/sys", "/proc", "/dev", "/boot", "/usr", "/bin", "/sbin", "/lib",
]


def _resolve_save_path(save_path: Optional[str], *, require_absolute: bool = False) -> Path:
    if not save_path:
        if require_absolute:
            raise HTTPException(400, "Save path is required and must be absolute (e.g. /home/user/recordings)")
        return settings.recordings_path

    if not save_path.startswith("/"):
        raise HTTPException(400, f"Save path must be an absolute host path, got: {save_path!r}")

    clean = os.path.normpath(save_path)
    if ".." in clean.split(os.sep):
        raise HTTPException(400, "Invalid path: path traversal detected")

    for blocked in _BLOCKED_PREFIXES:
        if clean == blocked or clean.startswith(blocked + "/"):
            raise HTTPException(400, f"Writing to {blocked} is not allowed")

    return HOST_ROOT / clean.lstrip("/")


def _ensure_writable(directory: Path) -> None:
    try:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / f".write_test_{uuid.uuid4().hex[:8]}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except Exception as e:
        raise HTTPException(400, f"Save folder is not writable: {directory} ({e})")


def _make_filename(kind: str, camera_index: int) -> str:
    """<timestamp>_cam<N>_<raw|inference>.mp4 — includes seconds (unlike the
    minute-only example in the design doc) so recordings started within the
    same minute (e.g. several cameras kicked off together) don't collide."""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{timestamp}_cam{camera_index}_{kind}.mp4"


# ── Recording input resolution ────────────────────────────────────────────────

class _RecordingInput:
    def __init__(self, kind: str, value: str):
        self.kind  = kind    # "rtsp" | "mediamtx_hls" | "hls_file"
        self.value = value


def _resolve_inference_input(slot: int) -> _RecordingInput:
    if not 2 <= slot <= 5:
        raise HTTPException(400, "slot must be 2-5 for inference recording")
    playlist = INFERENCE_HLS / f"slot-{slot}" / "index.m3u8"
    if not playlist.exists():
        raise HTTPException(400, f"Slot {slot} has no active inference stream")
    try:
        if ".ts" not in playlist.read_text():
            raise HTTPException(400, f"Slot {slot} has no active inference stream")
    except OSError:
        raise HTTPException(400, f"Slot {slot} has no active inference stream")
    return _RecordingInput("hls_file", str(playlist))


def _resolve_raw_input(camera_index: int) -> _RecordingInput:
    session = _multi_camera_session
    if session.get("active") and session.get("sources"):
        sources = session["sources"]
        if not 0 <= camera_index < len(sources):
            raise HTTPException(400, f"camera_index must be 0-{len(sources) - 1}")
        return _RecordingInput("rtsp", sources[camera_index])

    # Legacy single-camera path — only camera 0 exists.
    if camera_index != 0:
        raise HTTPException(400, "No multi-camera session active; camera_index must be 0")

    app_state = get_app_state()
    source_type, source_value = app_state.get_source()
    if not source_type or not source_value:
        raise HTTPException(400, "No active stream to record")

    if source_type == "RTSP":
        return _RecordingInput("rtsp", source_value)

    # USB / Video File — no separate "original" worth bypassing to; record
    # from the MediaMTX raw HLS the same way it's always worked.
    if not _slots[1].running:
        raise HTTPException(400, "Slot 1 has no active raw stream")
    return _RecordingInput("mediamtx_hls", f"{MEDIAMTX_HLS}/index.m3u8")


# ── Session tracking ──────────────────────────────────────────────────────────

class RecordingSession:
    def __init__(self, session_id: str, kind: str, camera_index: int,
                 slot: Optional[int], filename: str, save_dir: Path):
        self.session_id    = session_id
        self.kind           = kind
        self.camera_index   = camera_index
        self.slot           = slot
        self.filename       = filename
        self.filepath       = save_dir / filename
        self.process: Optional[subprocess.Popen] = None
        self.start_time: Optional[float] = None
        self.paused         = False


_sessions: dict[str, RecordingSession] = {}
_sessions_lock = threading.Lock()


# ── Schemas ───────────────────────────────────────────────────────────────────

class RecordingStartRequest(BaseModel):
    kind: Literal["raw", "inference"] = "inference"
    slot: Optional[int] = None            # required for kind == "inference" (2-5)
    camera_index: int = 0                 # 0-based; used for kind == "raw"
    save_path: str


class RecordingStartResponse(BaseModel):
    session_id: str
    filename: str
    kind: str
    camera_index: int
    slot: Optional[int] = None


class SessionRequest(BaseModel):
    session_id: str


class RecordingControlResponse(BaseModel):
    session_id: str
    status: str


class ActiveRecordingInfo(BaseModel):
    session_id: str
    kind: str
    camera_index: int
    slot: Optional[int] = None
    filename: str
    elapsed_seconds: float
    paused: bool


# ── FFmpeg launch ─────────────────────────────────────────────────────────────

async def _launch_ffmpeg(session: RecordingSession, rec_input: _RecordingInput) -> None:
    if rec_input.kind == "rtsp":
        # Direct camera copy — never re-encode (software x264 on this board
        # runs slower than real-time and the source falls behind and
        # disconnects). Fragmented mp4 so a killed/interrupted recording still
        # produces a playable file (otherwise the moov atom never gets
        # written and the file is corrupt).
        cmd = [
            "ffmpeg", "-y",
            "-rtsp_transport", settings.rtsp_transport,
            "-i", rec_input.value,
            "-c", "copy",
            "-f", "mp4",
            "-movflags", "+faststart+frag_keyframe+empty_moov",
            str(session.filepath),
        ]
    elif rec_input.kind == "mediamtx_hls":
        cmd = [
            "ffmpeg", "-y",
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "5",
            "-i", rec_input.value,
            "-c", "copy",
            "-movflags", "+faststart",
            str(session.filepath),
        ]
    else:  # hls_file — local inference HLS, already H.264
        cmd = [
            "ffmpeg", "-y",
            "-i", rec_input.value,
            "-c", "copy",
            "-movflags", "+faststart",
            str(session.filepath),
        ]

    logger.info("[rec:%s] FFmpeg: %s", session.session_id[:8], " ".join(cmd))

    session.filepath.parent.mkdir(parents=True, exist_ok=True)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    session.process    = proc
    session.start_time = time.time()

    def _drain():
        if proc.stderr:
            try:
                for line in proc.stderr:
                    if line.strip():
                        logger.debug("[rec:%s] %s", session.session_id[:8], line.rstrip())
            except Exception:
                pass
    threading.Thread(target=_drain, daemon=True).start()

    await asyncio.sleep(2)

    if proc.poll() is not None:
        raise RuntimeError(
            f"FFmpeg exited immediately (kind={rec_input.kind}, input={rec_input.value})"
        )

    logger.info("[rec:%s] Recording started — kind=%s cam=%d file=%s",
                session.session_id[:8], session.kind, session.camera_index, session.filename)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/recordings/start", response_model=RecordingStartResponse)
async def start_recording(request: RecordingStartRequest):
    save_dir = _resolve_save_path(request.save_path, require_absolute=True)
    _ensure_writable(save_dir)

    if request.kind == "inference":
        if request.slot is None:
            raise HTTPException(400, "slot is required for inference recording")
        rec_input = _resolve_inference_input(request.slot)
    else:
        rec_input = _resolve_raw_input(request.camera_index)

    filename   = _make_filename(request.kind, request.camera_index)
    session_id = str(uuid.uuid4())
    session    = RecordingSession(session_id, request.kind, request.camera_index,
                                   request.slot, filename, save_dir)

    with _sessions_lock:
        _sessions[session_id] = session

    try:
        await _launch_ffmpeg(session, rec_input)
    except Exception as e:
        with _sessions_lock:
            _sessions.pop(session_id, None)
        raise HTTPException(500, f"Failed to start recording: {e}")

    return RecordingStartResponse(
        session_id=session_id, filename=filename, kind=request.kind,
        camera_index=request.camera_index, slot=request.slot,
    )


@router.post("/recordings/stop")
async def stop_recording(request: SessionRequest):
    with _sessions_lock:
        session = _sessions.get(request.session_id)

    if not session:
        raise HTTPException(404, f"Session not found: {request.session_id}")

    started_at = session.start_time or time.time()

    if session.process:
        try:
            # If paused, must resume before stopping so FFmpeg can gracefully shutdown
            if session.paused:
                try:
                    session.process.send_signal(signal.SIGCONT)
                    time.sleep(0.2)  # Give process time to wake up
                except Exception:
                    pass

            session.process.send_signal(signal.SIGINT)
            session.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            session.process.kill()
            session.process.wait(timeout=2)
        except Exception:
            pass

    duration = max(0.0, time.time() - started_at)

    with _sessions_lock:
        _sessions.pop(request.session_id, None)

    logger.info("[rec:%s] Stopped — file=%s duration=%.1fs", request.session_id[:8], session.filename, duration)

    return {
        "filename":         session.filename,
        "path":             str(session.filepath),
        "duration_seconds": duration,
    }


@router.post("/recordings/pause", response_model=RecordingControlResponse)
def pause_recording(request: SessionRequest):
    with _sessions_lock:
        session = _sessions.get(request.session_id)

    if not session or not session.process or session.process.poll() is not None:
        raise HTTPException(404, "Active recording session not found")

    try:
        session.process.send_signal(signal.SIGSTOP)
        session.paused = True
    except Exception as e:
        raise HTTPException(500, f"Failed to pause: {e}")

    return RecordingControlResponse(session_id=request.session_id, status="paused")


@router.post("/recordings/resume", response_model=RecordingControlResponse)
def resume_recording(request: SessionRequest):
    with _sessions_lock:
        session = _sessions.get(request.session_id)

    if not session or not session.process or session.process.poll() is not None:
        raise HTTPException(404, "Active recording session not found")

    try:
        session.process.send_signal(signal.SIGCONT)
        session.paused = False
    except Exception as e:
        raise HTTPException(500, f"Failed to resume: {e}")

    return RecordingControlResponse(session_id=request.session_id, status="recording")


@router.get("/recordings/active")
def list_active_recordings():
    now = time.time()
    with _sessions_lock:
        sessions = list(_sessions.values())
    return {
        "sessions": [
            ActiveRecordingInfo(
                session_id=s.session_id,
                kind=s.kind,
                camera_index=s.camera_index,
                slot=s.slot,
                filename=s.filename,
                elapsed_seconds=max(0.0, now - (s.start_time or now)),
                paused=s.paused,
            )
            for s in sessions
        ]
    }


@router.get("/recordings/pick-folder")
def pick_folder():
    recordings_root = settings.recordings_path
    recordings_root.mkdir(parents=True, exist_ok=True)
    return {"path": str(recordings_root)}


@router.get("/recordings/list")
def list_recordings(save_path: str = Query(None)):
    recordings_root = _resolve_save_path(save_path)
    recordings_root.mkdir(parents=True, exist_ok=True)
    files = []
    try:
        for p in sorted(recordings_root.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True):
            stat = p.stat()
            files.append({
                "filename": p.name,
                "size_mb":  round(stat.st_size / (1024 * 1024), 2),
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
    except Exception as e:
        logger.error("Error listing recordings: %s", e)
    return {"files": files}
