import { afterAll, beforeAll, expect, test } from 'vitest'
import { useState } from 'react'
import { NativeClient, NativeError, type NativeHandle } from '../lib/client'
import { Box, BuildPart, Cylinder, Fillet, Shape, Subtract, Translate } from '../lib/components'
import { renderToBuild123dPlan } from '../lib/headless'
import { createBuild123dRoot } from '../lib/renderer'
import { Axis, native } from '../lib/generated/values'
import { expr } from '../lib/generated/runtime'
import { publicSymbols } from '../lib/generated/symbols'

let client: NativeClient

beforeAll(async () => {
  client = new NativeClient()
  await client.ready
}, 30_000)

afterAll(async () => { await client?.releaseAll() })

test('the TypeScript and local WASM inventories agree on every public export', async () => {
  const api = await client.inventory<{ exports: string[]; version: string }>()
  expect(api.version).toBe('0.13.0')
  expect(api.exports).toEqual([...publicSymbols])
  expect(api.exports).toHaveLength(203)
})

test('a headless JSX plan produces valid native triangles and exact box volume', async () => {
  const plan = renderToBuild123dPlan(<Box length={20} width={12} height={6} />)
  const result = await client.render(plan)
  expect(result.meshes).toHaveLength(1)
  expect(result.meshes[0]!.volume).toBeCloseTo(1440, 8)
  expect(result.meshes[0]!.valid).toBe(true)
  expect(result.meshes[0]!.indices.length).toBe(36)
  expect(result.meshes[0]!.normals.every(Number.isFinite)).toBe(true)
  expect(result.bounds!.min).toEqual([-10, -6, -3])
})

test('OCCT triangle orientation and enclosed mesh volume agree with native geometry', async () => {
  const result = await client.render(renderToBuild123dPlan(<Subtract>
    <Box length={12} width={10} height={8} />
    <Cylinder radius={2} height={10} />
  </Subtract>), { tolerance: 0.05, angularTolerance: 0.05 })
  const mesh = result.meshes[0]!
  let signedVolume = 0
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = mesh.indices[index]! * 3, b = mesh.indices[index + 1]! * 3, c = mesh.indices[index + 2]! * 3
    const [ax, ay, az] = mesh.positions.slice(a, a + 3) as [number, number, number]
    const [bx, by, bz] = mesh.positions.slice(b, b + 3) as [number, number, number]
    const [cx, cy, cz] = mesh.positions.slice(c, c + 3) as [number, number, number]
    signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
    const normal = [(by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)]
    const dot = normal.reduce((sum, value, axis) => sum + value * mesh.normals[a + axis]!, 0)
    expect(dot).toBeGreaterThanOrEqual(-1e-8)
  }
  expect(signedVolume).toBeGreaterThan(0)
  expect(Math.abs(signedVolume - mesh.volume) / mesh.volume).toBeLessThan(0.002)
})

test('live React state updates change the actual native geometry', async () => {
  let updateHeight!: (height: number) => void
  function ParametricBox() {
    const [height, setHeight] = useState(3)
    updateHeight = setHeight
    return <Box length={10} width={8} height={height} />
  }
  const root = createBuild123dRoot()
  try {
    expect((await client.render(root.render(<ParametricBox />))).meshes[0]!.volume).toBeCloseTo(240)
    root.flush(() => updateHeight(7))
    expect((await client.render(root.getPlan())).meshes[0]!.volume).toBeCloseTo(560)
  } finally { root.unmount() }
})

test('JSX selector expressions and native handle methods produce identical fillets', async () => {
  const box = await client.construct('Box', [], { length: 10, width: 8, height: 6 })
  const edges = await box.call<NativeHandle>('edges')
  const vertical = await edges.call<NativeHandle>('filter_by', [Axis.Z])
  const rounded = await box.call<NativeHandle>('fillet', [1, vertical])
  const result = await client.render(renderToBuild123dPlan(<BuildPart>
    <Box length={10} width={8} height={6} />
    <Fillet radius={1} objects={expr.method(native.edges(), 'filter_by', [Axis.Z])} />
  </BuildPart>))
  expect(result.meshes[0]!.volume).toBeCloseTo(await rounded.get<number>('volume'), 8)
  expect(result.meshes[0]!.valid).toBe(true)
})

test('retained native shapes interoperate with JSX and transforms', async () => {
  const box = await client.construct('Box', [4, 6, 8])
  const result = await client.render(renderToBuild123dPlan(<Translate offset={[10, 0, 0]}>
    <Shape shape={box} />
  </Translate>))
  expect(result.meshes[0]!.volume).toBeCloseTo(192)
  expect(result.bounds!.min[0]).toBeCloseTo(8)
  expect(result.bounds!.max[0]).toBeCloseTo(12)
})

test('native shape colors and labels survive tessellation and JSX can override them', async () => {
  const box = await client.construct('Box', [4, 6, 8])
  await box.set('color', native.Color(0.2, 0.4, 0.6, 0.35))
  await box.set('label', 'Native part')
  const nativeResult = await client.render(renderToBuild123dPlan(<Shape shape={box} />))
  expect(nativeResult.meshes[0]!.color).toEqual([0.2, 0.4, 0.6, 0.35])
  expect(nativeResult.meshes[0]!.name).toBe('Native part')
  const overridden = await client.render(renderToBuild123dPlan(<Shape shape={box} color="orange" name="Override" />))
  expect(overridden.meshes[0]!.color).toBe('orange')
  expect(overridden.meshes[0]!.name).toBe('Override')
})

test('native callable selectors accept serializable lambda expressions', async () => {
  const box = await client.construct('Box', [10, 8, 6])
  const edges = await box.call<NativeHandle>('edges')
  const predicate = expr.lambda(expr.operator(expr.get(expr.arg(0), 'length'), 'gt', [9]))
  const selected = await edges.call<NativeHandle>('filter_by', [predicate])
  expect(await selected.length()).toBe(4)
  const sample = await selected.slice(1, 3)
  expect(await sample.length()).toBe(2)
})

test('native errors retain their type and path and do not corrupt later builders', async () => {
  await expect(client.render(renderToBuild123dPlan(<BuildPart>
    <Box length={10} width={8} height={6} />
    <Fillet radius={999} objects={native.edges()} />
  </BuildPart>))).rejects.toMatchObject({ name: 'NativeError', path: 'plan.children[0].children[1]' })
  const result = await client.render(renderToBuild123dPlan(<Box length={2} width={3} height={4} />))
  expect(result.meshes[0]!.volume).toBeCloseTo(24)
  await expect(client.construct('NoSuchClass')).rejects.toBeInstanceOf(NativeError)
})

test('concurrent requests retain independent native objects and released refs fail early', async () => {
  const boxes = await Promise.all([2, 3, 4, 5].map(length => client.construct('Box', [length, 2, 3])))
  expect(await Promise.all(boxes.map(box => box.get<number>('volume')))).toEqual([12, 18, 24, 30])
  await boxes[0]!.release()
  await expect(boxes[0]!.get('volume')).rejects.toThrow('released')
})

test('auxiliary native streams and ColorIndex are exposed as callable/value helpers', async () => {
  expect(client.api.ColorIndex.RED).toEqual({ $enum: 'ColorIndex.RED' })
  const bytes = await client.api.BytesIO({ initial_bytes: expr.bytes('aGVsbG8=') })
  const text = await client.api.StringIO({ initial_value: 'native' })
  try {
    expect(await bytes.call('getvalue')).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
    expect(await text.call('getvalue')).toBe('native')
    expect(await bytes.get('closed')).toBe(false)
  } finally {
    await Promise.all([bytes.release(), text.release()])
  }
})

test('native selector keys can be invoked directly and embedded as expressions', async () => {
  const box = await client.api.Box({ length: 2, width: 3, height: 4 })
  const faces = await box.call('faces')
  const reference = await faces.at(0)
  const distance = await client.api.topo_distance_to({ other: reference })
  try {
    expect(await distance.invoke([reference])).toBe(0)
    expect(await client.invoke(distance, [reference])).toBe(0)
    const result = await client.render(renderToBuild123dPlan(<Box length={expr.operator(expr.apply(distance, [reference]), 'add', [2])} width={3} height={4} />))
    expect(result.meshes[0]!.volume).toBeCloseTo(24)
    await expect(reference.invoke([])).rejects.toMatchObject({ name: 'NativeError' })
  } finally {
    await Promise.all([box.release(), faces.release(), reference.release(), distance.release()])
  }
})
