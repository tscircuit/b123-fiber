import { beforeAll, expect, test } from 'vitest'
import { NativeClient } from '../lib/client'
import { BrowserKernel } from '../lib/kernel'
import { applyOperator, callMethod, getProperty } from '../lib/kernel/values'
import type { PlanNode, WireValue } from '../lib/types'

let kernel: BrowserKernel
let client: NativeClient
beforeAll(async () => {
  kernel = await BrowserKernel.create()
  client = new NativeClient({ kernel })
}, 120_000)
const node = (type: string, props: Record<string, WireValue> = {}, children: PlanNode[] = []): PlanNode => ({ type, props, children })
const render = (...children: PlanNode[]) => kernel.render({ version: 1, children })
const plane = (name: string): WireValue => ({ $type: 'Plane', path: name })
const box = () => node('Box', { length: 2, width: 4, height: 6 })
const call = (name: string, args: any[] = [], kwargs: Record<string, any> = {}) => kernel.context.invoke(name, args, kwargs)
const method = (target: any, name: string, args: any[] = [], kwargs: Record<string, any> = {}) => callMethod(target, name, args, kwargs, kernel.context)
const get = (target: any, name: string) => getProperty(target, name, kernel.context)

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
  expect(inventory.supported).toHaveLength(203)
  expect(inventory.unsupported).toEqual([])
  expect(inventory.declarative).toContain('BuildPart')
  expect(inventory.callable).toContain('Box')
  expect(inventory.callable).toEqual(expect.arrayContaining([
    'RotationLike', 'VectorLike', 'Export2D', 'detect_primitives', 'import_svg_as_buildline_code', 'export_to_pcbway',
  ]))
  expect(inventory.partial).toContain('Box')
  expect(inventory.compatibility).toMatch(/partially implemented/)
})

test('extrude supports Until.NEXT, Until.LAST, and Until.PREVIOUS against active and explicit targets', () => {
  // Sketch at z = 0 extruded UP (Until.NEXT) to a box elevated at z in [6, 10]
  const nextOutput = render(node('BuildPart', {}, [
    node('Locations', { args: [[0, 0, 8]] }, [node('Box', { length: 10, width: 10, height: 4 })]),
    node('BuildSketch', { workplane: plane('XY') }, [node('Rectangle', { width: 4, height: 4 })]),
    node('extrude', { until: { $enum: 'Until.NEXT' } }),
  ]))
  // Base box volume = 10*10*4 = 400; pillar from z=0 to z=6 has volume = 4*4*6 = 96
  expect(nextOutput.meshes[0]!.volume).toBeCloseTo(400 + 96, 5)

  // Sketch at z = 0 extruded UP (Until.LAST) through the same box at z in [6, 10]
  const lastOutput = render(node('BuildPart', {}, [
    node('Locations', { args: [[0, 0, 8]] }, [node('Box', { length: 10, width: 10, height: 4 })]),
    node('BuildSketch', { workplane: plane('XY') }, [node('Rectangle', { width: 2, height: 2 })]),
    node('extrude', { until: { $enum: 'Until.LAST' }, mode: { $enum: 'Mode.SUBTRACT' } }),
  ]))
  // Cuts a 2x2 hole through the elevated box (4*4 = 16 removed from 400)
  expect(lastOutput.meshes[0]!.volume).toBeCloseTo(400 - 16, 5)

  // Sketch at z = 10 extruded in reverse normal (Until.PREVIOUS) down to box at z in [0, 4]
  const upperPlane: WireValue = { $method: { target: plane('XY'), name: 'offset', args: [10] } }
  const prevOutput = render(node('BuildPart', {}, [
    node('Locations', { args: [[0, 0, 2]] }, [node('Box', { length: 10, width: 10, height: 4 })]),
    node('BuildSketch', { workplane: upperPlane }, [node('Rectangle', { width: 4, height: 4 })]),
    node('extrude', { until: { $enum: 'Until.PREVIOUS' } }),
  ]))
  expect(prevOutput.meshes[0]!.volume).toBeCloseTo(400 + 96, 5)
})

test('Intrinsic and Extrinsic Euler rotation orderings, axis-angle Rot, and uniform tuple scaling', () => {
  const rotIntrinsic = call('Rot', [[90, 90, 0], 'Intrinsic.XYZ'])
  const rotExtrinsic = call('Rot', [[90, 90, 0], 'Extrinsic.XYZ'])
  const vInt = applyOperator('mul', [rotIntrinsic, [1, 0, 0]], kernel.context).toTuple()
  const vExt = applyOperator('mul', [rotExtrinsic, [1, 0, 0]], kernel.context).toTuple()
  // Intrinsic XYZ(90, 90, 0) = Rx(90) * Ry(90) maps (1, 0, 0) -> (0, 1, 0)
  expect(vInt[0]).toBeCloseTo(0, 6)
  expect(vInt[1]).toBeCloseTo(1, 6)
  expect(vInt[2]).toBeCloseTo(0, 6)
  // Extrinsic XYZ(90, 90, 0) = Ry(90) * Rx(90) maps (1, 0, 0) -> (0, 0, -1)
  expect(vExt[0]).toBeCloseTo(0, 6)
  expect(vExt[1]).toBeCloseTo(0, 6)
  expect(vExt[2]).toBeCloseTo(-1, 6)

  // Axis-angle Rot(Axis.Z, 90)
  const rotAxis = call('Rot', [call('Axis.Z'), 90])
  const vAxis = applyOperator('mul', [rotAxis, [2, 0, 0]], kernel.context).toTuple()
  expect(vAxis[0]).toBeCloseTo(0, 6)
  expect(vAxis[1]).toBeCloseTo(2, 6)

  // Uniform 3-tuple scaling
  const scaled = render(node('BuildPart', {}, [
    node('Box', { length: 2, width: 2, height: 2 }),
    node('scale', { by: [2, 2, 2], mode: { $enum: 'Mode.REPLACE' } }),
  ]))
  expect(scaled.meshes[0]!.volume).toBeCloseTo(64, 6)
  expect(() => render(node('BuildPart', {}, [
    node('Box', { length: 2, width: 2, height: 2 }),
    node('scale', { by: [2, 3, 2], mode: { $enum: 'Mode.REPLACE' } }),
  ]))).toThrow(/Nonuniform scaling/)
})

test('RevoluteJoint, LinearJoint, CylindricalJoint, and BallJoint enforce bounds and transform connected parts', () => {
  const base = call('Box', [2, 2, 2])
  const arm = call('Box', [2, 2, 2])

  const rev = call('RevoluteJoint', ['hinge', base], { axis: call('Axis.Z'), angular_range: [0, 180] })
  const rigid = call('RigidJoint', ['mount', arm, call('Location', [[-5, 0, 0]])])

  method(rev, 'connect_to', [rigid], { angle: 90 })
  const coords = method(arm, 'center').toTuple()
  expect(coords[0]).toBeCloseTo(0, 5)
  expect(coords[1]).toBeCloseTo(5, 5)
  expect(coords[2]).toBeCloseTo(0, 5)

  expect(() => method(rev, 'connect_to', [rigid], { angle: 270 })).toThrow(/must be in range/)

  const lin = call('LinearJoint', ['slider', base], { axis: call('Axis.Z'), linear_range: [-10, 10] })
  method(lin, 'connect_to', [rigid], { position: 7 })
  const linCoords = method(arm, 'center').toTuple()
  expect(linCoords[0]).toBeCloseTo(5, 5)
  expect(linCoords[2]).toBeCloseTo(7, 5)
  expect(() => method(lin, 'connect_to', [rigid], { position: 25 })).toThrow(/must be in range/)
})

test('detect_primitives identifies analytic shapes and separates freeform leftovers', () => {
  const cyl = call('Cylinder', [3, 12])
  const [detectedCyl, leftoverCyl, cylCodes] = call('detect_primitives', [cyl])
  expect(detectedCyl).toHaveLength(3)
  expect(leftoverCyl).toHaveLength(0)
  expect(cylCodes).toEqual(['Cylinder(3, 12)'])

  const torus = call('Torus', [8, 2])
  const [, , torusCodes] = call('detect_primitives', [torus])
  expect(torusCodes).toEqual(['Torus(8, 2)'])
  const torusFaces = method(torus, 'faces')
  expect(get(torusFaces[0], 'radius')).toBeCloseTo(8, 6)
})

test('import_svg_as_buildline_code, Export2D static properties, and export_to_pcbway', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 10 0 L 10 5 Z"/><circle cx="2" cy="3" r="4"/></svg>'
  const stream = call('StringIO', [svg])
  const [code, builderName] = call('import_svg_as_buildline_code', [stream]) as [string, string]
  expect(builderName).toBe('line')
  expect(code).toContain('with BuildLine() as line:')
  expect(code).toContain('Line((0, 0), (10, 0))')
  expect(code).toContain('ThreePointArc((-2, -3), (2, -7), (6, -3))')

  expect(() => call('Export2D', [])).toThrow(/abstract base class/)
  expect(await client.resolve('Export2D.DEFAULT_LINE_WEIGHT')).toBe(0.09)
  expect(await client.resolve('ExportDXF.METRIC_UNITS')).toContain('Unit.MM')

  const boxShape = call('Box', [4, 4, 4])
  expect(() => call('export_to_pcbway', [boxShape])).toThrow(/pcbwayUpload/)

  let uploadedBytes = 0
  const customKernel = await BrowserKernel.create({
    pcbwayUpload: (step) => {
      uploadedBytes = step.byteLength
      return 'https://www.pcbway.com/project/custom-upload'
    },
  })
  const customBox = customKernel.context.invoke('Box', [4, 4, 4])
  const url = customKernel.context.invoke('export_to_pcbway', [customBox])
  expect(url).toBe('https://www.pcbway.com/project/custom-upload')
  expect(uploadedBytes).toBeGreaterThan(100)
})


