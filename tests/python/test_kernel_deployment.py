"""Deployment wiring: actual native geometry, browser access and request limits."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest
from fastapi.testclient import TestClient


ENTRYPOINT = Path(__file__).resolve().parents[2] / "deployment/kernel/app.py"
spec = importlib.util.spec_from_file_location("kernel_deployment", ENTRYPOINT)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
client = TestClient(deployment.app)


def test_fresh_deployment_preserves_drawing_text_and_native_single_line_font(tmp_path):
    # Import the hosting entrypoint before build123d, just as a cold function
    # does. Reusing pytest's OCCT singleton can conceal missing font setup.
    script = textwrap.dedent("""
        import importlib.util, json, sys
        from pathlib import Path
        from fastapi.testclient import TestClient

        assert "build123d" not in sys.modules
        entrypoint = Path(sys.argv[1])
        spec = importlib.util.spec_from_file_location("cold_kernel", entrypoint)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        import build123d as b
        from OCP.TCollection import TCollection_AsciiString
        text = b.Text("CAD", font_size=4)
        family, font_path, _ = b.Compound.resolve_font("Arial", None, b.FontStyle.REGULAR)
        relief = b.FontManager().manager.GetFont(TCollection_AsciiString("Relief SingleLine CAD"))
        response = TestClient(module.app).post("/render", json={
            "tolerance": 0.12, "angularTolerance": 0.15,
            "plan": {"version": 1, "children": [{
                "type": "TechnicalDrawing", "children": [], "props": {
                    "designed_by": "Fixture", "design_date": {"$date": "2024-01-02"},
                    "title": "Bracket", "nominal_text_size": 4,
                },
            }]},
        })
        response.raise_for_status()
        rendered = response.json()
        print(json.dumps({
            "family": family, "fontPath": font_path, "textArea": text.area,
            "relief": relief is not None, "bounds": rendered["bounds"],
            "area": sum(mesh["area"] for mesh in rendered["meshes"]),
            "triangles": sum(len(mesh["indices"]) // 3 for mesh in rendered["meshes"]),
        }))
    """)
    environment = {**os.environ, "BUILD123D_FIBER_WORKSPACE": str(tmp_path), "XDG_CACHE_HOME": str(tmp_path / "cache")}
    result = subprocess.run([sys.executable, "-", str(ENTRYPOINT)], input=script, text=True, capture_output=True, env=environment, timeout=60)
    assert result.returncode == 0, result.stderr
    actual = json.loads(result.stdout.splitlines()[-1])
    assert actual["family"] == "DejaVu Sans"
    assert Path(actual["fontPath"]) == ENTRYPOINT.parent / "fonts/DejaVuSans.ttf"
    assert actual["textArea"] > 0
    assert actual["relief"]
    assert actual["area"] == pytest.approx(859.0661334908299)
    assert actual["triangles"] == 7338
    assert actual["bounds"]["min"] == pytest.approx([-143.577148, -97.441406, 0], abs=5e-4)
    assert actual["bounds"]["max"] == pytest.approx([143.547852, 97.583984, 0], abs=5e-4)


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
