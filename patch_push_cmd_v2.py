import sys

path = "backend/app/routers/stream.py"
with open(path) as f:
    src = f.read()

old = '''def _build_mediamtx_push_cmd(source_type: str, source: str) -> list[str]:
    input_flags = _input_flags(source_type, source)
    return [
        "ffmpeg", "-y",
    ] + input_flags + [
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
        "-an",
        "-f", "rtsp",
        MEDIAMTX_RTSP,
    ]'''

new = '''def _build_mediamtx_push_cmd(source_type: str, source: str) -> list[str]:
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
    ]'''

if old not in src:
    print("ERROR: could not find the expected block. No changes made.")
    sys.exit(1)

src = src.replace(old, new)
with open(path, "w") as f:
    f.write(src)
print("OK: _build_mediamtx_push_cmd patched successfully.")
