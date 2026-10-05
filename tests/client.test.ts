import { describe, expect, it, vi } from "vitest"
import { NativeClient, NativeError, NativeHandle, expr } from "../lib/client"
import { Align, Axis, native, values } from "../lib/generated/values"
import type { BrowserKernel } from "../lib/kernel/index"
import { publicSymbols, symbolKinds, auxiliarySymbols } from "../lib/generated/symbols"

function stub(...responses: unknown[]) {
  const requests: { body: any }[] = []
  const rpc = vi.fn(async (request: unknown) => {
    requests.push({ body: request })
    return responses.shift() ?? { value: null }
  })
  const kernel = { rpc } as unknown as BrowserKernel
  return { client: new NativeClient({ kernel }), requests, rpc, kernel }
}

describe("local WebAssembly API client", () => {
  it("exposes every native root export and dispatches constructor/function calls correctly", async () => {
    const { client, requests } = stub({ value: { $ref: "box", kind: "Box" } }, { value: [3, 4] })
    expect(Object.keys(client.api)).toEqual([...publicSymbols, ...auxiliarySymbols])
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
    const edges = await client.callStatic<NativeHandle>("Solid", "make_box", [1, 2, 3])
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
    const kernel = {
      rpc: vi.fn(async (request: any) => {
        if (request.op === "construct") return { value: [{ $ref: "s1" }, { $ref: "s2" }] }
        if (request.target.$ref === "s1" && fail) throw new Error("retry release")
        return { value: null }
      }),
    } as unknown as BrowserKernel
    const client = new NativeClient({ kernel })
    const handles = await client.construct<NativeHandle[]>("ShapeList")
    await expect(client.releaseAll()).rejects.toThrow(/could not be released/)
    expect(handles[0].isReleased).toBe(false)
    expect(handles[1].isReleased).toBe(true)
    fail = false
    await client.releaseAll()
    expect(handles[0].isReleased).toBe(true)
  })

  it("retains structured local errors and initialization causes", async () => {
    const cause = Object.assign(new RangeError("Invalid radius"), { path: "construct.Sphere", details: { radius: -1 } })
    const kernel = { rpc: vi.fn(() => { throw cause }) } as unknown as BrowserKernel
    const client = new NativeClient({ kernel })
    const error = await client.construct("Sphere", [], { radius: -1 }).catch((error) => error)
    expect(error).toBeInstanceOf(NativeError)
    expect(error).toMatchObject({ message: "Invalid radius", kernelType: "RangeError", path: "construct.Sphere", cause })
    const missingValue = stub({ unexpected: true }).client
    await expect(missingValue.construct("Box", [1, 2, 3])).rejects.toThrow(/invalid RPC response/)
    const offline = new NativeClient({ kernel: Promise.reject(cause) })
    await expect(offline.construct("Box", [1, 2, 3])).rejects.toMatchObject({ name: "NativeError", cause })
  })

  it("shares an injected asynchronous kernel and reads the local inventory", async () => {
    const inventory = { exports: [...publicSymbols], runtime: "OpenCascade WebAssembly" }
    const kernel = { inventory: vi.fn(() => inventory) } as unknown as BrowserKernel
    const client = new NativeClient({ kernel: Promise.resolve(kernel) })
    expect(await client.ready).toBe(kernel)
    expect(await client.inventory()).toEqual(inventory)
    expect(kernel.inventory).toHaveBeenCalledOnce()
  })

  it("renders locally with OCCT tessellation options and cancellation", async () => {
    const controller = new AbortController()
    const scene = { meshes: [], bounds: null, kernel: "OpenCascade WebAssembly" }
    const render = vi.fn(async () => scene)
    const client = new NativeClient({ kernel: { render } as unknown as BrowserKernel })
    const plan = { version: 1 as const, children: [{ type: "Box", props: { length: 2, width: 3, height: 4 }, children: [] }] }
    const options = { tolerance: 0.01, angularTolerance: 0.1, signal: controller.signal }
    expect(await client.render(plan, options)).toEqual(scene)
    expect(render).toHaveBeenCalledWith(plan, options)
    controller.abort()
    await expect(client.render(plan, options)).rejects.toMatchObject({ name: "AbortError" })
    expect(render).toHaveBeenCalledOnce()
  })

  it("preserves constructor default cancellation and allows explicitly clearing it", async () => {
    const controller = new AbortController()
    controller.abort()
    const { kernel, requests } = stub({ value: 1 })
    const client = new NativeClient({ kernel, signal: controller.signal })
    await expect(client.resolve("MM")).rejects.toMatchObject({ name: "AbortError" })
    expect(requests).toHaveLength(0)
    expect(await client.resolve("MM", { signal: null })).toBe(1)
    expect(client.api.MM).toBe(1)
    expect(client.api.Align.CENTER).toEqual({ $enum: "Align.CENTER" })
  })

  it("cancels while WebAssembly initialization is pending without invoking CAD", async () => {
    let initialize!: (kernel: BrowserKernel) => void
    const pending = new Promise<BrowserKernel>(resolve => { initialize = resolve })
    const controller = new AbortController()
    const { kernel, requests } = stub({ value: 1 })
    const client = new NativeClient({ kernel: pending })
    const result = client.resolve("MM", { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toHaveLength(0)
    initialize(kernel)
    expect(await client.resolve("MM")).toBe(1)
  })

  it("rejects JSON lossy values before issuing a request and accepts repeated plain values", async () => {
    const { client, requests } = stub()
    for (const value of [NaN, Infinity, undefined, BigInt(1), Symbol("x"), () => 1, new Date()]) {
      await expect(client.callFunction<unknown>("add", [value])).rejects.toThrow(/finite|serializable|plain objects/)
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    await expect(client.callFunction<unknown>("add", [cycle])).rejects.toThrow(/cycles/)
    expect(requests).toHaveLength(0)
    const point = { x: 1 }
    await client.callFunction<unknown>("add", [[point, point]])
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
