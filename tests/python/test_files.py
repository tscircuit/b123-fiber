"""Actual native CAD round trips through browser upload/download and stream APIs."""

import base64
import io
from pathlib import Path

import build123d as b
from fastapi.testclient import TestClient
import pytest

from build123d_fiber import Kernel
from build123d_fiber.server import create_app


def node(type, **props):
    return {"type": type, "props": props, "children": []}


def plan(type="Box", **props):
    return {"version": 1, "children": [node(type, **(props or {"args": [2, 3, 4]}))]}


@pytest.mark.parametrize("format", ["step", "stl", "brep", "svg", "dxf"])
def test_browser_native_round_trip_and_durable_import_plan(tmp_path, format):
    original = b.Rectangle(6, 4) if format in {"svg", "dxf"} else b.Box(2, 3, 4)
    scene = plan("Rectangle", width=6, height=4) if format in {"svg", "dxf"} else plan()
    with TestClient(create_app(tmp_path)) as client:
        exported = client.post("/files/export", json={"plan": scene, "format": format, "filename": f"part.{format}"})
        assert exported.status_code == 200, exported.text
        assert exported.content
        assert "attachment" in exported.headers["content-disposition"]
        imported = client.post(f"/files/import?filename=part.{format}", content=exported.content)
        assert imported.status_code == 200, imported.text
        result = imported.json()
        assert result["result"]["meshes"]
        if format != "stl":
            assert all(mesh["valid"] for mesh in result["result"]["meshes"])
        assert result["plan"]["children"][0]["props"]["args"][0]["$file"]["name"] == f"part.{format}"
        # No retained ref is needed to run this plan on a fresh worker/workspace.
        fresh = Kernel(tmp_path / "fresh")
        rerendered = fresh.render({"plan": result["plan"]})
        assert rerendered["meshes"]
        assert not fresh.objects
        if format in {"step", "brep"}:
            assert sum(mesh["volume"] for mesh in rerendered["meshes"]) == pytest.approx(original.volume, rel=1e-6)
        elif format in {"svg", "dxf"}:
            imported_native = getattr(b, f"import_{format}")(fresh.decode(result["plan"]["children"][0]["props"]["args"][0]))
            assert sum(mesh["area"] for mesh in rerendered["meshes"]) == pytest.approx(sum(shape.area for shape in imported_native))
            assert sum(len(mesh["edges"]) for mesh in rerendered["meshes"]) > 0
        else:
            imported_native = b.import_stl(fresh.decode(result["plan"]["children"][0]["props"]["args"][0]))
            assert rerendered["meshes"][0]["valid"] == imported_native.is_valid
            assert sum(len(mesh["indices"]) for mesh in rerendered["meshes"]) > 0
            assert rerendered["bounds"]["max"] == pytest.approx([1, 1.5, 2], abs=1e-6)
        exported_again = client.post("/files/export", json={"plan": result["plan"], "format": format})
        assert exported_again.status_code == 200, exported_again.text
        assert exported_again.content


def test_upload_ids_auth_cors_and_cleanup(tmp_path):
    with TestClient(create_app(tmp_path, token="files-token", origins=["https://sandbox.example"])) as client:
        authorization = {"Authorization": "Bearer files-token", "Origin": "https://sandbox.example"}
        denied = client.post("/files?filename=hello.bin", content=b"hello", headers={"Origin": "https://sandbox.example"})
        assert denied.status_code == 401
        assert denied.headers["access-control-allow-origin"] == "https://sandbox.example"
        uploaded = client.post("/files?filename=hello.bin", content=b"hello\x00world", headers=authorization)
        assert uploaded.status_code == 200
        file = uploaded.json()["file"]
        assert file["size"] == 11
        assert not Path(file["path"]).is_absolute()
        assert (tmp_path / file["path"]).read_bytes() == b"hello\x00world"
        downloaded = client.get(f"/files/{file['id']}", headers=authorization)
        assert downloaded.content == b"hello\x00world"
        assert "Content-Disposition" in downloaded.headers["access-control-expose-headers"]
        assert client.get(f"/files/{file['id']}").status_code == 401
        assert client.delete(f"/files/{file['id']}", headers=authorization).json() == {"deleted": True}
        assert client.get(f"/files/{file['id']}", headers=authorization).status_code == 404
        preflight = client.options("/files/anything", headers={"Origin": "https://sandbox.example", "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "Authorization"})
        assert preflight.status_code == 200


@pytest.mark.parametrize("name", ["../outside.step", "dir/file.step", "dir\\file.step", ".", "..", "evil\r\nheader.step"])
def test_upload_filename_traversal_is_rejected(tmp_path, name):
    with TestClient(create_app(tmp_path)) as client:
        assert client.post("/files", params={"filename": name}, content=b"data").status_code == 422


def test_symlinked_file_storage_and_download_escape_blocked(tmp_path):
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    with TestClient(create_app(tmp_path)) as client:
        (tmp_path / ".b123-fiber-files").symlink_to(outside, target_is_directory=True)
        assert client.post("/files", content=b"data").status_code == 422
        (tmp_path / ".b123-fiber-files").unlink()
        file = client.post("/files", content=b"data").json()["file"]
        secret = outside / "secret"
        secret.write_text("outside")
        path = tmp_path / file["path"]
        path.unlink()
        path.symlink_to(secret)
        assert client.get(f"/files/{file['id']}").status_code == 422
        assert secret.read_text() == "outside"


def test_file_errors_limit_and_native_export_targets(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert client.post("/files", content=b"x", headers={"Content-Length": str(32 * 1024 * 1024 + 1)}).status_code == 413
        assert client.post("/files/import?format=obj", content=b"x").status_code == 422
        assert client.post("/files/import?format=step&options=not-json", content=b"x").status_code == 422
        assert client.post("/files/export", json={"plan": plan(), "format": "obj"}).status_code == 422
        assert client.post("/files/export", json={"plan": plan(), "format": "step", "filename": "../outside.step"}).status_code == 422
        shape = client.post("/rpc", json={"op": "construct", "name": "Box", "args": [2, 3, 4]}).json()["value"]
        exported = client.post("/files/export", json={"target": shape, "format": "step"})
        assert exported.status_code == 200
        assert b"ISO-10303" in exported.content
        assert client.post("/files/export", json={"target": {"$ref": "missing"}, "format": "step"}).status_code == 422
        assert client.post("/files/export", json={"plan": {"version": 1, "children": []}, "format": "step"}).status_code == 422
        assert client.post("/files/import?format=step", content=b"not-a-step-file").status_code == 422


@pytest.mark.parametrize("kind", ["bytes", "text"])
def test_http_stream_contents_native_overloads_and_release(tmp_path, kind):
    with TestClient(create_app(tmp_path)) as client:
        content = b"stream contents" if kind == "bytes" else "text \u03bb stream".encode()
        created = client.post(f"/streams?kind={kind}", content=content)
        stream = created.json()["value"]
        assert stream["kind"] == ("BytesIO" if kind == "bytes" else "StringIO")
        assert client.get(f"/streams/{stream['$ref']}").content == content
        native = client.post("/rpc", json={"op": "method", "target": stream, "name": "getvalue"}).json()["value"]
        assert native == ({"$bytes": base64.b64encode(content).decode()} if kind == "bytes" else content.decode())
        assert client.post(f"/streams/{stream['$ref']}", content=b"replacement").status_code == 200
        assert client.get(f"/streams/{stream['$ref']}").content == b"replacement"
        client.post("/rpc", json={"op": "release", "target": stream})
        assert client.get(f"/streams/{stream['$ref']}").status_code == 404


def test_binary_stream_native_step_brep_svg_dxf_exports(tmp_path):
    kernel = Kernel(tmp_path)
    box = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    for format in ("step", "brep"):
        stream = kernel.rpc({"op": "construct", "name": "BytesIO"})["value"]
        assert kernel.rpc({"op": "function", "name": f"export_{format}", "args": [box, stream]})["value"]
        encoded = kernel.rpc({"op": "method", "target": stream, "name": "getvalue"})["value"]
        content = base64.b64decode(encoded["$bytes"])
        assert content
        path = tmp_path / f"part.{format}"
        path.write_bytes(content)
        assert getattr(b, f"import_{format}")(path).volume == pytest.approx(24)
    rectangle = kernel.rpc({"op": "construct", "name": "Rectangle", "args": [6, 4]})["value"]
    for format in ("svg", "dxf"):
        writer = kernel.rpc({"op": "construct", "name": "ExportSVG" if format == "svg" else "ExportDXF"})["value"]
        kernel.rpc({"op": "method", "target": writer, "name": "add_shape", "args": [rectangle]})
        stream = kernel.rpc({"op": "construct", "name": "BytesIO"})["value"]
        kernel.rpc({"op": "method", "target": writer, "name": "write", "args": [stream]})
        content = base64.b64decode(kernel.rpc({"op": "method", "target": stream, "name": "getvalue"})["value"]["$bytes"])
        # SVG supports text streams; DXF supports both text and binary streams.
        read_stream = kernel.rpc({"op": "construct", "name": "StringIO", "args": [content.decode()]})["value"]
        imported = kernel.decode(kernel.rpc({"op": "function", "name": f"import_{format}", "args": [read_stream]})["value"])
        assert imported
        assert sum(shape.area for shape in imported) == pytest.approx(sum(shape.area for shape in getattr(b, f"import_{format}")(io.StringIO(content.decode()))))
