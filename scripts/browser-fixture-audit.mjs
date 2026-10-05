#!/usr/bin/env node
/** Run every existing plan through actual local OCCT WASM, never saved meshes. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const destination = resolve(root, 'artifacts/browser-geometry')
await mkdir(destination, { recursive: true })
const entry = resolve(destination, 'fixtures.mjs')
await build({ stdin: { contents: "export { NativeClient } from './lib/client'; export { visualFixtures } from './examples/gallery/fixtures';", resolveDir: root, loader: 'ts' }, outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { NativeClient, visualFixtures } = await import(pathToFileURL(entry).href)
const require = createRequire(import.meta.url)
const client = new NativeClient({ wasmUrl: require.resolve('replicad-opencascadejs/wasm'), fontUrl: resolve(root, 'assets/fonts/DejaVuSans.ttf') })
await client.ready
const sum = (result, property) => result.meshes.reduce((total, mesh) => total + mesh[property], 0)
const close = (actual, expected, absolute = 0.001) => Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * 1e-6)
const regression = JSON.parse(await readFile(resolve(root, 'tests/browser-geometry-baseline.json'), 'utf8'))
assert.deepEqual(Object.keys(regression.fixtures).sort(), visualFixtures.map(fixture => fixture.id).sort(), 'Every fixture has a reviewed browser regression metric')
const report = { fixtureCount: visualFixtures.length, engine: '', supported: 0, equivalent: 0, nativeChanged: 0, regressions: 0, failed: 0, fixtures: [] }
for (const fixture of visualFixtures) {
  const entry = { id: fixture.id, status: 'failed', differences: [], regressionDifferences: [] }
  try {
    const original = JSON.parse(await readFile(resolve(root, `sandbox/public/models/${fixture.id}.json`), 'utf8'))
    const result = await client.render(fixture.plan, { tolerance: 0.12, angularTolerance: 0.15 })
    report.engine = result.kernel
    assert.match(result.kernel, /OpenCascade.*(?:WebAssembly|WASM)/i)
    assert(result.bounds, 'Result has finite BRep bounds')
    assert([...result.bounds.min, ...result.bounds.max].every(Number.isFinite), 'Bounds are finite')
    assert(result.meshes.length >= (fixture.expected.minMeshes ?? 1), 'Expected shape count')
    for (const mesh of result.meshes) {
      assert.equal(mesh.valid, true, 'OCCT BRep validity')
      assert(mesh.positions.every(Number.isFinite), 'Finite tessellated positions')
      assert(mesh.normals.every(Number.isFinite), 'Finite tessellated normals')
      assert(mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3), 'Triangle indices reference vertices')
      assert(mesh.edges.flat().every(Number.isFinite), 'Finite BRep edge samples')
    }
    const volume = sum(result, 'volume'), area = sum(result, 'area')
    if (fixture.expected.dimension === 3) assert(volume > 0 && result.meshes.some(mesh => mesh.indices.length > 0), 'Solid volume and rendered surfaces')
    if (fixture.expected.dimension === 2) assert(area > 0 && result.meshes.some(mesh => mesh.indices.length > 0), 'Face area and rendered surfaces')
    if (fixture.expected.dimension === 1) assert(result.meshes.some(mesh => mesh.edges.some(edge => edge.length >= 6)), 'Curve edge topology')
    if (fixture.expected.dimension === 0) assert(result.meshes.some(mesh => (mesh.vertices?.length ?? 0) >= 3), 'Point topology')
    if (fixture.expected.volume !== undefined) assert(close(volume, fixture.expected.volume), 'Independent analytic volume')
    report.supported++
    entry.actual = { bounds: result.bounds, meshes: result.meshes.length, volume, area, triangles: result.meshes.reduce((total, mesh) => total + mesh.indices.length / 3, 0) }
    entry.expected = { bounds: original.bounds, meshes: original.meshes.length, volume: sum(original, 'volume'), area: sum(original, 'area') }
    for (const property of ['volume', 'area']) if (!close(entry.actual[property], entry.expected[property])) entry.differences.push(`${property}: ${entry.actual[property]} vs native ${entry.expected[property]}`)
    for (const side of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
      if (!close(result.bounds[side][axis], original.bounds[side][axis])) entry.differences.push(`bounds.${side}[${axis}]: ${result.bounds[side][axis]} vs native ${original.bounds[side][axis]}`)
    }
    if (entry.actual.meshes !== entry.expected.meshes) entry.differences.push(`meshes: ${entry.actual.meshes} vs native ${entry.expected.meshes}`)
    entry.status = entry.differences.length === 0 ? 'equivalent' : 'changed'
    if (entry.status === 'equivalent') report.equivalent++
    else report.nativeChanged++
    const browserExpected = regression.fixtures[fixture.id]
    for (const property of ['volume', 'area']) if (!close(entry.actual[property], browserExpected[property])) entry.regressionDifferences.push(property + ': ' + entry.actual[property] + ' vs reviewed browser ' + browserExpected[property])
    for (const side of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
      if (!close(result.bounds[side][axis], browserExpected.bounds[side][axis])) entry.regressionDifferences.push('bounds.' + side + '[' + axis + ']: ' + result.bounds[side][axis] + ' vs reviewed browser ' + browserExpected.bounds[side][axis])
    }
    for (const property of ['meshes', 'triangles']) if (entry.actual[property] !== browserExpected[property]) entry.regressionDifferences.push(property + ': ' + entry.actual[property] + ' vs reviewed browser ' + browserExpected[property])
    if (entry.regressionDifferences.length) report.regressions++
    await writeFile(resolve(destination, `${fixture.id}.json`), `${JSON.stringify(result)}\n`)
  } catch (error) { entry.error = error instanceof Error ? error.message : String(error) }
  if (entry.status === 'failed' || entry.regressionDifferences.length) report.failed++
  report.fixtures.push(entry)
  console.log(`${fixture.id}: ${entry.status}${entry.error ? ` (${entry.error})` : ''}${entry.differences.length ? ` (${entry.differences.join('; ')})` : ''}${entry.regressionDifferences.length ? ` REGRESSION (${entry.regressionDifferences.join('; ')})` : ''}`)
}
await client.releaseAll()
report.passed = report.failed === 0
await writeFile(resolve(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`Actual OCCT WASM: ${report.supported}/${report.fixtureCount} rendered; ${report.equivalent}/${report.fixtureCount} match native BRep metrics; ${report.nativeChanged} explicit native deltas; ${report.regressions} browser metric regressions`)
if (process.argv.includes('--write-review')) {
  await mkdir(resolve(root, 'docs/browser-migration'), { recursive: true })
  await writeFile(resolve(root, 'docs/browser-migration/geometry-summary.json'), `${JSON.stringify(report, null, 2)}\n`)
}
if (!report.passed && !process.argv.includes('--report-only')) process.exitCode = 1
