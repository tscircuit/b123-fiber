"""Independent regressions for native bridge composition and value identity."""

from enum import Enum

import build123d as b
import pytest

from build123d_fiber import Kernel


def node(kind, props=None, *children):
    return {"type": kind, "props": props or {}, "children": list(children)}


def render(kernel, child):
    return kernel.render({"plan": {"version": 1, "children": [child]}})


def assert_geometry(result, expected):
    assert len(result["meshes"]) == 1
    mesh = result["meshes"][0]
    assert mesh["valid"]
    assert mesh["volume"] == pytest.approx(expected.volume)
    assert mesh["area"] == pytest.approx(expected.area)
    bounds = expected.bounding_box()
    assert result["bounds"]["min"] == pytest.approx(list(bounds.min))
    assert result["bounds"]["max"] == pytest.approx(list(bounds.max))


@pytest.mark.parametrize("wrapper", ["Group", "Translate", "Locations", "Call", "NestedCall"])
def test_subtract_wrappers_preserve_boolean_mode(wrapper):
    kernel = Kernel()
    sphere = node("Sphere", {"radius": 3})
    if wrapper == "Group":
        cutter = node("Group", {}, sphere)
    elif wrapper == "Translate":
        cutter = node("Translate", {"offset": [1, 0, 0]}, sphere)
    elif wrapper == "Locations":
        cutter = node("Locations", {"args": [[1, 0, 0]]}, sphere)
    else:
        cutter = node("Call", {"symbol": "Sphere", "kwargs": {"radius": 3}})
        if wrapper == "NestedCall":
            cutter = node("Group", {}, cutter)
    expected_cutter = b.Sphere(3)
    if wrapper in {"Translate", "Locations"}:
        expected_cutter = expected_cutter.moved(b.Pos(1, 0, 0))
    result = render(kernel, node("Subtract", {}, node("Box", {"args": [10, 10, 10]}), cutter))
    assert_geometry(result, b.Box(10, 10, 10) - expected_cutter)


@pytest.mark.parametrize("source", ["retained", "static_call"])
@pytest.mark.parametrize("transform", ["Translate", "Rotate"])
def test_transforms_apply_to_returned_native_shapes(source, transform):
    kernel = Kernel()
    expected = b.Solid.make_box(2, 3, 4)
    if source == "retained":
        reference = kernel.rpc({"op": "method", "target": {"$type": "Solid"}, "name": "make_box", "args": [2, 3, 4]})["value"]
        shape = node("Shape", {"shape": reference})
    else:
        shape = node("Call", {"symbol": "Solid.make_box", "args": [2, 3, 4]})
    if transform == "Translate":
        props = {"offset": [10, 0, 0]}
        expected = expected.moved(b.Pos(10, 0, 0))
    else:
        props = {"angles": [0, 0, 90]}
        expected = expected.moved(b.Rot(0, 0, 90))
    assert_geometry(render(kernel, node(transform, props, shape)), expected)


@pytest.mark.parametrize("builder", ["BuildPart", "Union"])
def test_call_static_shape_is_added_to_active_builder(builder):
    kernel = Kernel()
    first = node("Call", {"symbol": "Solid.make_box", "args": [2, 3, 4]})
    second = node("Call", {"symbol": "Solid.make_box", "args": [3, 2, 4]})
    expected = b.Solid.make_box(2, 3, 4) + b.Solid.make_box(3, 2, 4)
    assert_geometry(render(kernel, node(builder, {}, first, second)), expected)


def test_shape_capture_reflects_placement_inside_builder():
    kernel = Kernel()
    reference = kernel.rpc({"op": "construct", "name": "Box", "args": [2, 2, 2]})["value"]
    first = node("Translate", {"offset": [10, 0, 0]}, node("Shape", {"shape": reference, "id": "placed"}))
    original = {"$method": {"target": {"$ref": "placed"}, "name": "moved", "args": [{"$call": "Pos", "args": [-10, 0, 0]}]}}
    second = node("Shape", {"shape": original})
    expected = b.Box(2, 2, 2).moved(b.Pos(10, 0, 0)) + b.Box(2, 2, 2)
    assert_geometry(render(kernel, node("BuildPart", {}, first, second)), expected)


def test_deferred_mirror_honors_explicit_native_replace_mode():
    kernel = Kernel()
    child = node("Box", {"args": [2, 2, 2], "position": [0, 5, 0]})
    props = {"about": {"$type": "Plane", "path": "XZ"}, "mode": {"$enum": "Mode.REPLACE"}}
    with b.BuildPart() as expected:
        with b.Locations((0, 5, 0)):
            b.Box(2, 2, 2)
        b.mirror(about=b.Plane.XZ, mode=b.Mode.REPLACE)
    assert_geometry(render(kernel, node("mirror", props, child)), expected.part)


def test_loft_accepts_native_vertex_endpoint_child():
    kernel = Kernel()
    child = node("loft", {}, node("Circle", {"radius": 3}), node("Vertex", {"args": [0, 0, 5]}))
    expected = b.loft([b.Circle(3), b.Vertex(0, 0, 5)])
    assert_geometry(render(kernel, child), expected)


@pytest.mark.parametrize("source", ["deferred_operation", "boolean", "transform"])
def test_composed_node_capture_is_a_shape(source):
    kernel = Kernel()
    if source == "deferred_operation":
        first = node("extrude", {"amount": 4, "id": "product"}, node("Circle", {"radius": 2}))
        expected = b.extrude(b.Circle(2), amount=4)
    elif source == "boolean":
        first = node("Union", {"id": "product"}, node("Box", {"args": [2, 3, 4]}), node("Sphere", {"radius": 1}))
        expected = b.Box(2, 3, 4) + b.Sphere(1)
    else:
        first = node("Translate", {"id": "product", "offset": [10, 0, 0]}, node("Box", {"args": [2, 3, 4]}))
        expected = b.Box(2, 3, 4).moved(b.Pos(10, 0, 0))
    second = node("Shape", {"shape": {"$ref": "product"}})
    result = kernel.render({"plan": {"version": 1, "children": [first, second]}})
    assert len(result["meshes"]) == 2
    for mesh in result["meshes"]:
        assert mesh["valid"]
        assert mesh["volume"] == pytest.approx(expected.volume)
        assert mesh["area"] == pytest.approx(expected.area)
    bounds = expected.bounding_box()
    assert result["bounds"]["min"] == pytest.approx(list(bounds.min))
    assert result["bounds"]["max"] == pytest.approx(list(bounds.max))


@pytest.mark.parametrize("name", [name for name in b.__all__ if isinstance(getattr(b, name), type) and issubclass(getattr(b, name), Enum)])
def test_every_enum_member_roundtrips_with_native_identity(name):
    kernel = Kernel()
    for member in getattr(b, name):
        encoded = kernel.encode(member)
        assert encoded == {"$enum": f"{type(member).__name__}.{member.name}"}
        assert kernel.decode(encoded) is member


def test_strenum_property_roundtrip_can_be_reused_as_constructor_argument():
    kernel = Kernel()
    draft = kernel.rpc({"op": "construct", "name": "Draft", "kwargs": {"unit": {"$enum": "Unit.IN"}}})["value"]
    unit = kernel.rpc({"op": "get", "target": draft, "name": "unit"})["value"]
    assert unit == {"$enum": "Unit.IN"}
    second = kernel.rpc({"op": "construct", "name": "Draft", "kwargs": {"unit": unit}})["value"]
    assert kernel.decode(second).unit is b.Unit.IN
