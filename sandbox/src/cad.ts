import type { Build123dPlan, RenderOptions, RenderResult } from '../../lib/types'
import type { NativeBinaryInput, NativeExportOptions, NativeFileFormat, NativeImportOptions, NativeImportedFile } from '../../lib/files'

interface WorkerReply { id: number; ok: boolean; value?: unknown; error?: { message: string; name?: string } }

/** Keep CAD computation off the application thread; cancellation resets the WASM worker. */
export class SandboxCadClient {
  private worker?: Worker
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup: () => void }>()

  private start(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./cad.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const { id, ok, value, error } = event.data
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      request.cleanup()
      if (ok) request.resolve(value)
      else request.reject(Object.assign(new Error(error?.message ?? 'CAD operation failed.'), { name: error?.name ?? 'Error' }))
    }
    worker.onerror = (event) => { event.preventDefault(); this.reset(new Error(event.message || 'The CAD worker stopped unexpectedly.')) }
    this.worker = worker
    return worker
  }

  private reset(error: Error): void {
    this.worker?.terminate()
    this.worker = undefined
    for (const request of this.pending.values()) { request.cleanup(); request.reject(error) }
    this.pending.clear()
  }

  private request<Result>(operation: string, args: unknown[], signal?: AbortSignal | null): Promise<Result> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      const id = ++this.nextId
      const abort = () => this.reset(new DOMException('Aborted', 'AbortError'))
      const cleanup = () => signal?.removeEventListener('abort', abort)
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.start().postMessage({ id, operation, args }) }
      catch (error) {
        this.pending.delete(id); cleanup()
        reject(error)
      }
    })
  }

  render(plan: Build123dPlan, options: RenderOptions = {}): Promise<RenderResult> {
    const { signal, ...renderOptions } = options
    return this.request('render', [plan, renderOptions], signal)
  }

  importFile(contents: NativeBinaryInput, options: NativeImportOptions = {}): Promise<NativeImportedFile<null>> {
    const { signal, ...importOptions } = options
    return this.request('importFile', [contents, importOptions], signal)
  }

  exportFile(plan: Build123dPlan, format: NativeFileFormat, options: NativeExportOptions = {}): Promise<Blob> {
    const { signal, ...exportOptions } = options
    return this.request('exportFile', [plan, format, exportOptions], signal)
  }

  dispose(): void { this.reset(new DOMException('Aborted', 'AbortError')) }
}
