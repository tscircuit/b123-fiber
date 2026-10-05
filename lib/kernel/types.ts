import type * as Replicad from 'replicad'
import type { Build123dPlan, MeshData, RenderOptions, RenderResult, WireValue } from '../types'

export interface KernelShape {
  readonly __cadShape: true
  shape: Replicad.AnyShape
  kind: string
  label?: string
  color?: string | number[]
  children?: KernelShape[]
  assemblyPath?: { name: string; index: number }[]
  mode?: string
}
export interface BuilderState {
  kind: 'BuildPart' | 'BuildSketch' | 'BuildLine'
  shape: KernelShape | null
  pending: KernelShape[]
  plane: any
  locations: any[]
}
export type KernelHandler = (args: any[], kwargs: Record<string, any>, context: KernelContext) => any
export interface KernelContext {
  oc: any
  replicad: typeof Replicad
  handlers: Record<string, KernelHandler>
  references: Map<string, any>
  builders: BuilderState[]
  invoke(name: string, args?: any[], kwargs?: Record<string, any>): any
  decode(value: any, environment?: any[]): any
  encode(value: any): any
  render(plan: Build123dPlan, options?: RenderOptions): RenderResult
  evaluatePlan(plan: Build123dPlan): any
  current(): BuilderState | undefined
}
export function isKernelShape(value: any): value is KernelShape { return value?.__cadShape === true }
const topologyKinds = ['Compound', 'CompSolid', 'Solid', 'Shell', 'Face', 'Wire', 'Edge', 'Vertex', 'Shape'] as const

/** OCCT topology is stable across bundlers; JavaScript class names are not. */
export function shapeKind(shape: Replicad.AnyShape): typeof topologyKinds[number] {
  const nativeType = shape.wrapped.ShapeType() as unknown as string | number | { value: string | number }
  const code = typeof nativeType === 'object' ? nativeType.value : nativeType
  // New OpenCascade.js builds expose enum strings; older injected builds may
  // expose numeric values or Embind enum objects. None depend on JS class names.
  const kind = typeof code === 'string'
    ? topologyKinds.find(name => name.toUpperCase() === code.replace(/^TopAbs_/, '').toUpperCase())
    : topologyKinds[code]
  if (!kind) throw new TypeError(`Unsupported OpenCascade topology type ${String(code)}`)
  return kind
}

export function shapeValue(shape: Replicad.AnyShape, kind: string = shapeKind(shape), metadata: Partial<KernelShape> = {}): KernelShape {
  return { __cadShape: true, shape, kind, ...metadata }
}
export function shapeList(value: any): KernelShape[] {
  if (isKernelShape(value)) return [value]
  if (Array.isArray(value)) return value.flatMap(shapeList)
  if (value?.shape && isKernelShape(value.shape)) return [value.shape]
  return []
}
export type KernelMeshFunction = (value: KernelShape, options?: RenderOptions) => MeshData
export type KernelWireValue = WireValue
