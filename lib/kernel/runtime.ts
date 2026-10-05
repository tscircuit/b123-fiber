import initOpenCascade from 'replicad-opencascadejs'
import * as replicad from 'replicad'

export interface KernelOptions {
  /** Reuse an OpenCascade.js instance supplied by the application. */
  openCascade?: any
  oc?: any
  /** URL of the shipped OpenCascade WebAssembly binary. */
  wasmUrl?: string | URL
  wasmURL?: string | URL
  wasmBinary?: Uint8Array | ArrayBuffer
  fontUrl?: string | URL
  fontBinary?: Uint8Array | ArrayBuffer
  locateFile?: (path: string, prefix: string) => string
}

let defaultRuntime: Promise<{ oc: any; replicad: typeof replicad }> | undefined

async function readAsset(url: string | URL): Promise<ArrayBuffer> {
  const target = new URL(String(url), import.meta.url)
  if (target.protocol === 'file:') {
    const fsName = 'node:fs/promises'
    const fs = await import(/* @vite-ignore */ fsName)
    const bytes: Uint8Array = await fs.readFile(target)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
  const response = await fetch(target)
  if (!response.ok) throw new Error(`Unable to load CAD asset ${target}: HTTP ${response.status}`)
  return response.arrayBuffer()
}

async function bootstrap(options: KernelOptions) {
  let binary = options.wasmBinary
  let wasmUrl = options.wasmUrl ?? options.wasmURL
  const node = typeof process !== 'undefined' && !!process.versions?.node
  if (!wasmUrl && node) {
    // Node reads the dependency directly; browsers receive the copied package asset.
    const moduleName = 'node:module'
    const { createRequire } = await import(/* @vite-ignore */ moduleName)
    const require = createRequire(import.meta.url)
    const urlName = 'node:url'
    const { pathToFileURL } = await import(/* @vite-ignore */ urlName)
    wasmUrl = pathToFileURL(require.resolve('replicad-opencascadejs/wasm'))
  }
  wasmUrl ??= new URL('./opencascade.wasm', import.meta.url)
  if (!binary && node) binary = new Uint8Array(await readAsset(wasmUrl))
  const oc = options.openCascade ?? options.oc ?? await initOpenCascade({
    ...(binary ? { wasmBinary: binary instanceof Uint8Array ? binary : new Uint8Array(binary) } : {}),
    locateFile: options.locateFile ?? ((path: string, prefix: string) => path.endsWith('.wasm') ? String(wasmUrl) : `${prefix}${path}`),
  })
  replicad.setOC(oc)
  // Browser and Node use the same bundled outline font, preserving glyph geometry.
  let font = options.fontBinary
  if (!font) {
    let fontUrl = options.fontUrl ?? new URL('./DejaVuSans.ttf', import.meta.url)
    if (node && !options.fontUrl) {
      try { font = await readAsset(fontUrl) } catch {
        fontUrl = new URL('../../assets/fonts/DejaVuSans.ttf', import.meta.url)
      }
    }
    font ??= await readAsset(fontUrl)
  }
  const buffer = font instanceof Uint8Array ? font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength) as ArrayBuffer : font
  await replicad.loadFont(buffer, 'DejaVu Sans', true)
  await replicad.loadFont(buffer, 'default', true)
  return { oc, replicad }
}

export function initializeOpenCascade(options: KernelOptions = {}) {
  if (Object.keys(options).length) return bootstrap(options)
  return defaultRuntime ??= bootstrap(options).catch(error => { defaultRuntime = undefined; throw error })
}
export const initializeKernel = initializeOpenCascade
export const initOpenCascadeRuntime = initializeOpenCascade
