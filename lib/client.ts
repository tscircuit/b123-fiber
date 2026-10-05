import { publicSymbols, symbolKinds, auxiliarySymbols, auxiliarySymbolKinds, type ClassSymbol, type FunctionSymbol, type PublicSymbol, type AuxiliarySymbol } from "./generated/symbols"
import { values } from "./generated/values"
import type { Build123dPlan, RenderOptions, RenderResult } from "./types"
import { BrowserKernel, type BrowserKernelOptions } from "./kernel/index"
import type { NativeTypeValue } from "./generated/runtime"
import type { NativeCallableMap, NativeClassName } from './generated/api-types'
import type { NativeOverloadedKeywordCallable, NativeCallableSignature, NativeRequestInvocation, NativeResult, NativeExplicitResult, NativeDynamicRequestInvocation, NativeDynamicInvocation, NativeMethodNames, NativeMethodSignature, NativeInvocation, NativePropertyNames, NativeProperty, NativeWritableNames, NativeWritable, NativeStaticMethodNames, NativeStaticSignature, NativeStaticPropertyNames, NativeStaticProperty, NativeOperatorName, NativeOperatorResult } from './native-types'
import type { NativeCallableInvocation, NativeCallableResult } from './native-types'
import { base64Bytes, bytesBase64, type NativeBinaryInput, type NativeFile, type NativeFileFormat, type NativeFileOptions, type NativeImportOptions, type NativeExportOptions, type NativeImportedFile } from './files'

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

export interface NativeClientOptions extends BrowserKernelOptions {
  /** Share an existing in-process OpenCascade kernel between clients or viewers. */
  kernel?: BrowserKernel | Promise<BrowserKernel>
  signal?: AbortSignal
}
export interface NativeRequestOptions { signal?: AbortSignal | null }

/** An in-process compatibility or OpenCascade error, preserving useful details. */
export class NativeError extends Error {
  readonly kernelType?: string
  readonly path?: string
  readonly details: unknown
  constructor(message: string, options: { kernelType?: string; path?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = "NativeError"
    this.kernelType = options.kernelType
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

/** Asynchronous build123d-compatible bindings to local OpenCascade WebAssembly. */
export class NativeClient {
  readonly api: NativeApi
  private readonly options: NativeClientOptions
  private kernelPromise?: Promise<BrowserKernel>
  private readonly signal: AbortSignal | undefined
  private readonly handles = new Map<string, NativeHandle<any, any>>()

  constructor(options: NativeClientOptions = {}) {
    this.options = options
    this.signal = options.signal
    if (options.kernel) this.kernelPromise = Promise.resolve(options.kernel)
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

  /** Lazily initialize the local WebAssembly kernel. No geometry service is needed. */
  get ready(): Promise<BrowserKernel> {
    return this.kernelPromise ??= BrowserKernel.create(this.options)
  }

  /** Local compatibility inventory, including available and unsupported bindings. */
  async inventory<Result = unknown>(options: NativeRequestOptions = {}): Promise<Result> {
    return this.withKernel(kernel => kernel.inventory(), options) as Promise<Result>
  }

  /** Execute a serializable JSX plan with the in-process OpenCascade kernel. */
  async render(plan: Build123dPlan, options: RenderOptions = {}): Promise<RenderResult> {
    const encoded = this.encode(plan) as Build123dPlan
    const result = await this.withKernel(kernel => kernel.render(encoded, options), options)
    if (!result || !Array.isArray(result.meshes) || typeof result.kernel !== 'string' || !('bounds' in result)) {
      throw new NativeError('The local kernel returned an invalid render response', { details: result })
    }
    return result
  }

  /** Store browser bytes in the WebAssembly instance's virtual filesystem. */
  async uploadFile(contents: NativeBinaryInput, options: NativeFileOptions = {}): Promise<NativeFile> {
    return this.withKernel(kernel => kernel.uploadFile(contents, options), options)
  }

  /** Download a file retained by this WebAssembly instance. */
  downloadFile(file: NativeFile | string, options: NativeRequestOptions = {}): Promise<Blob> {
    return this.withKernel(kernel => kernel.downloadFile(file), options)
  }

  async deleteFile(file: NativeFile | string, options: NativeRequestOptions = {}): Promise<void> {
    await this.withKernel(kernel => kernel.deleteFile(file), options)
  }

  /** Import browser bytes and return a self-contained, replayable CAD plan. */
  async importFile(contents: NativeBinaryInput, options: NativeImportOptions = {}): Promise<NativeImportedFile<NativeHandle | NativeHandle[]>> {
    const result = await this.withKernel(kernel => kernel.importFile(contents, options), options)
    return { ...result, value: this.decode(result.value) } as NativeImportedFile<NativeHandle | NativeHandle[]>
  }

  /** Export in-process OpenCascade geometry as a downloadable browser Blob. */
  exportFile(target: Build123dPlan | NativeHandle<any, any> | readonly NativeHandle<any, any>[], format: NativeFileFormat, options: NativeExportOptions = {}): Promise<Blob> {
    return this.withKernel(kernel => kernel.exportFile(this.encode(target), format, options), options)
  }

  /** Create an in-process byte or text stream for compatible stream overloads. */
  async createStream(contents: NativeBinaryInput | string = new Uint8Array(), options: NativeRequestOptions & { kind?: 'bytes' | 'text' } = {}): Promise<NativeHandle> {
    const value = await this.withKernel(kernel => kernel.createStream(contents, options), options)
    return this.decode(value.value) as NativeHandle
  }

  async readStream(stream: NativeHandle<any, any>, options: NativeRequestOptions = {}): Promise<Uint8Array | string> {
    stream.assertUsable(this)
    return this.withKernel(kernel => kernel.readStream(stream.toJSON()), options)
  }

  async writeStream(stream: NativeHandle<any, any>, contents: NativeBinaryInput | string, options: NativeRequestOptions = {}): Promise<void> {
    stream.assertUsable(this)
    await this.withKernel(kernel => kernel.writeStream(stream.toJSON(), contents), options)
  }

  async request<Result = any>(request: RpcRequest, options: NativeRequestOptions = {}): Promise<Result> {
    const encoded = this.encode(request) as RpcRequest
    const response = await this.withKernel(kernel => kernel.rpc(encoded), options)
    if (!response || typeof response !== 'object' || !('value' in response)) {
      throw new NativeError('The local kernel returned an invalid RPC response', { details: response })
    }
    return this.decode(response.value) as Result
  }

  private async withKernel<Result>(operation: (kernel: BrowserKernel) => Result | Promise<Result>, options: NativeRequestOptions = {}): Promise<Result> {
    const signal = options.signal !== undefined ? options.signal : this.signal
    signal?.throwIfAborted()
    try {
      const kernel = await this.abortable(this.ready, signal)
      signal?.throwIfAborted()
      const value = await this.abortable(Promise.resolve(operation(kernel)), signal)
      signal?.throwIfAborted()
      return value
    } catch (cause) {
      if (signal?.aborted || cause instanceof NativeError || cause instanceof DOMException && cause.name === 'AbortError') throw cause
      const details = cause as { name?: string; path?: string; details?: unknown }
      throw new NativeError(cause instanceof Error ? cause.message : String(cause), {
        kernelType: details?.name, path: details?.path, details: details?.details, cause,
      })
    }
  }

  private abortable<Result>(promise: Promise<Result>, signal?: AbortSignal | null): Promise<Result> {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      if (signal.aborted) { reject(signal.reason); return }
      signal.addEventListener('abort', abort, { once: true })
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
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

export function createNativeClient(options: NativeClientOptions = {}): NativeClient {
  return new NativeClient(options)
}
