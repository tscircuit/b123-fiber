# Validation

The implementation targets build123d **0.13.0** with OpenCascade **8**. The
generated inventory resolves all **203 public exports**, including **10,358
public member entries** and all **32 exported enums**. Inventory regeneration is
checked in fresh Python processes with different hash seeds.

The final checks cover:

| Check | Result |
| --- | --- |
| TypeScript type checking and distributable build | Pass |
| TypeScript compiler, React, client and actual HTTP integration tests | 37 tests pass |
| Native backend, conformance and independent regression tests | 199 tests and 437 subtests pass |
| Chromium geometry and viewer behavior checks | 62 checks pass |
| Visual regression matrix | 58 fixtures × 4 views = 232 screenshots |
| Screenshot comparison | Zero changed pixels; zero browser errors |
| npm package contents | Verified source, declarations, native service and documentation |

The native tests compare volume, area, bounding boxes, validity, topology and
curve results against independently constructed build123d models. They exercise
builders, placement grids, booleans, empty results, fillets, chamfers, lofts,
sweeps, selector callbacks, class methods, mutation, references, all five joint
types, and STEP/BREP/STL/SVG/DXF round trips. HTTP tests check transport,
authentication, concurrent execution and error recovery. The triangle test
checks winding and enclosed mesh volume against the native solid volume.

React tests cover actual hook state, context, effects, cleanup, refs, keyed
updates, removals, error boundaries, and root isolation. The viewer checks
orbiting, resizing, retained state, stale requests, error reporting, bearer
headers and native RGBA transparency. Native colors and labels also survive
tessellation, and explicit JSX metadata takes precedence.

Visual fixtures include curves, sketches, primitives and sectors, booleans,
extrusions, tapered extrusions, lofts, revolve, sweep, fillets, chamfers, hole
patterns, text, transformed assemblies, a motor spacer and a 19-part electronics
assembly. Every fixture is captured in isometric, top, front and right views.
The [contact sheet](visual-baseline.png) shows actual browser captures; the
[baseline manifest](../tests/visual/baselines/manifest.json) records the complete
matrix and environment.

Baselines use Playwright **1.63.0**, Chromium **153.0.8010.12** revision **1243**,
SwiftShader, DejaVu Sans, and a **760 × 640** canvas at device scale 1. The
comparison threshold and permitted changed pixel count are both zero. Run
`npm run test:visual` to recreate reports and four labeled contact sheets in
`artifacts/visual/`. Browser versions, fonts or graphics settings can change
pixels, so use the locked browser for regression comparisons.

Coverage of the API dispatch mechanism is broader than semantic test coverage.
These checks do not exercise every overload or every possible argument
combination. The pinned native API's restrictions and behavior are preserved;
unreleased development-branch additions and arbitrary JavaScript/Python code
are outside the compatibility surface. See [API usage](API.md) and the
[conformance notes](../tests/conformance/README.md).
