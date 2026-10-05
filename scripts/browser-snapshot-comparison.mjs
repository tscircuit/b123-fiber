#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const root = resolve(import.meta.dirname, '..')
const baseline = resolve(root, 'tests/visual/baselines')
const actual = resolve(root, 'artifacts/visual')
const destination = resolve(actual, 'comparison')
await mkdir(destination, { recursive: true })
const manifest = JSON.parse(await readFile(resolve(baseline, 'manifest.json'), 'utf8'))
const html = value => String(value).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value])
const report = { baselineKernel: manifest.kernel, baselineChromium: manifest.chromium, threshold: 0, maxDiffPixels: 0, expectedScreenshots: manifest.screenshotCount, matched: 0, changed: 0, missing: 0, snapshots: [] }
for (const name of manifest.screenshots) {
  const expectedBytes = await readFile(resolve(baseline, name))
  const entry = { name, baselineSha256: createHash('sha256').update(expectedBytes).digest('hex') }
  let actualBytes
  try { actualBytes = await readFile(resolve(actual, name)) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    entry.status = 'missing'; report.missing++; report.snapshots.push(entry); continue
  }
  const expectedImage = PNG.sync.read(expectedBytes), actualImage = PNG.sync.read(actualBytes)
  entry.actualSha256 = createHash('sha256').update(actualBytes).digest('hex')
  entry.expectedSize = [expectedImage.width, expectedImage.height]
  entry.actualSize = [actualImage.width, actualImage.height]
  const width = Math.max(expectedImage.width, actualImage.width), height = Math.max(expectedImage.height, actualImage.height)
  const pad = source => {
    const image = new PNG({ width, height })
    image.data.fill(255)
    PNG.bitblt(source, image, 0, 0, source.width, source.height, 0, 0)
    return image
  }
  const expected = pad(expectedImage), rendered = pad(actualImage), diff = new PNG({ width, height })
  entry.diffPixels = pixelmatch(expected.data, rendered.data, diff.data, width, height, { threshold: 0, includeAA: true })
  entry.status = entry.diffPixels === 0 && expectedImage.width === actualImage.width && expectedImage.height === actualImage.height ? 'matched' : 'changed'
  report[entry.status]++
  const triptych = new PNG({ width: width * 3, height })
  PNG.bitblt(expected, triptych, 0, 0, width, height, 0, 0)
  PNG.bitblt(rendered, triptych, 0, 0, width, height, width, 0)
  PNG.bitblt(diff, triptych, 0, 0, width, height, width * 2, 0)
  entry.comparisonImage = name
  await writeFile(resolve(destination, name), PNG.sync.write(triptych))
  report.snapshots.push(entry)
}
report.passed = report.changed === 0 && report.missing === 0 && report.snapshots.length === manifest.screenshotCount
await writeFile(resolve(destination, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(resolve(destination, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>OpenCascade browser migration snapshots</title><style>body{font:16px system-ui;margin:24px;background:#f8fafc;color:#0f172a}figure{margin:32px 0}img{width:100%;height:auto;border:1px solid #cbd5e1}figcaption{margin:8px 0}.changed,.missing{color:#b91c1c}.matched{color:#15803d}</style></head><body><h1>Browser OpenCascade snapshot comparison</h1><p>${report.matched} exact matches · ${report.changed} changed · ${report.missing} missing of ${report.expectedScreenshots}. Pixel threshold: 0. Native baselines have not been modified.</p><p>Each image shows <strong>native baseline / browser WASM / exact pixel difference</strong>.</p>${report.snapshots.map(entry => `<figure><figcaption class="${entry.status}">${html(entry.name)} · ${entry.status}${entry.diffPixels === undefined ? '' : ` · ${entry.diffPixels} changed pixels`}</figcaption>${entry.comparisonImage ? `<img loading="lazy" src="${encodeURIComponent(entry.comparisonImage)}" alt="Native, browser and difference for ${html(entry.name)}">` : '<p>Browser render failed or this fixture was not run. See the Playwright report.</p>'}</figure>`).join('')}</body></html>`)
console.log(`Snapshot comparison: ${report.matched} exact matches, ${report.changed} changed, ${report.missing} missing (${report.expectedScreenshots} expected); ${destination}/index.html`)
if (!report.passed && !process.argv.includes('--report-only')) process.exitCode = 1
