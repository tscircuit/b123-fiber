import { beforeAll, expect, test } from 'vitest'
import { BrowserKernel } from '../lib/kernel'
import type { PlanNode, WireValue } from '../lib/types'

let kernel: BrowserKernel
beforeAll(async () => { kernel = await BrowserKernel.create() }, 120_000)
const node = (type: string, props: Record<string, WireValue> = {}, children: PlanNode[] = []): PlanNode => ({ type, props, children })
const render = (...children: PlanNode[]) => kernel.render({ version: 1, children })

test('nested placements transform each boolean operand exactly once', () => {
  const output = render(node('Translate', { offset: [10, 0, 0] }, [node('Subtract', {}, [
    node('Box', { length: 4, width: 4, height: 4 }),
    node('Cylinder', { radius: 1, height: 8 }),
  ])]))
  expect(output.meshes[0]!.volume).toBeCloseTo(64 - 4 * Math.PI, 8)
  expect(output.bounds!.min[0]).toBeCloseTo(8)
  expect(output.bounds!.max[0]).toBeCloseTo(12)
})

test('explicit operands take precedence over composition children', () => {
  const output = render(node('extrude', { amount: 3, to_extrude: { $call: 'Circle', args: [2] } }, [node('Circle', { radius: 10 })]))
  expect(output.meshes[0]!.volume).toBeCloseTo(12 * Math.PI, 8)
})

test('captured builders resolve topology and named references remain scoped to a plan', () => {
  const output = render(node('BuildPart', {}, [
    node('Box', { length: 8, width: 6, height: 4, id: 'box' }),
    node('fillet', { radius: 1, objects: { $method: { target: { $ref: 'box' }, name: 'edges' } } }),
  ]))
  expect(output.meshes[0]!.valid).toBe(true)
  expect(output.meshes[0]!.volume).toBeLessThan(192)
  expect(() => kernel.decode({ $ref: 'box' })).toThrow(/reference/)
})

test('unsupported public members fail with useful errors and later plans recover', () => {
  expect(() => kernel.decode({ $call: 'Solid.not_a_method' })).toThrow(/does not implement/)
  expect(() => kernel.decode({ $type: 'Solid', path: 'not_a_property' })).toThrow(/unsupported/)
  expect(() => kernel.decode({ $get: { target: [1], name: '__proto__' } })).toThrow(/not public/)
  expect(render(node('Box', { length: 2, width: 3, height: 4 })).meshes[0]!.volume).toBeCloseTo(24)
})

test('render tolerances reject invalid values before native meshing', () => {
  const plan = { version: 1 as const, children: [node('Sphere', { radius: 2 })] }
  for (const tolerance of [0, -1, Infinity, NaN]) expect(() => kernel.render(plan, { tolerance })).toThrow(/positive finite/)
})

test('empty scenes have no geometry or bounds', () => {
  expect(render()).toEqual({ meshes: [], bounds: null, kernel: 'OpenCascade WebAssembly' })
})
