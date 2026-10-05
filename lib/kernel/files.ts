import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { Color as ThreeColor } from 'three'
import { base64Bytes, bytesBase64, fileBlob, fileName, type NativeBinaryInput, type NativeFile, type NativeFileFormat, type NativeFileOptions, type NativeFileValue, type NativeImportOptions, type NativeExportOptions } from '../files'
import type { Build123dPlan } from '../types'
import { isKernelShape, shapeList, shapeValue, type KernelContext, type KernelHandler, type KernelShape } from './types'

const MAX_FILE_SIZE = 32 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const mimeTypes: Record<NativeFileFormat, string> = { step: 'application/step', stl: 'model/stl', brep: 'application/octet-stream', svg: 'image/svg+xml', dxf: 'image/vnd.dxf', gltf: 'model/gltf+json', glb: 'model/gltf-binary', obj: 'model/obj', '3mf': 'model/3mf' }
function colorHex(value: any, fallback = '#a3a3a3'): string {
  const color = value?.rgba ?? value
  if (Array.isArray(color)) return '#' + color.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('')
  if (typeof color === 'string') return '#' + new ThreeColor(color.replace(/^ColorIndex\./, '').toLowerCase()).getHexString()
  return fallback
}
function abort(signal?: AbortSignal | null) { signal?.throwIfAborted() }
function safeName(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(value)) throw new TypeError('A file name must not contain parent-directory traversal')
  return value.split(/[\\/]/).at(-1)!.replace(/[^\w. -]/g, '_') || 'model.bin'
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice()
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  if (typeof value === 'string') return encoder.encode(value)
  if (value && typeof value === 'object' && '$bytes' in value) return base64Bytes(String(value.$bytes))
  throw new TypeError('Expected text or binary file content')
}

/** Python-compatible in-memory stream; it never touches the network or host filesystem. */
export class BrowserStream {
  readonly kind: 'BytesIO' | 'StringIO'
  private data: Uint8Array | string
  private position = 0
  closed = false
  constructor(kind: 'bytes' | 'text', value: unknown = kind === 'text' ? '' : new Uint8Array()) {
    this.kind = kind === 'text' ? 'StringIO' : 'BytesIO'
    this.data = kind === 'text' ? typeof value === 'string' ? value : decoder.decode(bytes(value)) : bytes(value)
  }
  private assertOpen() { if (this.closed) throw new Error('I/O operation on closed stream') }
  getvalue(): Uint8Array | string { this.assertOpen(); return typeof this.data === 'string' ? this.data : this.data.slice() }
  tell(): number { this.assertOpen(); return this.position }
  seek(offset: number, whence = 0): number {
    this.assertOpen()
    if (![0, 1, 2].includes(whence) || !Number.isInteger(offset)) throw new RangeError('Invalid stream seek')
    const position = offset + (whence === 1 ? this.position : whence === 2 ? this.data.length : 0)
    if (position < 0) throw new RangeError('Negative stream position')
    this.position = position; return position
  }
  read(size = -1): Uint8Array | string {
    this.assertOpen(); const end = size < 0 ? this.data.length : Math.min(this.data.length, this.position + size)
    const value = this.data.slice(this.position, end); this.position = end; return value
  }
  readline(size = -1): Uint8Array | string {
    this.assertOpen(); const newline = this.data.indexOf(typeof this.data === 'string' ? '\n' as never : 10 as never, this.position)
    const available = newline < 0 ? this.data.length - this.position : newline + 1 - this.position
    return this.read(size < 0 ? available : Math.min(size, available))
  }
  write(value: unknown): number {
    this.assertOpen()
    if (this.kind === 'StringIO') {
      if (typeof value !== 'string') throw new TypeError('StringIO.write expects a string')
      const old = this.data as string
      this.data = old.slice(0, this.position).padEnd(this.position, '\0') + value + old.slice(this.position + value.length)
      this.position += value.length; return value.length
    }
    const incoming = bytes(value), old = this.data as Uint8Array
    const replacement = new Uint8Array(Math.max(old.length, this.position + incoming.length))
    replacement.set(old); replacement.set(incoming, this.position); this.data = replacement
    this.position += incoming.length; return incoming.length
  }
  truncate(size = this.position): number {
    this.assertOpen(); if (!Number.isInteger(size) || size < 0) throw new RangeError('Invalid stream size')
    if (size < this.data.length) this.data = this.data.slice(0, size)
    return size
  }
  flush(): void { this.assertOpen() }
  close(): void { this.closed = true }
  readable(): boolean { return !this.closed }
  writable(): boolean { return !this.closed }
  seekable(): boolean { return !this.closed }
  replace(value: Uint8Array | string): void { this.assertOpen(); this.data = this.kind === 'StringIO' ? typeof value === 'string' ? value : decoder.decode(value) : bytes(value); this.position = 0 }
}

type FileContext = KernelContext & {
  encode(value: any): any
  render(plan: Build123dPlan): any
  evaluatePlan?(plan: Build123dPlan): any
}
const stores = new WeakMap<KernelContext, KernelFileStore>()

/** Files belong to an isolated OpenCascade WASM filesystem and local JS memory. */
export class KernelFileStore {
  private files = new Map<string, { info: NativeFile; bytes: Uint8Array }>()
  private sequence = 0
  private inlineFiles = new Map<string, string[]>()
  readonly root: string
  constructor(readonly context: KernelContext) {
    this.root = `/b123-files-${Math.random().toString(36).slice(2)}`
    context.oc.FS.mkdir(this.root); stores.set(context, this)
  }
  private path(name: string): string {
    if (name.startsWith(`${this.root}/`) && !name.slice(this.root.length + 1).includes('/')) return name
    return `${this.root}/${safeName(name)}`
  }
  materialize(value: NativeFileValue | NativeFileValue['$file']): string {
    const file = '$file' in value ? value.$file : value
    const content = base64Bytes(file.base64)
    if (content.length > MAX_FILE_SIZE) throw new RangeError('Files must be no larger than 32 MiB')
    let hash = 2166136261
    for (const byte of content) hash = Math.imul(hash ^ byte, 16777619)
    const key = `${safeName(file.name)}:${content.length}:${hash >>> 0}`
    for (const existingPath of this.inlineFiles.get(key) ?? []) {
      const existing = this.context.oc.FS.readFile(existingPath)
      if (content.every((byte, index) => byte === existing[index])) return existingPath
    }
    const path = this.path(`inline-${++this.sequence}-${safeName(file.name)}`)
    this.context.oc.FS.writeFile(path, content); this.inlineFiles.set(key, [...this.inlineFiles.get(key) ?? [], path]); return path
  }
  async uploadFile(contents: NativeBinaryInput, options: NativeFileOptions = {}): Promise<NativeFile> {
    abort(options.signal)
    const blob = fileBlob(contents)
    if (blob.size > MAX_FILE_SIZE) throw new RangeError('Files must be no larger than 32 MiB')
    const content = new Uint8Array(await blob.arrayBuffer()); abort(options.signal)
    const name = safeName(options.filename ?? fileName(contents)), id = `file-${this.root.slice(1)}-${++this.sequence}`
    const path = this.path(`${id}-${name}`)
    const format = name.split('.').at(-1)?.toLowerCase() as NativeFileFormat
    const info = { id, name, path, size: content.length, contentType: mimeTypes[format] ?? 'application/octet-stream' }
    this.context.oc.FS.writeFile(path, content); this.files.set(id, { info, bytes: content }); return info
  }
  downloadFile(file: NativeFile | string, options: NativeFileOptions = {}): Blob {
    abort(options.signal); const stored = this.files.get(typeof file === 'string' ? file : file.id)
    if (!stored) throw new Error('Unknown file ID')
    return new Blob([stored.bytes.slice().buffer], { type: stored.info.contentType })
  }
  deleteFile(file: NativeFile | string, options: NativeFileOptions = {}): void {
    abort(options.signal); const id = typeof file === 'string' ? file : file.id, stored = this.files.get(id)
    if (!stored) throw new Error('Unknown file ID')
    this.context.oc.FS.unlink(stored.info.path); this.files.delete(id)
  }
  read(input: unknown): Uint8Array {
    if (input instanceof BrowserStream) return bytes(input.getvalue())
    if (typeof input !== 'string') return bytes(input)
    return this.context.oc.FS.readFile(this.path(input)).slice()
  }
  write(output: unknown, content: Uint8Array | string): void {
    if (output instanceof BrowserStream) { output.write(output.kind === 'StringIO' ? typeof content === 'string' ? content : decoder.decode(content) : bytes(content)); return }
    if (typeof output !== 'string') throw new TypeError('Expected a virtual file path or BytesIO/StringIO')
    this.context.oc.FS.writeFile(this.path(output), bytes(content))
  }
  import(format: NativeFileFormat, input: unknown, options: Record<string, any> = {}): KernelShape | KernelShape[] {
    const { oc, replicad: r } = this.context
    r.setOC(oc)
    if (format === 'svg') return importSvg(decoder.decode(this.read(input)), this.context, options)
    if (format === 'dxf') return importDxf(decoder.decode(this.read(input)), this.context)
    if (format === 'brep') {
      const shape = r.deserializeShape(decoder.decode(this.read(input)))
      return shapeValue(shape)
    }
    if (format !== 'step' && format !== 'stl') throw new Error(`Importing ${format.toUpperCase()} is not supported`)
    const path = this.path(`import-${++this.sequence}.${format}`)
    oc.FS.writeFile(path, this.read(input))
    try {
      if (format === 'step') {
        const reader = new oc.STEPControl_Reader()
        try {
          if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Invalid STEP file')
          if (!reader.TransferRoots()) throw new Error('STEP file contains no transferrable geometry')
          const wrapped = reader.OneShape()
          if (wrapped.IsNull()) { wrapped.delete(); throw new Error('STEP file contains no geometry') }
          return shapeValue(r.cast(wrapped))
        } finally { reader.delete() }
      }
      const reader = new oc.StlAPI_Reader(), shell = new oc.TopoDS_Shell()
      try {
        if (!reader.Read(shell, path)) throw new Error('Invalid STL file')
        // StlAPI_Reader returns independent triangular faces, often in a compound.
        // Sew them before constructing a solid instead of assuming a shell type.
        const imported = r.cast(shell), sewn = r.weldShellsAndFaces(imported.faces, true)
        return shapeValue(sewn.wrapped.Closed() ? r.makeSolid([sewn]) : sewn)
      } finally { reader.delete() }
    } finally { oc.FS.unlink(path) }
  }
  async importFile(contents: NativeBinaryInput, options: NativeImportOptions = {}): Promise<any> {
    abort(options.signal)
    const name = safeName(options.filename ?? fileName(contents, `model.${options.format ?? 'step'}`))
    const suffix = name.split('.').at(-1)?.toLowerCase(), format = options.format ?? (suffix === 'stp' ? 'step' : suffix as NativeFileFormat)
    if (!['step', 'stl', 'brep', 'svg', 'dxf'].includes(format)) throw new Error(`Unsupported CAD import format: ${format}`)
    const blob = fileBlob(contents)
    if (blob.size > MAX_FILE_SIZE) throw new RangeError('Files must be no larger than 32 MiB')
    const content = new Uint8Array(await blob.arrayBuffer()); abort(options.signal)
    const inline: NativeFileValue = { $file: { name, base64: bytesBase64(content) } }
    const plan: Build123dPlan = { version: 1, children: [{ type: `import_${format}`, props: { args: [inline], ...(options.kwargs ?? {}) } as any, children: [] }] }
    const value = this.import(format, this.materialize(inline), options.kwargs as Record<string, any>)
    const ctx = this.context as FileContext
    return { value: ctx.encode(value), plan, result: ctx.render(plan) }
  }
  export(format: NativeFileFormat, target: unknown, options: Record<string, any> = {}): Uint8Array {
    const { oc, replicad: r } = this.context
    r.setOC(oc)
    const shapes = shapeList(target)
    if (!shapes.length) throw new Error('No CAD shapes to export')
    const shape = shapes.length === 1 ? shapes[0].shape : r.makeCompound(shapes.map(item => item.shape.clone()))
    if (format === 'brep') return encoder.encode(shape.serialize())
    if (format === 'svg' || format === 'dxf') return encoder.encode(exportVector(format, shapes, this.context, options))
    if (['gltf', 'glb', 'obj', '3mf'].includes(format)) return exportMesh(format, shapes, this.context, options)
    const path = this.path(`export-${++this.sequence}.${format}`)
    try {
      if (format === 'step') {
        const doc = r.createAssembly(shapes.map(item => ({ shape: item.shape, name: item.label ?? item.kind, color: colorHex(item.color) })))
        const session = new oc.XSControl_WorkSession(), writer = new oc.STEPCAFControl_Writer(session, false), progress = new oc.Message_ProgressRange()
        try {
          writer.SetColorMode(true); writer.SetNameMode(true); writer.SetLayerMode(true)
          oc.Interface_Static.SetCVal('write.step.unit', String(options.unit ?? 'MM').replace(/^Unit\./, '').toUpperCase())
          oc.Interface_Static.SetIVal('write.surfacecurve.mode', options.write_pcurves === false ? 0 : 1)
          oc.Interface_Static.SetIVal('write.precision.mode', options.precision_mode === 'MIN' ? -1 : options.precision_mode === 'MAX' ? 1 : 0)
          oc.Interface_Static.SetIVal('write.step.schema', 5)
          if (!writer.Perform(doc.wrapped, path, progress)) throw new Error('OpenCascade failed to export STEP')
        } finally { progress.delete(); writer.delete(); session.delete(); doc.delete() }
      } else if (format === 'stl') {
        shape.mesh({ tolerance: options.tolerance ?? options.linear_deflection ?? 0.001, angularTolerance: options.angular_tolerance ?? options.angular_deflection ?? 0.1 })
        const ascii = options.ascii_format ?? options.ascii ?? false
        if (!oc.StlAPI.Write(shape.wrapped, path, !!ascii)) throw new Error('OpenCascade failed to export STL')
      } else throw new Error(`Unsupported export format ${format}`)
      return oc.FS.readFile(path).slice()
    } finally { try { oc.FS.unlink(path) } catch {} }
  }
  async exportFile(target: unknown, format: NativeFileFormat, options: NativeExportOptions = {}): Promise<Blob> {
    abort(options.signal); const ctx = this.context as FileContext
    if (target && typeof target === 'object' && 'version' in target && 'children' in target) {
      if (!ctx.evaluatePlan) throw new Error('Kernel does not expose plan evaluation')
      target = ctx.evaluatePlan(target as Build123dPlan)
    } else target = ctx.decode(target)
    const content = this.export(format, target, options.kwargs as Record<string, any>); abort(options.signal)
    return new Blob([content.buffer as ArrayBuffer], { type: mimeTypes[format] })
  }
  async createStream(contents: NativeBinaryInput | string = new Uint8Array(), options: { kind?: 'bytes' | 'text'; signal?: AbortSignal | null } = {}): Promise<any> {
    abort(options.signal); const kind = options.kind ?? (typeof contents === 'string' ? 'text' : 'bytes')
    const content = typeof contents === 'string' ? contents : new Uint8Array(await fileBlob(contents).arrayBuffer()); abort(options.signal)
    return { value: (this.context as FileContext).encode(new BrowserStream(kind, content)) }
  }
  readStream(value: unknown): Uint8Array | string { const stream = this.context.decode(value); if (!(stream instanceof BrowserStream)) throw new TypeError('Expected BytesIO/StringIO'); return stream.getvalue() }
  async writeStream(value: unknown, contents: NativeBinaryInput | string): Promise<void> {
    const stream = this.context.decode(value); if (!(stream instanceof BrowserStream)) throw new TypeError('Expected BytesIO/StringIO')
    stream.replace(typeof contents === 'string' ? contents : new Uint8Array(await fileBlob(contents).arrayBuffer()))
  }
  dispose(): void {
    for (const name of this.context.oc.FS.readdir(this.root)) { if (name !== '.' && name !== '..') this.context.oc.FS.unlink(`${this.root}/${name}`) }
    this.context.oc.FS.rmdir(this.root); this.files.clear(); this.inlineFiles.clear(); stores.delete(this.context)
  }
}

export function fileStore(context: KernelContext): KernelFileStore { return stores.get(context) ?? new KernelFileStore(context) }
export function registerFileHandlers(context: KernelContext, store = fileStore(context)): Record<string, KernelHandler> {
  const handlers: Record<string, KernelHandler> = {
    BytesIO: (args, kwargs) => new BrowserStream('bytes', args[0] ?? kwargs.initial_bytes ?? new Uint8Array()),
    StringIO: (args, kwargs) => new BrowserStream('text', args[0] ?? kwargs.initial_value ?? ''),
    ExportSVG: (args, kwargs) => new VectorExporter('svg', store, kwargs),
    ExportDXF: (args, kwargs) => new VectorExporter('dxf', store, kwargs),
    Mesher: (args, kwargs) => new BrowserMesher(store, args[0] ?? kwargs.unit ?? 'Unit.MM'),
  }
  for (const format of ['step', 'stl', 'brep', 'svg', 'dxf'] as const) handlers[`import_${format}`] = (args, kwargs) => store.import(format, args[0] ?? kwargs.file_name ?? kwargs.file_path ?? kwargs.svg_file ?? kwargs.dxf_file, kwargs)
  for (const format of ['step', 'stl', 'brep', 'gltf', 'obj'] as const) handlers[`export_${format}`] = (args, kwargs) => {
    const target = args[0] ?? kwargs.to_export, output = args[1] ?? kwargs.file_path
    const options = { ...kwargs }
    const positional = format === 'step' ? ['unit', 'write_pcurves', 'precision_mode'] : format === 'stl' ? ['tolerance', 'angular_tolerance', 'ascii_format'] : ['linear_deflection', 'angular_deflection', 'include_uvs', 'atlas_packing', 'atlas_gutter']
    positional.forEach((key, index) => { if (args[index + 2] !== undefined) options[key] = args[index + 2] })
    store.write(output, store.export(format === 'gltf' && typeof output === 'string' && output.endsWith('.glb') ? 'glb' : format, target, options)); return true
  }
  Object.assign(context.handlers, handlers); return handlers
}

export function callFileMethod(target: unknown, name: string, args: any[], kwargs: Record<string, any>): { handled: boolean; value?: any } {
  if (!(target instanceof BrowserStream || target instanceof BrowserMesher || target instanceof VectorExporter)) return { handled: false }
  const signatures: Record<string, string[]> = target instanceof BrowserMesher ? {
    add_shape: ['shape', 'linear_deflection', 'angular_deflection', 'mesh_type', 'part_number', 'uuid_value'],
    add_meta_data: ['name_space', 'name', 'value', 'metadata_type', 'must_preserve'],
    get_meta_data: [], get_meta_data_by_key: ['name_space', 'name'], get_mesh_properties: [], read: ['file_name'], write: ['file_name'], write_stream: ['stream', 'file_type'],
  } : target instanceof VectorExporter ? {
    add_shape: ['shape', 'layer'], write: ['file_name'],
    add_layer: target.kind === 'ExportSVG' ? ['name', 'fill_color', 'line_color', 'line_weight', 'line_type'] : ['name', 'color', 'line_weight', 'line_type'],
  } : { seek: ['offset', 'whence'], read: ['size'], readline: ['size'], write: [target.kind === 'StringIO' ? 's' : 'b'], truncate: ['size'], tell: [], getvalue: [], flush: [], close: [], readable: [], writable: [], seekable: [] }
  const signature = signatures[name]
  if (!signature) throw new TypeError(`${target.kind} has no method ${name}`)
  const values = [...args]
  for (const [key, value] of Object.entries(kwargs)) {
    const index = signature.indexOf(key)
    if (index < 0) throw new TypeError(`Unknown ${target.kind}.${name} keyword ${key}`)
    if (index < args.length) throw new TypeError(`Multiple values for ${target.kind}.${name} argument ${key}`)
    values[index] = value
  }
  if (target instanceof VectorExporter && name === 'add_layer') return { handled: true, value: target.add_layer(values[0], Object.fromEntries(signature.slice(1).map((key, index) => [key, values[index + 1]]))) }
  return { handled: true, value: (target as any)[name](...values) }
}

interface MeshMetadata { name: string; part_number: string; type: string; uuid: string }
class BrowserMesher {
  readonly kind = 'Mesher'
  private shapes: KernelShape[] = []
  private meshOptions: Record<string, any> = {}
  private metadata: { name_space: string; name: string; value: string; type: string; must_preserve: boolean }[] = []
  private properties: MeshMetadata[] = []
  unit: string
  constructor(private store: KernelFileStore, unit = 'Unit.MM') { this.unit = unit }
  get model_unit(): string { return this.unit }
  get mesh_count(): number { return this.shapes.length }
  get vertex_counts(): number[] { return this.shapes.map(item => deduplicateMesh(shapeMesh(item, this.meshOptions)).positions.length / 3) }
  get triangle_counts(): number[] { return this.shapes.map(item => shapeMesh(item, this.meshOptions).indices.length / 3) }
  get library_version(): string { return '3MF Core 1.3 (JavaScript)' }
  add_shape(input: unknown, linear_deflection = 0.001, angular_deflection = 0.1, mesh_type = 'MeshType.MODEL', part_number: string | null = null, uuid_value: string | null = null): void {
    this.store.context.replicad.setOC(this.store.context.oc)
    this.meshOptions = { linear_deflection, angular_deflection }
    for (const item of shapeList(input)) {
      const mesh = shapeMesh(item, this.meshOptions)
      if (!mesh.indices.length) throw new Error('Cannot add a degenerate shape to Mesher')
      this.shapes.push(item)
      this.properties.push({ name: item.label ?? '', part_number: part_number ?? '', type: String(mesh_type).split('.').at(-1)!, uuid: uuid_value ?? '' })
    }
  }
  add_meta_data(name_space: string, name: string, value: string, metadata_type: string, must_preserve: boolean): void {
    this.metadata.push({ name_space, name, value, type: metadata_type, must_preserve })
  }
  get_meta_data(): Omit<BrowserMesher['metadata'][number], 'must_preserve'>[] { return this.metadata.map(({ must_preserve, ...entry }) => ({ ...entry })) }
  get_meta_data_by_key(name_space: string, name: string): { type: string; value: string } {
    const entry = this.metadata.find(item => item.name_space === name_space && item.name === name)
    if (!entry) throw new Error('Unknown metadata key')
    return { type: entry.type, value: entry.value }
  }
  get_mesh_properties(): MeshMetadata[] { return this.properties.map(item => ({ ...item })) }
  private output(format: '3mf' | 'stl'): Uint8Array {
    return this.store.export(format, this.shapes, { ...this.meshOptions, unit: this.unit, metadata: this.metadata, meshMetadata: this.properties, precomputedMeshes: this.shapes.map(item => deduplicateMesh(shapeMesh(item, this.meshOptions))) })
  }
  write(path: string): void {
    const format = path.split('.').at(-1)?.toLowerCase()
    if (format !== '3mf' && format !== 'stl') throw new Error('Unknown file format; Mesher writes 3mf or stl')
    this.store.write(path, this.output(format))
  }
  write_stream(stream: BrowserStream, file_type: '3mf' | 'stl'): void {
    if (file_type !== '3mf' && file_type !== 'stl') throw new Error('Unknown file format; Mesher writes 3mf or stl')
    this.store.write(stream, this.output(file_type))
  }
  read(path: string): KernelShape[] {
    const format = path.split('.').at(-1)?.toLowerCase()
    if (format === 'stl') { const result = shapeList(this.store.import('stl', path)); result.forEach(item => this.add_shape(item)); return result }
    if (format !== '3mf') throw new Error('Unknown file format; Mesher reads 3mf or stl')
    const archive = unzipSync(this.store.read(path), { filter: file => {
      if (!/(?:^|\/)3dmodel\.model$/i.test(file.name)) return false
      if (file.originalSize > MAX_FILE_SIZE) throw new RangeError('3MF model data must be no larger than 32 MiB')
      return true
    } }), modelName = Object.keys(archive).find(name => /(?:^|\/)3dmodel\.model$/i.test(name))
    if (!modelName) throw new Error('3MF archive contains no 3D model')
    const source = strFromU8(archive[modelName])
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Invalid 3MF model XML')
    const modelAttributes = svgAttributes(source.match(/<(?:\w+:)?model\b([^>]*)>/)?.[1] ?? '')
    const units: Record<string, string> = { micron: 'Unit.MC', millimeter: 'Unit.MM', centimeter: 'Unit.CM', inch: 'Unit.IN', foot: 'Unit.FT', meter: 'Unit.M' }
    this.unit = units[modelAttributes.unit ?? 'millimeter'] ?? 'Unit.MM'
    for (const metadata of source.matchAll(/<(?:\w+:)?metadata\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?metadata>/g)) {
      const attributes = svgAttributes(metadata[1]), name = attributes.name ?? '', split = name.lastIndexOf(':')
      this.add_meta_data(split >= 0 ? name.slice(0, split) : '', split >= 0 ? name.slice(split + 1) : name, metadata[2].replace(/&(?:amp|lt|gt|quot|apos);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[value]!), attributes.type ?? 'string', attributes.preserve === '1')
    }
    const objects = new Map<string, { attributes: Record<string, string>; vertices: number[][]; indices: number[]; components: { objectid: string; transform?: string }[] }>()
    for (const object of source.matchAll(/<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
      const attributes = svgAttributes(object[1]), vertices = [...object[2].matchAll(/<(?:\w+:)?vertex\b([^>]*)\/?\s*>/g)].map(match => { const attr = svgAttributes(match[1]); const point = [Number(attr.x), Number(attr.y), Number(attr.z)]; if (point.some(value => !Number.isFinite(value))) throw new Error('Invalid 3MF vertex'); return point })
      const indices = [...object[2].matchAll(/<(?:\w+:)?triangle\b([^>]*)\/?\s*>/g)].flatMap(match => { const attr = svgAttributes(match[1]); const face = [Number(attr.v1), Number(attr.v2), Number(attr.v3)]; if (face.some(index => !Number.isInteger(index) || index < 0 || index >= vertices.length)) throw new Error('Invalid 3MF triangle index'); return face })
      const components = [...object[2].matchAll(/<(?:\w+:)?component\b([^>]*)\/?\s*>/g)].map(match => svgAttributes(match[1]) as { objectid: string; transform?: string })
      objects.set(attributes.id, { attributes, vertices, indices, components })
    }
    const transform = (point: number[], input?: string): number[] => {
      if (!input) return point
      const m = input.split(/\s+/).map(Number)
      if (m.length !== 12 || m.some(value => !Number.isFinite(value))) throw new Error('Invalid 3MF object transform')
      return [point[0] * m[0] + point[1] * m[3] + point[2] * m[6] + m[9], point[0] * m[1] + point[1] * m[4] + point[2] * m[7] + m[10], point[0] * m[2] + point[1] * m[5] + point[2] * m[8] + m[11]]
    }
    const native = this.store.context.replicad; native.setOC(this.store.context.oc)
    const collect = (id: string, ancestors = new Set<string>()): { vertices: number[][]; indices: number[] } => {
      if (ancestors.has(id)) throw new Error('Cyclic 3MF component hierarchy')
      const object = objects.get(id); if (!object) throw new Error('Unknown 3MF component object')
      const path = new Set(ancestors).add(id), vertices = [...object.vertices], indices = [...object.indices]
      for (const component of object.components) { const child = collect(component.objectid, path), offset = vertices.length; vertices.push(...child.vertices.map(point => transform(point, component.transform))); indices.push(...child.indices.map(index => index + offset)) }
      return { vertices, indices }
    }
    const build = source.match(/<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/)?.[1]
    const items: Record<string, string>[] = build ? [...build.matchAll(/<(?:\w+:)?item\b([^>]*)\/?\s*>/g)].map(match => svgAttributes(match[1])) : [...objects.keys()].map(objectid => ({ objectid }))
    const colors = new Map<string, string[]>()
    for (const material of source.matchAll(/<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g)) colors.set(svgAttributes(material[1]).id, [...material[2].matchAll(/<(?:\w+:)?base\b([^>]*)\/?\s*>/g)].map(match => svgAttributes(match[1]).displaycolor))
    const results: KernelShape[] = []
    for (const item of items) {
      const object = objects.get(item.objectid); if (!object) throw new Error('Unknown 3MF build object')
      const mesh = collect(item.objectid), vertices = mesh.vertices.map(point => transform(point, item.transform)), faces = []
      if (!mesh.indices.length) throw new Error('3MF object contains no triangles')
      for (let index = 0; index < mesh.indices.length; index += 3) faces.push(native.makePolygon(mesh.indices.slice(index, index + 3).map(vertex => vertices[vertex] as [number, number, number])))
      const sewn = native.weldShellsAndFaces(faces, true), shape = sewn.wrapped.Closed() ? native.makeSolid([sewn]) : sewn
      const color = colors.get(object.attributes.pid)?.[Number(object.attributes.pindex ?? 0)]
      const value = shapeValue(shape, undefined, { label: object.attributes.name, color: color?.slice(0, 7) })
      this.shapes.push(value); this.properties.push({ name: object.attributes.name ?? '', part_number: object.attributes.partnumber ?? '', type: (object.attributes.type ?? 'model').toUpperCase(), uuid: object.attributes['p:UUID'] ?? '' }); results.push(value)
    }
    return results
  }
}

class VectorExporter {
  readonly kind: 'ExportSVG' | 'ExportDXF'
  private shapes: KernelShape[] = []
  private layers = new Map<string, Record<string, any>>()
  constructor(private format: 'svg' | 'dxf', private store: KernelFileStore, private options: Record<string, any>) { this.kind = format === 'svg' ? 'ExportSVG' : 'ExportDXF' }
  add_layer(name: string, options: Record<string, any> = {}): this { if (this.layers.has(name)) throw new Error(`Duplicate layer name ${name}`); this.layers.set(name, options); return this }
  add_shape(shape: unknown, layer = ''): this { if (layer && !this.layers.has(layer)) throw new Error(`Unknown layer ${layer}`); this.shapes.push(...shapeList(shape).map(item => ({ ...item, label: layer || item.label }))); return this }
  write(output: unknown): boolean { this.store.write(output, this.store.export(this.format, this.shapes, { ...this.options, layers: this.layers })); return true }
}

type Point2 = [number, number]
function xmlEscape(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!) }
function svgAttributes(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1], match[3].replace(/&(?:amp|lt|gt|quot|apos);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[value]!)]))
}
function svgPaths(source: string, context: KernelContext): { drawing: any; closed: boolean }[] {
  const tokens = source.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []
  const drawings: { drawing: any; closed: boolean }[] = []
  let index = 0, command = '', point: Point2 = [0, 0], start: Point2 = [0, 0], pen: any, control: Point2 | undefined, previous = ''
  const read = (): number => { if (index >= tokens.length || /^[a-zA-Z]$/.test(tokens[index])) throw new Error('Malformed SVG path'); const n = Number(tokens[index++]); if (!Number.isFinite(n)) throw new Error('Invalid SVG coordinate'); return n }
  const finish = (closed = false) => { if (pen) drawings.push({ drawing: closed ? pen.close() : pen.done(), closed }); pen = undefined }
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index])) command = tokens[index++]
    if (!command) throw new Error('SVG path must start with a command')
    const upper = command.toUpperCase(), relative = upper !== command
    const nextPoint = (): Point2 => { const x = read(), y = read(); return [x + (relative ? point[0] : 0), y + (relative ? point[1] : 0)] }
    const reflect = (): Point2 => control ? [point[0] * 2 - control[0], point[1] * 2 - control[1]] : [...point]
    if (upper === 'M') { finish(); point = nextPoint(); start = [...point]; pen = context.replicad.draw(point); command = relative ? 'l' : 'L'; control = undefined }
    else if (upper === 'Z') { finish(true); point = [...start]; command = ''; control = undefined }
    else {
      if (!pen) throw new Error('SVG path segment has no starting point')
      if (upper === 'L') { point = nextPoint(); pen.lineTo(point); control = undefined }
      else if (upper === 'H') { point = [read() + (relative ? point[0] : 0), point[1]]; pen.lineTo(point); control = undefined }
      else if (upper === 'V') { point = [point[0], read() + (relative ? point[1] : 0)]; pen.lineTo(point); control = undefined }
      else if (upper === 'C') { const first = nextPoint(), second = nextPoint(), end = nextPoint(); pen.cubicBezierCurveTo(end, first, second); point = end; control = second }
      else if (upper === 'S') { const first: Point2 = ['C', 'S'].includes(previous) ? reflect() : [...point], second = nextPoint(), end = nextPoint(); pen.cubicBezierCurveTo(end, first, second); point = end; control = second }
      else if (upper === 'Q') { const first = nextPoint(), end = nextPoint(); pen.quadraticBezierCurveTo(end, first); point = end; control = first }
      else if (upper === 'T') { const first: Point2 = ['Q', 'T'].includes(previous) ? reflect() : [...point], end = nextPoint(); pen.quadraticBezierCurveTo(end, first); point = end; control = first }
      else if (upper === 'A') { const rx = read(), ry = read(), rotation = read(), large = read(), sweep = read(), end = nextPoint(); if (![0, 1].includes(large) || ![0, 1].includes(sweep)) throw new Error('Invalid SVG arc flags'); if (!rx || !ry) pen.lineTo(end); else pen.ellipseTo(end, Math.abs(rx), Math.abs(ry), rotation, !!large, !!sweep); point = end; control = undefined }
      else throw new Error(`Unsupported SVG path command ${command}`)
    }
    previous = upper
  }
  finish(); return drawings
}
function svgTransform(drawing: any, source: string): any {
  const transforms = [...source.matchAll(/([\w]+)\s*\(([^)]*)\)/g)]
  for (const transform of transforms.reverse()) {
    const values = transform[2].trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (values.some(value => !Number.isFinite(value))) throw new Error('Invalid SVG transform')
    const [a, b, c] = values
    if (transform[1] === 'translate') drawing = drawing.translate(a, b ?? 0)
    else if (transform[1] === 'rotate') drawing = drawing.rotate(a, [b ?? 0, c ?? 0])
    else if (transform[1] === 'scale') { drawing = drawing.stretch(a, [1, 0], [0, 0]).stretch(b ?? a, [0, 1], [0, 0]) }
    else if (transform[1] === 'matrix') {
      const [m00, m10, m01, m11, tx, ty] = values
      if (values.length !== 6) throw new Error('SVG matrix requires six coordinates')
      const sx = Math.hypot(m00, m10), angle = Math.atan2(m10, m00) * 180 / Math.PI
      if (Math.abs(m00 * m01 + m10 * m11) > 1e-8) throw new Error('Sheared SVG matrix transforms are not supported')
      const sy = (m00 * m11 - m10 * m01) / sx
      drawing = drawing.stretch(sx, [1, 0], [0, 0]).stretch(sy, [0, 1], [0, 0]).rotate(angle).translate(tx, ty)
    } else throw new Error(`Unsupported SVG transform ${transform[1]}`)
  }
  return drawing
}
function filledSvgFaces(drawings: any[], context: KernelContext, rule: string): any[] {
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new Error(`Unsupported SVG fill-rule ${rule}`)
  const blueprints = drawings.map(drawing => drawing.blueprint), parents = new Array<number>(blueprints.length).fill(-1)
  for (let index = 0; index < blueprints.length; index++) {
    const containers: number[] = []
    for (let other = 0; other < blueprints.length; other++) {
      if (index === other) continue
      if (blueprints[index].intersects(blueprints[other])) throw new Error('Intersecting SVG subpaths require boolean simplification before importing')
      if (blueprints[other].isInside(blueprints[index].firstPoint)) containers.push(other)
    }
    containers.sort((a, b) => blueprints[a].boundingBox.width * blueprints[a].boundingBox.height - blueprints[b].boundingBox.width * blueprints[b].boundingBox.height)
    parents[index] = containers[0] ?? -1
  }
  const ancestors = (index: number) => { const list: number[] = [], seen = new Set<number>(); for (let parent = parents[index]; parent !== -1; parent = parents[parent]) { if (seen.has(parent)) throw new Error('Invalid SVG subpath containment'); seen.add(parent); list.push(parent) }; return list }
  const sign = (index: number) => blueprints[index].orientation === 'counterClockwise' ? 1 : -1
  const transitions = blueprints.map((_, index) => {
    const outer = ancestors(index), winding = outer.reduce((sum, other) => sum + sign(other), 0)
    const outside = rule === 'evenodd' ? outer.length % 2 === 1 : winding !== 0, inside = rule === 'evenodd' ? !outside : winding + sign(index) !== 0
    return outside === inside ? 0 : inside ? 1 : -1
  })
  return transitions.flatMap((transition, index) => {
    if (transition !== 1) return []
    const holes = blueprints.filter((_, other) => transitions[other] === -1 && ancestors(other).find(ancestor => transitions[ancestor] === 1) === index)
    const sketch = holes.length ? new context.replicad.CompoundBlueprint([blueprints[index], ...holes]).sketchOnPlane('XY') : blueprints[index].sketchOnPlane('XY')
    return [sketch.face()]
  })
}
function importSvg(source: string, context: KernelContext, options: Record<string, any> = {}): KernelShape[] {
  if (!/<svg\b/i.test(source) || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Invalid SVG document')
  const stack: { tag: string; attributes: Record<string, string> }[] = [], results: KernelShape[] = [], r = context.replicad
  for (const match of source.matchAll(/<\s*(\/?)\s*([\w:-]+)\b([^>]*?)(\/?)>/gs)) {
    const [, closing, tag, attributeSource, selfClosing] = match
    if (closing) { if (stack.at(-1)?.tag === tag) stack.pop(); continue }
    const attributes = svgAttributes(attributeSource)
    const styles = Object.assign({}, ...stack.map(item => item.attributes), attributes)
    if (options.ignore_visibility !== true && (/display\s*:\s*none|visibility\s*:\s*hidden/.test(styles.style ?? '') || styles.display === 'none' || styles.visibility === 'hidden')) { if (!selfClosing) stack.push({ tag, attributes }); continue }
    const n = (key: string, fallback = 0) => { const value = parseFloat(attributes[key] ?? String(fallback)); if (!Number.isFinite(value)) throw new Error(`Invalid SVG ${key}`); return value }
    let drawings: { drawing: any; closed: boolean }[] = []
    if (tag === 'path') drawings = svgPaths(attributes.d ?? '', context)
    else if (tag === 'rect') { const width = n('width'), height = n('height'), x = n('x'), y = n('y'), radius = n('rx', n('ry')); if (width > 0 && height > 0) drawings = [{ drawing: (radius ? r.drawRoundedRectangle(width, height, radius) : r.drawRectangle(width, height)).translate(x + width / 2, y + height / 2), closed: true }] }
    else if (tag === 'circle' || tag === 'ellipse') { const rx = n(tag === 'circle' ? 'r' : 'rx'), ry = n(tag === 'circle' ? 'r' : 'ry'); if (rx > 0 && ry > 0) drawings = [{ drawing: (rx === ry ? r.drawCircle(rx) : r.drawEllipse(rx, ry)).translate(n('cx'), n('cy')), closed: true }] }
    else if (tag === 'line') drawings = [{ drawing: r.draw([n('x1'), n('y1')]).lineTo([n('x2'), n('y2')]).done(), closed: false }]
    else if (tag === 'polyline' || tag === 'polygon') { const numbers = (attributes.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number); if (numbers.length % 2 || numbers.some(n => !Number.isFinite(n))) throw new Error('Invalid SVG points'); if (numbers.length >= 4) { const pen = r.draw([numbers[0], numbers[1]]); for (let index = 2; index < numbers.length; index += 2) pen.lineTo([numbers[index], numbers[index + 1]]); drawings = [{ drawing: tag === 'polygon' ? pen.close() : pen.done(), closed: tag === 'polygon' }] } }
    else if (['text', 'use', 'image', 'foreignObject'].includes(tag)) throw new Error(`SVG ${tag} geometry requires conversion to paths before importing`)
    const transforms = [...stack.map(item => item.attributes.transform).filter(Boolean), attributes.transform].filter(Boolean)
    const fill = styles.fill ?? styles.style?.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/)?.[1] ?? 'black'
    const transformed = drawings.map(({ drawing, closed }) => {
      for (const transform of [...transforms].reverse()) drawing = svgTransform(drawing, transform)
      if (options.flip_y !== false) drawing = drawing.mirror([1, 0], [0, 0], 'plane')
      return { drawing, closed }
    })
    const filled = transformed.filter(item => item.closed && fill !== 'none')
    if (filled.length > 1) {
      const rule = styles['fill-rule'] ?? styles.style?.match(/(?:^|;)\s*fill-rule\s*:\s*([^;]+)/)?.[1] ?? 'nonzero'
      for (const shape of filledSvgFaces(filled.map(item => item.drawing), context, rule)) results.push(shapeValue(shape, 'Face', { label: attributes[options.label_by ?? 'id'], color: fill }))
    }
    for (const { drawing, closed } of transformed) {
      if (filled.length > 1 && closed && fill !== 'none') continue
      const sketch = drawing.sketchOnPlane('XY') as any
      const shape = closed && fill !== 'none' ? sketch.face() : typeof sketch.wires === 'function' ? sketch.wires() : sketch.wires
      results.push(shapeValue(shape, closed && fill !== 'none' ? 'Face' : 'Wire', { label: attributes[options.label_by ?? 'id'], color: fill !== 'none' ? fill : undefined }))
    }
    if (!selfClosing && !['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(tag)) stack.push({ tag, attributes })
  }
  if (!results.length) throw new Error('SVG contains no supported geometry')
  if (options.align != null) {
    const all = r.makeCompound(results.map(item => item.shape.clone())), bounds = all.boundingBox.bounds, align = Array.isArray(options.align) ? options.align : [options.align, options.align]
    const displacement = [0, 1].map(axis => { const value = String(align[axis]).replace(/^Align\./, ''); return value === 'MIN' ? -bounds[0][axis] : value === 'MAX' ? -bounds[1][axis] : -(bounds[0][axis] + bounds[1][axis]) / 2 })
    results.forEach(item => { item.shape = item.shape.translate([displacement[0], displacement[1], 0]) })
  }
  return results
}

function importDxf(source: string, context: KernelContext): KernelShape[] {
  const lines = source.replace(/\r/g, '').split('\n'), pairs: [number, string][] = []
  for (let index = 0; index + 1 < lines.length; index += 2) { const code = Number(lines[index].trim()); if (!Number.isInteger(code)) throw new Error('Invalid DXF group code'); pairs.push([code, lines[index + 1].trim()]) }
  if (!pairs.some(([code, value]) => code === 2 && value === 'ENTITIES')) throw new Error('DXF contains no ENTITIES section')
  const results: KernelShape[] = [], r = context.replicad
  let inEntities = false
  for (let index = 0; index < pairs.length;) {
    const [code, type] = pairs[index++]
    if (code === 2 && type === 'ENTITIES') { inEntities = true; continue }
    if (code !== 0 || !inEntities) continue
    if (type === 'ENDSEC') { inEntities = false; continue }
    const fields: [number, string][] = []
    while (index < pairs.length && pairs[index][0] !== 0) fields.push(pairs[index++])
    const values = (code: number) => fields.filter(item => item[0] === code).map(item => Number(item[1]))
    const num = (code: number, fallback = 0) => { const raw = fields.find(item => item[0] === code)?.[1], value = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(value)) throw new Error('Invalid DXF coordinate'); return value }
    const p = (base = 10): [number, number, number] => [num(base), num(base + 10), num(base + 20)]
    const label = fields.find(item => item[0] === 8)?.[1]
    let shape: any
    if (type === 'LINE') shape = r.assembleWire([r.makeLine(p(), p(11))])
    else if (type === 'CIRCLE') shape = r.assembleWire([r.makeCircle(num(40), p())])
    else if (type === 'ARC') { const start = num(50) * Math.PI / 180, end = num(51) * Math.PI / 180; shape = r.assembleWire([r.makeEllipseArc(num(40), num(40), start, end > start ? end : end + 2 * Math.PI, p())]) }
    else if (type === 'ELLIPSE') { const center = p(), major = p(11), radius = Math.hypot(...major), ratio = num(40), start = num(41), end = num(42, 2 * Math.PI); shape = r.assembleWire([end - start >= 2 * Math.PI - 1e-8 ? r.makeEllipse(radius, radius * ratio, center, [0, 0, 1], major) : r.makeEllipseArc(radius, radius * ratio, start, end, center, [0, 0, 1], major)]) }
    else if (type === 'LWPOLYLINE') {
      const vertices: { point: Point2; bulge: number }[] = []
      for (let field = 0; field < fields.length; field++) if (fields[field][0] === 10) { const vertex = { point: [Number(fields[field][1]), 0] as Point2, bulge: 0 }; while (++field < fields.length && fields[field][0] !== 10) { if (fields[field][0] === 20) vertex.point[1] = Number(fields[field][1]); else if (fields[field][0] === 42) vertex.bulge = Number(fields[field][1]) } field--; vertices.push(vertex) }
      if (vertices.length < 2) throw new Error('DXF polyline has fewer than two vertices')
      const pen = r.draw(vertices[0].point), closed = !!(num(70) & 1)
      for (let vertex = 1; vertex < vertices.length + (closed ? 1 : 0); vertex++) { const previous = vertices[vertex - 1], next = vertices[vertex % vertices.length]; if (previous.bulge) pen.bulgeArcTo(next.point, previous.bulge); else pen.lineTo(next.point) }
      const sketch = pen.done().sketchOnPlane('XY') as any
      shape = typeof sketch.wires === 'function' ? sketch.wires() : sketch.wires
    } else if (type === 'POLYLINE') {
      const vertices: [number, number, number][] = [], closed = !!(num(70) & 1)
      while (index < pairs.length && pairs[index][0] === 0 && pairs[index][1] === 'VERTEX') {
        index++; const vertex: [number, number, number] = [0, 0, 0]
        while (index < pairs.length && pairs[index][0] !== 0) { const [group, raw] = pairs[index++]; if ([10, 20, 30].includes(group)) vertex[group / 10 - 1] = Number(raw); if (group === 42 && Number(raw)) throw new Error('DXF legacy POLYLINE bulges require conversion to LWPOLYLINE') }
        vertices.push(vertex)
      }
      if (pairs[index]?.[1] === 'SEQEND') index++
      const edges = vertices.slice(1).map((point, i) => r.makeLine(vertices[i], point)); if (closed && vertices.length > 2) edges.push(r.makeLine(vertices.at(-1)!, vertices[0])); shape = r.assembleWire(edges)
    } else if (type === 'SPLINE') {
      const x = values(11), y = values(21), z = values(31)
      if (!x.length) throw new Error('DXF control-point splines require fit points in this WASM build')
      shape = r.assembleWire([r.makeBSplineApproximation(x.map((value, index) => [value, y[index] ?? 0, z[index] ?? 0]), { tolerance: 1e-6 })])
    } else if (type === 'POINT') shape = r.makeVertex(p())
    else if (['SEQEND', 'VERTEX'].includes(type)) continue
    else throw new Error(`Unsupported DXF entity ${type}; convert it to lines, arcs, or polylines`)
    results.push(shapeValue(shape, undefined, { label }))
  }
  if (!results.length) throw new Error('DXF contains no supported geometry')
  return results
}

function exportVector(format: 'svg' | 'dxf', shapes: KernelShape[], context: KernelContext, options: Record<string, any>): string {
  const tolerance = options.tolerance ?? 0.001
  if (format === 'svg') {
    const paths: string[] = [], all = context.replicad.makeCompound(shapes.map(item => item.shape.clone())), bounds = all.boundingBox.bounds
    for (const item of shapes) {
      // Planar face outlines preserve native curves exactly. Open wires and 3D
      // shapes project their native edges to XY with the requested tolerance.
      const svgPaths = item.shape instanceof context.replicad.Face
        ? context.replicad.drawFaceOutline(item.shape.clone()).toSVGPaths().flat(Infinity) as string[]
        : item.shape.edges.map(edge => {
          const count = edge.geomType === 'LINE' ? 1 : Math.max(8, Math.min(65536, Math.ceil(edge.length / Math.sqrt(tolerance * Math.max(tolerance, edge.length)))))
          return Array.from({ length: count + 1 }, (_, index) => { const point = edge.pointAt(index / count).toTuple(); return `${index ? 'L' : 'M'} ${point[0]} ${-point[1]}` }).join(' ')
        })
      const layer = options.layers?.get(item.label) ?? {}, fill = layer.fill_color ?? options.fill_color, line = layer.line_color ?? options.line_color ?? item.color
      paths.push(`<g id="${xmlEscape(item.label ?? item.kind)}" fill="${fill == null ? 'none' : xmlEscape(colorHex(fill))}" stroke="${line === null ? 'none' : xmlEscape(colorHex(line, '#000000'))}" stroke-width="${Number(layer.line_weight ?? options.line_weight ?? options.stroke_width ?? 0.1)}">${svgPaths.map(path => `<path d="${xmlEscape(path)}"/>`).join('')}</g>`)
    }
    const margin = Number(options.margin ?? 0), minX = bounds[0][0] - margin, minY = -bounds[1][1] - margin, width = bounds[1][0] - bounds[0][0] + margin * 2, height = bounds[1][1] - bounds[0][1] + margin * 2
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="${minX} ${minY} ${width} ${height}">${paths.join('')}</svg>`
  }
  const output: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES']
  for (const item of shapes) for (const edge of item.shape.edges) {
    const start = edge.startPoint.toTuple(), end = edge.endPoint.toTuple(), layer = item.label ?? '0'
    if (edge.geomType === 'LINE') output.push(0, 'LINE', 8, layer, 10, start[0], 20, start[1], 30, start[2], 11, end[0], 21, end[1], 31, end[2])
    else {
      const count = Math.max(8, Math.min(65536, Math.ceil(edge.length / Math.sqrt(tolerance * Math.max(tolerance, edge.length)))))
      const points = Array.from({ length: count + 1 }, (_, index) => edge.pointAt(index / count).toTuple())
      output.push(0, 'LWPOLYLINE', 8, layer, 90, points.length, 70, edge.isClosed ? 1 : 0)
      for (const point of points) output.push(10, point[0], 20, point[1])
    }
  }
  output.push(0, 'ENDSEC', 0, 'EOF'); return output.join('\n') + '\n'
}

function shapeMesh(item: KernelShape, options: Record<string, any>): { positions: number[]; normals: number[]; indices: number[]; uvs: number[] } {
  const data = item.shape.mesh({ tolerance: options.linear_deflection ?? options.tolerance ?? 0.01, angularTolerance: options.angular_deflection ?? options.angular_tolerance ?? 0.1 })
  const uvs = new Array(data.vertices.length / 3 * 2).fill(0), faces = item.shape.faces
  data.faceGroups.forEach((group, faceIndex) => {
    const face = faces[faceIndex]; if (!face) return
    const bounds = face.UVBounds
    for (let index = group.start; index < group.start + group.count; index++) {
      const vertex = data.triangles[index], position = data.vertices.slice(vertex * 3, vertex * 3 + 3) as [number, number, number]
      const [u, v] = face.uvCoordinates(position)
      uvs[vertex * 2] = (u - bounds.uMin) / (bounds.uMax - bounds.uMin || 1)
      uvs[vertex * 2 + 1] = (v - bounds.vMin) / (bounds.vMax - bounds.vMin || 1)
    }
  })
  return { positions: data.vertices, normals: data.normals, indices: data.triangles, uvs }
}
function deduplicateMesh(mesh: ReturnType<typeof shapeMesh>): ReturnType<typeof shapeMesh> {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], remapping: number[] = [], keys = new Map<string, number>()
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex++) {
    const point = mesh.positions.slice(vertex * 3, vertex * 3 + 3), key = point.map(value => Math.round(value * 1e9)).join(',')
    let index = keys.get(key)
    if (index === undefined) { index = positions.length / 3; keys.set(key, index); positions.push(...point); normals.push(...mesh.normals.slice(vertex * 3, vertex * 3 + 3)); uvs.push(...mesh.uvs.slice(vertex * 2, vertex * 2 + 2)) }
    remapping.push(index)
  }
  return { positions, normals, uvs, indices: mesh.indices.map(index => remapping[index]) }
}
function exportMesh(format: NativeFileFormat, shapes: KernelShape[], context: KernelContext, options: Record<string, any>): Uint8Array {
  const meshes: ReturnType<typeof shapeMesh>[] = options.precomputedMeshes ?? shapes.map(item => shapeMesh(item, options)), includeUvs = options.include_uvs !== false
  if (format === 'obj') {
    const lines = ['# b123-fiber OpenCascade mesh']; let vertexOffset = 1
    meshes.forEach((mesh, index) => {
      lines.push(`o ${(shapes[index].label ?? `part-${index}`).replace(/[\r\n]/g, '_')}`)
      for (let vertex = 0; vertex < mesh.positions.length; vertex += 3) lines.push(`v ${mesh.positions.slice(vertex, vertex + 3).join(' ')}`)
      if (includeUvs) for (let uv = 0; uv < mesh.uvs.length; uv += 2) lines.push(`vt ${mesh.uvs.slice(uv, uv + 2).join(' ')}`)
      for (let normal = 0; normal < mesh.normals.length; normal += 3) lines.push(`vn ${mesh.normals.slice(normal, normal + 3).join(' ')}`)
      for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) lines.push(`f ${mesh.indices.slice(triangle, triangle + 3).map(vertex => { const n = vertex + vertexOffset; return includeUvs ? `${n}/${n}/${n}` : `${n}//${n}` }).join(' ')}`)
      vertexOffset += mesh.positions.length / 3
    }); return encoder.encode(lines.join('\n') + '\n')
  }
  if (format === '3mf') {
    const materials = shapes.map((item, index) => {
      const color = colorHex(item.color)
      return `<basematerials id="${1000000 + index}"><base name="${xmlEscape(item.label ?? '')}" displaycolor="${color}FF"/></basematerials>`
    }).join('')
    const resources = meshes.map((mesh, index) => {
      const metadata: MeshMetadata | undefined = options.meshMetadata?.[index]
      return `<object id="${index + 1}" type="${(metadata?.type ?? 'model').toLowerCase()}" name="${xmlEscape(metadata?.name ?? shapes[index].label ?? `part-${index}`)}" pid="${1000000 + index}" pindex="0"${metadata?.part_number ? ` partnumber="${xmlEscape(metadata.part_number)}"` : ''}${metadata?.uuid ? ` p:UUID="${xmlEscape(metadata.uuid)}"` : ''}><mesh><vertices>${Array.from({ length: mesh.positions.length / 3 }, (_, vertex) => `<vertex x="${mesh.positions[vertex * 3]}" y="${mesh.positions[vertex * 3 + 1]}" z="${mesh.positions[vertex * 3 + 2]}"/>`).join('')}</vertices><triangles>${Array.from({ length: mesh.indices.length / 3 }, (_, triangle) => `<triangle v1="${mesh.indices[triangle * 3]}" v2="${mesh.indices[triangle * 3 + 1]}" v3="${mesh.indices[triangle * 3 + 2]}"/>`).join('')}</triangles></mesh></object>`
    }).join('')
    const units: Record<string, string> = { MC: 'micron', MM: 'millimeter', CM: 'centimeter', IN: 'inch', FT: 'foot', M: 'meter' }
    const metadataXml = (options.metadata ?? []).map((entry: any) => `<metadata name="${xmlEscape(`${entry.name_space}:${entry.name}`)}" type="${xmlEscape(entry.type)}" preserve="${entry.must_preserve ? 1 : 0}">${xmlEscape(entry.value)}</metadata>`).join('')
    const model = `<?xml version="1.0" encoding="UTF-8"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" unit="${units[String(options.unit ?? 'Unit.MM').split('.').at(-1)!] ?? 'millimeter'}" xml:lang="en-US">${metadataXml}<resources>${materials}${resources}</resources><build>${shapes.map((_, index) => `<item objectid="${index + 1}"/>`).join('')}</build></model>`
    return zipSync({ '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), '3D/3dmodel.model': strToU8(model) }, { level: 6 })
  }
  const chunks: Uint8Array[] = [], bufferViews: any[] = [], accessors: any[] = [], materials: any[] = [], primitives: any[] = []; let byteLength = 0
  const addAccessor = (input: number[], componentType: number, type: string, target: number, limits = false): number => {
    const components = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1, array = componentType === 5126 ? new Float32Array(input) : new Uint32Array(input), content = new Uint8Array(array.buffer)
    chunks.push(content); const view = bufferViews.length; bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: content.length, target }); byteLength += content.length
    const accessor: any = { bufferView: view, componentType, count: input.length / components, type }
    if (limits) { accessor.min = Array.from({ length: components }, (_, axis) => Math.min(...input.filter((_, index) => index % components === axis))); accessor.max = Array.from({ length: components }, (_, axis) => Math.max(...input.filter((_, index) => index % components === axis))) }
    accessors.push(accessor); return accessors.length - 1
  }
  meshes.forEach((mesh, index) => {
    const attributes: any = { POSITION: addAccessor(mesh.positions, 5126, 'VEC3', 34962, true), NORMAL: addAccessor(mesh.normals, 5126, 'VEC3', 34962) }
    if (includeUvs) attributes.TEXCOORD_0 = addAccessor(mesh.uvs, 5126, 'VEC2', 34962)
    primitives.push({ attributes, indices: addAccessor(mesh.indices, 5125, 'SCALAR', 34963), material: index })
    const color = (shapes[index].color as any)?.rgba ?? shapes[index].color; let rgba = [0.64, 0.64, 0.64, 1]
    if (Array.isArray(color)) rgba = [...color.slice(0, 3), color[3] ?? 1]
    else if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) rgba = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255).concat(1)
    materials.push({ name: shapes[index].label ?? `part-${index}`, pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: 0, roughnessFactor: 0.7 } })
  })
  const binary = new Uint8Array(byteLength); let offset = 0; chunks.forEach(chunk => { binary.set(chunk, offset); offset += chunk.length })
  const document = { asset: { version: '2.0', generator: 'b123-fiber OpenCascade' }, scene: 0, scenes: [{ nodes: shapes.map((_, index) => index) }], nodes: shapes.map((shape, index) => ({ mesh: index, name: shape.label ?? `part-${index}` })), meshes: primitives.map(primitive => ({ primitives: [primitive] })), materials, accessors, bufferViews, buffers: [{ byteLength, ...(format === 'gltf' ? { uri: `data:application/octet-stream;base64,${bytesBase64(binary)}` } : {}) }] }
  if (format === 'gltf') return encoder.encode(JSON.stringify(document))
  const json = encoder.encode(JSON.stringify(document)), paddedLength = Math.ceil(json.length / 4) * 4, output = new Uint8Array(12 + 8 + paddedLength + 8 + binary.length), view = new DataView(output.buffer)
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, output.length, true); view.setUint32(12, paddedLength, true); view.setUint32(16, 0x4e4f534a, true); output.fill(32, 20, 20 + paddedLength); output.set(json, 20)
  view.setUint32(20 + paddedLength, binary.length, true); view.setUint32(24 + paddedLength, 0x004e4942, true); output.set(binary, 28 + paddedLength); return output
}
