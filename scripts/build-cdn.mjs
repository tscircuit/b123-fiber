#!/usr/bin/env node
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
const reactVersion = lock.packages['node_modules/react'].version
const reactUrl = `https://jscdn.tscircuit.com/react/${reactVersion}/+esm`

// jscdn transforms bare imports to latest and cannot currently transform
// react-reconciler's CommonJS entry. Bundle the browser dependencies ourselves,
// while keeping React as a single, explicitly versioned ESM dependency.
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      'export * from "./lib/index.ts";',
      'export { default as React } from "react";',
      'export { createRoot as createDOMRoot } from "react-dom/client";',
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'cdn-entry.ts',
    loader: 'ts',
  },
  outfile: 'dist/cdn.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // The Emscripten loader has a guarded Node branch. Preserve its built-in
  // imports; browsers never execute that branch.
  external: ['node:*'],
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
  banner: { js: '/*! Bundled dependency license texts: ./cdn.licenses.txt */' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'pinned-cdn-react',
    setup(builder) {
      // A CommonJS bridge makes both require('react') in the reconcilers and
      // ESM React imports use the same object, without browser dynamic require.
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'cdn-react' }))
      builder.onLoad({ filter: /.*/, namespace: 'cdn-react' }, () => ({
        contents: `import React from ${JSON.stringify(reactUrl)}; module.exports = React;`,
        loader: 'js',
      }))
    },
  }],
})

const licenses = await Promise.all(['react', 'react-dom', 'react-reconciler', 'scheduler', 'three', 'replicad', 'replicad-opencascadejs', 'opentype.js', 'fflate'].map(async name => {
  const directory = resolve(root, 'node_modules', name)
  const packageJson = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  return `=== ${name} ${packageJson.version} ===\n${await readFile(resolve(directory, 'LICENSE'), 'utf8')}`
}))
await writeFile(resolve(root, 'dist/cdn.licenses.txt'), `${licenses.join('\n')}\n`)

await writeFile(resolve(root, 'dist/cdn.d.ts'), [
  'export * from "./index.js";',
  'export { default as React } from "react";',
  'export { createRoot as createDOMRoot } from "react-dom/client";',
  '',
].join('\n'))
console.log(`Built dist/cdn.js with React ${reactVersion} from ${reactUrl}`)
