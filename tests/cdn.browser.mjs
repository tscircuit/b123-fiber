#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.playwright')
const { chromium } = await import('@playwright/test')
const { PNG } = await import('pngjs')
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
const reactUrl = `https://jscdn.tscircuit.com/react/${lock.packages['node_modules/react'].version}/+esm`
const publishedBundleUrl = process.env.B123_CDN_BUNDLE_URL
let bundle
if (publishedBundleUrl) {
  const response = await fetch(publishedBundleUrl, { signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, `Published CDN bundle did not return HTTP 200: ${publishedBundleUrl}`)
  bundle = Buffer.from(await response.arrayBuffer())
} else {
  bundle = await readFile(resolve(root, 'dist/cdn.js'))
}
assert(bundle.includes(Buffer.from(reactUrl)), 'CDN bundle must preserve its pinned React URL')
const artifactDir = resolve(root, 'artifacts/cdn')
await mkdir(artifactDir, { recursive: true })

// Reserve an ephemeral port for the independently started native kernel.
const probe = createPortProbe()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const kernelPort = probe.address().port
await new Promise(resolve => probe.close(resolve))
const backendUrl = `http://127.0.0.1:${kernelPort}`
const server = createServer((request, response) => {
  if (request.url === '/dist/cdn.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' })
    response.end(bundle)
    return
  }
  if (request.url !== '/') { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(`<!doctype html><html><body style="margin:0"><div id="app"></div>
    <script type="module">
      import { React, createDOMRoot, createBuild123dRoot, Build123dView, BuildPart, Box } from '/dist/cdn.js';
      window.cdnResult = null;
      window.cdnErrors = [];
      window.cdnReactVersion = React.version;
      const Width = React.createContext(2);
      function Model() {
        const width = React.useContext(Width);
        return React.createElement(BuildPart, null, React.createElement(Box, { length: width, width: 3, height: 4, color: '#29a4bd' }));
      }
      // Exercise hooks directly in the CDN's custom reconciler as well as in
      // ReactDOM and the viewer. All three must receive the same React object.
      let resize;
      function HookModel() {
        const [length, setLength] = React.useState(2);
        resize = setLength;
        return React.createElement(Box, { length, width: 3, height: 4 });
      }
      const cadRoot = createBuild123dRoot();
      const initial = cadRoot.render(React.createElement(HookModel));
      const updated = cadRoot.flush(() => resize(5));
      window.cdnHookSizes = [initial.children[0].props.length, updated.children[0].props.length];
      cadRoot.unmount();
      function App() {
        const [width, setWidth] = React.useState(2);
        return React.createElement(React.Fragment, null,
          React.createElement('button', { id: 'resize', onClick: () => setWidth(5) }, 'Resize box'),
          React.createElement(Build123dView, {
            backendUrl: ${JSON.stringify(backendUrl)},
            style: { width: 760, height: 640 },
            onLoad: result => { if (result.meshes.length) window.cdnResult = result; },
            onError: error => window.cdnErrors.push(error.message),
          }, React.createElement(Width.Provider, { value: width }, React.createElement(Model)))
        );
      }
      createDOMRoot(document.getElementById('app')).render(React.createElement(App));
    </script></body></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
let kernelLog = ''
const kernel = spawn(resolve(root, '.venv/bin/python'), ['-m', 'build123d_fiber', '--port', String(kernelPort), '--origin', baseUrl], {
  cwd: root,
  env: { ...process.env, PYTHONPATH: resolve(root, 'python') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
kernel.stdout.on('data', chunk => { kernelLog += chunk })
kernel.stderr.on('data', chunk => { kernelLog += chunk })
let spawnError
kernel.on('error', error => { spawnError = error })
let browser
let page
const browserErrors = []
const failedRequests = []
let abortedRenderRequests = 0
try {
  let ready = false
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (kernel.exitCode !== null) throw new Error(`Native kernel exited ${kernel.exitCode}: ${kernelLog}`)
    try { ready = (await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(500) })).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert(ready, `Native kernel did not start: ${kernelLog}`)
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })
  page = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 1 })
  // Node honors the managed environment's proxy CA; Chromium does not inherit
  // NODE_EXTRA_CA_CERTS. Verify the actual pinned CDN payload through Node TLS
  // and fulfill only this exact module URL, keeping all TLS checks enabled.
  const reactResponse = await fetch(reactUrl, { signal: AbortSignal.timeout(20_000) })
  assert.equal(reactResponse.status, 200)
  const reactSource = await reactResponse.text()
  await page.route(reactUrl, route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' },
    body: reactSource,
  }))
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText
    // The viewer deliberately cancels the empty initial plan or an outdated
    // geometry request when React commits a newer model.
    if (request.url() === `${backendUrl}/render` && failure === 'net::ERR_ABORTED') {
      abortedRenderRequests++
    } else {
      failedRequests.push(`${request.url()}: ${failure}`)
    }
  })
  const loadedModules = []
  page.on('response', response => { if (response.url() === reactUrl) loadedModules.push(response.status()) })
  await page.goto(baseUrl)
  await page.waitForFunction(() => Math.abs((window.cdnResult?.meshes[0]?.volume ?? 0) - 24) < 1e-8, undefined, { timeout: 45_000 })
  assert.deepEqual(await page.evaluate(() => window.cdnHookSizes), [2, 5])
  await page.locator('canvas').screenshot({ path: resolve(artifactDir, 'before.png') })
  await page.locator('#resize').click()
  await page.waitForFunction(() => Math.abs((window.cdnResult?.meshes[0]?.volume ?? 0) - 60) < 1e-8, undefined, { timeout: 20_000 })
  const result = await page.evaluate(() => window.cdnResult)
  assert(result.meshes[0].valid)
  assert(result.meshes[0].indices.length > 0)
  const screenshot = await page.locator('canvas').screenshot()
  await writeFile(resolve(artifactDir, 'browser.png'), screenshot)
  const png = PNG.sync.read(screenshot)
  let geometryPixels = 0
  for (let index = 0; index < png.data.length; index += 4) {
    const [red, green, blue] = png.data.subarray(index, index + 3)
    if (blue > red + 20 && green > red + 20) geometryPixels++
  }
  assert(geometryPixels > 1_000, `Viewer did not render the cyan native mesh (${geometryPixels} pixels)`)
  assert.deepEqual(await page.evaluate(() => window.cdnErrors), [])
  assert.deepEqual(browserErrors, [])
  assert.deepEqual(failedRequests, [])
  assert.deepEqual(loadedModules, [200])
  const report = {
    reactUrl, reactVersion: await page.evaluate(() => window.cdnReactVersion),
    browser: browser.version(), hookSizes: [2, 5], nativeVolume: result.meshes[0].volume,
    nativeKernel: result.kernel, geometryPixels, browserErrors, failedRequests, abortedRenderRequests,
    bundleUrl: publishedBundleUrl ?? 'local dist/cdn.js',
    remoteModuleTransport: 'Node TLS-verified fetch, exact Playwright module URL',
  }
  await writeFile(resolve(artifactDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`CDN browser smoke passed: shared React hooks, native OpenCascade volume ${result.meshes[0].volume}, ${geometryPixels} visible mesh pixels`)
} catch (error) {
  const state = await page?.evaluate(() => ({
    reactVersion: window.cdnReactVersion,
    hookSizes: window.cdnHookSizes,
    errors: window.cdnErrors,
    meshVolumes: window.cdnResult?.meshes.map(mesh => mesh.volume),
  })).catch(() => undefined)
  console.error({ browserErrors, failedRequests, state })
  throw error
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  if (kernel.exitCode === null) {
    kernel.kill('SIGTERM')
    await new Promise(resolve => { kernel.once('exit', resolve); setTimeout(() => { kernel.kill('SIGKILL'); resolve() }, 5_000).unref() })
  }
  await writeFile(resolve(artifactDir, 'kernel.log'), kernelLog)
}
