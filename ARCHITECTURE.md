# Architecture and wire protocol

The canonical geometry kernel is build123d 0.13.0 (OpenCascade 8 via OCP).
React compiles to a serializable plan. A Python HTTP service executes native
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
in one geometry-service process until explicitly released or that process exits.
An RPC handle cannot move between serverless workers. Use self-contained plans
for hosted rendering and downloads; imported file plans embed their content.

Encoded values: `{ $enum: "Align.CENTER" }`,
`{ $type: "Plane", path: "XY" }`, `{ $ref: "id" }`,
`{ $call: "Vector", args: [...], kwargs: {...} }`.
Nested `$method`, `$get`, `$index`, and `$operator` expressions preserve native
method, property, collection, and algebra semantics. `$lambda` expression bodies
use `$arg` placeholders to define native selector callbacks; `$if` selects one
branch. See [API usage](docs/API.md) for the TypeScript `expr` helpers.

Transport values also include:

| Value | Native meaning |
| --- | --- |
| `{ $bytes: "AAH/" }` | Strict base64-encoded Python `bytes`; native bytes decode to `Uint8Array` in the client. |
| `{ $file: { name: "part.step", base64: "..." } }` | File content materialized at a SHA256-named path inside the kernel workspace. |
| `{ $date: "2026-01-02" }` | Python `datetime.date`; an ISO datetime creates `datetime.datetime`. |
| `{ $uuid: "12345678-1234-5678-1234-567812345678" }` | Python `uuid.UUID`. |

File names must be basenames. Embedded files use strict base64, have a 32 MiB
decoded limit, and resolve inside `workspace/.uploads`; symlink escapes are
rejected. Their materialized paths are implementation details. A `$file` plan
can run on a fresh service process with the same result.

Render endpoint: `POST /render` body `{ plan, tolerance?: number, angularTolerance?: number }`.
Response: `{ meshes: MeshData[], bounds: { min: number[], max: number[] } | null, kernel: string }`.
`MeshData = { positions: number[], normals: number[], indices: number[], edges: number[][], vertices?: number[], color?: string | number[], name?: string, assemblyPath?: { name: string, index: number }[], volume: number, area: number, valid: boolean, kind: string }`.
Edges are flattened xyz point lists. Empty scenes return no meshes.
Isolated vertices use `vertices` and render as points. Native faces use OCCT
triangulations; native edges are sampled from their exact curves.
Shape collections are flattened into meshes. Native assembly children retain
part labels, colors, locations, and assembly paths; explicit JSX metadata takes
precedence over native appearance.

RPC endpoint: `POST /rpc` body `{ op: "construct"|"function"|"method"|"invoke"|"get"|"set"|"index"|"operator"|"release"|"setitem"|"delitem", name?: string, target?: WireValue, args?: WireValue[], kwargs?: Record<string, WireValue>, index?: WireValue, value?: WireValue }`.

`invoke` calls a retained native callable. Plans use
`{ $apply: { target, args, kwargs } }`, constructed by `expr.apply`, for the same
operation without requiring a cross-request handle.
Response `{ value: WireValue }`. Non-JSON native values use retained object refs
with `kind`. Native errors return structured error JSON and non-2xx status.
`GET /api` returns a generated runtime inventory of every public root symbol,
class method/property and constructor/function signature. Its `exports` remains
the exact 203-symbol build123d root surface; `auxiliarySymbols` records `Shape`,
`ColorIndex`, `BytesIO`, and `StringIO`, which supported signatures also need.
`setitem` and `delitem` preserve native indexed mutation; explicit operators also
include `round`, `reversed`, and `next`. No raw Python eval.

## Browser files and native streams

All routes use the same bearer-token and configured-origin policy as RPC.
Binary endpoints expose `Content-Disposition` to allowed origins and return
structured JSON errors on failure. Uploads are raw request bodies, avoiding a
multipart dependency.

| Endpoint | Behavior |
| --- | --- |
| `POST /files?filename=part.step` | Store bytes under a generated ID; return `{ file: { id, name, path, size, contentType } }`. |
| `GET /files/{id}` | Download a registered file as an attachment. |
| `DELETE /files/{id}` | Delete the registered file. |
| `POST /files/import?filename=part.step&format=step` | Import raw file content; return `{ value, plan, result }`. The plan embeds `$file` and survives process restarts. |
| `POST /files/export` | Export `{ format, plan }` or `{ format, target }` to a binary attachment, with optional `filename` and native keyword `options`. |
| `POST /streams?kind=bytes` | Construct a retained `BytesIO` from the body; `kind=text` constructs UTF-8 `StringIO`. |
| `GET /streams/{id}` | Read complete stream contents without moving its position. |
| `POST /streams/{id}` | Replace stream contents and rewind to position zero. |

CAD upload/download formats are STEP, STL, BREP, SVG, and DXF. Import options
are encoded in the `options` JSON query parameter. General uploads use generated
paths inside `workspace/.b123-fiber-files`; only registered IDs can be downloaded,
and every native path still passes workspace containment checks. Stream objects,
uploaded IDs, and RPC import values belong to one process; the returned import
plan is the portable artifact. Release stream and native handles after use.

Local file transport accepts files up to 32 MiB. Hosted Vercel requests must stay
below 4 MiB per HTTP payload, including base64 plan content and returned mesh
JSON; base64 expands bytes by roughly one third. The sandbox caps hosted uploads
at 2 MiB. Large models may need a configured persistent kernel. See
[deployment limits](docs/DEPLOYMENT.md) and the
[compatibility matrix](docs/COMPATIBILITY.md). The
[file transport guide](docs/FILE-TRANSPORT.md) documents the client methods.

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
