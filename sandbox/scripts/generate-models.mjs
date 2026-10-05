#!/usr/bin/env node
/**
 * Generate gallery assets with local OpenCascade WASM. Requires only npm ci.
 * Existing /models native assets remain immutable migration comparisons.
 * New output: sandbox/public/browser-models and src/browser-catalog.json.
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const sandbox = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(sandbox, '..')
const tolerance = 0.12
const angularTolerance = 0.15
const compiled = await build({
  entryPoints: [join(repository, 'examples/gallery/fixtures.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const { visualFixtures } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`)

// React refs belong to the reconciler. Native captures use `id` in runnable JSX.
const normalizeNode = ({ type, props, children }) => ({
  type,
  props: Object.fromEntries(Object.entries(props).map(([key, value]) => [key === 'ref' ? 'id' : key, value])),
  children: children.map(normalizeNode),
})
const fixtures = visualFixtures.map(fixture => ({
  ...fixture, plan: { version: 1, children: fixture.plan.children.map(normalizeNode) },
}))

const runtimeEntry = join(repository, 'artifacts/browser-model-generator.mjs')
await mkdir(dirname(runtimeEntry), { recursive: true })
await build({ stdin: { contents: "export { NativeClient } from './lib/client';", resolveDir: repository, loader: 'ts' }, outfile: runtimeEntry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { NativeClient } = await import(pathToFileURL(runtimeEntry).href)
const require = createRequire(import.meta.url)
const client = new NativeClient({ wasmUrl: require.resolve('replicad-opencascadejs/wasm'), fontUrl: join(repository, 'assets/fonts/DejaVuSans.ttf') })
await client.ready
const nativeResults = new Map()
for (const fixture of fixtures) {
  nativeResults.set(fixture.id, await client.render(fixture.plan, { tolerance, angularTolerance }))
}
await client.releaseAll()

const descriptions = {
  vertex: 'A single native vertex, rendered as point topology.',
  box: 'A centered rectangular solid with exact planar faces.',
  cylinder: 'A cylindrical solid with circular caps and a continuous side.',
  cone: 'A tapered cone between two circular radii.',
  sphere: 'A smooth sphere tessellated directly by OpenCascade.',
  torus: 'A ring-shaped solid with a circular tube profile.',
  wedge: 'A wedge bounded by a combination of sloped and planar faces.',
  'sector-cylinder': 'A partial cylinder with a 210° sweep.',
  'sector-torus': 'A torus with an open 240° sweep.',
  hemisphere: 'Half a sphere with a flat equatorial face.',
  'rotated-box': 'A box rotated around its local Euler axes.',
  circle: 'A circular sketch face on the XY workplane.',
  ellipse: 'An elliptical sketch face with independent axis radii.',
  rectangle: 'A centered rectangular sketch face.',
  'rounded-rectangle': 'A rectangular profile with rounded corners.',
  polygon: 'An irregular polygon created from an ordered point list.',
  hexagon: 'A regular six-sided profile.',
  octagon: 'A rotated regular eight-sided profile.',
  trapezoid: 'A trapezoid with independently controlled side angles.',
  'slot-center-to-center': 'A slot described by its end-center separation.',
  'slot-overall': 'A rounded slot described by its overall length.',
  'slot-center-point': 'A slot positioned from its center and a reference point.',
  text: 'Text converted into real sketch faces using DejaVu Sans.',
  line: 'A straight edge connecting two points in 3D space.',
  polyline: 'An open chain of straight segments.',
  'closed-polyline': 'A closed wire built from connected straight segments.',
  spline: 'An interpolating smooth curve through four points.',
  bezier: 'A cubic Bézier curve defined by four control points.',
  'center-arc': 'A circular arc defined by its center and sweep angle.',
  'radius-arc': 'A circular arc defined by its endpoints and radius.',
  'three-point-arc': 'An arc that passes through three supplied points.',
  'sagitta-arc': 'An arc specified by its chord endpoints and sagitta.',
  'polar-line': 'A line described by its start, length, and angle.',
  helix: 'A 3D helical edge with fixed pitch and radius.',
  'compositional-extrude': 'An extrusion whose nested sketch produces an annular solid.',
  'compositional-fillet': 'A fillet operation applied to the edges of a nested box.',
  'extrude-circle': 'A circular sketch extruded into a solid.',
  'extrude-taper': 'A hexagonal sketch extruded with a 10° draft.',
  'extrude-both': 'A slot extruded equally in both directions.',
  'extrude-ring': 'Two sketch circles combined into a hollow extrusion.',
  revolve: 'An asymmetric profile revolved around the Z axis.',
  'revolve-partial': 'A rectangular profile revolved through 240°.',
  loft: 'A smooth transition from a circle to a rectangle.',
  'loft-ruled': 'A ruled loft between two rotated hexagons.',
  sweep: 'A circular profile swept along a captured 3D spline.',
  fillet: 'A box with all twelve edges smoothly rounded.',
  chamfer: 'A box with planar bevels applied to every edge.',
  union: 'A box and cylinder combined using a native solid union.',
  subtract: 'A cylindrical through-hole cut from a rectangular block.',
  intersect: 'The shared volume of a sphere and a box.',
  'grid-locations': 'Six identical bosses positioned in a rectangular grid.',
  'polar-locations': 'Six bosses distributed around a circular pattern.',
  counterbore: 'A drilled hole with a wider, flat-bottomed recess.',
  countersink: 'A drilled hole with a conical entry recess.',
  'text-extrude': 'Native glyph faces extruded into raised lettering.',
  'motor-spacer': 'A mounting plate with a center opening and four drilled posts.',
  electronics: 'A 19-part PCB assembly with a controller, connector, and pin headers.',
  transforms: 'A colored assembly positioned with translation and rotation wrappers.',
}
const wrappers = new Set(['Union', 'Subtract', 'Intersect', 'Translate', 'Rotate', 'Group', 'Shape', 'Call'])
const collectTypes = nodes => nodes.flatMap(node => [node.type, ...collectTypes(node.children)])
const valueSource = value => {
  if (Array.isArray(value)) return `[${value.map(valueSource).join(', ')}]`
  if (value && typeof value === 'object') {
    if (value.$enum) return `b.${value.$enum}`
    if (value.$type && value.path) return `b.${value.$type}.${value.path}`
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${valueSource(item)}`).join(', ')} }`
  }
  return JSON.stringify(value)
}
const jsxNode = (node, depth = 2) => {
  const indent = '  '.repeat(depth)
  const type = wrappers.has(node.type) ? node.type : `b.${node.type}`
  // Wire-value objects are valid JSX props and preserve native selectors exactly.
  const props = Object.entries(node.props).map(([key, value]) => `${key}={${valueSource(value)}}`)
  const oneLine = `${indent}<${type}${props.length ? ` ${props.join(' ')}` : ''}`
  const start = oneLine.length < 125 ? oneLine : `${indent}<${type}\n${props.map(prop => `${indent}  ${prop}`).join('\n')}\n${indent}`
  if (!node.children.length) return `${start} />`
  return `${start}>\n${node.children.map(child => jsxNode(child, depth + 1)).join('\n')}\n${indent}</${type}>`
}
const sourceFor = fixture => {
  const extras = [...new Set(collectTypes(fixture.plan.children).filter(type => wrappers.has(type)))].sort()
  const imports = ['b', ...extras].join(', ')
  const single = fixture.plan.children.length === 1
  const nodes = fixture.plan.children.map(node => jsxNode(node, single ? 2 : 3)).join('\n')
  return `import { ${imports} } from '@tscircuit/b123-fiber'\n\nexport default function Example() {\n  return (\n${single ? nodes : `    <>\n${nodes}\n    </>`}\n  )\n}\n`
}

const quantize = number => Number(number.toFixed(6))
const finite = numbers => Array.isArray(numbers) && numbers.every(Number.isFinite)
const outputFlag = process.argv.indexOf('--output')
const catalogFlag = process.argv.indexOf('--catalog')
const modelDirectory = outputFlag === -1 ? join(sandbox, 'public/browser-models') : resolve(process.argv[outputFlag + 1])
const catalogFile = catalogFlag === -1 ? join(sandbox, 'src/browser-catalog.json') : resolve(process.argv[catalogFlag + 1])
if (modelDirectory === join(sandbox, 'public/models')) throw new Error('Existing native models are immutable migration references; choose a distinct browser output directory.')
const thumbnailDirectory = join(sandbox, 'public/thumbnails')
await Promise.all([mkdir(modelDirectory, { recursive: true }), mkdir(thumbnailDirectory, { recursive: true }), mkdir(join(sandbox, 'src'), { recursive: true })])
const catalog = []
for (const fixture of fixtures) {
  const result = nativeResults.get(fixture.id)
  if (!result || !/OpenCascade|OCCT/.test(result.kernel)) throw new Error(`Unexpected native kernel for ${fixture.id}`)
  if (!result.bounds || !finite(result.bounds.min) || !finite(result.bounds.max)) throw new Error(`Missing bounds for ${fixture.id}`)
  if (result.meshes.length < (fixture.expected.minMeshes ?? 1)) throw new Error(`Missing meshes for ${fixture.id}`)
  for (const mesh of result.meshes) {
    if (!mesh.valid || !finite(mesh.positions) || !finite(mesh.normals) || !mesh.edges.every(finite)) throw new Error(`Invalid native mesh for ${fixture.id}`)
    if (mesh.indices.some(index => !Number.isInteger(index) || index < 0 || index >= mesh.positions.length / 3)) throw new Error(`Invalid triangle index for ${fixture.id}`)
  }
  const stats = {
    dimension: fixture.expected.dimension,
    volume: result.meshes.reduce((sum, mesh) => sum + mesh.volume, 0),
    area: result.meshes.reduce((sum, mesh) => sum + mesh.area, 0),
    meshCount: result.meshes.length,
    triangles: result.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    valid: result.meshes.every(mesh => mesh.valid),
  }
  if (fixture.expected.dimension === 3 && (!stats.triangles || stats.volume <= 0)) throw new Error(`Empty native solid for ${fixture.id}`)
  if (fixture.expected.dimension === 2 && stats.area <= 0) throw new Error(`Empty native sketch for ${fixture.id}`)
  if (fixture.expected.dimension === 1 && !result.meshes.some(mesh => mesh.edges.some(edge => edge.length >= 6))) throw new Error(`Empty native curve for ${fixture.id}`)
  if (fixture.expected.dimension === 0 && !result.meshes.some(mesh => mesh.vertices.length >= 3)) throw new Error(`Empty native point for ${fixture.id}`)
  if (fixture.expected.volume !== undefined && Math.abs(stats.volume - fixture.expected.volume) > Math.max(0.001, fixture.expected.volume * 1e-8)) throw new Error(`Incorrect native volume for ${fixture.id}`)

  // Coordinate quantization saves network bytes; error is <= 0.0000005 mm.
  const model = {
    ...result,
    bounds: { min: result.bounds.min.map(quantize), max: result.bounds.max.map(quantize) },
    meshes: result.meshes.map(mesh => ({
      ...mesh, positions: mesh.positions.map(quantize), normals: mesh.normals.map(quantize),
      edges: mesh.edges.map(edge => edge.map(quantize)), vertices: mesh.vertices?.map(quantize),
    })),
  }
  await writeFile(join(modelDirectory, `${fixture.id}.json`), `${JSON.stringify(model)}\n`)
  // These are the existing reviewed Chromium/OpenCascade regression screenshots.
  await copyFile(join(repository, 'tests/visual/baselines', `${fixture.id}-iso.png`), join(thumbnailDirectory, `${fixture.id}.png`))
  catalog.push({
    id: fixture.id, title: fixture.title, category: fixture.category,
    description: descriptions[fixture.id] ?? `Native ${fixture.title} CAD example.`,
    modelUrl: `/browser-models/${fixture.id}.json`, thumbnailUrl: `/thumbnails/${fixture.id}.png`,
    source: sourceFor(fixture), plan: fixture.plan, stats,
  })
}
await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`)
const manifest = {
  kernel: nativeResults.values().next().value.kernel,
  generator: 'sandbox/scripts/generate-models.mjs',
  tolerance, angularTolerance, coordinatePrecision: 0.000001,
  fixtureCount: catalog.length,
  thumbnails: 'Reviewed isometric screenshots from tests/visual/baselines',
  models: catalog.map(({ id, stats }) => ({ id, ...stats })),
}
await writeFile(join(modelDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Generated ${catalog.length} browser OpenCascade examples, ${catalog.reduce((sum, fixture) => sum + fixture.stats.meshCount, 0)} meshes, and ${catalog.reduce((sum, fixture) => sum + fixture.stats.triangles, 0).toLocaleString()} triangles.`)
