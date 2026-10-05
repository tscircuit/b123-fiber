# Browser migration validation

Validation runs with Node.js, OpenCascade WASM and Chromium. It does not start a
geometry service or execute Python. The original native API inventory and visual
baselines remain the reference for comparison.

```sh
npm ci
npm run check:api
npm run typecheck
npm test
npm run test:browser:fixtures
npm run build
npm run test:kernel:minified
PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium
npm run test:visual -- --browser-baselines --report-only
npm run test:cdn
npm run sandbox:build
npm run test:sandbox
npm run test:sandbox:editor
```

The WASM geometry audit executes every one of the **73 existing plans**. It checks
finite geometry, native BRep validity, topology, independent analytic volumes,
and strict browser regression measurements. It also reports volume, area, bounds
and mesh-count differences against the historical native outputs. The measured
results are checked into [the migration review](browser-migration/README.md).

The visual suite captures all **292 engineering views** and creates exact
native/browser/difference triptychs. Historical screenshot assertions retain a
zero-pixel threshold. Migration report mode permits reviewed native differences,
while separate browser baselines enforce zero-pixel regression checks. Review
`artifacts/visual/comparison/index.html` and the Playwright report; CI uploads
these artifacts for each PR run.

Additional tests cover value algebra and coordinate handedness, selectors and
callbacks, OpenCascade ownership and retained-handle lifetime, repeated CAD file
exports/imports, compound metadata, nested placement and boolean semantics,
error recovery, React state changes and compiler type errors. Browser checks
verify local WASM execution without CAD HTTP requests, CDN hooks, changed volume
after editing, import/download workflows, cancellation and cursor controls.
The minified-kernel test bundles and renames Replicad's classes, then checks
boolean volumes, stable topology handles and STEP round trips against actual
WASM. This protects behavior in production builds as well as development.

Tests provide evidence for the exercised behavior. They do not establish parity
for every inherited build123d method or every argument combination. Unsupported
features are recorded in [compatibility](COMPATIBILITY.md).
