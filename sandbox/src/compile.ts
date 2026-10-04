import type { Build123dPlan } from '../../lib/types'

/** Compile JSX in a disposable worker; loops and crashes cannot freeze the UI. */
export function compileSource(source: string, signal?: AbortSignal): Promise<Build123dPlan> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const worker = new Worker(new URL('./compile.worker.ts', import.meta.url), { type: 'module' })
    const finish = (error?: Error, plan?: Build123dPlan) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(plan!)
    }
    const abort = () => finish(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Compilation exceeded 15 seconds. Check for an infinite loop.')), 15000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ ok: boolean; plan?: Build123dPlan; error?: string }>) => {
      if (event.data.ok && event.data.plan?.version === 1 && Array.isArray(event.data.plan.children)) finish(undefined, event.data.plan)
      else finish(new Error(event.data.error ?? 'CAD compilation failed.'))
    }
    worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'CAD compilation failed.')) }
    worker.postMessage({ source })
  })
}
