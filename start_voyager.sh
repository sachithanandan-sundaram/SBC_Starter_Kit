#!/bin/bash
# start_voyager.sh
# --------------------------------------------------------------------------
# Starts the voyager-sdk container + ai_server.py inference service.
#
# Works on BOTH:
#   - Raspberry Pi 5 + Metis M.2 starter kit (container built/started by hand,
#     typically named "voyager-sdk", DEST fixed at /home/voyager-sdk)
#   - Axelera Metis Compute Board (RK3588 SBC, container managed by
#     ~/start_axelera.py, DEST/venv location determined by the SDK version
#     you downloaded — see Metis Compute Board User Guide sec. 5.1)
#
# All platform-specific values are environment overrides so the same script
# and codebase work unmodified on either board. Defaults match the original
# Raspberry Pi 5 setup for backward compatibility.
#
#   CONTAINER   docker container name              (default: voyager-sdk)
#   SDK_DIR     voyager-sdk checkout path inside container
#               (default: auto-detected, falls back to /home/voyager-sdk)
#   NETWORK     docker network shared with backend  (default: app-net)
#   AXELERA_HOME  host dir containing start_axelera.py on the Compute Board
#               (default: /home/antelao)
# --------------------------------------------------------------------------
set -e

CONTAINER="${CONTAINER:-voyager-sdk}"
NETWORK="${NETWORK:-app-net}"
AXELERA_HOME="${AXELERA_HOME:-/home/antelao}"
SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)/voyager-service"

# ── Step 0: identify which board workflow we're on ──────────────────────────
# The Metis Compute Board ships an Axelera-provided container launcher
# (start_axelera.py) at $AXELERA_HOME; the Raspberry Pi 5 + M.2 starter kit
# does not — there the container is created once (e.g. via the SDK's own
# install.sh / launch-docker.sh) and simply (re)started here.
BOARD_MODE="raspi5-m2"
if [ -f "$AXELERA_HOME/start_axelera.py" ]; then
    BOARD_MODE="metis-compute-board"
fi
echo "==> Detected workflow: $BOARD_MODE"

echo "==> Checking voyager-sdk container exists..."
if ! docker inspect "$CONTAINER" > /dev/null 2>&1; then
    if [ "$BOARD_MODE" = "metis-compute-board" ]; then
        echo "    Container '$CONTAINER' not found — attempting to start it via start_axelera.py"
        echo "    (first-time setup: see Metis Compute Board User Guide sec 5.1 —"
        echo "     you must have already run ./setup_axelera_environment.sh <version>"
        echo "     from $AXELERA_HOME once to download the SDK container image)"
        VOYAGER_SDK_VERSION="${VOYAGER_SDK_VERSION:?Set VOYAGER_SDK_VERSION to the SDK version you downloaded (e.g. 1.6.0)}"
        (cd "$AXELERA_HOME" && python3 start_axelera.py start \
            --container-name "$CONTAINER" --version "$VOYAGER_SDK_VERSION")
    else
        echo "ERROR: Container '$CONTAINER' not found."
        echo "       On Raspberry Pi 5 + M.2: build/create it first per the voyager-sdk"
        echo "       install docs (https://github.com/axelera-ai-hub/voyager-sdk)."
        exit 1
    fi
fi

echo "==> Starting MediaMTX..."
pkill -f mediamtx 2>/dev/null || true
sleep 1
if ! command -v mediamtx > /dev/null 2>&1; then
    echo "ERROR: 'mediamtx' binary not found on PATH."
    echo "       Install it from https://github.com/bluenviron/mediamtx/releases"
    echo "       (grab the linux_arm64 build — both the Pi 5 and the RK3588-based"
    echo "       Metis Compute Board are arm64) and place it on PATH, e.g. /usr/local/bin."
    exit 1
fi
nohup mediamtx /etc/mediamtx.yml > /tmp/mediamtx.log 2>&1 &
sleep 2
if curl -sf http://localhost:8888/ > /dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q 8554; then
    echo "    MediaMTX is UP (RTSP :8554, HLS :8888)"
else
    echo "    WARNING: MediaMTX may not be running — check /tmp/mediamtx.log"
fi

echo "==> Starting $CONTAINER..."
docker start "$CONTAINER"
sleep 2

# ── Auto-detect the voyager-sdk checkout path inside the container ─────────
# The Raspberry Pi 5 starter always used /home/voyager-sdk. The Metis Compute
# Board's pre-built container may differ per SDK version — probe a small set
# of known-likely candidates (container's $HOME, /home/voyager-sdk, and
# anything matching */voyager-sdk under /home) before giving up.
if [ -z "$SDK_DIR" ]; then
    echo "==> Auto-detecting SDK_DIR inside container..."
    CONTAINER_HOME="$(docker exec "$CONTAINER" bash -c 'echo $HOME' 2>/dev/null || true)"
    CANDIDATES=(
        "/home/voyager-sdk"
        "${CONTAINER_HOME}"
        "${CONTAINER_HOME}/voyager-sdk"
        "${CONTAINER_HOME}/shared/voyager-sdk"
    )
    for c in "${CANDIDATES[@]}"; do
        [ -z "$c" ] && continue
        if docker exec "$CONTAINER" bash -c "[ -f '$c/deploy.py' ] || [ -d '$c/customers' ]" 2>/dev/null; then
            SDK_DIR="$c"
            break
        fi
    done
    if [ -z "$SDK_DIR" ]; then
        FOUND="$(docker exec "$CONTAINER" bash -c "find /home -maxdepth 3 -iname deploy.py 2>/dev/null | head -1" 2>/dev/null || true)"
        [ -n "$FOUND" ] && SDK_DIR="$(dirname "$FOUND")"
    fi
    SDK_DIR="${SDK_DIR:-/home/voyager-sdk}"
    echo "    SDK_DIR=$SDK_DIR"
fi
DEST="$SDK_DIR"

# venv may or may not exist depending on how the SDK was installed
# (Metis Compute Board's pip-wheel install path may not use a venv at all —
# see docs/tutorials/install.md: "Python environments ... symlinked to ./venv").
if docker exec "$CONTAINER" bash -c "[ -f '$DEST/venv/bin/activate' ]" 2>/dev/null; then
    VENV="$DEST/venv"
    ACTIVATE_CMD="source $VENV/bin/activate"
    echo "    Using venv at $VENV"
else
    ACTIVATE_CMD=":"  # no-op — rely on system/container-default python3
    echo "    No venv found at $DEST/venv — using container's default python3"
fi

echo "==> Copying voyager-service files..."
for f in ai_server.py ai_inference.py wginference.py; do
    if [ ! -f "$SERVICE_DIR/$f" ]; then
        echo "ERROR: $SERVICE_DIR/$f not found"
        exit 1
    fi
    docker cp "$SERVICE_DIR/$f" "$CONTAINER:$DEST/$f"
    echo "    copied $f"
done

echo "==> Installing system dependencies..."
docker exec -u root "$CONTAINER" bash -c "
    which ffmpeg > /dev/null 2>&1 || (apt-get update -qq && apt-get install -y -q ffmpeg)
" && echo "    ffmpeg ok"

echo "==> Installing dependencies..."
docker exec "$CONTAINER" bash -c "
    $ACTIVATE_CMD &&
    pip install --quiet fastapi uvicorn httpx psutil
"
echo "    done"

echo "==> Connecting to network: $NETWORK"
docker network connect "$NETWORK" "$CONTAINER" 2>&1 || echo "    (skipped — already connected or host network mode)"

echo "==> Killing stale processes and freeing AIPU..."
docker exec "$CONTAINER" bash -c "
    pkill -9 -f ai_server.py 2>/dev/null || true
    pkill -9 -f 'python3.*inference' 2>/dev/null || true
    pkill -9 -f 'python3.*axelera' 2>/dev/null || true
    sleep 2
    echo '    processes cleared'
" 2>/dev/null || true

echo "==> Setting up HLS dirs..."
mkdir -p /tmp/hls
for slot in 2 3 4; do
    mkdir -p /tmp/hls/slot-$slot
done
docker exec "$CONTAINER" bash -c "
    mkdir -p /tmp/hls/slot-2 /tmp/hls/slot-3 /tmp/hls/slot-4
"
echo "    /tmp/hls ready"

echo "==> Checking Metis AIPU driver on host..."
if docker exec "$CONTAINER" bash -c "[ -f /sys/class/metis/version ]" 2>/dev/null; then
    DRV_VER=$(docker exec "$CONTAINER" cat /sys/class/metis/version 2>/dev/null || echo "unknown")
    echo "    Metis driver version: $DRV_VER"
else
    echo "    NOTE: /sys/class/metis/version not visible inside container."
    echo "    On the Metis Compute Board the driver is installed on the SBC host"
    echo "    (see User Guide sec. 3.4) — this is informational only, not fatal,"
    echo "    since the container may not bind-mount /sys."
fi

echo "==> Starting ai_server.py..."
docker exec "$CONTAINER" bash -c "
    $ACTIVATE_CMD
    cd $DEST
    export SDK_DIR='$DEST'
    export HLS_ROOT='/home/ubuntu/shared/hls'
    export RTSP_URL='rtsp://127.0.0.1:8554/live'
    nohup python3 -u ai_server.py > /tmp/ai_server.log 2>&1 &
    disown
    echo \$! > /tmp/ai_server.pid
"
sleep 3

echo "==> Verifying..."
if docker exec "$CONTAINER" curl -sf http://localhost:8001/health > /dev/null; then
    echo "    voyager-sdk is UP at http://localhost:8001"
    docker exec "$CONTAINER" curl -s http://localhost:8001/health
    echo ""
else
    echo "FAILED. Logs:"
    docker exec "$CONTAINER" cat /tmp/ai_server.log 2>/dev/null || echo "no log file"
    exit 1
fi

echo ""
echo "Board mode:      $BOARD_MODE"
echo "SDK_DIR:         $DEST"
echo "Commands:"
echo "  Voyager logs: docker exec $CONTAINER tail -f /tmp/ai_server.log"
echo "  MediaMTX logs: tail -f /tmp/mediamtx.log"
echo "  Stop:         docker exec $CONTAINER pkill -f ai_server.py"
echo "  Restart:      bash $(basename "$0")"
