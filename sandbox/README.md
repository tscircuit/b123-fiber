# b123-fiber sandbox

A browser gallery of **73 build123d examples**, generated with the actual
OpenCascade kernel: solids, sketches, curves, modeling operations and assemblies.
Each example includes editable JSX, its serialized plan, native geometry
statistics and an interactive 3D preview. The default geometry service is
`https://b123-fiber-kernel.vercel.app`, running build123d 0.13.0/OpenCascade.

## Develop

Run these commands from the repository root:

```sh
npm ci
npm run sandbox:dev
```

Vite serves the sandbox at `http://localhost:5180`. The gallery loads checked-in
native meshes and thumbnails from `sandbox/public`, so browsing the examples
works immediately. Orbit, pan and zoom; choose an engineering view; inspect
source; and download model data, plans or screenshots. Edit JSX and press **Run**
or **Ctrl/Cmd+Enter** to regenerate geometry. The **Parameters** tab updates the
same model source. JSX compiles in a disposable browser worker, and modeling
errors preserve the last valid preview.

**Import CAD** accepts STEP, STL, BREP, SVG and DXF files. **Download CAD** exports
the current edited source in those formats. Imported plans embed the file data,
so they can be regenerated and exported after the hosted kernel restarts.

The **Kernel** setting selects a different service URL and an optional bearer
token. Run your own kernel for larger models or long-lived native RPC sessions:

```sh
uv run build123d-fiber-kernel --origin http://localhost:5180
```

The hosted sandbox caps files at 2 MiB and the hosted service caps HTTP request
payloads at 4 MiB. Local file transfer supports 32 MiB. See
[deployment](../docs/DEPLOYMENT.md) and [file transport](../docs/FILE-TRANSPORT.md).

```sh
npm run sandbox:build
npm run test:sandbox
npm run test:sandbox:editor
```

The production build goes to `sandbox/dist`. Browser checks validate all 73
native models, render every example, and exercise desktop and mobile controls.
Screenshots and reports are written to `artifacts/sandbox`. Controls also have
direction checks for horizontal and vertical drags in all four engineering views.
The UI uses Tailwind defaults with system fonts.
The editor checks use actual HTTP requests to the native kernel, including
changed volumes, error recovery, React hooks, file round trips and mobile layout.

## Update example geometry

The example definitions are shared with the library's visual regression suite
in `examples/gallery/fixtures.ts`. To regenerate models and source:

```sh
uv sync --extra test --frozen
npm run sandbox:generate
```

The generator verifies native shape validity, known volumes, dimensions and
triangle indices. It also compiles every displayed JSX example and checks that
its plan matches the model-generation input. Models use a 0.12 mm linear
tessellation tolerance and 0.15 angular tolerance; display coordinates are
stored to six decimal places. Original native area and volume measurements
remain in the model metadata.

Thumbnails are the reviewed isometric images from
`tests/visual/baselines`. After intentionally changing example geometry, update
and inspect those baselines with `npm run test:visual -- --update` before
regenerating the gallery assets.

## Deploy to Vercel

The [live sandbox](https://b123.tscircuit.com) is hosted
in the `tscircuit` Vercel team. Its existing project is connected to this GitHub
repository: pushes to `main` deploy to production automatically.

Import `tscircuit/b123-fiber` into Vercel with the **repository root** as the
project root. The root `vercel.json` configures:

- Install: `npm ci`
- Build: `npm run sandbox:build`
- Output: `sandbox/dist`

The frontend is static. Browsing uses checked-in native geometry, and editing
calls the separate native Vercel project. `VITE_KERNEL_URL` can override the
default service at build time. To deploy from an authenticated CLI:

```sh
npx vercel --prod
```

To verify an existing deployment:

```sh
SANDBOX_URL=https://your-project.vercel.app npm run test:sandbox
```

When using Vercel's temporary deployment mode, claim the deployment in your
Vercel account to retain it permanently. Keep the private claim link and
`.vercel` state outside version control.
