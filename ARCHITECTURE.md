# Architecture and plan protocol

React compiles CAD components to a serializable plan. A TypeScript compatibility
kernel evaluates that plan using OpenCascade.js WebAssembly and Replicad. Three.js
renders its tessellations. There is no Python process, geometry HTTP service, or
server-side CAD execution.

## Runtime loading

`BrowserKernel.create(options)` initializes OpenCascade asynchronously.
`NativeClient` initializes its kernel lazily; `client.ready` allows preloading.
The package ships `opencascade.wasm` and `DejaVuSans.ttf` beside its JavaScript
output. Applications can supply `wasmUrl`/`fontUrl`, byte buffers, or an existing
`openCascade` instance. Node uses the installed WASM dependency; browsers load
static assets. Serving CAD assets does not require a compute backend.

The headless compiler builds plans without initializing geometry. The React
reconciler updates a plan at commit time, keeping CAD work outside speculative
renders. `Build123dView` renders through a local `NativeClient`, ignores stale
results, uses a Z-up orthographic camera, and disposes GPU resources on changes
and unmounts. Applications can inject a shared `client` or `kernel` into the viewer.

The sandbox isolates source compilation in a disposable worker. Its separate
persistent CAD worker serializes local kernel operations. Aborting a CAD request
terminates that worker, making cancellation effective even during a synchronous
OpenCascade computation. A fresh worker initializes on the next operation.

## Shared serializable plan

```ts
Plan = { version: 1, children: PlanNode[] }
PlanNode = { type: string, props: Record<string, WireValue>, children: PlanNode[] }
```

Node types use build123d symbol names or composition helpers such as `Union`,
`Subtract`, `Intersect`, `Translate`, `Rotate`, `Group`, `Shape`, and `Call`.
`props.args` supplies positional arguments. Other properties use upstream keyword
names except metadata such as `color`, `position`, `name`, and `id`. Builder
nodes evaluate children in order; composition operations accept child operands.

`id` captures an evaluated value for later references within the plan. Retained
handle references belong to their originating local kernel/client, while saved
plans can be replayed in a fresh kernel. A handle cannot be transferred to a
separate worker or another client. Imported plans embed their source file bytes.

| Encoding | Local meaning |
| --- | --- |
| `{ $enum: 'Align.CENTER' }` | Compatibility enum value |
| `{ $type: 'Plane', path: 'XY' }` | Public type or class attribute |
| `{ $ref: 'id' }` | A plan capture or retained object |
| `{ $call: 'Vector', args: [...], kwargs: {...} }` | A compatible constructor/function call |
| `{ $bytes: 'AAH/' }` | Byte buffer; results decode as `Uint8Array` |
| `{ $file: { name: 'part.step', base64: '...' } }` | Bytes materialized in the WASM virtual filesystem |
| `{ $date: '2026-01-02' }` | ISO date string for compatible APIs |
| `{ $uuid: '12345678-1234-5678-1234-567812345678' }` | UUID string for compatible APIs |

Nested `$method`, `$get`, `$index`, and `$operator` expressions describe method,
property, selection, and algebra operations. `$lambda` uses `$arg` placeholders;
`$if` selects a branch; `$apply` invokes a compatible callable. The `expr` helpers
produce these expressions without transmitting executable JavaScript closures.

## Local dispatch and handles

The retained RPC-shaped request format remains serializable but is dispatched
in-process, without HTTP:

```ts
{
  op: 'construct' | 'function' | 'method' | 'invoke' | 'get' | 'set' |
      'index' | 'operator' | 'release' | 'setitem' | 'delitem',
  name?: string,
  target?: WireValue,
  args?: WireValue[],
  kwargs?: Record<string, WireValue>,
  index?: WireValue,
  value?: WireValue,
}
```

`BrowserKernel.rpc()` returns `{ value }`; non-serializable compatible objects use
`{ $ref, kind }`. The client restores stable `NativeHandle` identity and rejects
released or cross-client handles before execution. Release retained handles when
finished, or use `client.releaseAll()`. Errors retain their message, `kernelType`,
optional plan `path`, and cause through `NativeError`.

`client.inventory()` distinguishes implemented root bindings from unsupported
ones. Generated build123d signatures remain the compatibility reference; runtime
support and Python behavioral parity are separate concerns. Unsupported public
operations throw explicit errors. Private members and raw code evaluation are
outside the protocol.

## Geometry and meshes

`client.render(plan, { tolerance, angularTolerance, signal })` returns:

```ts
{
  meshes: MeshData[],
  bounds: { min: number[], max: number[] } | null,
  kernel: string,
}
```

Meshes include positions, normals, triangle indices, sampled topology edges,
optional vertices, name/color/assembly ancestry, volume, area, validity, and
shape kind. Edge coordinates are flattened xyz lists. Empty scenes return no
meshes. OpenCascade constructs the BRep and tessellates faces; geometry is not
approximated by a separate display-only mesh kernel.

## Files and streams

Browser `File`, `Blob`, buffers, and typed byte arrays move directly into local
memory and the Emscripten virtual filesystem. File names are confined to each
kernel's generated virtual directory. The file APIs retain a 32 MiB input limit,
with no HTTP payload or serverless response limit. Uploaded IDs and stream
handles last for that local instance; inline `$file` plans remain portable.

STEP, STL, BREP, SVG, and DXF use compatible import/export bindings. Additional
mesh export formats are described in the [file guide](docs/FILE-TRANSPORT.md).
`BytesIO` and `StringIO` are compatible JavaScript stream objects, not Python
objects. Their contents can be read, replaced, sought, or supplied to supported
file APIs. Downloads return browser Blobs. Nothing is uploaded to a CAD backend.
