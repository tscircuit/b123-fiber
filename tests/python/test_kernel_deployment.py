"""Deployment wiring: actual native geometry, browser access and request limits."""

import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


ENTRYPOINT = Path(__file__).resolve().parents[2] / "deployment/kernel/app.py"
spec = importlib.util.spec_from_file_location("kernel_deployment", ENTRYPOINT)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
client = TestClient(deployment.app)


def test_deployment_renders_native_shape():
    response = client.post("/render", json={"plan": {"version": 1, "children": [{"type": "Box", "props": {"args": [2, 3, 4]}, "children": []}]}})
    assert response.status_code == 200
    meshes = response.json()["meshes"]
    assert len(meshes) == 1
    assert meshes[0]["volume"] == pytest.approx(24)
    assert len(meshes[0]["indices"]) == 36


def test_deployment_allows_sandbox_origin():
    response = client.options("/render", headers={"Origin": "https://b123.tscircuit.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://b123.tscircuit.com"


def test_deployment_rejects_oversized_request():
    response = client.post("/render", content=b"x" * (deployment.MAX_REQUEST_BYTES + 1), headers={"Content-Type": "application/json", "Origin": "https://b123.tscircuit.com"})
    assert response.status_code == 413
    assert response.json()["error"]["type"] == "PayloadTooLarge"
    assert response.headers["access-control-allow-origin"] == "https://b123.tscircuit.com"


def test_deployment_rejects_oversized_chunked_request():
    response = client.post("/render", content=(b"x" * (1024 * 1024) for _ in range(5)), headers={"Content-Type": "application/json"})
    assert response.status_code == 413
