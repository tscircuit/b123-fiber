import * as esbuild from 'esbuild-wasm'
import wasmUrl from 'esbuild-wasm/esbuild.wasm?url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import * as fiber from '../../lib/headless'
import * as nativeValues from '../../lib/generated/values'

const initialized = esbuild.initialize({ wasmURL: wasmUrl, worker: false })

// User CAD code runs in this disposable worker, away from the application DOM.
// Module imports resolve to the same React and native CAD components as the app.
const modules: Record<string, unknown> = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': jsxDevRuntime,
  '@tscircuit/b123-fiber': fiber,
  '@tscircuit/b123-fiber/headless': fiber,
  '@tscircuit/b123-fiber/native': nativeValues,
}

self.onmessage = async (event: MessageEvent<{ source: string }>) => {
  let root: ReturnType<typeof fiber.createBuild123dRoot> | undefined
  try {
    await initialized
    const transformed = await esbuild.transform(event.data.source, {
      loader: 'tsx', sourcefile: 'sandbox.tsx', format: 'cjs', target: 'es2022',
      jsx: 'automatic', jsxImportSource: 'react',
    })
    const module = { exports: {} as { default?: unknown } }
    const require = (name: string) => {
      if (!(name in modules)) throw new Error(`Import "${name}" is unavailable. Use React or @tscircuit/b123-fiber.`)
      return modules[name]
    }
    new Function('require', 'module', 'exports', transformed.code)(require, module, module.exports)
    const exported = module.exports.default
    if (exported == null) throw new Error('Export a default CAD component or JSX element.')
    const element = React.isValidElement(exported) ? exported : React.createElement(exported as React.ComponentType)
    root = fiber.createBuild123dRoot()
    const plan = root.render(element)
    self.postMessage({ ok: true, plan })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    self.postMessage({ ok: false, error: message })
  } finally {
    try { root?.unmount() } catch { /* Compilation errors are already returned. */ }
  }
}
