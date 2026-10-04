#!/usr/bin/env node
/** Real browser editor, native regeneration and browser CAD file round trips. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'sandbox/dist')
const artifacts = resolve(root, 'artifacts/sandbox-editor')
const workspace = await mkdtemp(resolve(tmpdir(), 'b123-editor-'))
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.playwright')
const { chromium } = await import('@playwright/test')
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm' }
const report = { assertions: [], browserErrors: [], nativeVolumes: [], screenshots: [], browser: '' }
let browser, kernel
let logs = ''
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(`${dist}${sep}`)) { response.writeHead(403); response.end(); return }
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
  } catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = process.env.SANDBOX_URL ?? `http://127.0.0.1:${server.address().port}`
const token = 'sandbox-editor-test-token'
let kernelUrl = process.env.SANDBOX_KERNEL_URL
let authToken = process.env.SANDBOX_KERNEL_TOKEN ?? ''
await mkdir(artifacts, { recursive: true })

try {
  if (!kernelUrl) {
    const reserve = createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    const port = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
    kernelUrl = `http://127.0.0.1:${port}`
    authToken = token
    kernel = spawn(resolve(root, '.venv/bin/python'), ['-m', 'build123d_fiber', '--port', String(port), '--origin', new URL(baseUrl).origin, '--workspace-root', workspace], {
      cwd: root, env: { ...process.env, PYTHONPATH: resolve(root, 'python'), BUILD123D_FIBER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    kernel.stdout.on('data', chunk => { logs += chunk.toString() })
    kernel.stderr.on('data', chunk => { logs += chunk.toString() })
  }
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  let healthy = false
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch(`${kernelUrl}/health`, { headers, signal: AbortSignal.timeout(2000) })
      if (response.ok && (await response.json()).status === 'ok') { healthy = true; break }
    } catch { /* Wait for native imports and OCCT initialization. */ }
    if (kernel?.exitCode != null) throw new Error(`Kernel exited: ${logs}`)
    await delay(100)
  }
  assert(healthy, `Native kernel is available: ${logs}`)
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  report.browser = browser.version()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => report.browserErrors.push(error.message))
  if (process.env.SANDBOX_NODE_TRANSPORT === '1') {
    const origins = [new URL(baseUrl).origin, new URL(kernelUrl).origin]
    await page.route('**/*', async route => {
      const request = route.request()
      if (!origins.includes(new URL(request.url()).origin)) { await route.continue(); return }
      const response = await fetch(request.url(), { method: request.method(), headers: request.headers(), body: request.method() === 'GET' || request.method() === 'HEAD' ? undefined : request.postDataBuffer(), signal: AbortSignal.timeout(60_000) })
      const responseHeaders = Object.fromEntries(response.headers)
      delete responseHeaders['content-encoding']; delete responseHeaders['content-length']
      await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) })
    })
  }
  await page.goto(`${baseUrl}/?example=box`)
  await page.locator('.cad-viewer[data-model-id="box"][data-model-ready="true"]').waitFor()
  const catalog = JSON.parse(await readFile(resolve(root, 'sandbox/src/catalog.json'), 'utf8'))
  for (const id of ['electronics', ...catalog.filter(example => example.id.includes('full-round')).map(example => example.id)]) {
    await page.locator(`[data-testid="example-card"][data-example-id="${id}"]`).click()
    await page.locator(`.cad-viewer[data-model-id="${id}"][data-model-ready="true"]`).waitFor()
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert(await page.getByTestId('jsx-editor').evaluate(field => field.scrollHeight <= field.clientHeight + 2 && field.scrollWidth <= field.clientWidth + 1), `${id} at ${width}px: full source has no internal clipping`)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  await page.locator('[data-testid="example-card"][data-example-id="box"]').click()
  await page.locator('.cad-viewer[data-model-id="box"][data-model-ready="true"]').waitFor()
  report.assertions.push('Full example source autosizes without clipping at desktop, tablet, and mobile widths')
  await page.getByTestId('kernel-settings-toggle').click()
  await page.getByTestId('kernel-url').fill(kernelUrl)
  await page.getByTestId('kernel-token').fill(authToken)
  await page.getByTestId('kernel-connect').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="kernel-settings-toggle"]')?.textContent.includes('connected'))
  report.assertions.push('Configurable native endpoint and bearer token connect over real HTTP')

  const editor = page.getByTestId('jsx-editor')
  const original = await editor.inputValue()
  await editor.fill(original.replace('length={18}', 'length={24}'))
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('[data-testid="model-stats"]')?.getAttribute('data-volume')) - 2304) < 1e-6, undefined, { timeout: 30_000 })
  await page.getByTestId('run-source').waitFor({ state: 'visible' })
  assert.equal(await page.getByTestId('editor-error').count(), 0)
  report.nativeVolumes.push(2304)
  report.assertions.push('Edited JSX changes the actual OpenCascade box volume from 1728 to 2304 mm³')

  await page.getByRole('tab', { name: 'Parameters', exact: true }).click()
  await page.getByLabel('Box 1 · width', { exact: true }).fill('16')
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('[data-testid="model-stats"]')?.getAttribute('data-volume')) - 3072) < 1e-6, undefined, { timeout: 30_000 })
  report.nativeVolumes.push(3072)
  report.assertions.push('Parameter edits regenerate native geometry and synchronize editable JSX')
  await page.getByRole('tab', { name: 'JSX', exact: true }).click()
  assert.match(await editor.inputValue(), /width=\{16\}/)

  await editor.fill("import { b } from '@tscircuit/b123-fiber'\nexport default function Example() { return <b.Box length={ /> }")
  await page.getByTestId('run-source').click()
  await page.getByTestId('editor-error').waitFor({ state: 'visible' })
  assert.match(await page.getByTestId('editor-error').innerText(), /Compilation error/)
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 3072)
  report.assertions.push('Invalid JSX reports compiler diagnostics and preserves the last valid model')

  await editor.fill("import { b } from '@tscircuit/b123-fiber'\nexport default function Example() { return <b.Cylinder radius={-1} height={12} /> }")
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="editor-error"]')?.textContent.includes('Kernel error'), undefined, { timeout: 30_000 })
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 3072)
  report.assertions.push('Native modeling errors appear without discarding the previous model')

  const hookSource = "import { useState } from 'react'\nimport { b } from '@tscircuit/b123-fiber'\nexport default function Example() { const [length] = useState(6); return <b.Box length={length} width={8} height={10} /> }"
  await editor.fill(hookSource)
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="model-stats"]')?.getAttribute('data-volume')) === 480, undefined, { timeout: 30_000 })
  report.nativeVolumes.push(480)
  report.assertions.push('Editable React hooks execute through the actual CAD reconciler in the isolated worker')

  const title = await page.title()
  await editor.fill("document.title = 'source escaped into the app'\n" + hookSource)
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="editor-error"]')?.textContent.includes('document is not defined'), undefined, { timeout: 30_000 })
  assert.equal(await page.title(), title)
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 480)
  report.assertions.push('User JSX cannot access the application DOM from its isolated compiler worker')

  await editor.fill('export default function Example() { while (true) {} }')
  await page.getByTestId('run-source').click()
  await delay(1500)
  await page.locator('[data-testid="example-card"][data-example-id="cylinder"]').click()
  await page.locator('.cad-viewer[data-model-id="cylinder"][data-model-ready="true"]').waitFor({ timeout: 10_000 })
  assert.equal(await page.getByTestId('run-source').isEnabled(), true)
  assert.equal(await page.getByTestId('editor-error').count(), 0)
  report.assertions.push('Example navigation cancels looping user code while the application stays responsive')
  await page.locator('[data-testid="example-card"][data-example-id="box"]').click()
  await page.locator('.cad-viewer[data-model-id="box"][data-model-ready="true"]').waitFor()
  await editor.fill(hookSource)
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="model-stats"]')?.getAttribute('data-volume')) === 480, undefined, { timeout: 30_000 })

  await page.getByLabel('CAD export format').selectOption('step')
  const downloadEvent = page.waitForEvent('download')
  await page.getByTestId('export-cad').click()
  const step = await downloadEvent
  const stepPath = resolve(workspace, 'edited-box.step')
  await step.saveAs(stepPath)
  assert.match(await readFile(stepPath, 'utf8'), /ISO-10303-21/)
  report.assertions.push('Browser downloads a real STEP file generated from the edited source')

  await page.getByTestId('cad-file-input').setInputFiles(stepPath)
  await page.waitForFunction(() => document.querySelector('[data-testid="example-title"]')?.textContent === 'edited-box.step', undefined, { timeout: 30_000 })
  assert.match(await editor.inputValue(), /b\.import_step/)
  assert.match(await editor.inputValue(), /\$file/)
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 480)
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="run-source"]')?.textContent === 'Run' && !document.querySelector('[data-testid="editor-error"]'), undefined, { timeout: 30_000 })
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 480)
  report.assertions.push('Uploaded STEP produces editable durable JSX and regenerates without an RPC session handle')

  await page.getByLabel('CAD export format').selectOption('stl')
  const stlEvent = page.waitForEvent('download')
  await page.getByTestId('export-cad').click()
  const stl = await stlEvent
  const stlPath = resolve(workspace, 'edited-box.stl')
  await stl.saveAs(stlPath)
  const stlBody = await readFile(stlPath)
  assert(stlBody.length > 84)
  assert(stlBody.toString('utf8').startsWith('solid') || 84 + stlBody.readUInt32LE(80) * 50 === stlBody.length, 'Native STL contains valid triangle records')
  report.assertions.push('Browser exports imported CAD as a real native STL file')

  const planEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Plan JSON', exact: true }).click()
  const planDownload = await planEvent
  const planPath = resolve(workspace, 'imported-plan.json')
  await planDownload.saveAs(planPath)
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  assert.equal(plan.version, 1)
  assert(!JSON.stringify(plan).includes('"$ref"'), 'Imported plan is independent of process-local native handles')
  const replay = await fetch(`${kernelUrl}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ plan }), signal: AbortSignal.timeout(30_000) })
  assert.equal(replay.status, 200)
  const replayModel = await replay.json()
  assert.equal(replayModel.meshes.reduce((sum, mesh) => sum + mesh.volume, 0), 480)
  report.assertions.push('Downloaded imported plan replays natively over HTTP with embedded CAD bytes')

  await page.getByRole('button', { name: 'Reset example', exact: true }).click()
  assert.equal(await editor.inputValue(), original)
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 1728)
  let releaseAsset
  const heldAsset = new Promise(resolve => { releaseAsset = resolve })
  const assetUrl = new URL('/models/box.json', baseUrl).toString()
  const assetBody = await readFile(resolve(dist, 'models/box.json'))
  await page.route(assetUrl, async route => {
    await heldAsset
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: assetBody }) }
    catch { /* Native regeneration deliberately cancels this stale request. */ }
  })
  await page.reload()
  await editor.waitFor({ state: 'visible' })
  await page.getByTestId('kernel-settings-toggle').click()
  await page.getByTestId('kernel-token').fill(authToken)
  await editor.fill(original.replace('length={18}', 'length={24}'))
  await page.getByTestId('run-source').click()
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="model-stats"]')?.getAttribute('data-volume')) === 2304, undefined, { timeout: 30_000 })
  releaseAsset()
  await delay(150)
  assert.equal(Number(await page.getByTestId('model-stats').getAttribute('data-volume')), 2304)
  report.assertions.push('A late example asset cannot overwrite a newly regenerated native model')
  await page.getByRole('button', { name: 'Reset example', exact: true }).click()
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="model-stats"]')?.getAttribute('data-volume')) === 1728 && document.querySelector('.cad-viewer')?.getAttribute('data-model-ready') === 'true')
  await page.unroute(assetUrl)
  report.assertions.push('Reset restores original geometry even when its initial asset request was cancelled')
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({ path: resolve(artifacts, 'desktop-editor.png'), fullPage: true })
  report.screenshots.push('desktop-editor.png')
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Editable sandbox has no mobile horizontal overflow')
  await page.screenshot({ path: resolve(artifacts, 'mobile-editor.png'), fullPage: true })
  report.screenshots.push('mobile-editor.png')
  assert.deepEqual(report.browserErrors, [])
  console.log(`Passed ${report.assertions.length} real native editor, upload, and download checks`)
} catch (error) {
  report.failure = error.stack ?? String(error)
  throw error
} finally {
  await browser?.close()
  kernel?.kill('SIGTERM')
  if (kernel && kernel.exitCode == null) await Promise.race([new Promise(resolve => kernel.once('exit', resolve)), delay(5000).then(() => kernel.kill('SIGKILL'))])
  await new Promise(resolve => server.close(resolve))
  await writeFile(resolve(artifacts, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(resolve(artifacts, 'kernel.log'), logs)
  await rm(workspace, { recursive: true, force: true })
}
