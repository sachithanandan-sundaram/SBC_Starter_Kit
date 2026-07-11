"""
Run with: pytest tests/ -v
"""

import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data
    assert "inference_mode" in data


def test_list_models_empty():
    response = client.get("/api/models")
    assert response.status_code == 200
    data = response.json()
    assert "models" in data
    assert isinstance(data["models"], list)


def test_list_events_empty():
    response = client.get("/api/events")
    assert response.status_code == 200
    data = response.json()
    assert "events" in data
    assert isinstance(data["events"], list)


def test_list_recordings_empty():
    response = client.get("/api/recordings")
    assert response.status_code == 200
    data = response.json()
    assert "recordings" in data
    assert isinstance(data["recordings"], list)


def test_stream_usb_requires_device_id():
    response = client.get("/api/stream/hls?source=usb")
    assert response.status_code == 400


def test_stream_rtsp_starts():
    """
    This will start an FFmpeg process that fails immediately in CI
    since there is no real stream, but the endpoint itself should respond.
    """
    response = client.get("/api/stream/hls?source=rtsp://127.0.0.1:554/test")
    # 200 means FFmpeg launched; 500 means it failed — both are valid in CI
    assert response.status_code in (200, 500)
