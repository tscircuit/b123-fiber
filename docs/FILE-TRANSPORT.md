# Browser files and native streams

The file bridge uses the actual native build123d kernel and the same authentication,
origin policy, and workspace containment as geometry requests.

## Browser files and downloads

`NativeClient.importFile(file, { filename?, format?, kwargs?, signal? })` accepts a
browser `File`/`Blob`, `ArrayBuffer`, or typed byte array. Formats are `step`,
`stl`, `brep`, `svg`, and `dxf`; the filename extension selects the format when
it is omitted. The result contains a native `value`, a self-contained `plan`,
and rendered mesh `result`.

```ts
import { NativeClient, NativeHandle } from '@tscircuit/b123-fiber'

const client = new NativeClient({ url: '/api/kernel' })
const file = document.querySelector<HTMLInputElement>('#cad-file')!.files![0]!
const imported = await client.importFile(file)
const preview = imported.result
const regenerated = await client.render(imported.plan)
const step = await client.exportFile(imported.plan, 'step', { filename: 'part.step' })

const link = document.createElement('a')
link.href = URL.createObjectURL(step)
link.download = 'part.step'
link.click()
setTimeout(() => URL.revokeObjectURL(link.href), 0)

if (imported.value instanceof NativeHandle) await imported.value.release()
```

`exportFile(planOrHandle, format, { filename?, kwargs?, signal? })` returns a
`Blob`. Native exporter keyword arguments, such as STEP `unit` or STL
`tolerance`, go in `kwargs`. SVG/DXF use their native exporter constructors;
DXF `ascii_format` goes to the writer. Preserve native projection/workplane
semantics when exporting two-dimensional formats.

For direct file-path API calls, `uploadFile(contents, { filename?, signal? })`
returns `{ id, name, path, size, contentType }`; `path` is workspace-relative.
`downloadFile(fileOrId)` returns a `Blob`, and `deleteFile(fileOrId)` removes it.
The service creates its own paths and rejects filename traversal and symlink
escapes. `nativeFile(file, filename?)` creates an inline `$file` value for a
symbolic native import argument without contacting the service.

File transfer accepts up to 32 MiB locally. The hosted Vercel service has a
4 MiB HTTP payload budget; embedded base64 and returned mesh JSON count toward
that budget. The sandbox caps hosted uploads at 2 MiB to leave encoding headroom.
Large or complex models can exceed the response budget; configure a persistent
kernel URL for those models. A 4 MiB source file is larger after base64 encoding. See
[deployment limits](DEPLOYMENT.md).

## Native streams and transport values

Use retained native `BytesIO` or UTF-8 `StringIO` objects where an overload
supports a Python binary or text stream:

```ts
const box = await client.construct('Box', [2, 3, 4])
const stream = await client.createStream(new Uint8Array()) // BytesIO
await client.callFunction('export_step', [box, stream])
const content = await client.readStream(stream)
if (!(content instanceof Uint8Array)) throw new Error('Expected binary stream')
const download = new Blob([new Uint8Array(content)], { type: 'application/step' })
await Promise.all([stream.release(), box.release()])
```

`createStream('text')` defaults to `StringIO`; `{ kind: 'bytes' | 'text' }`
overrides inference. `readStream(handle)` returns `Uint8Array` or `string` and
leaves the native position unchanged. `writeStream(handle, contents)` replaces
content and rewinds. Native `.call('seek', [0])`, `.call('getvalue')`, and other
public stream methods are available. Python byte results decode as `Uint8Array`,
and typed byte arrays passed through RPC encode as `$bytes`.

Wire values preserve data needed by native overloads:

| Encoding | Python value |
| --- | --- |
| `{ $bytes: 'AAH/' }` | `bytes` containing `0, 1, 255` |
| `{ $file: { name: 'part.step', base64: '...' } }` | A confined, content-addressed file path |
| `{ $date: '2026-01-02' }` | `datetime.date`; an ISO datetime produces `datetime.datetime` |
| `{ $uuid: '12345678-1234-5678-1234-567812345678' }` | `uuid.UUID` |

`ColorIndex`, `BytesIO`, and `StringIO` are auxiliary signature dependencies,
available alongside the exact 203 root exports. `GET /api` reports auxiliary
symbols separately. Stream support follows each native overload: STEP/BREP and
SVG/DXF writers accept binary streams; SVG/DXF readers accept their native text
stream variants. STL uses the browser file bridge because its native APIs require
paths. Native STL imports retain upstream triangulation behavior and validity
values rather than becoming analytic BREP solids.

## Indexed mutation and handle lifetime

Use `handle.setAt(index, value)` and `handle.deleteAt(index)` for Python indexed
assignment and deletion. Client-level equivalents are
`client.setAt(target, index, value)` and `client.deleteAt(target, index)`.
Explicit `.operator()` calls also support native `round`, `reversed`, and `next`.
Returned native callable handles support `.invoke(args, kwargs)`; the client
equivalent is `client.invoke(target, args, kwargs)`. Use `expr.apply(target,
args, kwargs)` to invoke a native callable within a self-contained plan.

Native handles, uploaded file IDs, and streams live in one service process.
Serverless requests can reach different workers, so an RPC handle is unsuitable
for a portable hosted scene. Imported `plan` values embed the source file and
can be rendered or exported after a cold start. Use those plans in hosted apps;
release any retained import `value` when it is no longer needed. Native context
managers are represented by JSX builders, and the bridge does not execute raw
Python code.
