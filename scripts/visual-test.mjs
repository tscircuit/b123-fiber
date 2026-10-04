#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const children = []
const logs = []
const start = (command, args, env = {}) => {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => logs.push(chunk.toString()))
  child.stderr.on('data', chunk => logs.push(chunk.toString()))
  children.push(child)
  return child
}
const reachable = async url => { try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).status < 500 } catch { return false } }
const waitFor = async (url, child) => {
  for (let n = 0; n < 120; n++) {
    if (await reachable(url)) return
    if (child.exitCode !== null) throw new Error(`Service exited ${child.exitCode}: ${logs.slice(-20).join('')}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Service did not start: ${url}\n${logs.slice(-20).join('')}`)
}
const cleanup = () => children.forEach(child => { if (child.exitCode === null) child.kill('SIGTERM') })
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
let code = 1
try {
  await mkdir(resolve(root, 'artifacts/visual'), { recursive: true })
  if (!(await reachable('http://127.0.0.1:8765/health'))) {
    const kernel = start(resolve(root, '.venv/bin/python'), ['-m', 'build123d_fiber'], { PYTHONPATH: resolve(root, 'python') })
    await waitFor('http://127.0.0.1:8765/health', kernel)
  }
  if (!(await reachable('http://127.0.0.1:5173'))) {
    const vite = start(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'])
    await waitFor('http://127.0.0.1:5173', vite)
  }
  const args = process.argv.slice(2).map(arg => arg === '--update' ? '--update-snapshots' : arg)
  const playwright = spawn(process.execPath, [resolve(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'tests/visual/playwright.config.ts', ...args], { cwd: root, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve(root, '.playwright') }, stdio: 'inherit' })
  code = await new Promise((resolve, reject) => { playwright.on('exit', resolve); playwright.on('error', reject) })
  const contact = spawn(resolve(root, '.venv/bin/python'), ['scripts/visual-contact-sheet.py'], { cwd: root, stdio: 'inherit' })
  await new Promise((resolve, reject) => { contact.on('exit', resolve); contact.on('error', reject) })
} catch (error) { console.error(error.message) }
finally { await writeFile(resolve(root, 'artifacts/visual/service.log'), logs.join('')); cleanup() }
process.exit(code ?? 1)
