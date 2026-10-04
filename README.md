# build123d-fiber

Build precise CAD models with React and build123d. JSX is compiled to a serializable
plan, executed by **build123d 0.13.0 and OpenCascade 8**, then displayed in a Three.js
viewer. This follows the component and headless-plan approach of
[jscad-fiber](https://github.com/tscircuit/jscad-fiber).

The geometry service uses native Python build123d. It is required for geometry
execution; the browser displays its tessellations. This package does not ship a
browser WASM port of build123d. Dimensions use build123d units (millimeters by
default), angles use degrees, and keyword names retain Python's `snake_case`.

## Run the project

Requires Node.js 22+ and Python 3.11–3.14. [uv](https://docs.astral.sh/uv/) is used
below; a standard Python virtual environment also works.

```sh
npm ci
uv sync --extra test --frozen
npm run kernel
```

In another terminal, start the interactive example gallery:

```sh
npm run dev
```

The kernel listens at `http://127.0.0.1:8765`. The Vite terminal prints the gallery
URL. Keep the kernel on a trusted local machine; file import/export functions act
with the kernel process's filesystem permissions.

## Model with React

```tsx
import {
  Build123dView, BuildPart, Box, Cylinder, Fillet, Mode, Axis, native, expr,
} from 'build123d-fiber'

export function Mount() {
  return <Build123dView>
    <BuildPart>
      <Box length={20} width={12} height={6} />
      <Fillet radius={1} objects={expr.method(native.edges(), 'filter_by', [Axis.Z])} />
      <Cylinder radius={3} height={8} mode={Mode.SUBTRACT} />
    </BuildPart>
  </Build123dView>
}
```

Builders execute children in order inside the real native context. The `build123d`
(or `b`) namespace exposes every renderable symbol with its exact native spelling:
`b.Box`, `b.BuildSketch`, `b.extrude`, and so on. Named PascalCase operation aliases
such as `Extrude` and `Fillet` are available too. Function components, fragments,
arrays and conditional children work; the live renderer also supports hooks,
context, state, refs, effects and keyed updates.

Compile and execute without a viewer:

```tsx
import { Box, renderToBuild123dPlan } from 'build123d-fiber/headless'
import { NativeClient } from 'build123d-fiber/client'

const plan = renderToBuild123dPlan(<Box length={20} width={12} height={6} />)
const client = new NativeClient()
const result = await client.render(plan)
console.log(result.meshes[0].volume) // 1440 mm³
```

The static compiler requires synchronous components without hooks. Use
`createBuild123dRoot()` to mount components that need React state or effects.
Its `render()` and `getPlan()` return serializable plans; `subscribe()` observes
commits and `unmount()` runs cleanup.

## API coverage

The native client dispatches every public export of the pinned build123d release,
including geometry and topology classes, builders, objects, operations, selectors,
joints, importers, exporters, and utility functions. Native object handles expose
methods, properties, static/class methods, indexing, and explicit Python algebra
operations. Enums and common geometric values can be serialized in JSX plans.

The generated [API inventory](docs/api-inventory.json) records the exact symbol
surface and native signatures. [API usage](docs/API.md) explains the native client.
JavaScript has no Python context managers or overloaded arithmetic; JSX builders
and explicit native-handle operations provide those behaviors. Abstract base
classes and type aliases retain their native meaning and are not necessarily
constructible CAD objects.

API dispatch coverage is distinct from test coverage: the test suites exercise
representative native behavior and the visual gallery covers a broad range of
geometry; they do not prove every possible argument combination of every method.
Unreleased additions on build123d's development branch are outside the pinned
0.13.0 surface.

## Validation

See the [validation report](docs/VALIDATION.md) and
[visual contact sheet](docs/visual-baseline.png).

```sh
npm run generate:api
npm run typecheck
npm test
npm run test:python
npm run build
npm run test:visual
```

Visual tests execute native CAD fixtures, inspect mesh data, render isometric,
top, front, and right views with Chromium, and compare screenshots against stored
baselines. Generated screenshots and reports are written to `artifacts/`.
To intentionally regenerate baselines after inspecting a geometry or viewer
change, run `npm run test:visual -- --update`.
Install the browser once with
`PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium`.
The lockfile pins Chromium; screenshots use SwiftShader and DejaVu Sans.

## Architecture

`build123d-fiber/headless` compiles synchronous React elements without loading
Three.js or the modeling kernel. The React reconciler supports live component
updates. `build123d-fiber/client` handles native RPC. `build123d-fiber/three`
contains mesh and camera helpers. `Build123dView` is exported from the main
entrypoint. [Architecture and protocol](ARCHITECTURE.md) describe the
plan and mesh formats.

The TypeScript renderer is MIT licensed. build123d and OpenCascade retain their
own upstream licenses.
