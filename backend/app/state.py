"""
AppState singleton
------------------
Light state management for the backend.
Tracks: active models per slot.
Persists to /app/data/models/state.json so models survive restarts.
"""

import json
import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

STATE_FILE = Path("/app/data/models/state.json")


@dataclass
class Model:
    slot: int
    name: str
    model_id: str
    deploy_id: str = ""
    deployed: bool = False


@dataclass
class AppState:
    """Thread-safe global application state."""

    models: list[Model] = field(default_factory=list)
    source_type: Optional[str] = None
    source_value: Optional[str] = None
    _lock: threading.RLock = field(default_factory=threading.RLock)

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> None:
        """Persist models to JSON."""
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            data = [
                {
                    "slot":       m.slot,
                    "name":       m.name,
                    "model_id":   m.model_id,
                    "deploy_id":  m.deploy_id,
                    "deployed":   m.deployed,
                }
                for m in self.models
            ]
            STATE_FILE.write_text(json.dumps(data, indent=2))
        except Exception as e:
            logger.warning("Failed to save state: %s", e)

    def load(self) -> None:
        """Load persisted models from JSON."""
        try:
            if not STATE_FILE.exists():
                return
            data = json.loads(STATE_FILE.read_text())
            self.models = [
                Model(
                    slot=m["slot"],
                    name=m["name"],
                    model_id=m["model_id"],
                    deploy_id=m.get("deploy_id", ""),
                    deployed=m.get("deployed", False),
                )
                for m in data
            ]
            logger.info("Loaded %d model(s) from state file", len(self.models))
        except Exception as e:
            logger.warning("Failed to load state: %s", e)
            self.models = []

    # ── Model management ──────────────────────────────────────────────────────

    def add_model(self, name: str, model_id: str, deploy_id: str = "") -> int:
        with self._lock:
            if len(self.models) >= 4:
                raise ValueError("Maximum 4 models reached")
            slot = len(self.models) + 1
            self.models.append(Model(
                slot=slot, name=name, model_id=model_id, deploy_id=deploy_id
            ))
            self.save()
            return slot

    def remove_model(self, slot: int) -> bool:
        with self._lock:
            found = False
            for i, model in enumerate(self.models):
                if model.slot == slot:
                    self.models.pop(i)
                    found = True
                    break
            if found:
                for i, model in enumerate(self.models):
                    model.slot = i + 1
                self.save()
            return found

    def mark_deployed(self, deploy_id: str) -> bool:
        with self._lock:
            for model in self.models:
                if model.deploy_id == deploy_id:
                    model.deployed = True
                    self.save()
                    return True
            return False

    def get_models(self) -> list[Model]:
        with self._lock:
            return self.models.copy()

    def get_model_by_slot(self, slot: int) -> Optional[Model]:
        with self._lock:
            for model in self.models:
                if model.slot == slot:
                    return model
            return None

    # ── Source management ─────────────────────────────────────────────────────

    def set_source(self, source_type: str, source_value: str) -> None:
        with self._lock:
            self.source_type  = source_type
            self.source_value = source_value

    def get_source(self) -> tuple[Optional[str], Optional[str]]:
        with self._lock:
            return self.source_type, self.source_value

    def clear_source(self) -> None:
        with self._lock:
            self.source_type  = None
            self.source_value = None


# ── Global singleton ──────────────────────────────────────────────────────────

_app_state: Optional[AppState] = None
_state_lock = threading.Lock()


def get_app_state() -> AppState:
    global _app_state
    if _app_state is None:
        with _state_lock:
            if _app_state is None:
                _app_state = AppState()
                _app_state.load()   # restore models from disk on first access
    return _app_state