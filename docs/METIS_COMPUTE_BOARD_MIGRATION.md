# Migrating from Raspberry Pi 5 + Metis M.2 → Axelera Metis Compute Board

This document records what changed to move this codebase from the
Raspberry Pi 5 + Metis M.2 starter kit onto the **Axelera Metis Compute
Board** (Rockchip RK3588 SoC + integrated Metis AIPU), and — just as
important — what did **not** change, since the goal was to keep the same
architecture (FastAPI backend, React frontend, MediaMTX relay, voyager-sdk
container running `ai_server.py`) and only adjust the platform-specific
seams.

## TL;DR — what's actually different between the two boards

| | Raspberry Pi 5 + Metis M.2 | Metis Compute Board |
|---|---|---|
| Host CPU | Broadcom BCM2712 (Cortex-A76) | Rockchip RK3588 (Cortex-A76+A55) |
| Arch | arm64 | arm64 (same — no cross-compile concerns) |
| Metis AIPU | M.2 card, PCIe, driver installed by hand | Integrated on-board, PCIe internally, DKMS driver **pre-flashed as part of the Axelera BSP** |
| Host OS | Standard Raspberry Pi OS (Debian) | Axelera-provided "Voyager Linux" BSP (Debian-based, Weston/Wayland compositor, Mender A/B managed) |
| voyager-sdk container | Built/started by hand (`docker start voyager-sdk`) | Managed by Axelera's `start_axelera.py` launcher (`~/start_axelera.py start --container-name ... --version ...`) |
| Container home dir | Fixed at `/home/voyager-sdk` | Varies by SDK version/build — must be confirmed per-deployment |
| Camera enumeration | `/dev/video0`, `/dev/video1`... almost always real capture devices | RK3588's ISP (rkisp1) can register several extra `/dev/videoN` nodes (stats/params/metadata) that are **not** capture devices |
| Everything else (FastAPI routes, React UI, MediaMTX relay, HLS pipeline, docker-compose topology, nginx proxy) | — | **unchanged** |

Because both boards are arm64 and both run a Debian-family Linux, the
frontend, nginx config, `docker-compose.yml` topology, and 95% of the
backend needed **no changes at all**. The actual delta was: remove
hardcoded paths/IPs that happened to be correct by coincidence on the Pi,
and make the container lifecycle script understand the Compute Board's
own launcher.

## Files changed

### `backend/app/config.py`
Added three new settings, all overridable via `backend/.env`:
- `voyager_sdk_dir` — was hardcoded to `/home/voyager-sdk` in `models.py`;
  now centralized here and configurable (`VOYAGER_SDK_DIR`).
- `mediamtx_host` — was hardcoded to `172.18.0.1` (the Pi's docker bridge
  gateway) in `stream.py`; now configurable (`MEDIAMTX_HOST`).
- `mediamtx_rtsp_port` / `mediamtx_hls_port` — same reasoning, in case a
  future deployment needs different ports.

**Action required before first boot on the Compute Board:** run
`docker network inspect app-net` after `docker compose up -d` once, note
the actual `Gateway` IP under `IPAM`, and put it in `backend/.env` as
`MEDIAMTX_HOST`. It is not guaranteed to be `172.18.0.1` on a fresh host —
that value only happened to be correct on the original Pi because it was
the first bridge network Docker had created there.

### `backend/app/routers/stream.py`
- `MEDIAMTX_RTSP` / `MEDIAMTX_HLS` now derive from `settings.mediamtx_host`
  instead of the hardcoded Pi bridge IP.
- `list_cameras()` hardening: raised the video-node index ceiling
  (`MAX_VIDEO_NODES`, default 64, was a hardcoded `10`) and added a
  best-effort `v4l2-ctl` capability check to filter out ISP
  metadata/stats/params nodes that RK3588's rkisp1 registers alongside
  real capture devices. Falls back to the original name-based heuristic
  if `v4l2-ctl` isn't available, so behavior on the Pi is unchanged.

### `backend/app/routers/models.py`
- Replaced the hardcoded `/home/voyager-sdk/customers/{model_id}/...`
  network YAML path with `settings.voyager_sdk_dir`.

### `voyager-service/ai_inference.py`
- `SDK_DIR` and the `AXELERA_FRAMEWORK` env default now read from the
  `SDK_DIR` environment variable (already how `ai_server.py` worked) —
  previously hardcoded to `/home/voyager-sdk` in this file specifically,
  which meant the two files could disagree if `SDK_DIR` was overridden.

### `voyager-service/ai_server.py`
- `/health` now also reports `metis_driver_version`, read from
  `/sys/class/metis/version` when visible inside the container. This is
  the DKMS driver the Compute Board's BSP installs on the SBC host (User
  Guide §3.4) — useful as an at-a-glance confirmation the AIPU driver is
  actually loaded, independent of whether `ai_server.py` itself is up.

### `backend/app/voyager_mock.py`
- **Pre-existing bug fix, found while testing:** the mock `/deploy`
  endpoint expected `{deploy_id, yaml_path}`, but both the real
  `ai_server.py` and the backend's `models.py` caller use
  `{deploy_id, model_name, yaml_content}`. Every `POST /api/models/add`
  call against mock mode was failing with a 422 before this fix. Also
  added `GET /deployed-models` for parity with the real service (used by
  `main.py`'s startup state-restore).

### `start_voyager.sh`
Rewritten to auto-detect which board it's running on and adapt:
- Detects the Compute Board via presence of `~/start_axelera.py`
  (override the home dir with `AXELERA_HOME`); falls back to the
  Pi-style `docker start <container>` flow otherwise.
- If the container doesn't exist yet on the Compute Board, invokes
  `start_axelera.py start --container-name ... --version $VOYAGER_SDK_VERSION`
  (you must set `VOYAGER_SDK_VERSION` and have already run the board's
  one-time `setup_axelera_environment.sh` per the User Guide).
- Auto-detects `SDK_DIR` inside the container instead of assuming
  `/home/voyager-sdk` (checks the container's `$HOME`, common
  subdirectories, and falls back to a `find` for `deploy.py`).
- Detects whether a Python venv exists at `$SDK_DIR/venv` before trying
  to activate it — the Compute Board's pip-wheel install path doesn't
  necessarily use one (see voyager-sdk's `docs/tutorials/install.md`).
- Replaced the apt-based "does mediamtx run" check with an explicit
  `command -v mediamtx` check + clear install instructions (arm64 binary,
  same on both boards) instead of silently continuing.
- Reports the Metis driver version (`/sys/class/metis/version`) if
  visible, informationally.
- All of the above are overridable via env vars (`CONTAINER`, `SDK_DIR`,
  `NETWORK`, `AXELERA_HOME`, `VOYAGER_SDK_VERSION`) so the same script
  still runs unmodified against the original Pi + M.2 setup.

### `docker-compose.yml`
- Removed duplicated volume lines that were already present in the
  original file (`/tmp/hls:/tmp/hls` and the host-mount line were each
  listed twice — harmless with Docker but confusing to maintain).
- Reworded the commented-out `devices:` block to be board-agnostic (both
  boards expose USB cameras as `/dev/videoN`); pointed at `/api/cameras`
  to discover the right index instead of assuming `/dev/video0`.

### `backend/.env.example`
- Documented the three new settings above with the reasoning for why they
  need per-host verification.

## What I could **not** test in this environment, and why

I do not have a physical Raspberry Pi 5, Metis M.2 card, or Metis Compute
Board attached to this sandbox, nor a Docker daemon. So the AIPU
compile/deploy path, real RTSP camera ingestion, and the DKMS driver check
are logic-reviewed and cross-referenced against the Voyager SDK docs and
the Metis Compute Board User Guide, but not executed against real
hardware. Everything else — every one of the 24 backend REST endpoints,
the full model add → deploy → mark-deployed → remove lifecycle, state
persistence/restore across restarts, and the production build of the
React frontend served through the FastAPI static mount — **was** run
end-to-end in this environment using the bundled `voyager_mock.py` in
place of the real `ai_server.py`, since a working mock service is exactly
what it exists for. See the test log in the delivery message for the
exact commands and responses.

## Bring-up checklist on the physical Metis Compute Board

1. Flash / confirm the board is on the Axelera "Voyager Linux" BSP
   (`cat /etc/os-release`, `mender show-artifact`).
2. Confirm the AIPU driver is loaded: `cat /sys/class/metis/version` on
   the **host**, not inside a container.
3. One-time: `cd ~ && ./setup_axelera_environment.sh <sdk-version>` to
   pull the SDK container image if not already present.
4. `docker compose up -d --build` from the repo root (builds/starts
   `frontend` + `backend` only — voyager-sdk is separate by design).
5. `docker network inspect app-net` → copy the `Gateway` IP into
   `backend/.env` as `MEDIAMTX_HOST` → `docker compose restart backend`.
6. Install `mediamtx` (arm64 build) on the host if not already present.
7. `VOYAGER_SDK_VERSION=<version> ./start_voyager.sh` — watch the output;
   it will tell you which `BOARD_MODE` it detected and which `SDK_DIR` it
   auto-resolved. If auto-detection picks the wrong path, set `SDK_DIR`
   explicitly and re-run.
8. `curl http://localhost:8001/health` from inside the container (or
   through the exposed port if you choose to publish it) — confirm
   `metis_driver_version` is populated.
9. Open the dashboard, add a model, and use **Live View → USB** with a
   camera connected — first run `curl http://localhost:8000/api/cameras`
   to see which `/dev/videoN` index the board actually assigned it,
   since RK3588's ISP can shift indices versus what you'd expect from a
   Pi.
10. Confirm inference HLS (`/api/stream/slot/2/index.m3u8` etc.) plays
    with real AIPU-annotated frames, and check `docker exec <container>
    tail -f /tmp/ai_server.log` for the "17.5fps proven on RPi5" style log
    lines — first-run frame rate on the Compute Board should be recorded
    here for future tuning (RK3588 has a different CPU/mem profile than
    the Pi 5 for the ffmpeg re-encode step in `HLSWriter`).
