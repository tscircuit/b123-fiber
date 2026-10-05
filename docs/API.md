# Compatible API bindings

The generated [inventory](api-inventory.json) records build123d 0.13.0's **203 root
exports**, inspected overloads, inherited methods, and properties. It is the
TypeScript compatibility reference. The runtime is implemented in TypeScript
with OpenCascade WebAssembly; it does not import or execute Python build123d.
Not every listed API has equivalent browser behavior. Use
`await client.inventory()` and the [compatibility matrix](COMPATIBILITY.md) to
inspect implemented and unsupported bindings.

## Local client and retained objects

```ts
import { NativeClient } from '@tscircuit/b123-fiber'

const client = new NativeClient()
const box = await client.construct('Box', [], { length: 20, width: 12, height: 6 })
const volume = await box.get('volume')
const edges = await box.call('edges')
await box.set('label', 'Mount')
const download = await client.exportFile(box, 'step', { filename: 'mount.step' })
await Promise.all([box.release(), edges.release()])
```

`construct(name, args, kwargs)` and `callFunction(name, args, kwargs)` dispatch
local compatible bindings. `client.api.Name(kwargs)` provides keyword-only
calls. `NativeHandle` exposes `.call()`, `.get()`, `.set()`, `.at()`, `.slice()`,
`.operator()`, and `.release()`. Collections provide `.length()`, `.contains()`,
and `.toArray()`. Static methods use `client.callStatic(typeName, method, args,
kwargs)`. Retained callables use `.invoke(args, kwargs)`. Handles recursively
encode in subsequent calls and retain stable identity when decoded repeatedly.

Release handles when finished, or use `client.releaseAll()`. Handles belong to
their originating client and cannot be used after release or in another client.
Indexed mutation uses `.setAt()` and `.deleteAt()` where the binding supports it.

## Symbolic expressions in JSX

`native.Name(...args)` and `native.Name.withKwargs(kwargs, ...args)` create
serializable calls. `native.Plane.XY` and `native.Solid.make_box(2, 3, 4)` represent
class attributes/static calls. They execute when the local kernel evaluates the
plan. `values` combines symbolic constructors, functions, enums, and constants.
JavaScript arithmetic is not overloaded; use compatible `.operator()` calls.

`expr.method(expr.call('edges'), 'filter_by', [Axis.Z])` describes selection in an
active builder. `expr.index()` and `expr.slice()` describe indexed selection.
`expr.lambda(edge => expr.operator(expr.get(edge, 'length'), 'gt', [5]))` builds
a serializable predicate once. `expr.apply(target, args, kwargs)` calls a
compatible callable; `expr.arg(index)` describes callback arguments and
`expr.conditional()` chooses a branch. JavaScript closures are not executed
inside the CAD kernel; expression objects describe their supported operations.

## Initialization, rendering, and errors

```ts
const client = new NativeClient({
  wasmUrl: '/assets/opencascade.wasm',
  fontUrl: '/assets/DejaVuSans.ttf',
})
await client.ready
const result = await client.render(plan, {
  tolerance: 0.1,
  angularTolerance: 0.1,
  signal: controller.signal,
})
```

Packaged assets load lazily by default. `wasmBinary`/`fontBinary` accept bytes;
`openCascade` injects an initialized compatible OpenCascade.js instance. A shared
`kernel` can also be supplied. There is no URL for a geometry service and no
fetch/authentication transport option. Geometry runs in-process after static
assets load. The sandbox uses a worker to keep synchronous CAD work off the UI.

The constructor signal is the default; per-request options override it, and
`signal: null` clears it. Cancellation rejects pending asynchronous requests;
terminating a dedicated worker stops synchronous native computation. Errors
preserve their message, `kernelType`, optional plan path, and cause. Missing
bindings throw explicit errors rather than silently falling back to a backend.

Known keyword arguments and named JSX props are typed against the upstream
signatures. Explicit result generics and dynamic symbol names remain escape
hatches. These declarations do not prove runtime support for every overload.
Builder availability, argument ranges, and native geometry validity are checked
by the local compatibility implementation. See [files](FILE-TRANSPORT.md),
[architecture](../ARCHITECTURE.md), and [deployment](DEPLOYMENT.md).

## Upstream symbol inventory

The following lists describe the reference API, including unsupported runtime
bindings. They are preserved for comparison with the pinned build123d release.

## Classes

`HexLocations`, `PolarLocations`, `Locations`, `GridLocations`, `BuildLine`, `BuildPart`, `BuildSketch`, `BaseCurveObject`, `BaseEdgeObject`, `BaseLineObject`, `Airfoil`, `Bezier`, `BlendCurve`, `BSpline`, `CenterArc`, `ConstrainedArcs`, `ConstrainedLines`, `DoubleTangentArc`, `EllipticalCenterArc`, `EllipticalStartArc`, `ParabolicCenterArc`, `HyperbolicCenterArc`, `FilletPolyline`, `Helix`, `IntersectingLine`, `Line`, `PolarLine`, `Polyline`, `RadiusArc`, `SagittaArc`, `Spline`, `TangentArc`, `JernArc`, `ThreePointArc`, `ArrowHead`, `Arrow`, `BaseSketchObject`, `Circle`, `Draft`, `DimensionLine`, `Ellipse`, `ExtensionLine`, `Polygon`, `Rectangle`, `RectangleRounded`, `RegularPolygon`, `SlotArc`, `SlotCenterPoint`, `SlotCenterToCenter`, `SlotOverall`, `Superellipse`, `Text`, `TechnicalDrawing`, `Trapezoid`, `Triangle`, `BasePartObject`, `Box`, `Cone`, `ConvexPolyhedron`, `CounterBoreHole`, `CounterSinkHole`, `Cylinder`, `Hole`, `Sphere`, `Torus`, `Wedge`, `BoundBox`, `OrientedBoundBox`, `Rotation`, `Rot`, `Pos`, `ShapeList`, `Axis`, `Color`, `Curve`, `Vector`, `Vertex`, `Edge`, `Wire`, `Face`, `Matrix`, `Solid`, `Shell`, `Part`, `Plane`, `Compound`, `Location`, `GeomEncoder`, `Joint`, `RigidJoint`, `RevoluteJoint`, `Sketch`, `LinearJoint`, `CylindricalJoint`, `BallJoint`, `DraftAngleError`, `FontManager`, `Export2D`, `ExportDXF`, `ExportSVG`, `Mesher`

## Functions

`topo_distance_to`, `detect_primitives`, `import_brep`, `import_dxf`, `import_step`, `import_stl`, `import_svg`, `import_svg_as_buildline_code`, `delta`, `edges_to_wires`, `new_edges`, `pack`, `polar`, `available_fonts`, `solids`, `faces`, `wires`, `edges`, `vertices`, `solid`, `face`, `wire`, `edge`, `vertex`, `add`, `insert`, `bounding_box`, `chamfer`, `draft`, `extrude`, `fillet`, `full_round`, `loft`, `make_brake_formed`, `make_face`, `make_hull`, `mirror`, `offset`, `project`, `project_workplane`, `revolve`, `scale`, `section`, `split`, `sweep`, `thicken`, `trace`, `topo_explore_connected_edges`, `topo_explore_common_vertex`, `export_step`, `export_gltf`, `export_stl`, `export_brep`, `export_obj`, `export_to_pcbway`

## Enums

`Align`, `ApproxOption`, `AngularDirection`, `CenterOf`, `ContinuityLevel`, `Convexity`, `Extrinsic`, `FontStyle`, `FrameMethod`, `GeomType`, `HeadType`, `Intrinsic`, `Keep`, `Kind`, `Sagitta`, `LengthMode`, `MeshType`, `Mode`, `NumberDisplay`, `PageSize`, `Tangency`, `PositionMode`, `PrecisionMode`, `Select`, `Side`, `SortBy`, `TextAlign`, `Transition`, `Unit`, `Until`, `LineType`, `DotLength`

## Constants

`MC`, `MM`, `CM`, `M`, `IN`, `FT`, `THOU`, `UNITS_PER_METER`, `G`, `KG`, `G_PER_LB`, `LB`, `UNITS_PER_KILOGRAM`

## Type aliases

`RotationLike`, `VectorLike`
