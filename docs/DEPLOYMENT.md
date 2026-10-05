# Static deployment

The sandbox and browser CAD runtime deploy as static frontend assets. Vercel
builds the root project with `npm ci` and `npm run sandbox:build`, then serves
`sandbox/dist`. OpenCascade's WASM binary and the outline font are emitted into
the build; source compilation and CAD computation run in browser workers.
There is no Python function, CAD API endpoint, or separate geometry deployment.

The existing [sandbox](https://b123.tscircuit.com) project is connected to this
GitHub repository. Pushes to `main` deploy production; this migration can be
reviewed in its PR preview before merge. The previously published 0.2.0 frontend
uses the earlier service until the migration is merged and deployed.

When consuming the npm or CDN package, publish its WASM and font assets alongside
the JavaScript. Default loading resolves packaged assets relative to the module.
For a separate asset host, configure `wasmUrl` and `fontUrl`; that host must permit
browser access. Bytes can also be supplied with `wasmBinary`/`fontBinary`, or an
initialized compatible instance with `openCascade`. Serve WASM with
`application/wasm`; version the assets together with their JavaScript loader.

The single-threaded kernel does not require cross-origin isolation. Applications
that need responsive interaction during complex CAD work should use a dedicated
worker, as the sandbox does. Worker termination provides effective cancellation
of synchronous native computations; the next request initializes a fresh worker.

CAD file imports use the local virtual filesystem and a 32 MiB input limit.
There are no CAD serverless request/response limits or authentication settings.
Keep self-contained plans when persisting imported files across browser sessions.
See [file APIs](FILE-TRANSPORT.md) and [architecture](../ARCHITECTURE.md).
