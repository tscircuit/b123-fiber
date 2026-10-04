"""Independent native comparisons for collection, assembly and wire parity."""

import base64
from datetime import date, datetime, timezone
import math
from pathlib import Path
import uuid

import build123d as b
import ezdxf
import pytest

from build123d_fiber import Kernel, KernelError


def node(kind, props=None, *children):
    return {"type": kind, "props": props or {}, "children": list(children)}


def render(kernel, *children):
    return kernel.render({"plan": {"version": 1, "children": list(children)}})


def native_call(name, *args, **kwargs):
    return {"$call": name, "args": list(args), "kwargs": kwargs}


def assert_geometry(result, expected):
    assert result["meshes"]
    assert sum(mesh["volume"] for mesh in result["meshes"]) == pytest.approx(expected.volume)
    assert sum(mesh["area"] for mesh in result["meshes"]) == pytest.approx(expected.area)
    bounds = expected.bounding_box()
    assert result["bounds"]["min"] == pytest.approx(list(bounds.min), abs=2e-6)
    assert result["bounds"]["max"] == pytest.approx(list(bounds.max), abs=2e-6)
    for mesh in result["meshes"]:
        assert mesh["valid"] == expected.is_valid
        assert all(math.isfinite(v) for v in mesh["positions"] + mesh["normals"])
        assert all(0 <= index < len(mesh["positions"]) // 3 for index in mesh["indices"])


@pytest.mark.parametrize("children", [False, True])
def test_pack_collection_renders_and_matches_native_and_rpc(children):
    kernel = Kernel()
    boxes = [native_call("Box", 2, 3, 4), native_call("Box", 3, 3, 3)]
    props = {"padding": 1, "id": "packed"}
    if children:
        inputs = [node("Box", {"args": [2, 3, 4]}), node("Box", {"args": [3, 3, 3]})]
    else:
        props["objects"] = boxes
        inputs = []
    result = render(kernel, node("pack", props, *inputs))
    expected = b.pack([b.Box(2, 3, 4), b.Box(3, 3, 3)], padding=1)
    assert len(result["meshes"]) == 2
    assert_geometry(result, b.Compound(expected))
    rpc = kernel.rpc({"op": "function", "name": "pack", "kwargs": {"objects": boxes, "padding": 1}})["value"]
    assert [kernel.decode(ref).volume for ref in rpc] == pytest.approx([s.volume for s in expected])


@pytest.mark.parametrize("format,exporter,importer,argument", [
    ("svg", b.ExportSVG, b.import_svg, "svg_file"),
    ("dxf", b.ExportDXF, b.import_dxf, "dxf_file"),
])
def test_profile_import_collection_and_embedded_file_survive_fresh_kernel(tmp_path, format, exporter, importer, argument):
    path = tmp_path / f"rectangle.{format}"
    writer = exporter()
    writer.add_shape(b.Rectangle(6, 4))
    writer.write(path)
    expected = b.Compound(list(importer(path)))
    file_value = {"$file": {"name": path.name, "base64": base64.b64encode(path.read_bytes()).decode()}}
    for workspace in (tmp_path / "first", tmp_path / "second"):
        kernel = Kernel(workspace)
        result = render(kernel, node(importer.__name__, {argument: file_value}))
        assert_geometry(result, expected)
        rpc = kernel.rpc({"op": "function", "name": importer.__name__, "args": [file_value]})["value"]
        assert rpc["kind"] == "ShapeList"
        assert len(kernel.decode(rpc)) == len(importer(path))
        resolved = Path(kernel.decode(file_value))
        assert resolved.is_relative_to(workspace)
        assert resolved.suffix == f".{format}"
        assert resolved.read_bytes() == path.read_bytes()


@pytest.mark.parametrize("children", [False, True])
def test_edges_to_wires_collection_keeps_native_length(children):
    kernel = Kernel()
    props, inputs = {}, []
    if children:
        inputs = [node("Line", {"args": [[0, 0, 0], [3, 0, 0]]})]
    else:
        props["edges"] = [native_call("Line", [0, 0, 0], [3, 0, 0])]
    result = render(kernel, node("edges_to_wires", props, *inputs))
    expected = b.Compound(b.edges_to_wires([b.Line((0, 0, 0), (3, 0, 0))]))
    assert_geometry(result, expected)
    assert result["meshes"][0]["edges"] == [[0, 0, 0, 3, 0, 0]]


def test_nested_collection_shapes_keep_capture_placement_and_overrides():
    kernel = Kernel()
    first = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    second = kernel.rpc({"op": "construct", "name": "Sphere", "args": [1]})["value"]
    shape = node("Shape", {"shape": [first, [second]], "id": "collection", "name": "placed", "color": "#00ff00"})
    copied_second = {"$index": {"target": {"$index": {"target": {"$ref": "collection"}, "index": 1}}, "index": 0}}
    result = render(kernel, node("Translate", {"offset": [8, 0, 0]}, shape), node("Shape", {"shape": copied_second}))
    expected = b.Compound([b.Box(2, 3, 4).moved(b.Pos(8, 0, 0)), b.Sphere(1).moved(b.Pos(8, 0, 0)), b.Sphere(1).moved(b.Pos(8, 0, 0))])
    assert len(result["meshes"]) == 3
    assert_geometry(result, expected)
    assert all(mesh["name"] == "placed" and mesh["color"] == "#00ff00" for mesh in result["meshes"][:2])


@pytest.mark.parametrize("member", list(b.ColorIndex))
def test_colorindex_roundtrip_and_dxf_layer_match_native(tmp_path, member):
    kernel = Kernel(tmp_path)
    wire = {"$enum": f"ColorIndex.{member.name}"}
    assert kernel.decode(kernel.encode(member)) is member
    writer = kernel.rpc({"op": "construct", "name": "ExportDXF", "kwargs": {"color": wire}})["value"]
    kernel.rpc({"op": "method", "target": writer, "name": "add_layer", "args": ["colored"], "kwargs": {"color": wire}})
    kernel.rpc({"op": "method", "target": writer, "name": "add_shape", "args": [native_call("Rectangle", 6, 4)], "kwargs": {"layer": "colored"}})
    bridge_path = tmp_path / "bridge.dxf"
    kernel.rpc({"op": "method", "target": writer, "name": "write", "args": [str(bridge_path)]})
    direct = b.ExportDXF(color=member)
    direct.add_layer("colored", color=member)
    direct.add_shape(b.Rectangle(6, 4), layer="colored")
    direct_path = tmp_path / "direct.dxf"
    direct.write(direct_path)
    bridge, native = ezdxf.readfile(bridge_path), ezdxf.readfile(direct_path)
    assert bridge.layers.get("0").color == native.layers.get("0").color == member.value
    assert bridge.layers.get("colored").color == native.layers.get("colored").color == member.value
    assert set(kernel.api()["exports"]) == set(b.__all__)
    assert "ColorIndex" in kernel.api()["auxiliarySymbols"]


def colored_assembly():
    red = b.Box(2, 2, 2)
    red.label, red.color = "red box", b.Color("red")
    blue = b.Box(2, 2, 2).moved(b.Pos(5, 0, 0))
    blue.label, blue.color = "blue box", b.Color("blue")
    subgroup = b.Compound(children=[red, blue], label="subassembly").moved(b.Pos(0, 3, 0) * b.Rot(0, 0, 25))
    return b.Compound(children=[subgroup], label="assembly").moved(b.Pos(10, 0, 0) * b.Rot(0, 0, 90))


@pytest.mark.parametrize("overrides", [False, True])
def test_native_nested_assembly_preserves_child_world_geometry_and_metadata(overrides):
    kernel = Kernel()
    assembly = colored_assembly()
    props = {"shape": kernel.retain(assembly)}
    if overrides:
        props.update(name="explicit", color="#00ff00")
    result = render(kernel, node("Shape", props))
    assert len(result["meshes"]) == 2
    # Native Compound.volume only sums immediate solid children; nested
    # assembly volume is zero. Compare actual native world-space leaf geometry.
    native_leaves = [child.located(child.global_location) for child in assembly.descendants if child.is_leaf]
    assert_geometry(result, b.Compound(native_leaves))
    for mesh, child in zip(result["meshes"], assembly.children[0].children):
        assert mesh["name"] == ("explicit" if overrides else child.label)
        assert mesh["color"] == ("#00ff00" if overrides else list(child.color))
        assert mesh["assemblyPath"] == [{"name": "assembly", "index": 0}, {"name": "subassembly", "index": 0}]
        positions = mesh["positions"]
        world_bounds = child.located(child.global_location).bounding_box()
        assert [min(positions[axis::3]) for axis in range(3)] == pytest.approx(list(world_bounds.min), abs=1e-6)
        assert [max(positions[axis::3]) for axis in range(3)] == pytest.approx(list(world_bounds.max), abs=1e-6)


def test_imported_step_assembly_keeps_leaf_labels_colors_and_world_placement(tmp_path):
    path = tmp_path / "assembly.step"
    b.export_step(colored_assembly(), path)
    expected = b.import_step(path)
    kernel = Kernel(tmp_path)
    result = render(kernel, node("import_step", {"filename": str(path)}))
    assert len(result["meshes"]) == 2
    native_leaves = [child.located(child.global_location) for child in expected.descendants if child.is_leaf]
    assert_geometry(result, b.Compound(native_leaves))
    assert {mesh["name"] for mesh in result["meshes"]} == {child.label for child in expected.descendants if child.is_leaf}
    assert {tuple(mesh["color"]) for mesh in result["meshes"]} == {(1, 0, 0, 1), (0, 0, 1, 1)}
    assert all(mesh["assemblyPath"] for mesh in result["meshes"])


def test_compound_jsx_children_preserve_nested_parts_and_apply_transforms_once():
    assembly = node("Compound", {"label": "outer"},
                    node("Compound", {"label": "inner"},
                         node("Box", {"args": [2, 2, 2], "name": "red", "color": "#ff0000"}),
                         node("Translate", {"offset": [5, 0, 0]},
                              node("Box", {"args": [2, 2, 2], "name": "blue", "color": "#0000ff"}))))
    result = render(Kernel(), node("Translate", {"offset": [10, 0, 0]}, assembly))
    expected = b.Compound([b.Box(2, 2, 2).moved(b.Pos(10, 0, 0)), b.Box(2, 2, 2).moved(b.Pos(15, 0, 0))])
    assert len(result["meshes"]) == 2
    assert_geometry(result, expected)
    assert [mesh["name"] for mesh in result["meshes"]] == ["red", "blue"]
    assert [mesh["color"] for mesh in result["meshes"]] == [[1, 0, 0, 1], [0, 0, 1, 1]]
    assert all(mesh["assemblyPath"] == [{"name": "outer", "index": 0}, {"name": "inner", "index": 0}] for mesh in result["meshes"])


def test_section_children_return_section_instead_of_input_part():
    result = render(Kernel(), node("section", {}, node("Box", {"args": [2, 3, 4]})))
    assert_geometry(result, b.section(b.Box(2, 3, 4)))
    assert result["meshes"][0]["volume"] == 0


def test_project_children_match_explicit_native_face_projection():
    props = {"workplane": {"$type": "Plane", "path": "XY"}}
    result = render(Kernel(), node("project", props, node("Circle", {"radius": 2, "position": [0, 0, 3]})))
    expected = b.project(b.Circle(2).face().moved(b.Pos(0, 0, 3)), workplane=b.Plane.XY)
    assert_geometry(result, expected)
    assert result["bounds"]["max"][2] == pytest.approx(0)


def test_project_vertex_collection_remains_visible_as_points():
    props = {"objects": [native_call("Vector", 1, 2, 3)], "workplane": {"$type": "Plane", "path": "XY"}}
    result = render(Kernel(), node("project", props))
    expected = b.project([b.Vector(1, 2, 3)], workplane=b.Plane.XY)
    assert result["meshes"][0]["vertices"] == list(expected[0])
    assert result["bounds"]["min"] == pytest.approx(list(expected[0]))


def test_full_round_children_accept_active_edge_selection():
    edge = {"$select": "edges", "sort": {"$type": "Axis", "path": "X"}, "index": -1}
    result = render(Kernel(), node("full_round", {"edge": edge}, node("Rectangle", {"args": [6, 4]})))
    source = b.Rectangle(6, 4)
    expected = b.full_round(source.edges().sort_by(b.Axis.X)[-1])
    assert_geometry(result, expected)


def test_draft_children_accept_native_selected_faces():
    faces = {"$method": {"target": {"$select": "faces"}, "name": "filter_by", "args": [{"$type": "Axis", "path": "Z"}], "kwargs": {"reverse": True}}}
    props = {"faces": faces, "neutral_plane": {"$type": "Plane", "path": "XY"}, "angle": 5}
    result = render(Kernel(), node("draft", props, node("Box", {"args": [6, 4, 3]})))
    source = b.Box(6, 4, 3)
    expected = b.draft(source.faces().filter_by(b.Axis.Z, reverse=True), neutral_plane=b.Plane.XY, angle=5)
    assert_geometry(result, expected)


def test_brake_formed_children_support_positional_thickness_and_width():
    result = render(Kernel(), node("make_brake_formed", {"args": [1, 6]}, node("Polyline", {"args": [[0, 0], [10, 0], [10, 10]]})))
    expected = b.make_brake_formed(1, 6, line=b.Polyline((0, 0), (10, 0), (10, 10)))
    assert_geometry(result, expected)


def test_round_reversed_next_and_collection_mutation_match_native():
    kernel = Kernel()
    vector = kernel.rpc({"op": "construct", "name": "Vector", "args": [1.234, 2.345, 3.456]})["value"]
    rounded = kernel.decode(kernel.rpc({"op": "operator", "target": vector, "name": "round", "args": [2]})["value"])
    assert tuple(rounded) == tuple(round(b.Vector(1.234, 2.345, 3.456), 2))
    box = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    edges = kernel.rpc({"op": "method", "target": box, "name": "edges"})["value"]
    direct = b.Box(2, 3, 4).edges()
    iterator = kernel.rpc({"op": "operator", "target": edges, "name": "reversed"})["value"]
    first = kernel.decode(kernel.rpc({"op": "operator", "target": iterator, "name": "next"})["value"])
    assert first.length == pytest.approx(next(reversed(direct)).length)
    replacement = kernel.rpc({"op": "construct", "name": "Line", "args": [[0, 0, 0], [9, 0, 0]]})["value"]
    kernel.rpc({"op": "setitem", "target": edges, "index": 0, "value": replacement})
    direct[0] = b.Line((0, 0, 0), (9, 0, 0))
    kernel.rpc({"op": "delitem", "target": edges, "index": {"$slice": [1, 3]}})
    del direct[1:3]
    assert [edge.length for edge in kernel.decode(edges)] == pytest.approx([edge.length for edge in direct])


def test_retained_native_callable_invocation_and_expression_match_topological_distance():
    kernel = Kernel()
    box = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    edges = kernel.rpc({"op": "method", "target": box, "name": "edges"})["value"]
    source = kernel.rpc({"op": "index", "target": edges, "value": 0})["value"]
    function = kernel.rpc({"op": "function", "name": "topo_distance_to", "args": [source]})["value"]
    direct_edges = b.Box(2, 3, 4).edges()
    expected_key = b.topo_distance_to(direct_edges[0])
    distances = []
    for index, expected_edge in enumerate(direct_edges):
        edge = kernel.rpc({"op": "index", "target": edges, "value": index})["value"]
        value = kernel.rpc({"op": "invoke", "target": function, "args": [edge]})["value"]
        assert value == expected_key(expected_edge)
        assert kernel.decode({"$apply": {"target": function, "args": [edge]}}) == value
        distances.append(value)
    # Native callback handles still work as native function arguments; the
    # expression form can also call them from a serialized selector predicate.
    sorted_edges = kernel.decode(kernel.rpc({"op": "method", "target": edges, "name": "sort_by", "args": [function]})["value"])
    assert [b.topo_distance_to(kernel.decode(source))(edge) for edge in sorted_edges] == sorted(distances)
    callback = {"$lambda": {"$apply": {"target": function, "args": [{"$arg": 0}]}}}
    expression_sorted = kernel.decode(kernel.rpc({"op": "method", "target": edges, "name": "sort_by", "args": [callback]})["value"])
    assert [edge.length for edge in expression_sorted] == pytest.approx([edge.length for edge in direct_edges.sort_by(expected_key)])


def test_native_callable_invocation_preserves_path_validation_and_blocks_noncallables(tmp_path):
    kernel = Kernel(tmp_path)
    importer = kernel.rpc({"op": "get", "target": {"$type": "import_brep"}})["value"]
    with pytest.raises(KernelError, match="inside kernel workspace"):
        kernel.rpc({"op": "invoke", "target": importer, "args": ["../outside.brep"]})
    box = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    with pytest.raises(KernelError) as error:
        kernel.rpc({"op": "invoke", "target": box})
    assert error.value.error_type == "TypeError"
    assert error.value.path == "rpc.invoke."
    with pytest.raises(TypeError, match="not callable"):
        kernel.decode({"$apply": {"target": box}})
    with pytest.raises(KernelError, match="public native API"):
        kernel.rpc({"op": "method", "target": importer, "name": "__call__"})
    with pytest.raises(KernelError, match="Unknown build123d symbol"):
        kernel.rpc({"op": "invoke", "target": {"$type": "eval"}, "args": ["1 + 1"]})


def test_binary_stream_export_and_wire_values_preserve_native_types(tmp_path):
    kernel = Kernel(tmp_path)
    data = b"\x00\xffnative\r\n"
    stream = kernel.rpc({"op": "construct", "name": "BytesIO", "args": [{"$bytes": base64.b64encode(data).decode()}]})["value"]
    value = kernel.rpc({"op": "method", "target": stream, "name": "getvalue"})["value"]
    assert kernel.decode(value) == data
    output = kernel.rpc({"op": "construct", "name": "BytesIO"})["value"]
    shape = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 3, 4]})["value"]
    assert kernel.rpc({"op": "function", "name": "export_brep", "args": [shape, output]})["value"]
    brep = kernel.decode(kernel.rpc({"op": "method", "target": output, "name": "getvalue"})["value"])
    path = tmp_path / "stream.brep"
    path.write_bytes(brep)
    imported = b.import_brep(path)
    assert imported.volume == pytest.approx(b.Box(2, 3, 4).volume)
    for native in (date(2026, 10, 4), datetime(2026, 10, 4, 12, 30, tzinfo=timezone.utc), uuid.UUID("12345678-1234-1234-1234-123456789abc")):
        decoded = kernel.decode(kernel.encode(native))
        assert type(decoded) is type(native)
        assert decoded == native


@pytest.mark.parametrize("wire", [
    {"$bytes": "!invalid!"}, {"$bytes": 123}, {"$date": "yesterday"},
    {"$uuid": "not-a-uuid"}, {"$file": {"name": "../outside.step", "base64": ""}},
    {"$file": {"name": "folder\\outside.step", "base64": ""}},
])
def test_invalid_typed_values_are_rejected_without_native_execution(wire, tmp_path):
    kernel = Kernel(tmp_path)
    with pytest.raises(KernelError):
        kernel.rpc({"op": "construct", "name": "BytesIO", "args": [wire]})
    assert not list(tmp_path.iterdir())


def test_embedded_files_and_binary_payloads_enforce_size_and_symlink_containment(tmp_path, monkeypatch):
    import build123d_fiber.kernel as kernel_module
    monkeypatch.setattr(kernel_module, "MAX_FILE_BYTES", 16)
    kernel = Kernel(tmp_path / "workspace")
    with pytest.raises(ValueError, match="32 MiB"):
        kernel.decode({"$bytes": base64.b64encode(b"x" * 17).decode()})
    kernel.workspace_root.mkdir()
    (kernel.workspace_root / ".uploads").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="inside the kernel workspace"):
        kernel.decode({"$file": {"name": "x.step", "base64": base64.b64encode(b"x").decode()}})
    assert list(tmp_path.iterdir()) == [kernel.workspace_root]
