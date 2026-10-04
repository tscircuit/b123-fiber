# build123d compatibility

The geometry service runs **build123d 0.13.0 and OpenCascade 8**, rather than
substituting JavaScript approximations. All 203 native `__all__` exports are
registered. The bridge also registers `Shape`, `ColorIndex`, `BytesIO`, and
`StringIO`, which supported signatures require but the root inventory omits.

Export registration, argument typing, behavior, and rendered appearance are
different measures of support. The generated inventory includes inherited
members repeatedly; its member count is not a count of independently tested
behaviors. The table below records concrete coverage. “RPC” means asynchronous
native calls; “plan” includes JSX compiled into that serializable plan.

| Feature | Native RPC / plan support | Argument and result transport | Behavioral evidence | Visual evidence |
| --- | --- | --- | --- | --- |
| Builders and workplanes | RPC construction; contextual execution through JSX builders | Native planes, locations, builder captures and selections | Native builder, nesting, placement and failure-recovery comparisons | Extrusions, sweeps, lofts, grids and polar locations |
| Solid primitives | Constructors and JSX | Numeric dimensions, enums, tuple vectors and rotations | Independent volume, bounds, area and topology checks | Box, cylinder, cone, sphere, torus, wedge and partial/rotated variants |
| Sketches and text | Constructors and JSX | Native fonts, alignment, modes and topology | Independent sketch and glyph checks | Polygons, slots, profiles, text and extruded lettering |
| Curves | Constructors and JSX | Positional overloads, vector tuples, native edge operands | Independent native lengths, bounds and topology | Lines, arcs, splines, Bézier curves and helices |
| Advanced and constrained curves | Constructors and JSX | Native edge arguments, enum constraints and serializable selectors | Airfoil, C1/C2 BlendCurve, ConstrainedLines/Arcs and DoubleTangentArc | Dedicated fixtures for each family |
| Drafting and drawings | Constructors and JSX | Draft handles/symbolic values, ISO dates and tolerance tuples | TechnicalDrawing, DimensionLine and ExtensionLine | Drawing sheet and both dimension forms |
| Modeling operations | Functions, JSX and native methods | Native operands and exact build123d keyword arguments | Independent native operation comparisons | Extrude, revolve, loft, sweep, fillet, chamfer, booleans, transforms and more |
| Draft, full round and sheet metal | Functions and JSX | Face/edge selections, planes, bend outline and widths | `draft`, `full_round` and `make_brake_formed` comparisons | Dedicated tapered box, rounded profile and bent sheet fixtures |
| Child composition | Nested operation JSX | Child geometry supplies the native operand; explicit operands take precedence | Collection and operation composition regressions | Nested extrusion, fillet and section |
| Collection-valued geometry | RPC and plan rendering | ShapeList handles retain methods; nested lists/tuples flatten for rendering | `pack`, SVG/DXF imports, `edges_to_wires` and nested outputs | Packed parts plus imported-file workflow checks |
| Projection and primitive detection | Functions and JSX geometry results | Mixed return tuples preserve shapes, collections and code strings | Planar projection; six planar patches reconstructed from a Mesher box | Projection fixture; primitive reconstruction checked numerically |
| Native assemblies | Constructors, imported STEP and plan rendering | Child labels, colors, world placements and ancestor paths | Native Compound and STEP assembly regressions | Colored native Compound and existing multi-part assemblies |
| Joints | All five joint classes through RPC | Retained part/joint handles | Rigid, revolute, linear, cylindrical and ball joint comparisons | Assembly geometry fixtures; joint motion checked numerically |
| Topology and selection | Native methods, properties, indexing and symbolic expressions | Typed handles and ShapeList operations | Filtering, grouping, slicing, sorting and topology constructors | Geometry fixtures inspect validity and tessellation |
| Enums and signature dependencies | Registered native values | All root enum members plus ColorIndex; dates, UUIDs and binary data | Enum round trips, colored DXF and dated drawings | Colored assemblies and drawings |
| STEP / BREP / STL / SVG / DXF | Native file APIs and browser transfer endpoints | Confined native paths; browser Blob/File uploads and downloads | Native and HTTP round trips; imported plans replay in a fresh kernel | Sandbox import/regeneration/download browser checks |
| GLTF / GLB / OBJ | Native functions through RPC | Native workspace paths and supported binary streams | Parsed GLTF buffers/accessors/UVs, GLB headers, OBJ faces/normals/UV indices | Export structure checked directly |
| Mesher / 3MF | Native constructor/methods through RPC | File paths, stream handles, units, part metadata and UUIDs | Parsed 3MF archive, round-trip volume/label/color and primitive reconstruction | Meshed geometry checked numerically |
| Python protocol operations | Explicit RPC and symbolic operators | Arithmetic, comparison, indexing, round, iteration, indexed mutation/deletion | Native parity and collection mutation tests | Geometry resulting from operations |
| Native callbacks | `expr.lambda`, `expr.apply`, arguments, operators and conditional expressions; callable-handle `.invoke(...)` | Serializable expression tree evaluated against native objects; typed callable handles | Native callable selection and direct invocation comparisons | Selected topology feeds modeling fixtures |
| TypeScript API | Generated JSX, constructors, functions, native methods and properties | Typed enums/vectors/topology, overloads and native result handles | Positive and negative compiler checks | Runtime checks remain independent of declarations |
| Viewer controls | Packaged viewer and sandbox | Shared Z-up OrbitControls setup | Actual Three.js drag-direction and orientation-preservation tests | Four engineering views; edge/resize changes preserve orbit, pan and zoom |
| Editable sandbox | Browser worker compiles JSX; native service regenerates geometry | Editable source/parameters, structured errors and CAD import/export | Browser edits checked against changed native volumes | All catalog examples and desktop/mobile interactions |

Native behavior tests are in [conformance](../tests/conformance),
[kernel/HTTP tests](../tests/python), and [regressions](../tests/review).
[Visual fixtures](../examples/gallery/fixtures.ts) contain 73 native scenarios
with isometric, top, front and right baselines. Browser workflows also have
dedicated [sandbox checks](../scripts/test-sandbox.mjs). These are representative
behavioral checks, not proof that every inherited method and every parameter
combination has a separate test.

## Python and JavaScript differences

- JavaScript calls are asynchronous. Use `.operator(...)` for Python algebra;
  JavaScript cannot overload `+`, `&`, or `@` for native handles.
- Use JSX `BuildPart`, `BuildSketch`, `BuildLine` and location scopes for native
  context-manager workflows. Open builder contexts across separate RPC requests
  are intentionally unsupported: they would retain thread-local native context
  beyond a request. Contextual selectors still execute inside native JSX scopes.
- Use `expr.lambda` to construct serializable native callbacks, `expr.apply`
  to invoke them within a plan, or `.invoke(...)` on returned callable handles. JavaScript
  closures, arbitrary Python evaluation and private Python members are outside
  the protocol. Raw OCP objects are not browser values; native expressions can
  pass existing native attributes directly between supported calls.
- Static headless compilation requires pure synchronous components. The live
  React renderer supports hooks, context and component state.
- Native text needs an installed font. The hosted kernel registers bundled
  DejaVu Sans and maps native drawing text's Arial default to that font.
  Fonts absent on the host follow build123d's native fallback/error behavior.
- Primitive detection needs a topological triangle mesh, such as
  `Mesher.read(...)`. Native `import_stl` returns a triangulated OCCT Face, on
  which build123d 0.13.0 primitive detection raises `Standard_NullObject`.
  The bridge preserves that native error; use the Mesher input workflow.

## Backend lifetime and transfer limits

RPC handles, general uploaded-file IDs and stream handles belong to one running
service process. Keep long RPC sessions on a persistent local/container service.
Serverless instances can restart or route a later request to another process.

The hosted sandbox regenerates and exports complete plans in one request.
Imported plans embed their CAD file contents with `$file`, so they remain usable
on another instance or after a restart. Local file transfers accept up to 32 MiB.
The Vercel deployment caps request bodies at 4 MiB, within Vercel's function
payload limit; embedded base64 imports have less available binary capacity.
Large files or models should use the documented container/local service and
the sandbox's kernel URL setting. See [deployment](DEPLOYMENT.md).
