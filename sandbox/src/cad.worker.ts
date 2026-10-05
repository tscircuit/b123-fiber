import wasmUrl from 'replicad-opencascadejs/wasm?url'
import fontUrl from '../../assets/fonts/DejaVuSans.ttf?url'
import { NativeClient, NativeHandle } from '../../lib/client'
import type { Build123dPlan, RenderOptions } from '../../lib/types'
import type { NativeBinaryInput, NativeExportOptions, NativeFileFormat, NativeImportOptions } from '../../lib/files'

const client = new NativeClient({ wasmUrl, fontUrl })
let queue = Promise.resolve()

// An OpenCascade instance has shared mutable native state. Serialize work inside
// this persistent worker, while the UI can cancel it by terminating the worker.
self.onmessage = (event: MessageEvent<{ id: number; operation: string; args: unknown[] }>) => {
  const { id, operation, args } = event.data
  queue = queue.then(async () => {
    try {
      let value: unknown
      if (operation === 'render') {
        value = await client.render(args[0] as Build123dPlan, args[1] as RenderOptions)
      } else if (operation === 'importFile') {
        const imported = await client.importFile(args[0] as NativeBinaryInput, args[1] as NativeImportOptions)
        const release = async (handle: unknown): Promise<void> => {
          if (handle instanceof NativeHandle) await handle.release()
          else if (Array.isArray(handle)) await Promise.all(handle.map(release))
        }
        await release(imported.value)
        value = { ...imported, value: null }
      } else if (operation === 'exportFile') {
        value = await client.exportFile(args[0] as Build123dPlan, args[1] as NativeFileFormat, args[2] as NativeExportOptions)
      } else throw new Error(`Unknown CAD worker operation: ${operation}`)
      self.postMessage({ id, ok: true, value })
    } catch (error) {
      self.postMessage({ id, ok: false, error: { message: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : undefined } })
    }
  })
}
