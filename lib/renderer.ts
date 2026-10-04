import { createContext, type ReactNode } from 'react'
import Reconciler from 'react-reconciler'
import { ConcurrentRoot, DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants.js'
import { Build123dPlanError, clonePlan, createPlanNode } from './plan.js'
import type { Build123dPlan, PlanNode, WireValue } from './types.js'

export interface Build123dInstance {
  type: string
  props: Record<string, WireValue>
  children: Build123dInstance[]
  hidden: boolean
}

interface Container {
  children: Build123dInstance[]
  plan: Build123dPlan
  listeners: Set<(plan: Build123dPlan) => void>
  errors: unknown[]
}

function remove(parent: { children: Build123dInstance[] }, child: Build123dInstance): void {
  const index = parent.children.indexOf(child)
  if (index >= 0) parent.children.splice(index, 1)
}
function append(parent: { children: Build123dInstance[] }, child: Build123dInstance): void {
  remove(parent, child)
  parent.children.push(child)
}
function insert(parent: { children: Build123dInstance[] }, child: Build123dInstance, before: Build123dInstance): void {
  remove(parent, child)
  const index = parent.children.indexOf(before)
  if (index < 0) throw new Build123dPlanError('React attempted to insert before a detached CAD node.')
  parent.children.splice(index, 0, child)
}
function snapshot(children: Build123dInstance[]): PlanNode[] {
  return children.filter(child => !child.hidden).map(child => ({
    type: child.type,
    props: child.props,
    children: snapshot(child.children),
  }))
}

let currentPriority = NoEventPriority
const hostContext = Object.freeze({})

// This renderer manages a plan tree only. Geometry is executed by the service
// after React commits, so speculative renders cannot create native CAD objects.
const reconciler = Reconciler({
  rendererVersion: '0.1.0',
  rendererPackageName: 'build123d-fiber',
  extraDevToolsConfig: null,
  bindToConsole: (_method: string, args: unknown[]) => () => console.log(...args),
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsResources: false,
  supportsSingletons: false,
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  getRootHostContext: () => hostContext,
  getChildHostContext: () => hostContext,
  getPublicInstance: (instance: Build123dInstance) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: (container: Container) => {
    container.plan = clonePlan({ version: 1, children: snapshot(container.children) })
    for (const listener of container.listeners) listener(clonePlan(container.plan))
  },
  preparePortalMount: () => {},
  createInstance: (type: string, props: Record<string, unknown>): Build123dInstance => ({ ...createPlanNode(type, props), children: [], hidden: false }),
  appendInitialChild: append,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  createTextInstance: (text: string): Build123dInstance => {
    if (text.trim()) throw new Build123dPlanError('Text is not CAD geometry. Pass text to the Text component through its txt prop.')
    return { type: '__whitespace', props: {}, children: [], hidden: true }
  },
  scheduleTimeout: (callback: (...args: unknown[]) => unknown, delay?: number) => setTimeout(callback, delay),
  cancelTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: (callback: () => unknown) => queueMicrotask(callback),
  appendChild: append,
  appendChildToContainer: append,
  insertBefore: insert,
  insertInContainerBefore: insert,
  removeChild: remove,
  removeChildFromContainer: remove,
  clearContainer: (container: Container) => { container.children.length = 0 },
  commitUpdate: (instance: Build123dInstance, type: string, _previous: Record<string, unknown>, next: Record<string, unknown>) => {
    instance.props = createPlanNode(type, next).props
  },
  commitTextUpdate: (_instance: Build123dInstance, _oldText: string, text: string) => {
    if (text.trim()) throw new Build123dPlanError('Text is not CAD geometry. Use the Text component.')
  },
  resetTextContent: () => {},
  hideInstance: (instance: Build123dInstance) => { instance.hidden = true },
  unhideInstance: (instance: Build123dInstance) => { instance.hidden = false },
  hideTextInstance: () => {},
  unhideTextInstance: () => {},
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => {},
  NotPendingTransition: null,
  HostTransitionContext: createContext(null) as unknown as Reconciler.ReactContext<null>,
  setCurrentUpdatePriority: (priority: number) => { currentPriority = priority },
  getCurrentUpdatePriority: () => currentPriority,
  resolveUpdatePriority: () => currentPriority || DefaultEventPriority,
  resetFormInstance: () => {},
  requestPostPaintCallback: (callback: (time: number) => void) => queueMicrotask(() => callback(performance.now())),
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => performance.now(),
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => {},
  suspendOnActiveViewTransition: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
})

export interface Build123dRootOptions {
  onCommit?: (plan: Build123dPlan) => void
  onError?: (error: unknown) => void
  strictMode?: boolean
}

export interface Build123dRoot {
  /** Mount/update real React components, including hooks, context and effects. */
  render(element: ReactNode): Build123dPlan
  /** Flush a synchronous state update: root.flush(() => setDimensions(...)). */
  flush(update?: () => void): Build123dPlan
  getPlan(): Build123dPlan
  subscribe(listener: (plan: Build123dPlan) => void): () => void
  /** Unmount React, running effect cleanup and detaching refs. */
  unmount(): void
  readonly disposed: boolean
}

export function createBuild123dRoot(options: Build123dRootOptions = {}): Build123dRoot {
  const container: Container = { children: [], plan: { version: 1, children: [] }, listeners: new Set(), errors: [] }
  if (options.onCommit) container.listeners.add(options.onCommit)
  let disposed = false
  const captureError = (error: unknown) => {
    container.errors.push(error)
    options.onError?.(error)
  }
  const root = reconciler.createContainer(container, ConcurrentRoot, null, options.strictMode ?? false, null, '', captureError, error => options.onError?.(error), captureError, () => {}, null)
  function assertActive() {
    if (disposed) throw new Build123dPlanError('This CAD root has been unmounted. Create another root before rendering again.')
  }
  function finish(): Build123dPlan {
    reconciler.flushSyncWork()
    // Passive effects must run so callers can observe cleanup and effects that
    // intentionally initialize a model. React schedules subsequent commits.
    reconciler.flushPassiveEffects()
    reconciler.flushSyncWork()
    if (container.errors.length) {
      const error = container.errors.shift()
      container.errors.length = 0
      throw error
    }
    return clonePlan(container.plan)
  }
  return {
    get disposed() { return disposed },
    render(element) {
      assertActive()
      reconciler.flushSyncFromReconciler(() => reconciler.updateContainerSync(element, root, null, null))
      return finish()
    },
    flush(update) {
      assertActive()
      reconciler.flushSyncFromReconciler(update ?? (() => {}))
      return finish()
    },
    getPlan: () => clonePlan(container.plan),
    subscribe(listener) {
      assertActive()
      container.listeners.add(listener)
      return () => { container.listeners.delete(listener) }
    },
    unmount() {
      if (disposed) return
      reconciler.flushSyncFromReconciler(() => reconciler.updateContainerSync(null, root, null, null))
      finish()
      container.listeners.clear()
      disposed = true
    },
  }
}

export const createBuild123dRenderer = createBuild123dRoot
