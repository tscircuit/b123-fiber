import { initializeOpenCascade, type KernelOptions } from './runtime'
import { registerGeometry, meshShape, unionShapes, transformShape, isEmptyShape } from './geometry'
import { registerSketches } from './sketches'
import { registerValues, getProperty, setProperty, callMethod, applyOperator, applyLocation, KernelPlane } from './values'
import { KernelFileStore, registerFileHandlers, BrowserStream, callFileMethod } from './files'
import { isKernelShape, shapeList, shapeKind, type BuilderState, type KernelContext, type KernelShape } from './types'
import { values } from '../generated/values'
import { build123dVersion, publicSymbols, symbolKinds } from '../generated/symbols'
import { base64Bytes, bytesBase64 } from '../files'
import type { RpcRequest } from '../client'
import type { Build123dPlan, PlanNode, RenderOptions, RenderResult } from '../types'

export type BrowserKernelOptions = KernelOptions
export { initializeOpenCascade } from './runtime'
export type { KernelOptions } from './runtime'

const metadata = new Set(['args', 'color', 'position', 'name', 'ref', 'id', 'children'])
const childOperands: Record<string, string> = {
  extrude: 'to_extrude', revolve: 'profiles', loft: 'sections', sweep: 'sections', thicken: 'to_thicken',
  fillet: 'objects', chamfer: 'objects', offset: 'objects', mirror: 'objects', scale: 'objects', split: 'objects',
  make_face: 'edges', make_hull: 'edges', trace: 'lines', add: 'objects', insert: 'objects', section: 'obj',
  project: 'objects', draft: 'faces', full_round: 'edge', make_brake_formed: 'line', bounding_box: 'objects',
  pack: 'objects', edges_to_wires: 'edges',
}
const replacementOperations = new Set(['fillet', 'chamfer', 'offset', 'scale', 'split', 'draft', 'full_round'])
const localPartObjects = new Set(['BasePartObject', 'ConvexPolyhedron', 'Box', 'Cylinder', 'Cone', 'Sphere', 'Torus', 'Wedge', 'Hole', 'CounterBoreHole', 'CounterSinkHole'])
// Positional mode slots follow the checked-in build123d 0.13 signatures.
const modeArgument: Record<string, number> = {
  BuildLine: 1, BaseCurveObject: 1, BaseEdgeObject: 1, BaseLineObject: 1,
  Airfoil: 3, BlendCurve: 5, BSpline: 5, CenterArc: 4, DoubleTangentArc: 4,
  Helix: 7, IntersectingLine: 3, PolarLine: 5, RadiusArc: 4, SagittaArc: 3, JernArc: 4,
  ArrowHead: 3, Arrow: 5, BaseSketchObject: 3, Circle: 3, DimensionLine: 7,
  Ellipse: 4, ExtensionLine: 9, Rectangle: 4, RectangleRounded: 5, RegularPolygon: 5,
  SlotArc: 3, SlotCenterPoint: 4, SlotCenterToCenter: 3, SlotOverall: 4,
  Superellipse: 6, Text: 11, TechnicalDrawing: 10, Trapezoid: 6, BasePartObject: 3,
  Box: 5, Cone: 6, ConvexPolyhedron: 3, CounterBoreHole: 4, CounterSinkHole: 4,
  Cylinder: 5, Hole: 2, Sphere: 6, Torus: 7, Wedge: 9, add: 3, insert: 3,
  bounding_box: 1, extrude: 8, full_round: 3, loft: 3, make_brake_formed: 6,
  make_face: 1, make_hull: 1, mirror: 2, offset: 7, project: 3, revolve: 4,
  scale: 3, section: 4, split: 3, sweep: 8, thicken: 5, trace: 2,
}
function dimension(shape: KernelShape): number {
  const native: any = shape.shape
  // Operation labels describe the API result, not necessarily its topology.
  // In particular generic mirror/split also accept faces and curves.
  const kind = shapeKind(native)
  if (kind === 'Solid' || kind === 'CompSolid') return 3
  if (kind === 'Face' || kind === 'Shell') return 2
  if (kind === 'Vertex') return 0
  if (kind === 'Compound') return native.solids?.length ? 3 : native.faces?.length ? 2 : native.edges?.length ? 1 : 0
  return 1
}
const enumName = (value: any) => typeof value === 'string' ? value.split('.').at(-1)! : value?.value ?? value?.name ?? String(value)
function publicMember(name: string) {
  if (typeof name !== 'string' || !name || name.startsWith('_') || ['constructor', 'prototype', '__proto__'].includes(name)) throw new TypeError(`Member ${JSON.stringify(name)} is not public`)
}

/** A local OpenCascade WASM instance with serializable build123d-compatible bindings. */
export class BrowserKernel {
  readonly context: KernelContext
  readonly files: KernelFileStore
  private sequence = 0
  private retained = new WeakMap<object, string>()

  static async create(options: BrowserKernelOptions = {}): Promise<BrowserKernel> {
    const runtime = await initializeOpenCascade(options)
    return new BrowserKernel(runtime)
  }

  private constructor(runtime: Awaited<ReturnType<typeof initializeOpenCascade>>) {
    this.context = {
      ...runtime, handlers: {}, references: new Map(), builders: [],
      current: () => this.context.builders.at(-1),
      invoke: (name, args = [], kwargs = {}) => this.invoke(name, args, kwargs),
      decode: (value, env) => this.decode(value, env),
      encode: value => this.encode(value),
      render: (plan, options) => this.render(plan, options),
      evaluatePlan: plan => this.evaluatePlan(plan),
    }
    Object.assign(this.context.handlers, registerValues(this.context), registerGeometry(this.context), registerSketches(this.context))
    this.files = new KernelFileStore(this.context)
    Object.assign(this.context.handlers, registerFileHandlers(this.context, this.files))
    for (const name of ['vertices', 'edges', 'wires', 'faces', 'solids']) this.context.handlers[name] = (args, kwargs) => {
      const target = args[0] ?? kwargs.obj ?? this.context.current()?.shape ?? this.context.current()?.pending
      return callMethod(target, name, [], {}, this.context)
    }
  }

  inventory() {
    const callable = publicSymbols.filter(name => !!this.context.handlers[name])
    const declarative = publicSymbols.filter(name => ['BuildPart', 'BuildSketch', 'BuildLine', 'Locations', 'GridLocations', 'PolarLocations', 'HexLocations'].includes(name))
    const supported = publicSymbols.filter(name => symbolKinds[name] === 'enum' || symbolKinds[name] === 'constant' || callable.includes(name) || declarative.includes(name))
    return {
      version: build123dVersion, engine: 'OpenCascade WebAssembly', exports: [...publicSymbols], supported,
      callable, declarative, unsupported: publicSymbols.filter(name => !supported.includes(name)),
      partial: supported.filter(name => symbolKinds[name] === 'class' || symbolKinds[name] === 'function'),
      compatibility: 'Supported lists available entry points. Signatures and members are partially implemented; unsupported operations and options throw explicit errors.',
    }
  }

  private invoke(name: string, args: any[] = [], kwargs: Record<string, any> = {}): any {
    this.context.replicad.setOC(this.context.oc)
    const handler = this.context.handlers[name]
    if (handler) {
      const suppliedMode = kwargs.mode ?? (modeArgument[name] === undefined ? undefined : args[modeArgument[name]!])
      const mode = suppliedMode === undefined ? undefined : enumName(suppliedMode)
      if (mode && !['ADD', 'SUBTRACT', 'INTERSECT', 'REPLACE', 'PRIVATE'].includes(mode)) throw new TypeError(`Unsupported combination mode ${mode}`)
      const result = handler(args, kwargs, this.context)
      if (mode && isKernelShape(result)) return { ...result, mode }
      if (mode && Array.isArray(result)) return result.map(value => isKernelShape(value) ? { ...value, mode } : value)
      return result
    }
    throw new TypeError(`The browser kernel does not implement ${name}`)
  }

  private resolve(name: string): any {
    const handler = this.context.handlers[name]
    if (handler && /^(Axis|Plane)\./.test(name)) return handler([], {}, this.context)
    if (name.includes('.') && Object.hasOwn(this.context.handlers, name)) return Object.assign((...args: any[]) => this.invoke(name, args), { __cadType: name })
    const [root, ...path] = name.split('.')
    const value = (values as Record<string, any>)[root!]
    if (path.length && value && typeof value !== 'function') {
      let result = value
      for (const member of path) { publicMember(member); result = result?.[member] }
      if (result?.$enum) return result.$enum
      if (result !== undefined) return this.decode(result)
    }
    if (path.length && this.context.handlers[name]) return this.context.handlers[name]!([], {}, this.context)
    if (!path.length && value !== undefined && typeof value !== 'function' && value?.$type !== name) return this.decode(value)
    if (this.context.handlers[name]) return Object.assign((...args: any[]) => this.invoke(name, args), { __cadType: name })
    if (path.length) throw new TypeError(`Unknown or unsupported build123d member ${name}`)
    throw new TypeError(`Unknown or unsupported build123d symbol ${name}`)
  }

  private property(target: any, name: string): any {
    publicMember(name)
    if (target?.__cadType) return this.resolve(`${target.__cadType}.${name}`)
    return getProperty(target, name, this.context)
  }

  private method(target: any, name: string, args: any[] = [], kwargs: Record<string, any> = {}): any {
    publicMember(name)
    if (target?.__cadType) return this.invoke(`${target.__cadType}.${name}`, args, kwargs)
    const fileResult = callFileMethod(target, name, args, kwargs)
    if (fileResult.handled) return fileResult.value
    if (target instanceof BrowserStream) {
      const method = (target as any)[name]
      if (typeof method !== 'function') throw new TypeError(`Stream has no method ${name}`)
      return method.apply(target, args)
    }
    return callMethod(target, name, args, kwargs, this.context)
  }

  private index(target: any, index: any): any {
    if (index?.$slice) {
      const [start, stop, suppliedStep] = index.$slice
      const step = suppliedStep ?? 1, length = target.length
      if (!Number.isInteger(step) || !step) throw new RangeError('Slice step must be a nonzero integer')
      const normalize = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n < 0 ? n + length : n))
      let i = start == null ? step > 0 ? 0 : length - 1 : normalize(start, step > 0 ? 0 : -1, step > 0 ? length : length - 1)
      const end = stop == null ? step > 0 ? length : -1 : normalize(stop, step > 0 ? 0 : -1, step > 0 ? length : length - 1)
      const output: any[] = []
      for (; step > 0 ? i < end : i > end; i += step) output.push(target[i])
      return target.__cadValue === 'ShapeList' ? this.invoke('ShapeList', [output]) : output
    }
    const resolved = typeof index === 'number' && index < 0 ? target.length + index : index
    if (target[resolved] === undefined) throw new RangeError(`Index ${index} is out of range`)
    return target[resolved]
  }

  decode(value: any, environment?: any[]): any {
    if (value == null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('CAD arguments require finite numbers')
      return value
    }
    if (isKernelShape(value) || value.__cadValue || value instanceof BrowserStream) return value
    if (Array.isArray(value)) return value.map(item => this.decode(item, environment))
    const decode = (item: any) => this.decode(item, environment)
    if ('$ref' in value) {
      if (!this.context.references.has(value.$ref)) throw new TypeError(`Unknown or released native reference ${value.$ref}`)
      return this.context.references.get(value.$ref)
    }
    if ('$enum' in value) return String(value.$enum)
    if ('$type' in value) return this.resolve(value.path ? `${value.$type}.${value.path}` : value.$type)
    if ('$bytes' in value) return base64Bytes(value.$bytes)
    if ('$file' in value) return this.files.materialize(value)
    if ('$date' in value) return value.$date
    if ('$uuid' in value) return value.$uuid
    if ('$call' in value) return value.target ? this.method(decode(value.target), value.$call, decode(value.args ?? []), decode(value.kwargs ?? {})) : this.invoke(value.$call, decode(value.args ?? []), decode(value.kwargs ?? {}))
    if ('$arg' in value) {
      if (!environment || value.$arg >= environment.length) throw new TypeError('$arg requires an active lambda argument')
      return environment[value.$arg]
    }
    if ('$lambda' in value) return (...args: any[]) => this.decode(value.$lambda, args)
    if ('$if' in value) return decode(decode(value.$if.condition) ? value.$if.then : value.$if.else)
    if ('$method' in value) { const v = value.$method; return this.method(decode(v.target), v.name, decode(v.args ?? []), decode(v.kwargs ?? {})) }
    if ('$get' in value) { const v = value.$get; return this.property(decode(v.target), v.name) }
    if ('$apply' in value) { const v = value.$apply; return this.apply(decode(v.target), decode(v.args ?? []), decode(v.kwargs ?? {})) }
    if ('$index' in value) { const v = value.$index; return this.index(decode(v.target), decode(v.index)) }
    if ('$slice' in value) return { $slice: decode(value.$slice) }
    if ('$operator' in value) { const v = value.$operator; return applyOperator(v.name, [decode(v.target), ...decode(v.args ?? [])], this.context) }
    if ('$select' in value) {
      const target = value.target ? decode(value.target) : this.context.current()?.shape ?? this.context.current()?.pending
      if (!target) throw new TypeError('Selection requires an active builder or target')
      let selected = this.method(target, value.$select, [], {})
      if (value.axis) selected = this.method(selected, 'filter_by', [decode(value.axis)])
      if (value.sort) selected = this.method(selected, 'sort_by', [decode(value.sort)])
      if ('index' in value) selected = this.index(selected, decode(value.index))
      return selected
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
  }

  encode(value: any): any {
    if (value === undefined) return null
    if (value == null || ['string', 'boolean', 'number'].includes(typeof value)) return value
    if (value instanceof Uint8Array) return { $bytes: bytesBase64(value) }
    if (isKernelShape(value) || value.__cadValue || typeof value === 'function' || value instanceof BrowserStream || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      let id = this.retained.get(value)
      if (!id || !this.context.references.has(id)) { id = `cad-${++this.sequence}`; this.retained.set(value, id); this.context.references.set(id, value) }
      return { $ref: id, kind: value.__cadValue ?? value.kind ?? (typeof value === 'function' ? 'Callable' : value.constructor.name) }
    }
    if (Array.isArray(value)) return value.map(item => this.encode(item))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.encode(item)]))
  }

  private apply(target: any, args: any[], kwargs: Record<string, any>): any {
    if (typeof target !== 'function') throw new TypeError('Target is not callable')
    return target.__cadType ? this.invoke(target.__cadType, args, kwargs) : target(...args)
  }

  rpc(request: RpcRequest): { value: any } {
    this.context.replicad.setOC(this.context.oc)
    const args = this.decode(request.args ?? []), kwargs = this.decode(request.kwargs ?? {})
    const target = request.target === undefined ? undefined : this.decode(request.target)
    let value: any
    switch (request.op) {
      case 'construct': case 'function': value = this.invoke(request.name!, args, kwargs); break
      case 'method': value = this.method(target, request.name!, args, kwargs); break
      case 'get': value = request.name === undefined ? target : this.property(target, request.name); break
      case 'set': {
        publicMember(request.name!)
        setProperty(target, request.name!, this.decode(request.value), this.context)
        value = null; break
      }
      case 'index': value = this.index(target, this.decode(request.value)); break
      case 'setitem': target[this.decode(request.index)] = this.decode(request.value); value = null; break
      case 'delitem': target.splice(this.decode(request.index), 1); value = null; break
      case 'operator': value = applyOperator(request.name!, [target, ...args], this.context); break
      case 'invoke': value = this.apply(target, args, kwargs); break
      case 'release': this.context.references.delete((request.target as any).$ref); value = null; break
      default: throw new TypeError(`Unknown kernel operation ${(request as any).op}`)
    }
    return { value: this.encode(value) }
  }

  private publish(builder: BuilderState, shapes: KernelShape[], mode = 'ADD') {
    if (mode === 'PRIVATE' || !shapes.length) return
    const expectedDimension = builder.kind === 'BuildPart' ? 3 : builder.kind === 'BuildSketch' ? 2 : 1
    const matching = shapes.filter(shape => dimension(shape) === expectedDimension)
    builder.pending.push(...shapes.filter(shape => dimension(shape) !== expectedDimension))
    if (!matching.length) return
    const product = unionShapes(matching)
    if (!product) return
    builder.shape = mode === 'REPLACE' || !builder.shape ? product : unionShapes([builder.shape, product], mode)
  }

  private plane(value: any): KernelPlane {
    if (value instanceof KernelPlane) return value
    if (isKernelShape(value)) return this.invoke('Plane', [value])
    if (value?.__cadValue === 'Location') {
      const matrix = value.matrix
      return new KernelPlane(matrix.slice(0, 3).map((row: number[]) => row[3]), matrix.slice(0, 3).map((row: number[]) => row[0]), matrix.slice(0, 3).map((row: number[]) => row[2]))
    }
    if (typeof value === 'string') return this.resolve(`Plane.${value.split('.').at(-1)}`)
    return new KernelPlane(value?.origin ?? [0, 0, 0], value?.x_dir ?? value?.xDir ?? [1, 0, 0], value?.z_dir ?? value?.zDir ?? [0, 0, 1])
  }

  private visit(node: PlanNode, path: string, appearance: Partial<KernelShape> = {}): KernelShape[] {
    try {
      if (!node || typeof node.type !== 'string' || !Array.isArray(node.children)) throw new TypeError('Each node requires a type and children array')
      const { type, children, props = {} } = node
      const current = this.context.current()
      const capture = props.id ?? props.ref
      const meta: Partial<KernelShape> = { ...appearance }
      if (props.color !== undefined) { const color = this.decode(props.color); meta.color = color?.toTuple?.() ?? color?.rgba ?? color }
      if (props.name !== undefined) meta.label = String(props.name)
      const child = (entry: PlanNode, i: number) => this.visit(entry, `${path}.children[${i}]`, meta)
      const args = () => this.decode(props.args ?? [])
      const kwargs = () => this.decode(Object.fromEntries(Object.entries(props).filter(([key]) => !metadata.has(key))))
      let result: KernelShape[]
      if (['BuildPart', 'BuildSketch', 'BuildLine'].includes(type)) {
        const arguments_ = args(), keywords = kwargs()
        const positionalPlacements = type === 'BuildLine' ? arguments_.slice(0, 1) : arguments_
        const placements = positionalPlacements.length ? positionalPlacements : keywords.placements ?? keywords.workplanes ?? [keywords.workplane ?? current?.plane ?? this.resolve('Plane.XY')]
        if (!Array.isArray(placements) || !placements.length) throw new TypeError('Builder placements require at least one plane, face, or location')
        const planes = placements.map(value => this.plane(value))
        const builder: BuilderState = { kind: type as BuilderState['kind'], shape: null, pending: [], plane: planes[0], locations: [] }
        this.context.builders.push(builder)
        if (capture) this.context.references.set(String(capture), builder)
        try {
          children.forEach((entry, i) => {
            const output = child(entry, i)
            const explicitMode = entry.props.mode === undefined ? undefined : enumName(this.decode(entry.props.mode))
            for (const shape of output) this.publish(builder, [shape], explicitMode ?? shape.mode ?? (replacementOperations.has(entry.type) ? 'REPLACE' : entry.type.endsWith('Hole') || entry.type === 'Hole' ? 'SUBTRACT' : 'ADD'))
          })
          result = builder.shape ? [builder.shape] : builder.pending
          if (planes.length > 1) {
            const inverse = this.method(planes[0]!.location, 'inverse')
            result = planes.flatMap(placement => result.map(shape => applyLocation(shape, applyOperator('mul', [placement.location, inverse], this.context), this.context)))
          }
          if (type === 'BuildLine' && arguments_[1] !== undefined) {
            const mode = enumName(arguments_[1])
            if (!['ADD', 'SUBTRACT', 'INTERSECT', 'REPLACE', 'PRIVATE'].includes(mode)) throw new TypeError(`Unsupported combination mode ${mode}`)
            result = result.map(shape => ({ ...shape, mode }))
          }
        } finally { this.context.builders.pop() }
      } else if (['Group', 'Translate', 'Rotate'].includes(type) || /^(Locations|GridLocations|PolarLocations|HexLocations)$/.test(type)) {
        result = children.flatMap(child)
        if (type === 'Translate') result = result.map(shape => transformShape(shape, { position: this.decode(props.offset ?? props.position ?? props.vector ?? (props.args as any)?.[0] ?? [props.x ?? 0, props.y ?? 0, props.z ?? 0]) }))
        if (type === 'Rotate') result = result.map(shape => transformShape(shape, { rotation: this.decode(props.rotation ?? props.angles ?? (props.args as any)?.[0] ?? [props.x ?? 0, props.y ?? 0, props.z ?? 0]) }))
        if (type.endsWith('Locations')) {
          const locations = this.locations(type, args(), kwargs())
          const plane = current ? this.plane(current.plane) : undefined
          const inverse = plane ? this.method(plane.location, 'inverse') : undefined
          result = locations.flatMap(location => {
            const worldLocation = plane ? applyOperator('mul', [applyOperator('mul', [plane.location, location], this.context), inverse], this.context) : location
            return result.map(shape => this.move(shape, worldLocation))
          })
        }
      } else if (['Union', 'Subtract', 'Intersect'].includes(type)) {
        const outputs = children.map(child).map(shapes => unionShapes(shapes)).filter(isKernelShape)
        const product = unionShapes(outputs, type === 'Subtract' ? 'SUBTRACT' : type === 'Intersect' ? 'INTERSECT' : 'ADD')
        result = product ? [product] : []
      } else if (childOperands[type] && children.length) {
        const builder: BuilderState = { kind: 'BuildPart', shape: null, pending: [], plane: current?.plane ?? this.resolve('Plane.XY'), locations: [] }
        this.context.builders.push(builder)
        try {
          const products = children.flatMap((entry, i) => { const output = child(entry, i); this.publish(builder, output, enumName(this.decode(entry.props.mode ?? 'ADD'))); return output })
          const positional = args(), keywords = kwargs(), operand = childOperands[type]!
          if (!(operand in keywords) && !positional.length) {
            if (['fillet', 'chamfer'].includes(type)) keywords[operand] = this.method(builder.shape ?? unionShapes(products), 'edges')
            else if (type === 'sweep') { if (!keywords.path) keywords.path = products.at(-1); keywords[operand] = products.filter(value => value !== keywords.path) }
            else keywords[operand] = products.length === 1 ? products[0] : products
          }
          result = shapeList(this.invoke(type, positional, keywords))
        } finally { this.context.builders.pop() }
      } else if (type === 'Compound' && children.length) {
        const products = children.flatMap(child), positional = args(), keywords = kwargs()
        // Native constructor operands win over composition children. Without
        // explicit geometry, the JSX children form a real assembly compound.
        if (positional[0] === undefined && positional[6] === undefined && keywords.obj === undefined && keywords.shapes === undefined) keywords.children = products
        result = shapeList(this.invoke(type, positional, keywords))
      } else if (type === 'Shape') {
        result = shapeList(this.decode(props.shape ?? props.value ?? (props.args as any)?.[0]))
        if (!result.length) throw new TypeError('Shape requires native geometry')
      } else if (type === 'Call') {
        const name = String(props.symbol ?? props.function ?? props.name)
        result = shapeList(props.target ? this.method(this.decode(props.target), name, args(), this.decode(props.kwargs ?? {})) : this.invoke(name, args(), this.decode(props.kwargs ?? {})))
      } else {
        result = shapeList(this.invoke(type, args(), kwargs()))
        // Sketch and curve handlers already construct world coordinates. Solid
        // object constructors build in local XYZ before their builder placement.
        if (current?.kind === 'BuildPart' && localPartObjects.has(type)) result = result.map(shape => applyLocation(shape, this.plane(current.plane).location, this.context))
        if (childOperands[type] && current && !['fillet', 'chamfer', 'draft', 'full_round'].includes(type)) current.pending = []
      }
      result = result.map(shape => ({ ...shape, ...meta, ...(props.mode !== undefined ? { mode: enumName(this.decode(props.mode)) } : {}) }))
      if (props.position !== undefined && type !== 'Translate') result = result.map(shape => transformShape(shape, { position: this.decode(props.position) }))
      if (capture && !['BuildPart', 'BuildSketch', 'BuildLine'].includes(type)) this.context.references.set(String(capture), result.length === 1 ? result[0] : result)
      return result
    } catch (cause) {
      if (cause && typeof cause === 'object' && !('path' in cause)) Object.assign(cause, { path })
      throw cause
    }
  }

  private move(shape: KernelShape, location: any): KernelShape {
    if (location?.__cadValue === 'Location') return { ...applyLocation(shape, location, this.context), mode: shape.mode }
    const positions = location?.position?.toTuple?.() ?? location?.position ?? location?.translation ?? location?.toTuple?.()?.[0] ?? location
    const rotation = location?.orientation?.toTuple?.() ?? location?.orientation ?? location?.rotation
    return { ...transformShape(shape, { position: positions, rotation }), mode: shape.mode }
  }

  private locations(type: string, args: any[], kwargs: Record<string, any>): any[] {
    if (this.context.handlers[type]) { const result = this.invoke(type, args, kwargs); return result.locations ?? result }
    const number = (name: string, i: number, fallback: number) => Number(kwargs[name] ?? args[i] ?? fallback)
    const result: number[][] = []
    if (type === 'PolarLocations') {
      const radius = number('radius', 0, 0), count = number('count', 1, 1), start = number('start_angle', 2, 0), arc = number('angular_range', 3, 360)
      for (let i = 0; i < count; i++) { const angle = (start + arc * i / (arc === 360 || kwargs.endpoint === false ? count : count - 1 || 1)) * Math.PI / 180; result.push([radius * Math.cos(angle), radius * Math.sin(angle), 0]) }
    } else {
      const dx = number('x_spacing', 0, 1), dy = number('y_spacing', 1, 1), nx = number('x_count', 2, 1), ny = number('y_count', 3, 1)
      for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) result.push([(x - (nx - 1) / 2) * dx + (type === 'HexLocations' && y % 2 ? dx / 2 : 0), (y - (ny - 1) / 2) * dy, 0])
    }
    return result
  }

  evaluatePlan(plan: Build123dPlan): KernelShape[] {
    if (plan?.version !== 1 || !Array.isArray(plan.children)) throw new TypeError('Expected plan {version: 1, children: [...]}')
    this.context.replicad.setOC(this.context.oc)
    const saved = new Map(this.context.references), depth = this.context.builders.length
    try { return plan.children.flatMap((node, i) => this.visit(node, `plan.children[${i}]`)).filter(shape => !isEmptyShape(shape)) }
    finally {
      this.context.builders.length = depth
      for (const key of this.context.references.keys()) if (!saved.has(key) && !key.startsWith('cad-')) this.context.references.delete(key)
      for (const [key, value] of saved) this.context.references.set(key, value)
    }
  }

  render(plan: Build123dPlan, options: RenderOptions = {}): RenderResult {
    options.signal?.throwIfAborted()
    for (const name of ['tolerance', 'angularTolerance'] as const) {
      if (options[name] !== undefined && (!Number.isFinite(options[name]) || options[name]! <= 0)) throw new RangeError(`${name} must be a positive finite number`)
    }
    const flatten = (shape: KernelShape): KernelShape[] => shape.children?.length ? shape.children.flatMap((child, index) => flatten({ ...child, assemblyPath: [...(shape.assemblyPath ?? []), { name: shape.label ?? '', index }] })) : [shape]
    const shapes = this.evaluatePlan(plan).flatMap(flatten).filter(shape => !isEmptyShape(shape))
    const meshes = shapes.map(shape => meshShape({ ...shape, color: (shape.color as any)?.rgba ?? shape.color }, options))
    let bounds: RenderResult['bounds'] = null
    for (const shape of shapes) {
      const box = shape.shape.boundingBox, [min, max] = box.bounds
      if (!bounds) bounds = { min: [...min], max: [...max] }
      else for (let axis = 0; axis < 3; axis++) { bounds.min[axis] = Math.min(bounds.min[axis]!, min[axis]!); bounds.max[axis] = Math.max(bounds.max[axis]!, max[axis]!) }
      box.delete()
    }
    return { meshes, bounds, kernel: 'OpenCascade WebAssembly' }
  }

  uploadFile(...args: Parameters<KernelFileStore['uploadFile']>) { return this.files.uploadFile(...args) }
  downloadFile(...args: Parameters<KernelFileStore['downloadFile']>) { return this.files.downloadFile(...args) }
  deleteFile(...args: Parameters<KernelFileStore['deleteFile']>) { return this.files.deleteFile(...args) }
  importFile(...args: Parameters<KernelFileStore['importFile']>) { this.context.replicad.setOC(this.context.oc); return this.files.importFile(...args) }
  exportFile(...args: Parameters<KernelFileStore['exportFile']>) { this.context.replicad.setOC(this.context.oc); return this.files.exportFile(...args) }
  createStream(...args: Parameters<KernelFileStore['createStream']>) { return this.files.createStream(...args) }
  readStream(...args: Parameters<KernelFileStore['readStream']>) { return this.files.readStream(...args) }
  writeStream(...args: Parameters<KernelFileStore['writeStream']>) { return this.files.writeStream(...args) }
}
