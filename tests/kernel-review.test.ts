import { beforeAll, expect, test } from 'vitest'
import { BrowserKernel } from '../lib/kernel'
import type { PlanNode, WireValue } from '../lib/types'

let kernel: BrowserKernel
beforeAll(async () => { kernel = await BrowserKernel.create() }, 120_000)
const node = (type: string, props: Record<string, WireValue> = {}, children: PlanNode[] = []): PlanNode => ({ type, props, children })
const render = (...children: PlanNode[]) => kernel.render({ version: 1, children })
const plane = (name: string): WireValue => ({ $type: 'Plane', path: name })
const box = () => node('Box', { length: 2, width: 4, height: 6 })

test('solid primitive dimensions follow the builder workplane', () => {
  const output = render(node('BuildPart', { workplane: plane('YZ') }, [box()]))
  output.bounds!.min.forEach((value, index) => expect(value).toBeCloseTo([-3, -1, -2][index]!, 8))
  output.bounds!.max.forEach((value, index) => expect(value).toBeCloseTo([3, 1, 2][index]!, 8))
  expect(output.meshes[0]!.volume).toBeCloseTo(48, 8)
})

test('Locations accepts arrays of positions and applies every copy', () => {
  const output = render(node('Locations', { args: [[[1, 0, 0], [10, 0, 0]]] }, [box()]))
  expect(output.meshes).toHaveLength(2)
  expect(output.bounds!.min).toEqual([0, -2, -3])
  expect(output.bounds!.max).toEqual([11, 2, 3])
  expect(output.meshes.every(mesh => mesh.valid && Math.abs(mesh.volume - 48) < 1e-7)).toBe(true)
})

test('local placements follow translated workplane axes without repeating the origin offset', () => {
  const workplane: WireValue = { $call: 'Plane', args: [[100, 20, 30], [0, 1, 0], [1, 0, 0]] }
  const output = render(node('BuildPart', { workplane }, [node('Locations', { args: [[10, 0, 0]] }, [box()])]))
  expect(output.bounds!.min).toEqual([97, 29, 28])
  expect(output.bounds!.max).toEqual([103, 31, 32])
})

test('multiple builder placements each produce the completed geometry', () => {
  const upperPlane: WireValue = { $method: { target: plane('XY'), name: 'offset', args: [10] } }
  const output = render(node('BuildPart', { args: [plane('XY'), upperPlane] }, [box()]))
  expect(output.meshes).toHaveLength(2)
  expect(output.bounds!.min).toEqual([-1, -2, -3])
  expect(output.bounds!.max).toEqual([1, 2, 13])
  expect(output.meshes.map(mesh => mesh.volume)).toEqual([48, 48])
})

test('mirroring a planar sketch publishes its native dimension', () => {
  const output = render(node('BuildSketch', {}, [
    node('Rectangle', { width: 2, height: 4, position: [5, 0, 0] }),
    node('mirror', { about: plane('YZ') }),
  ]))
  expect(output.bounds!.min).toEqual([-6, -2, 0])
  expect(output.bounds!.max).toEqual([6, 2, 0])
  expect(output.meshes[0]!.area).toBeCloseTo(16, 8)
})

test('explicit combination modes override a modeling operation replacement default', () => {
  for (const [mode, volume] of [['ADD', 8], ['SUBTRACT', 7], ['REPLACE', 1]] as const) {
    const output = render(node('BuildPart', {}, [node('Box', { length: 2, width: 2, height: 2 }), node('scale', { by: 0.5, mode: { $enum: `Mode.${mode}` } })]))
    expect(output.meshes[0]!.volume, mode).toBeCloseTo(volume, 8)
  }
})

test('positional constructor modes are preserved by JSX plan composition', () => {
  const output = render(node('BuildPart', {}, [
    node('Box', { length: 4, width: 4, height: 4 }),
    node('Cylinder', { args: [1, 8, 360, [0, 0, 0], ['CENTER', 'CENTER', 'CENTER'], { $enum: 'Mode.SUBTRACT' }] }),
  ]))
  expect(output.meshes[0]!.volume).toBeCloseTo(64 - 4 * Math.PI, 8)
  expect(() => render(node('Box', { length: 1, width: 1, height: 1, mode: 'INVALID' }))).toThrow(/combination mode/)
})

test('BuildLine interprets its second positional argument as a mode rather than a placement', () => {
  const output = render(node('BuildLine', { args: [plane('YZ'), { $enum: 'Mode.ADD' }] }, [node('Line', { args: [[0, 0, 0], [10, 0, 0]] })]))
  output.bounds!.min.forEach(value => expect(value).toBeCloseTo(0, 8))
  output.bounds!.max.forEach((value, index) => expect(value).toBeCloseTo([0, 10, 0][index]!, 8))
})

test('assembly booleans render the modified BRep instead of stale child meshes', () => {
  const output = render(node('Subtract', {}, [
    node('Compound', { args: [[{ $call: 'Box', args: [4, 4, 4] }]] }),
    node('Cylinder', { radius: 1, height: 8 }),
  ]))
  expect(output.meshes).toHaveLength(1)
  expect(output.meshes[0]!.volume).toBeCloseTo(64 - 4 * Math.PI, 8)
})

test('declarative compounds preserve leaf colors, hierarchy and transformed placement', () => {
  const output = render(node('Compound', { name: 'assembly', position: [10, 0, 0] }, [
    node('Box', { length: 2, width: 2, height: 2, name: 'red', color: '#ff0000' }),
    node('Box', { length: 2, width: 2, height: 2, name: 'blue', color: '#0000ff', position: [4, 0, 0] }),
  ]))
  expect(output.meshes).toHaveLength(2)
  expect(output.meshes.map(mesh => mesh.name)).toEqual(['red', 'blue'])
  expect(output.meshes.map(mesh => mesh.color)).toEqual(['#ff0000', '#0000ff'])
  expect(output.meshes.map(mesh => mesh.assemblyPath)).toEqual([[{ name: 'assembly', index: 0 }], [{ name: 'assembly', index: 1 }]])
  expect(output.bounds!.min).toEqual([9, -1, -1])
  expect(output.bounds!.max).toEqual([15, 1, 1])
})

test('explicit native Compound operands take precedence over JSX children', () => {
  const output = render(node('Compound', { args: [[{ $call: 'Box', args: [2, 2, 2] }]] }, [node('Box', { length: 20, width: 20, height: 20 })]))
  expect(output.meshes).toHaveLength(1)
  expect(output.meshes[0]!.volume).toBeCloseTo(8, 8)
})

test('disjoint intersections and fully removed geometry produce an empty scene', () => {
  const empty = { meshes: [], bounds: null, kernel: 'OpenCascade WebAssembly' }
  expect(render(node('Intersect', {}, [box(), node('Box', { length: 2, width: 4, height: 6, position: [20, 0, 0] })]))).toEqual(empty)
  expect(render(node('Subtract', {}, [box(), box()]))).toEqual(empty)
  expect(render(node('Compound', { args: [[]] }))).toEqual(empty)
})

test('compatibility inventory distinguishes declarations from callable support', () => {
  const inventory = kernel.inventory()
  expect(inventory.exports).toHaveLength(203)
  expect(inventory.declarative).toContain('BuildPart')
  expect(inventory.callable).toContain('Box')
  expect(inventory.partial).toContain('Box')
  expect(inventory.compatibility).toMatch(/partially implemented/)
})
