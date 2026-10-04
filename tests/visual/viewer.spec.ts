import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { visualFixtures } from '../../examples/gallery/fixtures'

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

test('viewer ignores a superseded asynchronous geometry response', async ({ page, request }) => {
  const box = visualFixtures.find(fixture => fixture.id === 'box')!
  const sphere = visualFixtures.find(fixture => fixture.id === 'sphere')!
  const boxResult = await (await request.post('http://127.0.0.1:8765/render', { data: { plan: box.plan } })).json()
  const sphereResult = await (await request.post('http://127.0.0.1:8765/render', { data: { plan: sphere.plan } })).json()
  let firstRequestStarted = false
  await page.route('http://127.0.0.1:8765/render', async route => {
    const isBox = route.request().postDataJSON().plan.children[0].type === 'Box'
    if (isBox) firstRequestStarted = true
    await new Promise(resolve => setTimeout(resolve, isBox ? 750 : 30))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(isBox ? boxResult : sphereResult) })
  })
  await page.goto('/?case=box')
  await expect.poll(() => firstRequestStarted).toBe(true)
  await page.locator('#fixture-select').selectOption('sphere')
  await page.waitForFunction(() => window.__CAD_VISUAL__?.id === 'sphere' && (window.__CAD_VISUAL__.result?.meshes[0]?.volume ?? 0) > 2100)
  await page.waitForTimeout(850)
  expect(await page.evaluate(() => window.__CAD_VISUAL__.result?.meshes[0]?.volume)).toBeCloseTo(sphere.expected.volume!, 6)
  await expect(page.locator('[data-cad-status]')).toHaveAttribute('data-cad-status', 'ready')
})


test('viewer forwards auth headers and renders native RGBA transparency', async ({ page }) => {
  const headers: string[] = []
  page.on('request', request => { if (request.url().endsWith('/render')) headers.push(request.headers()['authorization'] ?? '') })
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
  expect(headers.length).toBeGreaterThanOrEqual(2)
  expect(headers.every(value => value === 'Bearer viewer-test')).toBe(true)
})
