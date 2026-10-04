import { test, expect } from '@playwright/test'
import { visualFixtures } from '../../examples/gallery/fixtures'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const artifacts = join(process.cwd(), 'artifacts/visual')
mkdirSync(artifacts, { recursive: true })
for (const fixture of visualFixtures) {
  test(`${fixture.id}: native geometry and four engineering views`, async ({ page }) => {
    const browserErrors: string[] = []
    page.on('pageerror', error => browserErrors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
    await page.goto(`/?test=1&case=${fixture.id}`)
    await page.waitForFunction(() => document.querySelector('[data-cad-status]')?.getAttribute('data-cad-status') !== 'loading', null, { timeout: 90_000 })
    const status = await page.locator('[data-cad-status]').getAttribute('data-cad-status')
    expect(status, await page.locator('[data-cad-status]').innerText()).toBe('ready')
    await page.waitForFunction(() => Boolean(window.__CAD_VISUAL__?.result))
    const result = await page.evaluate(() => window.__CAD_VISUAL__.result!)
    expect(result.kernel).toMatch(/build123d|OpenCascade|OCCT/i)
    expect(result.bounds).not.toBeNull()
    expect(result.bounds!.min).toHaveLength(3)
    expect(result.bounds!.max).toHaveLength(3)
    expect([...result.bounds!.min, ...result.bounds!.max].every(Number.isFinite)).toBe(true)
    result.bounds!.min.forEach((value, index) => expect(value).toBeLessThanOrEqual(result.bounds!.max[index]!))
    expect(result.meshes.length).toBeGreaterThanOrEqual(fixture.expected.minMeshes ?? 1)
    for (const mesh of result.meshes) {
      expect(mesh.valid, 'OpenCascade shape validity').toBe(true)
      expect(mesh.positions.every(Number.isFinite)).toBe(true)
      expect(mesh.normals.every(Number.isFinite)).toBe(true)
      expect(mesh.indices.every(i => Number.isInteger(i) && i >= 0 && i < mesh.positions.length / 3)).toBe(true)
      expect(mesh.edges.flat().every(Number.isFinite)).toBe(true)
    }
    if (fixture.expected.dimension === 3) {
      expect(result.meshes.reduce((n, m) => n + m.volume, 0)).toBeGreaterThan(0)
      expect(result.meshes.reduce((n, m) => n + m.indices.length, 0)).toBeGreaterThan(0)
    } else if (fixture.expected.dimension === 2) {
      expect(result.meshes.reduce((n, m) => n + m.area, 0)).toBeGreaterThan(0)
    } else if (fixture.expected.dimension === 1) {
      expect(result.meshes.reduce((n, m) => n + m.edges.flat().length, 0)).toBeGreaterThan(0)
    } else {
      expect(result.meshes.reduce((n, m) => n + (m.vertices?.length ?? 0), 0)).toBeGreaterThan(0)
    }
    if (fixture.expected.volume !== undefined) {
      const volume = result.meshes.reduce((n, m) => n + m.volume, 0)
      expect(Math.abs(volume - fixture.expected.volume)).toBeLessThan(Math.max(0.001, fixture.expected.volume * 1e-8))
    }
    writeFileSync(join(artifacts, `${fixture.id}.geometry.json`), JSON.stringify({ bounds: result.bounds, meshes: result.meshes.map(({ volume, area, valid, kind, positions, indices, edges, name }) => ({ volume, area, valid, kind, name, vertices: positions.length / 3, triangles: indices.length / 3, edges: edges.length })) }, null, 2))
    for (const view of ['iso', 'top', 'front', 'right'] as const) {
      await page.getByTestId(`view-${view}`).click()
      await expect(page.locator('[data-cad-view]')).toHaveAttribute('data-cad-view', view)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const canvas = page.locator('canvas')
      const screenshot = await canvas.screenshot()
      writeFileSync(join(artifacts, `${fixture.id}-${view}.png`), screenshot)
      const pixels = PNG.sync.read(screenshot)
      let foreground = 0
      for (let i = 0; i < pixels.data.length; i += 4) {
        if (Math.abs(pixels.data[i]! - 241) + Math.abs(pixels.data[i + 1]! - 244) + Math.abs(pixels.data[i + 2]! - 248) > 20) foreground++
      }
      expect(foreground, `${view} camera renders a visible shape`).toBeGreaterThan(40)
      await expect(canvas).toHaveScreenshot(`${fixture.id}-${view}.png`)
    }
    expect(browserErrors, 'No browser runtime, network or WebGL errors').toEqual([])
  })
}
