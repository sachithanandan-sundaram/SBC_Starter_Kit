from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # App
    app_env: str = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    log_level: str = "info"

    # Data directories
    recordings_dir: str = "/app/data/recordings"  # Always fixed in Docker

    # HLS
    hls_dir: str = "/app/data/hls"
    hls_segment_duration: int = 2
    hls_playlist_size: int = 6

    # Voyager SDK
    voyager_sdk_url: str = "http://voyager-sdk:8001"

    # Path to the voyager-sdk checkout *inside* the voyager-sdk container.
    # Raspberry Pi 5 + M.2 starter kit used a fixed "/home/voyager-sdk".
    # On the Metis Compute Board the pre-built Axelera container may use a
    # different home directory (e.g. under /home/antelao/shared) depending on
    # SDK version — override via VOYAGER_SDK_DIR in backend/.env after
    # confirming the path inside the running container
    # (`docker exec <container> pwd` from the SDK shell).
    voyager_sdk_dir: str = "/home/voyager-sdk"

    # Host-side gateway IP of the docker bridge network ("app-net") that the
    # backend container uses to reach MediaMTX, which runs directly on the
    # host (not inside a container) on both the Raspberry Pi 5 and the Metis
    # Compute Board. Docker assigns this address when the network is created;
    # it is NOT guaranteed to be 172.18.0.1 — verify with
    # `docker network inspect app-net` and override via MEDIAMTX_HOST if the
    # bridge subnet differs (this is common when other docker networks
    # already occupy 172.17-18.x.x on a given host).
    mediamtx_host: str = "172.18.0.1"
    mediamtx_rtsp_port: int = 8554
    mediamtx_hls_port: int = 8888
    rtsp_transport: str = "udp"

    # CORS
    cors_origins: str = "http://localhost:8080,http://localhost:5173"

    @property
    def is_development(self) -> bool:
        return self.app_env == "development"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    @property
    def recordings_path(self) -> Path:
        return Path(self.recordings_dir)

    @property
    def hls_path(self) -> Path:
        return Path(self.hls_dir)

    def ensure_data_dirs(self) -> None:
        """Create data directories if they don't exist."""
        self.hls_path.mkdir(parents=True, exist_ok=True)
        self.recordings_path.mkdir(parents=True, exist_ok=True)
        Path("/app/data/events").mkdir(parents=True, exist_ok=True)
        Path("/app/data/models").mkdir(parents=True, exist_ok=True)
        Path("/app/data/uploads").mkdir(parents=True, exist_ok=True)

settings = Settings()
