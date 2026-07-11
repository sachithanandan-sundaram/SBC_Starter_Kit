"""
recordings.py router
--------------------
FFmpeg-based recording for all streaming slots.

Slot 1  (raw)      → reads from MediaMTX HLS over HTTP
Slots 2-5 (inference) → reads from /tmp/hls/slot-N/index.m3u8

Endpoints:
  POST   /api/recordings/start          Start recording
  POST   /api/recordings/stop           Stop and finalize MP4
  POST   /api/recordings/pause          Pause recording
  POST   /api/recordings/resume         Resume recording
  GET    /api/recordings/list           List sessions
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
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.config import settings
from app.routers.stream import INFERENCE_HLS, MEDIAMTX_HLS, _slots

logger = logging.getLogger(__name__)
router = APIRouter(tags=["recordings"])

HOST_ROOT = Path(os.environ.get("HOST_ROOT", "/host"))

_BLOCKED_PREFIXES = [
    "/etc", "/sys", "/proc", "/dev", "/boot", "/usr", "/bin", "/sbin", "/lib",
]


def _resolve_save_path(save_path: Optional[str]) -> Path:
    if not save_path:
        return settings.recordings_path

    clean = os.path.normpath(save_path)
    if ".." in clean.split(os.sep):
        raise HTTPException(400, "Invalid path: path traversal detected")

    for blocked in _BLOCKED_PREFIXES:
        if clean == blocked or clean.startswith(blocked + "/"):
            raise HTTPException(400, f"Writing to {blocked} is not allowed")

    return HOST_ROOT / clean.lstrip("/")


def _make_filename(slot: int, model_name: str) -> str:
    """
    Build the recording filename.

    Slot 1 (raw stream):
        RawStream_YYYY-MM-DD_HH-MM-SS.mp4

    Slots 2-5 (model/inference), display slot = internal slot - 1:
        <ModelName>_slot<display_slot>_YYYY-MM-DD_HH-MM-SS.mp4

    model_name is sanitised to remove characters unsafe in filenames.
    """
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

    if slot == 1:
        return f"RawStream_{timestamp}.mp4"

    # Sanitise model name: keep alphanumerics, hyphens, underscores
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in model_name).strip("_")
    if not safe_name:
        safe_name = "model"

    display_slot = slot - 1  # internal slot 2 → display slot 1, etc.
    return f"{safe_name}_slot{display_slot}_{timestamp}.mp4"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hls_url_for_slot(slot: int) -> str:
    if slot == 1:
        return f"{MEDIAMTX_HLS}/index.m3u8"
    else:
        return str(INFERENCE_HLS / f"slot-{slot}" / "index.m3u8")


def _slot_is_active(slot: int) -> bool:
    if slot == 1:
        return _slots[1].running
    playlist = INFERENCE_HLS / f"slot-{slot}" / "index.m3u8"
    if not playlist.exists():
        return False
    try:
        return ".ts" in playlist.read_text()
    except Exception:
        return False


# ── Session tracking ──────────────────────────────────────────────────────────

class RecordingSession:
    def __init__(self, session_id: str, slot: int, filename: str, save_path: Optional[str] = None):
        self.session_id  = session_id
        self.slot        = slot
        self.filename    = filename
        self.filepath    = _resolve_save_path(save_path) / filename
        self.process: Optional[subprocess.Popen] = None
        self.start_time: Optional[float] = None
        self.paused      = False


_sessions: dict[str, RecordingSession] = {}
_sessions_lock = threading.Lock()


# ── Schemas ───────────────────────────────────────────────────────────────────

class RecordingStartRequest(BaseModel):
    slot: int
    model_name: Optional[str] = "model"   # frontend sends the displayed model name
    save_path: Optional[str] = None


class RecordingStartResponse(BaseModel):
    session_id: str
    filename: str
    slot: int


class SessionRequest(BaseModel):
    session_id: str


class RecordingControlResponse(BaseModel):
    session_id: str
    status: str


# ── FFmpeg launch ─────────────────────────────────────────────────────────────

async def _launch_ffmpeg(session: RecordingSession) -> None:
    hls_input = _hls_url_for_slot(session.slot)
    is_http   = hls_input.startswith("http")

    input_flags = []
    if is_http:
        input_flags = [
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_delay_max", "5",
        ]

    cmd = [
        "ffmpeg", "-y",
        *input_flags,
        "-i", hls_input,
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
        raise RuntimeError(f"FFmpeg exited immediately (slot {session.slot}, input={hls_input})")

    logger.info("[rec:%s] Recording started — slot=%d file=%s", session.session_id[:8], session.slot, session.filename)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/recordings/start", response_model=RecordingStartResponse)
async def start_recording(request: RecordingStartRequest):
    if not 1 <= request.slot <= 5:
        raise HTTPException(400, "Slot must be 1-5")

    if not _slot_is_active(request.slot):
        raise HTTPException(400, f"Slot {request.slot} has no active stream")

    filename   = _make_filename(request.slot, request.model_name or "model")
    session_id = str(uuid.uuid4())
    session    = RecordingSession(session_id, request.slot, filename, request.save_path)

    with _sessions_lock:
        _sessions[session_id] = session

    try:
        await _launch_ffmpeg(session)
    except Exception as e:
        with _sessions_lock:
            _sessions.pop(session_id, None)
        raise HTTPException(500, f"Failed to start recording: {e}")

    return RecordingStartResponse(session_id=session_id, filename=filename, slot=request.slot)


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