# Native conformance tests

Run these tests after installing the Python package and its test dependencies:

```sh
python -m pip install -e '.[test]'
python -m unittest discover -s tests/conformance -v
```

The suite contains 103 behavioral tests. It constructs expected geometry directly
with build123d 0.13.0, then independently executes a serialized React plan or RPC
through the bridge. Geometry comparisons check native volume, area, bounding box,
validity, and topology counts. Render comparisons also check finite positions and
normals, triangle indices, and sampled edges.

- 44 rendering examples cover solids, partial angular sweeps, rotations, a convex
  polyhedron, sketches, rounded profiles, slots, splines, rational Bezier curves,
  B-splines, arcs, and cylindrical/conical helices.
- Native builder examples combine parts, sketches, lines, pending faces,
  extrusion, subtraction, offset workplanes, grid/polar placement, and filleting
  selected edges.
- RPC examples cover vectors, axes, planes, matrices, locations, shape transforms,
  property mutation, topology class/static constructors, shape algebra, selection,
  sorting, grouping, slicing, and native callable predicates.
- Modeling operations cover extrusion, revolution, loft, sweep, fillet, chamfer,
  mirror, offset, nonuniform scale, split, section, thicken, and trace.
- All five joint classes connect native parts and verify the resulting geometry
  and joint locations.
- STEP, BREP, STL, SVG, and DXF round trips compare bridge imports with independent
  native imports. Both bridge-written and native-written files are exercised.
- Every one of build123d's 203 public exports resolves to its actual native value.
  Generated and runtime inventories include public inherited members, metaclass
  properties, and every enum member.
- The HTTP suite launches the published CLI as a separate process and exercises
  real JSON transport, reference lifecycle, structured error responses, token
  authentication, and concurrent render requests.

Surface inventory validation and representative semantic tests provide different
evidence. Export resolution establishes access to the public API; individual
modeling cases verify the listed native behaviors. The suite records native OCCT
behavior for array-initialized matrices and mesh-backed STL imports, including
their native error and validity results.

The suite runs against the actual installed build123d/OpenCascade kernel and
creates temporary export files. It uses neither mocked geometry nor recorded
responses. Screenshot checks live separately in `tests/visual`.
