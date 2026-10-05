# b123-fiber sandbox

The sandbox shows editable build123d-style JSX, model parameters, CAD file
import/export, and an interactive Three.js preview. Geometry executes locally
in OpenCascade WebAssembly; no Python installation or geometry backend is used.

Run these commands from the repository root:

```sh
npm ci
npm run sandbox:dev
```

Vite serves the sandbox at `http://localhost:5180`. Gallery thumbnails are static references; selecting an example constructs its
geometry locally. Edit JSX and press **Run** or **Ctrl/Cmd+Enter**
to rebuild the model with the browser kernel. The **Parameters** tab updates the
same source. JSX compiles in a disposable worker; CAD computation runs in a
separate persistent worker. Cancellation terminates the CAD worker, so a slow
operation does not block the application. Errors preserve the last valid preview.

**Import CAD** reads browser files through the WebAssembly virtual filesystem.
**Download CAD** exports the current edited source. Imported plans embed their
file content, so they can be saved and replayed in a fresh browser session.
Supported formats and build123d bindings are listed in the compatibility docs.

```sh
npm run sandbox:build
npm run test:sandbox
npm run test:sandbox:editor
```

The production build goes to `sandbox/dist`, including the OpenCascade WASM
asset. Browser checks render examples, verify editing and file round trips, and
exercise desktop/mobile layout and camera controls. Screenshots and reports are
written to `artifacts/sandbox`. The UI uses Tailwind defaults with system fonts.

Example definitions are shared with the visual regression suite in
`examples/gallery/fixtures.ts`. Historical native snapshots remain available
for comparisons against the WebAssembly migration.

The [live sandbox](https://b123.tscircuit.com) is hosted in the `tscircuit` Vercel
team. The project is connected to this GitHub repository: pushes to `main`
deploy to production. Pull requests receive separate preview deployments.
The root `vercel.json` uses `npm ci`, `npm run sandbox:build`, and `sandbox/dist`.
Everything is served as static frontend assets.
