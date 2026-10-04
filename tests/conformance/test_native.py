"""Behavioral checks against independently constructed native OCCT shapes.

Run with: .venv/bin/python -m unittest discover -s tests/conformance -v
These tests do real modeling and tessellation. They deliberately do not infer
expected geometry from bridge output, generated declarations or API inventory.
"""

from __future__ import annotations

import math
import inspect
import json
from enum import Enum
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

import build123d as b
from build123d_fiber import Kernel, KernelError

try:
    from .cases import CASES
except ImportError:
    from cases import CASES


def native(value):
    """JSON arrays correspond to Python tuple vectors/rotation parameters."""
    if isinstance(value, list):
        return tuple(native(item) for item in value)
    if isinstance(value, dict):
        return {key: native(item) for key, item in value.items()}
    return value


def node(kind, args=(), children=(), **kwargs):
    return {"type": kind, "props": {"args": list(args), **kwargs}, "children": list(children)}


def plan(*children):
    return {"version": 1, "children": list(children)}


def constant(kind, path):
    return {"$type": kind, "path": path}


def enum(path):
    return {"$enum": path}


class NativeConformance(unittest.TestCase):
    def setUp(self):
        self.kernel = Kernel()

    def render(self, *children, **options):
        return self.kernel.render({"plan": plan(*children), "tolerance": 0.15, **options})

    def rpc(self, op, **request):
        response = self.kernel.rpc({"op": op, **request})
        self.assertIn("value", response)
        return response["value"]

    def construct(self, name, *args, **kwargs):
        return self.rpc("construct", name=name, args=list(args), kwargs=kwargs)

    def method(self, target, name, *args, **kwargs):
        return self.rpc("method", target=target, name=name, args=list(args), kwargs=kwargs)

    def get(self, target, name):
        return self.rpc("get", target=target, name=name)

    def function(self, name, *args, **kwargs):
        return self.rpc("function", name=name, args=list(args), kwargs=kwargs)

    def assertNumber(self, actual, expected, places=6):
        self.assertTrue(math.isfinite(actual), actual)
        self.assertAlmostEqual(actual, expected, delta=max(10 ** -places, abs(expected) * 10 ** -places))

    def assertVector(self, encoded, expected):
        expected = b.Vector(expected)
        if isinstance(encoded, list):
            values = encoded
        else:
            values = [self.get(encoded, name) for name in ("X", "Y", "Z")]
        self.assertEqual(len(values), 3)
        for actual, target in zip(values, expected):
            self.assertNumber(actual, target)

    def assertNativeShape(self, encoded, expected):
        self.assertEqual(self.get(encoded, "is_valid"), bool(expected.is_valid))
        self.assertNumber(self.get(encoded, "volume"), expected.volume)
        self.assertNumber(self.get(encoded, "area"), expected.area)
        bounds = self.method(encoded, "bounding_box")
        golden = expected.bounding_box()
        self.assertVector(self.get(bounds, "min"), golden.min)
        self.assertVector(self.get(bounds, "max"), golden.max)
        for name in ("solids", "faces", "edges", "vertices"):
            actual = self.method(encoded, name)
            self.assertEqual(self.collectionLength(actual), len(getattr(expected, name)()), name)

    def collectionLength(self, encoded):
        if isinstance(encoded, list):
            return len(encoded)
        return self.rpc("operator", target=encoded, name="len", args=[])

    def assertRendered(self, response, expected):
        self.assertIn("kernel", response)
        self.assertTrue(response["meshes"], "native nonempty shape must be represented")
        self.assertNumber(sum(mesh["volume"] for mesh in response["meshes"]), expected.volume)
        self.assertNumber(sum(mesh["area"] for mesh in response["meshes"]), expected.area)
        self.assertTrue(all(mesh["valid"] for mesh in response["meshes"]))
        golden = expected.bounding_box()
        for key, vector in (("min", golden.min), ("max", golden.max)):
            for actual, target in zip(response["bounds"][key], vector):
                self.assertNumber(actual, target, places=5)
        for mesh in response["meshes"]:
            self.assertEqual(len(mesh["positions"]) % 3, 0)
            self.assertEqual(len(mesh["normals"]), len(mesh["positions"]))
            self.assertEqual(len(mesh["indices"]) % 3, 0)
            self.assertTrue(all(math.isfinite(value) for value in mesh["positions"] + mesh["normals"]))
            vertex_count = len(mesh["positions"]) // 3
            self.assertTrue(all(isinstance(index, int) and 0 <= index < vertex_count for index in mesh["indices"]))
            self.assertTrue(all(len(edge) % 3 == 0 and len(edge) >= 6 for edge in mesh["edges"]))
            if expected.faces():
                self.assertTrue(mesh["indices"], "face/solid rendering must contain triangles")
            else:
                self.assertTrue(mesh["edges"], "curve rendering must contain sampled edges")

    def test_empty_scene(self):
        result = self.render()
        self.assertEqual(result["meshes"], [])
        self.assertIsNone(result["bounds"])

    def test_build_part_subtract_and_align(self):
        with b.BuildPart() as direct:
            b.Box(10, 8, 4, align=(b.Align.CENTER, b.Align.CENTER, b.Align.MIN))
            b.Cylinder(2, 8, mode=b.Mode.SUBTRACT)
        response = self.render(node("BuildPart", children=[
            node("Box", [10, 8, 4], align=[enum("Align.CENTER"), enum("Align.CENTER"), enum("Align.MIN")]),
            node("Cylinder", [2, 8], mode=enum("Mode.SUBTRACT")),
        ]))
        self.assertRendered(response, direct.part)

    def test_build_sketch_extrude_with_hole(self):
        with b.BuildPart() as direct:
            with b.BuildSketch():
                b.RectangleRounded(12, 8, 1)
                b.Circle(2, mode=b.Mode.SUBTRACT)
            b.extrude(amount=5)
        response = self.render(node("BuildPart", children=[
            node("BuildSketch", children=[node("RectangleRounded", [12, 8, 1]), node("Circle", [2], mode=enum("Mode.SUBTRACT"))]),
            node("extrude", amount=5),
        ]))
        self.assertRendered(response, direct.part)

    def test_build_line_make_face_extrude(self):
        with b.BuildPart() as direct:
            with b.BuildSketch():
                with b.BuildLine():
                    b.Polyline((0, 0), (5, 0), (4, 3), (0, 2), close=True)
                b.make_face()
            b.extrude(amount=3)
        response = self.render(node("BuildPart", children=[
            node("BuildSketch", children=[
                node("BuildLine", children=[node("Polyline", [[0, 0], [5, 0], [4, 3], [0, 2]], close=True)]),
                node("make_face"),
            ]), node("extrude", amount=3),
        ]))
        self.assertRendered(response, direct.part)

    def test_build_sketch_on_offset_plane(self):
        with b.BuildPart() as direct:
            with b.BuildSketch(b.Plane.XY.offset(3)):
                b.Circle(2)
            b.extrude(amount=4)
        workplane = {"$call": "Plane", "args": [[0, 0, 3]], "kwargs": {}}
        response = self.render(node("BuildPart", children=[
            node("BuildSketch", [workplane], children=[node("Circle", [2])]), node("extrude", amount=4),
        ]))
        self.assertRendered(response, direct.part)

    def test_vector_methods_and_algebra(self):
        vector = self.construct("Vector", 3, 4, 0)
        other = self.construct("Vector", 0, 0, 2)
        self.assertNumber(self.get(vector, "length"), 5)
        self.assertVector(self.method(vector, "normalized"), b.Vector(3, 4, 0).normalized())
        self.assertNumber(self.method(vector, "dot", other), 0)
        self.assertVector(self.method(vector, "cross", other), b.Vector(3, 4, 0).cross(b.Vector(0, 0, 2)))
        self.assertVector(self.rpc("operator", target=vector, name="add", args=[other]), (3, 4, 2))

    def test_axis_methods(self):
        axis = self.construct("Axis", [1, 2, 3], [0, 0, 1])
        self.assertVector(self.get(axis, "position"), (1, 2, 3))
        self.assertVector(self.get(axis, "direction"), (0, 0, 1))
        self.assertNumber(self.method(axis, "angle_between", constant("Axis", "X")), 90)

    def test_plane_local_coordinates(self):
        plane_ref = self.construct("Plane", [1, 2, 3], [0, 1, 0], [0, 0, 1])
        direct = b.Plane((1, 2, 3), (0, 1, 0), (0, 0, 1))
        self.assertVector(self.get(plane_ref, "origin"), direct.origin)
        self.assertVector(self.method(plane_ref, "to_local_coords", [4, 5, 6]), direct.to_local_coords((4, 5, 6)))
        self.assertVector(self.method(plane_ref, "from_local_coords", [4, 5, 6]), direct.from_local_coords((4, 5, 6)))
        moved = self.method(plane_ref, "offset", 4)
        self.assertVector(self.get(moved, "origin"), direct.offset(4).origin)

    def test_matrix_identity_transform(self):
        matrix = self.construct("Matrix")
        vector = self.construct("Vector", 2, 3, 4)
        transformed = self.method(matrix, "multiply", vector)
        self.assertVector(transformed, b.Matrix().multiply(b.Vector(2, 3, 4)))
        inverse = self.method(matrix, "inverse")
        self.assertVector(self.method(inverse, "multiply", transformed), (2, 3, 4))

    def test_matrix_entries_and_native_failure(self):
        # OCCT 8 reports non-orthogonal GTrsf for array-initialized matrices,
        # even when the array is a rigid translation. Preserve native behavior.
        values = [[1, 0, 0, 3], [0, 1, 0, 4], [0, 0, 1, 5], [0, 0, 0, 1]]
        matrix = self.construct("Matrix", values)
        direct = b.Matrix(values)
        for row in range(3):
            for column in range(4):
                self.assertNumber(self.rpc("index", target=matrix, value=[row, column]), direct[row, column])
        with self.assertRaises(Exception) as native_error:
            direct.multiply(b.Vector(2, 3, 4))
        with self.assertRaises(KernelError) as bridge_error:
            self.method(matrix, "multiply", self.construct("Vector", 2, 3, 4))
        self.assertEqual(bridge_error.exception.error_type, type(native_error.exception).__name__)
        self.assertEqual(str(bridge_error.exception), str(native_error.exception))

    def test_location_and_shape_move(self):
        loc = self.construct("Location", [3, 4, 5], [0, 0, 25])
        direct_loc = b.Location((3, 4, 5), (0, 0, 25))
        self.assertVector(self.get(loc, "position"), direct_loc.position)
        self.assertVector(self.get(loc, "orientation"), direct_loc.orientation)
        box = self.construct("Box", 4, 6, 8)
        moved = self.method(box, "moved", loc)
        self.assertNativeShape(moved, b.Box(4, 6, 8).moved(direct_loc))
        self.assertNativeShape(box, b.Box(4, 6, 8))

    def test_shape_property_setters(self):
        box = self.construct("Box", 4, 6, 8)
        self.rpc("set", target=box, name="label", value="independent fixture")
        self.assertEqual(self.get(box, "label"), "independent fixture")
        self.rpc("set", target=box, name="position", value=[3, 4, 5])
        direct = b.Box(4, 6, 8)
        direct.position = (3, 4, 5)
        self.assertNativeShape(box, direct)

    def test_edge_static_constructor(self):
        edge = self.method({"$type": "Edge"}, "make_three_point_arc", [0, 0], [2, 3], [4, 0])
        self.assertNativeShape(edge, b.Edge.make_three_point_arc((0, 0), (2, 3), (4, 0)))
        self.assertNumber(self.get(edge, "length"), b.Edge.make_three_point_arc((0, 0), (2, 3), (4, 0)).length)

    def test_wire_static_constructor(self):
        points = [[0, 0], [4, 0], [3, 3], [0, 2]]
        wire = self.method({"$type": "Wire"}, "make_polygon", points, close=True)
        self.assertNativeShape(wire, b.Wire.make_polygon(native(points), close=True))

    def test_face_static_constructor(self):
        face = self.method({"$type": "Face"}, "make_rect", 4, 7, plane=constant("Plane", "YZ"))
        self.assertNativeShape(face, b.Face.make_rect(4, 7, plane=b.Plane.YZ))

    def test_solid_static_constructor(self):
        solid = self.method({"$type": "Solid"}, "make_cylinder", 3, 7, plane=constant("Plane", "XZ"), angle=240)
        self.assertNativeShape(solid, b.Solid.make_cylinder(3, 7, plane=b.Plane.XZ, angle=240))

    def test_every_public_export_resolves_to_native_value(self):
        # Resolving all symbols verifies the bridge's public mechanism. It is
        # intentionally separate from the semantic modeling tests above.
        self.assertEqual(len(b.__all__), 203)
        for name in b.__all__:
            with self.subTest(name=name):
                expected = getattr(b, name)
                self.assertIs(self.kernel.resolve(name), expected)
                encoded = self.rpc("get", target={"$type": name})
                actual = self.kernel.decode(encoded)
                if isinstance(expected, (str, int, float, bool, dict)):
                    self.assertEqual(actual, expected)
                else:
                    self.assertIs(actual, expected)

    def test_runtime_and_generated_inventory_completeness(self):
        generated = json.loads((ROOT / "docs/api-inventory.json").read_text(encoding="utf-8"))
        runtime = self.kernel.api()
        self.assertEqual(generated["exportCount"], 203)
        self.assertEqual(generated["build123dVersion"], b.__version__)
        self.assertEqual(set(generated["symbols"]), set(b.__all__))
        self.assertEqual(set(runtime["exports"]), set(b.__all__))
        self.assertEqual(set(runtime["symbols"]), set(b.__all__))
        for name in b.__all__:
            with self.subTest(name=name):
                expected = getattr(b, name)
                if inspect.isclass(expected):
                    members = {member for member, _ in inspect.getmembers_static(expected) if not member.startswith("_")}
                    self.assertTrue(members <= set(generated["symbols"][name].get("members", {})))
                    self.assertTrue(members <= set(runtime["symbols"][name].get("members", {})))
                    self.assertTrue(set(generated["symbols"][name].get("members", {})) <= set(runtime["symbols"][name].get("members", {})), name)
                if inspect.isclass(expected) and issubclass(expected, Enum):
                    self.assertEqual(set(generated["symbols"][name]["values"]), set(expected.__members__))
                    self.assertEqual(set(generated["symbols"][name]["enumMembers"]), set(expected.__members__))
                    for member in expected.__members__:
                        self.assertIs(self.kernel.decode(enum(f"{name}.{member}")), getattr(expected, member))

    def test_shape_list_filter_sort_group_and_slice(self):
        box = self.construct("Box", 4, 6, 8)
        direct = b.Box(4, 6, 8)
        edges = self.method(box, "edges")
        filtered = self.method(edges, "filter_by", constant("Axis", "Z"))
        self.assertEqual(self.collectionLength(filtered), len(direct.edges().filter_by(b.Axis.Z)))
        top_faces = self.method(self.method(box, "faces"), "sort_by", constant("Axis", "Z"))
        top = self.rpc("index", target=top_faces, value=-1)
        self.assertNativeShape(top, direct.faces().sort_by(b.Axis.Z)[-1])
        subset = self.rpc("index", target=top_faces, value={"$slice": [1, 4, 1]})
        self.assertEqual(self.collectionLength(subset), 3)
        groups = self.method(edges, "group_by", constant("Axis", "Z"))
        self.assertEqual(self.collectionLength(groups), len(direct.edges().group_by(b.Axis.Z)))
        high_edges = self.method(edges, "filter_by_position", constant("Axis", "Z"), 0, 5)
        self.assertEqual(self.collectionLength(high_edges), len(direct.edges().filter_by_position(b.Axis.Z, 0, 5)))

    def test_shape_list_native_callable_filter(self):
        box = self.construct("Box", 4, 6, 8)
        edges = self.method(box, "edges")
        predicate = {"$lambda": {"$operator": {"name": "gt", "target": {"$get": {"target": {"$arg": 0}, "name": "length"}}, "args": [5]}}}
        filtered = self.method(edges, "filter_by", predicate)
        expected = b.Box(4, 6, 8).edges().filter_by(lambda edge: edge.length > 5)
        self.assertEqual(self.collectionLength(filtered), len(expected))
        for index, edge in enumerate(expected):
            actual = self.rpc("index", target=filtered, value=index)
            self.assertNumber(self.get(actual, "length"), edge.length)

    def test_extrude_function(self):
        profile = self.construct("Rectangle", 7, 4)
        shape = self.function("extrude", profile, amount=3, both=True, taper=5)
        self.assertNativeShape(shape, b.extrude(b.Rectangle(7, 4), amount=3, both=True, taper=5))

    def test_revolve_function(self):
        profile = self.construct("Rectangle", 2, 4)
        location = self.construct("Location", [4, 0, 0], [90, 0, 0])
        profile = self.method(profile, "moved", location)
        shape = self.function("revolve", profile, axis=constant("Axis", "Z"), revolution_arc=250)
        direct = b.Rectangle(2, 4).moved(b.Location((4, 0, 0), (90, 0, 0)))
        self.assertNativeShape(shape, b.revolve(direct, axis=b.Axis.Z, revolution_arc=250))

    def test_loft_function(self):
        first = self.construct("Circle", 3)
        second = self.method(self.construct("Circle", 1), "moved", self.construct("Location", [0, 0, 6]))
        shape = self.function("loft", [first, second], ruled=True)
        self.assertNativeShape(shape, b.loft([b.Circle(3), b.Circle(1).moved(b.Location((0, 0, 6)))], ruled=True))

    def test_sweep_function(self):
        profile = self.method(self.construct("Circle", 1), "moved", self.construct("Location", [0, 0, 0], [0, 90, 0]))
        path = self.construct("Line", [0, 0, 0], [8, 0, 0])
        shape = self.function("sweep", profile, path)
        direct = b.Circle(1).moved(b.Location((0, 0, 0), (0, 90, 0)))
        self.assertNativeShape(shape, b.sweep(direct, b.Line((0, 0, 0), (8, 0, 0))))

    def test_fillet_function(self):
        box = self.construct("Box", 4, 6, 8)
        edges = self.method(self.method(box, "edges"), "filter_by", constant("Axis", "Z"))
        shape = self.function("fillet", edges, radius=0.5)
        direct = b.Box(4, 6, 8)
        self.assertNativeShape(shape, b.fillet(direct.edges().filter_by(b.Axis.Z), radius=0.5))

    def test_chamfer_function(self):
        box = self.construct("Box", 4, 6, 8)
        edges = self.method(self.method(box, "edges"), "filter_by", constant("Axis", "Z"))
        shape = self.function("chamfer", edges, length=0.5, length2=0.8)
        direct = b.Box(4, 6, 8)
        self.assertNativeShape(shape, b.chamfer(direct.edges().filter_by(b.Axis.Z), length=0.5, length2=0.8))

    def test_mirror_function(self):
        location = self.construct("Location", [4, 2, 1])
        box = self.method(self.construct("Box", 4, 6, 8), "moved", location)
        shape = self.function("mirror", box, about=constant("Plane", "YZ"))
        self.assertNativeShape(shape, b.mirror(b.Box(4, 6, 8).moved(b.Location((4, 2, 1))), about=b.Plane.YZ))

    def test_offset_function(self):
        profile = self.construct("Rectangle", 6, 4)
        shape = self.function("offset", profile, amount=1, kind=enum("Kind.INTERSECTION"))
        self.assertNativeShape(shape, b.offset(b.Rectangle(6, 4), amount=1, kind=b.Kind.INTERSECTION))

    def test_scale_function_nonuniform(self):
        box = self.construct("Box", 4, 6, 8)
        shape = self.function("scale", box, by=[2, 1, 0.5], about=[1, 2, 3])
        self.assertNativeShape(shape, b.scale(b.Box(4, 6, 8), by=(2, 1, 0.5), about=(1, 2, 3)))

    def test_split_function(self):
        box = self.construct("Box", 4, 6, 8)
        shape = self.function("split", box, bisect_by=constant("Plane", "XY"), keep=enum("Keep.TOP"))
        self.assertNativeShape(shape, b.split(b.Box(4, 6, 8), bisect_by=b.Plane.XY, keep=b.Keep.TOP))

    def test_section_function(self):
        box = self.construct("Box", 4, 6, 8)
        shape = self.function("section", box, section_by=constant("Plane", "XY"), height=1)
        self.assertNativeShape(shape, b.section(b.Box(4, 6, 8), section_by=b.Plane.XY, height=1))

    def test_thicken_function(self):
        profile = self.construct("Rectangle", 6, 4)
        shape = self.function("thicken", profile, amount=2, both=True)
        self.assertNativeShape(shape, b.thicken(b.Rectangle(6, 4), amount=2, both=True))

    def test_trace_function(self):
        curve = self.construct("Polyline", [0, 0], [4, 0], [4, 3])
        shape = self.function("trace", curve, line_width=0.8)
        self.assertNativeShape(shape, b.trace(b.Polyline((0, 0), (4, 0), (4, 3)), line_width=0.8))

    def test_shape_boolean_operators(self):
        first = self.construct("Box", 6, 6, 4)
        second = self.construct("Cylinder", 2, 8)
        for name, operation in (("add", lambda a, c: a + c), ("sub", lambda a, c: a - c), ("and", lambda a, c: a & c)):
            with self.subTest(operation=name):
                actual = self.rpc("operator", target=first, name=name, args=[second])
                self.assertNativeShape(actual, operation(b.Box(6, 6, 4), b.Cylinder(2, 8)))

    def test_grid_locations_native_builder(self):
        with b.BuildPart() as direct:
            with b.GridLocations(6, 8, 3, 2):
                b.Box(2, 3, 4)
        response = self.render(node("BuildPart", children=[node("GridLocations", [6, 8, 3, 2], children=[node("Box", [2, 3, 4])])]))
        self.assertRendered(response, direct.part)

    def test_polar_locations_native_builder(self):
        with b.BuildPart() as direct:
            with b.PolarLocations(8, 5, start_angle=12, angular_range=300):
                b.Box(2, 3, 4)
        response = self.render(node("BuildPart", children=[node("PolarLocations", [8, 5], start_angle=12, angular_range=300, children=[node("Box", [2, 3, 4])])]))
        self.assertRendered(response, direct.part)

    def test_select_fillet_inside_plan(self):
        with b.BuildPart() as direct:
            b.Box(4, 6, 8)
            b.fillet(direct.edges().filter_by(b.Axis.Z), radius=0.5)
        response = self.render(node("BuildPart", children=[node("Box", [4, 6, 8]), node("fillet", objects={"$select": "edges", "axis": constant("Axis", "Z")}, radius=0.5)]))
        self.assertRendered(response, direct.part)

    def test_structured_native_argument_error(self):
        with self.assertRaises(TypeError) as direct_error:
            b.Box(length=4)
        with self.assertRaises(KernelError) as bridge_error:
            self.construct("Box", length=4)
        error = bridge_error.exception
        self.assertEqual(error.error_type, type(direct_error.exception).__name__)
        self.assertEqual(error.message, str(direct_error.exception))
        self.assertEqual(error.path, "rpc.construct.Box")
        self.assertEqual(error.json()["error"]["path"], error.path)

    def test_release_and_unknown_reference(self):
        box = self.construct("Box", 4, 6, 8)
        vector = self.construct("Vector", 1, 2, 3)
        self.rpc("release", target=[box, vector])
        self.assertEqual(self.kernel.objects, {})
        for target in (box, vector, {"$ref": "nonexistent"}):
            with self.subTest(target=target):
                with self.assertRaisesRegex(KernelError, "Unknown or released native reference"):
                    self.get(target, "volume")

    def test_failed_nested_plan_restores_native_context(self):
        malformed = node("BuildPart", children=[node("Box", [4, 6, 8]), node("BuildSketch", children=[node("Circle", nonsense=True)])])
        with self.assertRaises(KernelError) as error:
            self.render(malformed)
        self.assertEqual(error.exception.path, "plan.children[0].children[1].children[0]")
        self.assertEqual(self.kernel.objects, {})
        self.assertRendered(self.render(node("Box", [2, 3, 4])), b.Box(2, 3, 4))
        # Also verify a native builder constructed after the failure is clean.
        with b.BuildPart() as direct:
            b.Box(2, 3, 4)
        self.assertNumber(direct.part.volume, 24)

    def test_invalid_request_and_tessellation_parameters(self):
        requests = [({}, "plan"), ({"plan": {"version": 2, "children": []}}, "plan"),
                    ({"plan": plan(), "tolerance": 0}, "tolerance"),
                    ({"plan": plan(), "tolerance": math.nan}, "tolerance"),
                    ({"plan": plan(), "angularTolerance": -1}, "angularTolerance")]
        for request, path in requests:
            with self.subTest(request=request):
                with self.assertRaises(KernelError) as error:
                    self.kernel.render(request)
                self.assertEqual(error.exception.path, path)

    def test_unknown_symbol_and_private_member_failures(self):
        box = self.construct("Box", 4, 6, 8)
        before = set(self.kernel.objects)
        for request in ({"op": "construct", "name": "NonexistentShape"},
                        {"op": "get", "target": box, "name": "__class__"},
                        {"op": "operator", "target": box, "name": "unsupported"},
                        {"op": "method", "target": box, "name": "method_does_not_exist"}):
            with self.subTest(request=request):
                with self.assertRaises(KernelError) as error:
                    self.kernel.rpc(request)
                self.assertTrue(error.exception.message)
                self.assertTrue(error.exception.path.startswith("rpc."))
                self.assertEqual(set(self.kernel.objects), before)

    def test_brep_round_trip(self):
        self.check_solid_round_trip("brep", "export_brep", "import_brep")

    def test_step_round_trip(self):
        self.check_solid_round_trip("step", "export_step", "import_step")

    def test_stl_native_round_trip(self):
        # Native import_stl returns a mesh-backed Face, rather than a repaired
        # BREP solid. Compare its actual native semantics, including validity.
        self.check_solid_round_trip("stl", "export_stl", "import_stl", compare_original=False)

    def check_solid_round_trip(self, extension, exporter, importer, compare_original=True):
        with tempfile.TemporaryDirectory(prefix="build123d-conformance-") as directory:
            self.kernel = Kernel(directory)
            shape = self.construct("Box", 4, 6, 8)
            path = Path(directory) / f"fixture.{extension}"
            self.assertTrue(self.function(exporter, shape, str(path)))
            self.assertGreater(path.stat().st_size, 100)
            imported = self.function(importer, str(path))
            independently_imported = getattr(b, importer)(path)
            self.assertNativeShape(imported, independently_imported)
            if compare_original:
                self.assertNativeShape(imported, b.Box(4, 6, 8))
            independent_path = Path(directory) / f"native.{extension}"
            self.assertTrue(getattr(b, exporter)(b.Box(4, 6, 8), independent_path))
            imported_native_file = self.function(importer, str(independent_path))
            self.assertNativeShape(imported_native_file, getattr(b, importer)(independent_path))

    def test_svg_round_trip(self):
        self.check_profile_round_trip("svg", "ExportSVG", "import_svg")

    def test_dxf_round_trip(self):
        self.check_profile_round_trip("dxf", "ExportDXF", "import_dxf")

    def check_profile_round_trip(self, extension, exporter, importer):
        with tempfile.TemporaryDirectory(prefix="build123d-conformance-") as directory:
            self.kernel = Kernel(directory)
            profile = self.construct("Rectangle", 6, 4)
            writer = self.construct(exporter)
            self.method(writer, "add_shape", profile)
            path = Path(directory) / f"profile.{extension}"
            self.method(writer, "write", str(path))
            self.assertGreater(path.stat().st_size, 100)
            imported = self.function(importer, str(path))
            expected = getattr(b, importer)(path)
            self.assertEqual(self.collectionLength(imported), len(expected))
            for index, golden in enumerate(expected):
                actual = self.rpc("index", target=imported, value=index)
                self.assertNativeShape(actual, golden)
                self.assertNumber(self.get(actual, "length"), golden.length)
            independent_path = Path(directory) / f"native.{extension}"
            writer_native = getattr(b, exporter)()
            writer_native.add_shape(b.Rectangle(6, 4))
            writer_native.write(independent_path)
            independently_written = self.function(importer, str(independent_path))
            self.assertEqual(self.collectionLength(independently_written), len(expected))

    def test_import_export_workspace_paths(self):
        with tempfile.TemporaryDirectory(prefix="build123d-conformance-") as directory:
            self.kernel = Kernel(directory)
            shape = self.construct("Box", 4, 6, 8)
            self.assertTrue(self.function("export_brep", shape, "relative.brep"))
            self.assertTrue((Path(directory) / "relative.brep").is_file())
            self.assertNativeShape(self.function("import_brep", "relative.brep"), b.Box(4, 6, 8))
            for request in (("import_step", ["/etc/passwd"]), ("export_step", [shape, "../outside.step"])):
                with self.subTest(request=request):
                    with self.assertRaisesRegex(KernelError, "must be inside kernel workspace"):
                        self.function(request[0], *request[1])

    def test_rigid_joint_connection(self):
        first = self.construct("Box", 4, 6, 8)
        second = self.construct("Box", 2, 3, 4)
        first_joint = self.construct("RigidJoint", "socket", to_part=first, joint_location=self.construct("Location", [3, 4, 5]))
        second_joint = self.construct("RigidJoint", "plug", to_part=second, joint_location=self.construct("Location", [0, 0, 2]))
        native_first, native_second = b.Box(4, 6, 8), b.Box(2, 3, 4)
        native_a = b.RigidJoint("socket", to_part=native_first, joint_location=b.Location((3, 4, 5)))
        native_c = b.RigidJoint("plug", to_part=native_second, joint_location=b.Location((0, 0, 2)))
        self.method(first_joint, "connect_to", second_joint)
        native_a.connect_to(native_c)
        self.assertNativeShape(first, native_first)
        self.assertNativeShape(second, native_second)
        self.assertVector(self.get(self.get(first_joint, "location"), "position"), native_a.location.position)
        self.assertVector(self.get(self.get(second_joint, "location"), "position"), native_c.location.position)
        self.assertIn("socket", self.get(first, "joints"))

    def test_revolute_joint_connection(self):
        self.check_joint_connection("RevoluteJoint", {"axis": constant("Axis", "Z")}, {"axis": b.Axis.Z}, {"angle": 35})

    def test_linear_joint_connection(self):
        self.check_joint_connection("LinearJoint", {"axis": constant("Axis", "Z"), "linear_range": [-5, 10]}, {"axis": b.Axis.Z, "linear_range": (-5, 10)}, {"position": 3})

    def test_cylindrical_joint_connection(self):
        self.check_joint_connection("CylindricalJoint", {"axis": constant("Axis", "Z"), "linear_range": [-5, 10]}, {"axis": b.Axis.Z, "linear_range": (-5, 10)}, {"position": 3, "angle": 35})

    def test_ball_joint_connection(self):
        self.check_joint_connection("BallJoint", {}, {}, {"angles": [15, 25, 35]})

    def check_joint_connection(self, name, wire_kwargs, native_kwargs, connect_kwargs):
        first = self.construct("Box", 4, 6, 8)
        second = self.construct("Box", 2, 3, 4)
        primary = self.construct(name, "socket", to_part=first, **wire_kwargs)
        plug = self.construct("RigidJoint", "plug", to_part=second, joint_location=self.construct("Location", [0, 0, 2]))
        native_first, native_second = b.Box(4, 6, 8), b.Box(2, 3, 4)
        native_primary = getattr(b, name)("socket", to_part=native_first, **native_kwargs)
        native_plug = b.RigidJoint("plug", to_part=native_second, joint_location=b.Location((0, 0, 2)))
        self.method(primary, "connect_to", plug, **connect_kwargs)
        native_primary.connect_to(native_plug, **native(connect_kwargs))
        self.assertNativeShape(first, native_first)
        self.assertNativeShape(second, native_second)
        self.assertVector(self.get(self.get(primary, "location"), "position"), native_primary.location.position)
        self.assertVector(self.get(self.get(plug, "location"), "position"), native_plug.location.position)


def primitive_test(name, args, kwargs):
    def test(self):
        direct = getattr(b, name)(*native(args), **native(kwargs))
        self.assertRendered(self.render(node(name, args, **kwargs)), direct)
    return test


for slug, name, args, kwargs in CASES:
    setattr(NativeConformance, f"test_render_{slug}", primitive_test(name, args, kwargs))


if __name__ == "__main__":
    unittest.main()
