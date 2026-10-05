# b123-fiber

Build CAD models with React and a build123d-compatible TypeScript API. JSX becomes
a serializable plan, OpenCascade WebAssembly constructs and tessellates the
geometry locally, and Three.js displays the result. This follows the component
and headless-plan approach of
[jscad-fiber](https://github.com/tscircuit/jscad-fiber).

This branch contains the **0.3.0 browser-kernel migration**. The previously
published 0.2.0 release uses the earlier Python service; 0.3.0 becomes available
after this PR is merged and published. The browser implementation requires no
Python runtime or CAD backend. Dimensions use millimeters, angles use degrees,
and argument names retain build123d's `snake_case` spelling.

## Run the project

Development requires Node.js 24+:

```sh
npm ci
npm run sandbox:dev
```

The sandbox provides editable JSX and parameters, CAD imports/downloads, and an
interactive 3D preview. Selecting an example constructs its geometry in the browser. Press
**Run** to rebuild edited source with OpenCascade. Compilation runs in a
disposable worker, and CAD runs in a separate persistent worker. See the
[sandbox guide](sandbox/README.md) and [compatibility matrix](docs/COMPATIBILITY.md).

```sh
npm run sandbox:build
npm run test:sandbox
npm run test:sandbox:editor
```

## Model with React

```tsx
import {
  Build123dView, BuildPart, Box, Cylinder, Mode,
} from '@tscircuit/b123-fiber'

export function Mount() {
  return <Build123dView>
    <BuildPart>
      <Box length={20} width={12} height={6} />
      <Cylinder radius={3} height={8} mode={Mode.SUBTRACT} />
    </BuildPart>
  </Build123dView>
}
```

Builders evaluate children in order. The `build123d` (or `b`) namespace uses
upstream symbol spelling, including `b.Box`, `b.BuildSketch`, and `b.extrude`.
PascalCase operation aliases such as `Extrude` and `Fillet` are also available.
The live renderer supports React hooks, context, state, refs, effects, and keyed
updates. The static compiler accepts synchronous components without hooks.

Compile and execute without a viewer:

```tsx
import { Box, renderToBuild123dPlan } from '@tscircuit/b123-fiber/headless'
import { NativeClient } from '@tscircuit/b123-fiber/client'

const plan = renderToBuild123dPlan(<Box length={20} width={12} height={6} />)
const client = new NativeClient()
const result = await client.render(plan)
console.log(result.meshes[0].volume) // 1440 mm³
```

`NativeClient` retains its name for API compatibility; its methods execute
in-process. `createBuild123dRoot()` mounts components that need state or effects.
Its `render()` and `getPlan()` return serializable plans, `subscribe()` observes
commits, and `unmount()` runs component cleanup.

## OpenCascade loading

The npm package includes **`dist/opencascade.wasm`** and an outline font. The
JavaScript loader initializes OpenCascade asynchronously when geometry is first
requested; `await client.ready` can preload it. Geometry operations then execute
locally. Loading these static assets is the only required network activity.

Bundlers can emit the dependency's WASM and this package's font as assets. The
sandbox does this with Vite `?url` imports. Supply `wasmUrl` and `fontUrl` when
hosting those assets elsewhere:

```ts
const client = new NativeClient({
  wasmUrl: '/assets/opencascade.wasm',
  fontUrl: '/assets/DejaVuSans.ttf',
})
```

`wasmBinary` and `fontBinary` accept already-loaded bytes. `openCascade` accepts
an initialized compatible OpenCascade.js instance. A viewer can share a client
through `<Build123dView client={client}>` or a kernel through its `kernel` prop.
The default packaged loader resolves assets beside its JavaScript module; static
hosts must serve those files too. No backend URL, authentication token, or HTTP
geometry transport is configured.

## API compatibility

Generated TypeScript bindings retain build123d 0.13.0's **203 root exports** and
its inspected constructor, method, property, and overload signatures. Runtime
bindings are implemented in TypeScript over OpenCascade.js and Replicad. The
symbol inventory is an API reference, not a claim of complete Python behavioral
parity: `await client.inventory()` reports supported and unsupported root
symbols, and unimplemented operations throw explicit errors.

Native-style handles provide methods, properties, indexing, explicit algebra,
and lifetime management. JavaScript does not overload arithmetic or implement
Python context managers; JSX builders and `.operator(...)` provide those
workflows. [API usage](docs/API.md) explains expressions and typed bindings;
[file APIs](docs/FILE-TRANSPORT.md) explain local virtual files and streams.
The [compatibility matrix](docs/COMPATIBILITY.md) describes the implemented
behavior and remaining differences.

## Packaging and CDN

Releases use GitHub Packages and
[jscdn](https://jscdn.tscircuit.com). After 0.3.0 is published:

```sh
npm install https://jscdn.tscircuit.com/@tscircuit/b123-fiber/0.3.0.tgz
```

The `dist/cdn.js` entry bundles Three.js, ReactDOM, and the CAD reconciler with
one pinned React module. Import `React` and `createDOMRoot` from that entry so
hooks share the same React instance. The normal package entrypoints use the
application's React and Three.js peer dependencies. The WASM/font files must
remain accessible beside the CDN JavaScript. See [publishing](docs/PUBLISHING.md).

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run test:kernel:minified
npm run test:browser:fixtures
npm run test:visual -- --browser-baselines --report-only
npm run test:cdn
```

Visual tests construct actual WASM geometry, inspect mesh data, and render
isometric, top, front, and right views in Chromium. Historical native snapshots
remain available for PR comparisons. Reports and screenshots go to `artifacts/`.
See the [validation report](docs/VALIDATION.md). Install the browser with
`PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium`.

## Architecture and licenses

The [architecture](ARCHITECTURE.md) describes plans, local bindings, mesh data,
and worker boundaries. `headless` compiles without loading Three.js or the
modeling kernel; `client` exposes local CAD operations; `three` provides mesh and
camera helpers; the main entrypoint exports `Build123dView`.

The TypeScript renderer is MIT licensed. Replicad, OpenCascade.js, OpenCascade,
and the bundled font retain their upstream licenses, included with distributed
assets where required.
