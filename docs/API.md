# Native API inventory

This package targets **build123d 0.13.0**, using its native OpenCascade kernel. The generated [inventory](api-inventory.json) contains all **203 root exports**, constructor and function signatures, overloads, inherited methods, writable properties, and metaclass properties such as `Plane.XY`. Regenerate it with `.venv/bin/python scripts/generate-api.py`; `--check` verifies reproducibility.

The native service preserves the original Python API. JavaScript uses asynchronous RPC because geometry executes in the Python service. JSX compiles to the same native builders and operations. Python names and keyword arguments retain their spelling and angles remain in degrees.

```ts
import { NativeClient, native, Align, Axis } from '@tscircuit/b123-fiber'

const client = new NativeClient({ url: 'http://127.0.0.1:8765' })
const box = await client.construct('Box', [], { length: 20, width: 12, height: 6 })
const volume = await box.get('volume')
const edges = await box.call('edges')
const vertical = await edges.call('filter_by', [Axis.Z])
const filleted = await box.call('fillet', [1, vertical])
const other = await client.api.Cylinder({ radius: 3, height: 10, align: Align.CENTER })
const cut = await box.operator('sub', other)
const solid = await client.callStatic('Solid', 'make_box', [2, 3, 4])
await client.callFunction('export_step', [cut, 'part.step'])
await Promise.all([box.release(), edges.release(), vertical.release(), filleted.release(), other.release(), cut.release(), solid.release()])
```

`construct(name, args, kwargs)` and `callFunction(name, args, kwargs)` cover every exported constructor/function. `client.api.Name(kwargs)` is a convenient asynchronous namespace for keyword calls. Native objects return `NativeHandle` values, whose `.call(name, args, kwargs)`, `.get(name)`, `.set(name, value)`, `.at(index)`, `.slice(start, stop, step)`, `.operator(name, ...args)` and `.release()` expose methods, properties, indexing, algebra and lifetime management. ShapeList and other native collections support `.length()`, `.contains(value)` and `.toArray()`. Static/class methods use `callStatic(typeName, method, args, kwargs)`. Values recursively decode inside arrays and records, and handles recursively encode when passed to later operations. Call `.release()` once a handle is no longer needed; use `client.releaseAll()` to release all handles retained by that client. Handles belong to their originating client, and using released or cross-client handles throws before any request.

`native.Name(...args)` and `native.Name.withKwargs(kwargs, ...args)` create serializable symbolic calls for JSX props. Symbolic class attributes and static calls work as `native.Plane.XY` and `native.Solid.make_box(2, 3, 4)`. These calls execute when the service decodes the plan or RPC arguments. `values` combines symbolic classes/functions, enums, and constants into one namespace. Direct RPC objects remain native objects; their attributes are read explicitly with `.get()`. JavaScript does not overload Python's algebra operators; `.operator('add' | 'sub' | 'and' | 'mul', ...)` forwards their native equivalents.

The `expr` namespace composes native method/property/index/operator expressions for JSX props. For example, `expr.method(expr.call('edges'), 'filter_by', [Axis.Z])` selects vertical edges while the enclosing builder is active. `expr.index(target, -1)` and `expr.slice(target, 1, 3)` retain Python selection behavior. Native callbacks can be expressed with `expr.lambda(edge => expr.operator(expr.get(edge, 'length'), 'gt', [5]))`; this JavaScript function builds a serializable callback body once, and the native service evaluates that body for each actual edge. `expr.arg(index)` supports explicit callback arguments and `expr.conditional(condition, thenValue, elseValue)` branches on native expressions. JavaScript arithmetic/comparisons inside a callback are not transmitted; compose `expr.operator` calls instead.

`client.render(plan, { tolerance, angularTolerance, signal })` executes headless plans and returns OCCT mesh data using the client's configured URL, headers and error handling. RPC methods accept optional request options with a signal; `client.request(request, { signal })` exposes the complete protocol. The constructor signal is the default, and a per-request signal overrides it.

The bridge exposes native capabilities rather than approximating missing operations. Some APIs require their original native context or resource: builder selectors need an active builder, text needs an installed font, import/export needs a service-side path, and assembly methods need native joint/shape handles. Backend errors retain the Python exception type and message. Declarative native callbacks are supported through `expr.lambda`; arbitrary JavaScript closures, arbitrary Python code, private attributes, and raw OCP objects are outside the JSON protocol. Root coverage is not a claim that every context or every overload has its own visual regression fixture.

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
