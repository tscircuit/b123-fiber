# b123-fiber sandbox

A browser gallery of **58 build123d examples**, generated with the actual
OpenCascade kernel: solids, sketches, curves, modeling operations and assemblies.
Each example includes runnable JSX, its serialized plan, native geometry
statistics and an interactive 3D preview.

## Develop

Run these commands from the repository root:

```sh
npm ci
npm run sandbox:dev
```

Vite serves the sandbox at `http://localhost:5180`. The gallery loads checked-in
native meshes and thumbnails from `sandbox/public`, so browsing the examples
works immediately. Orbit, pan and zoom; choose an engineering view; inspect
source; and download model data, plans or screenshots.

```sh
npm run sandbox:build
npm run test:sandbox
```

The production build goes to `sandbox/dist`. Browser checks validate all 58
native models, render every example, and exercise desktop and mobile controls.
Screenshots and reports are written to `artifacts/sandbox`. Controls also have
direction checks for horizontal and vertical drags in all four engineering views.
The UI uses Tailwind defaults with system fonts.

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

Import `tscircuit/b123-fiber` into Vercel with the **repository root** as the
project root. The root `vercel.json` configures:

- Install: `npm ci`
- Build: `npm run sandbox:build`
- Output: `sandbox/dist`

The production build is static. The checked-in native geometry makes deployment
independent of a Python service on Vercel. To deploy from an authenticated CLI:

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
