#!/usr/bin/env node
/** Produce a compact, checked-in PR review sheet from the exact comparison. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const comparison = resolve(root, 'artifacts/visual/comparison')
const destination = resolve(root, 'docs/browser-migration')
const report = JSON.parse(await readFile(resolve(comparison, 'results.json'), 'utf8'))
await mkdir(destination, { recursive: true })
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.playwright')
const { chromium } = await import('@playwright/test')
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const figures = []
for (const entry of report.snapshots.filter(entry => entry.name.endsWith('-iso.png'))) {
  const image = entry.comparisonImage ? `data:image/png;base64,${(await readFile(resolve(comparison, entry.comparisonImage))).toString('base64')}` : null
  figures.push(`<figure><figcaption>${escape(entry.name.replace('-iso.png', ''))} · ${entry.status}${entry.diffPixels === undefined ? '' : ` · ${entry.diffPixels} pixels`}</figcaption>${image ? `<img src="${image}" alt="Native baseline, browser WASM, difference">` : '<div class="missing">No browser capture; inspect the fixture failure.</div>'}</figure>`)
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><head><style>body{font:13px system-ui;margin:0;padding:20px;background:#f8fafc;color:#0f172a;box-sizing:border-box}h1{font-size:24px;margin:0 0 8px}p{margin:6px 0 14px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}figure{margin:0;border:1px solid #cbd5e1;background:white;padding:8px;overflow:hidden}figcaption{font-weight:600;margin-bottom:6px}img{display:block;width:100%;height:auto}.missing{height:150px;display:flex;align-items:center;color:#b91c1c}</style></head><body><h1>OpenCascade browser migration — unchanged native snapshot baselines</h1><p>${report.matched} exact matches / ${report.changed} changed / ${report.missing} missing across all ${report.expectedScreenshots} views. Pixel threshold: 0.</p><p>All 73 isometric comparisons below show <strong>native baseline / browser WASM / exact difference</strong>. The full artifact contains the other three views for every fixture.</p><div class="grid">${figures.join('')}</div></body></html>`, { waitUntil: 'load' })
  await page.screenshot({ path: resolve(destination, 'isometric-comparison.png'), fullPage: true })
  const representatives = ['box', 'sphere', 'sweep', 'fillet', 'text', 'technical-drawing']
  const selected = []
  for (const id of representatives) {
    const entry = report.snapshots.find(entry => entry.name === id + '-iso.png')
    if (!entry?.comparisonImage) continue
    const bytes = await readFile(resolve(comparison, entry.comparisonImage))
    selected.push('<figure><figcaption>' + escape(id) + ' · ' + entry.status + ' · ' + entry.diffPixels + ' changed pixels</figcaption><img src="data:image/png;base64,' + bytes.toString('base64') + '"></figure>')
  }
  await page.setContent('<!doctype html><html><head><style>body{font:16px system-ui;margin:20px;background:#f8fafc;color:#0f172a}h1{font-size:24px}figure{margin:24px 0;border:1px solid #cbd5e1;background:white;padding:10px}figcaption{font-weight:600;margin-bottom:8px}img{display:block;width:100%;height:auto}</style></head><body><h1>Representative native / browser WASM / exact pixel differences</h1><p>Original native baselines are unchanged. Box demonstrates exact identity; the other cases expose tessellation, shading and text rendering differences.</p>' + selected.join('') + '</body></html>', { waitUntil: 'load' })
  await page.screenshot({ path: resolve(destination, 'representative-comparison.png'), fullPage: true })
} finally { await browser.close() }
await writeFile(resolve(destination, 'snapshot-summary.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`PR review artifacts written to ${destination}`)
