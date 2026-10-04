"""Backend regressions for native scopes, safe transport, and tessellation."""

from concurrent.futures import ThreadPoolExecutor
import math

import build123d as b
import pytest
from fastapi.testclient import TestClient

from build123d_fiber import Kernel, KernelError
from build123d_fiber.server import create_app


def node(kind, props=None, children=None):
    return {"type": kind, "props": props or {}, "children": children or []}


def render(kernel, *nodes):
    return kernel.render({"plan": {"version": 1, "children": list(nodes)}})


def test_operation_children_keep_native_workplane_products():
    kernel = Kernel()
    extrusion = render(kernel, node("extrude", {"amount": 4}, [node("Rectangle", {"args": [3, 5]})]))
    assert extrusion["meshes"][0]["volume"] == pytest.approx(60)
    loft = render(kernel, node("loft", {}, [
        node("BuildSketch", {"args": [{"$type": "Plane", "path": "XY"}]}, [node("Rectangle", {"args": [8, 8]})]),
        node("BuildSketch", {"args": [{"$call": "Plane", "kwargs": {"origin": [0, 0, 8]}}]}, [node("Circle", {"args": [3]})]),
    ]))
    with b.BuildPart() as expected:
        with b.BuildSketch(b.Plane.XY):
            b.Rectangle(8, 8)
        with b.BuildSketch(b.Plane(origin=(0, 0, 8))):
            b.Circle(3)
        b.loft()
    assert loft["meshes"][0]["volume"] == pytest.approx(expected.part.volume)
    assert loft["bounds"]["max"][2] == pytest.approx(8, abs=1e-6)


def test_child_operation_subtraction_publishes_once():
    result = render(Kernel(), node("Subtract", {}, [
        node("Box", {"args": [10, 10, 10]}),
        node("extrude", {"amount": 20}, [node("Circle", {"args": [2]})]),
    ]))
    # Extrusion extends from z=0 through the top half of the centered box.
    assert result["meshes"][0]["volume"] == pytest.approx(1000 - math.pi*4*5)


def test_symbolic_callback_filter_and_sort_preserve_native_shape_list():
    kernel = Kernel()
    shape = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    edges = kernel.rpc({"op": "method", "target": shape, "name": "edges"})["value"]
    assert edges["kind"] == "ShapeList"
    predicate = {"$lambda": {"$operator": {"target": {"$get": {"target": {"$arg": 0}, "name": "length"}}, "name": "gt", "args": [3.5]}}}
    selected = kernel.rpc({"op": "method", "target": edges, "name": "filter_by", "args": [predicate]})["value"]
    assert kernel.rpc({"op": "operator", "target": selected, "name": "len"})["value"] == 4
    lengths = kernel.decode({"$method": {"target": edges, "name": "sort_by", "args": [{"$lambda": {"$get": {"target": {"$arg": 0}, "name": "length"}}}]}})
    assert [edge.length for edge in lengths] == sorted(edge.length for edge in lengths)


def test_normals_are_unit_and_outward_from_native_box():
    mesh = render(Kernel(), node("Box", {"args": [2, 3, 4]}))["meshes"][0]
    assert len(mesh["positions"]) == len(mesh["normals"])
    for index in range(0, len(mesh["positions"]), 3):
        point, normal = mesh["positions"][index:index+3], mesh["normals"][index:index+3]
        assert math.sqrt(sum(x*x for x in normal)) == pytest.approx(1)
        assert sum(point[axis]*normal[axis] for axis in range(3)) > 0


def test_0d_and_1d_native_geometry_are_not_dropped():
    kernel = Kernel()
    point = render(kernel, node("Vertex", {"args": [1, 2, 3]}))["meshes"][0]
    line = render(kernel, node("Line", {"args": [[1, 2, 3], [4, 5, 6]]}))["meshes"][0]
    assert point["vertices"] == [1, 2, 3]
    assert not point["positions"] and not point["edges"]
    assert line["edges"] == [[1, 2, 3, 4, 5, 6]]


def test_error_restores_builder_scope_for_next_request():
    kernel = Kernel()
    with pytest.raises(KernelError) as caught:
        render(kernel, node("BuildPart", {}, [node("BuildSketch", {}, [node("Circle", {"not_radius": 2})])]))
    assert "children[0].children[0].children[0]" in caught.value.path
    result = render(kernel, node("Box", {"args": [2, 3, 4]}))
    assert result["meshes"][0]["volume"] == pytest.approx(24)
    assert b.BuildPart._get_context(log=False) is None


def test_parallel_calls_are_serialized_without_scope_leaks():
    kernel = Kernel()
    def build(size):
        return render(kernel, node("BuildPart", {}, [node("Box", {"args": [size, 2, 3]})]))["meshes"][0]["volume"]
    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(build, range(1, 9))) == pytest.approx([6*size for size in range(1, 9)])


@pytest.mark.parametrize("api_name", ["import_step", "import_brep", "import_svg", "import_dxf"])
def test_file_read_containment(api_name, tmp_path):
    kernel = Kernel(tmp_path)
    with pytest.raises(KernelError, match="inside kernel workspace"):
        kernel.rpc({"op": "function", "name": api_name, "args": ["../outside.step"]})


def test_export_relative_paths_are_based_on_workspace_and_symlinks_blocked(tmp_path):
    kernel = Kernel(tmp_path)
    shape = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    kernel.rpc({"op": "function", "name": "export_brep", "args": [shape, "shape.brep"]})
    assert (tmp_path / "shape.brep").is_file()
    imported = kernel.rpc({"op": "function", "name": "import_brep", "args": ["shape.brep"]})["value"]
    assert kernel.rpc({"op": "get", "target": imported, "name": "volume"})["value"] == pytest.approx(24)
    (tmp_path / "escape").symlink_to(tmp_path.parent, target_is_directory=True)
    with pytest.raises(KernelError, match="inside kernel workspace"):
        kernel.rpc({"op": "function", "name": "export_brep", "args": [shape, "escape/outside.brep"]})


def test_private_access_and_raw_eval_are_not_available():
    kernel = Kernel()
    shape = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    with pytest.raises(KernelError, match="public"):
        kernel.rpc({"op": "get", "target": shape, "name": "__class__"})
    with pytest.raises(KernelError, match="Unknown build123d symbol"):
        kernel.rpc({"op": "function", "name": "eval", "args": ["1 + 1"]})


def test_native_tangent_and_shape_list_sort_operator_overloads():
    kernel = Kernel()
    line = kernel.rpc({"op": "construct", "name": "Line", "args": [[0, 0, 0], [3, 4, 0]]})["value"]
    tangent = kernel.decode(kernel.rpc({"op": "operator", "target": line, "name": "%", "args": [0.5]})["value"])
    native_tangent = b.Line((0, 0, 0), (3, 4, 0)) % 0.5
    assert (tangent.X, tangent.Y, tangent.Z) == pytest.approx((native_tangent.X, native_tangent.Y, native_tangent.Z))
    shape = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    edges = kernel.rpc({"op": "method", "target": shape, "name": "edges"})["value"]
    for name in (">>", "<<"):
        result = kernel.decode(kernel.rpc({"op": "operator", "target": edges, "name": name, "args": [{"$type": "Axis", "path": "Z"}]})["value"])
        expected = kernel.decode(edges) >> b.Axis.Z if name == ">>" else kernel.decode(edges) << b.Axis.Z
        assert [edge.center().Z for edge in result] == pytest.approx([edge.center().Z for edge in expected])


def test_http_auth_errors_inventory_and_configured_cors(tmp_path):
    with TestClient(create_app(tmp_path, token="test-token", origins=["http://localhost:4567"])) as client:
        assert client.get("/health").status_code == 401
        headers = {"Authorization": "Bearer test-token"}
        inventory = client.get("/api", headers=headers)
        assert inventory.status_code == 200
        assert set(inventory.json()["exports"]) == set(b.__all__)
        assert len(inventory.json()["exports"]) == 203
        response = client.post("/render", json={"plan": {"version": 1, "children": [node("unknown")]}}, headers=headers)
        assert response.status_code == 422
        assert response.json()["error"]["path"] == "plan.children[0]"
        preflight = client.options("/render", headers={"Origin": "http://localhost:4567", "Access-Control-Request-Method": "POST"})
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "http://localhost:4567"
