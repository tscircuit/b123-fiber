# Browser files and compatible streams

CAD file operations run locally in the OpenCascade WASM instance. Browser bytes
are copied into its virtual filesystem when required by a native OpenCascade
reader/writer. No HTTP upload, geometry backend, or Python runtime is involved.

## Imports and downloads

`client.importFile(input, { filename?, format?, kwargs?, signal? })` accepts a
browser `File`/`Blob`, `ArrayBuffer`, or typed byte array. The result contains a
retained compatible `value`, self-contained `plan`, and rendered mesh `result`.
The filename extension selects a format when `format` is omitted. STEP, STL,
BREP, SVG, and DXF have import bindings; see compatibility notes for differences.

```ts
import { NativeClient, NativeHandle } from '@tscircuit/b123-fiber'

const client = new NativeClient()
const imported = await client.importFile(file)
const regenerated = await client.render(imported.plan)
const step = await client.exportFile(imported.plan, 'step', { filename: 'part.step' })

const url = URL.createObjectURL(step)
const link = document.createElement('a')
link.href = url
link.download = 'part.step'
link.click()
setTimeout(() => URL.revokeObjectURL(url), 1000)

if (imported.value instanceof NativeHandle) await imported.value.release()
```

`exportFile(planOrHandle, format, { filename?, kwargs?, signal? })` returns a
browser `Blob`. The file bindings support STEP, STL, BREP, SVG, DXF, and mesh
exports such as GLTF/GLB, OBJ, and 3MF. These compatibility writers are not a claim
that every upstream exporter option is implemented. SVG/DXF are two-dimensional
formats; preserve the intended projection/workplane when preparing geometry.

`uploadFile(input, { filename?, signal? })` stores local bytes and returns
`{ id, name, path, size, contentType }`. `path` is a virtual filesystem path for
supported file-path APIs. `downloadFile(fileOrId)` returns a Blob;
`deleteFile(fileOrId)` removes it. IDs belong to the current kernel instance.
Names cannot traverse parent directories. The 32 MiB input limit applies locally;
there are no geometry HTTP payload or serverless response budgets.

`nativeFile(input, filename?)` creates `{ $file: { name, base64 } }` for a symbolic
import without initializing the kernel. Saved imported plans embed those bytes
and can be replayed after the worker/browser/kernel is recreated. Base64 expands
saved file data by approximately one third.

## Byte and text streams

`BytesIO` and `StringIO` are compatible JavaScript stream objects. They provide
read/write, seek/tell, getvalue, truncate, and close behavior for supported APIs.

```ts
const box = await client.construct('Box', [2, 3, 4])
const stream = await client.createStream(new Uint8Array())
await client.callFunction('export_step', [box, stream])
const bytes = await client.readStream(stream)
await Promise.all([stream.release(), box.release()])
```

`createStream('text')` defaults to `StringIO`; `{ kind: 'bytes' | 'text' }`
overrides that inference. `readStream(handle)` returns `Uint8Array` or `string`
without moving the stream position. `writeStream(handle, contents)` replaces
contents and rewinds. Supported public stream methods are available through
`.call()`. Typed byte arrays passed through local dispatch encode as `$bytes`;
byte results decode as `Uint8Array`.

`$date` and `$uuid` retain ISO/UUID strings for compatible APIs rather than
constructing Python date/UUID instances. The root namespace also retains
auxiliary types such as `ColorIndex`, `BytesIO`, and `StringIO` where signatures
refer to them.

## Lifetime and worker boundaries

Handles, file IDs, and streams belong to one local instance. A worker restart
releases that instance, so use a saved inline-file plan for portable geometry.
Release retained import values and stream handles when finished. Handles cannot
be structured-cloned into a different worker; pass plans or file bytes instead.

The sandbox worker releases the temporary imported handle before returning its
plan and meshes to the UI. Exported Blobs can be cloned across that boundary.
See [architecture](../ARCHITECTURE.md) and [compatibility](COMPATIBILITY.md).

## Format compatibility

STEP and BREP use OpenCascade's actual readers and writers inside WASM. STEP
exports preserve part names and colors. STL imports sew the native triangular
faces into a shell or solid. Tessellated STL input retains its faceted geometry;
recovering analytic primitives from those triangles is not implemented.

SVG imports support lines, polylines, polygons, rectangles, circles, ellipses and
all standard path commands, including native Bézier and elliptical curves.
Nested closed subpaths preserve holes with `evenodd` and `nonzero` fill rules.
Intersecting subpaths require boolean simplification first. Text, external
references (`use`), images, foreign objects, and sheared matrix transforms
require conversion to ordinary paths before import. These cases fail explicitly.
SVG planar face export preserves its native outlines; open wires and 3D edges
are projected to XY with tolerance-controlled sampling.

DXF import supports LINE, CIRCLE, ARC, ELLIPSE, LWPOLYLINE (including bulges),
legacy straight POLYLINE, POINT, and SPLINE with fit points. Control-point-only
splines, legacy POLYLINE bulges, text, blocks/INSERT, and other entities require
conversion to supported entities. DXF export writes lines exactly and samples
curved edges to polylines; it is not an analytic curve-preserving round trip.

OBJ and GLTF/GLB contain actual OpenCascade tessellation, normals, and native
face UV coordinates. The UV atlas and gutter packing options are not implemented.
`Mesher` reads and writes genuine 3MF ZIP archives and STL; 3MF retains units,
names, colors, part numbers, UUIDs, and model metadata. It supports mesh counts
and byte-stream export. It uses the JavaScript 3MF writer, so `library_version`
identifies that writer rather than a native Lib3MF installation. Automatic
caller-source capture (`add_code_to_metadata`) is not implemented. The 3MF
reader supports mesh objects, component hierarchies, and affine build transforms.

Exporter layer styling, line patterns, page layout, and advanced schema/options
do not yet cover every upstream overload. Consult the compatibility inventory
and verify the exported artifact when depending on a particular advanced option.
