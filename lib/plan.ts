import type { Build123dPlan, PlanNode, WireValue } from './types.js'
import { componentSymbols } from './generated/symbols.js'
import { NativeHandle } from './client.js'

export type { Build123dPlan, PlanNode, WireValue } from './types.js'
export type Plan = Build123dPlan

const specialNodes = ['Union', 'Subtract', 'Intersect', 'Translate', 'Rotate', 'Group', 'Shape', 'Call']
const nodeTypes = new Set<string>([...componentSymbols, ...specialNodes])

export class Build123dPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Build123dPlanError'
  }
}

export function assertNodeType(type: string): void {
  if (!nodeTypes.has(type)) {
    throw new Build123dPlanError(`Unknown CAD node "${type}". Use a build123d component or NativeNode with a public build123d constructor/function name.`)
  }
}

/** Convert React props to data that can cross the geometry service boundary. */
export function serializeProps(props: Record<string, unknown>, type: string): Record<string, WireValue> {
  return Object.fromEntries(Object.entries(props)
    .filter(([key, value]) => key !== 'children' && key !== 'key' && key !== 'ref' && value !== undefined)
    .map(([key, value]) => [key, serializeValue(value, `${type}.${key}`)]))
}

export function serializeValue(value: unknown, path = 'value', ancestors = new Set<object>()): WireValue {
  if (value instanceof NativeHandle) return serializeValue(value.toJSON(), path, ancestors)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Build123dPlanError(`${path} must be finite; received ${String(value)}.`)
    return value
  }
  if (typeof value !== 'object') {
    throw new Build123dPlanError(`${path} is not serializable (${typeof value}). Pass a native enum/value, JSON data, or a {$call: ..., args: ...} selector instead of a function.`)
  }
  if (ancestors.has(value)) throw new Build123dPlanError(`${path} contains a circular reference.`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item, index) => serializeValue(item, `${path}[${index}]`, ancestors))
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return Array.from(value as unknown as ArrayLike<unknown>, (item, index) => serializeValue(item, `${path}[${index}]`, ancestors))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Build123dPlanError(`${path} is a ${prototype?.constructor?.name ?? 'native object'}; use its wire reference or a native symbolic value.`)
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, serializeValue(item, `${path}.${key}`, ancestors)]))
  } finally {
    ancestors.delete(value)
  }
}

export function createPlanNode(type: string, props: Record<string, unknown>, children: PlanNode[] = []): PlanNode {
  assertNodeType(type)
  return { type, props: serializeProps(props, type), children }
}

export function clonePlan(plan: Build123dPlan): Build123dPlan {
  return JSON.parse(JSON.stringify(plan)) as Build123dPlan
}

/** Defer a native function or a selector until a real builder context is active. */
export function call(symbol: string, args: readonly unknown[] = [], kwargs: Record<string, unknown> = {}): WireValue {
  return serializeValue({ $call: symbol, args, kwargs })
}

/** Reference a previously captured plan result (`id` on a CAD node). */
export function reference(id: string): WireValue {
  return { $ref: id }
}
