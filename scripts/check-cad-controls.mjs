import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

export async function checkCadControls(context) {
  const bundle = await build({
    stdin: { contents: `
      import { OrthographicCamera, Vector3 } from 'three'
      import { frameCadCamera } from './lib/three'
      import { createCadControls } from './sandbox/src/controls'
      let controls, camera, target
      window.frame = view => {
        controls?.dispose()
        camera = new OrthographicCamera(-1, 1, 1, -1, .001, 1000)
        target = frameCadCamera(camera, { min: [10,20,30], max: [20,40,35] }, view, 640/480)
        controls = createCadControls(camera, document.querySelector('canvas'), target)
      }
      window.direction = () => {
        const offset = camera.position.clone().sub(target).normalize()
        return { elevation: offset.dot(camera.up), position: offset.toArray() }
      }
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
      await drag(80, 0)
      const horizontal = await page.evaluate(() => window.direction())
      assert(Math.abs(horizontal.elevation - before.elevation) < 1e-6, `${view}: horizontal drag preserves elevation in the camera's up-axis`)
      assert(Math.hypot(...horizontal.position.map((value, i) => value - before.position[i])) > .1, `${view}: horizontal drag rotates the part`)
      await drag(0, 40)
      const vertical = await page.evaluate(() => window.direction())
      assert(vertical.elevation > horizontal.elevation + .05, `${view}: downward drag tilts the camera upward consistently`)
    }
  } finally { await page.close() }
}
