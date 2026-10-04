import type { Build123dPlan, PlanNode, WireValue } from '../../lib/types'
import { advancedVisualFixtures } from './advanced-fixtures'

export interface VisualFixture {
  id: string
  title: string
  category: 'solid' | 'sketch' | 'curve' | 'operation' | 'assembly'
  plan: Build123dPlan
  expected: { volume?: number; minMeshes?: number; dimension: 0 | 1 | 2 | 3 }
}
const node = (type: string, props: Record<string, WireValue> = {}, ...children: PlanNode[]): PlanNode => ({ type, props, children })
const en = (name: string): WireValue => ({ $enum: name })
const plane = (name: string): WireValue => ({ $type: 'Plane', path: name })
const axis = (name: string): WireValue => ({ $type: 'Axis', path: name })
const atZ = (z: number): WireValue => ({ $call: 'Plane', kwargs: { origin: [0, 0, z] } })
const centeredMin = [en('Align.CENTER'), en('Align.CENTER'), en('Align.MIN')]
const fixture = (id: string, title: string, category: VisualFixture['category'], children: PlanNode[], dimension: 0 | 1 | 2 | 3 = 3, expected: Partial<VisualFixture['expected']> = {}): VisualFixture => ({ id, title, category, plan: { version: 1, children }, expected: { dimension, ...expected } })
const solid = (id: string, title: string, type: string, props: Record<string, WireValue>, volume?: number) => fixture(id, title, 'solid', [node(type, props)], 3, { volume })
const sketch = (id: string, title: string, type: string, props: Record<string, WireValue>) => fixture(id, title, 'sketch', [node('BuildSketch', {}, node(type, props))], 2)
const curve = (id: string, title: string, type: string, props: Record<string, WireValue>) => fixture(id, title, 'curve', [node('BuildLine', { color: '#254e77' }, node(type, props))], 1)
const part = (id: string, title: string, ...children: PlanNode[]) => fixture(id, title, 'operation', [node('BuildPart', {}, ...children)])

/** Each fixture executes native build123d; no hand-built substitute meshes. */
export const visualFixtures: VisualFixture[] = [
  fixture('vertex', 'Vertex · native point topology', 'curve', [node('Vertex', { args: [1, 2, 3], color: '#254e77' })], 0),
  solid('box', 'Box · centered', 'Box', { length: 18, width: 12, height: 8 }, 1728),
  solid('cylinder', 'Cylinder', 'Cylinder', { radius: 7, height: 12 }, Math.PI * 49 * 12),
  solid('cone', 'Cone', 'Cone', { bottom_radius: 8, top_radius: 2, height: 14 }),
  solid('sphere', 'Sphere', 'Sphere', { radius: 8 }, 4 * Math.PI * 512 / 3),
  solid('torus', 'Torus', 'Torus', { major_radius: 10, minor_radius: 3 }, 2 * Math.PI ** 2 * 10 * 9),
  solid('wedge', 'Wedge', 'Wedge', { xsize: 16, ysize: 12, zsize: 10, xmin: 3, zmin: 2, xmax: 13, zmax: 8 }),
  solid('sector-cylinder', 'Cylinder · 210° sector', 'Cylinder', { radius: 10, height: 8, arc_size: 210 }),
  solid('sector-torus', 'Torus · 240° sector', 'Torus', { major_radius: 11, minor_radius: 2.5, major_angle: 240 }),
  solid('hemisphere', 'Sphere · hemisphere', 'Sphere', { radius: 9, arc_size1: 0, arc_size2: 90 }),
  solid('rotated-box', 'Box · Euler rotation', 'Box', { length: 18, width: 8, height: 6, rotation: [20, 30, 35] }, 864),
  sketch('circle', 'Circle', 'Circle', { radius: 9 }),
  sketch('ellipse', 'Ellipse', 'Ellipse', { x_radius: 12, y_radius: 7 }),
  sketch('rectangle', 'Rectangle', 'Rectangle', { width: 20, height: 12 }),
  sketch('rounded-rectangle', 'RectangleRounded', 'RectangleRounded', { width: 22, height: 14, radius: 3 }),
  sketch('polygon', 'Polygon', 'Polygon', { args: [[-10, -6], [6, -9], [12, 0], [4, 8], [-8, 6]] }),
  sketch('hexagon', 'RegularPolygon · hexagon', 'RegularPolygon', { radius: 10, side_count: 6 }),
  sketch('octagon', 'RegularPolygon · octagon', 'RegularPolygon', { radius: 10, side_count: 8, rotation: 22.5 }),
  sketch('trapezoid', 'Trapezoid', 'Trapezoid', { width: 24, height: 10, left_side_angle: 65, right_side_angle: 75 }),
  sketch('slot-center-to-center', 'SlotCenterToCenter', 'SlotCenterToCenter', { center_separation: 14, height: 7 }),
  sketch('slot-overall', 'SlotOverall', 'SlotOverall', { width: 24, height: 7 }),
  sketch('slot-center-point', 'SlotCenterPoint', 'SlotCenterPoint', { center: [-6, 0], point: [6, 4], height: 6 }),
  sketch('text', 'Text · OCCT glyph faces', 'Text', { txt: 'CAD', font_size: 12, font: 'DejaVu Sans' }),
  curve('line', 'Line', 'Line', { args: [[-10, -6, 0], [10, 6, 8]] }),
  curve('polyline', 'Polyline', 'Polyline', { args: [[-12, -6], [-4, 7], [4, -3], [12, 6]] }),
  curve('closed-polyline', 'Polyline · closed', 'Polyline', { args: [[-10, -7], [10, -7], [8, 7], [-7, 9]], close: true }),
  curve('spline', 'Spline', 'Spline', { args: [[-12, -5], [-4, 8], [4, -7], [12, 6]] }),
  curve('bezier', 'Bezier', 'Bezier', { args: [[-12, -6], [-5, 14], [5, -12], [12, 6]] }),
  curve('center-arc', 'CenterArc', 'CenterArc', { center: [0, 0], radius: 10, start_angle: 15, arc_size: 260 }),
  curve('radius-arc', 'RadiusArc', 'RadiusArc', { start_point: [-8, 0], end_point: [8, 0], radius: 10 }),
  curve('three-point-arc', 'ThreePointArc', 'ThreePointArc', { args: [[-10, 0], [0, 9], [10, 0]] }),
  curve('sagitta-arc', 'SagittaArc', 'SagittaArc', { start_point: [-10, 0], end_point: [10, 0], sagitta: 5 }),
  curve('polar-line', 'PolarLine', 'PolarLine', { start: [-8, -5], length: 22, angle: 35 }),
  curve('helix', 'Helix', 'Helix', { pitch: 5, height: 20, radius: 6 }),
  fixture('compositional-extrude', 'extrude · nested sketch children', 'operation', [node('extrude', { amount: 8 }, node('BuildSketch', {}, node('Circle', { radius: 10 }), node('Circle', { radius: 6, mode: en('Mode.SUBTRACT') })))], 3, { volume: Math.PI * (100 - 36) * 8 }),
  fixture('compositional-fillet', 'fillet · nested Box child', 'operation', [node('fillet', { objects: { $select: 'edges' }, radius: 1.5 }, node('Box', { length: 18, width: 14, height: 8 }))]),
  part('extrude-circle', 'extrude · circle', node('BuildSketch', {}, node('Circle', { radius: 7 })), node('extrude', { amount: 12 })),
  part('extrude-taper', 'extrude · tapered hexagon', node('BuildSketch', {}, node('RegularPolygon', { radius: 10, side_count: 6 })), node('extrude', { amount: 12, taper: 10 })),
  part('extrude-both', 'extrude · both directions', node('BuildSketch', {}, node('SlotOverall', { width: 24, height: 8 })), node('extrude', { amount: 5, both: true })),
  part('extrude-ring', 'extrude · sketch subtraction', node('BuildSketch', {}, node('Circle', { radius: 10 }), node('Circle', { radius: 6, mode: en('Mode.SUBTRACT') })), node('extrude', { amount: 8 })),
  part('revolve', 'revolve · annular profile', node('BuildSketch', { args: [plane('XZ')] }, node('Polygon', { args: [[4, -5], [10, -5], [10, 4], [6, 6], [4, 3]] })), node('revolve', { axis: axis('Z') })),
  part('revolve-partial', 'revolve · 240° profile', node('BuildSketch', { args: [plane('XZ')] }, node('Polygon', { args: [[4, -5], [10, -5], [10, 5], [4, 5]] })), node('revolve', { axis: axis('Z'), revolution_arc: 240 })),
  part('loft', 'loft · circle to rectangle', node('BuildSketch', {}, node('Circle', { radius: 10 })), node('BuildSketch', { args: [atZ(15)] }, node('Rectangle', { width: 10, height: 10 })), node('loft', {})),
  part('loft-ruled', 'loft · ruled polygons', node('BuildSketch', {}, node('RegularPolygon', { radius: 11, side_count: 6 })), node('BuildSketch', { args: [atZ(14)] }, node('RegularPolygon', { radius: 7, side_count: 6, rotation: 30 })), node('loft', { ruled: true })),
  part('sweep', 'sweep · curved pipe', node('BuildSketch', { args: [plane('YZ')] }, node('Circle', { radius: 2 })), node('BuildLine', { ref: 'sweep-path' }, node('Spline', { args: [[0, 0, 0], [8, 0, 2], [14, 8, 5], [20, 10, 10]] })), node('sweep', { path: { $ref: 'sweep-path' } })),
  part('fillet', 'fillet · all box edges', node('Box', { length: 20, width: 14, height: 10 }), node('fillet', { objects: { $select: 'edges' }, radius: 2 })),
  part('chamfer', 'chamfer · all box edges', node('Box', { length: 20, width: 14, height: 10 }), node('chamfer', { objects: { $select: 'edges' }, length: 1.5 })),
  fixture('union', 'Union · box and cylinder', 'operation', [node('Union', {}, node('Box', { length: 16, width: 12, height: 8 }), node('Cylinder', { radius: 7, height: 16 }))]),
  fixture('subtract', 'Subtract · through hole', 'operation', [node('Subtract', {}, node('Box', { length: 22, width: 16, height: 8 }), node('Cylinder', { radius: 5, height: 12 }))], 3, { volume: 2816 - Math.PI * 25 * 8 }),
  fixture('intersect', 'Intersect · sphere and box', 'operation', [node('Intersect', {}, node('Sphere', { radius: 10 }), node('Box', { length: 16, width: 16, height: 8 }))]),
  part('grid-locations', 'GridLocations · 3 × 2 bosses', node('GridLocations', { x_spacing: 12, y_spacing: 12, x_count: 3, y_count: 2 }, node('Cylinder', { radius: 3, height: 8 }))),
  part('polar-locations', 'PolarLocations · six bosses', node('PolarLocations', { radius: 12, count: 6 }, node('Cylinder', { radius: 3, height: 8 }))),
  part('counterbore', 'CounterBoreHole', node('Box', { length: 24, width: 18, height: 10, align: centeredMin }), node('Locations', { args: [[0, 0, 10]] }, node('CounterBoreHole', { radius: 3, counter_bore_radius: 6, counter_bore_depth: 3, depth: 12 }))),
  part('countersink', 'CounterSinkHole', node('Box', { length: 24, width: 18, height: 10, align: centeredMin }), node('Locations', { args: [[0, 0, 10]] }, node('CounterSinkHole', { radius: 3, counter_sink_radius: 6, depth: 12, counter_sink_angle: 90 }))),
  part('text-extrude', 'Text · raised lettering', node('BuildSketch', {}, node('Text', { txt: 'CAD', font_size: 12, font: 'DejaVu Sans' })), node('extrude', { amount: 3 })),
  fixture('motor-spacer', 'Motor spacer · four mounting posts', 'assembly', [node('Subtract', { color: '#db9463' }, node('Union', {}, node('Box', { length: 42, width: 42, height: 4, align: centeredMin }), ...[-15.5, 15.5].flatMap(x => [-15.5, 15.5].map(y => node('Cylinder', { radius: 4, height: 10, align: centeredMin, position: [x, y, 0] })))), node('Cylinder', { radius: 15, height: 16, position: [0, 0, 5] }), ...[-15.5, 15.5].flatMap(x => [-15.5, 15.5].map(y => node('Cylinder', { radius: 1.6, height: 16, position: [x, y, 5] }))))]),
  fixture('electronics', 'PCB · connector assembly', 'assembly', [node('Group', {}, node('Subtract', { color: '#347357', name: 'PCB' }, node('Box', { length: 48, width: 32, height: 1.6 }), ...[-20, 20].flatMap(x => [-12, 12].map(y => node('Cylinder', { radius: 1.6, height: 4, position: [x, y, 0] })))), node('Box', { length: 17, width: 10, height: 4, color: '#353c49', name: 'Controller', position: [0, 0, 2.8] }), node('Box', { length: 12, width: 10, height: 7, color: '#9da5af', name: 'USB shell', position: [19, 0, 4.3] }), ...[-1, 1].flatMap(side => Array.from({ length: 8 }, (_, i) => node('Box', { length: 1.4, width: 1.4, height: 8, color: '#dbc37c', name: `Pin ${side}-${i}`, position: [-14 + i * 4, side * 11, 4.8] }))))], 3, { minMeshes: 19 }),
  fixture('transforms', 'Translate / Rotate · assembly', 'assembly', [node('Group', {}, node('Translate', { offset: [-10, 0, 0] }, node('Box', { length: 10, width: 8, height: 8, color: '#ca8470' })), node('Rotate', { angles: [0, 30, 30] }, node('Cylinder', { radius: 4, height: 18, color: '#698daf', position: [8, 0, 0] })))], 3, { minMeshes: 2 }),
  ...advancedVisualFixtures,
]
