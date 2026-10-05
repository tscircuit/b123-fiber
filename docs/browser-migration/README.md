# Browser kernel comparison

The 73 existing examples now execute with OpenCascade WebAssembly. The original 292 native screenshots and saved model assets remain unchanged for this PR's comparisons.

- [All isometric comparisons](isometric-comparison.png): native reference, browser result, exact pixel difference.
- [Representative comparisons](representative-comparison.png): box, sphere, sweep, fillet, text, and technical drawing at a larger scale.
- [Screenshot summary](snapshot-summary.json): all four views of every example, SHA-256 hashes, and exact changed pixel counts.
- [Geometry summary](geometry-summary.json): live BRep validity, bounds, area, volume, shape counts, and differences from the saved native models.
- [API support report](api-support.json): available entry points and explicitly unsupported roots. Registered bindings still have partial method and overload coverage.

The native comparison has **114 exact matches, 178 changed images, and no missing images**. Surface tessellation and shading changes remain visible in the review images. No native screenshot was replaced.

All 73 examples produce valid geometry. Their bounds and shape counts match the saved native assets; 67 also match area and volume within the existing metric tolerance. Six recorded metric differences involve text/drawing examples and the spline sweep. These are differences from saved assets, rather than proof that freshly computed native geometry differs.

The runtime recognizes **197 of 203 root entries**. The six unavailable roots are the two type aliases `RotationLike` and `VectorLike`, the abstract `Export2D` base, and `detect_primitives`, `import_svg_as_buildline_code`, and `export_to_pcbway`. Method and overload coverage remains partial even for registered roots; [compatibility](../COMPATIBILITY.md) lists those limits.

The browser has its own 292 screenshot baselines in `tests/visual/browser-baselines` and 73 metric baselines in `tests/browser-geometry-baseline.json`. Reproduction requires **zero changed screenshot pixels**. The fixture audit also checks independent analytic volumes and native topology invariants. Baseline files are never updated by the test commands.

```sh
npm run test:browser:fixtures
npm run test:kernel:minified
npm run test:visual -- --browser-baselines --report-only
npm run sandbox:build
npm run test:sandbox
npm run test:sandbox:editor
npm run test:cdn
```

`--report-only` records differences against the historical native screenshots; `--browser-baselines` still enforces the browser's zero-pixel regression assertions. Full-resolution comparisons and failure details are written to `artifacts/visual/comparison` and uploaded by CI.
