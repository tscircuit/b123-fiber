import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { checkPackagedViewerControls } from '../../scripts/check-cad-controls.mjs'

test('packaged viewer orbits in the framed up-axis and preserves pan/zoom through edges and resize', async ({ context }) => {
  await checkPackagedViewerControls(context)
})

test('viewer preserves React hooks and context across parent updates; orbit and resize work', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/examples/viewer-test/')
  await page.waitForFunction(() => window.__CAD_VIEWER_TEST__?.result?.meshes[0]?.volume === 120)
  await page.getByRole('button', { name: 'Update CAD hook' }).click()
  await page.waitForFunction(() => window.__CAD_VIEWER_TEST__.result?.meshes[0]?.volume === 240)
  const loads = await page.evaluate(() => window.__CAD_VIEWER_TEST__.loads)
  await page.getByRole('button', { name: 'Rerender parent' }).click()
  await page.waitForFunction(previous => window.__CAD_VIEWER_TEST__.loads > previous, loads)
  expect(await page.evaluate(() => window.__CAD_VIEWER_TEST__.result?.meshes[0]?.volume)).toBe(240)
  const canvas = page.locator('canvas')
  const before = await canvas.screenshot()
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 8 }); await page.mouse.up()
  expect((await canvas.screenshot()).equals(before)).toBe(false)
  await page.setViewportSize({ width: 650, height: 800 })
  await expect(canvas).toHaveJSProperty('width', 634)
  expect(errors).toEqual([])
})

test('viewer reports invalid React plan props via overlay and onError', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/examples/viewer-test/')
  await page.waitForFunction(() => window.__CAD_VIEWER_TEST__?.result?.meshes[0]?.volume === 120)
  await page.getByRole('button', { name: 'Invalid CAD props' }).click()
  await expect(page.getByRole('alert')).toContainText(/finite|NaN|number/i)
  expect(await page.evaluate(() => window.__CAD_VIEWER_TEST__.error)).toMatch(/finite|NaN|number/i)
  expect(await page.evaluate(() => window.__CAD_VIEWER_TEST__.errors)).toBe(1)
  expect(errors).toEqual([])
})

test('viewer ignores a superseded local WASM render', async ({ page }) => {
  await page.goto('/examples/viewer-test/?delay=1')
  await page.waitForFunction(() => (window.__CAD_VIEWER_TEST__?.started ?? 0) >= 1)
  await page.getByRole('button', { name: 'Update CAD hook' }).click()
  await page.waitForFunction(() => window.__CAD_VIEWER_TEST__?.result?.meshes[0]?.volume === 240)
  await page.waitForTimeout(850)
  expect(await page.evaluate(() => window.__CAD_VIEWER_TEST__.result?.meshes[0]?.volume)).toBeCloseTo(240, 6)
  await expect(page.locator('[data-cad-status]')).toHaveAttribute('data-cad-status', 'ready')
})

test('viewer renders native RGBA transparency without a geometry service', async ({ page }) => {
  const serviceRequests: string[] = []
  page.on('request', request => { if (/\/(render|rpc|health)(?:[?/#]|$)/.test(request.url())) serviceRequests.push(request.url()) })
  await page.goto('/examples/viewer-test/')
  await page.waitForFunction(() => window.__CAD_VIEWER_TEST__?.result?.meshes[0]?.volume === 120)
  const opaque = PNG.sync.read(await page.locator('canvas').screenshot())
  await page.getByRole('button', { name: 'Toggle transparency' }).click()
  await page.waitForFunction(() => window.__CAD_VIEWER_TEST__.result?.meshes[0]?.color?.[3] === 0.35)
  const transparent = PNG.sync.read(await page.locator('canvas').screenshot())
  const center = (Math.floor(opaque.height / 2) * opaque.width + Math.floor(opaque.width / 2)) * 4
  const before = opaque.data[center]! + opaque.data[center + 1]! + opaque.data[center + 2]!
  const after = transparent.data[center]! + transparent.data[center + 1]! + transparent.data[center + 2]!
  expect(after, 'Transparent material blends with the light CAD background').toBeGreaterThan(before)
  expect(serviceRequests).toEqual([])
})
