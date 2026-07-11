"""
playback.py router
------------------
Playback recorded MP4 files from /app/data/recordings/.

Endpoints:
  - GET /api/playback/list                      List all recorded .mp4 files
  - GET /api/playback/video/{filename}          Serve video with HTTP range support
"""

import functools
import logging
import os
import subprocess
from pathlib import Path
from datetime import datetime

from fastapi import APIRouter, HTTPException, Header, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["playback"])

HOST_ROOT = Path(os.environ.get("HOST_ROOT", "/host"))

_BLOCKED_PREFIXES = [
    "/etc", "/sys", "/proc", "/dev", "/boot", "/usr", "/bin", "/sbin", "/lib",
]


def _resolve_save_path(save_path: str | None) -> Path:
    if not save_path:
        return settings.recordings_path

    clean = os.path.normpath(save_path)
    if ".." in clean.split(os.sep):
        raise HTTPException(400, "Invalid path: path traversal detected")

    for blocked in _BLOCKED_PREFIXES:
        if clean == blocked or clean.startswith(blocked + "/"):
            raise HTTPException(400, f"Reading from {blocked} is not allowed")

    return HOST_ROOT / clean.lstrip("/")


@functools.lru_cache(maxsize=256)
def _get_duration_seconds(file_path_str: str) -> float:
    """
    Use ffprobe to read the actual video duration from the MP4 container.

    Takes a plain string (not Path) so lru_cache can hash it.
    Result is memoised for the lifetime of the process — duration is immutable
    for a given file, so there is nothing to invalidate.  A new file that
    happens to share a name will only appear after the process restarts, at
    which point the cache is empty again anyway.

    Returns 0.0 if ffprobe is unavailable or the file has no duration metadata.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path_str,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        raw = result.stdout.strip()
        return float(raw) if raw else 0.0
    except Exception:
        return 0.0


# ── Schemas ──────────────────────────────────────────────────────────────────

class VideoFileInfo(BaseModel):
    filename: str
    size_mb: float
    duration_s: float          # actual video duration in seconds from ffprobe
    modified: str              # ISO 8601 timestamp


class PlaybackListResponse(BaseModel):
    files: list[VideoFileInfo]


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/playback/list", response_model=PlaybackListResponse)
def list_recordings(save_path: str = Query(None)):
    """
    List all .mp4 files in the recordings directory.
    Returns sorted by modification time (newest first).
    Duration is cached after the first ffprobe call — subsequent polls are fast.
    """
    recordings_root = _resolve_save_path(save_path)
    recordings_root.mkdir(parents=True, exist_ok=True)

    files = []
    try:
        for file_path in recordings_root.glob("*.mp4"):
            stat = file_path.stat()
            modified_dt = datetime.fromtimestamp(stat.st_mtime)
            files.append(
                VideoFileInfo(
                    filename=file_path.name,
                    size_mb=round(stat.st_size / (1024 * 1024), 2),
                    # Pass str so lru_cache can hash it
                    duration_s=_get_duration_seconds(str(file_path.resolve())),
                    modified=modified_dt.isoformat(),
                )
            )
        files.sort(key=lambda f: f.modified, reverse=True)

    except Exception as e:
        logger.error("Error listing recordings: %s", e)

    return PlaybackListResponse(files=files)


@router.get("/playback/video/{filename}")
def get_video(filename: str, range_header: str = Header(None), save_path: str = Query(None)):
    """
    Serve a video file with HTTP range support.
    Allows HTML5 <video> to seek without downloading the entire file.
    """
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(400, "Invalid filename")

    recordings_root = _resolve_save_path(save_path)
    file_path = recordings_root / filename

    if not file_path.exists():
        raise HTTPException(404, "File not found")

    if file_path.suffix.lower() != ".mp4":
        raise HTTPException(400, "Only .mp4 files are supported")

    file_size = file_path.stat().st_size

    if range_header:
        try:
            part = range_header.replace("bytes=", "").split("-")
            start = int(part[0]) if part[0] else 0
            end = int(part[1]) if part[1] else file_size - 1

            if start < 0:
                start = 0
            if end >= file_size:
                end = file_size - 1
            if start > end:
                raise HTTPException(400, "Invalid range")

            def range_generator():
                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = end - start + 1
                    chunk_size = 8192
                    while remaining > 0:
                        to_read = min(chunk_size, remaining)
                        chunk = f.read(to_read)
                        if not chunk:
                            break
                        yield chunk
                        remaining -= len(chunk)

            return StreamingResponse(
                range_generator(),
                status_code=206,
                media_type="video/mp4",
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(end - start + 1),
                },
            )

        except (ValueError, IndexError):
            pass

    return FileResponse(
        file_path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )