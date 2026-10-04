#!/usr/bin/env node
import assert from 'node:assert/strict'
import { checkCadControls } from './check-cad-controls.mjs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'sandbox/dist')
const artifacts = resolve(root, 'artifacts/sandbox')
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.playwright')
const [{ chromium }, { PNG }, { build }] = await Promise.all([
  import('@playwright/test'), import('pngjs'), import('esbuild'),
])
const fixtureBundle = await build({
  entryPoints: [resolve(root, 'examples/gallery/fixtures.ts')],
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const { visualFixtures } = await import(`data:text/javascript;base64,${Buffer.from(fixtureBundle.outputFiles[0].text).toString('base64')}`)
const catalog = JSON.parse(await readFile(resolve(root, 'sandbox/src/catalog.json'), 'utf8'))
assert.equal(catalog.length, 58, 'Sandbox must offer all 58 native examples')
assert.deepEqual(new Set(catalog.map(example => example.id)), new Set(visualFixtures.map(example => example.id)))
await mkdir(artifacts, { recursive: true })

let server
let baseUrl = process.env.SANDBOX_URL
if (!baseUrl) {
  await stat(resolve(dist, 'index.html'))
  const contentTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  }
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!path.startsWith(`${dist}${sep}`)) { response.writeHead(403); response.end(); return }
      const body = await readFile(path)
      response.writeHead(200, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' })
      response.end(body)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
}
baseUrl = baseUrl.replace(/\/$/, '')
const report = { baseUrl, browser: '', modelCount: 0, geometry: [], screenshots: [], browserErrors: [], failedRequests: [], httpErrors: [], interactions: [] }
const screenshots = []
const transport = process.env.SANDBOX_NODE_TRANSPORT === '1'
let browser
let context
let page

function validateGeometry(example, fixture, result) {
  assert.match(result.kernel, /build123d|OpenCascade|OCCT/i, `${example.id}: real native kernel`)
  assert(result.bounds, `${example.id}: native bounds`)
  for (const axis of ['min', 'max']) {
    assert.equal(result.bounds[axis].length, 3)
    assert(result.bounds[axis].every(Number.isFinite))
  }
  result.bounds.min.forEach((value, axis) => assert(value <= result.bounds.max[axis]))
  assert(result.meshes.length >= (fixture.expected.minMeshes ?? 1), `${example.id}: expected topology count`)
  for (const mesh of result.meshes) {
    assert.equal(mesh.valid, true, `${example.id}: native shape validity`)
    assert.equal(mesh.positions.length % 3, 0)
    assert.equal(mesh.normals.length % 3, 0)
    assert.equal(mesh.indices.length % 3, 0)
    assert(mesh.positions.every(Number.isFinite), `${example.id}: finite positions`)
    assert(mesh.normals.every(Number.isFinite), `${example.id}: finite normals`)
    assert(mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3), `${example.id}: valid triangle topology`)
    assert(mesh.edges.every(edge => edge.length % 3 === 0 && edge.every(Number.isFinite)), `${example.id}: finite topology edges`)
    assert((mesh.vertices ?? []).every(Number.isFinite), `${example.id}: finite point topology`)
    assert(Number.isFinite(mesh.volume) && mesh.volume >= 0)
    assert(Number.isFinite(mesh.area) && mesh.area >= 0)
  }
  const volume = result.meshes.reduce((sum, mesh) => sum + mesh.volume, 0)
  const area = result.meshes.reduce((sum, mesh) => sum + mesh.area, 0)
  const triangles = result.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0)
  if (fixture.expected.dimension === 3) assert(volume > 0 && triangles > 0, `${example.id}: solid surfaces`)
  if (fixture.expected.dimension === 2) assert(area > 0 && triangles > 0, `${example.id}: sketch surfaces`)
  if (fixture.expected.dimension === 1) assert(result.meshes.some(mesh => mesh.edges.some(edge => edge.length >= 6)), `${example.id}: native curve edges`)
  if (fixture.expected.dimension === 0) assert(result.meshes.some(mesh => mesh.vertices?.length >= 3), `${example.id}: native points`)
  if (fixture.expected.volume !== undefined) assert(Math.abs(volume - fixture.expected.volume) < Math.max(0.001, fixture.expected.volume * 1e-8), `${example.id}: analytic volume`)
  assert.equal(example.stats.meshCount, result.meshes.length)
  assert.equal(example.stats.triangles, triangles)
  assert(Math.abs(example.stats.volume - volume) < 1e-8)
  return { id: example.id, dimension: fixture.expected.dimension, meshes: result.meshes.length, volume, area, triangles, bounds: result.bounds }
}

async function waitForModel(id) {
  await page.waitForFunction(id => {
    const workspace = document.querySelector('.model-workspace')
    const viewer = document.querySelector('.cad-viewer')
    return workspace?.getAttribute('data-example-id') === id && viewer?.getAttribute('data-model-id') === id && viewer?.getAttribute('data-model-ready') === 'true'
  }, id, { timeout: 30_000 })
  await page.getByTestId('sandbox-canvas').waitFor({ state: 'visible' })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

function visiblePixels(buffer) {
  const png = PNG.sync.read(buffer)
  let foreground = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const red = png.data[i], green = png.data[i + 1], blue = png.data[i + 2]
    // Ignore the light canvas and graph paper. This accepts every geometry
    // palette, including dark curves, neutral metal, and a native point.
    if (Math.min(red, green, blue) < 210 && Math.abs(red - 245) + Math.abs(green - 247) + Math.abs(blue - 251) > 75) foreground++
  }
  assert(foreground > 15, `Canvas must render actual geometry (${foreground} foreground pixels)`)
  return foreground
}

async function screenshotCanvas(name) {
  const image = await page.getByTestId('sandbox-canvas').screenshot()
  const foreground = visiblePixels(image)
  await writeFile(resolve(artifacts, `${name}.png`), image)
  report.screenshots.push({ name, foreground })
  return image
}

try {
  const home = await fetch(baseUrl, { signal: AbortSignal.timeout(30_000) })
  assert.equal(home.status, 200, 'Published sandbox HTML is available')
  assert.match(home.headers.get('content-type'), /text\/html/)
  for (const example of catalog) {
    const response = await fetch(new URL(example.modelUrl, `${baseUrl}/`), { signal: AbortSignal.timeout(30_000) })
    assert.equal(response.status, 200, `${example.id}: deployed model URL`)
    report.geometry.push(validateGeometry(example, visualFixtures.find(fixture => fixture.id === example.id), await response.json()))
  }
  report.modelCount = report.geometry.length
  console.log(`Verified ${report.modelCount} native model assets over HTTP`)

  browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })
  report.browser = browser.version()
  context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 })
  await checkCadControls(context)
  report.interactions.push('Cursor rotation direction in all four engineering views')
  page = await context.newPage()
  if (transport) {
    // Chromium does not inherit the managed environment's proxy CA. Node
    // keeps certificate verification enabled while fetching this exact origin.
    const origin = new URL(baseUrl).origin
    await page.route(`${origin}/**`, async route => {
      const response = await fetch(route.request().url(), { signal: AbortSignal.timeout(30_000) })
      const headers = Object.fromEntries(response.headers)
      delete headers['content-encoding']
      delete headers['content-length']
      await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) })
    })
  }
  report.transport = transport ? 'Node TLS-verified fetch for the exact deployment origin' : 'Direct Chromium requests'
  page.on('pageerror', error => report.browserErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()) })
  page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') report.failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`) })
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push(`${response.status()} ${response.url()}`) })
  await page.goto(`${baseUrl}/?example=electronics`)
  await waitForModel('electronics')
  assert.match(await page.getByTestId('example-title').innerText(), /PCB|connector/i)
  await page.screenshot({ path: resolve(artifacts, 'desktop.png'), fullPage: true })

  const search = page.getByTestId('example-search')
  await search.fill('torus')
  assert.equal(await page.getByTestId('example-card').count(), 2, 'Search narrows the native examples')
  await search.fill('not-a-cad-example-xyz')
  await page.getByTestId('search-empty').waitFor({ state: 'visible' })
  assert.equal(await page.getByTestId('example-card').count(), 0)
  await search.fill('')
  assert.equal(await page.getByTestId('example-card').count(), 58)
  await page.getByRole('button', { name: 'Assemblies', exact: true }).click()
  assert.equal(await page.getByTestId('example-card').count(), 3, 'Category filtering exposes the three complete assemblies')
  await page.getByRole('button', { name: 'All', exact: true }).click()
  report.interactions.push('Search, category filtering, and empty state')

  for (const [index, example] of catalog.entries()) {
    await page.locator(`[data-testid="example-card"][data-example-id="${example.id}"]`).click()
    await waitForModel(example.id)
    assert.equal(new URL(page.url()).searchParams.get('example'), example.id, `${example.id}: shareable example URL`)
    assert.equal(Number(await page.locator('.cad-viewer').getAttribute('data-mesh-count')), example.stats.meshCount)
    const image = await screenshotCanvas(example.id)
    screenshots.push({ id: example.id, title: example.title, image })
    if ((index + 1) % 10 === 0 || index + 1 === catalog.length) console.log(`Rendered and photographed ${index + 1}/${catalog.length} native examples`)
  }
  report.interactions.push('All 58 examples selected through the gallery')

  for (const id of ['electronics', 'fillet']) {
    await page.locator(`[data-testid="example-card"][data-example-id="${id}"]`).click()
    await waitForModel(id)
    const hashes = new Set()
    for (const view of ['iso', 'top', 'front', 'right']) {
      await page.getByTestId(`view-${view}`).click()
      assert.equal(await page.locator('.cad-viewer').getAttribute('data-view'), view)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      hashes.add(createHash('sha256').update(await screenshotCanvas(`${id}-${view}`)).digest('hex'))
    }
    assert.equal(hashes.size, 4, `${id}: all engineering views change the rendered camera`)
  }
  report.interactions.push('Four engineering views on the PCB assembly and fillet')
  await page.getByTestId('view-iso').click()
  const edges = page.getByTestId('toggle-edges')
  assert.equal(await edges.getAttribute('aria-pressed'), 'true')
  await edges.click()
  assert.equal(await edges.getAttribute('aria-pressed'), 'false')
  await screenshotCanvas('fillet-no-edges')
  await edges.click()
  assert.equal(await edges.getAttribute('aria-pressed'), 'true')
  const beforeOrbit = await screenshotCanvas('fillet-edges')
  const bounds = await page.getByTestId('sandbox-canvas').boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 100, bounds.y + bounds.height / 2 + 60, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const afterOrbit = await screenshotCanvas('fillet-orbit')
  assert.notEqual(createHash('sha256').update(beforeOrbit).digest('hex'), createHash('sha256').update(afterOrbit).digest('hex'), 'Dragging orbits the native shape')
  await page.getByTestId('reset-view').click()
  await page.waitForTimeout(250)
  const reset = await screenshotCanvas('fillet-reset')
  assert.notEqual(createHash('sha256').update(afterOrbit).digest('hex'), createHash('sha256').update(reset).digest('hex'), 'Reset reframes an orbited camera')
  report.interactions.push('Edge toggle, orbit drag, and reset')

  await page.getByRole('tab', { name: 'Plan', exact: true }).click()
  assert.match(await page.locator('[role="tabpanel"]').innerText(), /BuildPart|fillet/)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseUrl).origin })
  await page.getByRole('button', { name: 'Copy source', exact: true }).click()
  const copiedPlan = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
  assert.equal(copiedPlan.version, 1)
  assert(copiedPlan.children.some(node => node.type === 'BuildPart'))
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Plan JSON', exact: true }).click()
  const download = await downloadPromise
  await download.saveAs(resolve(artifacts, 'downloaded-plan.json'))
  assert.equal(JSON.parse(await readFile(resolve(artifacts, 'downloaded-plan.json'), 'utf8')).version, 1)
  report.interactions.push('Readable plan source, clipboard copy, and valid JSON download')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/?example=electronics`)
  await waitForModel('electronics')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout fits the viewport')
  const mobileCanvas = await page.getByTestId('sandbox-canvas').boundingBox()
  assert(mobileCanvas.width > 250 && mobileCanvas.height > 200, 'Mobile provides a usable CAD viewport')
  await page.screenshot({ path: resolve(artifacts, 'mobile.png'), fullPage: true })
  await page.getByTestId('mobile-examples-toggle').click()
  await page.getByTestId('example-search').waitFor({ state: 'visible' })
  await page.locator('[data-testid="example-card"][data-example-id="cylinder"]').click()
  await waitForModel('cylinder')
  await screenshotCanvas('mobile-cylinder')
  report.interactions.push('Mobile layout and example navigation')
  assert.deepEqual(report.browserErrors, [], 'No browser console or runtime errors')
  assert.deepEqual(report.failedRequests, [], 'No failed browser requests')
  assert.deepEqual(report.httpErrors, [], 'No HTTP asset failures')

  const sheet = await context.newPage()
  await sheet.setViewportSize({ width: 1760, height: 1400 })
  const escapeHtml = value => value.replace(/[&<>\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character])
  await sheet.setContent(`<!doctype html><html><head><style>body{margin:0;background:#e9edf3;font:12px system-ui}.grid{display:grid;grid-template-columns:repeat(8,220px)}figure{margin:0;padding:7px;box-sizing:border-box;height:174px}img{width:206px;height:139px;object-fit:contain;background:#f5f7fb}figcaption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-top:4px}</style></head><body><div class="grid">${screenshots.map(({ id, title, image }) => `<figure><img src="data:image/png;base64,${image.toString('base64')}"><figcaption>${escapeHtml(id)} · ${escapeHtml(title)}</figcaption></figure>`).join('')}</div></body></html>`)
  await sheet.screenshot({ path: resolve(artifacts, 'contact-sheet.png'), fullPage: true })
  await sheet.close()
  report.passed = true
  console.log(`Sandbox passed: ${report.modelCount} real native models, ${report.screenshots.length} geometry screenshots, desktop/mobile navigation and CAD controls`)
} catch (error) {
  report.passed = false
  report.error = error.stack ?? String(error)
  await page?.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(resolve(artifacts, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
}
