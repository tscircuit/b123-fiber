#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, 'artifacts/visual')
const logs = []
const baseUrl = process.env.VISUAL_BASE_URL ?? 'http://127.0.0.1:5177'
let vite
const reachable = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).status < 500 } catch { return false } }
const cleanup = () => { if (vite?.exitCode === null) vite.kill('SIGTERM') }
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
const run = (command, args, env = {}) => new Promise((resolveCode, reject) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => resolveCode(code ?? 1))
})
let code = 1
try {
  const reportOnly = process.argv.includes('--report-only')
  const browserBaselines = process.argv.includes('--browser-baselines') || process.env.B123_BROWSER_BASELINES === '1'
  const args = process.argv.slice(2).filter(arg => !['--report-only', '--browser-baselines'].includes(arg))
  if (args.some(arg => /update/.test(arg))) throw new Error('Browser migration comparisons preserve the existing native baselines. Review artifacts/visual/comparison/index.html instead of updating snapshots.')
  await mkdir(artifacts, { recursive: true })
  const manifest = JSON.parse(await readFile(resolve(root, 'tests/visual/baselines/manifest.json'), 'utf8'))
  // Remove only this run's outputs: stale images must not make failed fixtures
  // appear supported in the comparison report.
  await Promise.all(manifest.screenshots.map(name => rm(resolve(artifacts, name), { force: true })))
  if (!(await reachable(baseUrl))) {
    vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', new URL(baseUrl).port], { cwd: root, env: { ...process.env, B123_VISUAL_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    vite.stdout.on('data', chunk => logs.push(String(chunk)))
    vite.stderr.on('data', chunk => logs.push(String(chunk)))
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await reachable(baseUrl)) break
      if (vite.exitCode !== null) throw new Error(`Vite exited ${vite.exitCode}: ${logs.join('')}`)
      if (attempt === 119) throw new Error(`Vite did not start at ${baseUrl}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  code = await run(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'tests/visual/playwright.config.ts', ...args], { VISUAL_BASE_URL: baseUrl, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(root, '.playwright'), B123_SNAPSHOT_REPORT_ONLY: reportOnly ? '1' : '0', B123_BROWSER_BASELINES: browserBaselines ? '1' : '0' })
  const comparisonCode = await run(process.execPath, ['scripts/browser-snapshot-comparison.mjs', ...(reportOnly ? ['--report-only'] : [])])
  if (comparisonCode !== 0) code = comparisonCode
} catch (error) { console.error(error.message) }
finally { await writeFile(resolve(artifacts, 'service.log'), logs.join('')); cleanup() }
process.exit(code)
