import { beforeAll, describe, expect, test } from 'vitest'
import { BrowserKernel } from '../lib/kernel'
import { KernelPlane } from '../lib/kernel/values'
import type { KernelShape } from '../lib/kernel/types'

let kernel: BrowserKernel
const invoke = (name: string, args: any[] = [], kwargs: Record<string, any> = {}) => kernel.context.invoke(name, args, kwargs)
const shape = (name: string, args: any[] = [], kwargs: Record<string, any> = {}) => invoke(name, args, kwargs) as KernelShape
beforeAll(async () => { kernel = await BrowserKernel.create() }, 60_000)

describe('browser OpenCascade sketches', () => {
  test('profiles follow the workplane normal and local coordinates', () => {
    const plane = new KernelPlane([4, 5, 6], [1, 0, 0], [0, -1, 0])
    kernel.context.builders.push({ kind: 'BuildSketch', shape: null, pending: [], plane, locations: [] })
    try {
      const circle = shape('Circle', [3])
      expect(circle.shape.boundingBox.center).toEqual([4, 5, 6])
      const normal = (circle.shape as any).normalAt().toTuple()
      expect(normal[0]).toBeCloseTo(0, 7)
      expect(normal[1]).toBeCloseTo(-1, 7)
      expect(normal[2]).toBeCloseTo(0, 7)
      expect(kernel.context.replicad.measureArea(circle.shape as any)).toBeCloseTo(9 * Math.PI, 8)
    } finally { kernel.context.builders.pop() }
  })

  test('splines interpolate supplied interior points rather than approximating a control polygon', () => {
    const points = [[0, 0], [1, 4], [3, -2], [5, 1]]
    const spline = shape('Spline', points)
    for (const p of points) expect(kernel.context.replicad.measureDistanceBetween(spline.shape, kernel.context.replicad.makeVertex(p as [number, number]))).toBeLessThan(1e-6)
    const periodic = shape('Spline', [[0, 0], [2, 0], [2, 2], [0, 2]], { periodic: true })
    expect((periodic.shape as any).isClosed).toBe(true)
  })

  test('rational quadratic Bezier and exact BSpline represent a quarter circle', () => {
    const points = [[1, 0], [1, 1], [0, 1]], weights = [1, Math.SQRT1_2, 1]
    const bezier = shape('Bezier', points, { weights })
    const bspline = shape('BSpline', [points, [0, 0, 0, 1, 1, 1], 2, weights])
    expect(kernel.context.replicad.measureLength(bezier.shape)).toBeCloseTo(Math.PI / 2, 6)
    expect(kernel.context.replicad.measureLength(bspline.shape)).toBeCloseTo(Math.PI / 2, 6)
  })

  test('fillets preserve tangent straight lengths and reject overlapping arcs', () => {
    const fillet = shape('FilletPolyline', [[0, 0], [10, 0], [10, 10]], { radius: 2 })
    expect(kernel.context.replicad.measureLength(fillet.shape)).toBeCloseTo(16 + Math.PI, 7)
    expect(() => shape('FilletPolyline', [[0, 0], [1, 0], [1, 1]], { radius: 2 })).toThrow(/does not fit/)
  })

  test('triangle side and angle constraints produce the same area', () => {
    const sides = shape('Triangle', [], { a: 3, b: 4, c: 5 })
    const angles = shape('Triangle', [], { a: 3, B: 90, C: 53.13010235415598 })
    expect(kernel.context.replicad.measureArea(sides.shape as any)).toBeCloseTo(6, 7)
    expect(kernel.context.replicad.measureArea(angles.shape as any)).toBeCloseTo(6, 7)
  })

  test('font outlines retain glyph holes and native text metric alignment', () => {
    const cad = shape('Text', ['CAD', 12], { font: 'DejaVu Sans' })
    const [min, max] = cad.shape.boundingBox.bounds
    expect(min[0]).toBeCloseTo(-12.240234375, 5)
    expect(min[1]).toBeCloseTo(-4.32421875, 5)
    expect(max[0]).toBeCloseTo(12.205078125, 5)
    expect(max[1]).toBeCloseTo(4.751953125, 5)
    expect(kernel.context.replicad.measureArea(cad.shape as any)).toBeCloseTo(70.74948120117188, 7)
    const u = shape('Text', ['Fixture Sub Title', 4], { font: 'DejaVu Sans' })
    expect(kernel.context.replicad.measureArea(u.shape as any)).toBeGreaterThan(0)
    expect(cad.shape.faces.some(face => face.innerWires().length > 0)).toBe(true)
  })

  test('drafting dimensions validate offsets and include readable native glyph geometry', () => {
    const draft = invoke('Draft', [], { font_size: 2, arrow_length: 1, font: 'DejaVu Sans' })
    const dimension = shape('DimensionLine', [], { path: [[0, 0], [30, 0]], draft, tolerance: [.1, .2] })
    const extension = shape('ExtensionLine', [], { border: [[0, 0], [30, 0]], offset: [0, 5], draft })
    expect((dimension as any).dimension).toBe(30)
    expect(extension.shape.boundingBox.bounds[1][1]).toBeCloseTo(7, 6)
    expect(() => shape('ExtensionLine', [], { border: [[0, 0], [30, 0]], offset: [2, 3], measurement_direction: [1, 0], draft })).toThrow(/perpendicular/)
    expect(() => shape('DimensionLine', [], { path: [[0, 0], [30, 0]], draft, arrows: [false, false] })).toThrow(/No output/)
  })

  test('constraints preserve every tangent solution in a single curve result', () => {
    const a = shape('CenterArc', [[-5, 0], 4, 0, 360]), b = shape('CenterArc', [[5, 0], 3, 0, 360])
    const lines = shape('ConstrainedLines', [a, b])
    expect(lines.shape.edges).toHaveLength(4)
    const arcs = shape('ConstrainedArcs', [[0, 0], [4, 0]], { radius: 3, sagitta: 'BOTH' })
    expect(arcs.shape.edges).toHaveLength(4)
  })

  test('single-edge slot offsets use genuine closed contours with end arcs', () => {
    const slot = shape('SlotArc', [shape('Line', [[0, 0], [10, 0]]), 2])
    expect(kernel.context.replicad.measureArea(slot.shape as any)).toBeCloseTo(20 + Math.PI, 7)
    const superellipse = shape('Superellipse', [10, 8, 4])
    expect(kernel.context.replicad.measureArea(superellipse.shape as any)).toBeGreaterThan(70)
  })

  test('conic curve bindings preserve analytic endpoint positions', () => {
    const parabola = shape('ParabolicCenterArc', [[0, 0], 2])
    const hyperbola = shape('HyperbolicCenterArc', [[0, 0], 5, 3])
    const p = (parabola.shape as any).endPoint.toTuple(), h = (hyperbola.shape as any).endPoint.toTuple()
    expect(p[0]).toBeCloseTo((Math.PI / 2) ** 2 / 8, 7)
    expect(p[1]).toBeCloseTo(Math.PI / 2, 7)
    expect(h[0]).toBeCloseTo(5 * Math.cosh(Math.PI / 2), 7)
    expect(h[1]).toBeCloseTo(3 * Math.sinh(Math.PI / 2), 7)
  })

  test('IntersectingLine chooses the nearest finite straight-edge crossing', () => {
    const target = shape('Polyline', [[8, -2], [8, 2], [3, 2], [3, -2]])
    const intersection = shape('IntersectingLine', [[0, 0], [2, 0], target])
    expect(kernel.context.replicad.measureLength(intersection.shape)).toBeCloseTo(3, 7)
    expect((intersection.shape as any).endPoint.toTuple()).toEqual([3, 0, 0])
    const backward = shape('IntersectingLine', [], { start: [0, 0], direction: [1, 0], other: shape('Line', [[-5, -2], [-5, 2]]) })
    expect((backward.shape as any).endPoint.toTuple()).toEqual([5, 0, 0])
    const threeD = shape('IntersectingLine', [[0, 0, 0], [1, 1, 1], shape('Line', [[3, 2, 3], [3, 4, 3]])])
    expect((threeD.shape as any).endPoint.toTuple().map((v: number) => Math.round(v))).toEqual([3, 3, 3])
  })

  test('IntersectingLine rejects parallel, finite misses and unsupported curve/surface targets', () => {
    expect(() => shape('IntersectingLine', [[0, 0], [1, 0], shape('Line', [[0, 1], [5, 1]])])).toThrow(/No intersections/)
    expect(() => shape('IntersectingLine', [[0, 0], [1, 0], shape('Line', [[5, 1], [5, 2]])])).toThrow(/No intersections/)
    expect(() => shape('IntersectingLine', [[0, 0], [1, 0], shape('Line', [[5, -1, 1], [5, 1, 1]])])).toThrow(/same plane/)
    expect(() => shape('IntersectingLine', [[0, 0], [1, 0], shape('CenterArc', [[5, 0], 2, 0, 360])])).toThrow(/curved intersections/)
    expect(() => shape('IntersectingLine', [[0, 0], [1, 0], shape('Rectangle', [10, 10])])).toThrow(/surface intersections/)
  })
})
