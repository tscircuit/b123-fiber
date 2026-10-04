"""Final boolean composition regressions against independent native algebra."""

import build123d as b
import pytest

from build123d_fiber import Kernel


def node(kind, props=None, *children):
    return {"type": kind, "props": props or {}, "children": list(children)}


def render(*children):
    return Kernel().render({"plan": {"version": 1, "children": list(children)}})


def box(x=0):
    return node("Box", {"args": [2, 2, 2], "position": [x, 0, 0]})


def assert_geometry(result, expected):
    assert len(result["meshes"]) == 1
    mesh = result["meshes"][0]
    assert mesh["valid"]
    assert mesh["volume"] == pytest.approx(expected.volume)
    assert mesh["area"] == pytest.approx(expected.area)
    bounds = expected.bounding_box()
    assert result["bounds"]["min"] == pytest.approx(list(bounds.min))
    assert result["bounds"]["max"] == pytest.approx(list(bounds.max))


def assert_empty(result):
    assert result["meshes"] == []
    assert result["bounds"] is None


@pytest.mark.parametrize("kind", ["Union", "Subtract", "Intersect"])
def test_grouped_transformed_multi_solid_operand_matches_native_algebra(kind):
    grouped = node("Group", {}, node("Box", {"args": [5, 2, 4], "position": [-4, 0, 0]}), node("Box", {"args": [5, 2, 4], "position": [4, 0, 0]}))
    transformed = node("Translate", {"offset": [3, 2, 1]}, node("Rotate", {"angles": [0, 0, 90]}, grouped))
    group = (b.Box(5, 2, 4).moved(b.Pos(-4, 0, 0)) + b.Box(5, 2, 4).moved(b.Pos(4, 0, 0))).moved(b.Pos(3, 2, 1) * b.Rot(0, 0, 90))
    base = b.Box(14, 14, 6)
    expected = base + group if kind == "Union" else base - group if kind == "Subtract" else base & group
    assert_geometry(render(node(kind, {}, node("Box", {"args": [14, 14, 6]}), transformed)), expected)


@pytest.mark.parametrize("kind", ["Union", "Subtract", "Intersect"])
@pytest.mark.parametrize("empty_first", [False, True])
def test_nested_empty_operand_keeps_its_position(kind, empty_first):
    empty = node("Intersect", {}, box(), box(10))
    children = [empty, box()] if empty_first else [box(), empty]
    result = render(node(kind, {}, *children))
    if kind == "Intersect" or kind == "Subtract" and empty_first:
        assert_empty(result)
    else:
        assert_geometry(result, b.Box(2, 2, 2))


def test_empty_intersection_never_revives_on_a_later_operand():
    assert_empty(render(node("Intersect", {}, box(), box(10), box())))


@pytest.mark.parametrize("kind", ["Intersect", "Subtract"])
def test_empty_boolean_capture_remains_a_reusable_native_shape(kind):
    first = node(kind, {"id": "empty"}, box(), box(10) if kind == "Intersect" else box())
    assert_empty(render(first, node("Shape", {"shape": {"$ref": "empty"}})))


@pytest.mark.parametrize("mode", ["ADD", "PRIVATE", "SUBTRACT", "INTERSECT", "REPLACE"])
def test_boolean_publication_in_parent_builder_matches_native_mode(mode):
    shape = b.Cylinder(2, 20).moved(b.Pos(-6, 0, 0)) + b.Cylinder(2, 20).moved(b.Pos(6, 0, 0))
    with b.BuildPart() as direct:
        b.Box(14, 14, 14)
        b.insert(shape, mode=getattr(b.Mode, mode))
    operand = node("Union", {"mode": {"$enum": f"Mode.{mode}"}}, node("Cylinder", {"radius": 2, "height": 20, "position": [-6, 0, 0]}), node("Cylinder", {"radius": 2, "height": 20, "position": [6, 0, 0]}))
    assert_geometry(render(node("BuildPart", {}, node("Box", {"args": [14, 14, 14]}), operand)), direct.part)


@pytest.mark.parametrize("kind", ["Union", "Subtract", "Intersect"])
@pytest.mark.parametrize("inside_builder", [False, True])
def test_native_locations_replicate_completed_boolean_once(kind, inside_builder):
    base, other = b.Box(4, 3, 4), b.Cylinder(1, 6)
    product = base + other if kind == "Union" else base - other if kind == "Subtract" else base & other
    expected = product.moved(b.Pos(-10, 0, 0)) + product.moved(b.Pos(10, 0, 0))
    child = node(kind, {}, node("Box", {"args": [4, 3, 4]}), node("Cylinder", {"radius": 1, "height": 6}))
    scene = node("Locations", {"args": [[-10, 0, 0], [10, 0, 0]]}, child)
    if inside_builder:
        scene = node("BuildPart", {}, scene)
    assert_geometry(render(scene), expected)


@pytest.mark.parametrize("mode", ["ADD", "PRIVATE", "SUBTRACT", "INTERSECT", "REPLACE"])
def test_empty_boolean_publication_preserves_native_insert_behavior(mode):
    # Native insert of an empty Compound leaves an existing builder unchanged,
    # including INTERSECT and REPLACE. Preserve the pinned native API behavior.
    with b.BuildPart() as direct:
        b.Box(2, 2, 2)
        b.insert(b.Compound([]), mode=getattr(b.Mode, mode))
    empty = node("Intersect", {"mode": {"$enum": f"Mode.{mode}"}}, box(), box(10))
    assert_geometry(render(node("BuildPart", {}, box(), empty)), direct.part)


@pytest.mark.parametrize("placement", ["metadata", "wrapper"])
def test_boolean_own_placement_is_applied_once(placement):
    product = b.Box(2, 3, 4) + b.Cylinder(1, 6)
    children = [node("Box", {"args": [2, 3, 4]}), node("Cylinder", {"radius": 1, "height": 6})]
    scene = node("Union", {"position": [10, 0, 0]}, *children) if placement == "metadata" else node("Translate", {"offset": [10, 0, 0]}, node("Union", {}, *children))
    assert_geometry(render(scene), product.moved(b.Pos(10, 0, 0)))


def test_boolean_output_preserves_assembly_color_and_name_metadata():
    combined = node("Union", {"name": "combined", "color": "#db9463"}, node("Box", {"args": [2, 3, 4], "color": "red"}), node("Cylinder", {"radius": 1, "height": 6, "color": "blue"}))
    separate = node("Box", {"args": [2, 2, 2], "position": [10, 0, 0], "name": "separate", "color": [0.2, 0.4, 0.8, 0.35]})
    result = render(node("Group", {}, combined, separate))
    assert len(result["meshes"]) == 2
    assert [(mesh["name"], mesh["color"]) for mesh in result["meshes"]] == [("combined", "#db9463"), ("separate", [0.2, 0.4, 0.8, 0.35])]
    assert result["meshes"][0]["volume"] == pytest.approx((b.Box(2, 3, 4) + b.Cylinder(1, 6)).volume)
    assert result["meshes"][1]["volume"] == pytest.approx(8)
