# Architecture and wire protocol

The canonical geometry kernel is build123d 0.13.0 (OpenCascade 8 via OCP).
React compiles to a serializable plan. A local Python HTTP service executes native
builders, objects and operations, and returns OCCT tessellations. The browser does
not require a Python runtime; the geometry service does.

## Shared JSON wire format

`Plan = { version: 1, children: PlanNode[] }`

`PlanNode = { type: string, props: Record<string, WireValue>, children: PlanNode[] }`

Node type is an exact build123d public symbol (e.g. `Box`, `extrude`,
`BuildSketch`), or one of `Union`, `Subtract`, `Intersect`, `Translate`,
`Rotate`, `Group`, `Shape`, `Call`.

`props.args` supplies positional arguments, all other props are exact Python
keyword names except common metadata `color`, `position`, `name`, and `id`.
`rotation` and `align` retain build123d meanings. Arrays work for vectors and
align tuples. Build contexts execute children while the real context is active.
Compositional operations evaluate their child geometry inside a native working
builder before applying the operation. Pass operation arguments by keyword
(`amount`, `radius`, etc.) when providing child geometry.

`id` captures a node's native result for later plan references. Real builder
nodes capture their builder object; boolean and operation nodes capture their
resulting shape. Plan references last for one evaluation. RPC references live
in the geometry service until explicitly released.

Encoded values: `{ $enum: "Align.CENTER" }`,
`{ $type: "Plane", path: "XY" }`, `{ $ref: "id" }`,
`{ $call: "Vector", args: [...], kwargs: {...} }`.
Nested `$method`, `$get`, `$index`, and `$operator` expressions preserve native
method, property, collection, and algebra semantics. `$lambda` expression bodies
use `$arg` placeholders to define native selector callbacks; `$if` selects one
branch. See [API usage](docs/API.md) for the TypeScript `expr` helpers.

Render endpoint: `POST /render` body `{ plan, tolerance?: number, angularTolerance?: number }`.
Response: `{ meshes: MeshData[], bounds: { min: number[], max: number[] } | null, kernel: string }`.
`MeshData = { positions: number[], normals: number[], indices: number[], edges: number[][], vertices?: number[], color?: string | number[], name?: string, volume: number, area: number, valid: boolean, kind: string }`.
Edges are flattened xyz point lists. Empty scenes return no meshes.
Isolated vertices use `vertices` and render as points. Native faces use OCCT
triangulations; native edges are sampled from their exact curves.

RPC endpoint: `POST /rpc` body `{ op: "construct"|"function"|"method"|"get"|"set"|"index"|"operator"|"release", name?: string, target?: WireValue, args?: WireValue[], kwargs?: Record<string, WireValue>, value?: WireValue }`.
Response `{ value: WireValue }`. Non-JSON native values use retained object refs
with `kind`. Native errors return structured error JSON and non-2xx status.
`GET /api` returns a generated runtime inventory of every public root symbol,
class method/property and constructor/function signature. No raw Python eval.

The service binds to localhost by default. RPC retains native objects until
released or process exit. All native CAD operations are serialized by a lock.
Import/export paths resolve inside `--workspace-root` (the launch directory by
default). `--origin` configures permitted browser origins;
`BUILD123D_FIBER_TOKEN` optionally requires a bearer token. NativeClient supports
custom transport headers.

The live React renderer updates a plan tree at commit time, keeping geometry
execution outside React's speculative renders. The viewer aborts stale requests,
preserves mounted CAD component state, frames geometry with a Z-up orthographic
camera, and releases GPU resources when geometry changes or the viewer unmounts.
