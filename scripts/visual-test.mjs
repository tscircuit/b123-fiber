#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, 'artifacts/visual')
const fontBootstrap = `
import hashlib
import json
import os
from pathlib import Path
import runpy

from build123d import Compound, FontManager, FontStyle

# build123d resets FONTCONFIG_FILE, and OCCT also discovers system fonts.
# Pin its test-process registry explicitly before importing the kernel.
font_path = Path(os.environ['BUILD123D_VISUAL_FONT']).resolve()
manager = FontManager().manager
manager.ClearFontDataBase()
font = manager.CheckFont(str(font_path))
if font is None or not manager.RegisterFont(font, True):
    raise RuntimeError(f'Cannot register visual-test font: {font_path}')
resolved_fonts = {}
for requested in ('Arial', 'DejaVu Sans'):
    family, path, _ = Compound.resolve_font(requested, None, FontStyle.REGULAR)
    if Path(path).resolve() != font_path:
        raise RuntimeError(f'Visual-test font {requested!r} resolved to {path!r}')
    resolved_fonts[requested] = family
if len(manager.GetAvailableFonts()) != 1:
    raise RuntimeError('Visual-test font registry includes unpinned system fonts')
diagnostic = {
    'file': str(font_path),
    'sha256': hashlib.sha256(font_path.read_bytes()).hexdigest(),
    'resolvedFamilies': resolved_fonts,
    'availableFonts': [font.FontName().ToCString() for font in manager.GetAvailableFonts()],
}
Path(os.environ['BUILD123D_VISUAL_FONT_DIAGNOSTIC']).write_text(json.dumps(diagnostic, indent=2) + '\\n')
print('Visual native fonts: ' + json.dumps(diagnostic), flush=True)
runpy.run_module('build123d_fiber', run_name='__main__')
`
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
  await mkdir(artifacts, { recursive: true })
  if (await reachable('http://127.0.0.1:8765/health')) {
    throw new Error('Visual tests need an isolated kernel on port 8765; stop the existing kernel first.')
  }
  const fontCache = resolve(artifacts, 'fontconfig-cache')
  const fontConfig = resolve(artifacts, 'fonts.conf')
  const fontDirectory = resolve(root, 'deployment/kernel/fonts')
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  await mkdir(fontCache, { recursive: true })
  await writeFile(fontConfig, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>${xml(fontDirectory)}</dir><cachedir>${xml(fontCache)}</cachedir></fontconfig>\n`)
  const kernel = start(resolve(root, '.venv/bin/python'), ['-c', fontBootstrap], {
    PYTHONPATH: resolve(root, 'python'),
    FONTCONFIG_FILE: fontConfig,
    FONTCONFIG_PATH: artifacts,
    BUILD123D_VISUAL_FONT: resolve(fontDirectory, 'DejaVuSans.ttf'),
    BUILD123D_VISUAL_FONT_DIAGNOSTIC: resolve(artifacts, 'font-environment.json'),
  })
  await waitFor('http://127.0.0.1:8765/health', kernel)
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
finally { await writeFile(resolve(artifacts, 'service.log'), logs.join('')); cleanup() }
process.exit(code ?? 1)
