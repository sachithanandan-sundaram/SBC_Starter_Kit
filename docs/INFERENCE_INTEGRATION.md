# Axelera Inference Integration — War Notes

> A complete record of every wall we hit integrating the Axelera voyager-sdk with a React + FastAPI + Docker dashboard on a Raspberry Pi 5.

---

## System Overview

```
USB Camera
    │
    ├──► Backend FFmpeg ──► /app/data/hls/slot-1/  ──► nginx ──► Frontend slot 1 (raw)
    │
    └──► voyager-sdk inference.py ──► /tmp/hls/slot-2/ ──► nginx ──► Frontend slot 2 (annotated)
```

**Stack:**
- Frontend: React + HLS.js + nginx (port 80)
- Backend: FastAPI Python 3.11 (port 8000, internal only)
- voyager-sdk: external Docker container, host network mode, port 8001
- Shared HLS: `/tmp/hls/` (mounted in both backend container and accessible from voyager-sdk via host filesystem)

---

## Chapter 1: The voyager-sdk Container is Cursed

**Problem:** voyager-sdk runs with `network_mode: host`. It cannot join `app-net` (the Docker bridge network that frontend and backend use).

```
Error response from daemon: container sharing network namespace with another container
or host cannot be connected to any other network
```

**Solution:** Backend reaches voyager-sdk at `http://172.17.0.1:8001` (Docker bridge gateway IP).
voyager-sdk reaches nginx at `http://127.0.0.1:80` (localhost since it's on host network).

**Lesson:** Never try to `docker network connect` a host-network container. Check with:
```bash
docker inspect voyager-sdk --format='{{.HostConfig.NetworkMode}}'
```

---

## Chapter 2: The USB Camera Can Only Have One Master

**Problem:** FFmpeg (backend) and voyager-sdk both try to open `/dev/video0`. One wins, one dies.

```
ERROR: v4l2src0: BUS: Device '/dev/video0' cannot capture in the specified format
ERROR: Tried to capture in MJPG, but device returned format YUYV
```

**Why it happened:** When FFmpeg holds the camera and voyager-sdk tries to grab it, GStreamer defaults to MJPG format. The C270 webcam reports MJPG support but delivers YUYV — so it fails.

**Solution:** For USB sources, stop FFmpeg slot 1 before starting inference. voyager-sdk owns the camera directly. Only 1 model allowed for USB sources.

```python
if source_type == "USB" and _slots[1].running:
    _stop_slot(1)  # free the camera for voyager-sdk
```

---

## Chapter 3: GStreamer Headless Hell

**Problem:** Running inference without a display causes GStreamer to try various sink elements that all fail:

- `kmssink` → `drmModeSetPlane failed: Permission denied (13)` (no DRM access in container)
- `xvimagesink` → `Output window was closed` (no X11)
- `ximagesink` → same
- `waylandsink` → no Wayland compositor

**Fix that worked:**
```bash
GST_PLUGIN_FEATURE_RANK='kmssink:0,waylandsink:0,ximagesink:0,xvimagesink:0'
```

Set at the very top of `ai_inference.py` — **before any imports** — or GStreamer has already initialized its plugin registry.

```python
import os
os.environ["GST_PLUGIN_FEATURE_RANK"] = "kmssink:0,waylandsink:0,ximagesink:0,xvimagesink:0"
# NOW import everything else
```

---

## Chapter 4: `--display none` Doesn't Drive the Pipeline

**Problem:** `inference.py --pipe gst --display none` runs but produces 0 frames. The GStreamer pipeline needs a sink element to drive the frame loop. With no display and all sinks disabled, nothing pulls frames.

**Things we tried that failed:**
- `--display none` → pipeline runs, 0 frames out
- `--display console` → hangs without a TTY
- `--display opencv` → requires display
- `-o /dev/stdout` → `Not supported format for stdout`
- `-o named_pipe` → `Not supported format for manual.pipe`
- HLS source + `--pipe gst` → always hangs, 0 output
- `--pipe torch-aipu` → falls back to CPU

**What actually works:**
```bash
./inference.py model usb:0 --display none
```
No `-o` flag, no `--pipe` override, let it default. The frame iterator yields frames. We capture them via the Python API:

```python
args   = parser.parse_args([network_yaml, "usb:0", "--display", "none"])
stream = wginference.init(args, tracers)
for fr in stream:
    frame = wginference.to_bgr24(fr.image)
    jpeg  = cv2.imencode(".jpg", frame)[1].tobytes()
    push_frame(frame_queue, jpeg)
```

**Key insight:** `usb:0 --display none` with default pipe = works at 18fps on AIPU. Everything else = suffering.

---

## Chapter 5: AXELERA_FRAMEWORK Must Be Set Before Import

**Problem:** `inference.py` checks `os.environ.get('AXELERA_FRAMEWORK')` at startup and calls `sys.exit()` if it's not set. When `ai_inference.py` spawns a subprocess or multiprocessing worker, the env var isn't inherited unless explicitly set.

```
[ERROR] Please activate the Axelera environment
```

**Fix:**
```python
os.environ.setdefault("AXELERA_FRAMEWORK", "/home/voyager-sdk")
```

Set this before any axelera imports in `ai_inference.py`.

---

## Chapter 6: AIPU Device Contention

**Problem:** Only one process can hold the AIPU at a time. Running multiple test sessions simultaneously causes:

```
[libtriton_linux.c:1262] Failed to allocate AI cores: Invalid argument
[ERROR][axeDeviceAllocateContext]: Fail to alloc ctx associate to 1 device.
ZE_RESULT_ERROR_INVALID_NULL_POINTER
```

**Fix:** Always kill stale inference processes before starting new ones:
```bash
docker exec voyager-sdk bash -c "
  for pid in \$(ls /proc | grep '^[0-9]'); do
    if ls -la /proc/\$pid/fd 2>/dev/null | grep -q metis; then
      kill -9 \$pid
    fi
  done
"
```

Check device is free:
```bash
ls -la /proc/*/fd 2>/dev/null | grep metis
# Should be empty
```

---

## Chapter 7: The HLS Path Problem

**Problem:** voyager-sdk container has host network mode but NOT the backend volume mounts. It can't write to `/app/data/hls/slot-2/` because that path doesn't exist in the container (it's a Docker volume mount inside the backend container, not on the host).

**What we tried:**
- Write to `/home/wgtech/Documents/...` — wrong path (repo was on Desktop, not Documents)
- Write to the absolute host path — created a new directory inside the container, not the host
- Named pipes — SDK doesn't support them as output

**Fix:** Use `/tmp` which IS bind-mounted (`/tmp:/tmp` is in voyager-sdk's HostConfig.Binds).

```python
HLS_ROOT = os.getenv("HLS_ROOT", "/tmp/hls")
```

Pass the env var when starting the server:
```bash
export HLS_ROOT='/tmp/hls'
nohup python3 -u ai_server.py > /tmp/ai_server.log 2>&1 &
```

Mount `/tmp/hls` in the backend container:
```yaml
volumes:
  - /tmp/hls:/tmp/hls
```

Serve from `/tmp/hls` in `stream.py`:
```python
INFERENCE_HLS = Path("/tmp/hls")   # slots 2-4
HLS_ROOT      = Path("/app/data/hls")  # slot 1 only
```

---

## Chapter 8: The Playlist Wait Timeout

**Problem:** `ai_server.py` waits for the first HLS segment before returning from `/inference/start`. With USB source, inference startup takes 5-15 seconds. The backend times out after 15s and reports 504.

**Fix:** For USB source, don't wait — return immediately and let the frontend poll:

```python
if session and request.source_type != "USB":
    ready = session["hls"].wait_for_playlist(timeout=30.0)
    if not ready:
        stop_session(request.run_id)
        raise HTTPException(504, "...")
# For USB: return immediately, frontend polls
```

---

## Chapter 9: StreamContext Clears State Too Early

**Problem:** `StreamContext.tsx` polls `/api/stream` every 10 seconds. When USB inference starts, FFmpeg slot 1 stops — so `/api/stream` returns 0 active streams — and the context resets `isStreaming: false`, wiping the UI state.

```javascript
// This was the killer line:
if (!anySlotActive) {
    setStreamState((prev) => ({ ...prev, isStreaming: false }));
}
```

**Fix:** Before clearing state, check if inference slots (2-4) are serving HLS:

```javascript
if (!anySlotActive) {
    for (const slot of [2, 3, 4]) {
        const inf = await fetch(`/api/stream/slot/${slot}/index.m3u8`);
        if (inf.ok) return; // inference running — keep state
    }
    setStreamState((prev) => ({ ...prev, isStreaming: false }));
}
```

---

## Chapter 10: Slot 2 Returns 404 Before Inference Starts

**Problem:** Frontend loads `HlsPlayer` for slot 2 immediately after stream starts, before voyager-sdk has written any segments. HLS.js marks the error as fatal and gives up.

**Fix:** Add `inferenceReady` state. Poll `/api/stream/slot/2/index.m3u8` every 2 seconds. Show a spinner until segments exist, then mount the player:

```tsx
{inferenceReady
    ? <GridCell src="/api/stream/slot/2/index.m3u8" />
    : <div>Starting inference engine...</div>
}
```

---

## Chapter 11: `start_session()` Signature Changed But Server Didn't

**Problem:** We updated `ai_inference.py` to use `source_type` + `source` instead of `video_path`, but the `ai_server.py` on disk was still calling the old signature:

```
{"detail":"start_session() got an unexpected keyword argument 'video_path'"}
```

This happened 3 separate times because:
1. `start_voyager.sh` copied files but the old server was still running
2. Port 8001 was already in use by the old server
3. The copy went to the wrong path

**Fix:** Always kill-verify-restart:
```bash
docker exec voyager-sdk pkill -9 -f ai_server.py || true
sleep 2
# Verify port is free
docker exec voyager-sdk curl -sf http://localhost:8001/health && echo "OLD SERVER STILL RUNNING"
# Then start fresh
```

---

## Final Architecture

```
USB Camera (/dev/video0)
    │
    ▼
[Backend: stream.py]
POST /api/stream/start
    │
    ├── Starts FFmpeg → /app/data/hls/slot-1/ (raw stream)
    ├── Saves source to AppState
    └── asyncio.create_task(_trigger_inference_for_deployed_models)
              │
              ├── Stops slot 1 FFmpeg (USB only — free the camera)
              └── POST voyager-sdk /inference/start
                        │
                        ▼
              [voyager-sdk: ai_inference.py]
              inference_worker (multiprocess)
                  │
                  ├── wginference.init(args) with usb:0 --display none
                  ├── for fr in stream: encode JPEG → frame_queue
                  └── HLSWriter: ffmpeg pipe → /tmp/hls/slot-2/
                                                      │
                                              [shared via /tmp mount]
                                                      │
                                                      ▼
                                         [Backend: stream.py]
                                         GET /api/stream/slot/2/*.ts
                                         Serves from /tmp/hls/slot-2/
                                                      │
                                                      ▼
                                         [Frontend: LiveViewPage]
                                         HlsPlayer → slot 2 annotated video
```

---

## Key Commands

```bash
# Start everything
sudo docker compose up -d
sudo bash start_voyager.sh

# Check if AIPU device is in use
docker exec voyager-sdk bash -c "ls -la /proc/*/fd 2>/dev/null | grep metis"

# Check inference logs
docker exec voyager-sdk strings /tmp/ai_server.log | tail -20

# Check HLS segments are being written
ls -la /tmp/hls/slot-2/

# Test inference directly
docker exec -it voyager-sdk bash
source /home/voyager-sdk/venv/bin/activate
DISPLAY='' GST_PLUGIN_FEATURE_RANK='kmssink:0,waylandsink:0,ximagesink:0,xvimagesink:0' \
./inference.py <model_name> usb:0 --display none --frames 30

# Force stop everything
curl -X DELETE http://localhost/api/stream/stop
docker exec voyager-sdk pkill -9 -f inference.py
```

---

## Things That Will Bite You Again

1. **The AIPU is single-tenant.** One process at a time. Always kill stale sessions before starting new ones.
2. **`/tmp` is shared, volumes are not.** voyager-sdk can only write to host paths that are bind-mounted in its HostConfig.Binds (`/tmp`, `/lib/modules`, `/run`).
3. **`--display none` produces no frames.** Always use the Python API (`wginference.init`) with `--display none` as a CLI arg, not as a pipeline flag.
4. **GST env vars must be set before Python even imports anything.** Put them at line 1 of `ai_inference.py`.
5. **USB camera is exclusive.** If FFmpeg holds it, voyager-sdk gets MJPG/YUYV errors. Stop FFmpeg first.
6. **StreamContext will reset if it thinks no streams are running.** Always check inference slots before clearing `isStreaming`.
7. **The repo path matters.** `/home/wgtech/Documents/...` vs `/home/wgtech/Desktop/...` — one character difference, hours of debugging.