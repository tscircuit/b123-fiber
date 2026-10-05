import type { AnyShape, Drawing, Edge, Face, Plane, Point, Wire } from 'replicad'
import { isKernelShape, shapeValue, type KernelContext, type KernelHandler, type KernelShape } from './types'

type P = [number, number, number]
const rad = Math.PI / 180
const plus = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const minus = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const times = (a: P, s: number): P => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: P) => Math.hypot(...a)
const unit = (a: P): P => { const n = norm(a); if (!n) throw new Error('A direction must be non-zero'); return times(a, 1 / n) }
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
function tuple(value: any): P {
  const p = Array.isArray(value) ? value : value?.toTuple?.() ?? value?.toArray?.() ?? [value?.X ?? value?.x, value?.Y ?? value?.y, value?.Z ?? value?.z ?? 0]
  if (p.length < 2 || p.some((x: any) => typeof x !== 'number' || !Number.isFinite(x))) throw new TypeError('Expected a finite point or vector')
  return [p[0], p[1], p[2] ?? 0]
}
function enumName(value: any): string { return String(value?.$enum ?? value?.name ?? value?.value ?? value?.__enum ?? value ?? '').split('.').at(-1)!.toUpperCase() }
function params(args: any[], kwargs: Record<string, any>, names: string[], defaults: Record<string, any> = {}) {
  const p = { ...defaults, ...kwargs }
  args.forEach((v, i) => { if (!names[i]) throw new TypeError('Too many positional arguments'); if (Object.hasOwn(kwargs, names[i]!)) throw new TypeError(`Duplicate argument ${names[i]}`); p[names[i]!] = v })
  return p
}
function positive(value: any, name: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`); return value }
function pointArgs(args: any[], kwargs: Record<string, any>, name = 'pts'): P[] {
  let points = args.length ? args : kwargs[name] ?? kwargs.points ?? kwargs.cntl_pnts ?? []
  if (points.length === 1 && Array.isArray(points[0]) && typeof points[0][0] !== 'number') points = points[0]
  return points.map(tuple)
}
function plane(ctx: KernelContext): Plane {
  const p = ctx.current()?.plane
  if (p instanceof ctx.replicad.Plane) return p
  if (!p) return ctx.replicad.makePlane('XY')
  if (typeof p === 'string') return ctx.replicad.makePlane(p as any)
  return new ctx.replicad.Plane(tuple(p.origin ?? [0, 0, 0]), tuple(p.x_dir ?? p.xDir ?? [1, 0, 0]), tuple(p.z_dir ?? p.zDir ?? p.normal ?? [0, 0, 1]))
}
function local(ctx: KernelContext, point: P): P {
  const p = plane(ctx)
  return tuple(p.toWorldCoords(point))
}
function sketchShape(ctx: KernelContext, drawing: Drawing, p: Record<string, any>, defaultAlign: any = ['CENTER', 'CENTER'], applyRotation = true): KernelShape {
  const align = p.align === undefined ? defaultAlign : p.align
  if (align != null) {
    const a = Array.isArray(align) ? align : [align, align]
    const [min, max] = drawing.boundingBox.bounds
    const shift = [0, 1].map(i => { const n = enumName(a[i]); return n === 'MIN' ? -min[i]! : n === 'MAX' ? -max[i]! : n === 'CENTER' ? -(min[i]! + max[i]!) / 2 : 0 }) as [number, number]
    drawing = drawing.translate(shift)
  }
  if (applyRotation && p.rotation) drawing = drawing.rotate(Number(p.rotation))
  const sketch = drawing.sketchOnPlane(plane(ctx))
  const raw = sketch instanceof ctx.replicad.Sketches ? sketch.faces() : sketch.face()
  const normal = tuple(plane(ctx).zDir)
  const faces = raw instanceof ctx.replicad.Face ? [raw] : raw.faces
  const corrected = faces.map(face => dot(tuple(face.normalAt()), normal) < 0 ? face.flipOrientation() : face)
  const result = shapeValue(corrected.length === 1 ? corrected[0]! : ctx.replicad.makeCompound(corrected), 'Sketch')
  return Object.assign(result, { plane: ctx.current()?.plane })
}
function curveShape(ctx: KernelContext, shape: Edge | Wire, kind = 'Edge'): KernelShape { return shapeValue(shape, kind) }
function polygonDrawing(ctx: KernelContext, points: P[]): Drawing {
  if (points.length < 3) throw new Error('Polygon requires at least three points')
  if (points.some(p => Math.abs(p[2]) > 1e-9)) throw new Error('Browser sketch polygons currently require points in their local XY plane')
  const d = ctx.replicad.draw([points[0]![0], points[0]![1]])
  for (const p of points.slice(1)) d.lineTo([p[0], p[1]])
  return d.close()
}
function splineEdge(ctx: KernelContext, points: P[], periodic = false, tangents?: P[], scalars?: number[]): Edge {
  const { oc, replicad: r } = ctx
  if (points.length < 2) throw new Error('Spline requires at least two points')
  const storage = new oc.NCollection_Array1_gp_Pnt(1, points.length)
  const temporaries: any[] = [storage]
  try {
    points.forEach((v, i) => { const p = r.asPnt(v); temporaries.push(p); storage.SetValue(i + 1, p) })
    const array = new oc.NCollection_HArray1_gp_Pnt(storage)
    temporaries.push(array)
    const interpolation = new oc.GeomAPI_Interpolate(array, periodic, 1e-6)
    temporaries.push(interpolation)
    if (tangents) {
      if (tangents.length !== 2 && tangents.length !== points.length) throw new Error('Tangents must match the number of points or have two endpoint values')
      if (scalars && scalars.length !== tangents.length) throw new Error('Tangent scalars must match tangent count')
      const vectors = tangents.map((t, i) => { const v = times(unit(t), scalars?.[i] ?? 1); const raw = new oc.gp_Vec(...v); temporaries.push(raw); return raw })
      if (vectors.length === 2) interpolation.Load(vectors[0], vectors[1], scalars == null)
      else {
        const v = new oc.NCollection_Array1_gp_Vec(1, vectors.length)
        const flags = new oc.NCollection_HArray1_bool(1, vectors.length, true)
        temporaries.push(v, flags)
        vectors.forEach((t, i) => v.SetValue(i + 1, t))
        interpolation.Load(v, flags, scalars == null)
      }
    }
    interpolation.Perform()
    if (!interpolation.IsDone()) throw new Error('OpenCascade spline interpolation failed')
    const curve = interpolation.Curve(); temporaries.push(curve)
    const builder = new oc.BRepBuilderAPI_MakeEdge(curve); temporaries.push(builder)
    return new r.Edge(builder.Edge())
  } finally { temporaries.reverse().forEach(p => p.delete()) }
}
function circularArc(ctx: KernelContext, center: P, radius: number, start: number, size: number): Edge {
  positive(radius, 'radius')
  if (!Number.isFinite(size) || Math.abs(size) < 1e-12) throw new Error('arc_size must be non-zero')
  const p = plane(ctx)
  if (Math.abs(size) >= 360) return ctx.replicad.makeCircle(radius, p.toWorldCoords(center), p.zDir)
  const at = (a: number): P => local(ctx, plus(center, [radius * Math.cos(a * rad), radius * Math.sin(a * rad), 0]))
  return ctx.replicad.makeThreePointArc(at(start), at(start + size / 2), at(start + size))
}
function arcMetadata(result: KernelShape, center: P, radius: number): KernelShape { return Object.assign(result, { arcCenter: center, radius }) }
function edge(value: any, ctx: KernelContext): Edge | Wire {
  if (!isKernelShape(value) || !(value.shape instanceof ctx.replicad.Edge || value.shape instanceof ctx.replicad.Wire)) throw new TypeError('Expected an edge or wire')
  return value.shape
}
function derivative(ctx: KernelContext, e: Edge | Wire, u: number, order: 1 | 2): P {
  const c: any = e.curve.wrapped
  const v = new ctx.oc.gp_Vec()
  try { const d = c.DN?.(c.FirstParameter() + u * (c.LastParameter() - c.FirstParameter()), order); if (d) { const result: P = [d.X(), d.Y(), d.Z()]; d.delete(); return result }
    const p = new ctx.oc.gp_Pnt(); const v2 = new ctx.oc.gp_Vec()
    try { if (order === 1) c.D1(c.FirstParameter() + u * (c.LastParameter() - c.FirstParameter()), p, v); else c.D2(c.FirstParameter() + u * (c.LastParameter() - c.FirstParameter()), p, v, v2); const d = order === 1 ? v : v2; return [d.X(), d.Y(), d.Z()] } finally { p.delete(); v2.delete() }
  } finally { v.delete() }
}
function compound(ctx: KernelContext, shapes: AnyShape[], kind = 'Sketch'): KernelShape {
  return shapeValue(ctx.replicad.makeCompound(shapes), kind)
}
function slotDrawing(ctx: KernelContext, separation: number, height: number): Drawing {
  positive(height, 'height'); if (separation < 0) throw new RangeError('center_separation must be non-negative')
  if (!separation) return ctx.replicad.drawCircle(height / 2)
  const x = separation / 2, r = height / 2
  return ctx.replicad.draw([-x, -r]).lineTo([x, -r]).threePointsArcTo([x, r], [x + r, 0]).lineTo([-x, r]).threePointsArcTo([-x, -r], [-x - r, 0]).close()
}
function stroke(ctx: KernelContext, start: P, end: P, width: number): AnyShape {
  const v = minus(end, start), u = unit(v), n = times([-u[1], u[0], 0], positive(width, 'line_width') / 2)
  return ctx.replicad.makePolygon([plus(start, n), plus(end, n), minus(end, n), minus(start, n)].map(p => local(ctx, p)))
}
function booleanFaces(ctx: KernelContext, shapes: AnyShape[]): AnyShape {
  if (!shapes.length) throw new Error('Cannot create an empty drawing')
  return shapes.slice(1).reduce((shape, other) => {
    const b = new ctx.oc.BRepAlgoAPI_Fuse(shape.wrapped, other.wrapped)
    try { if (!b.IsDone()) throw new Error('OpenCascade could not join drafting faces'); return ctx.replicad.cast(b.Shape()) } finally { b.delete() }
  }, shapes[0]!)
}
function arrowHead(ctx: KernelContext, size: number, type: any): AnyShape {
  positive(size, 'size')
  const r = ctx.replicad, t = enumName(type ?? 'CURVED')
  if (t === 'STRAIGHT') return r.makePolygon([[0, 0, 0], [-size, size / 3, 0], [-size, -size / 3, 0]])
  if (t !== 'CURVED') throw new Error('Filleted arrow heads are not yet supported by the browser kernel')
  const upper = r.makeTangentArc([0, 0, 0], [-size, size / 6, 0], [-size, size / 3, 0])
  const inside: P = [-7 * size / 8, 0, 0]
  const upperLine = r.makeLine(upper.endPoint, inside), lowerLine = r.makeLine(inside, [-size, -size / 3, 0])
  const lower = upper.clone().mirror('XZ')
  const reversed = r.cast(lower.wrapped.Reversed()) as Edge
  return r.makeFace(r.assembleWire([upper, upperLine, lowerLine, reversed]))
}
function draftLabel(draft: any, length: number, tolerance: any): string {
  const metric = ['MM', 'CM', 'M', 'MC'].includes(enumName(draft.unit ?? 'MM')), display = draft.display_units ?? true
  const number = (v: number, units: boolean): string => {
    const raw = v / (metric ? 1 : 25.4)
    let result = raw.toFixed(draft.decimal_precision ?? 2)
    if (!metric && enumName(draft.number_display) === 'FRACTION') {
      const whole = Math.floor(raw), denominator = draft.fractional_precision ?? 64
      let numerator = Math.round((raw - whole) * denominator), divisor = denominator
      const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
      const divisorGcd = gcd(numerator, denominator); numerator /= divisorGcd; divisor /= divisorGcd
      result = `${whole ? `${whole} ` : ''}${numerator}/${divisor}`
    }
    return result + (units && display ? metric ? 'mm' : '"' : '')
  }
  if (tolerance == null) return number(length, true)
  return number(length, false) + (Array.isArray(tolerance) ? ` +${number(tolerance[0], false)} -${number(tolerance[1], true)}` : ` ±${number(tolerance, true)}`)
}
function fontFaces(ctx: KernelContext, commands: any[], transform: (p: P) => P): AnyShape[] {
  const contours: { wire: Wire; points: P[]; depth: number }[] = []
  let edges: Edge[] = [], current: P | undefined, first: P | undefined
  const finish = () => {
    if (!edges.length) return
    if (current && first && norm(minus(current, first)) > 1e-9) edges.push(ctx.replicad.makeLine(transform(current), transform(first)))
    const points = edges.flatMap(e => Array.from({ length: 16 }, (_, i) => tuple(e.pointAt(i / 16))))
    contours.push({ wire: ctx.replicad.assembleWire(edges), points, depth: 0 }); edges = []
  }
  for (const c of commands) {
    if (c.type === 'Z') { finish(); current = undefined; first = undefined; continue }
    const point: P = [c.x, -c.y, 0]
    if (c.type === 'M') { finish(); current = point; first = point; continue }
    if (!current) throw new Error('Font contour is missing its starting point')
    if (norm(minus(current, point)) < 1e-9 && c.type === 'L') continue
    if (c.type === 'L') edges.push(ctx.replicad.makeLine(transform(current), transform(point)))
    else if (c.type === 'Q') edges.push(ctx.replicad.makeBezierCurve([current, [c.x1, -c.y1, 0] as P, point].map(transform)))
    else if (c.type === 'C') edges.push(ctx.replicad.makeBezierCurve([current, [c.x1, -c.y1, 0] as P, [c.x2, -c.y2, 0] as P, point].map(transform)))
    else throw new Error(`Unsupported font outline command ${c.type}`)
    current = point
  }
  finish()
  const workplane = plane(ctx)
  const projected = contours.map(c => c.points.map(p => tuple(workplane.toLocalCoords(new ctx.replicad.Vector(p)))))
  const inside = (p: P, polygon: P[]) => {
    let yes = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes }
    return yes
  }
  contours.forEach((c, i) => { c.depth = contours.filter((_, j) => i !== j && inside(projected[i]![0]!, projected[j]!)).length })
  return contours.flatMap((c, i) => {
    if (c.depth % 2) return []
    const holes = contours.filter((h, j) => h.depth === c.depth + 1 && inside(projected[j]![0]!, projected[i]!)).map(h => h.wire)
    const face = ctx.replicad.makeFace(c.wire, holes)
    const fix = new ctx.oc.ShapeFix_Face(face.wrapped)
    try { fix.FixOrientation(); const corrected = new ctx.replicad.Face(fix.Face()); return [dot(tuple(corrected.normalAt()), tuple(workplane.zDir)) < 0 ? corrected.flipOrientation() : corrected] } finally { fix.delete() }
  })
}

/** Build123d sketches and curves backed by OpenCascade BReps. */
export function registerSketches(ctx: KernelContext): Record<string, KernelHandler> {
  const r = ctx.replicad
  const handlers: Record<string, KernelHandler> = {
    Circle(args, kwargs) {
      const p = params(args, kwargs, ['radius', 'arc_size', 'align', 'mode'], { arc_size: 360 })
      positive(p.radius, 'radius')
      if (p.arc_size === 360) return sketchShape(ctx, r.drawCircle(p.radius), p)
      const s = p.arc_size * rad
      const d = r.draw([0, 0]).lineTo([p.radius, 0]).threePointsArcTo([p.radius * Math.cos(s), p.radius * Math.sin(s)], [p.radius * Math.cos(s / 2), p.radius * Math.sin(s / 2)]).close()
      return sketchShape(ctx, d, p)
    },
    Ellipse(args, kwargs) { const p = params(args, kwargs, ['x_radius', 'y_radius', 'rotation', 'align', 'mode']); return sketchShape(ctx, r.drawEllipse(positive(p.x_radius, 'x_radius'), positive(p.y_radius, 'y_radius')), p) },
    Rectangle(args, kwargs) { const p = params(args, kwargs, ['width', 'height', 'rotation', 'align', 'mode']); return sketchShape(ctx, r.drawRectangle(positive(p.width, 'width'), positive(p.height, 'height')), p) },
    RectangleRounded(args, kwargs) { const p = params(args, kwargs, ['width', 'height', 'radius', 'rotation', 'align', 'mode']); positive(p.radius, 'radius'); if (p.width <= 2 * p.radius || p.height <= 2 * p.radius) throw new Error('width and height must be greater than 2*radius'); return sketchShape(ctx, r.drawRoundedRectangle(p.width, p.height, p.radius), p) },
    Polygon(args, kwargs) { return sketchShape(ctx, polygonDrawing(ctx, pointArgs(args, kwargs)), kwargs, ['NONE', 'NONE']) },
    RegularPolygon(args, kwargs) {
      const p = params(args, kwargs, ['radius', 'side_count', 'major_radius', 'rotation', 'align', 'mode'], { major_radius: true })
      positive(p.radius, 'radius'); if (!Number.isInteger(p.side_count) || p.side_count < 3) throw new Error('side_count must be an integer of at least three')
      const radius = p.major_radius ? p.radius : p.radius / Math.cos(Math.PI / p.side_count)
      const pts: P[] = Array.from({ length: p.side_count }, (_, i) => { const a = i * 2 * Math.PI / p.side_count + (p.rotation ?? 0) * rad; return [radius * Math.cos(a), radius * Math.sin(a), 0] })
      // Native regular polygons align around their construction origin rather than the asymmetric bbox center.
      const q: Record<string, any> = { ...p, rotation: 0 }; const a = q.align ?? ['CENTER', 'CENTER']; const align = Array.isArray(a) ? a : [a, a]
      return sketchShape(ctx, polygonDrawing(ctx, pts), { ...q, align: align.map((x: any) => enumName(x) === 'CENTER' ? 'NONE' : x) }, ['NONE', 'NONE'])
    },
    Trapezoid(args, kwargs) {
      const p = params(args, kwargs, ['width', 'height', 'left_side_angle', 'right_side_angle', 'rotation', 'align', 'mode'])
      positive(p.width, 'width'); positive(p.height, 'height')
      const left = p.height / Math.tan(p.left_side_angle * rad), right = p.height / Math.tan((p.right_side_angle ?? p.left_side_angle) * rad)
      const bl = p.width / 2 + Math.min(left, 0), br = p.width / 2 + Math.min(right, 0), tl = p.width / 2 - Math.max(left, 0), tr = p.width / 2 - Math.max(right, 0)
      if (bl + br < 0 || tl + tr < 0) throw new Error('Trapezoid angles produce an invalid top or bottom')
      return sketchShape(ctx, polygonDrawing(ctx, [[-bl, -p.height / 2, 0], [br, -p.height / 2, 0], [tr, p.height / 2, 0], [-tl, p.height / 2, 0]]), p)
    },
    SlotCenterToCenter(args, kwargs) { const p = params(args, kwargs, ['center_separation', 'height', 'rotation', 'mode']); return sketchShape(ctx, slotDrawing(ctx, p.center_separation, p.height), p, null) },
    SlotOverall(args, kwargs) { const p = params(args, kwargs, ['width', 'height', 'rotation', 'align', 'mode']); if (p.width < p.height) throw new Error('Slot width must be at least its height'); return sketchShape(ctx, slotDrawing(ctx, p.width - p.height, p.height), p) },
    SlotCenterPoint(args, kwargs) {
      const p = params(args, kwargs, ['center', 'point', 'height', 'rotation', 'mode']); const center = tuple(p.center), end = tuple(p.point), delta = minus(end, center)
      if (!norm(delta)) throw new Error('center and point must be different')
      const drawing = slotDrawing(ctx, norm(delta) * 2, p.height).rotate(Math.atan2(delta[1], delta[0]) / rad).translate([center[0], center[1]])
      return sketchShape(ctx, drawing, p, null)
    },
    SlotArc(args, kwargs) {
      const p = params(args, kwargs, ['arc', 'height', 'rotation', 'mode']), path = edge(p.arc, ctx)
      let wire = path instanceof r.Wire ? path.clone() : r.assembleWire([path.clone()])
      // OCCT's planar offset requires splitting a one-edge spine, as in build123d.
      const edges = wire.edges
      if (edges.length === 1) {
        const curve = ctx.oc.BRep_Tool.Curve(edges[0]!.wrapped), middle = (curve.First + curve.Last) / 2
        const first = new ctx.oc.BRepBuilderAPI_MakeEdge(curve.returnValue, curve.First, middle), second = new ctx.oc.BRepBuilderAPI_MakeEdge(curve.returnValue, middle, curve.Last)
        wire = r.assembleWire([new r.Edge(first.Edge()), new r.Edge(second.Edge())]); first.delete(); second.delete(); curve.returnValue.delete()
      }
      const builder = new ctx.oc.BRepOffsetAPI_MakeOffset(wire.wrapped, ctx.oc.GeomAbs_JoinType.GeomAbs_Arc, false)
      try {
        builder.Perform(positive(p.height, 'height') / 2, 0)
        if (!builder.IsDone()) throw new Error('OpenCascade could not offset the slot centerline')
        const result = r.cast(builder.Shape())
        const wires = result instanceof r.Wire ? [result] : Array.from(r.iterTopo(result.wrapped, 'wire'), (v: any) => new r.Wire(v))
        if (wires.length !== 1) throw new Error('A closed SlotArc centerline requires annular offset support')
        let face: AnyShape = r.makeFace(wires[0]!); if (p.rotation) face = face.rotate(p.rotation)
        return shapeValue(face, 'Sketch')
      } finally { builder.delete() }
    },
    Superellipse(args, kwargs) {
      const p = params(args, kwargs, ['width', 'height', 'order', 'point_count', 'rotation', 'align', 'mode'], { order: 4, point_count: 16 })
      positive(p.width, 'width'); positive(p.height, 'height'); positive(p.order, 'order')
      if (p.order === 1) return sketchShape(ctx, polygonDrawing(ctx, [[p.width / 2, 0, 0], [0, p.height / 2, 0], [-p.width / 2, 0, 0], [0, -p.height / 2, 0]]), p)
      if (p.order === 2) return sketchShape(ctx, r.drawEllipse(p.width / 2, p.height / 2), p)
      if (!Number.isInteger(p.point_count) || p.point_count < 3) throw new Error('point_count must be at least three')
      const points: P[] = [[p.width / 2, 0, 0]]
      for (let i = 1; i < p.point_count - 1; i++) { const a = i * Math.PI / p.point_count / 2; points.push([Math.cos(a) ** (2 / p.order) * p.width / 2, Math.sin(a) ** (2 / p.order) * p.height / 2, 0]) }
      points.push([0, p.height / 2, 0])
      const quadrant = splineEdge(ctx, points), q1 = quadrant.clone(), q2 = r.cast(quadrant.clone().mirror('YZ').wrapped.Reversed()) as Edge, q3 = quadrant.clone().rotate(180), q4 = r.cast(quadrant.clone().mirror('XZ').wrapped.Reversed()) as Edge
      let face: AnyShape = r.makeFace(r.assembleWire([q1, q2, q3, q4]))
      const a = p.align ?? ['CENTER', 'CENTER'], align = Array.isArray(a) ? a : [a, a], [min, max] = face.boundingBox.bounds
      const shift: P = [0, 1].map(i => enumName(align[i]) === 'MIN' ? -min[i]! : enumName(align[i]) === 'MAX' ? -max[i]! : enumName(align[i]) === 'CENTER' ? -(min[i]! + max[i]!) / 2 : 0).concat(0) as P
      face = face.translate(shift); if (p.rotation) face = face.rotate(p.rotation)
      const wp = plane(ctx), tr = new r.Transformation().coordSystemChange(new r.Plane([0, 0, 0]), wp)
      return Object.assign(shapeValue(r.cast(tr.transform(face.wrapped)), 'Sketch'), { plane: ctx.current()?.plane })
    },
    Triangle(args, kwargs) {
      if (args.length) throw new Error('Triangle uses named side and angle arguments')
      const sides = [kwargs.a, kwargs.b, kwargs.c] as (number | undefined)[], angles = [kwargs.A, kwargs.B, kwargs.C].map(a => a == null ? undefined : a * rad) as (number | undefined)[]
      if ([...sides, ...angles].filter(v => v != null).length !== 3 || sides.every(v => v == null)) throw new Error('Triangle requires one side and two other side/angle values')
      if (sides.every(v => v != null)) angles.forEach((_, i) => angles[i] = Math.acos((sides[(i + 1) % 3]! ** 2 + sides[(i + 2) % 3]! ** 2 - sides[i]! ** 2) / (2 * sides[(i + 1) % 3]! * sides[(i + 2) % 3]!)))
      else if (angles.filter(v => v != null).length === 2) { const missing = angles.findIndex(v => v == null); angles[missing] = Math.PI - angles.reduce((sum: number, v) => sum + (v ?? 0), 0); const i = sides.findIndex(v => v != null), scale = sides[i]! / Math.sin(angles[i]!); sides.forEach((_, j) => sides[j] = scale * Math.sin(angles[j]!)) }
      else {
        const angleIndex = angles.findIndex(v => v != null), missingSide = sides.findIndex(v => v == null)
        if (angleIndex === missingSide) sides[missingSide] = Math.sqrt(sides[(missingSide + 1) % 3]! ** 2 + sides[(missingSide + 2) % 3]! ** 2 - 2 * sides[(missingSide + 1) % 3]! * sides[(missingSide + 2) % 3]! * Math.cos(angles[angleIndex]!))
        else { const knownSide = sides.findIndex((v, i) => v != null && i !== angleIndex); angles[knownSide] = Math.asin(sides[knownSide]! * Math.sin(angles[angleIndex]!) / sides[angleIndex]!); angles[missingSide] = Math.PI - angles[angleIndex]! - angles[knownSide]!; sides[missingSide] = sides[angleIndex]! * Math.sin(angles[missingSide]!) / Math.sin(angles[angleIndex]!) }
        angles.forEach((v, i) => { if (v == null) angles[i] = Math.acos((sides[(i + 1) % 3]! ** 2 + sides[(i + 2) % 3]! ** 2 - sides[i]! ** 2) / (2 * sides[(i + 1) % 3]! * sides[(i + 2) % 3]!)) })
      }
      if ([...sides, ...angles].some(v => v == null || !Number.isFinite(v) || v <= 0)) throw new Error('Triangle inputs do not define a valid triangle')
      const points: P[] = [[0, 0, 0], [sides[0]!, 0, 0], [sides[2]! * Math.cos(angles[1]!), sides[2]! * Math.sin(angles[1]!), 0]], center = times(points.reduce(plus, [0, 0, 0] as P), 1 / 3)
      return Object.assign(sketchShape(ctx, polygonDrawing(ctx, points.map(p => minus(p, center))), kwargs, null), { a: sides[0], b: sides[1], c: sides[2], A: angles[0]! / rad, B: angles[1]! / rad, C: angles[2]! / rad })
    },
    Line(args, kwargs) { const p = params(args, kwargs, ['start_point', 'end_point', 'mode']); return curveShape(ctx, r.makeLine(local(ctx, tuple(p.start_point)), local(ctx, tuple(p.end_point)))) },
    IntersectingLine(args, kwargs) {
      const p = params(args, kwargs, ['start', 'direction', 'other', 'mode'])
      const start = local(ctx, tuple(p.start)), wp = plane(ctx), direction = unit(tuple(p.direction))
      const u = unit(plus(plus(times(tuple(wp.xDir), direction[0]), times(tuple(wp.yDir), direction[1])), times(tuple(wp.zDir), direction[2])))
      if (!isKernelShape(p.other) || p.other.shape.faces.length || p.other.shape.solids.length) throw new TypeError('IntersectingLine requires an edge, wire or curve; surface intersections are not supported')
      const targets = p.other.shape instanceof r.Edge ? [p.other.shape] : p.other.shape.edges
      if (!targets.length || targets.some(e => e.geomType !== 'LINE')) throw new Error('Browser IntersectingLine currently supports straight-edge targets; curved intersections are unavailable')
      const distances: number[] = []
      for (const target of targets) {
        const a = tuple(target.startPoint), b = tuple(target.endPoint), v = minus(b, a), w = minus(a, start), n = cross(u, v), denominator = dot(n, n)
        if (denominator < 1e-20 * dot(v, v)) continue
        const t = dot(cross(w, v), n) / denominator, s = dot(cross(w, u), n) / denominator
        const axisPoint = plus(start, times(u, t)), targetPoint = plus(a, times(v, s))
        if (norm(minus(axisPoint, targetPoint)) > 1e-6) throw new Error('IntersectingLine targets must lie in the same plane as its start and direction')
        if (s >= -1e-6 / norm(v) && s <= 1 + 1e-6 / norm(v)) distances.push(Math.abs(t))
      }
      if (!distances.length) throw new Error('No intersections found')
      const length = Math.min(...distances)
      if (length < 1e-9) throw new Error('Intersection coincides with the start; cannot create a zero-length line')
      // build123d measures the nearest extended-axis crossing and creates the
      // resulting edge in the supplied positive direction, including crossings behind start.
      return curveShape(ctx, r.makeLine(start, plus(start, times(u, length))))
    },
    Polyline(args, kwargs) {
      const pts = pointArgs(args, kwargs).map(p => local(ctx, p)); if (pts.length < 2) throw new Error('Polyline needs at least two points')
      if (kwargs.close && norm(minus(pts[0]!, pts.at(-1)!)) > 1e-9) pts.push(pts[0]!)
      return curveShape(ctx, r.assembleWire(pts.slice(1).map((p, i) => r.makeLine(pts[i]!, p))), 'Wire')
    },
    Spline(args, kwargs) { return curveShape(ctx, splineEdge(ctx, pointArgs(args, kwargs).map(p => local(ctx, p)), kwargs.periodic ?? false, kwargs.tangents?.map((p: any) => tuple(p)), kwargs.tangent_scalars)) },
    Bezier(args, kwargs) {
      const points = pointArgs(args, kwargs).map(p => local(ctx, p))
      if (!kwargs.weights) return curveShape(ctx, r.makeBezierCurve(points))
      if (kwargs.weights.length !== points.length) throw new Error('Bezier weights must match control points')
      const poles = new ctx.oc.NCollection_Array1_gp_Pnt(1, points.length), weights = new ctx.oc.NCollection_Array1_double(1, points.length)
      points.forEach((p, i) => { const v = r.asPnt(p); poles.SetValue(i + 1, v); v.delete(); weights.SetValue(i + 1, positive(kwargs.weights[i], 'weight')) })
      const c = new ctx.oc.Geom_BezierCurve(poles, weights), b = new ctx.oc.BRepBuilderAPI_MakeEdge(c)
      const result = curveShape(ctx, new r.Edge(b.Edge())); b.delete(); c.delete(); weights.delete(); poles.delete(); return result
    },
    BSpline(args, kwargs) {
      const p = params(args, kwargs, ['control_points', 'knots', 'degree', 'weights', 'periodic', 'mode'], { periodic: false })
      const points = p.control_points.map((v: any) => local(ctx, tuple(v))) as P[], knotValues: number[] = [], multiplicities: number[] = []
      for (const knot of p.knots) { if (typeof knot !== 'number' || !Number.isFinite(knot)) throw new Error('BSpline knots must be finite numbers'); if (knot === knotValues.at(-1)) multiplicities[multiplicities.length - 1]!++; else { if (knotValues.length && knot < knotValues.at(-1)!) throw new Error('BSpline knots must be nondecreasing'); knotValues.push(knot); multiplicities.push(1) } }
      const poles = new ctx.oc.NCollection_Array1_gp_Pnt(1, points.length), knots = new ctx.oc.NCollection_Array1_double(1, knotValues.length), mults = new ctx.oc.NCollection_Array1_int(1, knotValues.length)
      const temporaries: any[] = [poles, knots, mults]
      try {
        points.forEach((point, i) => { const v = r.asPnt(point); temporaries.push(v); poles.SetValue(i + 1, v) })
        knotValues.forEach((v, i) => { knots.SetValue(i + 1, v); mults.SetValue(i + 1, multiplicities[i]) })
        let curve: any
        if (p.weights) { if (p.weights.length !== points.length) throw new Error('BSpline weights must match control points'); const weights = new ctx.oc.NCollection_Array1_double(1, points.length); temporaries.push(weights); p.weights.forEach((v: number, i: number) => weights.SetValue(i + 1, positive(v, 'weight'))); curve = new ctx.oc.Geom_BSplineCurve(poles, weights, knots, mults, p.degree, p.periodic) }
        else curve = new ctx.oc.Geom_BSplineCurve(poles, knots, mults, p.degree, p.periodic)
        temporaries.push(curve); const builder = new ctx.oc.BRepBuilderAPI_MakeEdge(curve); temporaries.push(builder); return curveShape(ctx, new r.Edge(builder.Edge()))
      } finally { temporaries.reverse().forEach(v => v.delete()) }
    },
    EllipticalCenterArc(args, kwargs) {
      const p = params(args, kwargs, ['center', 'x_radius', 'y_radius', 'start_angle'], { start_angle: 0, arc_size: 90, rotation: 0 })
      if (typeof p.arc_size !== 'number') throw new Error('Geometric ellipse arc limits are not yet supported by the browser kernel')
      const wp = plane(ctx), center = local(ctx, tuple(p.center)), x = tuple(wp.xDir), y = tuple(wp.yDir), rotation = p.rotation * rad
      const xDir = plus(times(x, Math.cos(rotation)), times(y, Math.sin(rotation)))
      let a = p.start_angle * rad, b = (p.start_angle + p.arc_size) * rad, normal = tuple(wp.zDir)
      let major = positive(p.x_radius, 'x_radius'), minor = positive(p.y_radius, 'y_radius'), direction = xDir
      if (minor > major) { [major, minor] = [minor, major]; direction = cross(normal, direction); a -= Math.PI / 2; b -= Math.PI / 2 }
      let shape = r.makeEllipseArc(major, minor, Math.min(a, b), Math.max(a, b), center, normal, direction)
      if (p.arc_size < 0) shape = r.cast(shape.wrapped.Reversed()) as Edge
      return curveShape(ctx, shape)
    },
    EllipticalStartArc(args, kwargs) {
      const p = params(args, kwargs, ['start_pnt', 'start_tangent', 'x_radius', 'y_radius', 'arc_size'])
      const start = tuple(p.start_pnt), tangent = unit(tuple(p.start_tangent)), normal: P = [0, 0, 1]
      let angle: number, x: P
      if (p.start_angle != null) {
        angle = p.start_angle * rad
        const a = -p.x_radius * Math.sin(angle), b = p.y_radius * Math.cos(angle)
        x = unit(minus(times(tangent, a), times(cross(normal, tangent), b)))
      } else if (p.major_axis_dir != null) {
        x = unit(tuple(p.major_axis_dir)); const y = cross(normal, x)
        angle = Math.atan2(-dot(tangent, x) / p.x_radius, dot(tangent, y) / p.y_radius)
      } else throw new Error('EllipticalStartArc requires start_angle or major_axis_dir')
      const y = cross(normal, x), center = minus(minus(start, times(x, p.x_radius * Math.cos(angle))), times(y, p.y_radius * Math.sin(angle)))
      return handlers.EllipticalCenterArc!([], { center, x_radius: p.x_radius, y_radius: p.y_radius, start_angle: angle / rad, arc_size: p.arc_size, rotation: Math.atan2(x[1], x[0]) / rad }, ctx)
    },
    ParabolicCenterArc(args, kwargs) {
      const p = params(args, kwargs, ['vertex', 'focal_length', 'start_angle'], { start_angle: 0, arc_size: 90, rotation: 0 })
      if (typeof p.arc_size !== 'number') throw new Error('Geometric parabola arc limits are not yet supported by the browser kernel')
      const f = positive(p.focal_length, 'focal_length'), start = p.start_angle * rad, end = (p.start_angle + p.arc_size) * rad, delta = end - start
      const points: P[] = [[start * start / (4 * f), start, 0], [(start * start + start * delta) / (4 * f), start + delta / 2, 0], [end * end / (4 * f), end, 0]]
      const origin = tuple(p.vertex), rotation = p.rotation * rad
      return curveShape(ctx, r.makeBezierCurve(points.map(point => local(ctx, plus(origin, [point[0] * Math.cos(rotation) - point[1] * Math.sin(rotation), point[0] * Math.sin(rotation) + point[1] * Math.cos(rotation), 0])))))
    },
    HyperbolicCenterArc(args, kwargs) {
      const p = params(args, kwargs, ['center', 'x_radius', 'y_radius', 'start_angle'], { start_angle: 0, arc_size: 90, rotation: 0 })
      if (typeof p.arc_size !== 'number') throw new Error('Geometric hyperbola arc limits are not yet supported by the browser kernel')
      let a = positive(p.x_radius, 'x_radius'), b = positive(p.y_radius, 'y_radius'), start = p.start_angle * rad, end = (p.start_angle + p.arc_size) * rad, rotation = p.rotation * rad
      if (b > a) { [a, b] = [b, a]; rotation += Math.PI / 2; start -= Math.PI / 2; end -= Math.PI / 2 }
      const middle = (start + end) / 2, weight = Math.cosh((end - start) / 2), points: P[] = [[a * Math.cosh(start), b * Math.sinh(start), 0], [a * Math.cosh(middle) / weight, b * Math.sinh(middle) / weight, 0], [a * Math.cosh(end), b * Math.sinh(end), 0]], center = tuple(p.center)
      if (points.some(p => p.some(v => !Number.isFinite(v)))) throw new Error('Hyperbola parameters overflow finite coordinates')
      return handlers.Bezier!(points.map(point => plus(center, [point[0] * Math.cos(rotation) - point[1] * Math.sin(rotation), point[0] * Math.sin(rotation) + point[1] * Math.cos(rotation), 0])), { weights: [1, weight, 1] }, ctx)
    },
    JernArc(args, kwargs) {
      const p = params(args, kwargs, ['start', 'tangent', 'radius', 'arc_size', 'mode'])
      if (typeof p.arc_size !== 'number') throw new Error('Geometric JernArc limits are not yet supported by the browser kernel')
      const start = tuple(p.start), tangent = unit(tuple(p.tangent)), size = p.arc_size, n = times([-tangent[1], tangent[0], 0], Math.sign(size)), center = plus(start, times(n, Math.abs(p.radius)))
      return arcMetadata(curveShape(ctx, circularArc(ctx, center, Math.abs(p.radius), Math.atan2(start[1] - center[1], start[0] - center[0]) / rad, size)), local(ctx, center), Math.abs(p.radius))
    },
    FilletPolyline(args, kwargs) {
      let pts = pointArgs(args, kwargs); if (pts.length < 2) throw new Error('FilletPolyline requires at least two points')
      let close = kwargs.close ?? false
      if (norm(minus(pts[0]!, pts.at(-1)!)) < 1e-6) { close = true; pts = pts.slice(0, -1) }
      const count = pts.length, cornerCount = count - (close ? 0 : 2), radii = Array.isArray(kwargs.radius) ? kwargs.radius : Array(cornerCount).fill(kwargs.radius)
      if (radii.length !== cornerCount || radii.some((v: any) => typeof v !== 'number' || v < 0)) throw new Error('FilletPolyline radii must be nonnegative and match the corner count')
      const incoming = pts.slice(), outgoing = pts.slice(), arcs: (Edge | null)[] = Array(count).fill(null)
      for (let i = close ? 0 : 1; i < (close ? count : count - 1); i++) {
        const radius = radii[i - (close ? 0 : 1)]
        if (!radius) continue
        const vertex = pts[i]!, prev = pts[(i + count - 1) % count]!, next = pts[(i + 1) % count]!, a = unit(minus(prev, vertex)), b = unit(minus(next, vertex)), angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
        const distance = radius / Math.tan(angle / 2)
        if (!Number.isFinite(distance) || distance > norm(minus(prev, vertex)) || distance > norm(minus(next, vertex))) throw new Error('Fillet radius does not fit the adjacent segments')
        incoming[i] = plus(vertex, times(a, distance)); outgoing[i] = plus(vertex, times(b, distance))
        const center = plus(vertex, times(unit(plus(a, b)), radius / Math.sin(angle / 2))), mid = plus(center, times(unit(minus(vertex, center)), radius))
        arcs[i] = r.makeThreePointArc(local(ctx, incoming[i]!), local(ctx, mid), local(ctx, outgoing[i]!))
      }
      const edges: Edge[] = []
      for (let i = 0; i < (close ? count : count - 1); i++) { const next = (i + 1) % count; if (dot(minus(incoming[next]!, outgoing[i]!), minus(pts[next]!, pts[i]!)) < -1e-6) throw new Error('Adjacent fillets overlap'); if (norm(minus(incoming[next]!, outgoing[i]!)) > 1e-9) edges.push(r.makeLine(local(ctx, outgoing[i]!), local(ctx, incoming[next]!))); if (arcs[next]) edges.push(arcs[next]!) }
      return curveShape(ctx, r.assembleWire(edges), 'Wire')
    },
    CenterArc(args, kwargs) { const p = params(args, kwargs, ['center', 'radius', 'start_angle', 'arc_size', 'mode']); if (typeof p.arc_size !== 'number') throw new Error('CenterArc geometric arc limits are not yet supported by the browser kernel'); return arcMetadata(curveShape(ctx, circularArc(ctx, tuple(p.center), p.radius, p.start_angle, p.arc_size)), local(ctx, tuple(p.center)), p.radius) },
    ThreePointArc(args, kwargs) { const p = pointArgs(args, kwargs); if (p.length !== 3) throw new Error('ThreePointArc requires three points'); return curveShape(ctx, r.makeThreePointArc(local(ctx, p[0]!), local(ctx, p[1]!), local(ctx, p[2]!))) },
    SagittaArc(args, kwargs) {
      const p = params(args, kwargs, ['start_point', 'end_point', 'sagitta', 'mode']); const a = tuple(p.start_point), b = tuple(p.end_point), d = unit(minus(b, a)), mid = times(plus(a, b), 0.5)
      if (!p.sagitta) throw new Error('sagitta must be non-zero')
      return curveShape(ctx, r.makeThreePointArc(local(ctx, a), local(ctx, plus(mid, [-d[1] * p.sagitta, d[0] * p.sagitta, 0])), local(ctx, b)))
    },
    RadiusArc(args, kwargs) {
      const p = params(args, kwargs, ['start_point', 'end_point', 'radius', 'short_sagitta', 'mode'], { short_sagitta: true }); const half = norm(minus(tuple(p.end_point), tuple(p.start_point))) / 2
      if (Math.abs(p.radius) < half) throw new Error('Arc radius is not large enough to reach the end point')
      const sagitta = (p.short_sagitta ? Math.abs(p.radius) - Math.sqrt(p.radius ** 2 - half ** 2) : -Math.abs(p.radius) - Math.sqrt(p.radius ** 2 - half ** 2)) * Math.sign(p.radius)
      return handlers.SagittaArc!([], { ...p, sagitta }, ctx)
    },
    PolarLine(args, kwargs) {
      const p = params(args, kwargs, ['start', 'length', 'angle', 'direction', 'length_mode', 'mode']); const start = tuple(p.start)
      if (p.angle == null && p.direction == null) throw new Error('PolarLine requires an angle or direction')
      let direction = p.direction ? unit(tuple(p.direction)) : [Math.cos(p.angle * rad), Math.sin(p.angle * rad), 0] as P
      const lengthMode = enumName(p.length_mode ?? 'DIAGONAL')
      const divisor = lengthMode === 'HORIZONTAL' ? Math.abs(direction[0]) : lengthMode === 'VERTICAL' ? Math.abs(direction[1]) : 1
      if (!divisor) throw new Error('PolarLine length mode is perpendicular to its direction')
      direction = times(direction, p.length / divisor)
      return curveShape(ctx, r.makeLine(local(ctx, start), local(ctx, plus(start, direction))))
    },
    Helix(args, kwargs) {
      const p = params(args, kwargs, ['pitch', 'height', 'radius', 'center', 'direction', 'cone_angle', 'lefthand', 'mode'], { center: [0, 0, 0], direction: [0, 0, 1], cone_angle: 0, lefthand: false })
      if (p.cone_angle) throw new Error('Conical helices are not yet supported by the browser kernel')
      return curveShape(ctx, r.makeHelix(positive(p.pitch, 'pitch'), positive(p.height, 'height'), positive(p.radius, 'radius'), tuple(p.center), tuple(p.direction), p.lefthand), 'Wire')
    },
    TangentArc(args, kwargs) {
      const points = pointArgs(args, kwargs); if (points.length !== 2) throw new Error('TangentArc requires two points')
      const fromFirst = kwargs.tangent_from_first ?? true
      return curveShape(ctx, r.makeTangentArc(local(ctx, points[fromFirst ? 0 : 1]!), tuple(kwargs.tangent), local(ctx, points[fromFirst ? 1 : 0]!)))
    },
    Airfoil(args, kwargs) {
      const p = params(args, kwargs, ['airfoil_code', 'n_points', 'finite_te', 'mode'], { n_points: 50, finite_te: false }); const code = String(p.airfoil_code).replace('NACA', '').trim()
      if (!/^\d{4}(\.\d+)?$/.test(code)) throw new Error('Airfoil requires a NACA four-digit code')
      if (!Number.isInteger(p.n_points) || p.n_points < 3) throw new Error('n_points must be at least three')
      const m = Number(code[0]) / 100, c = Number(code[1]) / 10, t = Number(code.slice(2)) / 100
      const upper: P[] = [], lower: P[] = [], camber: P[] = []
      for (let i = 0; i < p.n_points; i++) {
        const x = (1 - Math.cos(i * Math.PI / (p.n_points - 1))) / 2
        const yt = 5 * t * (.2969 * Math.sqrt(x) - .1260 * x - .3516 * x ** 2 + .2843 * x ** 3 + (p.finite_te ? -.1015 : -.1036) * x ** 4)
        const k = x < c ? c : 1 - c
        const yc = !m || !c || c === 1 ? 0 : m / k ** 2 * (x < c ? 2 * c * x - x ** 2 : 1 - 2 * c + 2 * c * x - x ** 2)
        const slope = !m || !c || c === 1 ? 0 : 2 * m / k ** 2 * (c - x), theta = Math.atan(slope)
        upper.push([x - yt * Math.sin(theta), yc + yt * Math.cos(theta), 0]); lower.push([x + yt * Math.sin(theta), yc - yt * Math.cos(theta), 0]); camber.push([x, yc, 0])
      }
      const unique = [...upper.reverse(), ...lower].filter((v, i, all) => !all.slice(0, i).some(q => norm(minus(v, q)) < 1e-12))
      const e = splineEdge(ctx, unique.map(p => local(ctx, p)), !p.finite_te)
      const wire = p.finite_te ? r.assembleWire([e, r.makeLine(e.endPoint, e.startPoint)]) : r.assembleWire([e])
      return Object.assign(curveShape(ctx, wire, 'Wire'), { code, max_camber: m, camber_pos: c, thickness: t, finite_te: p.finite_te, camberPoints: camber })
    },
    BlendCurve(args, kwargs) {
      const p = params(args, kwargs, ['curve0', 'curve1', 'continuity', 'end_points', 'tangent_scalars', 'mode'], { continuity: 'C2', tangent_scalars: [1, 1] })
      const e0 = edge(p.curve0, ctx), e1 = edge(p.curve1, ctx)
      const ends = [tuple(e0.startPoint), tuple(e0.endPoint)], targets = [tuple(e1.startPoint), tuple(e1.endPoint)]
      let a = 0, b = 0, distance = Infinity
      if (p.end_points) { a = ends.findIndex(v => norm(minus(v, tuple(p.end_points[0]))) < 1e-6); b = targets.findIndex(v => norm(minus(v, tuple(p.end_points[1]))) < 1e-6); if (a < 0 || b < 0) throw new Error('end_points must coincide with curve endpoints') }
      else ends.forEach((v, i) => targets.forEach((w, j) => { const d = norm(minus(v, w)); if (d < distance) { a = i; b = j; distance = d } }))
      if (p.tangent_scalars.length !== 2) throw new Error('tangent_scalars requires two values')
      const start = ends[a]!, end = targets[b]!, d0 = times(derivative(ctx, e0, a, 1), p.tangent_scalars[0]), d1 = times(derivative(ctx, e1, b, 1), p.tangent_scalars[1])
      const level = enumName(p.continuity)
      if (level === 'C0') return curveShape(ctx, r.makeLine(start, end))
      const points = level === 'C1' ? [start, plus(start, times(d0, 1 / 3)), minus(end, times(d1, 1 / 3)), end] : [start, plus(start, times(d0, 1 / 5)), plus(plus(start, times(d0, 2 / 5)), times(derivative(ctx, e0, a, 2), 1 / 20)), plus(minus(end, times(d1, 2 / 5)), times(derivative(ctx, e1, b, 2), 1 / 20)), minus(end, times(d1, 1 / 5)), end]
      return curveShape(ctx, r.makeBezierCurve(points))
    },
    ConstrainedLines(args, kwargs) {
      if (args.length !== 2) throw new Error('ConstrainedLines requires two tangency constraints')
      if (args.some(v => Array.isArray(v) && isKernelShape(v[0]))) throw new Error('Qualified circle tangency constraints are not yet supported by the browser kernel')
      if (kwargs.angle != null || kwargs.direction != null) throw new Error('Fixed-orientation constrained lines are not yet supported by the browser kernel')
      const circle = (v: any): { center: P; radius: number } => {
        const s = Array.isArray(v) && isKernelShape(v[0]) ? v[0] : v
        if (!isKernelShape(s) || !(s.shape instanceof r.Edge) || s.shape.geomType !== 'CIRCLE') throw new Error('ConstrainedLines currently requires circular tangency targets')
        const c = new ctx.oc.BRepAdaptor_Curve(s.shape.wrapped), circ = c.Circle(), center = circ.Location()
        const result = { center: [center.X(), center.Y(), center.Z()] as P, radius: circ.Radius() }; center.delete(); circ.delete(); c.delete(); return result
      }
      const a = circle(args[0]), point = !isKernelShape(args[1]) && !(Array.isArray(args[1]) && isKernelShape(args[1][0]))
      const b = point ? { center: tuple(args[1]), radius: 0 } : circle(args[1])
      const delta = minus(b.center, a.center), d = norm(delta), u = unit(delta), perp = [-u[1], u[0], 0] as P
      const edges: KernelShape[] = []
      for (const sign of point ? [1] : [1, -1]) {
        const h = (a.radius - sign * b.radius) / d
        if (Math.abs(h) > 1) continue
        for (const side of [-1, 1]) {
          const n = plus(times(u, h), times(perp, side * Math.sqrt(1 - h * h)))
          edges.push(curveShape(ctx, r.makeLine(plus(a.center, times(n, a.radius)), plus(b.center, times(n, sign * b.radius)))))
        }
      }
      if (!edges.length) throw new Error('No constrained tangent lines exist')
      const selected = kwargs.selector ? kwargs.selector(edges) : edges
      if (isKernelShape(selected)) return selected
      if (!Array.isArray(selected) || !selected.length || selected.some(s => !isKernelShape(s))) throw new Error('selector must return an edge or a non-empty collection of edges')
      return compound(ctx, selected.map(s => s.shape.clone()), 'Curve')
    },
    ConstrainedArcs(args, kwargs) {
      if (kwargs.center_on != null) throw new Error('Center-locus constrained arcs are not yet supported by the browser kernel')
      if (args.length !== 2 || !Array.isArray(args[0]) || !Array.isArray(args[1]) || typeof args[0][0] !== 'number' || typeof args[1][0] !== 'number') throw new Error('Browser ConstrainedArcs currently supports two point constraints and a radius')
      const a = tuple(args[0]), b = tuple(args[1]), radius = positive(kwargs.radius, 'radius'), d = minus(b, a), half = norm(d) / 2
      if (radius < half) throw new Error('Arc radius cannot reach both constraint points')
      const u = unit(d), mid = times(plus(a, b), .5), height = Math.sqrt(radius ** 2 - half ** 2), perp = [-u[1], u[0], 0] as P
      const results: KernelShape[] = [], sag = enumName(kwargs.sagitta ?? 'SHORT')
      for (const side of [-1, 1]) {
        const center = plus(mid, times(perp, side * height)), start = Math.atan2(a[1] - center[1], a[0] - center[0]) / rad
        const end = Math.atan2(b[1] - center[1], b[0] - center[0]) / rad
        let short = ((end - start + 540) % 360) - 180
        for (const size of sag === 'BOTH' ? [short, short - Math.sign(short) * 360] : [sag === 'LONG' ? short - Math.sign(short) * 360 : short]) results.push(arcMetadata(curveShape(ctx, circularArc(ctx, center, radius, start, size)), local(ctx, center), radius))
      }
      const selected = kwargs.selector ? kwargs.selector(results) : results
      if (isKernelShape(selected)) return selected
      if (!Array.isArray(selected) || !selected.length || selected.some(s => !isKernelShape(s))) throw new Error('selector must return an edge or a non-empty collection of edges')
      return compound(ctx, selected.map(s => s.shape.clone()), 'Curve')
    },
    DoubleTangentArc(args, kwargs) {
      const p = params(args, kwargs, ['pnt', 'tangent', 'other', 'keep', 'mode'], { keep: 'TOP' }); const start = tuple(p.pnt), tangent = unit(tuple(p.tangent)), target = edge(p.other, ctx)
      if (!['TOP', 'BOTTOM'].includes(enumName(p.keep))) throw new Error('DoubleTangentArc keep must be TOP or BOTTOM')
      if (target.geomType !== 'LINE') throw new Error('Browser DoubleTangentArc currently supports a straight target')
      const a = tuple(target.startPoint), b = tuple(target.endPoint), d = unit(minus(b, a)), normal = [-d[1], d[0], 0] as P, perp = [-tangent[1], tangent[0], 0] as P
      const solutions: { radius: number; end: P }[] = []
      for (const side of [-1, 1]) for (const sign of [-1, 1]) {
        const v = times(perp, side), denominator = dot(normal, v) - sign
        if (Math.abs(denominator) < 1e-12) continue
        const radius = -dot(normal, minus(start, a)) / denominator
        if (radius <= 1e-8) continue
        const center = plus(start, times(v, radius)), end = minus(center, times(normal, dot(normal, minus(center, a))))
        if (dot(minus(end, a), d) < -1e-6 || dot(minus(end, b), d) > 1e-6) continue
        if (!solutions.some(s => norm(minus(s.end, end)) < 1e-6)) solutions.push({ radius, end })
      }
      if (!solutions.length) throw new Error('No double tangent arc exists')
      const chosen = enumName(p.keep) === 'BOTTOM' ? solutions.at(-1)! : solutions[0]!
      return curveShape(ctx, r.makeTangentArc(start, tangent, chosen.end))
    },
    Text(args, kwargs) {
      const p = params(args, kwargs, ['txt', 'font_size', 'font', 'font_path', 'font_style', 'text_align', 'align', 'path', 'position_on_path', 'single_line_width', 'rotation', 'mode'], { font: 'DejaVu Sans', font_style: 'REGULAR', text_align: ['CENTER', 'CENTER'] })
      positive(p.font_size, 'font_size')
      if (String(p.txt).includes('\n') || String(p.txt).includes('\r')) throw new Error('Multiline Text is not yet supported by the browser kernel')
      if (p.font_path) throw new Error('Text font_path requires registering that font with loadFont() first')
      if (enumName(p.font_style) !== 'REGULAR') throw new Error('Register a matching bold or italic font before requesting that Text font_style')
      if (!r.getFont(p.font)) throw new Error(`Font "${p.font}" is not loaded; call loadFont() before rendering text`)
      if (p.path) throw new Error('Text following an edge path is not yet supported by the browser kernel')
      const font = r.getFont(p.font)!
      const path = font.getPath(String(p.txt), 0, 0, p.font_size)
      const [horizontal, vertical] = p.text_align.map(enumName)
      const advance = font.getAdvanceWidth(String(p.txt), p.font_size)
      const fontScale = p.font_size / font.unitsPerEm
      const shiftX = horizontal === 'CENTER' ? -advance / 2 : horizontal === 'RIGHT' ? -advance : 0
      const shiftY = vertical === 'CENTER' ? -(font.ascender + font.descender) * fontScale / 2 : vertical === 'TOP' || vertical === 'TOPFIRSTLINE' ? -font.ascender * fontScale : 0
      const bbox = path.getBoundingBox()
      let translation: P = [shiftX, shiftY, 0]
      if (p.align != null) {
        const align = Array.isArray(p.align) ? p.align : [p.align, p.align]
        const min = [bbox.x1 + shiftX, -bbox.y2 + shiftY], max = [bbox.x2 + shiftX, -bbox.y1 + shiftY]
        translation = plus(translation, [0, 1].map(i => { const a = enumName(align[i]); return a === 'MIN' ? -min[i]! : a === 'MAX' ? -max[i]! : a === 'CENTER' ? -(min[i]! + max[i]!) / 2 : 0 }).concat(0) as P)
      }
      const angle = (p.rotation ?? 0) * rad
      const faces = fontFaces(ctx, path.commands, point => { const q = plus(point, translation); return local(ctx, [q[0] * Math.cos(angle) - q[1] * Math.sin(angle), q[0] * Math.sin(angle) + q[1] * Math.cos(angle), 0]) })
      if (!faces.length) throw new Error('Text has no visible glyph outlines')
      return Object.assign(compound(ctx, faces), { txt: String(p.txt), font_size: p.font_size, font: p.font, plane: ctx.current()?.plane })
    },
    Draft(args, kwargs) {
      const p = params(args, kwargs, ['font_size', 'font', 'font_style', 'head_type', 'arrow_length', 'line_width', 'pad_around_text', 'unit', 'number_display', 'display_units', 'decimal_precision', 'fractional_precision', 'extension_gap'], { font_size: 5, font: 'DejaVu Sans', font_style: 'REGULAR', head_type: 'CURVED', arrow_length: 3, line_width: .5, pad_around_text: 2, unit: 'MM', number_display: 'DECIMAL', display_units: true, decimal_precision: 2, fractional_precision: 64, extension_gap: 2 })
      if (!Number.isInteger(Math.log2(p.fractional_precision))) throw new Error('fractional_precision must be a power of two')
      return { __cadDraft: true, ...p }
    },
    ArrowHead(args, kwargs) {
      const p = params(args, kwargs, ['size', 'head_type', 'rotation', 'mode'], { head_type: 'CURVED', rotation: 0 })
      let head = arrowHead(ctx, p.size, p.head_type)
      if (p.rotation) head = head.rotate(p.rotation)
      return shapeValue(head, 'Sketch')
    },
    Arrow(args, kwargs) {
      const p = params(args, kwargs, ['arrow_size', 'shaft_path', 'shaft_width', 'head_at_start', 'head_type', 'mode'], { head_at_start: true, head_type: 'CURVED' })
      const path = edge(p.shaft_path, ctx)
      if (path.geomType !== 'LINE') throw new Error('Browser Arrow currently requires a straight shaft path')
      const a = tuple(path.startPoint), b = tuple(path.endPoint), u = unit(minus(b, a)), size = positive(p.arrow_size, 'arrow_size')
      const angle = Math.atan2(u[1], u[0]) / rad + (p.head_at_start ? 180 : 0), tip = p.head_at_start ? a : b
      const head = arrowHead(ctx, size, p.head_type).rotate(angle).translate(tip)
      const shaft = stroke(ctx, p.head_at_start ? plus(a, times(u, size / 2)) : a, p.head_at_start ? b : minus(b, times(u, size / 2)), p.shaft_width)
      return shapeValue(booleanFaces(ctx, [head, shaft]), 'Sketch')
    },
    DimensionLine(args, kwargs) {
      const p = params(args, kwargs, ['path', 'draft', 'sketch', 'label', 'arrows', 'tolerance', 'label_angle', 'mode'], { arrows: [true, true], label_angle: false })
      const path = Array.isArray(p.path) ? p.path.map(tuple) : [tuple(edge(p.path, ctx).startPoint), tuple(edge(p.path, ctx).endPoint)]
      if (path.length !== 2) throw new Error('Only two points are allowed for DimensionLine')
      if (!p.arrows.some(Boolean)) throw new Error('No output - no arrows selected')
      if (p.label_angle) throw new Error('DimensionLine angular labels require curved paths, which are not yet supported')
      if (p.sketch) throw new Error('DimensionLine placement against an existing sketch is not yet supported')
      const a = path[0]!, b = path[1]!, vector = minus(b, a), length = norm(vector), u = unit(vector), style = p.draft ?? handlers.Draft!([], {}, ctx)
      const label = p.label ?? draftLabel(style, length, p.tolerance), labelShape = handlers.Text!([], { txt: label, font_size: style.font_size, font: style.font, align: ['CENTER', 'CENTER'] }, ctx) as KernelShape
      const labelLength = labelShape.shape.boundingBox.width, shaftLength = (length - labelLength) / 2 - style.pad_around_text
      const internal = labelLength + p.arrows.filter(Boolean).length * style.arrow_length < length && shaftLength > style.arrow_length / 2
      const shafts: [P, P][] = internal ? [[a, plus(a, times(u, shaftLength))], [minus(b, times(u, shaftLength)), b]] : [[a, minus(a, times(u, 2 * style.arrow_length))], [plus(b, times(u, 2 * style.arrow_length)), b]]
      const shapes: AnyShape[] = []
      shafts.forEach(([start, end], i) => { if (p.arrows[i]) { const shaftPath = curveShape(ctx, r.makeLine(start, end)); shapes.push((handlers.Arrow!([], { arrow_size: style.arrow_length, shaft_path: shaftPath, shaft_width: style.line_width, head_type: style.head_type, head_at_start: internal ? i === 0 : i === 1 }, ctx) as KernelShape).shape) } })
      const mid = times(plus(a, b), .5), angle = Math.atan2(u[1], u[0]) / rad
      labelShape.shape = labelShape.shape.rotate(angle >= 180 || angle < -90 ? angle + 180 : angle).translate(local(ctx, mid))
      shapes.push(labelShape.shape)
      return Object.assign(compound(ctx, shapes), { dimension: length })
    },
    ExtensionLine(args, kwargs) {
      const p = params(args, kwargs, ['border', 'offset', 'draft', 'sketch', 'label', 'arrows', 'tolerance', 'label_angle', 'measurement_direction', 'mode'], { arrows: [true, true] })
      const path = Array.isArray(p.border) ? p.border.map(tuple) : [tuple(edge(p.border, ctx).startPoint), tuple(edge(p.border, ctx).endPoint)]
      if (path.length !== 2) throw new Error('Browser ExtensionLine currently requires a straight border')
      let a = path[0]!, b = path[1]!, u = unit(minus(b, a)), offset: P
      if (typeof p.offset === 'number') { if (!p.offset) throw new Error('Use DimensionLine when offset is zero'); offset = times([u[1], -u[0], 0], p.offset) }
      else { offset = tuple(p.offset); if (!norm(offset)) throw new Error('offset must be non-zero'); if (Math.abs(offset[2]) > 1e-6) throw new Error('offset must lie in the drawing XY plane'); const direction = p.measurement_direction ? unit(tuple(p.measurement_direction)) : unit([offset[1], -offset[0], 0]); const extent = times(direction, dot(minus(b, a), direction)); if (norm(extent) < 1e-6) throw new Error('border has no extent along measurement_direction'); b = plus(a, extent); u = unit(extent); if (Math.abs(dot(unit(offset), u)) > Math.sin(rad)) throw new Error('offset must be perpendicular to the dimension line') }
      const style = p.draft ?? handlers.Draft!([], {}, ctx), shifted: P[] = [plus(a, offset), plus(b, offset)]
      const dimension = handlers.DimensionLine!([], { ...p, path: shifted, draft: style, label: p.label ?? draftLabel(style, norm(minus(b, a)), p.tolerance) }, ctx) as KernelShape
      const gap = times(unit(offset), style.extension_gap)
      const shapes = [dimension.shape, stroke(ctx, plus(path[0]!, gap), plus(shifted[0]!, gap), style.line_width), stroke(ctx, plus(path[1]!, gap), plus(shifted[1]!, gap), style.line_width)]
      return Object.assign(compound(ctx, shapes), { dimension: norm(minus(b, a)) })
    },
    TechnicalDrawing(args, kwargs) {
      const p = params(args, kwargs, ['designed_by', 'design_date', 'page_size', 'title', 'sub_title', 'drawing_number', 'sheet_number', 'drawing_scale', 'nominal_text_size', 'line_width', 'mode'], { designed_by: 'build123d', design_date: new Date().toISOString().slice(0, 10), page_size: 'A4', title: 'Title', sub_title: 'Sub Title', drawing_number: 'B3D-1', sheet_number: null, drawing_scale: 1, nominal_text_size: 10, line_width: .5 })
      const sizes: Record<string, number[]> = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210], A5: [210, 148.5], A6: [148.5, 105], A7: [105, 74], A8: [74, 52], A9: [52, 37], A10: [37, 26], LETTER: [279.4, 215.9], LEGAL: [355.6, 215.9], LEDGER: [431.8, 279.4] }
      const size = sizes[enumName(p.page_size)]; if (!size) throw new Error('Unknown technical drawing page size')
      const text = positive(p.nominal_text_size, 'nominal_text_size'), w = size[0]! - 10 - 2 * text, h = 2 * w / 3, width = positive(p.line_width, 'line_width'), shapes: AnyShape[] = []
      const addLine = (a: P, b: P) => shapes.push(stroke(ctx, a, b, width))
      const addText = (label: any, fontSize: number, x: number, y: number, left = false) => { try { const t = handlers.Text!([], { txt: String(label), font_size: fontSize, font: 'DejaVu Sans', align: left ? ['MIN', 'CENTER'] : null }, ctx) as KernelShape; t.shape = t.shape.translate(local(ctx, [x, y, 0])); shapes.push(t.shape) } catch (error) { throw new Error(`TechnicalDrawing label ${String(label)} failed: ${String(error)}`) } }
      const frame: P[] = [[-w / 2, h / 2, 0], [w / 2, h / 2, 0], [w / 2, -h / 2, 0], [-w / 2, -h / 2, 0]]
      frame.forEach((a, i) => addLine(a, frame[(i + 1) % 4]!))
      const lengths = [w, h, w, h], perimeter = 2 * (w + h)
      for (let i = 0; i < 20; i++) {
        if ([0, 6, 10, 16].includes(i)) continue
        let distance = i / 20 * perimeter, segment = 0
        while (distance > lengths[segment]! + 1e-9) { distance -= lengths[segment]!; segment++ }
        const u = unit(minus(frame[(segment + 1) % 4]!, frame[segment]!)), start = plus(frame[segment]!, times(u, distance))
        addLine(start, plus(start, times([-u[1], u[0], 0], text)))
      }
      for (let n = 0; n < 4; n++) for (const side of [-.5, .5]) addText(n + 1, text, side * (w + 1.5 * text), [-3 / 8, -1 / 8, 1 / 8, 3 / 8][n]! * h)
      ;['F', 'E', 'D', 'C', 'B', 'A'].forEach((letter, i) => { for (const side of [-.5, .5]) addText(letter, text, [-5 / 12, -3 / 12, -1 / 12, 1 / 12, 3 / 12, 5 / 12][i]! * w, side * (h + 1.5 * text)) })
      const bottom = -h / 2, top = -h / 4, y = (u: number) => bottom + u * h / 4
      addLine([0, bottom, 0], [0, top, 0]); addLine([0, top, 0], [w / 2, top, 0]); addLine([0, y(1 / 3), 0], [w / 2, y(1 / 3), 0]); addLine([0, y(2 / 3), 0], [w / 2, y(2 / 3), 0]); addLine([w / 6, top, 0], [w / 6, bottom, 0]); addLine([w / 3, bottom, 0], [w / 3, y(1 / 3), 0])
      const x0 = text / 5, x1 = x0 + w / 6, x2 = x0 + w / 3
      addText('DESIGNED BY:', text / 3, x0, y(11 / 12), true); addText(p.designed_by, text / 2, x0, y(9 / 12), true)
      addText('DATE:', text / 3, x0, y(7 / 12), true); addText(p.design_date instanceof Date ? p.design_date.toISOString().slice(0, 10) : p.design_date, text / 2, x0, y(5 / 12), true)
      addText('SCALE:', text / 3, x0, y(3 / 12), true); addText(`1:${Number(p.drawing_scale).toFixed(1)}`, text / 2, x0, y(1 / 12), true)
      addText(p.title, text, x1, y(10 / 12), true); addText(p.sub_title, text, x1, y(6 / 12), true)
      addText('DRAWING NUMBER:', text / 3, x1, y(3 / 12), true); addText(p.drawing_number, text / 2, x1, y(1 / 12), true)
      addText('SHEET:', text / 3, x2, y(3 / 12), true); if (p.sheet_number != null) addText(p.sheet_number, text / 2, x2, y(1 / 12), true)
      return compound(ctx, shapes)
    },
  }
  handlers.BlendCurveC1 = (args, kwargs) => handlers.BlendCurve!(args, { ...kwargs, continuity: 'C1' }, ctx)
  handlers.BlendCurveC2 = (args, kwargs) => handlers.BlendCurve!(args, { ...kwargs, continuity: 'C2' }, ctx)
  return handlers
}
