import logging
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.config import settings
from app.state import get_app_state
from app.routers import health
from app.routers import stream
from app.routers import models
from app.routers import recordings
from app.routers import playback

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


async def _sync_models_from_voyager() -> None:
    """
    On startup, restore deployed models from voyager-sdk if backend state is empty.
    Priority: state.json on disk first, then voyager-sdk /deployed-models.
    """
    import httpx

    state = get_app_state()

    if state.get_models():
        logger.info("State restored from disk: %d model(s)", len(state.get_models()))
        return

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{settings.voyager_sdk_url}/deployed-models")
        if resp.status_code != 200:
            return
        deployed = resp.json()
        for model_name, info in deployed.items():
            try:
                deploy_id = info.get("deploy_id", "")
                state.add_model(name=model_name, model_id=model_name, deploy_id=deploy_id)
                state.mark_deployed(deploy_id)
                logger.info("Restored model from voyager-sdk: %s", model_name)
            except ValueError:
                break
    except Exception as e:
        logger.debug("Could not sync models from voyager-sdk: %s", e)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("Starting Unified Dashboard  [env=%s]", settings.app_env)
    settings.ensure_data_dirs()

    bundled_model = Path("/app/yolo11n.pt")
    target_model  = Path("/app/data/models/yolo11n.pt")
    if bundled_model.exists() and not target_model.exists():
        target_model.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundled_model, target_model)
        logger.info("Bootstrapped default model to %s", target_model)

    await _sync_models_from_voyager()
    yield
    # Clean up persistent HTTP clients
    await stream._close_mediamtx_client()
    logger.info("Shutting down")


app = FastAPI(
    title="Unified Dashboard API",
    version="1.0.0",
    description="AI vision inference backend",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

if settings.is_development:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(health.router,     prefix="/api")
app.include_router(stream.router,     prefix="/api")
app.include_router(models.router,     prefix="/api")
app.include_router(recordings.router, prefix="/api")
app.include_router(playback.router,   prefix="/api")

_hls_dir = Path("/app/data/hls")
if not _hls_dir.exists():
    _hls_dir = Path("data/hls")
    _hls_dir.mkdir(parents=True, exist_ok=True)

app.mount("/hls", StaticFiles(directory=str(_hls_dir)), name="hls")

_dist = Path("dist")
if _dist.exists():
    app.mount("/", StaticFiles(directory="dist", html=True), name="frontend")

    @app.exception_handler(404)
    async def spa_fallback(_request, _exc):
        index = _dist / "index.html"
        if index.exists():
            return FileResponse(str(index))
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Not found"}, status_code=404)
else:
    logger.warning("dist/ not found — frontend not built. Run `npm run build` in frontend/ first.")