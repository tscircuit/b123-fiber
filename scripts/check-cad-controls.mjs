import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function checkCadControls(context) {
  const bundle = await build({
    stdin: { contents: `
      import { OrthographicCamera, Vector3 } from 'three'
      import { frameCadCamera } from './lib/three'
      import { createCadControls } from './lib/controls'
      let controls, camera, target
      window.frame = view => {
        controls?.dispose()
        camera = new OrthographicCamera(-1, 1, 1, -1, .001, 1000)
        target = frameCadCamera(camera, { min: [10,20,30], max: [20,40,35] }, view, 640/480)
        controls = createCadControls(camera, document.querySelector('canvas'), target)
      }
      window.direction = () => {
        const offset = camera.position.clone().sub(controls.target).normalize()
        return { elevation: offset.dot(camera.up), position: offset.toArray() }
      }
      window.controlState = () => ({ position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom })
      window.reset = () => controls.reset()
    `, resolveDir: resolve(import.meta.dirname, '..') },
    bundle: true, write: false, platform: 'browser', format: 'iife',
  })
  const page = await context.newPage()
  try {
    await page.setContent('<canvas width="640" height="480" style="display:block;width:640px;height:480px;touch-action:none"></canvas>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const bounds = await page.locator('canvas').boundingBox()
    const drag = async (dx, dy) => {
      await page.mouse.move(bounds.x + 320, bounds.y + 240)
      await page.mouse.down()
      await page.mouse.move(bounds.x + 320 + dx, bounds.y + 240 + dy, { steps: 10 })
      await page.mouse.up()
    }
    for (const view of ['iso', 'top', 'front', 'right']) {
      await page.evaluate(view => window.frame(view), view)
      const before = await page.evaluate(() => window.direction())
      const framed = await page.evaluate(() => window.controlState())
      await drag(80, 0)
      const horizontal = await page.evaluate(() => window.direction())
      assert(Math.abs(horizontal.elevation - before.elevation) < 1e-6, `${view}: horizontal drag preserves elevation in the camera's up-axis`)
      assert(Math.hypot(...horizontal.position.map((value, i) => value - before.position[i])) > .1, `${view}: horizontal drag rotates the part`)
      await drag(0, 40)
      const vertical = await page.evaluate(() => window.direction())
      assert(vertical.elevation > horizontal.elevation + .05, `${view}: downward drag tilts the camera upward consistently`)
      await page.evaluate(() => window.reset())
      const reset = await page.evaluate(() => window.controlState())
      for (const key of ['position', 'target']) reset[key].forEach((value, index) => assert(Math.abs(value - framed[key][index]) < 1e-9, `${view}: reset restores the nonzero model center and framed position`))
      assert.equal(reset.zoom, framed.zoom)
    }
  } finally { await page.close() }
  await checkPackagedViewerControls(context)
}

/** Exercise the exported viewer itself, observing real Three.js controls. */
export async function checkPackagedViewerControls(context) {
  const root = resolve(import.meta.dirname, '..')
  const result = JSON.parse(await readFile(resolve(root, 'sandbox/public/models/box.json'), 'utf8'))
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { flushSync } from 'react-dom'
      import { Build123dView } from './lib/viewer'
      const root = createRoot(document.querySelector('#app'))
      const result = ${JSON.stringify(result)}
      let props = { view: 'iso', showEdges: true }
      window.setViewer = changes => {
        props = { ...props, ...changes }
        flushSync(() => root.render(React.createElement(Build123dView, {
          ...props, result, style: { height: 480 }
        })))
      }
      window.snapshot = () => {
        const controls = window.observedControls
        const camera = controls.object
        const direction = camera.position.clone().sub(controls.target).normalize()
        return {
          position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
          target: controls.target.toArray(), up: camera.up.toArray(), zoom: camera.zoom,
          direction: direction.toArray(), elevation: direction.dot(camera.up),
          constructorUp: controls.constructorUp,
        }
      }
      window.unmountViewer = () => flushSync(() => root.unmount())
      window.setViewer({})
    `, resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    plugins: [{
      name: 'observe-real-orbit-controls',
      setup(builder) {
        builder.onResolve({ filter: /^three\/addons\/controls\/OrbitControls\.js$/ }, () => ({ path: 'controls', namespace: 'observed-controls' }))
        builder.onLoad({ filter: /.*/, namespace: 'observed-controls' }, () => ({
          contents: `
            import { OrbitControls as RealControls } from ${JSON.stringify(resolve(root, 'node_modules/three/examples/jsm/controls/OrbitControls.js'))}
            export class OrbitControls extends RealControls {
              constructor(camera, canvas) {
                const up = camera.up.toArray()
                super(camera, canvas)
                this.constructorUp = up
                window.observedControls = this
              }
            }
          `,
          resolveDir: root,
        }))
      },
    }],
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const snapshot = () => page.evaluate(() => window.snapshot())
  const chooseView = async view => {
    await page.evaluate(view => window.setViewer({ view }), view)
    await settled()
  }
  const drag = async (dx, dy, button = 'left') => {
    const bounds = await page.locator('canvas').boundingBox()
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down({ button })
    await page.mouse.move(x + dx, y + dy, { steps: 10 })
    await page.mouse.up({ button })
    await settled()
  }
  const unchanged = (actual, expected, message) => {
    for (const key of ['position', 'quaternion', 'target', 'up']) {
      actual[key].forEach((value, index) => assert(Math.abs(value - expected[key][index]) < 1e-9, `${message}: ${key}[${index}]`))
    }
    assert.equal(actual.zoom, expected.zoom, `${message}: zoom`)
  }
  try {
    await page.setContent('<style>body{margin:0}</style><div id="app" style="width:640px"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForFunction(() => document.querySelector('[data-cad-status]')?.getAttribute('data-cad-status') === 'ready')
    await settled()
    for (const view of ['iso', 'top', 'front', 'right']) {
      await chooseView(view)
      const before = await snapshot()
      const up = view === 'top' ? [0, 1, 0] : [0, 0, 1]
      assert.deepEqual(before.constructorUp, up, `${view}: packaged viewer frames the camera before constructing controls`)
      assert.deepEqual(before.up, up)
      await drag(80, 0)
      const horizontal = await snapshot()
      assert(Math.abs(horizontal.elevation - before.elevation) < 1e-6, `${view}: packaged horizontal orbit preserves elevation`)
      assert(Math.hypot(...horizontal.direction.map((value, index) => value - before.direction[index])) > 0.1, `${view}: packaged horizontal orbit moves the camera`)
      await drag(0, 40)
      const vertical = await snapshot()
      assert(vertical.elevation > horizontal.elevation + 0.05, `${view}: packaged downward drag tilts upward`)
      await page.evaluate(() => window.observedControls.reset())
      unchanged(await snapshot(), before, `${view}: reset returns to the framed model`)
    }
    await chooseView('iso')
    await drag(65, 30)
    await drag(25, -15, 'right')
    await page.mouse.wheel(0, -300)
    await page.waitForFunction(() => window.snapshot().zoom > 1)
    const oriented = await snapshot()
    const image = await page.locator('canvas').screenshot()
    await page.evaluate(() => window.setViewer({ showEdges: false }))
    await settled()
    unchanged(await snapshot(), oriented, 'Hide edges preserves orbit/pan/zoom')
    await page.evaluate(() => window.setViewer({ showEdges: true }))
    await settled()
    unchanged(await snapshot(), oriented, 'Show edges preserves orbit/pan/zoom')
    assert((await page.locator('canvas').screenshot()).equals(image), 'Edge toggle restores exactly the same rendered orientation')
    await page.locator('#app').evaluate(element => { element.style.width = '420px' })
    await page.waitForFunction(() => document.querySelector('canvas')?.width === 420)
    unchanged(await snapshot(), oriented, 'Resize preserves orbit/pan/zoom')
    await page.locator('#app').evaluate(element => { element.style.width = '640px' })
    await page.waitForFunction(() => document.querySelector('canvas')?.width === 640)
    unchanged(await snapshot(), oriented, 'Restoring viewport preserves orbit/pan/zoom')
    assert((await page.locator('canvas').screenshot()).equals(image), 'Resize round trip restores exactly the same rendered image')
    await page.evaluate(() => window.unmountViewer())
    assert.equal(await page.locator('canvas').count(), 0, 'Viewer disposes its canvas and controls')
    assert.deepEqual(errors, [], 'Packaged controls run without browser errors')
  } finally { await page.close() }
}
