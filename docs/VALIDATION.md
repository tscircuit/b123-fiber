# Validation

The implementation targets build123d **0.13.0** with OpenCascade **8**. The
generated inventory resolves all **203 public exports**, including **10,358
public member entries** and all **32 exported enums**. Inventory regeneration is
checked in fresh Python processes with different hash seeds.

The final checks cover:

| Check | Result |
| --- | --- |
| TypeScript type checking and distributable build | Pass |
| TypeScript compiler, React, client and actual HTTP integration tests | 45 tests pass; 29 negative compile cases |
| Native backend, conformance and independent regression tests | 277 tests and 437 subtests pass |
| Chromium geometry and viewer behavior checks | 78 checks pass |
| Visual regression matrix | 73 fixtures × 4 views = 292 screenshots |
| Screenshot comparison | Zero changed pixels against reviewed baselines; zero browser errors |
| Static sandbox catalog and responsive layout | 73 models and 86 screenshots pass |
| Editable sandbox, worker isolation and browser CAD transfer | 15 browser checks pass |
| npm package contents | Verified source, declarations, native service and documentation |
| CDN browser module | Shared React hooks and context, native volume 24 → 60, visible geometry; zero browser errors |
| Installed release tarball | JavaScript exports load; locked native kernel imports successfully |

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

The dedicated CDN browser module is checked in Chromium using the actual pinned
React module from jscdn. Both the CAD reconciler and ReactDOM update hook state;
context changes a native box from 24 to 60 mm³, and the viewer displays its mesh.
This check verifies visible pixels and saves before/after screenshots in
`artifacts/cdn/`; it adds no screenshot baseline to the 292-image matrix.

Visual fixtures include curves, sketches, primitives and sectors, booleans,
extrusions, tapered extrusions, lofts, revolve, sweep, fillets, chamfers, hole
patterns, text, transformed assemblies, a motor spacer and a 19-part electronics
assembly. Advanced fixtures add airfoils, constrained curves, technical drawings,
dimensions, draft, full round, sheet metal, projection, packing, native assemblies
and nested section operations. Every fixture is captured in isometric, top,
front and right views.
The [contact sheet](visual-baseline.png) shows actual browser captures; the
[baseline manifest](../tests/visual/baselines/manifest.json) records the complete
matrix and environment.

Baselines use Playwright **1.63.0**, Chromium **153.0.8010.12** revision **1243**,
SwiftShader, DejaVu Sans, and a **760 × 640** canvas at device scale 1. The
comparison threshold and permitted changed pixel count are both zero. Run
`npm run test:visual` to recreate reports and four labeled contact sheets in
`artifacts/visual/`. Browser versions, fonts or graphics settings can change
pixels, so use the locked browser for regression comparisons.

The visual runner registers the bundled DejaVu Sans font directly with OCCT
before starting its isolated kernel. Native drawing text's default Arial alias
resolves to that same file. Host-installed fonts therefore cannot change the
tested glyph geometry; the baseline manifest records the font's SHA-256.

The 0.2.0 camera correction required reviewing 18 existing front-view baselines.
Removing the previous Y-up spherical pole clamp changed 549 comparison pixels
in total, at most 201 of 486,400 pixels in one image. The other 274 images were
unchanged. Side-by-side camera comparisons confirmed that geometry was preserved.

Coverage of the API dispatch mechanism is broader than semantic test coverage.
These checks do not exercise every overload or every possible argument
combination. The pinned native API's restrictions and behavior are preserved;
unreleased development-branch additions and arbitrary JavaScript/Python code
are outside the compatibility surface. See [API usage](API.md) and the
[conformance notes](../tests/conformance/README.md), and the
[support matrix](COMPATIBILITY.md).
