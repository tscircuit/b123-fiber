import { publicSymbols, symbolKinds, type ClassSymbol, type FunctionSymbol, type PublicSymbol } from "./generated/symbols"
import { values } from "./generated/values"
import type { Build123dPlan, RenderOptions, RenderResult } from "./types"
import type { NativeTypeValue } from "./generated/runtime"

export { expr } from "./generated/runtime"
export type { NativeCallValue, NativeEnumValue, NativeTypeValue } from "./generated/runtime"

export type RpcOperation = "construct" | "function" | "method" | "get" | "set" | "index" | "operator" | "release"
export interface RpcRequest {
  op: RpcOperation
  name?: string
  target?: unknown
  args?: readonly unknown[]
  kwargs?: Readonly<Record<string, unknown>>
  value?: unknown
}
export type NativeApi = {
  readonly [Name in ClassSymbol | FunctionSymbol]: (kwargs?: Readonly<Record<string, unknown>>) => Promise<any>
} & {
  readonly [Name in Exclude<PublicSymbol, ClassSymbol | FunctionSymbol>]: Name extends keyof typeof values
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
export class NativeHandle {
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

  /** Invoke a public native method. Use the generic parameter to refine its return type. */
  call<Result = any>(name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}): Promise<Result> {
    return this.client.call<Result>(this, name, args, kwargs)
  }

  get<Result = any>(name: string): Promise<Result> { return this.client.get<Result>(this, name) }
  set(name: string, value: unknown): Promise<void> { return this.client.set(this, name, value) }
  at<Result = NativeHandle>(index: unknown): Promise<Result> { return this.client.index<Result>(this, index) }
  slice(start?: number | null, stop?: number | null, step?: number | null): Promise<NativeHandle> {
    return this.client.index(this, { $slice: [start ?? null, stop ?? null, step ?? null] })
  }
  operator<Result = any>(name: string, ...args: readonly unknown[]): Promise<Result> {
    return this.client.operator<Result>(this, name, args)
  }
  length(): Promise<number> { return this.operator<number>("len") }
  contains(value: unknown): Promise<boolean> { return this.operator<boolean>("contains", value) }
  toArray<Result = any>(): Promise<Result[]> { return this.operator<Result[]>("list") }

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
  private readonly handles = new Map<string, NativeHandle>()

  constructor(options: NativeClientOptions | string = {}) {
    const config = typeof options === "string" ? { url: options } : options
    this.url = (config.url ?? "http://127.0.0.1:8765").replace(/\/+$/, "")
    this.transport = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.headers = config.headers
    this.signal = config.signal
    const namespace: Record<string, unknown> = {}
    for (const name of publicSymbols) {
      const kind = symbolKinds[name]
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

  construct<Result = NativeHandle>(name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "construct", name, args, kwargs }, options)
  }
  callFunction<Result = any>(name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "function", name, args, kwargs }, options)
  }
  call<Result = any>(target: unknown, name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "method", target, name, args, kwargs }, options)
  }
  callStatic<Result = any>(typeName: string, name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}, options: NativeRequestOptions = {}): Promise<Result> {
    return this.call<Result>({ $type: typeName }, name, args, kwargs, options)
  }
  get<Result = any>(target: unknown, name: string, options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "get", target, name }, options)
  }
  getStatic<Result = any>(typeName: string, name: string, options: NativeRequestOptions = {}): Promise<Result> {
    return this.get<Result>({ $type: typeName }, name, options)
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
  operator<Result = any>(target: unknown, name: string, args: readonly unknown[] = [], options: NativeRequestOptions = {}): Promise<Result> {
    return this.request<Result>({ op: "operator", target, name, args }, options)
  }
  async release(target: NativeHandle | { $ref: string }): Promise<void> {
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

  async request<Result = any>(request: RpcRequest, options: NativeRequestOptions = {}): Promise<Result> {
    const encoded = this.encode(request)
    const response = await this.http("/rpc", { method: "POST", body: JSON.stringify(encoded) }, options)
    if (!response || typeof response !== "object" || !("value" in response)) {
      throw new NativeError("The native service returned an invalid RPC response", { details: response })
    }
    return this.decode((response as { value: unknown }).value) as Result
  }

  private async http(path: string, init: RequestInit, options: NativeRequestOptions = {}): Promise<any> {
    const headers = new Headers(this.headers)
    headers.set("Accept", "application/json")
    if (init.body !== undefined) headers.set("Content-Type", "application/json")
    let response: Response
    try {
      response = await this.transport(`${this.url}${path}`, { ...init, headers, signal: options.signal !== undefined ? options.signal : this.signal })
    } catch (cause) {
      throw new NativeError(`Could not reach the native build123d service at ${this.url || "the current origin"}`, { cause })
    }
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
