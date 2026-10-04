import { publicSymbols, symbolKinds, auxiliarySymbols, auxiliarySymbolKinds, type ClassSymbol, type FunctionSymbol, type PublicSymbol, type AuxiliarySymbol } from "./generated/symbols"
import { values } from "./generated/values"
import type { Build123dPlan, RenderOptions, RenderResult } from "./types"
import type { NativeTypeValue } from "./generated/runtime"
import type { NativeCallableMap, NativeClassName } from './generated/api-types'
import type { NativeOverloadedKeywordCallable, NativeCallableSignature, NativeRequestInvocation, NativeResult, NativeExplicitResult, NativeDynamicRequestInvocation, NativeDynamicInvocation, NativeMethodNames, NativeMethodSignature, NativeInvocation, NativePropertyNames, NativeProperty, NativeWritableNames, NativeWritable, NativeStaticMethodNames, NativeStaticSignature, NativeStaticPropertyNames, NativeStaticProperty, NativeOperatorName, NativeOperatorResult } from './native-types'
import type { NativeCallableInvocation, NativeCallableResult } from './native-types'
import { base64Bytes, bytesBase64, fileBlob, fileName, type NativeBinaryInput, type NativeFile, type NativeFileFormat, type NativeFileOptions, type NativeImportOptions, type NativeExportOptions, type NativeImportedFile } from './files'

export { nativeFile } from './files'
export type { NativeBinaryInput, NativeFile, NativeFileFormat, NativeFileValue, NativeFileOptions, NativeImportOptions, NativeExportOptions, NativeImportedFile } from './files'

export { expr } from "./generated/runtime"
export type { NativeCallValue, NativeEnumValue, NativeTypeValue } from "./generated/runtime"
export type { NativeInput, NativeValue, NativeObjectInput, NativeVectorLike, NativeRotationLike, NativeReference, NativeBytesValue, NativeDateValue, NativeUuidValue, NativeLambdaValue } from './native-types'

export type RpcOperation = "construct" | "function" | "method" | "get" | "set" | "index" | "operator" | "release" | "setitem" | "delitem" | "invoke"
export interface RpcRequest {
  op: RpcOperation
  name?: string
  target?: unknown
  args?: readonly unknown[]
  kwargs?: Readonly<Record<string, unknown>>
  value?: unknown
  index?: unknown
}
export type NativeApi = {
  readonly [Name in ClassSymbol | FunctionSymbol | 'Shape' | 'BytesIO' | 'StringIO']: NativeOverloadedKeywordCallable<NativeCallableMap[Name]>
} & {
  readonly [Name in Exclude<PublicSymbol | AuxiliarySymbol, ClassSymbol | FunctionSymbol | 'Shape' | 'BytesIO' | 'StringIO'>]: Name extends keyof typeof values
    ? (typeof values)[Name] : NativeTypeValue
}

export interface NativeClientOptions {
  /** Geometry service URL. May be relative when the service shares an origin. */
  url?: string
  /** Injectable HTTP transport, useful in tests and applications with authentication. */
  fetch?: typeof globalThis.fetch
  headers?: HeadersInit
  signal?: AbortSignal
}
export interface NativeRequestOptions { signal?: AbortSignal | null }

/** A native Python exception or HTTP/transport failure, preserving useful details. */
export class NativeError extends Error {
  readonly status: number
  readonly pythonType?: string
  readonly path?: string
  readonly details: unknown
  constructor(message: string, options: { status?: number; pythonType?: string; path?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = "NativeError"
    this.status = options.status ?? 0
    this.pythonType = options.pythonType
    this.path = options.path
    this.details = options.details
  }
}

/** Retained geometry, a builder, or another native public build123d object. */
export class NativeHandle<Kind extends string = string, Item = unknown> {
  /** Type-only native class marker; no extra state crosses the wire. */
  declare readonly __nativeClass: Kind
  readonly id: string
  readonly kind?: string
  readonly client: NativeClient
  private released = false

  constructor(client: NativeClient, id: string, kind?: string) {
    this.client = client
    this.id = id
    this.kind = kind
  }

  get isReleased() { return this.released }

  /** Execute a native callable returned by an API such as topo_distance_to. */
  invoke<Result = never>(...invocation: [Result] extends [never] ? NativeCallableInvocation<Kind, Item> : NativeDynamicInvocation): Promise<NativeExplicitResult<Result, NativeCallableResult<Kind, Item>>> {
    const [args = [], kwargs = {}] = invocation as NativeDynamicInvocation
    return this.client.invoke(this, args, kwargs) as Promise<NativeExplicitResult<Result, NativeCallableResult<Kind, Item>>>
  }

  /** Invoke a public native method. Use the generic parameter to refine its return type. */
  call<Result = never, Name extends NativeMethodNames<Kind> = NativeMethodNames<Kind>>(name: Name, ...invocation: [Result] extends [never] ? NativeInvocation<NativeMethodSignature<Kind, Name, Item>> : NativeDynamicInvocation): Promise<NativeExplicitResult<Result, NativeResult<NativeMethodSignature<Kind, Name, Item>>>> {
    const [args = [], kwargs = {}] = invocation as NativeDynamicInvocation
    return this.client.call(this, name, args, kwargs)
  }

  get<Result = never, Name extends NativePropertyNames<Kind> = NativePropertyNames<Kind>>(name: Name): Promise<NativeExplicitResult<Result, NativeProperty<Kind, Name, Item>>> { return this.client.get(this, name) }
  set<Name extends NativeWritableNames<Kind>>(name: Name, value: NativeWritable<Kind, Name, Item>): Promise<void> { return this.client.set(this, name, value) }
  at<Result = never>(index: number): Promise<NativeExplicitResult<Result, Item>> { return this.client.index(this, index) }
  setAt(index: unknown, value: unknown): Promise<void> { return this.client.setAt(this, index, value) }
  deleteAt(index: unknown): Promise<void> { return this.client.deleteAt(this, index) }
  slice(start?: number | null, stop?: number | null, step?: number | null): Promise<NativeHandle<Kind, Item>> {
    return this.client.index(this, { $slice: [start ?? null, stop ?? null, step ?? null] })
  }
  operator<Result = never, Name extends NativeOperatorName = NativeOperatorName>(name: Name, ...args: readonly unknown[]): Promise<NativeExplicitResult<Result, NativeOperatorResult<Kind, Name, Item>>> {
    return this.client.operator(this, name, args)
  }
  length(): Promise<number> { return this.operator<number>("len") }
  contains(value: unknown): Promise<boolean> { return this.operator<boolean>("contains", value) }
  toArray<Result = never>(): Promise<NativeExplicitResult<Result, Item>[]> { return this.client.operator(this, 'list') }

  /** Explicitly free this retained native object. Successful release is idempotent. */
  async release(): Promise<void> {
    if (this.released) return
    await this.client.release(this)
  }

  /** Marker accepted by JSON.stringify and the plan compiler. */
  toJSON(): { $ref: string } {
    this.assertUsable(this.client)
    return { $ref: this.id }
  }

  /** @internal */
  assertUsable(client: NativeClient): void {
    if (client !== this.client) throw new TypeError("A native handle belongs to a different client")
    if (this.released) throw new TypeError(`Native handle ${this.id} has been released`)
  }
  /** @internal */
  markReleased(): void { this.released = true }
}

/** Complete asynchronous dispatch to the pinned native build123d API. */
export class NativeClient {
  readonly url: string
  readonly api: NativeApi
  private readonly transport: typeof globalThis.fetch
  private readonly headers: HeadersInit | undefined
  private readonly signal: AbortSignal | undefined
  private readonly handles = new Map<string, NativeHandle<any, any>>()

  constructor(options: NativeClientOptions | string = {}) {
    const config = typeof options === "string" ? { url: options } : options
    this.url = (config.url ?? "http://127.0.0.1:8765").replace(/\/+$/, "")
    this.transport = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.headers = config.headers
    this.signal = config.signal
    const namespace: Record<string, unknown> = {}
    for (const name of [...publicSymbols, ...auxiliarySymbols]) {
      const kind = name in auxiliarySymbolKinds
        ? auxiliarySymbolKinds[name as AuxiliarySymbol]
        : symbolKinds[name as PublicSymbol]
      if (kind === "class" || kind === "function") {
        namespace[name] = (kwargs: Readonly<Record<string, unknown>> = {}) => {
          if (!kwargs || typeof kwargs !== "object" || Array.isArray(kwargs)) {
            throw new TypeError(`api.${name} accepts a keyword argument object; use construct/callFunction for positional arguments`)
          }
          return kind === "class" ? this.construct(name, [], kwargs) : this.callFunction(name, [], kwargs)
        }
      } else if (name in values) {
        namespace[name] = values[name as keyof typeof values]
      } else {
        namespace[name] = Object.freeze({ $type: name })
      }
    }
    this.api = Object.freeze(namespace) as NativeApi
  }

  construct<Result = never, Name extends string = string>(name: Name, ...invocation: [Result] extends [never] ? NativeRequestInvocation<NativeCallableSignature<Name>> : NativeDynamicRequestInvocation): Promise<NativeExplicitResult<Result, NativeResult<NativeCallableSignature<Name>>>> {
    const [args = [], kwargs = {}, options = {}] = invocation as NativeDynamicRequestInvocation
    return this.request({ op: "construct", name, args, kwargs }, options)
  }
  callFunction<Result = never, Name extends string = string>(name: Name, ...invocation: [Result] extends [never] ? NativeRequestInvocation<NativeCallableSignature<Name>> : NativeDynamicRequestInvocation): Promise<NativeExplicitResult<Result, NativeResult<NativeCallableSignature<Name>>>> {
    const [args = [], kwargs = {}, options = {}] = invocation as NativeDynamicRequestInvocation
    return this.request({ op: "function", name, args, kwargs }, options)
  }
  call<Result = any>(target: unknown, name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "method", target, name, args, kwargs }, options)
  }
  invoke<Result = unknown>(target: unknown, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: 'invoke', target, args, kwargs }, options)
  }
  callStatic<Result = never, Kind extends NativeClassName = NativeClassName, Name extends NativeStaticMethodNames<Kind> = NativeStaticMethodNames<Kind>>(typeName: Kind, name: Name, ...invocation: [Result] extends [never] ? NativeRequestInvocation<NativeStaticSignature<Kind, Name>> : NativeDynamicRequestInvocation): Promise<NativeExplicitResult<Result, NativeResult<NativeStaticSignature<Kind, Name>>>> {
    const [args = [], kwargs = {}, options = {}] = invocation as NativeDynamicRequestInvocation
    return this.call({ $type: typeName }, name, args, kwargs, options)
  }
  get<Result = any>(target: unknown, name: string, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "get", target, name }, options)
  }
  getStatic<Result = never, Kind extends NativeClassName = NativeClassName, Name extends NativeStaticPropertyNames<Kind> = NativeStaticPropertyNames<Kind>>(typeName: Kind, name: Name, options: NativeRequestOptions = {}): Promise<NativeExplicitResult<Result, NativeStaticProperty<Kind, Name>>> {
    return this.get({ $type: typeName }, name, options)
  }
  /** Resolve any public root symbol or public dotted class attribute natively. */
  resolve<Result = any>(name: string, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "get", target: { $type: name } }, options)
  }
  async set(target: unknown, name: string, value: unknown, options: NativeRequestOptions = {}): Promise<void> {
    await this.request({ op: "set", target, name, value }, options)
  }
  index<Result = NativeHandle>(target: unknown, value: unknown, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "index", target, value }, options)
  }
  async setAt(target: unknown, index: unknown, value: unknown, options: NativeRequestOptions = {}): Promise<void> {
    await this.request({ op: 'setitem', target, index, value }, options)
  }
  async deleteAt(target: unknown, index: unknown, options: NativeRequestOptions = {}): Promise<void> {
    await this.request({ op: 'delitem', target, index }, options)
  }
  operator<Result = any>(target: unknown, name: string, args: readonly unknown[] = [], options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "operator", target, name, args }, options)
  }
  async release(target: NativeHandle<any, any> | { $ref: string }): Promise<void> {
    if (target instanceof NativeHandle) {
      if (target.isReleased) return
      target.assertUsable(this)
    }
    await this.request({ op: "release", target })
    const id = target instanceof NativeHandle ? target.id : target.$ref
    this.handles.get(id)?.markReleased()
    this.handles.delete(id)
    if (target instanceof NativeHandle) target.markReleased()
  }

  /** Release all retained refs decoded by this client, preserving failures for retry. */
  async releaseAll(): Promise<void> {
    const results = await Promise.allSettled([...this.handles.values()].map((handle) => handle.release()))
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Some native handles could not be released")
  }

  /** Native runtime inventory, including every method/property signature. */
  async inventory<Result = unknown>(options: NativeRequestOptions = {}): Promise<Result> {
    return this.http("/api", { method: "GET" }, options) as Promise<Result>
  }

  /** Execute a serializable JSX plan with the same transport/authentication as RPC. */
  async render(plan: Build123dPlan, options: RenderOptions = {}): Promise<RenderResult> {
    const body = this.encode({
      plan,
      ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
      ...(options.angularTolerance === undefined ? {} : { angularTolerance: options.angularTolerance }),
    })
    const result = await this.http("/render", { method: "POST", body: JSON.stringify(body) }, { signal: options.signal })
    if (!result || !Array.isArray(result.meshes) || typeof result.kernel !== "string" || !("bounds" in result)) {
      throw new NativeError("The native service returned an invalid render response", { details: result })
    }
    return result as RenderResult
  }

  /** Store binary content under a generated ID in the native workspace. */
  async uploadFile(contents: NativeBinaryInput, options: NativeFileOptions = {}): Promise<NativeFile> {
    const filename = options.filename ?? fileName(contents)
    const result = await this.http(`/files?filename=${encodeURIComponent(filename)}`, {
      method: 'POST', body: fileBlob(contents), headers: { 'Content-Type': 'application/octet-stream' },
    }, options)
    if (!result?.file || typeof result.file.id !== 'string' || typeof result.file.path !== 'string') {
      throw new NativeError('The native service returned an invalid file response', { details: result })
    }
    return result.file as NativeFile
  }

  /** Download an uploaded file. File IDs belong to the current native process. */
  downloadFile(file: NativeFile | string, options: NativeRequestOptions = {}): Promise<Blob> {
    return this.binary(`/files/${encodeURIComponent(typeof file === 'string' ? file : file.id)}`, { method: 'GET' }, options)
  }

  async deleteFile(file: NativeFile | string, options: NativeRequestOptions = {}): Promise<void> {
    await this.http(`/files/${encodeURIComponent(typeof file === 'string' ? file : file.id)}`, { method: 'DELETE' }, options)
  }

  /** Import a browser file and return a durable, self-contained native CAD plan. */
  async importFile(contents: NativeBinaryInput, options: NativeImportOptions = {}): Promise<NativeImportedFile<NativeHandle | NativeHandle[]>> {
    const filename = options.filename ?? fileName(contents, `model.${options.format ?? 'step'}`)
    const query = new URLSearchParams({ filename })
    if (options.format) query.set('format', options.format)
    if (options.kwargs) query.set('options', JSON.stringify(this.encode(options.kwargs)))
    const result = await this.http(`/files/import?${query}`, {
      method: 'POST', body: fileBlob(contents), headers: { 'Content-Type': 'application/octet-stream' },
    }, options)
    if (!result?.plan || !result.result || !Array.isArray(result.result.meshes) || !('value' in result)) {
      throw new NativeError('The native service returned an invalid import response', { details: result })
    }
    return { ...result, value: this.decode(result.value) } as NativeImportedFile<NativeHandle | NativeHandle[]>
  }

  /** Export native geometry as a downloadable CAD file with authenticated transport. */
  exportFile(target: Build123dPlan | NativeHandle<any, any> | readonly NativeHandle<any, any>[], format: NativeFileFormat, options: NativeExportOptions = {}): Promise<Blob> {
    const plan = target && typeof target === 'object' && 'version' in target && 'children' in target
    const body = this.encode({
      format, ...(plan ? { plan: target } : { target }),
      ...(options.filename === undefined ? {} : { filename: options.filename }),
      ...(options.kwargs === undefined ? {} : { options: options.kwargs }),
    })
    return this.binary('/files/export', { method: 'POST', body: JSON.stringify(body) }, options)
  }

  /** Construct native BytesIO/StringIO for build123d's stream overloads. */
  async createStream(contents: NativeBinaryInput | string = new Uint8Array(), options: NativeRequestOptions & { kind?: 'bytes' | 'text' } = {}): Promise<NativeHandle> {
    const kind = options.kind ?? (typeof contents === 'string' ? 'text' : 'bytes')
    const result = await this.http(`/streams?kind=${kind}`, {
      method: 'POST', body: fileBlob(contents), headers: { 'Content-Type': 'application/octet-stream' },
    }, options)
    const handle = this.decode(result?.value)
    if (!(handle instanceof NativeHandle)) throw new NativeError('The native service returned an invalid stream handle', { details: result })
    return handle
  }

  /** Read complete stream contents without changing the native stream position. */
  async readStream(stream: NativeHandle<any, any>, options: NativeRequestOptions = {}): Promise<Uint8Array | string> {
    stream.assertUsable(this)
    const blob = await this.binary(`/streams/${encodeURIComponent(stream.id)}`, { method: 'GET' }, options)
    return stream.kind === 'StringIO' ? blob.text() : new Uint8Array(await blob.arrayBuffer())
  }

  async writeStream(stream: NativeHandle<any, any>, contents: NativeBinaryInput | string, options: NativeRequestOptions = {}): Promise<void> {
    stream.assertUsable(this)
    await this.http(`/streams/${encodeURIComponent(stream.id)}`, {
      method: 'POST', body: fileBlob(contents), headers: { 'Content-Type': 'application/octet-stream' },
    }, options)
  }

  async request<Result = any>(request: RpcRequest, options: NativeRequestOptions = {}): Promise<Result> {
    const encoded = this.encode(request)
    const response = await this.http("/rpc", { method: "POST", body: JSON.stringify(encoded) }, options)
    if (!response || typeof response !== "object" || !("value" in response)) {
      throw new NativeError("The native service returned an invalid RPC response", { details: response })
    }
    return this.decode((response as { value: unknown }).value) as Result
  }

  private async response(path: string, init: RequestInit, options: NativeRequestOptions = {}): Promise<Response> {
    const headers = new Headers(this.headers)
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    if (!headers.has('Accept')) headers.set("Accept", "application/json")
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set("Content-Type", "application/json")
    let response: Response
    try {
      response = await this.transport(`${this.url}${path}`, { ...init, headers, signal: options.signal !== undefined ? options.signal : this.signal })
    } catch (cause) {
      throw new NativeError(`Could not reach the native build123d service at ${this.url || "the current origin"}`, { cause })
    }
    return response
  }

  private async binary(path: string, init: RequestInit, options: NativeRequestOptions = {}): Promise<Blob> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/octet-stream')
    const response = await this.response(path, { ...init, headers }, options)
    if (!response.ok) return this.jsonResponse(response)
    return response.blob()
  }

  private async http(path: string, init: RequestInit, options: NativeRequestOptions = {}): Promise<any> {
    return this.jsonResponse(await this.response(path, init, options))
  }

  private async jsonResponse(response: Response): Promise<any> {
    const body = await response.text()
    let data: any
    try { data = body ? JSON.parse(body) : null }
    catch (cause) {
      throw new NativeError(`The native service returned non-JSON data (HTTP ${response.status})`, { status: response.status, details: body, cause })
    }
    if (!response.ok || data?.error) {
      const error = data?.error
      const message = typeof error === "string" ? error : error?.message ?? data?.message ?? `Native request failed (HTTP ${response.status})`
      throw new NativeError(message, { status: response.status, pythonType: error?.type, path: error?.path, details: data })
    }
    return data
  }

  /** Recursively encode handles and validate that the JSON protocol loses no values. */
  private encode(value: unknown, seen = new Set<object>()): unknown {
    if (value instanceof NativeHandle) {
      value.assertUsable(this)
      return value.toJSON()
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      return { $bytes: bytesBase64(bytes) }
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Native arguments require finite numbers")
      return value
    }
    if (value === undefined || typeof value !== "object") throw new TypeError("Native arguments must be JSON-serializable")
    if (seen.has(value)) throw new TypeError("Native arguments cannot contain cycles")
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map((item) => this.encode(item, seen))
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError("Native arguments must contain plain objects, symbolic values or native handles")
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.encode(item, seen)]))
    } finally { seen.delete(value) }
  }

  private decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.decode(item))
    if (value && typeof value === "object") {
      const data = value as Record<string, unknown>
      if (typeof data.$bytes === 'string') return base64Bytes(data.$bytes)
      if (typeof data.$ref === "string") {
        let handle = this.handles.get(data.$ref)
        if (!handle) {
          handle = new NativeHandle(this, data.$ref, typeof data.kind === "string" ? data.kind : undefined)
          this.handles.set(data.$ref, handle)
        }
        return handle
      }
      return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, this.decode(item)]))
    }
    return value
  }
}

export function createNativeClient(options: NativeClientOptions | string = {}): NativeClient {
  return new NativeClient(options)
}
