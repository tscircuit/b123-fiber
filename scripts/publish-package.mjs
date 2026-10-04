#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const registry = 'https://npm.pkg.github.com'
if (manifest.name !== '@tscircuit/b123-fiber' || manifest.publishConfig?.registry !== registry) {
  throw new Error('The jscdn release must publish @tscircuit/b123-fiber to GitHub Packages')
}
const packageVersion = `${manifest.name}@${manifest.version}`
const existing = spawnSync('npm', ['view', packageVersion, 'version', '--json', '--registry', registry], { encoding: 'utf8' })
if (existing.error) throw existing.error
if (existing.status === 0) {
  if (JSON.parse(existing.stdout) !== manifest.version) throw new Error('Registry returned an unexpected version')
  console.log(`${packageVersion} is already published. Bump package.json and package-lock.json to release another version.`)
} else if (/\bE404\b/.test(existing.stderr)) {
  // CI built and tested this exact revision before this job. Avoid running the
  // prepare lifecycle again while packing the same already-verified dist files.
  const published = spawnSync('npm', ['publish', '--ignore-scripts', '--registry', registry], { stdio: 'inherit' })
  if (published.error) throw published.error
  if (published.status !== 0) process.exit(published.status ?? 1)
  console.log(`Published ${packageVersion} for https://jscdn.tscircuit.com/${manifest.name}/${manifest.version}.tgz`)
} else {
  process.stderr.write(existing.stderr)
  throw new Error(`Cannot check ${packageVersion}; refusing to treat an authentication or network failure as a missing version`)
}
