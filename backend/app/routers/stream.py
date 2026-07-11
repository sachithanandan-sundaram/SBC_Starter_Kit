"""
stream.py — Stream management with MediaMTX + FFmpeg.

Architecture:
  All sources → FFmpeg → MediaMTX (rtsp://localhost:8554/live)
  MediaMTX → HLS :8888/live  (fMP4 / LL-HLS, version 10)
  MediaMTX master playlist:  /live/index.m3u8  → references stream.m3u8
  MediaMTX variant playlist: /live/stream.m3u8 → references *.mp4 segments
  voyager-sdk reads rtsp://127.0.0.1:8554/live for inference
  Inference output → /tmp/hls/slot-N/ (slots 2-5)
"""

import asyncio
import glob
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import settings
from app.state import get_app_state

logger = logging.getLogger(__name__)
router = APIRouter(tags=["stream"])

VOYAGER_BASE    = settings.voyager_sdk_url
# NOTE: MediaMTX runs on the host (not in a container) on both the Raspberry
# Pi 5 and the Metis Compute Board. The backend container reaches it via the
# docker bridge gateway IP, which is configurable (see config.py) because it
# is not guaranteed to be the same address on every host/docker install.
MEDIAMTX_RTSP   = f"rtsp://{settings.mediamtx_host}:{settings.mediamtx_rtsp_port}/live"
MEDIAMTX_HLS    = f"http://{settings.mediamtx_host}:{settings.mediamtx_hls_port}/live"
INFERENCE_HLS   = Path("/tmp/hls")     # slots 2-5 inference output
RECORDINGS_ROOT = Path("/app/data/recordings")
UPLOADS_ROOT    = Path("/app/data/uploads")
MAX_SLOTS       = 5
MAX_MULTI_CAMERAS = MAX_SLOTS - 1      # slots 2..5 → up to 4 camera tiles


# ── Slot state ────────────────────────────────────────────────────────────────

class SlotState:
    def __init__(self):
        self.source_type: Optional[str]  = None
        self.source_value: Optional[str] = None
        self.ffmpeg_process: Optional[subprocess.Popen] = None
        self.running: bool = False
        self.lock = threading.Lock()


# ── Persistent HTTP client for MediaMTX proxying ─────────────────────────────
_mediamtx_client: Optional[httpx.AsyncClient] = None


def _get_mediamtx_client() -> httpx.AsyncClient:
    global _mediamtx_client
    if _mediamtx_client is None:
        _mediamtx_client = httpx.AsyncClient(timeout=10)
    return _mediamtx_client


async def _close_mediamtx_client() -> None:
    global _mediamtx_client
    if _mediamtx_client is not None:
        await _mediamtx_client.aclose()
        _mediamtx_client = None


_slots: dict[int, SlotState] = {i: SlotState() for i in range(1, MAX_SLOTS + 1)}

# Tracks the currently active multi-camera (one model, N RTSP sources) session
# so /stream/status can report it and the frontend can rebuild the grid across
# a page refresh — voyager-sdk inference sessions otherwise aren't reflected
# anywhere in `_slots` (that dict only tracks the slot-1 ffmpeg→MediaMTX push).
_multi_camera_session: dict = {
    "active":          False,
    "source_type":     None,
    "sources":         [],
    "inference_slots": [],
    "raw_slot":        1,
}


def _clear_multi_camera_session() -> None:
    _multi_camera_session.update({
        "active":          False,
        "source_type":     None,
        "sources":         [],
        "inference_slots": [],
    })


# ── Schemas ───────────────────────────────────────────────────────────────────

class StreamStartRequest(BaseModel):
    source_type: str
    source_value: Optional[str] = None
    sources: Optional[list[str]] = None   # NEW: multi-camera, one model on N RTSP sources


class SlotStartRequest(BaseModel):
    source_type: str
    source_value: str


class CameraInfo(BaseModel):
    index: int
    name: str
    device: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _allowed_video_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


def _allowed_hls_asset(asset_name: str) -> bool:
    return Path(asset_name).suffix.lower() in {".m3u8", ".ts", ".mp4"}


def _media_type_for(asset_name: str) -> str:
    suffix = Path(asset_name).suffix.lower()
    if suffix == ".m3u8":
        return "application/vnd.apple.mpegurl"
    if suffix == ".mp4":
        return "video/mp4"
    return "video/mp2t"


def _resolve_upload_dir() -> Path:
    try:
        UPLOADS_ROOT.mkdir(parents=True, exist_ok=True)
        probe = UPLOADS_ROOT / ".write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return UPLOADS_ROOT
    except Exception:
        fallback = Path("/tmp/uploads")
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def _resolve_source(source_type: str, source_value: str) -> str:
    if source_type == "USB":
        if not source_value.startswith("/dev/"):
            return f"/dev/video{source_value}"
        return source_value
    if source_type == "Video File":
        p = Path(source_value)
        if p.is_absolute() and p.exists():
            return str(p)
        candidate = UPLOADS_ROOT / p.name
        if candidate.exists():
            return str(candidate)
        raise HTTPException(404, f"Video file not found: {source_value}")
    return source_value


def _validate_slot(slot: int) -> None:
    if not 1 <= slot <= MAX_SLOTS:
        raise HTTPException(400, f"Slot must be 1-{MAX_SLOTS}")


def _inference_hls_dir(slot: int) -> Path:
    d = INFERENCE_HLS / f"slot-{slot}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _inference_hls_asset_path(slot: int, asset_name: str) -> Path:
    if "/" in asset_name or asset_name.startswith("."):
        raise HTTPException(400, "Invalid asset name")
    if not _allowed_hls_asset(asset_name):
        raise HTTPException(400, "Only .m3u8, .ts, and .mp4 assets supported")
    root      = _inference_hls_dir(slot).resolve()
    candidate = (root / asset_name).resolve()
    if not str(candidate).startswith(str(root)):
        raise HTTPException(400, "Invalid asset path")
    if not candidate.exists():
        raise HTTPException(404, f"Asset not found: {asset_name}")
    return candidate


def _input_flags(source_type: str, source: str) -> list[str]:
    if source_type == "RTSP":
        return ["-rtsp_transport", settings.rtsp_transport, "-fflags", "nobuffer", "-flags", "low_delay", "-i", source]
    if source_type == "USB":
        return ["-f", "v4l2", "-framerate", "30", "-video_size", "1280x720", "-i", source]
    return ["-re", "-stream_loop", "-1", "-i", source]


def _build_mediamtx_push_cmd(source_type: str, source: str) -> list[str]:
    input_flags = _input_flags(source_type, source)

    # RTSP cameras already deliver H.264, so stream-copy it straight through
    # to MediaMTX. This avoids a CPU-heavy software re-encode (which on this
    # board runs slower than real-time and makes the source fall behind and
    # disconnect). USB / video-file sources are raw or non-H.264, so those
    # still need a real encode.
    if source_type == "RTSP":
        codec_flags = ["-c:v", "copy"]
    else:
        codec_flags = [
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
            "-c:v", "libx264",
            "-preset", "fast",
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-r", "25",
            "-b:v", "3500k",
            "-maxrate", "4000k",
            "-bufsize", "3500k",
            "-g", "50",
        ]

    return [
        "ffmpeg", "-y",
    ] + input_flags + codec_flags + [
        "-an",
        "-f", "rtsp",
        MEDIAMTX_RTSP,
    ]


def _drain_stderr(proc: subprocess.Popen, label: str) -> None:
    def _read():
        if proc.stderr:
            try:
                for line in proc.stderr:
                    if line.strip():
                        logger.debug("[%s] %s", label, line.rstrip())
            except Exception:
                pass
    threading.Thread(target=_read, daemon=True).start()


async def _wait_for_mediamtx_hls(timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                resp = await client.get(f"{MEDIAMTX_HLS}/index.m3u8")
                if resp.status_code == 200 and "#EXTM3U" in resp.text:
                    logger.info("MediaMTX HLS ready")
                    return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    logger.error("MediaMTX HLS not ready after %.1fs", timeout)
    return False


def _stop_slot(slot: int) -> None:
    state = _slots[slot]
    with state.lock:
        if state.ffmpeg_process:
            state.ffmpeg_process.terminate()
            try:
                state.ffmpeg_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                state.ffmpeg_process.kill()
                state.ffmpeg_process.wait(timeout=1)
            state.ffmpeg_process = None
        state.running      = False
        state.source_type  = None
        state.source_value = None
    logger.info("Slot %d stopped", slot)


async def _cleanup_inference_slots() -> None:
    """
    Clean up all inference slots (2-5):
    1. Stop all voyager-sdk inference sessions
    2. Clear HLS output directories
    3. Wait for cleanup to complete
    
    This ensures a clean state when switching input types or stopping streams.
    """
    # Any previously active multi-camera session is being torn down here
    # (either replaced by a new stream or explicitly stopped) — clear it so
    # /stream/status stops reporting a dead session.
    _clear_multi_camera_session()

    # Stop all voyager inference sessions
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{VOYAGER_BASE}/inference/status")
            if resp.status_code == 200:
                sessions = resp.json().get("sessions", [])
                for s in sessions:
                    try:
                        await client.post(
                            f"{VOYAGER_BASE}/inference/stop",
                            json={"run_id": s["run_id"]},
                            timeout=5
                        )
                    except Exception as e:
                        logger.debug("Could not stop voyager session %s: %s", s.get("run_id"), e)
                if sessions:
                    logger.info("Stopped %d voyager inference session(s)", len(sessions))
    except Exception as e:
        logger.debug("Could not fetch voyager inference status: %s", e)

    # Clear HLS directories for inference slots (2-5)
    import shutil
    for slot in range(2, MAX_SLOTS + 1):
        slot_dir = INFERENCE_HLS / f"slot-{slot}"
        if slot_dir.exists():
            try:
                shutil.rmtree(slot_dir)
                slot_dir.mkdir(parents=True, exist_ok=True)
                logger.info("Cleared HLS output for slot %d", slot)
            except Exception as e:
                logger.debug("Could not clean HLS slot %d: %s", slot, e)

    # Small delay to ensure filesystem operations complete
    await asyncio.sleep(0.5)


async def _start_stream_to_mediamtx(source_type: str, source: str) -> None:
    state = _slots[1]
    if state.running:
        _stop_slot(1)

    # Clean up inference slots before starting new stream
    # This ensures old inference frames don't persist when switching input types
    await _cleanup_inference_slots()

    cmd = _build_mediamtx_push_cmd(source_type, source)
    logger.info("FFmpeg → MediaMTX: %s", " ".join(cmd))

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    await asyncio.sleep(3)

    if proc.poll() is not None:
        stderr = proc.stderr.read() if proc.stderr else ""
        raise HTTPException(500, f"FFmpeg failed to push to MediaMTX: {stderr[:300]}")

    _drain_stderr(proc, "ffmpeg→mediamtx")

    with state.lock:
        state.ffmpeg_process = proc
        state.running        = True
        state.source_type    = source_type
        state.source_value   = source

    logger.info("Stream pushing to MediaMTX [type=%s]", source_type)


# ── Inference trigger ─────────────────────────────────────────────────────────

async def _trigger_inference_for_deployed_models(source_type: str, source: str) -> None:
    state    = get_app_state()
    deployed = [m for m in state.get_models() if getattr(m, "deployed", False)]
    if not deployed:
        return

    try:
        from app.routers.models import _voyager_infer
        for model in deployed:
            stream_slot = model.slot + 1
            logger.info("Triggering inference slot %d model=%s", stream_slot, model.name)
            asyncio.create_task(
                _voyager_infer(stream_slot, source_type, source, model.model_id,
                               getattr(model, "deploy_id", ""))
            )
    except Exception as e:
        logger.warning("Failed to trigger inference: %s", e)


# ── Multi-camera, single-model ────────────────────────────────────────────────
#
# Design: slot → {source, model}, generalized so "different model per camera"
# can be added later without a rewrite. For now, one deployed model runs
# against N RTSP cameras (target 4) — one voyager-sdk process, demuxed by
# fr.source_id, one HLSWriter per camera at slots 2..(1+N). RTSP cameras are
# already H.264, so the inference path reads them directly — no MediaMTX
# bounce needed for these slots (unlike the single-source path below).

async def _start_multi_camera_stream(sources: list[str]) -> dict:
    sources = [s.strip() for s in sources if s and s.strip()]
    if not sources:
        raise HTTPException(400, "At least one RTSP source is required")
    if len(sources) > MAX_MULTI_CAMERAS:
        raise HTTPException(400, f"At most {MAX_MULTI_CAMERAS} cameras supported")

    state    = get_app_state()
    deployed = [m for m in state.get_models() if getattr(m, "deployed", False)]
    if not deployed:
        raise HTTPException(400, "Deploy a model before starting a multi-camera stream")
    model = deployed[0]

    # Best-effort raw preview tile for camera 0 (slot 1). This must happen
    # BEFORE the inference session is started below — it also clears any
    # previous inference sessions/slots, which would kill our own session if
    # done afterward.
    try:
        await _start_stream_to_mediamtx("RTSP", sources[0])
        await _wait_for_mediamtx_hls(timeout=15.0)
    except Exception as e:
        logger.warning("Raw preview push failed (non-fatal): %s", e)

    state.set_source("RTSP", sources[0])

    base_slot = 2
    run_id    = f"multicam-{model.model_id}"
    network   = f"{settings.voyager_sdk_dir}/customers/{model.model_id}/{model.model_id}.yaml"

    try:
        async with httpx.AsyncClient(timeout=35) as client:
            resp = await client.post(
                f"{VOYAGER_BASE}/inference/start",
                json={
                    "run_id":      run_id,
                    "slot_id":     base_slot,
                    "source_type": "RTSP",
                    "sources":     sources,
                    "network":     network,
                },
            )
    except httpx.RequestError as e:
        raise HTTPException(503, f"voyager-sdk unreachable: {e}")
    if resp.status_code != 200:
        raise HTTPException(502, f"voyager-sdk /inference/start error: {resp.text[:300]}")

    slots = list(range(base_slot, base_slot + len(sources)))
    logger.info("Multi-camera stream started: %d source(s) → slots %s (model=%s)",
                len(sources), slots, model.model_id)

    _multi_camera_session.update({
        "active":          True,
        "source_type":     "RTSP",
        "sources":         sources,
        "inference_slots": slots,
        "raw_slot":        1,
    })

    return {
        "status":   "streaming",
        "mode":     "multi-camera",
        "slots":    slots,
        "hls_urls": [f"/api/stream/slot/{s}/index.m3u8" for s in slots],
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/stream/start")
async def start_stream(request: StreamStartRequest):
    if request.source_type == "RTSP" and request.sources:
        return await _start_multi_camera_stream(request.sources)

    if not request.source_value:
        raise HTTPException(400, "source_value is required")

    source = _resolve_source(request.source_type, request.source_value)

    app_state = get_app_state()
    app_state.set_source(request.source_type, source)

    logger.info("Starting stream [type=%s source=%s]", request.source_type, 
                source if request.source_type != "RTSP" else request.source_value)

    await _start_stream_to_mediamtx(request.source_type, source)

    if not await _wait_for_mediamtx_hls(timeout=45.0):
        _stop_slot(1)
        raise HTTPException(504, "MediaMTX stream did not start in time")

    logger.info("Stream connected and ready [type=%s]", request.source_type)

    asyncio.create_task(_trigger_inference_for_deployed_models(request.source_type, source))

    return {
        "status":  "streaming",
        "slot":    1,
        "hls_url": "/api/stream/slot/1/index.m3u8",
    }


@router.delete("/stream/stop")
async def stop_stream():
    get_app_state().clear_source()

    for slot in range(1, MAX_SLOTS + 1):
        if _slots[slot].running:
            _stop_slot(slot)

    # Clean up inference slots
    await _cleanup_inference_slots()

    return {"status": "stopped"}


@router.post("/stream/upload-video")
async def upload_video(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    if not _allowed_video_file(file.filename):
        raise HTTPException(400, "Unsupported video format")

    safe_name  = Path(file.filename).name
    upload_dir = _resolve_upload_dir()
    target     = upload_dir / f"{uuid.uuid4().hex}_{safe_name}"
    content    = await file.read()
    if not content:
        raise HTTPException(400, "Uploaded file is empty")
    target.write_bytes(content)

    return {"status": "uploaded", "filename": safe_name, "stored_as": target.name, "source_path": str(target)}


@router.get("/stream/status")
def stream_status():
    slots_out = {}
    for slot, state in _slots.items():
        if slot == 1:
            running = state.running
        else:
            # Inference slots (2-5) aren't tracked in `_slots` — that dict only
            # covers the slot-1 ffmpeg→MediaMTX push. Derive "running" the same
            # way /stream already does: a live HLS playlist for the slot.
            running = (INFERENCE_HLS / f"slot-{slot}" / "index.m3u8").exists()
        slots_out[slot] = {
            "running":      running,
            "source_type":  state.source_type,
            "source_value": state.source_value,
        }

    return {
        "slots":   slots_out,
        "session": dict(_multi_camera_session),
    }


@router.get("/stream")
def get_streams():
    app_state = get_app_state()
    streams   = []
    if _slots[1].running:
        streams.append({
            "slot": 1, "name": "Raw Stream",
            "source_type": _slots[1].source_type,
            "source_value": _slots[1].source_value,
            "url": "/api/stream/slot/1/index.m3u8",
            "mode": "raw",
        })
    for slot in range(2, MAX_SLOTS + 1):
        hls_path = INFERENCE_HLS / f"slot-{slot}" / "index.m3u8"
        if hls_path.exists():
            model = app_state.get_model_by_slot(slot - 1)
            name  = model.name if model else f"Model {slot - 1}"
            streams.append({
                "slot": slot, "name": name,
                "url": f"/api/stream/slot/{slot}/index.m3u8",
                "mode": "annotated",
            })
    return {"streams": streams, "count": len(streams)}


# FIX: api_route with GET + HEAD so nginx doesn't 405 HEAD requests
@router.api_route("/stream/slot/1/{asset_path:path}", methods=["GET", "HEAD"])
async def get_slot1_asset(asset_path: str):
    """Proxy ALL slot-1 HLS assets from MediaMTX (master, variant, init, segments, parts)."""
    if not _slots[1].running:
        raise HTTPException(404, "Slot 1 is not running")
    try:
        client = _get_mediamtx_client()
        resp = await client.get(f"{MEDIAMTX_HLS}/{asset_path}")
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code, f"MediaMTX returned {resp.status_code} for {asset_path}")
        return Response(
            content=resp.content,
            media_type=resp.headers.get("content-type") or _media_type_for(asset_path),
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma":        "no-cache",
                "Expires":       "0",
                "Access-Control-Allow-Origin": "*",
            },
        )
    except httpx.RequestError as e:
        raise HTTPException(503, f"MediaMTX unreachable: {e}")


@router.get("/stream/slot/{slot}/index.m3u8")
async def get_slot_playlist(slot: int):
    return await get_slot_asset(slot, "index.m3u8")


# FIX: api_route with GET + HEAD so nginx doesn't 405 HEAD requests
@router.api_route("/stream/slot/{slot}/{asset_name}", methods=["GET", "HEAD"])
async def get_slot_asset(slot: int, asset_name: str):
    """Slots 2-5: serve inference HLS from /tmp/hls/slot-N/."""
    _validate_slot(slot)
    if slot == 1:
        return await get_slot1_asset(asset_name)

    file_path = _inference_hls_asset_path(slot, asset_name)
    return FileResponse(
        file_path,
        media_type=_media_type_for(asset_name),
        headers={
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        }
    )


# ── Camera detection ──────────────────────────────────────────────────────────


# Some SoCs (e.g. Rockchip RK3588 on the Metis Compute Board) route camera
# frames through an ISP (rkisp1) that registers several /dev/videoN nodes
# per physical sensor for metadata/stats/params in addition to the actual
# capture node — unlike the Raspberry Pi 5 where /dev/video* is almost
# always a real capture device (USB webcam or the Pi camera stack). A fixed
# "index < 10" cutoff (as used by the original Pi build) can both hide real
# USB cameras that land on a higher node number and include non-capture ISP
# nodes. Raise the ceiling and prefer a real V4L2_CAP_VIDEO_CAPTURE check
# when the v4l-utils tooling is available (installed in both Dockerfiles),
# falling back to the old heuristic if not.
MAX_VIDEO_NODES = int(os.getenv("MAX_VIDEO_NODES", "64"))


def _v4l2_is_capture_device(dev: str) -> Optional[bool]:
    """Return True/False if v4l2-ctl confirms (non-)capture capability,
    or None if v4l2-ctl isn't available / the query failed (caller should
    fall back to the name-based heuristic)."""
    try:
        result = subprocess.run(
            ["v4l2-ctl", "-d", dev, "--all"],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode != 0:
            return None
        out = result.stdout
        return "Video Capture" in out and "Metadata Capture" not in out.split("Video Capture")[0][-40:]
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return None


@router.get("/cameras")
def list_cameras():
    if not sys.platform.startswith("linux"):
        return {"cameras": []}
    cameras = []
    for dev in sorted(glob.glob("/dev/video*")):
        try:
            idx = int(os.path.basename(dev).replace("video", ""))
        except ValueError:
            continue
        if idx >= MAX_VIDEO_NODES:
            continue
        if not Path(f"/sys/class/video4linux/video{idx}").exists():
            continue

        is_capture = _v4l2_is_capture_device(dev)
        if is_capture is False:
            continue  # confirmed non-capture (ISP stats/params/metadata node) — skip

        cameras.append(CameraInfo(index=idx, name=_camera_name(idx), device=dev))
    logger.info("Camera detection: %d camera(s)", len(cameras))
    return {"cameras": cameras}


def _camera_name(index: int) -> str:
    try:
        return Path(f"/sys/class/video4linux/video{index}/name") \
            .read_text(encoding="utf-8", errors="ignore").strip() or f"Camera {index}"
    except Exception:
        return f"Camera {index}"