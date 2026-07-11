from pathlib import Path
import threading
import time
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

app = FastAPI(title="Voyager SDK Mock", version="1.0.0")

HLS_ROOT = Path("/app/data/hls")

# In-memory deploy tracking
DEPLOYMENTS: dict = {}
DEPLOY_LOCK = threading.Lock()
DEPLOYED_MODELS: dict = {}
DEPLOYED_LOCK = threading.Lock()


class DeployRequest(BaseModel):
    deploy_id: str
    model_name: str
    yaml_content: str


class InferenceStartRequest(BaseModel):
    run_id: str
    slot_id: int
    source_type: str
    source: str
    network: str


class InferenceStopRequest(BaseModel):
    run_id: str


@app.get("/health")
def health():
    with DEPLOY_LOCK:
        active = sum(1 for d in DEPLOYMENTS.values() if not d["done"])
    return {"status": "ok", "service": "voyager-sdk-mock", "active_deployments": active}


@app.get("/deployed-models")
def get_deployed_models():
    with DEPLOYED_LOCK:
        return dict(DEPLOYED_MODELS)


@app.post("/deploy")
def deploy_model(request: DeployRequest):
    # Real ai_server.py writes the YAML to disk under customers/{model_name}/
    # — mirror that here so mock mode exercises the same on-disk contract
    # the frontend/backend expect, just without an actual AIPU compile.
    model_dir = Path("/tmp/voyager-sdk-mock/customers") / request.model_name
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / f"{request.model_name}.yaml").write_text(request.yaml_content, encoding="utf-8")

    # Simulate async deploy — completes after 5s
    with DEPLOY_LOCK:
        DEPLOYMENTS[request.deploy_id] = {
            "model_name":   request.model_name,
            "started_at":   time.time(),
            "done":         False,
            "exit_code":    None,
        }

    def _finish():
        time.sleep(5)
        with DEPLOY_LOCK:
            if request.deploy_id in DEPLOYMENTS:
                DEPLOYMENTS[request.deploy_id]["done"]      = True
                DEPLOYMENTS[request.deploy_id]["exit_code"] = 0
        with DEPLOYED_LOCK:
            DEPLOYED_MODELS[request.model_name] = {
                "deploy_id":   request.deploy_id,
                "deployed_at": time.time(),
            }

    threading.Thread(target=_finish, daemon=True).start()

    return {"status": "deploying", "deploy_id": request.deploy_id, "pid": -1}


@app.get("/deploy/status")
def deploy_status(deploy_id: str):
    with DEPLOY_LOCK:
        if deploy_id not in DEPLOYMENTS:
            raise HTTPException(404, f"deploy_id not found: {deploy_id}")
        d = DEPLOYMENTS[deploy_id]
        elapsed   = time.time() - d["started_at"]
        done      = d["done"]
        exit_code = d["exit_code"]

    # Fake progress: 0 → 100 over 5s
    progress  = min(100.0, (elapsed / 5.0) * 100) if not done else 100.0
    stage     = "completed" if done else ("compiling" if elapsed > 2 else "loading")

    return {
        "deploy_id": deploy_id,
        "done":      done,
        "exit_code": exit_code,
        "progress":  progress,
        "stage":     stage,
        "log":       f"Mock deploy running... {progress:.0f}%",
    }


@app.post("/inference/start")
def inference_start(request: InferenceStartRequest):
    return {
        "status":  "started",
        "run_id":  request.run_id,
        "slot_id": request.slot_id,
        "hls_url": f"/hls/slot-{request.slot_id}/index.m3u8",
    }


@app.post("/inference/stop")
def inference_stop(request: InferenceStopRequest):
    return {"status": "stopped", "run_id": request.run_id}


@app.get("/inference/status")
def inference_status():
    return {"sessions": []}


# HLS file serving
@app.get("/hls/slot-{slot}/index.m3u8")
def get_slot_playlist(slot: int):
    playlist = HLS_ROOT / f"slot-{slot}" / "index.m3u8"
    if not playlist.exists():
        raise HTTPException(404, "Playlist not found")
    return FileResponse(str(playlist), media_type="application/vnd.apple.mpegurl")


@app.get("/hls/slot-{slot}/{segment_name}")
def get_slot_segment(slot: int, segment_name: str):
    if "/" in segment_name or segment_name.startswith("."):
        raise HTTPException(400, "Invalid segment name")
    slot_dir  = (HLS_ROOT / f"slot-{slot}").resolve()
    file_path = (slot_dir / segment_name).resolve()
    if not str(file_path).startswith(str(slot_dir)):
        raise HTTPException(400, "Invalid path")
    if not file_path.exists():
        raise HTTPException(404, "Segment not found")
    media_type = "application/vnd.apple.mpegurl" if segment_name.endswith(".m3u8") else "video/mp2t"
    return FileResponse(str(file_path), media_type=media_type)