"""Independent native fixtures for the less frequently exercised build123d API."""

from __future__ import annotations

import datetime
import json
import math
import struct
import xml.etree.ElementTree as ET
import zipfile

import build123d as b
import pytest

from build123d_fiber import Kernel, KernelError


def call(name, *args, **kwargs):
    return {"$call": name, "args": list(args), "kwargs": kwargs}


def method(target, name, *args, **kwargs):
    return {"$method": {"target": target, "name": name, "args": list(args), "kwargs": kwargs}}


def enum(name):
    return {"$enum": name}


def plane(name):
    return {"$type": "Plane", "path": name}


def fixtures():
    line0 = call("Line", [0, 0], [2, 0])
    line1 = call("Line", [5, 3], [5, 5])
    draft_style = call("Draft", font_size=2, arrow_length=1, font="DejaVu Sans")
    return [
        ("airfoil", "Airfoil", ["2412"], {"n_points": 25, "finite_te": True}, lambda: b.Airfoil("2412", n_points=25, finite_te=True)),
        ("blend-c1", "BlendCurve", [line0, line1], {"continuity": enum("ContinuityLevel.C1")}, lambda: b.BlendCurve(b.Line((0, 0), (2, 0)), b.Line((5, 3), (5, 5)), continuity=b.ContinuityLevel.C1)),
        ("blend-c2", "BlendCurve", [line0, line1], {}, lambda: b.BlendCurve(b.Line((0, 0), (2, 0)), b.Line((5, 3), (5, 5)))),
        ("constrained-lines", "ConstrainedLines", [call("CenterArc", [-5, 0], 4, 0, 360), call("CenterArc", [5, 0], 3, 0, 360)], {}, lambda: b.ConstrainedLines(b.CenterArc((-5, 0), 4, 0, 360), b.CenterArc((5, 0), 3, 0, 360))),
        ("constrained-arcs", "ConstrainedArcs", [[0, 0], [4, 0]], {"radius": 3, "sagitta": enum("Sagitta.BOTH")}, lambda: b.ConstrainedArcs((0, 0), (4, 0), radius=3, sagitta=b.Sagitta.BOTH)),
        ("double-tangent", "DoubleTangentArc", [[0, 0], [1, 0], call("Line", [5, -5], [5, 5])], {}, lambda: b.DoubleTangentArc((0, 0), (1, 0), b.Line((5, -5), (5, 5)))),
        ("technical-drawing", "TechnicalDrawing", [], {"designed_by": "Fixture", "design_date": {"$date": "2024-01-02"}, "title": "Bracket", "nominal_text_size": 4}, lambda: b.TechnicalDrawing(designed_by="Fixture", design_date=datetime.date(2024, 1, 2), title="Bracket", nominal_text_size=4)),
        ("dimension-line", "DimensionLine", [[[0, 0], [30, 0]], draft_style], {"tolerance": [0.1, 0.2]}, lambda: b.DimensionLine([(0, 0), (30, 0)], b.Draft(font_size=2, arrow_length=1, font="DejaVu Sans"), tolerance=(0.1, 0.2))),
        ("extension-line", "ExtensionLine", [[[0, 0], [30, 0]], [0, 5], draft_style], {}, lambda: b.ExtensionLine([(0, 0), (30, 0)], (0, 5), b.Draft(font_size=2, arrow_length=1, font="DejaVu Sans"))),
        ("draft", "draft", [method(method(call("Box", 8, 6, 10), "faces"), "filter_by", {"$type": "Axis", "path": "Z"}, reverse=True)], {"neutral_plane": method(plane("XY"), "offset", -5), "angle": 3}, lambda: b.draft(b.Box(8, 6, 10).faces().filter_by(b.Axis.Z, reverse=True), b.Plane.XY.offset(-5), 3)),
        ("full-round", "full_round", [{"$index": {"target": method(method(call("Rectangle", 8, 4), "edges"), "sort_by", {"$type": "Axis", "path": "X"}), "index": -1}}], {"voronoi_point_count": 30}, lambda: b.full_round(b.Rectangle(8, 4).edges().sort_by(b.Axis.X)[-1], voronoi_point_count=30)),
        ("brake-formed", "make_brake_formed", [1, 5, call("Polyline", [0, 0], [10, 0], [10, 5])], {}, lambda: b.make_brake_formed(1, 5, b.Polyline((0, 0), (10, 0), (10, 5)))),
        ("projection", "project", [method(method(call("Rectangle", 4, 6), "face"), "moved", call("Pos", Z=5))], {"workplane": plane("XY")}, lambda: b.project(b.Rectangle(4, 6).face().moved(b.Pos(Z=5)), workplane=b.Plane.XY)),
    ]


@pytest.mark.parametrize("_id,name,args,kwargs,native", fixtures(), ids=[f[0] for f in fixtures()])
def test_advanced_native_rpc_and_render(_id, name, args, kwargs, native, tmp_path):
    kernel = Kernel(tmp_path)
    expected = native()
    operation = "construct" if isinstance(getattr(b, name), type) else "function"
    encoded = kernel.rpc({"op": operation, "name": name, "args": args, "kwargs": kwargs})["value"]
    assert "$ref" in encoded
    actual = kernel.decode(encoded)
    assert actual.is_valid == expected.is_valid
    for metric in ("volume", "area", "length"):
        if hasattr(expected, metric):
            value = kernel.rpc({"op": "get", "target": encoded, "name": metric})["value"]
            assert value == pytest.approx(getattr(expected, metric), rel=1e-6, abs=1e-5)
    for collection in ("vertices", "edges", "faces", "solids"):
        selected = kernel.rpc({"op": "method", "target": encoded, "name": collection})["value"]
        assert len(kernel.decode(selected)) == len(getattr(expected, collection)())
    request = {"plan": {"version": 1, "children": [{"type": name, "props": {"args": args, **kwargs}, "children": []}]}}
    rendered = kernel.render(request)
    assert rendered["bounds"] is not None
    assert rendered["meshes"]
    assert sum(m["volume"] for m in rendered["meshes"]) == pytest.approx(expected.volume, rel=1e-6, abs=1e-5)
    assert sum(m["area"] for m in rendered["meshes"]) == pytest.approx(expected.area, rel=1e-6, abs=1e-5)
    bbox = expected.bounding_box()
    assert rendered["bounds"]["min"] == pytest.approx(list(bbox.min), abs=2e-5)
    assert rendered["bounds"]["max"] == pytest.approx(list(bbox.max), abs=2e-5)
    for mesh in rendered["meshes"]:
        assert mesh["valid"]
        assert all(math.isfinite(x) for x in mesh["positions"] + mesh["normals"])
        assert all(0 <= index < len(mesh["positions"]) // 3 for index in mesh["indices"])
        assert mesh["edges"] or mesh["indices"]


def rpc(kernel, op, **kwargs):
    return kernel.rpc({"op": op, **kwargs})["value"]


def test_mesher_3mf_roundtrip_preserves_geometry_and_metadata(tmp_path):
    kernel = Kernel(tmp_path)
    shape = rpc(kernel, "construct", name="Box", args=[2, 3, 4])
    rpc(kernel, "set", target=shape, name="label", value="fixture-part")
    rpc(kernel, "set", target=shape, name="color", value=call("Color", "red"))
    writer = rpc(kernel, "construct", name="Mesher")
    rpc(kernel, "method", target=writer, name="add_shape", args=[shape], kwargs={"part_number": "P-123", "uuid_value": {"$uuid": "12345678-1234-5678-1234-567812345678"}})
    rpc(kernel, "method", target=writer, name="write", args=["bridge.3mf"])
    path = tmp_path / "bridge.3mf"
    with zipfile.ZipFile(path) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
        assert model.attrib["unit"] == "millimeter"
        assert len(model.findall(".//{*}triangle")) == 12
    independent = b.Mesher().read(path)
    assert len(independent) == 1
    assert independent[0].volume == pytest.approx(24)
    assert independent[0].label == "fixture-part"
    assert tuple(independent[0].color) == pytest.approx((1, 0, 0, 1))
    reader = rpc(kernel, "construct", name="Mesher")
    returned = rpc(kernel, "method", target=reader, name="read", args=["bridge.3mf"])
    assert len(returned) == 1
    assert rpc(kernel, "get", target=returned[0], name="volume") == pytest.approx(independent[0].volume)
    properties = rpc(kernel, "method", target=reader, name="get_mesh_properties")
    assert len(properties) == 1


def test_detect_primitives_reconstructs_mesh_box_planes(tmp_path):
    path = tmp_path / "box.3mf"
    mesher = b.Mesher()
    mesher.add_shape(b.Box(2, 3, 4))
    mesher.write(path)
    native_mesh = b.Mesher().read(path)[0]
    expected_primitives, expected_remaining, expected_code = b.detect_primitives(native_mesh)
    assert len(expected_primitives) == 6
    assert len(expected_remaining) == 0
    kernel = Kernel(tmp_path)
    reader = rpc(kernel, "construct", name="Mesher")
    mesh = rpc(kernel, "method", target=reader, name="read", args=["box.3mf"])[0]
    primitives, remaining, code = rpc(kernel, "function", name="detect_primitives", args=[mesh])
    assert len(kernel.decode(primitives)) == len(expected_primitives)
    assert len(kernel.decode(remaining)) == len(expected_remaining)
    assert code == expected_code
    for actual, expected in zip(kernel.decode(primitives), expected_primitives):
        assert actual.geom_type == b.GeomType.PLANE
        assert actual.area == pytest.approx(expected.area)


def test_native_stl_face_detection_error_is_preserved(tmp_path):
    # Native import_stl returns a triangulated Face; primitive detection expects
    # topological triangle faces (e.g. Mesher.read), rather than that OCCT Face.
    path = tmp_path / "box.stl"
    b.export_stl(b.Box(2, 3, 4), path)
    with pytest.raises(Exception) as direct:
        b.detect_primitives(b.import_stl(path))
    kernel = Kernel(tmp_path)
    mesh = rpc(kernel, "function", name="import_stl", args=["box.stl"])
    with pytest.raises(KernelError) as bridged:
        rpc(kernel, "function", name="detect_primitives", args=[mesh])
    assert bridged.value.error_type == type(direct.value).__name__
    assert bridged.value.message == str(direct.value)


@pytest.mark.parametrize("binary", [False, True], ids=["gltf", "glb"])
def test_gltf_exports_parse_and_include_uvs(tmp_path, binary):
    kernel = Kernel(tmp_path)
    shape = rpc(kernel, "construct", name="Box", args=[2, 3, 4])
    path = tmp_path / ("box.glb" if binary else "box.gltf")
    assert rpc(kernel, "function", name="export_gltf", args=[shape, str(path)], kwargs={"binary": binary})
    data = path.read_bytes()
    if binary:
        magic, version, size = struct.unpack_from("<4sII", data)
        assert (magic, version, size) == (b"glTF", 2, len(data))
        chunk_size, chunk_kind = struct.unpack_from("<I4s", data, 12)
        assert chunk_kind == b"JSON"
        document = json.loads(data[20:20 + chunk_size])
    else:
        document = json.loads(data)
        for buffer in document["buffers"]:
            assert (path.parent / buffer["uri"]).stat().st_size == buffer["byteLength"]
    assert document["asset"]["version"] == "2.0"
    primitives = [p for mesh in document["meshes"] for p in mesh["primitives"]]
    assert primitives
    assert all("POSITION" in p["attributes"] and "TEXCOORD_0" in p["attributes"] for p in primitives)
    assert sum(document["accessors"][p["indices"]]["count"] for p in primitives) == 36


def test_obj_export_vertices_faces_normals_and_uvs(tmp_path):
    kernel = Kernel(tmp_path)
    shape = rpc(kernel, "construct", name="Box", args=[2, 3, 4])
    assert rpc(kernel, "function", name="export_obj", args=[shape, "box.obj"])
    lines = (tmp_path / "box.obj").read_text().splitlines()
    vertices = [line for line in lines if line.startswith("v ")]
    uvs = [line for line in lines if line.startswith("vt ")]
    normals = [line for line in lines if line.startswith("vn ")]
    faces = [line for line in lines if line.startswith("f ")]
    assert vertices and uvs and normals
    assert len(faces) == 12
    for face in faces:
        assert len(face.split()) == 4
        for vertex in face.split()[1:]:
            vi, ti, ni = map(int, vertex.split("/"))
            assert 1 <= vi <= len(vertices)
            assert 1 <= ti <= len(uvs)
            assert 1 <= ni <= len(normals)
