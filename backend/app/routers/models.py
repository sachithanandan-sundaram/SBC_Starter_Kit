"""
models_new.py
-------------
- GET    /api/models/list                    List active models
- POST   /api/models/add                     Add model → deploy to voyager-sdk
- GET    /api/models/deploy-status           Poll deployment progress
- DELETE /api/models/{slot}                  Remove model + stop its stream
"""
import logging
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.state import get_app_state
from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["models"])

VOYAGER_BASE = settings.voyager_sdk_url
# ── Schemas ───────────────────────────────────────────────────────────────────

class ModelInfo(BaseModel):
    slot: int
    name: str
    model_id: str
    deploy_id: Optional[str] = None
    deployed: bool = False


class ModelsListResponse(BaseModel):
    models: list[ModelInfo]


class AddModelRequest(BaseModel):
    model_name: str
    description: str = ""
    yaml_content: str
    number_of_cores: int = 1


class AddModelResponse(BaseModel):
    slot: int
    name: str
    deploy_id: str


class DeployStatusResponse(BaseModel):
    deploy_id: str
    done: bool
    progress: Optional[float] = None
    stage: str = "initializing"
    exit_code: Optional[int] = None
    log: str = ""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalize(name: str) -> str:
    return name.strip().lower().replace(" ", "_")


# ── Voyager-SDK calls ─────────────────────────────────────────────────────────

async def _voyager_deploy(deploy_id: str, model_name: str, yaml_content: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{VOYAGER_BASE}/deploy",
                json={
                    "deploy_id": deploy_id,
                    "model_name": model_name,
                    "yaml_content": yaml_content,
                },
            )
        if resp.status_code != 200:
            raise HTTPException(502, f"voyager-sdk /deploy error: {resp.text[:200]}")
    except httpx.RequestError as e:
        raise HTTPException(503, f"voyager-sdk unreachable: {str(e)[:200]}")


# deploy_id -> wall-clock time the FIRST 404 was seen for it. A 404 right
# after starting a deploy usually just means voyager-sdk hasn't registered it
# yet (or restarted and lost in-memory state) — treat that as "still queued"
# for a bounded grace period. Past that, voyager-sdk has genuinely lost track
# of it and polling forever would leave the UI spinning with no way to know
# something's wrong; report it as failed instead.
_deploy_404_since: dict[str, float] = {}
DEPLOY_404_TIMEOUT_SECONDS = 30.0


async def _voyager_deploy_status(deploy_id: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{VOYAGER_BASE}/deploy/status",
                params={"deploy_id": deploy_id},
            )
        if resp.status_code == 404:
            now = time.time()
            first_seen = _deploy_404_since.setdefault(deploy_id, now)
            if now - first_seen > DEPLOY_404_TIMEOUT_SECONDS:
                _deploy_404_since.pop(deploy_id, None)
                logger.warning("deploy_id %s still 404 after %.0fs — treating as failed",
                               deploy_id, now - first_seen)
                return {
                    "done": True, "progress": None, "stage": "failed", "exit_code": -1,
                    "log": ("voyager-sdk lost track of this deployment (no response after "
                            f"{DEPLOY_404_TIMEOUT_SECONDS:.0f}s) — it may have restarted "
                            "mid-deploy. Try deploying again."),
                }
            return {"done": False, "progress": None, "stage": "queued", "exit_code": None, "log": ""}

        _deploy_404_since.pop(deploy_id, None)
        if resp.status_code != 200:
            raise HTTPException(502, f"voyager-sdk status error: {resp.text[:200]}")
        return resp.json()
    except httpx.RequestError as e:
        raise HTTPException(503, f"voyager-sdk unreachable: {str(e)[:200]}")


async def _voyager_infer(slot: int, source_type: str, source: str, model_id: str, deploy_id: str) -> None:
    """Tell voyager-sdk to start inference on a slot.
    voyager-sdk always reads from MediaMTX RTSP — source_type/source ignored here."""
    run_id  = f"{model_id}-slot{slot}"
    network = f"{settings.voyager_sdk_dir}/customers/{model_id}/{model_id}.yaml"
    try:
        async with httpx.AsyncClient(timeout=35) as client:
            resp = await client.post(
                f"{VOYAGER_BASE}/inference/start",
                json={
                    "run_id":      run_id,
                    "slot_id":     slot,
                    "source_type": source_type,
                    "source":      source,
                    "network":     network,
                },
            )
        if resp.status_code != 200:
            logger.warning("voyager-sdk /inference/start error slot %d: %s", slot, resp.text[:200])
        else:
            logger.info("Inference started slot %d run_id=%s", slot, run_id)
    except httpx.RequestError as e:
        logger.warning("voyager-sdk unreachable for inference slot %d: %s", slot, e)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/models/list", response_model=ModelsListResponse)
def list_models():
    state = get_app_state()
    return ModelsListResponse(
        models=[
            ModelInfo(
                slot=m.slot,
                name=m.name,
                model_id=m.model_id,
                deploy_id=getattr(m, "deploy_id", None),
                deployed=getattr(m, "deployed", False),
            )
            for m in state.get_models()
        ]
    )


@router.post("/models/add", response_model=AddModelResponse)
async def add_model(request: AddModelRequest):
    """
    1. Write YAML to voyager-sdk customers/{model_name}/
    2. Call voyager-sdk /deploy (non-blocking, returns deploy_id)
    3. Reserve slot in state
    4. Return deploy_id — frontend polls /models/deploy-status
    """
    state = get_app_state()

    model_name = _normalize(request.model_name)
    if not model_name:
        raise HTTPException(400, "model_name is required")

    deploy_id = f"{model_name}-{uuid.uuid4().hex[:8]}"

    # All sources support up to 4 models — voyager-sdk reads from slot-1 HLS, no camera conflicts
    if len(state.get_models()) >= 4:
        raise HTTPException(400, "Maximum 4 models reached")

    # Reserve slot before deploy so UI can show it immediately
    try:
        slot = state.add_model(
            name=request.model_name,
            model_id=model_name,
            deploy_id=deploy_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Kick off deployment — send yaml content directly, voyager-sdk writes the file
    try:
        await _voyager_deploy(deploy_id, model_name, request.yaml_content)
    except HTTPException:
        state.remove_model(slot)
        raise

    logger.info("Deploy started [slot=%d deploy_id=%s]", slot, deploy_id)
    return AddModelResponse(slot=slot, name=request.model_name, deploy_id=deploy_id)


@router.get("/models/deploy-status", response_model=DeployStatusResponse)
async def deploy_status(deploy_id: str):
    """
    Proxy to voyager-sdk deploy status.
    Marks model as deployed in state when done + exit_code == 0.
    """
    data = await _voyager_deploy_status(deploy_id)

    done      = data.get("done", False)
    progress  = data.get("progress")
    stage     = data.get("stage", "running")
    exit_code = data.get("exit_code")
    log       = data.get("log", "")

    if done:
        state = get_app_state()
        if exit_code != 0 and exit_code is not None:
            # Deploy failed — auto-remove the model from state so UI clears it
            model = next(
                (m for m in state.get_models() if getattr(m, "deploy_id", None) == deploy_id),
                None
            )
            if model:
                state.remove_model(model.slot)
                logger.warning("Deploy failed (exit_code=%s) — auto-removed slot %d model=%s",
                               exit_code, model.slot, model.model_id)
        elif exit_code == 0:
            if state.mark_deployed(deploy_id):
                logger.info("Model marked deployed: deploy_id=%s", deploy_id)
                model = next(
                    (m for m in state.get_models() if getattr(m, "deploy_id", None) == deploy_id),
                    None
                )
                source_type, source_value = state.get_source()
                if model and source_type and source_value:
                    logger.info("Triggering inference slot %d source=%s", model.slot, source_value)
                    import asyncio
                    asyncio.create_task(
                        _voyager_infer(model.slot + 1, source_type, source_value, model.model_id, deploy_id)
                    )
                else:
                    logger.info("No active source — inference will start when stream begins")

    return DeployStatusResponse(
        deploy_id=deploy_id,
        done=done,
        progress=progress,
        stage=stage,
        exit_code=exit_code,
        log=log,
    )


@router.delete("/models/{slot}")
async def remove_model(slot: int):
    if not 1 <= slot <= 4:
        raise HTTPException(400, "Slot must be 1-4")

    state = get_app_state()
    model = next((m for m in state.get_models() if m.slot == slot), None)
    if not model or not state.remove_model(slot):
        raise HTTPException(404, f"No model at slot {slot}")

    model_id    = model.model_id
    stream_slot = slot + 1          # model slot 1 → stream slot 2
    run_id      = f"{model_id}-slot{stream_slot}"

    # Stop voyager-sdk inference session. stop_session() there waits for a
    # graceful stop_event-driven exit (so the SDK releases the AIPU device
    # cleanly) before forcing — worst case ~12-13s, hence the longer timeout.
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                f"{VOYAGER_BASE}/inference/stop",
                json={"run_id": run_id},
            )
            if resp.status_code == 200:
                logger.info("Stopped inference session %s", run_id)
            else:
                logger.warning("inference/stop returned %d for %s", resp.status_code, run_id)
    except Exception as e:
        logger.warning("Could not stop voyager inference %s: %s", run_id, e)

    # Stop backend HLS stream slot
    try:
        from app.routers.stream import _stop_slot, _slots
        if _slots[stream_slot].running:
            _stop_slot(stream_slot)
    except Exception as e:
        logger.warning("Could not stop stream slot %d: %s", stream_slot, e)

    logger.info("Model removed slot=%d stream_slot=%d run_id=%s", slot, stream_slot, run_id)
    return {"status": "removed", "slot": slot}

# ── File upload endpoints ─────────────────────────────────────────────────────

@router.post("/models/upload-weights")
async def upload_weights(model_name: str = Form(...), file: UploadFile = File(...)):
    """Forward .pt weights to voyager-sdk customers/{model_name}/models/"""
    if not file.filename or not file.filename.endswith(".pt"):
        raise HTTPException(400, "Only .pt files accepted")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")

    try:
        import httpx as _httpx
        async with _httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{VOYAGER_BASE}/models/upload-weights",
                data={"model_name": model_name},
                files={"file": (file.filename, data, "application/octet-stream")},
            )
        if resp.status_code != 200:
            raise HTTPException(502, f"voyager-sdk upload error: {resp.text[:200]}")
        return resp.json()
    except _httpx.RequestError as e:
        raise HTTPException(503, f"voyager-sdk unreachable: {e}")


@router.post("/models/upload-dataset")
async def upload_dataset(dataset_name: str = Form(...), file: UploadFile = File(...)):
    """Forward YOLO dataset zip to voyager-sdk data/{dataset_name}/"""
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(400, "Only .zip files accepted")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")

    try:
        import httpx as _httpx
        async with _httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{VOYAGER_BASE}/models/upload-dataset",
                data={"dataset_name": dataset_name},
                files={"file": (file.filename, data, "application/zip")},
            )
        if resp.status_code != 200:
            raise HTTPException(502, f"voyager-sdk upload error: {resp.text[:200]}")
        return resp.json()
    except _httpx.RequestError as e:
        raise HTTPException(503, f"voyager-sdk unreachable: {e}")