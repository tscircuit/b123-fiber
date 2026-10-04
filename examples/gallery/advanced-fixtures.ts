import type { VisualFixture } from './fixtures'
import type { PlanNode, WireValue } from '../../lib/types'

const call = (name: string, args: WireValue[] = [], kwargs: Record<string, WireValue> = {}): WireValue => ({ $call: name, args, kwargs })
const method = (target: WireValue, name: string, args: WireValue[] = [], kwargs: Record<string, WireValue> = {}): WireValue => ({ $method: { target, name, args, kwargs } })
const get = (target: WireValue, name: string): WireValue => ({ $get: { target, name } })
const index = (target: WireValue, i: number): WireValue => ({ $index: { target, index: i } })
const constant = (name: string, path: string): WireValue => ({ $type: name, path })
const node = (type: string, props: Record<string, WireValue>, children: PlanNode[] = []): PlanNode => ({ type, props, children })
const fixture = (id: string, title: string, category: VisualFixture['category'], type: string, props: Record<string, WireValue>, dimension: 1 | 2 | 3, expected: Partial<VisualFixture['expected']> = {}): VisualFixture => ({ id, title, category, plan: { version: 1, children: [node(type, props)] }, expected: { dimension, ...expected } })
const style = call('Draft', [], { font_size: 2, arrow_length: 1, font: 'DejaVu Sans' })
const box = call('Box', [8, 6, 10])
const rectangle = call('Rectangle', [8, 4])
const red = call('Solid', [], { obj: get(call('Box', [8, 6, 4]), 'wrapped'), label: 'Base', color: call('Color', ['red']) })
const blue = method(call('Solid', [], { obj: get(call('Cylinder', [2, 8]), 'wrapped'), label: 'Post', color: call('Color', ['blue']) }), 'moved', [call('Location', [[12, 0, 0]])])

/** Native modeling regressions added after the compatibility audit. */
export const advancedVisualFixtures: VisualFixture[] = [
  fixture('airfoil', 'Airfoil · NACA 2412', 'curve', 'Airfoil', { airfoil_code: '2412', n_points: 25, finite_te: true }, 1),
  fixture('blend-curve', 'BlendCurve · curvature continuity', 'curve', 'BlendCurve', { curve0: call('Line', [[0, 0], [2, 0]]), curve1: call('Line', [[5, 3], [5, 5]]) }, 1),
  fixture('constrained-lines', 'ConstrainedLines · circle tangents', 'curve', 'ConstrainedLines', { args: [call('CenterArc', [[-5, 0], 4, 0, 360]), call('CenterArc', [[5, 0], 3, 0, 360])] }, 1),
  fixture('constrained-arcs', 'ConstrainedArcs · radius constraint', 'curve', 'ConstrainedArcs', { args: [[0, 0], [4, 0]], radius: 3, sagitta: { $enum: 'Sagitta.BOTH' } }, 1),
  fixture('double-tangent', 'DoubleTangentArc', 'curve', 'DoubleTangentArc', { pnt: [0, 0], tangent: [1, 0], other: call('Line', [[5, -5], [5, 5]]) }, 1),
  fixture('technical-drawing', 'TechnicalDrawing · drawing sheet', 'sketch', 'TechnicalDrawing', { designed_by: 'Fixture', design_date: { $date: '2024-01-02' }, title: 'Bracket', nominal_text_size: 4 }, 2),
  fixture('dimension-line', 'DimensionLine · tolerances', 'sketch', 'DimensionLine', { path: [[0, 0], [30, 0]], draft: style, tolerance: [0.1, 0.2] }, 2),
  fixture('extension-line', 'ExtensionLine · outside dimension', 'sketch', 'ExtensionLine', { border: [[0, 0], [30, 0]], offset: [0, 5], draft: style }, 2),
  fixture('draft', 'draft · tapered box', 'operation', 'draft', { faces: method(method(box, 'faces'), 'filter_by', [constant('Axis', 'Z')], { reverse: true }), neutral_plane: method(constant('Plane', 'XY'), 'offset', [-5]), angle: 3 }, 3),
  fixture('full-round', 'full_round · rounded profile end', 'operation', 'full_round', { edge: index(method(method(rectangle, 'edges'), 'sort_by', [constant('Axis', 'X')]), -1), voronoi_point_count: 30 }, 2),
  fixture('brake-formed', 'make_brake_formed · bent sheet', 'operation', 'make_brake_formed', { thickness: 1, station_widths: 5, line: call('Polyline', [[0, 0], [10, 0], [10, 5]]) }, 3, { volume: 35 }),
  fixture('projection', 'project · planar face', 'operation', 'project', { objects: method(method(call('Rectangle', [4, 6]), 'face'), 'moved', [call('Pos', [], { Z: 5 })]), workplane: constant('Plane', 'XY') }, 2),
  fixture('packed-parts', 'pack · spaced parts', 'assembly', 'pack', { objects: [call('Box', [8, 6, 4]), call('Cylinder', [2, 8])], padding: 3 }, 3, { minMeshes: 2, volume: 192 + 32 * Math.PI }),
  fixture('native-assembly', 'Compound · colored native parts', 'assembly', 'Compound', { args: [null, 'Assembly', null, null, null, null, [red, blue]] }, 3, { minMeshes: 2, volume: 192 + 32 * Math.PI }),
  { id: 'compositional-section', title: 'section · nested solid', category: 'operation', plan: { version: 1, children: [node('section', { section_by: constant('Plane', 'XY') }, [node('Box', { length: 8, width: 6, height: 4 })])] }, expected: { dimension: 2 } },
]
