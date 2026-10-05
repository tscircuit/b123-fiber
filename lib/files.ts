import type { Build123dPlan, RenderResult } from './types'

export type NativeFileFormat = 'step' | 'stl' | 'brep' | 'svg' | 'dxf' | 'gltf' | 'glb' | 'obj' | '3mf'
export type NativeBinaryInput = Blob | ArrayBuffer | ArrayBufferView
export interface NativeFile {
  id: string
  name: string
  /** Virtual filesystem path usable by CAD file-path APIs on this instance. */
  path: string
  size: number
  contentType: string
}
export interface NativeFileValue { $file: { name: string; base64: string } }
export interface NativeFileOptions {
  filename?: string
  signal?: AbortSignal | null
}
export interface NativeImportOptions extends NativeFileOptions {
  format?: NativeFileFormat
  kwargs?: Readonly<Record<string, unknown>>
}
export interface NativeExportOptions extends NativeFileOptions {
  kwargs?: Readonly<Record<string, unknown>>
}
export interface NativeImportedFile<Value = unknown> {
  /** Retained CAD object; its lifetime belongs to the current kernel instance. */
  value: Value
  /** Self-contained file content; this plan survives kernel restarts. */
  plan: Build123dPlan
  result: RenderResult
}

export function fileBlob(value: NativeBinaryInput | string): Blob {
  if (typeof value === 'string') return new Blob([value], { type: 'text/plain' })
  if (value instanceof Blob) return value
  if (value instanceof ArrayBuffer) return new Blob([value])
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength)
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    return new Blob([bytes])
  }
  throw new TypeError('File content must be a Blob, File, ArrayBuffer, or typed byte array')
}

export function fileName(value: NativeBinaryInput | string, fallback = 'model.bin'): string {
  return typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
    ? value.name : fallback
}

export function bytesBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  }
  return btoa(binary)
}

export function base64Bytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** Encode a browser file into a durable native import argument. */
export async function nativeFile(value: NativeBinaryInput, name = fileName(value)): Promise<NativeFileValue> {
  const blob = fileBlob(value)
  if (blob.size > 32 * 1024 * 1024) throw new RangeError('Files must be no larger than 32 MiB')
  return { $file: { name, base64: bytesBase64(new Uint8Array(await blob.arrayBuffer())) } }
}
