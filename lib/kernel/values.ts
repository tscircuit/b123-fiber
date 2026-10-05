import { Color as ThreeColor } from 'three'
import { isKernelShape, shapeList, shapeValue, shapeKind, type KernelContext, type KernelHandler, type KernelShape } from './types'
import { offsetShape2D } from './geometry'

type Tuple = [number, number, number]
const EPS = 1e-7
const radians = (value: number) => value * Math.PI / 180
const degrees = (value: number) => value * 180 / Math.PI
const enumName = (value: any) => String(value?.$enum ?? value ?? '').split('.').at(-1)!
const param = (args: any[], kwargs: Record<string, any>, index: number, name: string, fallback?: any) => kwargs[name] !== undefined ? kwargs[name] : args[index] !== undefined ? args[index] : fallback
const unsupported = (name: string): never => { throw new Error(`${name} is not implemented by the browser OpenCascade bindings`) }

/** Build123d vectors are values; they do not need OpenCascade heap allocations. */
export class KernelVector {
  readonly __cadValue = 'Vector'
  constructor(public X = 0, public Y = 0, public Z = 0) {}
  get x() { return this.X }
  set x(value: number) { this.X = value }
  get y() { return this.Y }
  set y(value: number) { this.Y = value }
  get z() { return this.Z }
  set z(value: number) { this.Z = value }
  get length() { return Math.hypot(this.X, this.Y, this.Z) }
  get Length() { return this.length }
  toArray(): Tuple { return [this.X || 0, this.Y || 0, this.Z || 0] }
  toTuple(): Tuple { return this.toArray() }
  add(other: any) { const p = vectorTuple(other); return new KernelVector(this.X + p[0], this.Y + p[1], this.Z + p[2]) }
  sub(other: any) { const p = vectorTuple(other); return new KernelVector(this.X - p[0], this.Y - p[1], this.Z - p[2]) }
  multiply(scale: number) { return new KernelVector(this.X * scale, this.Y * scale, this.Z * scale) }
  dot(other: any) { const p = vectorTuple(other); return this.X * p[0] + this.Y * p[1] + this.Z * p[2] }
  cross(other: any) { const [x, y, z] = vectorTuple(other); return new KernelVector(this.Y * z - this.Z * y, this.Z * x - this.X * z, this.X * y - this.Y * x) }
  normalized() { if (this.length < EPS) throw new Error('Cannot normalize a zero-length vector'); return this.multiply(1 / this.length) }
}

/** Arrays remain iterable in plans while retaining ShapeList identity over RPC. */
export function kernelShapeList<T>(items: T[] = []): T[] & { readonly __cadValue: 'ShapeList' } {
  if ((items as any).__cadValue !== 'ShapeList') Object.defineProperty(items, '__cadValue', { value: 'ShapeList' })
  return items as T[] & { readonly __cadValue: 'ShapeList' }
}

export function vectorTuple(value: any = [0, 0, 0]): Tuple {
  if (Array.isArray(value)) return [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)]
  if (typeof value?.toTuple === 'function') return vectorTuple(value.toTuple())
  if (typeof value?.toArray === 'function') return vectorTuple(value.toArray())
  if (value?.position && value.__cadValue === 'Location') return vectorTuple(value.position)
  return [Number(value?.X ?? value?.x ?? 0), Number(value?.Y ?? value?.y ?? 0), Number(value?.Z ?? value?.z ?? 0)]
}
const vector = (value: any) => new KernelVector(...vectorTuple(value))
const normalize = (value: any) => vector(value).normalized()
function rotateVector(value: any, angle: number, direction: any, origin: any = [0, 0, 0]) {
  const axis = normalize(direction), p = vector(value).sub(origin), c = Math.cos(radians(angle)), s = Math.sin(radians(angle))
  return p.multiply(c).add(axis.cross(p).multiply(s)).add(axis.multiply(axis.dot(p) * (1 - c))).add(origin)
}

export class KernelAxis {
  readonly __cadValue = 'Axis'
  position: KernelVector
  direction: KernelVector
  constructor(position: any = [0, 0, 0], direction: any = [0, 0, 1]) { this.position = vector(position); this.direction = normalize(direction) }
}
export class KernelPlane {
  readonly __cadValue = 'Plane'
  origin: KernelVector
  x_dir: KernelVector
  z_dir: KernelVector
  constructor(origin: any = [0, 0, 0], xDirection: any = null, normal: any = [0, 0, 1]) {
    this.origin = vector(origin); this.z_dir = normalize(normal)
    xDirection ??= Math.abs(this.z_dir.X) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    this.x_dir = vector(xDirection).sub(this.z_dir.multiply(vector(xDirection).dot(this.z_dir))).normalized()
  }
  get y_dir() { return this.z_dir.cross(this.x_dir).normalized() }
  get xDir() { return this.x_dir }
  get yDir() { return this.y_dir }
  get zDir() { return this.z_dir }
  get location() { return locationFromPlane(this) }
}
export function planeValue(value: any = new KernelPlane()): { origin: Tuple; x_dir: Tuple; z_dir: Tuple } {
  return { origin: vectorTuple(value.origin), x_dir: vectorTuple(value.x_dir ?? value.xDir ?? [1, 0, 0]), z_dir: vectorTuple(value.z_dir ?? value.zDir ?? [0, 0, 1]) }
}
export function replicadPlane(value: any, ctx: KernelContext) {
  if (typeof value === 'string') return ctx.replicad.makePlane(value as any)
  const p = planeValue(value)
  return new ctx.replicad.Plane(p.origin, p.x_dir, p.z_dir)
}

type Matrix4 = number[][]
const identity = (): Matrix4 => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
const multiplyMatrices = (a: Matrix4, b: Matrix4): Matrix4 => a.map((row) => b[0].map((_, c) => row.reduce((sum, v, k) => sum + v * b[k][c], 0)))
function eulerMatrix(angles: any): Matrix4 {
  const [x, y, z] = vectorTuple(angles).map(radians), sx = Math.sin(x), sy = Math.sin(y), sz = Math.sin(z), cx = Math.cos(x), cy = Math.cos(y), cz = Math.cos(z)
  return [[cy * cz, -cy * sz, sy, 0], [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy, 0], [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy, 0], [0, 0, 0, 1]]
}
function axisAngleMatrix(direction: any, angle: number, origin: any = [0, 0, 0]): Matrix4 {
  const [x, y, z] = normalize(direction).toTuple(), c = Math.cos(radians(angle)), s = Math.sin(radians(angle)), t = 1 - c
  const matrix = [[t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0], [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0], [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0], [0, 0, 0, 1]]
  vector(origin).sub(transformPoint(matrix, origin)).toTuple().forEach((coordinate, i) => { matrix[i][3] = coordinate })
  return matrix
}
function matrixEuler(m: Matrix4) {
  const y = Math.asin(Math.max(-1, Math.min(1, m[0][2])))
  return Math.abs(Math.cos(y)) > EPS ? new KernelVector(degrees(Math.atan2(-m[1][2], m[2][2])), degrees(y), degrees(Math.atan2(-m[0][1], m[0][0]))) : new KernelVector(degrees(Math.atan2(m[2][1], m[1][1])), degrees(y), 0)
}
const transformPoint = (matrix: Matrix4, point: any, direction = false) => {
  const p = [...vectorTuple(point), direction ? 0 : 1]
  return new KernelVector(...matrix.slice(0, 3).map(row => row.reduce((sum, v, i) => sum + v * p[i], 0)) as Tuple)
}
function inverseRigid(matrix: Matrix4): Matrix4 {
  const output = identity()
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) output[i][j] = matrix[j][i]
  for (let i = 0; i < 3; i++) output[i][3] = -output[i].slice(0, 3).reduce((sum, v, j) => sum + v * matrix[j][3], 0)
  return output
}
function inverseMatrix(matrix: Matrix4): Matrix4 {
  const augmented = matrix.map((row, i) => [...row, ...identity()[i]])
  for (let column = 0; column < 4; column++) {
    let pivot = column
    for (let row = column + 1; row < 4; row++) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row
    if (Math.abs(augmented[pivot][column]) < EPS) throw new Error('Matrix is singular')
    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const scale = augmented[column][column]; augmented[column] = augmented[column].map(value => value / scale)
    for (let row = 0; row < 4; row++) if (row !== column) { const factor = augmented[row][column]; augmented[row] = augmented[row].map((value, i) => value - factor * augmented[column][i]) }
  }
  return augmented.map(row => row.slice(4))
}
export class KernelLocation {
  readonly __cadValue = 'Location'
  matrix: Matrix4
  constructor(position: any = [0, 0, 0], orientation: any = [0, 0, 0], matrix?: Matrix4) {
    this.matrix = matrix ?? eulerMatrix(orientation)
    if (!matrix) vectorTuple(position).forEach((value, index) => { this.matrix[index][3] = value })
  }
  get position() { return new KernelVector(this.matrix[0][3], this.matrix[1][3], this.matrix[2][3]) }
  set position(value: any) { vectorTuple(value).forEach((coordinate, i) => { this.matrix[i][3] = coordinate }) }
  get orientation() { return matrixEuler(this.matrix) }
  set orientation(value: any) { const position = this.position; this.matrix = eulerMatrix(value); this.position = position }
}
export function locationValue(value: any = new KernelLocation()): { position: Tuple; rotation: Tuple } {
  return { position: vectorTuple(value.position ?? value), rotation: vectorTuple(value.orientation ?? value.rotation ?? [0, 0, 0]) }
}
function locationFromPlane(plane: KernelPlane) {
  const x = plane.x_dir.toArray(), y = plane.y_dir.toArray(), z = plane.z_dir.toArray(), o = plane.origin.toArray()
  return new KernelLocation(undefined, undefined, [[x[0], y[0], z[0], o[0]], [x[1], y[1], z[1], o[1]], [x[2], y[2], z[2], o[2]], [0, 0, 0, 1]])
}
export function applyLocation(value: KernelShape, location: any, ctx: KernelContext): KernelShape {
  const loc = location instanceof KernelLocation ? location : new KernelLocation(location?.position ?? location, location?.orientation)
  const [x, y, z] = loc.orientation.toArray()
  let shape = value.shape.clone()
  if (z) shape = shape.rotate(z, [0, 0, 0], [0, 0, 1])
  if (y) shape = shape.rotate(y, [0, 0, 0], [0, 1, 0])
  if (x) shape = shape.rotate(x, [0, 0, 0], [1, 0, 0])
  shape = shape.translate(loc.position.toArray())
  const transformed = shapeValue(shape, value.kind, { ...value, shape, children: value.children?.map(child => applyLocation(child, loc, ctx)) })
  const old = (value as any).location instanceof KernelLocation ? (value as any).location : new KernelLocation()
  ;(transformed as any).location = new KernelLocation(undefined, undefined, multiplyMatrices(loc.matrix, old.matrix))
  return transformed
}

export class KernelColor {
  readonly __cadValue = 'Color'
  rgba: [number, number, number, number]
  constructor(value: any = 'white', g?: number, b?: number, a = 1) {
    if (value instanceof KernelColor) this.rgba = [...value.rgba]
    else if (Array.isArray(value)) this.rgba = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3] ?? 1)]
    else if (typeof value === 'number' && g !== undefined && b !== undefined) this.rgba = [value, g, b, a]
    else {
      const hex = new ThreeColor(typeof value === 'number' ? value : String(value)).getHex()
      this.rgba = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, a]
    }
  }
  toTuple() { return this.rgba }
}
export class KernelBoundBox {
  readonly __cadValue = 'BoundBox'
  min: KernelVector
  max: KernelVector
  constructor(min: any = [0, 0, 0], max: any = [0, 0, 0]) { this.min = vector(min); this.max = vector(max) }
  get size() { return this.max.sub(this.min) }
  get diagonal() { return this.size.length }
  get center() { return this.min.add(this.max).multiply(0.5) }
}
export class KernelMatrix {
  readonly __cadValue = 'Matrix'
  matrix: Matrix4
  constructor(matrix?: Matrix4) { this.matrix = matrix ? [...matrix.map(row => [...row]), ...(matrix.length === 3 ? [[0, 0, 0, 1]] : [])] : identity() }
}

export class KernelOrientedBoundBox {
  readonly __cadValue = 'OrientedBoundBox'
  center: KernelVector
  size: KernelVector
  location: KernelLocation
  plane: KernelPlane
  constructor(shape: KernelShape, ctx: KernelContext) {
    const box = new ctx.oc.Bnd_OBB()
    try {
      ctx.oc.BRepBndLib.AddOBB(shape.shape.wrapped, box, false, true, false)
      const read = (coordinate: any) => { try { return new KernelVector(coordinate.X(), coordinate.Y(), coordinate.Z()) } finally { coordinate.delete() } }
      this.center = read(box.Center())
      this.plane = new KernelPlane(this.center, read(box.XDirection()), read(box.ZDirection()))
      this.size = new KernelVector(2 * box.XHSize(), 2 * box.YHSize(), 2 * box.ZHSize())
      this.location = this.plane.location
    } finally { box.delete() }
  }
  get diagonal() { return this.size.length }
  get corners() { const result: KernelVector[] = []; for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) result.push(planeCoords(this.plane, [x * this.size.X / 2, y * this.size.Y / 2, z * this.size.Z / 2], false)); return result }
}

function wrappedShape(value: any): KernelShape {
  if (isKernelShape(value)) return value
  if (isKernelShape(value?.shape)) return value.shape
  throw new TypeError('Expected an OpenCascade shape')
}
function shapeBounds(value: KernelShape) { const bounds = value.shape.boundingBox.bounds; return new KernelBoundBox(bounds[0], bounds[1]) }
function shapeCenter(value: KernelShape, ctx: KernelContext) {
  const shape: any = value.shape
  if (shape.asTuple) return vector(shape.asTuple())
  try {
    if (shape instanceof ctx.replicad.Edge || shape instanceof ctx.replicad.Wire) return vector(ctx.replicad.measureShapeLinearProperties(shape).centerOfMass)
    if (shape instanceof ctx.replicad.Face) return vector(ctx.replicad.measureShapeSurfaceProperties(shape).centerOfMass)
    return vector(ctx.replicad.measureShapeVolumeProperties(shape).centerOfMass)
  } catch { return shapeBounds(value).center }
}
function topology(value: KernelShape, name: string, ctx: KernelContext): KernelShape[] {
  const singular = name.replace(/s$/, ''), native: any = value.shape
  if (name === 'vertices') {
    const vertices: KernelShape[] = [], explorer = new ctx.oc.TopExp_Explorer(native.wrapped, ctx.oc.TopAbs_ShapeEnum.TopAbs_VERTEX, ctx.oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
    while (explorer.More()) { const shape = ctx.replicad.cast(explorer.Current()); if (!vertices.some(vertex => vertex.shape.isSame(shape))) vertices.push(shapeValue(shape, 'Vertex')); else shape.delete(); explorer.Next() }
    explorer.delete(); return kernelShapeList(vertices.map(vertex => Object.assign(vertex, { owner: value })))
  }
  if (name === 'shells') {
    const shells: KernelShape[] = [], explorer = new ctx.oc.TopExp_Explorer(native.wrapped, ctx.oc.TopAbs_ShapeEnum.TopAbs_SHELL, ctx.oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
    while (explorer.More()) { shells.push(shapeValue(ctx.replicad.cast(explorer.Current()), 'Shell')); explorer.Next() }
    explorer.delete(); return kernelShapeList(shells.map(shell => Object.assign(shell, { owner: value })))
  }
  if (singular === value.kind.toLowerCase() || shapeKind(native).toLowerCase() === singular) return kernelShapeList([value])
  const items: any[] = native[name] ?? []
  return kernelShapeList(items.map(shape => Object.assign(shapeValue(shape, singular[0].toUpperCase() + singular.slice(1)), { owner: value })))
}
function shapeGeomType(value: KernelShape) { return String((value.shape as any).geomType ?? (value.shape as any).surface?.geomType ?? 'OTHER').replace('CYLINDRE', 'CYLINDER').replace(/_(CURVE|SURFACE)$/, '') }
function shapeDirection(value: KernelShape, ctx: KernelContext) {
  const shape: any = value.shape
  if (shape instanceof ctx.replicad.Face) return vector(shape.normalAt())
  if (shape instanceof ctx.replicad.Edge || shape instanceof ctx.replicad.Wire) return vector(shape.tangentAt(0.5))
  return new KernelVector(0, 0, 0)
}
function shapeDistance(a: any, b: any, ctx: KernelContext) {
  const first = wrappedShape(a), second = isKernelShape(b) ? b : shapeValue(ctx.replicad.makeVertex(vectorTuple(b)), 'Vertex')
  try { return ctx.replicad.measureDistanceBetween(first.shape, second.shape) } finally { if (!isKernelShape(b)) second.shape.delete() }
}
function sortKey(value: any, selector: any, ctx: KernelContext): number {
  if (typeof selector === 'function') return Number(selector(value))
  if (selector instanceof KernelAxis) return (value instanceof KernelVector ? value : shapeCenter(wrappedShape(value), ctx)).sub(selector.position).dot(selector.direction)
  const field = enumName(selector).toLowerCase()
  if (['length', 'radius', 'area', 'volume'].includes(field)) return Number(getProperty(value, field, ctx))
  if (typeof selector === 'string' && selector in value) return Number(getProperty(value, selector, ctx))
  return (value instanceof KernelVector ? value : shapeCenter(wrappedShape(value), ctx)).Z
}

export function getProperty(target: any, name: string, ctx: KernelContext): any {
  if (name.startsWith('_')) throw new Error('Private members are not accessible')
  if (/^Build(Part|Sketch|Line)$/.test(target?.kind)) {
    if (['part', 'sketch', 'line', 'shape'].includes(name)) return target.shape
    if (target.shape) return getProperty(target.shape, name, ctx)
  }
  if (isKernelShape(target)) {
    const shape: any = target.shape
    if (shape instanceof ctx.replicad.Vertex && ['X', 'Y', 'Z'].includes(name)) return shape.asTuple()[['X', 'Y', 'Z'].indexOf(name)]
    switch (name) {
      case 'wrapped': return target
      case 'volume': return ctx.replicad.measureVolume(shape)
      case 'area': return ctx.replicad.measureArea(shape)
      case 'length': return shape.length ?? ctx.replicad.measureLength(shape)
      case 'is_valid': { const analyzer = new ctx.oc.BRepCheck_Analyzer(shape.wrapped, true, false, false); const result = analyzer.IsValid(); analyzer.delete(); return result }
      case 'is_null': return shape.isNull
      case 'is_closed': return Boolean(shape.isClosed ?? shape.wrapped.Closed?.())
      case 'is_manifold': { const edges = topology(target, 'edges', ctx); return edges.every(edge => topology(target, 'faces', ctx).filter(face => topology(face, 'edges', ctx).some(e => e.shape.isSame(edge.shape))).length <= 2) }
      case 'geom_type': return { $enum: `GeomType.${shapeGeomType(target)}` }
      case 'position': return shapeCenter(target, ctx)
      case 'location': case 'global_location': return (target as any).location ?? new KernelLocation()
      case 'orientation': return ((target as any).location ?? new KernelLocation()).orientation
      case 'color': return target.color instanceof KernelColor ? target.color : target.color ? new KernelColor(target.color) : null
      case 'label': return target.label ?? ''
      case 'children': return target.children ?? []
      case 'joints': return (target as any).joints ?? ((target as any).joints = {})
      case 'radius': {
        if (!['CIRCLE', 'CYLINDER', 'SPHERE', 'TORUS'].includes(shapeGeomType(target))) throw new Error('Shape has no constant radius')
        const adaptor: any = shape._geomAdaptor(), method = { CIRCLE: 'Circle', CYLINDER: 'Cylinder', SPHERE: 'Sphere', TORUS: 'Torus' }[shapeGeomType(target) as 'CIRCLE']
        try { const surface = adaptor[method](); try { return surface.Radius ? surface.Radius() : surface.MajorRadius() } finally { surface.delete() } } finally { adaptor.delete() }
      }
      case 'material': return (target as any).material ?? null
      default: if (name in target) return (target as any)[name]
    }
  }
  if (target instanceof KernelBoundBox) {
    if (name === 'xmin') return target.min.X
    if (name === 'ymin') return target.min.Y
    if (name === 'zmin') return target.min.Z
    if (name === 'xmax') return target.max.X
    if (name === 'ymax') return target.max.Y
    if (name === 'zmax') return target.max.Z
  }
  if (target instanceof KernelOrientedBoundBox) {
    if (name === 'x_direction') return target.plane.x_dir
    if (name === 'y_direction') return target.plane.y_dir
    if (name === 'z_direction') return target.plane.z_dir
  }
  if (target && name in Object(target)) { const value = target[name]; return typeof value === 'function' ? value.bind(target) : value }
  throw new Error(`Unknown property ${name} on ${target?.kind ?? target?.__cadValue ?? typeof target}`)
}

/** Mutable shape properties update the BRep as well as the retained metadata. */
export function setProperty(target: any, name: string, value: any, ctx: KernelContext): void {
  if (name.startsWith('_') || ['constructor', 'prototype'].includes(name)) throw new Error('Private members are not accessible')
  if (isKernelShape(target) && ['location', 'position', 'orientation'].includes(name)) {
    const old = (target as any).location instanceof KernelLocation ? (target as any).location : new KernelLocation()
    const desired = name === 'location' ? value instanceof KernelLocation ? value : new KernelLocation(value) : new KernelLocation(name === 'position' ? value : old.position, name === 'orientation' ? value : old.orientation)
    const delta = new KernelLocation(undefined, undefined, multiplyMatrices(desired.matrix, inverseRigid(old.matrix)))
    const transformed = applyLocation(target, delta, ctx)
    target.shape = transformed.shape; target.children = transformed.children; (target as any).location = desired
    return
  }
  if (isKernelShape(target) && name === 'color') { (target as any).color = value == null ? undefined : value instanceof KernelColor ? value : new KernelColor(value); return }
  target[name] = value
}

function planeCoords(plane: KernelPlane, point: any, local: boolean): KernelVector {
  const p = vector(point)
  return local ? new KernelVector(p.sub(plane.origin).dot(plane.x_dir), p.sub(plane.origin).dot(plane.y_dir), p.sub(plane.origin).dot(plane.z_dir)) : plane.origin.add(plane.x_dir.multiply(p.X)).add(plane.y_dir.multiply(p.Y)).add(plane.z_dir.multiply(p.Z))
}

export function callMethod(target: any, name: string, args: any[] = [], kwargs: Record<string, any> = {}, ctx: KernelContext): any {
  if (name.startsWith('_')) throw new Error('Private members are not accessible')
  if (/^Build(Part|Sketch|Line)$/.test(target?.kind)) {
    if (target.shape) return callMethod(target.shape, name, args, kwargs, ctx)
    if (['edges', 'wires', 'faces', 'shells', 'solids', 'vertices'].includes(name)) return kernelShapeList(target.pending.flatMap((shape: KernelShape) => topology(shape, name, ctx)))
  }
  const arg = (i: number, key: string, fallback?: any) => param(args, kwargs, i, key, fallback)
  if (Array.isArray(target)) {
    const reverse = Boolean(arg(1, 'reverse', false)), selector = arg(0, 'filter_by', kwargs.sort_by)
    switch (name) {
      case 'filter': return kernelShapeList(target.filter(arg(0, 'predicate')))
      case 'center': return target.reduce((sum, value) => sum.add(shapeCenter(wrappedShape(value), ctx)), new KernelVector()).multiply(1 / (target.length || 1))
      case 'expand': return kernelShapeList(target.flatMap(value => Array.isArray(value) ? value : value.children?.length ? value.children : [value]))
      case 'compound': if (target.length !== 1) throw new Error(`Expected one compound, found ${target.length}`); return target[0]
      case 'compounds': return kernelShapeList(target.flatMap(value => topology(wrappedShape(value), 'compounds', ctx)))
      case 'filter_by': return kernelShapeList(target.filter(value => {
        let matches: boolean
        if (typeof selector === 'function') matches = Boolean(selector(value))
        else if (selector instanceof KernelAxis) { const direction = shapeDirection(wrappedShape(value), ctx); matches = direction.length > EPS && Math.abs(Math.abs(direction.normalized().dot(selector.direction)) - 1) < 1e-5 }
        else if (selector instanceof KernelPlane) matches = Math.abs(Math.abs(shapeDirection(wrappedShape(value), ctx).dot(selector.z_dir)) - 1) < 1e-5
        else matches = shapeGeomType(wrappedShape(value)) === enumName(selector)
        return reverse ? !matches : matches
      }))
      case 'filter_by_position': {
        const axis = arg(0, 'axis'), minimum = arg(1, 'minimum'), maximum = arg(2, 'maximum'), inclusive = arg(3, 'inclusive', [true, true])
        return kernelShapeList(target.filter(value => { const key = sortKey(value, axis, ctx); return (inclusive[0] ? key >= minimum - EPS : key > minimum + EPS) && (inclusive[1] ? key <= maximum + EPS : key < maximum - EPS) }))
      }
      case 'sort': target.sort((a, b) => (sortKey(a, kwargs.key, ctx) - sortKey(b, kwargs.key, ctx)) * (kwargs.reverse ? -1 : 1)); return null
      case 'sort_by': return kernelShapeList([...target].sort((a, b) => (sortKey(a, arg(0, 'sort_by'), ctx) - sortKey(b, arg(0, 'sort_by'), ctx)) * (reverse ? -1 : 1)))
      case 'sort_by_distance': return kernelShapeList([...target].sort((a, b) => (shapeDistance(a, arg(0, 'other'), ctx) - shapeDistance(b, arg(0, 'other'), ctx)) * (reverse ? -1 : 1)))
      case 'group_by': {
        const sorted = [...target].sort((a, b) => sortKey(a, arg(0, 'group_by'), ctx) - sortKey(b, arg(0, 'group_by'), ctx)), groups: any[][] = [], digits = arg(2, 'tol_digits', 6), tolerance = Math.pow(10, -digits)
        for (const value of sorted) { const group = groups.at(-1); if (group && Math.abs(sortKey(group[0], arg(0, 'group_by'), ctx) - sortKey(value, arg(0, 'group_by'), ctx)) < tolerance) group.push(value); else groups.push([value]) }
        return (reverse ? groups.reverse() : groups).map(kernelShapeList)
      }
      case 'first': return target[0]
      case 'last': return target.at(-1)
      case 'edge': case 'wire': case 'face': case 'shell': case 'solid': case 'vertex': if (target.length !== 1) throw new Error(`Expected one ${name}, found ${target.length}`); return target[0]
      case 'edges': case 'wires': case 'faces': case 'shells': case 'solids': case 'vertices': return kernelShapeList(target.flatMap(shape => topology(wrappedShape(shape), name, ctx)))
      case 'append': target.push(args[0]); return null
      case 'extend': target.push(...args[0]); return null
      case 'insert': target.splice(args[0], 0, args[1]); return null
      case 'pop': return target.splice(args[0] ?? -1, 1)[0]
      case 'clear': target.splice(0); return null
      case 'remove': { const index = target.indexOf(args[0]); if (index < 0) throw new Error('Value not in ShapeList'); target.splice(index, 1); return null }
      case 'reverse': target.reverse(); return null
      case 'copy': return kernelShapeList([...target])
      case 'count': return target.filter(value => value === args[0]).length
      case 'index': return target.indexOf(args[0])
    }
  }
  if (target instanceof KernelVector) {
    switch (name) {
      case 'to_tuple': case 'to_list': return target.toArray()
      case 'center': return target
      case 'reverse': return target.multiply(-1)
      case 'normalized': return target.normalized()
      case 'normalize': { const n = target.normalized(); target.X = n.X; target.Y = n.Y; target.Z = n.Z; return target }
      case 'add': return target.add(arg(0, 'vec'))
      case 'sub': return target.sub(arg(0, 'vec'))
      case 'multiply': return target.multiply(arg(0, 'scale'))
      case 'dot': return target.dot(arg(0, 'vec'))
      case 'cross': return target.cross(arg(0, 'vec'))
      case 'get_angle': return degrees(Math.acos(Math.max(-1, Math.min(1, target.normalized().dot(normalize(arg(0, 'vec')))))))
      case 'get_signed_angle': { const other = normalize(arg(0, 'vec')); return degrees(Math.atan2(normalize(arg(1, 'normal', [0, 0, 1])).dot(target.normalized().cross(other)), target.normalized().dot(other))) }
      case 'rotate': { const axis = arg(0, 'axis'); return rotateVector(target, arg(1, 'angle'), axis.direction, axis.position) }
      case 'rotate_x': return rotateVector(target, arg(0, 'angle'), [1, 0, 0])
      case 'rotate_y': return rotateVector(target, arg(0, 'angle'), [0, 1, 0])
      case 'rotate_z': return rotateVector(target, arg(0, 'angle'), [0, 0, 1])
      case 'distance_to': return target.sub(arg(0, 'other')).length
      case 'intersect': return target.sub(arg(0, 'vector')).length < EPS ? target : null
      case 'project_to_line': { const line = arg(0, 'line'); if (line instanceof KernelAxis) return line.position.add(line.direction.multiply(target.sub(line.position).dot(line.direction))); const direction = normalize(line); return direction.multiply(target.dot(direction)) }
      case 'project_to_plane': { const plane = arg(0, 'plane'); return target.sub(plane.z_dir.multiply(target.sub(plane.origin).dot(plane.z_dir))) }
      case 'transform': { const matrix = arg(0, 'affine_transform'); return transformPoint(matrix.matrix, target, Boolean(arg(1, 'is_direction', false))) }
      case 'signed_distance_from_plane': return target.sub(args[0].origin).dot(args[0].z_dir)
      case 'distance_to_plane': return Math.abs(target.sub(args[0].origin).dot(args[0].z_dir))
      case 'to_pnt': return new ctx.oc.gp_Pnt(...target.toTuple())
      case 'to_dir': return new ctx.oc.gp_Dir(...target.normalized().toTuple())
      case 'is_parallel': return Math.abs(Math.abs(target.normalized().dot(normalize(args[0]))) - 1) < (kwargs.tolerance ?? EPS)
      case 'is_normal': return Math.abs(target.normalized().dot(normalize(args[0]))) < (kwargs.tolerance ?? EPS)
      case 'to_axis': return new KernelAxis([0, 0, 0], target)
    }
  }
  if (target instanceof KernelAxis) {
    switch (name) {
      case 'to_plane': { const dir = target.direction; return new KernelPlane(target.position, Math.abs(dir.X) < 0.9 ? [1, 0, 0] : [0, 1, 0], dir) }
      case 'to_location': return locationFromPlane(callMethod(target, 'to_plane', [], {}, ctx))
      case 'reverse': return new KernelAxis(target.position, target.direction.multiply(-1))
      case 'is_parallel': return Math.abs(Math.abs(target.direction.dot(args[0].direction)) - 1) < radians(arg(1, 'angular_tolerance', 1e-5))
      case 'is_normal': return Math.abs(target.direction.dot(args[0].direction)) < radians(arg(1, 'angular_tolerance', 1e-5))
      case 'is_opposite': return target.direction.dot(args[0].direction) < -1 + radians(arg(1, 'angular_tolerance', 1e-5))
      case 'is_coaxial': return callMethod(target, 'is_parallel', args, kwargs, ctx) && target.position.sub(args[0].position).cross(target.direction).length < arg(2, 'linear_tolerance', 1e-5)
      case 'is_skew': return !callMethod(target, 'is_parallel', args, kwargs, ctx) && Math.abs(target.position.sub(args[0].position).dot(target.direction.cross(args[0].direction).normalized())) > arg(1, 'tolerance', EPS)
      case 'angle_between': return callMethod(target.direction, 'get_angle', [args[0].direction], {}, ctx)
      case 'intersect': { const point = vector(arg(0, 'vector')), offset = point.sub(target.position); return offset.cross(target.direction).length < EPS ? point : null }
      case 'located': case 'moved': { const input = arg(0, 'new_location'), loc = input instanceof KernelLocation ? input : new KernelLocation(input); return new KernelAxis(transformPoint(loc.matrix, target.position), transformPoint(loc.matrix, target.direction, true)) }
    }
  }
  if (target instanceof KernelPlane) {
    switch (name) {
      case 'offset': return new KernelPlane(target.origin.add(target.z_dir.multiply(arg(0, 'amount'))), target.x_dir, target.z_dir)
      case 'to_local_coords': { const value = arg(0, 'obj'); if (isKernelShape(value)) return applyLocation(value, new KernelLocation(undefined, undefined, inverseRigid(target.location.matrix)), ctx); return planeCoords(target, value, true) }
      case 'from_local_coords': { const value = arg(0, 'obj'); if (isKernelShape(value)) return applyLocation(value, target.location, ctx); return planeCoords(target, value, false) }
      case 'rotated': { const [x, y, z] = vectorTuple(arg(0, 'rotation')); const m = multiplyMatrices(target.location.matrix, eulerMatrix([x, y, z])); return new KernelPlane(target.origin, transformPoint(m, [1, 0, 0], true), transformPoint(m, [0, 0, 1], true)) }
      case 'shift_origin': return new KernelPlane(arg(0, 'locator'), target.x_dir, target.z_dir)
      case 'move': case 'moved': { const loc = args[0] instanceof KernelLocation ? args[0] : new KernelLocation(args[0]); return new KernelPlane(transformPoint(loc.matrix, target.origin), transformPoint(loc.matrix, target.x_dir, true), transformPoint(loc.matrix, target.z_dir, true)) }
      case 'contains': { const value = arg(0, 'obj'); if (value instanceof KernelAxis) return Math.abs(target.z_dir.dot(value.direction)) < EPS && Math.abs(target.z_dir.dot(value.position.sub(target.origin))) < EPS; return Math.abs(target.z_dir.dot(vector(value).sub(target.origin))) < arg(1, 'tolerance', EPS) }
      case 'intersect': return callMethod(target, 'contains', [arg(0, 'vector')], {}, ctx) ? vector(arg(0, 'vector')) : null
      case 'reverse': return new KernelPlane(target.origin, target.x_dir, target.z_dir.multiply(-1))
      case 'location_between': return new KernelLocation(undefined, undefined, multiplyMatrices(arg(0, 'other').location.matrix, inverseRigid(target.location.matrix)))
      case 'to_gp_ax2': case 'to_gp_ax3': { const point = new ctx.oc.gp_Pnt(...target.origin.toTuple()), normal = new ctx.oc.gp_Dir(...target.z_dir.toTuple()), x = new ctx.oc.gp_Dir(...target.x_dir.toTuple()); try { return name === 'to_gp_ax2' ? new ctx.oc.gp_Ax2(point, normal, x) : new ctx.oc.gp_Ax3(point, normal, x) } finally { point.delete(); normal.delete(); x.delete() } }
      case 'to_location': return target.location
    }
  }
  if (target instanceof KernelLocation) {
    switch (name) {
      case 'inverse': return new KernelLocation(undefined, undefined, inverseRigid(target.matrix))
      case 'to_tuple': return [target.position.toArray(), target.orientation.toArray()]
      case 'to_axis': return new KernelAxis(target.position, transformPoint(target.matrix, [0, 0, 1], true))
      case 'to_matrix': return new KernelMatrix(target.matrix)
      case 'center': return target.position
      case 'intersect': return target.position.sub(arg(0, 'vector')).length < EPS ? vector(arg(0, 'vector')) : null
    }
  }
  if (target instanceof KernelMatrix) {
    switch (name) {
      case 'inverse': return new KernelMatrix(inverseMatrix(target.matrix))
      case 'transposed': return new KernelMatrix(target.matrix[0].map((_, i) => target.matrix.map(row => row[i])))
      case 'transposed_list': return target.matrix[0].map((_, i) => target.matrix.map(row => row[i])).flat()
      case 'multiply': return args[0] instanceof KernelMatrix ? new KernelMatrix(multiplyMatrices(target.matrix, args[0].matrix)) : transformPoint(target.matrix, args[0])
      case 'rotate': { const axis = arg(0, 'axis'), angle = arg(1, 'angle'); const o = vector(axis.position), v = axis.direction, columns = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(p => rotateVector(p, degrees(angle), v)); const m = identity(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] = columns[j].toArray()[i]; const p = o.sub(transformPoint(m, o)); p.toArray().forEach((val: number, i: number) => m[i][3] = val); target.matrix = multiplyMatrices(m, target.matrix); return null }
    }
  }
  if (target instanceof KernelColor && name === 'to_tuple') return target.rgba
  if (target instanceof KernelBoundBox) {
    switch (name) {
      case 'add': { const other = args[0] instanceof KernelBoundBox ? args[0] : new KernelBoundBox(args[0], args[0]), gap = arg(1, 'gap', 0); return new KernelBoundBox(target.min.toArray().map((v, i) => Math.min(v, other.min.toArray()[i]) - gap), target.max.toArray().map((v, i) => Math.max(v, other.max.toArray()[i]) + gap)) }
      case 'is_inside': return target.min.toArray().every((v, i) => v >= args[0].min.toArray()[i]) && target.max.toArray().every((v, i) => v <= args[0].max.toArray()[i])
      case 'center': return target.center
      case 'contains': case 'covers': case 'contains_properly': { const other = arg(0, 'other'), tolerance = arg(1, 'tolerance', EPS), strict = name === 'contains_properly'; return target.min.toArray().every((v, i) => strict ? v < other.min.toArray()[i] - tolerance : v <= other.min.toArray()[i] + tolerance) && target.max.toArray().every((v, i) => strict ? v > other.max.toArray()[i] + tolerance : v >= other.max.toArray()[i] - tolerance) }
      case 'within': case 'covered_by': return callMethod(arg(0, 'other'), 'covers', [target], kwargs, ctx)
      case 'intersects': case 'overlaps': case 'touches': case 'disjoint': { const other = arg(0, 'other'), tolerance = arg(1, 'tolerance', EPS); const overlaps = target.min.toArray().every((v, i) => v <= other.max.toArray()[i] + tolerance) && target.max.toArray().every((v, i) => v >= other.min.toArray()[i] - tolerance); if (name === 'disjoint') return !overlaps; if (name === 'touches') return overlaps && target.min.toArray().some((v, i) => Math.abs(v - other.max.toArray()[i]) <= tolerance || Math.abs(target.max.toArray()[i] - other.min.toArray()[i]) <= tolerance); return overlaps }
      case 'to_align_offset': { const align = arg(0, 'align'); return new KernelVector(...target.min.toArray().map((minimum, i) => { const mode = enumName(Array.isArray(align) ? align[i] : align); return mode === 'MIN' ? -minimum : mode === 'MAX' ? -target.max.toArray()[i] : mode === 'CENTER' ? -(minimum + target.max.toArray()[i]) / 2 : 0 }) as Tuple) }
    }
  }
  if (target instanceof KernelOrientedBoundBox) {
    if (name === 'center') return target.center
    if (name === 'is_outside') { const local = planeCoords(target.plane, args[0], true); return local.toTuple().some((coordinate, i) => Math.abs(coordinate) > target.size.toTuple()[i] / 2 + EPS) }
    if (name === 'is_completely_inside') return target.corners.every(point => !callMethod(args[0], 'is_outside', [point], {}, ctx))
  }
  if (isKernelShape(target)) {
    const shape: any = target.shape
    if (['edges', 'wires', 'faces', 'shells', 'solids', 'vertices'].includes(name)) return topology(target, name, ctx)
    if (['edge', 'wire', 'face', 'shell', 'solid', 'vertex'].includes(name)) { const values = topology(target, `${name === 'vertex' ? 'vertice' : name}s`, ctx); if (values.length !== 1) throw new Error(`Expected one ${name}, found ${values.length}`); return values[0] }
    switch (name) {
      case 'bounding_box': return shapeBounds(target)
      case 'oriented_bounding_box': return new KernelOrientedBoundBox(target, ctx)
      case 'entities': return topology(target, args[0] === 'Vertex' ? 'vertices' : `${String(args[0]).toLowerCase()}s`, ctx)
      case 'get_top_level_shapes': return kernelShapeList(target.children?.length ? target.children : [target])
      case 'compute_volume': return ctx.replicad.measureVolume(shape)
      case 'center': return enumName(arg(0, 'center_of', 'MASS')) === 'BOUNDING_BOX' ? shapeBounds(target).center : shapeCenter(target, ctx)
      case 'copy': { const copied = shape.clone(); return shapeValue(copied, target.kind, { ...target, shape: copied }) }
      case 'clean': { const cleaned = shape.clone().simplify(); return shapeValue(cleaned, target.kind, { ...target, shape: cleaned }) }
      case 'moved': return applyLocation(target, arg(0, 'loc'), ctx)
      case 'located': { const copy = methodCopy(target); setProperty(copy, 'location', arg(0, 'loc'), ctx); return copy }
      case 'move': { const transformed = applyLocation(target, arg(0, 'loc'), ctx); target.shape = transformed.shape; target.children = transformed.children; (target as any).location = (transformed as any).location; return target }
      case 'locate': setProperty(target, 'location', arg(0, 'loc'), ctx); return target
      case 'translate': return applyLocation(target, new KernelLocation(arg(0, 'vector')), ctx)
      case 'rotate': { const axis = arg(0, 'axis'); return applyLocation(target, new KernelLocation(undefined, undefined, axisAngleMatrix(axis.direction, arg(1, 'angle'), axis.position)), ctx) }
      case 'scale': { const factor = arg(0, 'factor'); if (Array.isArray(factor)) return unsupported('nonuniform affine shape scaling'); const scale = (value: KernelShape): KernelShape => { const scaled = value.shape.clone().scale(factor, vectorTuple(arg(1, 'about', [0, 0, 0]))); return shapeValue(scaled, value.kind, { ...value, shape: scaled, children: value.children?.map(scale) }) }; return scale(target) }
      case 'mirror': { const plane = replicadPlane(arg(0, 'mirror_plane', new KernelPlane()), ctx); const mirror = (value: KernelShape): KernelShape => { const mirrored = value.shape.clone().mirror(plane); return shapeValue(mirrored, value.kind, { ...value, shape: mirrored, children: value.children?.map(mirror) }) }; return mirror(target) }
      case 'distance_to': return shapeDistance(target, arg(0, 'other'), ctx)
      case 'distance': return shapeDistance(target, arg(0, 'other'), ctx)
      case 'distances': return args.map(value => shapeDistance(target, value, ctx))
      case 'is_same': return shape.isSame(wrappedShape(args[0]).shape)
      case 'is_equal': return shape.isEqual(wrappedShape(args[0]).shape)
      case 'position_at': return vector(shape.pointAt(arg(0, 'position', 0)))
      case 'positions': return (arg(0, 'distances', [0, 0.25, 0.5, 0.75, 1]) as number[]).map(position => vector(shape.pointAt(position)))
      case 'distribute_locations': { const count = arg(0, 'count'), start = arg(1, 'start', 0), end = arg(2, 'stop', 1), positionsOnly = arg(3, 'positions_only', false); return Array.from({ length: count }, (_, i) => { const u = start + (end - start) * i / Math.max(count - 1, 1), position = vector(shape.pointAt(u)); if (positionsOnly) return new KernelLocation(position); const tangent = vector(shape.tangentAt(u)); return callMethod(new KernelAxis(position, tangent), 'to_location', [], {}, ctx) }) }
      case 'tangent_at': return vector(shape.tangentAt(arg(0, 'position', 0)))
      case 'normal_at': return vector(shape.normalAt(args[0] ? vectorTuple(args[0]) : undefined))
      case 'transformed': return applyLocation(target, new KernelLocation(arg(1, 'offset', [0, 0, 0]), arg(0, 'rotate', [0, 0, 0])), ctx)
      case 'mesh': shape.mesh({ tolerance: arg(0, 'tolerance'), angularTolerance: arg(1, 'angular_tolerance', 0.1) }); return null
      case 'tessellate': { const mesh = shape.mesh({ tolerance: arg(0, 'tolerance'), angularTolerance: arg(1, 'angular_tolerance', 0.1) }); const positions = Array.from({ length: mesh.vertices.length / 3 }, (_, i) => new KernelVector(...mesh.vertices.slice(i * 3, i * 3 + 3) as Tuple)), indices = Array.from({ length: mesh.triangles.length / 3 }, (_, i) => mesh.triangles.slice(i * 3, i * 3 + 3)); return [positions, indices] }
      case 'start_point': return vector(shape.startPoint)
      case 'end_point': return vector(shape.endPoint)
      case 'outer_wire': return shapeValue(shape.clone().outerWire(), 'Wire')
      case 'inner_wires': return kernelShapeList(shape.clone().innerWires().map((wire: any) => shapeValue(wire, 'Wire')))
      case 'close': { const a = vector(shape.startPoint), b = vector(shape.endPoint); if (a.sub(b).length < EPS) return target; const wire = ctx.replicad.assembleWire([shape, ctx.replicad.makeLine(b.toArray(), a.toArray())]); return shapeValue(wire, 'Wire') }
      case 'offset_2d': return offsetShape2D(target, arg(0, 'distance'), enumName(arg(1, 'kind', 'ARC')), enumName(arg(2, 'side', 'BOTH')), arg(3, 'closed', true))
      case 'extrude': return shapeValue(ctx.replicad.basicFaceExtrusion(shape, new ctx.replicad.Vector(vectorTuple(args[0]))), 'Solid')
      case 'fuse': case 'cut': case 'intersect': { let result = shape.clone(); for (const item of shapeList(args)) result = result[name](item.shape); return shapeValue(result) }
      case 'fillet': case 'chamfer': return ctx.invoke(name, [], { objects: args[1] ?? topology(target, 'edges', ctx), [name === 'fillet' ? 'radius' : 'length']: args[0], target })
      case 'split': return ctx.invoke('split', [target], kwargs)
      case 'section': return ctx.invoke('section', [target, ...args], kwargs)
      case 'to_tuple': if (shape.asTuple) return shape.asTuple(); break
      case 'is_inside': { const p = ctx.replicad.makeVertex(vectorTuple(args[0])); try { return ctx.replicad.measureDistanceBetween(shape, p) <= arg(1, 'tolerance', EPS) } finally { p.delete() } }
    }
  }
  if (target?.__cadValue?.endsWith('Joint') && ['connect_to', 'relative_to'].includes(name)) {
    const other = arg(0, 'other')
    if (name === 'relative_to') { const first = target.location instanceof KernelLocation ? target.location : new KernelLocation(), second = other.location instanceof KernelLocation ? other.location : new KernelLocation(); return new KernelLocation(undefined, undefined, multiplyMatrices(first.matrix, inverseRigid(second.matrix))) }
    if (args.length > 1 || Object.keys(kwargs).some(key => key !== 'other')) return unsupported('joint angular and linear motion constraints')
    return target.connect_to(other)
  }
  if (target && typeof target[name] === 'function') { if (Object.keys(kwargs).length) return unsupported(`${target?.kind ?? target?.__cadValue ?? 'value'}.${name} keyword arguments`); return target[name](...args) }
  return unsupported(`${target?.kind ?? target?.__cadValue ?? 'value'}.${name}`)
}

function methodCopy(target: KernelShape) { const copied = target.shape.clone(); return shapeValue(copied, target.kind, { ...target, shape: copied }) }
function combineShapes(a: any, b: any, operation: 'fuse' | 'cut' | 'intersect') { const first = wrappedShape(a); let native: any = first.shape.clone(); for (const other of shapeList(b)) native = native[operation](other.shape); return shapeValue(native, first.kind) }
export function applyOperator(name: string, args: any[], ctx: KernelContext): any {
  const [a, b] = args
  if (typeof a === 'number' && b instanceof KernelVector && ['mul', '*'].includes(name)) return b.multiply(a)
  if (name === 'getitem') return a[typeof b === 'number' && b < 0 ? a.length + b : b]
  if (name === 'setitem') { a[typeof b === 'number' && b < 0 ? a.length + b : b] = args[2]; return null }
  if (name === 'delitem') { if (Array.isArray(a)) a.splice(b, 1); else delete a[b]; return null }
  if (name === 'len') return a instanceof KernelVector ? 3 : a.length ?? Object.keys(a).length
  if (name === 'list') return a instanceof KernelVector ? a.toArray() : a instanceof KernelColor ? a.rgba : Array.from(a)
  if (name === 'iter') return (a instanceof KernelVector ? a.toArray() : a instanceof KernelColor ? a.rgba : a)[Symbol.iterator]()
  if (name === 'next') { const next = a.next(); if (next.done) { if (args.length > 1) return b; throw new Error('Iterator exhausted') } return next.value }
  if (name === 'reversed') return Array.from(a).reverse()
  if (name === 'contains') return a.includes ? a.includes(b) : b in a
  if (name === 'bool') return isKernelShape(a) ? !a.shape.isNull : Boolean(a) && (!Array.isArray(a) || a.length > 0)
  if (name === 'int') return Math.trunc(Number(a))
  if (name === 'float') return Number(a)
  if (name === 'round') { const factor = Math.pow(10, b ?? 0); if (a instanceof KernelVector) return new KernelVector(...a.toArray().map(v => Math.round(v * factor) / factor) as Tuple); return Math.round(a * factor) / factor }
  if (a instanceof KernelVector) {
    if (['add', '+'].includes(name)) return a.add(b)
    if (['sub', '-'].includes(name)) return a.sub(b)
    if (['mul', '*'].includes(name)) return typeof b === 'number' ? a.multiply(b) : a.dot(b)
    if (['truediv', 'div', '/'].includes(name)) return a.multiply(1 / b)
    if (['neg', 'invert'].includes(name)) return a.multiply(-1)
    if (name === 'abs') return a.length
    if (name === 'pos') return a
    if (['eq', 'equal', '==', 'ne', '!='].includes(name)) { const same = a.sub(b).length < EPS; return ['ne', '!='].includes(name) ? !same : same }
  }
  if (a instanceof KernelLocation) {
    if (['mul', '*'].includes(name)) { if (b instanceof KernelLocation) return new KernelLocation(undefined, undefined, multiplyMatrices(a.matrix, b.matrix)); if (isKernelShape(b)) return applyLocation(b, a, ctx); if (Array.isArray(b) && !b.every(value => typeof value === 'number')) return b.map(value => applyOperator('mul', [a, value], ctx)); return transformPoint(a.matrix, b) }
    if (['pow', '**'].includes(name)) { if (!Number.isInteger(b)) throw new Error('Location powers must be integers'); let output = new KernelLocation(), base = b < 0 ? new KernelLocation(undefined, undefined, inverseRigid(a.matrix)) : a; for (let i = 0; i < Math.abs(b); i++) output = applyOperator('mul', [output, base], ctx); return output }
    if (name === 'invert') return new KernelLocation(undefined, undefined, inverseRigid(a.matrix))
  }
  if (a instanceof KernelPlane && ['mul', '*'].includes(name)) return isKernelShape(b) ? applyLocation(b, a.location, ctx) : planeCoords(a, b, false)
  if (isKernelShape(a)) {
    if (['add', '+', 'or', '|'].includes(name)) return combineShapes(a, b, 'fuse')
    if (['sub', '-'].includes(name)) return combineShapes(a, b, 'cut')
    if (['and', '&'].includes(name)) return combineShapes(a, b, 'intersect')
    if (['mul', '*'].includes(name) && b instanceof KernelLocation) return applyLocation(a, b, ctx)
    if (['matmul', '@'].includes(name)) return callMethod(a, 'position_at', [b], {}, ctx)
    if (['mod', '%'].includes(name)) return callMethod(a, 'tangent_at', [b], {}, ctx)
    if (['eq', 'equal', '==', 'ne', '!='].includes(name)) { const same = isKernelShape(b) && a.shape.isSame(b.shape); return ['ne', '!='].includes(name) ? !same : same }
  }
  if (Array.isArray(a)) {
    if (['add', '+'].includes(name)) return [...a, ...b]
    if (['sub', '-'].includes(name)) return a.filter(value => !b.some((other: any) => value === other || isKernelShape(value) && isKernelShape(other) && value.shape.isSame(other.shape)))
    if (['and', '&'].includes(name) && Array.isArray(b)) return kernelShapeList(a.filter(value => b.some(other => value === other || isKernelShape(value) && isKernelShape(other) && value.shape.isSame(other.shape))))
    if (['or', '|'].includes(name) && Array.isArray(b)) return kernelShapeList([...a, ...b.filter(other => !a.some(value => value === other || isKernelShape(value) && isKernelShape(other) && value.shape.isSame(other.shape)))])
    if (['or', '|', 'mod', '%'].includes(name)) return callMethod(a, 'filter_by', [b], {}, ctx)
    if (['gt', '>'].includes(name)) return callMethod(a, 'sort_by', [b], {}, ctx)
    if (['lt', '<'].includes(name)) return callMethod(a, 'sort_by', [b], { reverse: true }, ctx)
    if (['lshift', '<<'].includes(name)) return callMethod(a, 'group_by', [b], {}, ctx)
    if (['rshift', '>>'].includes(name)) return callMethod(a, 'group_by', [b], { reverse: true }, ctx)
  }
  switch (name) {
    case 'add': case '+': return a + b
    case 'sub': case '-': return a - b
    case 'mul': case '*': return a * b
    case 'truediv': case 'div': case '/': return a / b
    case 'floordiv': case '//': return Math.floor(a / b)
    case 'mod': case '%': return ((a % b) + b) % b
    case 'pow': case '**': return a ** b
    case 'neg': return -a
    case 'pos': return +a
    case 'invert': return ~a
    case 'abs': return Math.abs(a)
    case 'and': case '&': return a & b
    case 'or': case '|': return a | b
    case 'xor': case '^': return a ^ b
    case 'lshift': case '<<': return a << b
    case 'rshift': case '>>': return a >> b
    case 'eq': case 'equal': case '==': return a === b
    case 'ne': case '!=': return a !== b
    case 'lt': case '<': return a < b
    case 'le': case '<=': return a <= b
    case 'gt': case '>': return a > b
    case 'ge': case '>=': return a >= b
    case 'divmod': return [Math.floor(a / b), ((a % b) + b) % b]
    default: return unsupported(`operator ${name}`)
  }
}

function jointHandler(kind: string): KernelHandler {
  return (args, kwargs) => {
    const label = param(args, kwargs, 0, 'label'), parent = param(args, kwargs, 1, 'to_part'), location = param(args, kwargs, 2, 'joint_location', new KernelLocation())
    const joint: any = { __cadValue: kind, label, parent, location, relative_to: null, connected_to: null }
    if (parent) { (parent as any).joints ??= {}; (parent as any).joints[label] = joint }
    return joint
  }
}

/** Registry for value classes and explicit topology factories. */
export function registerValues(ctx: KernelContext): Record<string, KernelHandler> {
  const r = ctx.replicad
  const handlers: Record<string, KernelHandler> = {
    Vector: (a, k) => a.length > 1 || 'X' in k || 'Y' in k || 'Z' in k ? new KernelVector(param(a, k, 0, 'X', 0), param(a, k, 1, 'Y', 0), param(a, k, 2, 'Z', 0)) : vector(param(a, k, 0, 'v', [0, 0, 0])),
    Axis: (a, k) => new KernelAxis(param(a, k, 0, 'origin', k.position ?? [0, 0, 0]), param(a, k, 1, 'direction', [0, 0, 1])),
    Plane: (a, k) => { const input = param(a, k, 0, 'origin', [0, 0, 0]); if (input instanceof KernelPlane) return new KernelPlane(input.origin, input.x_dir, input.z_dir); if (isKernelShape(input)) { const normal = vector((input.shape as any).normalAt()); const x = Math.abs(normal.X) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return new KernelPlane(shapeCenter(input, ctx), x, normal) } return new KernelPlane(input, param(a, k, 1, 'x_dir', [1, 0, 0]), param(a, k, 2, 'z_dir', [0, 0, 1])) },
    Location: (a, k) => { const input = param(a, k, 0, 'position', [0, 0, 0]); if (input instanceof KernelLocation) return new KernelLocation(undefined, undefined, input.matrix.map(row => [...row])); if (input instanceof KernelPlane) return input.location; if (a.length >= 3 || 'angle' in k) { const matrix = axisAngleMatrix(param(a, k, 1, 'axis', [0, 0, 1]), param(a, k, 2, 'angle', 0)); vectorTuple(input).forEach((coordinate, i) => { matrix[i][3] = coordinate }); return new KernelLocation(undefined, undefined, matrix) } return new KernelLocation(input, param(a, k, 1, 'orientation', [0, 0, 0])) },
    Pos: (a, k) => new KernelLocation(a.length === 1 && typeof a[0] !== 'number' ? a[0] : [param(a, k, 0, 'X', k.x ?? 0), param(a, k, 1, 'Y', k.y ?? 0), param(a, k, 2, 'Z', k.z ?? 0)]),
    Rot: (a, k) => new KernelLocation([0, 0, 0], a.length === 1 && typeof a[0] !== 'number' ? a[0] : [param(a, k, 0, 'X', k.x ?? 0), param(a, k, 1, 'Y', k.y ?? 0), param(a, k, 2, 'Z', k.z ?? 0)]),
    Rotation: (a, k) => new KernelLocation([0, 0, 0], a.length === 1 && typeof a[0] !== 'number' ? a[0] : [param(a, k, 0, 'X', 0), param(a, k, 1, 'Y', 0), param(a, k, 2, 'Z', 0)]),
    Matrix: (a, k) => new KernelMatrix(param(a, k, 0, 'matrix')),
    Color: (a, k) => new KernelColor(param(a, k, 0, 'red', k.color ?? 'white'), param(a, k, 1, 'green'), param(a, k, 2, 'blue'), param(a, k, 3, 'alpha', 1)),
    'Color.categorical_set': (a, k) => Array.from({ length: param(a, k, 0, 'color_count', 12) }, (_, index) => { const color = new ThreeColor().setHSL(index * 0.61803398875 % 1, 0.65, 0.55); return new KernelColor(color.getHex()) }),
    BoundBox: (a, k) => { const shape = param(a, k, 0, 'bb'); return isKernelShape(shape) ? shapeBounds(shape) : new KernelBoundBox(shape?.min ?? k.min, shape?.max ?? k.max) },
    OrientedBoundBox: (a, k) => new KernelOrientedBoundBox(wrappedShape(param(a, k, 0, 'shape')), ctx),
    'BoundBox.from_topo_ds': a => shapeBounds(wrappedShape(a[0])),
    'BoundBox.find_outside_box_2d': (a, k) => { const first = param(a, k, 0, 'bb1'), second = param(a, k, 1, 'bb2'); const includes = (outer: KernelBoundBox, inner: KernelBoundBox) => outer.min.X <= inner.min.X && outer.max.X >= inner.max.X && outer.min.Y <= inner.min.Y && outer.max.Y >= inner.max.Y; return includes(first, second) ? first : includes(second, first) ? second : null },
    ShapeList: (a, k) => kernelShapeList(Array.from(param(a, k, 0, 'iterable', []))),
    topo_distance_to: (a, k) => { const other = param(a, k, 0, 'other'); return (shape: any) => Array.isArray(other) ? Math.min(...other.map(value => shapeDistance(shape, value, ctx))) : shapeDistance(shape, other, ctx) },
    polar: (a, k) => { const length = param(a, k, 0, 'length'), angle = radians(param(a, k, 1, 'angle')); return [length * Math.cos(angle), length * Math.sin(angle)] },
    project_workplane: (a, k) => { if (ctx.current() && ctx.current()?.kind !== 'BuildPart') throw new Error('project_workplane requires algebra or BuildPart context'); const input = param(a, k, 0, 'origin'), origin = isKernelShape(input) ? shapeCenter(input, ctx) : vector(input), x = normalize(param(a, k, 1, 'x_dir')), normal = normalize(param(a, k, 2, 'projection_dir')); return new KernelPlane(origin.add(normal.multiply(param(a, k, 3, 'distance'))), x, normal) },
    delta: (a, k) => { const first = shapeList(param(a, k, 0, 'shapes_one')), second = shapeList(param(a, k, 1, 'shapes_two')); return first.filter(shape => !second.some(other => shape.shape.isSame(other.shape))) },
    'Edge.make_line': (a, k) => shapeValue(r.makeLine(vectorTuple(param(a, k, 0, 'point1')), vectorTuple(param(a, k, 1, 'point2'))), 'Edge'),
    'Edge.make_circle': (a, k) => { const plane = param(a, k, 1, 'plane', new KernelPlane()); const radius = param(a, k, 0, 'radius'), start = param(a, k, 2, 'start_angle', 0), end = param(a, k, 3, 'end_angle', 360); if (Math.abs(end - start) >= 360 - EPS) return shapeValue(r.makeCircle(radius, vectorTuple(plane.origin), vectorTuple(plane.z_dir)), 'Edge'); return ctx.invoke('CenterArc', [vectorTuple(plane.origin), radius, start, end - start]) },
    'Edge.make_ellipse': (a, k) => { const plane = param(a, k, 2, 'plane', new KernelPlane()); return shapeValue(r.makeEllipse(param(a, k, 0, 'x_radius'), param(a, k, 1, 'y_radius'), vectorTuple(plane.origin), vectorTuple(plane.z_dir), vectorTuple(plane.x_dir)), 'Edge') },
    'Edge.make_bezier': (a, k) => shapeValue(r.makeBezierCurve(param(a, k, 0, 'points').map(vectorTuple)), 'Edge'),
    'Edge.make_spline': (a, k) => ctx.invoke('Spline', param(a, k, 0, 'points'), { ...k, mode: 'PRIVATE' }),
    'Edge.make_bspline': (a, k) => ctx.invoke('BSpline', a, k),
    'Edge.make_spline_approx': (a, k) => shapeValue(r.makeBSplineApproximation(param(a, k, 0, 'points').map(vectorTuple), { tolerance: k.tol ?? 1e-3, degMin: k.min_deg, degMax: k.max_deg }), 'Edge'),
    'Edge.make_three_point_arc': (a, k) => shapeValue(r.makeThreePointArc(vectorTuple(param(a, k, 0, 'point1')), vectorTuple(param(a, k, 1, 'point2')), vectorTuple(param(a, k, 2, 'point3'))), 'Edge'),
    'Edge.make_tangent_arc': (a, k) => shapeValue(r.makeTangentArc(vectorTuple(param(a, k, 0, 'start')), vectorTuple(param(a, k, 1, 'tangent')), vectorTuple(param(a, k, 2, 'end'))), 'Edge'),
    'Edge.make_helix': (a, k) => shapeValue(r.makeHelix(param(a, k, 0, 'pitch'), param(a, k, 1, 'height'), param(a, k, 2, 'radius'), vectorTuple(param(a, k, 3, 'center', [0, 0, 0])), vectorTuple(param(a, k, 4, 'normal', [0, 0, 1])), param(a, k, 6, 'lefthand', false)), 'Wire'),
    'Wire.make_wire': (a, k) => shapeValue(r.assembleWire(shapeList(param(a, k, 0, 'edges')).map(value => value.shape as any)), 'Wire'),
    'Wire.combine': (a, k) => [shapeValue(r.assembleWire(shapeList(param(a, k, 0, 'wires')).flatMap(value => value.shape instanceof r.Edge ? [value.shape] : value.shape.edges)), 'Wire')],
    'Wire.make_polygon': (a, k) => { const points = param(a, k, 0, 'vertices').map(vectorTuple), close = param(a, k, 1, 'close', true); const edges = points.slice(1).map((point: Tuple, i: number) => r.makeLine(points[i], point)); if (close && vector(points[0]).sub(points.at(-1)).length > EPS) edges.push(r.makeLine(points.at(-1), points[0])); return shapeValue(r.assembleWire(edges), 'Wire') },
    'Wire.make_circle': (a, k) => shapeValue(r.assembleWire([handlers['Edge.make_circle'](a, k, ctx).shape]), 'Wire'),
    'Wire.make_ellipse': (a, k) => shapeValue(r.assembleWire([handlers['Edge.make_ellipse'](a, k, ctx).shape]), 'Wire'),
    'Face.make_face': (a, k) => shapeValue(r.makeFace(wrappedShape(param(a, k, 0, 'outer_wire')).shape as any, shapeList(param(a, k, 1, 'inner_wires', [])).map(value => value.shape as any)), 'Face'),
    'Face.make_rect': (a, k) => { const width = param(a, k, 0, 'width'), height = param(a, k, 1, 'height'), plane = param(a, k, 2, 'plane', new KernelPlane()); return shapeValue((r.drawRectangle(width, height).sketchOnPlane(replicadPlane(plane, ctx)) as any).face(), 'Face') },
    'Solid.make_box': (a, k) => { const plane = param(a, k, 3, 'plane', new KernelPlane()); return applyLocation(shapeValue(r.makeBox([0, 0, 0], [param(a, k, 0, 'length'), param(a, k, 1, 'width'), param(a, k, 2, 'height')]), 'Solid'), plane.location, ctx) },
    'Solid.make_cylinder': (a, k) => { const plane = param(a, k, 2, 'plane', new KernelPlane()); return applyLocation(ctx.invoke('Cylinder', [], { radius: param(a, k, 0, 'radius'), height: param(a, k, 1, 'height'), arc_size: param(a, k, 3, 'angle', 360), align: null }), plane.location, ctx) },
    'Solid.make_sphere': (a, k) => { const plane = param(a, k, 1, 'plane', new KernelPlane()); return applyLocation(ctx.invoke('Sphere', [], { radius: param(a, k, 0, 'radius'), arc_size1: param(a, k, 2, 'angle1', -90), arc_size2: param(a, k, 3, 'angle2', 90), arc_size3: param(a, k, 4, 'angle3', 360), align: null }), plane.location, ctx) },
    'Solid.make_cone': (a, k) => { const plane = param(a, k, 3, 'plane', new KernelPlane()); return applyLocation(ctx.invoke('Cone', [], { bottom_radius: param(a, k, 0, 'base_radius'), top_radius: param(a, k, 1, 'top_radius'), height: param(a, k, 2, 'height'), arc_size: param(a, k, 4, 'angle', 360), align: null }), plane.location, ctx) },
    'Solid.make_torus': (a, k) => { const plane = param(a, k, 2, 'plane', new KernelPlane()); return applyLocation(ctx.invoke('Torus', [], { major_radius: param(a, k, 0, 'major_radius'), minor_radius: param(a, k, 1, 'minor_radius'), minor_start_angle: param(a, k, 3, 'start_angle', 0), minor_end_angle: param(a, k, 4, 'end_angle', 360), major_angle: param(a, k, 5, 'major_angle', 360), align: null }), plane.location, ctx) },
    'Shell.make_shell': (a, k) => shapeValue(r.weldShellsAndFaces(shapeList(param(a, k, 0, 'faces')).map(value => value.shape as any)), 'Shell'),
    'Compound.make_compound': (a, k) => { const children = shapeList(param(a, k, 0, 'shapes')); return shapeValue(r.makeCompound(children.map(value => value.shape.clone())), 'Compound', { children }) },
    'Solid.make_solid': (a, k) => shapeValue(r.makeSolid(shapeList(param(a, k, 0, 'shell')).map(value => value.shape as any)), 'Solid'),
    edges_to_wires: (a, k) => [shapeValue(r.assembleWire(shapeList(param(a, k, 0, 'edges')).map(value => value.shape as any)), 'Wire')],
    new_edges: (a, k) => {
      const originals = shapeList(a).flatMap(shape => topology(shape, 'edges', ctx)), combined = wrappedShape(k.combined), edges = topology(combined, 'edges', ctx)
      if (!originals.length) return edges
      const source = r.makeCompound(edges.map(value => value.shape.clone())), tools = r.makeCompound(originals.map(value => value.shape.clone())), operation = new ctx.oc.BRepAlgoAPI_Cut(source.wrapped, tools.wrapped)
      try { const result = r.cast(operation.Shape()); return kernelShapeList(result.edges.map(edge => Object.assign(shapeValue(edge, 'Edge'), { owner: combined }))) } finally { operation.delete(); source.delete(); tools.delete() }
    },
    available_fonts: () => ['DejaVu Sans'],
    FontManager: () => ({ __cadValue: 'FontManager', get_font_list: () => ['DejaVu Sans'], available_fonts: () => ['DejaVu Sans'] }),
    'FontManager.get_font_list': () => ['DejaVu Sans'],
    GeomEncoder: () => ({ __cadValue: 'GeomEncoder', encode: (value: any) => JSON.stringify(value, (key, entry) => key.startsWith('_') ? undefined : entry) }),
  }
  handlers.Locations = (a, k) => {
    const input = a.length ? a : k.locations ?? [], points = input.length === 1 && Array.isArray(input[0]) && !input[0].every((value: any) => typeof value === 'number') ? input[0] : input
    return { __cadValue: 'Locations', locations: points.map((point: any) => point instanceof KernelLocation ? point : point instanceof KernelPlane ? point.location : point instanceof KernelAxis ? callMethod(point, 'to_location', [], {}, ctx) : isKernelShape(point) ? new KernelLocation(shapeCenter(point, ctx)) : new KernelLocation(point)) }
  }
  handlers.GridLocations = (a, k) => {
    const dx = param(a, k, 0, 'x_spacing'), dy = param(a, k, 1, 'y_spacing'), nx = param(a, k, 2, 'x_count'), ny = param(a, k, 3, 'y_count'), align = param(a, k, 4, 'align', ['CENTER', 'CENTER'])
    const shift = (length: number, i: number) => enumName(Array.isArray(align) ? align[i] : align) === 'MIN' ? 0 : enumName(Array.isArray(align) ? align[i] : align) === 'MAX' ? -length : -length / 2
    const locations: KernelLocation[] = []
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) locations.push(new KernelLocation([x * dx + shift((nx - 1) * dx, 0), y * dy + shift((ny - 1) * dy, 1), 0]))
    return { __cadValue: 'GridLocations', locations }
  }
  handlers.PolarLocations = (a, k) => {
    const radius = param(a, k, 0, 'radius'), count = param(a, k, 1, 'count'), start = param(a, k, 2, 'start_angle', 0), sweep = param(a, k, 3, 'angular_range', 360), rotate = param(a, k, 4, 'rotate', true), endpoint = param(a, k, 5, 'endpoint', false)
    if (!Number.isInteger(count) || count < 1) throw new Error('At least one location is required')
    return { __cadValue: 'PolarLocations', locations: Array.from({ length: count }, (_, i) => { const angle = start + sweep * i / Math.max(count - (endpoint ? 1 : 0), 1); return new KernelLocation([radius * Math.cos(radians(angle)), radius * Math.sin(radians(angle)), 0], [0, 0, rotate ? angle : 0]) }) }
  }
  handlers.HexLocations = (a, k) => {
    const radius = param(a, k, 0, 'radius'), nx = param(a, k, 1, 'x_count'), ny = param(a, k, 2, 'y_count'), major = param(a, k, 3, 'major_radius', false), align = param(a, k, 4, 'align', ['CENTER', 'CENTER']), diagonal = major ? 2 * radius : 4 * radius / Math.sqrt(3), apothem = major ? radius * Math.cos(Math.PI / 6) : radius, dx = 3 * diagonal / 4, dy = diagonal * Math.sqrt(3) / 2
    if (!(radius > 0) || !Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1) throw new Error('Hex spacing and counts must be greater than zero')
    const points: Tuple[] = []
    for (const parity of [0, 1]) for (let x = parity; x < nx; x += 2) for (let y = 0; y < ny; y++) points.push([dx * x, dy * y + dy * (parity ? 1 : 0.5), 0])
    const minimum = [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))], size = [Math.max(...points.map(point => point[0])) - minimum[0], Math.max(...points.map(point => point[1])) - minimum[1]]
    const locations = points.map(point => new KernelLocation(point.map((coordinate, i) => { if (i === 2) return 0; const mode = enumName(Array.isArray(align) ? align[i] : align); return coordinate - minimum[i] + (mode === 'MIN' ? 0 : mode === 'MAX' ? -size[i] : -size[i] / 2) })))
    return { __cadValue: 'HexLocations', locations, radius, apothem, diagonal, x_count: nx, y_count: ny, major_radius: major, align }
  }
  for (const name of ['BuildPart', 'BuildSketch', 'BuildLine'] as const) handlers[name] = (a, k) => ({ __cadValue: name, kind: name, shape: null, pending: [], plane: a[0] ?? k.workplane ?? k.workplanes?.[0] ?? new KernelPlane(), locations: [], mode: k.mode ?? 'ADD' })
  handlers.DraftAngleError = a => Object.assign(new Error(a[0] ?? 'Unable to apply draft angle'), { __cadValue: 'DraftAngleError' })
  handlers.topo_explore_common_vertex = (a, k) => {
    const first = topology(wrappedShape(param(a, k, 0, 'edge1')), 'vertices', ctx), second = topology(wrappedShape(param(a, k, 1, 'edge2')), 'vertices', ctx)
    return first.find(vertex => second.some(other => vertex.shape.isSame(other.shape) || shapeDistance(vertex, other, ctx) < EPS)) ?? null
  }
  handlers.topo_explore_connected_edges = (a, k) => {
    const edge = wrappedShape(param(a, k, 0, 'edge')), parent = param(a, k, 1, 'parent', (edge as any).owner)
    if (!parent) throw new Error('Connected-edge exploration requires a parent shape')
    if (enumName(param(a, k, 2, 'continuity', 'C0')) !== 'C0') return unsupported('connected-edge continuity beyond C0')
    return kernelShapeList(topology(wrappedShape(parent), 'edges', ctx).filter(other => !other.shape.isSame(edge.shape) && handlers.topo_explore_common_vertex([edge, other], {}, ctx)))
  }
  const axes: Record<string, Tuple> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }
  for (const [name, direction] of Object.entries(axes)) handlers[`Axis.${name}`] = () => new KernelAxis([0, 0, 0], direction)
  const planes: Record<string, [Tuple, Tuple]> = { XY: [[1, 0, 0], [0, 0, 1]], XZ: [[1, 0, 0], [0, -1, 0]], YZ: [[0, 1, 0], [1, 0, 0]], ZX: [[0, 0, 1], [0, 1, 0]], YX: [[0, 1, 0], [0, 0, -1]], ZY: [[0, 0, 1], [-1, 0, 0]], front: [[1, 0, 0], [0, -1, 0]], back: [[-1, 0, 0], [0, 1, 0]], left: [[0, -1, 0], [-1, 0, 0]], right: [[0, 1, 0], [1, 0, 0]], top: [[1, 0, 0], [0, 0, 1]], bottom: [[1, 0, 0], [0, 0, -1]] }
  for (const [name, [x, z]] of Object.entries(planes)) handlers[`Plane.${name}`] = () => new KernelPlane([0, 0, 0], x, z)
  for (const name of ['solids', 'faces', 'wires', 'edges', 'vertices', 'shells']) handlers[name] = () => { const current = ctx.current(); return current?.shape ? topology(current.shape, name, ctx) : current?.pending.flatMap(shape => topology(shape, name, ctx)) ?? [] }
  for (const name of ['solid', 'face', 'wire', 'edge', 'vertex', 'shell']) handlers[name] = () => { const shapes = handlers[name === 'vertex' ? 'vertices' : `${name}s`]([], {}, ctx); if (shapes.length !== 1) throw new Error(`Expected one ${name}, found ${shapes.length}`); return shapes[0] }
  for (const name of ['Joint', 'RigidJoint', 'RevoluteJoint', 'LinearJoint', 'CylindricalJoint', 'BallJoint']) {
    const handler = jointHandler(name)
    handlers[name] = (a, k) => { const joint = handler(a, k, ctx); joint.connect_to = (other: any) => { const first = joint.location instanceof KernelLocation ? joint.location : new KernelLocation(), second = other.location instanceof KernelLocation ? other.location : new KernelLocation(); const transformed = applyLocation(wrappedShape(other.parent), new KernelLocation(undefined, undefined, multiplyMatrices(first.matrix, inverseRigid(second.matrix))), ctx); other.parent.shape = transformed.shape; joint.connected_to = other; other.connected_to = joint; return null }; return joint }
  }
  return handlers
}
