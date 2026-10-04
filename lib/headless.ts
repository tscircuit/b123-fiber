import * as React from 'react'
import { Fragment, isValidElement, type ReactNode } from 'react'
import { Build123dPlanError, createPlanNode } from './plan.js'
import type { Build123dPlan, PlanNode } from './types.js'

export { call, reference, Build123dPlanError } from './plan.js'
export type { Build123dPlan, PlanNode, WireValue } from './types.js'
export * from './components.js'
export * from './renderer.js'
export * from './generated/values.js'
export { expr } from './generated/runtime.js'

const memo = Symbol.for('react.memo')
const forwardRef = Symbol.for('react.forward_ref')

// Static compilation may itself be called during a React render. Isolate the
// dispatcher so an accidentally invoked hook cannot attach to the caller's
// component. This private integration is pinned alongside React 19.2 and the
// reconciler; restore it even when a user component fails.
const reactInternals = (React as unknown as {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: unknown }
}).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

function evaluatePure(render: (...args: never[]) => unknown, args: unknown[], path: string): unknown {
  if (Object.prototype.toString.call(render) === '[object AsyncFunction]') {
    throw new Build123dPlanError(`${path} is asynchronous. Static CAD compilation requires synchronous components; resolve data first or use createBuild123dRoot.`)
  }
  const previous = reactInternals?.H
  if (reactInternals) reactInternals.H = new Proxy({}, {
    get: () => () => { throw new Build123dPlanError(`${path} uses React hooks or context. Use createBuild123dRoot (the live React renderer), then root.render(element) and root.getPlan().`) },
  })
  try { return render(...args as never[]) }
  finally { if (reactInternals) reactInternals.H = previous }
}

/**
 * Compile a static JSX tree without mounting React or executing geometry.
 * Use createBuild123dRoot for components with hooks, context, state or effects.
 */
export function renderToBuild123dPlan(element: ReactNode): Build123dPlan {
  function visit(input: unknown, path: string): PlanNode[] {
    if (input == null || typeof input === 'boolean') return []
    if (Array.isArray(input)) return input.flatMap((child, index) => visit(child, `${path}[${index}]`))
    if (typeof input === 'string' && input.trim() === '') return []
    if (typeof input === 'object' && typeof (input as { then?: unknown }).then === 'function') {
      if (input instanceof Promise) void input.catch(() => {})
      throw new Build123dPlanError(`${path} is asynchronous. Static CAD compilation requires synchronous components; resolve data first or use createBuild123dRoot.`)
    }
    if (!isValidElement(input)) throw new Build123dPlanError(`${path} is not a CAD element. Text and numbers are not geometry; pass them as component props.`)
    const { type, props } = input as unknown as { type: unknown; props: Record<string, unknown> }
    if (type === Fragment) return visit(props.children, `${path}.Fragment`)
    if (typeof type === 'string') return [createPlanNode(type, props, visit(props.children, `${path}.${type}.children`))]
    let resolved = type
    while (typeof resolved === 'object' && resolved !== null && (resolved as { $$typeof?: symbol }).$$typeof === memo) {
      resolved = (resolved as { type: unknown }).type
    }
    try {
      if (typeof resolved === 'object' && resolved !== null && (resolved as { $$typeof?: symbol }).$$typeof === forwardRef) {
        const render = (resolved as { render: (props: Record<string, unknown>, ref: unknown) => unknown }).render
        return visit(evaluatePure(render as (...args: never[]) => unknown, [props, props.ref ?? null], path), `${path}.forwardRef`)
      }
      if (typeof resolved === 'function') {
        if (resolved.prototype?.isReactComponent) {
          throw new Build123dPlanError(`${resolved.name || path} is a React class component. Mount it with createBuild123dRoot to preserve lifecycle and state semantics.`)
        }
        return visit(evaluatePure(resolved as (...args: never[]) => unknown, [props], path), `${path}.${resolved.name || 'Component'}`)
      }
    } catch (error) {
      if (error instanceof Build123dPlanError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/hook|dispatcher|useState|useContext|useReducer|useEffect|useMemo|reading 'use/i.test(message)) {
        throw new Build123dPlanError(`${path} uses React hooks or context. Use createBuild123dRoot (the live React renderer), then root.render(element) and root.getPlan().`)
      }
      throw error
    }
    throw new Build123dPlanError(`${path} uses an unsupported React element type. Lazy components, providers and Suspense require createBuild123dRoot.`)
  }
  return { version: 1, children: visit(element, 'root') }
}
