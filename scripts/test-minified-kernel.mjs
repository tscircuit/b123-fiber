#!/usr/bin/env node
/** Execute actual OCCT after bundling/minifying Replicad, not an unminified dependency. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts/minified-kernel')
await mkdir(output, { recursive: true })
const entry = resolve(output, 'kernel.mjs')
await build({
  stdin: {
    contents: "export { NativeClient } from './lib/client'; import { Solid, Face, Wire } from 'replicad'; export const constructorNames = { Solid: Solid.name, Face: Face.name, Wire: Wire.name };",
    resolveDir: root, loader: 'ts',
  },
  outfile: entry, bundle: true, minify: true, platform: 'node', format: 'esm',
  // Replicad must be bundled here: its minified class names triggered the bug.
  external: ['replicad-opencascadejs'],
})
const { NativeClient, constructorNames } = await import(pathToFileURL(entry).href)
assert.notEqual(constructorNames.Solid, 'Solid', 'This regression test must rename Replicad classes')
assert.notEqual(constructorNames.Face, 'Face', 'Face classification must be tested after minification')
const require = createRequire(import.meta.url)
const client = new NativeClient({
  wasmUrl: require.resolve('replicad-opencascadejs/wasm'),
  fontUrl: resolve(root, 'assets/fonts/DejaVuSans.ttf'),
})
await client.ready
const catalog = JSON.parse(await readFile(resolve(root, 'sandbox/src/catalog.json'), 'utf8'))
const report = { constructorNames, checks: [] }
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-6, `Expected ${expected}, received ${actual}`)

try {
  // These independent formulas catch sketches being collected instead of cut,
  // and translated hole tools being added instead of subtracted from the body.
  for (const [id, expected] of [
    ['compositional-extrude', Math.PI * (10 ** 2 - 6 ** 2) * 8],
    ['counterbore', 24 * 18 * 10 - Math.PI * 3 ** 2 * 10 - Math.PI * (6 ** 2 - 3 ** 2) * 3],
  ]) {
    const plan = catalog.find(example => example.id === id).plan
    // Repeat in one persistent instance, matching the sandbox worker's lifetime.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.render(plan)
      assert.equal(result.meshes.length, 1, `${id}: one combined BRep`)
      assert(result.meshes.every(mesh => mesh.valid), `${id}: actual OCCT validity`)
      close(result.meshes.reduce((sum, mesh) => sum + mesh.volume, 0), expected)
    }
    report.checks.push(`${id}: valid combined BRep and independent analytic volume`)
  }

  const box = await client.callStatic('Solid', 'make_box', [2, 3, 4])
  assert.equal(box.kind, 'Solid', 'Public handle kind must use OCCT topology, not the minified class name')
  const solids = await box.call('solids')
  assert.equal(await solids.length(), 1, 'A solid selects itself after class names are renamed')
  close(await box.get('volume'), 24)
  report.checks.push('Stable Solid handle kind, self-selection, and native volume')

  const step = await client.exportFile(box, 'step')
  const imported = await client.importFile(step, { filename: 'minified.step' })
  const values = Array.isArray(imported.value) ? imported.value : [imported.value]
  assert(values.every(value => ['Compound', 'CompSolid', 'Solid', 'Shell', 'Face'].includes(value.kind)), 'Imported handle kinds must remain public topology names')
  assert(imported.result.meshes.every(mesh => mesh.valid), 'Minified STEP round trip retains native validity')
  close(imported.result.meshes.reduce((sum, mesh) => sum + mesh.volume, 0), 24)
  report.checks.push('STEP export/import preserves native geometry and stable public handle kinds')
} finally { await client.releaseAll() }
await writeFile(resolve(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`Minified OpenCascade kernel: ${report.checks.length} geometry/type regression groups passed`)
