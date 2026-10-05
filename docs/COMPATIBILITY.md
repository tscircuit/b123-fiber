# build123d compatibility

The browser kernel targets the names, signatures, units and plan format of
build123d **0.13.0**, and implements them in TypeScript against OpenCascade WASM.
The original Python implementation is absent from this branch. The generated
203-symbol inventory is the compatibility specification, not a claim that every
native overload is implemented.

`NativeClient.inventory()` identifies the runtime bindings and unsupported root
symbols. A registered root can have unsupported overloads or methods. Those
raise explicit errors; saved gallery meshes are never substituted for execution.
Builders execute through JSX plans; constructing a builder handle does not enter
a context manager.

The checked runtime report recognizes **197 of 203 root entries**. Six are
unavailable: the `RotationLike` and `VectorLike` type aliases, abstract `Export2D`,
and `detect_primitives`, `import_svg_as_buildline_code`, and `export_to_pcbway`.

| Area | Implemented behavior | Evidence |
| --- | --- | --- |
| Solid primitives | Box, cylinder, cone, sphere, torus, wedge, sector angles, alignment and rotation | Independent analytic volume, area, bounds and validity tests |
| Sketches and curves | Profiles, slots, glyph outlines, lines, arcs, interpolation, Bézier/B-splines and helices | Native BRep measurements and gallery comparisons |
| Advanced curves | NACA airfoils, C1/C2 blends, circular tangent constraints, two-point constrained arcs, line tangency and IntersectingLine against finite straight edges | Dedicated modeling tests and snapshots |
| Modeling | Extrude, revolve, loft, sweep, fillet/chamfer, booleans, offset, trace, hulls, draft and sheet bends | Genuine WASM geometry, selections and volume assertions |
| Plans | Ordered builders, captures, explicit operands, nested operations, locations and transforms | Plan regressions and 73 executable examples |
| Values and topology | Vectors, axes, planes, locations, matrices, colors, bounds, topology selectors and ShapeList handles | Value algebra, selection, mutation and ownership tests |
| Assemblies | Compounds with labels, colors, child placements and assembly paths | Colored assembly fixtures and repeated export checks |
| Expressions | Symbolic calls/properties/methods, lambdas, conditionals, indexing and explicit operators | Handle and plan integration tests |
| Files | Local Blob/file APIs, virtual filesystem, byte/text streams, STEP/STL/BREP and vector imports/exports | Actual local file round trips and browser checks |
| Viewer and sandbox | Four engineering views, cursor orbit/pan/zoom, editable JSX and parameters, worker cancellation | Chromium controls, editing and all-example tests |

Current limitations include the following. This list describes runtime behavior,
independently of the preserved TypeScript declarations.

- Extrusion requires `amount`; `until` overloads are unavailable. Nonuniform
  scaling and alternate rotation orderings are unavailable.
- `project` currently projects parallel planar faces. Full round requires three
  straight neighboring edges. Brake forming supports straight stations with
  inner bends. Convex hulls support straight edges; curved tangent hulls do not.
  `pack` places parts in a row, rather than performing general two-dimensional
  bin packing.
- General constrained-curve solvers, conical helices, arbitrary font paths,
  text-on-path and several advanced drawing styles are unavailable. DejaVu Sans
  is bundled. Joint motion parameters beyond the implemented default attachment
  behavior fail explicitly.
- `IntersectingLine` supports straight edges, polylines and straight-edge curve
  compounds. Curved targets and surface intersections fail explicitly. Like the
  pinned build123d implementation, it measures the nearest extended-axis
  crossing and constructs the result in the supplied positive direction.
- Many inherited topology methods and static overloads have not been ported.
  Raw Python/OCP values, arbitrary code execution and custom native subclass
  registries are outside the browser compatibility layer.
- The runtime support report lists remaining abstract base types, type aliases
  and utility/export helpers separately. See
  [the migration review](browser-migration/README.md) for the measured scope.

All 73 original gallery plans execute with the browser kernel. The historical
native meshes and **292 original screenshots are retained unchanged** for review.
[Comparison artifacts](browser-migration/isometric-comparison.png) show the
native image, the browser image and its exact pixel difference. Separate browser
regression baselines protect the new implementation; they do not erase the
historical comparison. Small native mass-property and curved-surface
triangulation differences are recorded in the report.
