import { describe, expect, it, vi } from "vitest"
import { NativeClient, NativeError, NativeHandle, expr } from "../lib/client"
import { Align, Axis, native, values } from "../lib/generated/values"
import { publicSymbols, symbolKinds } from "../lib/generated/symbols"

function stub(...responses: unknown[]) {
  const requests: { url: string; init: RequestInit; body?: any }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(responses.shift() ?? { value: null }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { client: new NativeClient({ url: "http://localhost:9999/", fetch }), requests, fetch }
}

describe("complete native API client", () => {
  it("exposes every native root export and dispatches constructor/function calls correctly", async () => {
    const { client, requests } = stub({ value: { $ref: "box", kind: "Box" } }, { value: [3, 4] })
    expect(Object.keys(client.api)).toEqual([...publicSymbols])
    for (const name of publicSymbols) {
      if (symbolKinds[name] === "class" || symbolKinds[name] === "function") expect(typeof client.api[name]).toBe("function")
      else if (name in values) expect(client.api[name]).toEqual(values[name as keyof typeof values])
    }
    const box = await client.api.Box({ length: 2, width: 3, height: 4, align: Align.CENTER })
    expect(box).toBeInstanceOf(NativeHandle)
    expect(box.kind).toBe("Box")
    expect(await client.api.polar({ length: 5, angle: 53.130102354 })).toEqual([3, 4])
    expect(requests[0].body).toEqual({ op: "construct", name: "Box", args: [], kwargs: { length: 2, width: 3, height: 4, align: { $enum: "Align.CENTER" } } })
    expect(requests[1].body.op).toBe("function")
    expect(() => client.api.Box([1, 2, 3] as never)).toThrow(/keyword argument object/)
  })

  it("decodes nested refs with stable identity and encodes them recursively for later native operations", async () => {
    const { client, requests } = stub(
      { value: { shapes: [{ $ref: "s1", kind: "Solid" }, { $ref: "s1", kind: "Solid" }] } },
      { value: 24 },
      { value: { $ref: "s2", kind: "Part" } },
    )
    const { shapes } = await client.callFunction<{ shapes: NativeHandle[] }>("pack", [])
    expect(shapes[0]).toBe(shapes[1])
    expect(await shapes[0].get("volume")).toBe(24)
    const result = await client.callFunction("add", [], { objects: [shapes[0]], rotation: native.Rotation(0, 0, 45) })
    expect(result.id).toBe("s2")
    expect(requests[2].body.kwargs).toEqual({ objects: [{ $ref: "s1" }], rotation: { $call: "Rotation", args: [0, 0, 45], kwargs: {} } })
  })

  it("implements static methods, properties, methods, index/slice, operators and collection helpers", async () => {
    const { client, requests } = stub({ value: { $ref: "edges", kind: "ShapeList" } }, { value: null }, { value: null }, { value: null }, { value: null }, { value: 4 }, { value: true }, { value: [] })
    const edges = await client.callStatic("Solid", "make_box", [1, 2, 3])
    await edges.call("filter_by", [Axis.Z])
    await edges.set("label", "edges")
    await edges.at(-1)
    await edges.slice(1, 3)
    expect(await edges.length()).toBe(4)
    expect(await edges.contains(native.Edge.make_line([0, 0, 0], [1, 0, 0]))).toBe(true)
    expect(await edges.toArray()).toEqual([])
    expect(requests.map((request) => request.body.op)).toEqual(["method", "method", "set", "index", "index", "operator", "operator", "operator"])
    expect(requests[0].body.target).toEqual({ $type: "Solid" })
    expect(requests[4].body.value).toEqual({ $slice: [1, 3, null] })
    expect(requests.slice(5).map((request) => request.body.name)).toEqual(["len", "contains", "list"])
  })

  it("releases refs idempotently, rejects released/cross-client handles, and retains failed releases for retry", async () => {
    const { client, requests } = stub({ value: { $ref: "s1", kind: "Solid" } }, { value: null })
    const shape = await client.construct("Box", [1, 2, 3])
    const other = stub().client
    await expect(other.callFunction("add", [shape])).rejects.toThrow(/different client/)
    await shape.release()
    await shape.release()
    expect(requests).toHaveLength(2)
    expect(shape.isReleased).toBe(true)
    await expect(shape.get("volume")).rejects.toThrow(/released/)
    expect(() => JSON.stringify(shape)).toThrow(/released/)
  })

  it("releaseAll attempts all refs and keeps failed native releases usable for retry", async () => {
    let fail = true
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(String(options.body))
      if (request.op === "construct") return new Response(JSON.stringify({ value: [{ $ref: "s1" }, { $ref: "s2" }] }))
      if (request.target.$ref === "s1" && fail) return new Response(JSON.stringify({ error: { type: "RuntimeError", message: "retry release" } }), { status: 422 })
      return new Response(JSON.stringify({ value: null }))
    }) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ fetch })
    const handles = await client.construct<NativeHandle[]>("ShapeList")
    await expect(client.releaseAll()).rejects.toThrow(/could not be released/)
    expect(handles[0].isReleased).toBe(false)
    expect(handles[1].isReleased).toBe(true)
    fail = false
    await client.releaseAll()
    expect(handles[0].isReleased).toBe(true)
  })

  it("retains structured Python errors, malformed response details and transport causes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { type: "ValueError", message: "Invalid radius", path: "rpc.construct.Sphere" } }), { status: 422 })) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ fetch })
    const error = await client.construct("Sphere", [], { radius: -1 }).catch((error) => error)
    expect(error).toBeInstanceOf(NativeError)
    expect(error).toMatchObject({ message: "Invalid radius", pythonType: "ValueError", status: 422, path: "rpc.construct.Sphere" })
    const html = new NativeClient({ fetch: vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof globalThis.fetch })
    await expect(html.construct("Box")).rejects.toMatchObject({ name: "NativeError", status: 502 })
    const missingValue = stub({ unexpected: true }).client
    await expect(missingValue.construct("Box")).rejects.toThrow(/invalid RPC response/)
    const cause = new Error("connection refused")
    const offline = new NativeClient({ fetch: vi.fn(async () => { throw cause }) as unknown as typeof globalThis.fetch })
    await expect(offline.construct("Box")).rejects.toMatchObject({ name: "NativeError", cause })
  })

  it("supports relative URLs, inventory reads, custom headers and cancellation signals", async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const controller = new AbortController()
    const client = new NativeClient({ url: "/kernel/", headers: { "X-Test": "native" }, signal: controller.signal, fetch: (async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify({ exports: publicSymbols }))
    }) as typeof globalThis.fetch })
    expect(await client.inventory()).toEqual({ exports: [...publicSymbols] })
    expect(requests[0].url).toBe("/kernel/api")
    expect(requests[0].init?.method).toBe("GET")
    expect(new Headers(requests[0].init?.headers).get("X-Test")).toBe("native")
    expect(requests[0].init?.signal).toBe(controller.signal)
  })

  it("renders headless plans with OCCT tessellation options and request signal overrides", async () => {
    const controller = new AbortController()
    const override = new AbortController()
    const scene = { meshes: [], bounds: null, kernel: "build123d/OpenCascade" }
    const { client, requests } = stub(scene, { value: 24 }, { invalid: "render" })
    const plan = { version: 1 as const, children: [{ type: "Box", props: { length: 2, width: 3, height: 4 }, children: [] }] }
    expect(await client.render(plan, { tolerance: 0.01, angularTolerance: 0.1, signal: override.signal })).toEqual(scene)
    expect(requests[0].url).toBe("http://localhost:9999/render")
    expect(requests[0].body).toEqual({ plan, tolerance: 0.01, angularTolerance: 0.1 })
    expect(requests[0].init.signal).toBe(override.signal)
    await client.callFunction("polar", [1, 90], {}, { signal: controller.signal })
    expect(requests[1].init.signal).toBe(controller.signal)
    await expect(client.render(plan)).rejects.toThrow(/invalid render response/)
  })

  it("preserves constructor default signal and allows explicitly clearing it per request", async () => {
    const controller = new AbortController()
    const signals: unknown[] = []
    const client = new NativeClient({ signal: controller.signal, fetch: (async (_url, init) => {
      signals.push(init?.signal)
      return new Response(JSON.stringify({ value: 1 }))
    }) as typeof globalThis.fetch })
    await client.resolve("MM")
    await client.resolve("MM", { signal: null })
    expect(signals).toEqual([controller.signal, null])
    expect(client.api.MM).toBe(1)
    expect(client.api.Align.CENTER).toEqual({ $enum: "Align.CENTER" })
  })

  it("rejects JSON lossy values before issuing a request and accepts repeated plain values", async () => {
    const { client, requests } = stub()
    for (const value of [NaN, Infinity, undefined, BigInt(1), Symbol("x"), () => 1, new Date()]) {
      await expect(client.callFunction("add", [value])).rejects.toThrow(/finite|serializable|plain objects/)
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    await expect(client.callFunction("add", [cycle])).rejects.toThrow(/cycles/)
    expect(requests).toHaveLength(0)
    const point = { x: 1 }
    await client.callFunction("add", [[point, point]])
    expect(requests[0].body.args).toEqual([[{ x: 1 }, { x: 1 }]])
  })

  it("composes topology selection, callback, conditional and static-call expressions", () => {
    const edges = expr.call("edges")
    const selection = expr.index(expr.method(edges, "sort_by", [Axis.Z]), -1)
    const callback = expr.lambda((edge) => expr.operator(expr.get(edge, "length"), "gt", [10]))
    const predicate = expr.conditional(expr.operator(3, "gt", [2]), "yes", "no")
    expect(JSON.parse(JSON.stringify(callback))).toEqual({ $lambda: { $operator: { target: { $get: { target: { $arg: 0 }, name: "length" } }, name: "gt", args: [10] } } })
    expect(selection.$index.index).toBe(-1)
    expect(predicate.$if).toEqual({ condition: { $operator: { target: 3, name: "gt", args: [2] } }, then: "yes", else: "no" })
    expect(native.Solid.make_box(2, 3, 4)).toEqual({ $call: "Solid.make_box", args: [2, 3, 4], kwargs: {} })
    expect(native.Plane.XY).toEqual({ $type: "Plane", path: "XY" })
    expect(native.Box.withKwargs({ length: 2, width: 3, height: 4 })).toEqual({ $call: "Box", args: [], kwargs: { length: 2, width: 3, height: 4 } })
  })
})
