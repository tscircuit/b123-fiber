import { describe, expect, it, vi } from 'vitest'
import { NativeClient, NativeError, NativeHandle, nativeFile } from '../lib/client'

describe('browser file and native stream transport', () => {
  it('uploads binary content with authentication and downloads/deletes generated file IDs', async () => {
    const requests: { url: string; init: RequestInit }[] = []
    const fetch = vi.fn(async (url: unknown, init: RequestInit = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === 'POST') return Response.json({ file: { id: 'upload1', name: 'part.step', path: '.files/upload1.step', size: 4, contentType: 'application/step' } })
      if (init.method === 'DELETE') return Response.json({ deleted: true })
      return new Response(new Uint8Array([0, 1, 128, 255]), { headers: { 'Content-Type': 'application/step' } })
    }) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ url: '/kernel/', fetch, headers: { Authorization: 'Bearer files-token' } })
    const signal = new AbortController().signal
    const contents = new Uint8Array([0, 1, 128, 255])
    const file = await client.uploadFile(new File([contents], 'part.step'), { signal })
    expect(file.id).toBe('upload1')
    expect(requests[0].url).toBe('/kernel/files?filename=part.step')
    expect(await (requests[0].init.body as Blob).arrayBuffer()).toEqual(contents.buffer)
    expect(new Headers(requests[0].init.headers).get('Content-Type')).toBe('application/octet-stream')
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe('Bearer files-token')
    expect(requests[0].init.signal).toBe(signal)
    expect(new Uint8Array(await (await client.downloadFile(file)).arrayBuffer())).toEqual(contents)
    await client.deleteFile(file)
    expect(requests.at(-1)?.init.method).toBe('DELETE')
  })

  it('imports into a durable native plan and exports plans and retained targets as binary downloads', async () => {
    const plan = { version: 1 as const, children: [{ type: 'import_step', props: { args: [{ $file: { name: 'part.step', base64: 'YWJj' } }] }, children: [] }] }
    const requests: { url: string; init: RequestInit }[] = []
    const fetch = vi.fn(async (url: unknown, init: RequestInit = {}) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('/import')) return Response.json({ value: { $ref: 'part', kind: 'Compound' }, plan, result: { meshes: [], bounds: null, kernel: 'build123d/OpenCascade' } })
      return new Response('CAD-file', { headers: { 'Content-Type': 'application/step' } })
    }) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ url: '/kernel', fetch })
    const imported = await client.importFile(new Blob(['abc']), { filename: 'part.step', format: 'step', kwargs: { color: { $enum: 'ColorIndex.RED' } } })
    expect(imported.value).toBeInstanceOf(NativeHandle)
    expect(imported.plan).toEqual(plan)
    expect(new URL(requests[0].url, 'http://localhost').searchParams.get('options')).toBe('{"color":{"$enum":"ColorIndex.RED"}}')
    expect(await (await client.exportFile(imported.plan, 'step', { filename: 'copy.step' })).text()).toBe('CAD-file')
    expect(JSON.parse(String(requests[1].init.body))).toEqual({ format: 'step', plan, filename: 'copy.step' })
    expect(await (await client.exportFile(imported.value as NativeHandle, 'brep')).text()).toBe('CAD-file')
    expect(JSON.parse(String(requests[2].init.body)).target).toEqual({ $ref: 'part' })
  })

  it('constructs, reads, replaces and natively accesses BytesIO/StringIO content', async () => {
    const fetch = vi.fn(async (url: unknown, init: RequestInit = {}) => {
      if (String(url).includes('/streams?')) return Response.json({ value: { $ref: String(url).endsWith('text') ? 'text' : 'bytes', kind: String(url).endsWith('text') ? 'StringIO' : 'BytesIO' } })
      if (String(url).endsWith('/rpc')) return Response.json({ value: { $bytes: 'AAH+/w==' } })
      if (init.method === 'POST') return Response.json({ value: { $ref: 'bytes', kind: 'BytesIO' } })
      return String(url).endsWith('/text') ? new Response('hello λ') : new Response(new Uint8Array([0, 1, 254, 255]))
    }) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ fetch })
    const bytes = await client.createStream(new Uint8Array([0, 1, 254, 255]))
    expect(bytes.kind).toBe('BytesIO')
    expect(await client.readStream(bytes)).toEqual(new Uint8Array([0, 1, 254, 255]))
    expect(await bytes.call('getvalue')).toEqual(new Uint8Array([0, 1, 254, 255]))
    await client.writeStream(bytes, new Uint8Array([2, 3]))
    const text = await client.createStream('hello λ')
    expect(text.kind).toBe('StringIO')
    expect(await client.readStream(text)).toBe('hello λ')
  })

  it('bridges typed binary arguments and preserves byte offsets and retained handle ownership', async () => {
    const requests: any[] = []
    const fetch = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      requests.push(JSON.parse(String(init.body)))
      return Response.json({ value: { $ref: 'bytes', kind: 'BytesIO' } })
    }) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ fetch })
    const bytes = await client.construct('BytesIO', [new Uint8Array([99, 0, 1, 255, 99]).subarray(1, 4)])
    expect(requests[0].args).toEqual([{ $bytes: 'AAH/' }])
    const other = new NativeClient({ fetch })
    await expect(other.readStream(bytes)).rejects.toThrow(/different client/)
  })

  it('retains native binary failure details and creates standalone file values from browser inputs', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { type: 'FileTransferError', message: 'File too large', path: 'file' } }, { status: 413 })) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ fetch })
    await expect(client.downloadFile('missing')).rejects.toMatchObject({ name: 'NativeError', status: 413, pythonType: 'FileTransferError', path: 'file' })
    await expect(client.exportFile({ version: 1, children: [] }, 'step')).rejects.toBeInstanceOf(NativeError)
    expect(await nativeFile(new File([new Uint8Array([0, 1, 255])], 'part.step'))).toEqual({ $file: { name: 'part.step', base64: 'AAH/' } })
  })

  it('assigns and deletes native list indexes explicitly', async () => {
    const requests: any[] = []
    const fetch = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      requests.push(JSON.parse(String(init.body)))
      return Response.json({ value: requests.length === 1 ? { $ref: 'list', kind: 'ShapeList' } : null })
    }) as unknown as typeof globalThis.fetch
    const client = new NativeClient({ fetch })
    const list = await client.construct('ShapeList')
    await list.setAt(0, { $call: 'Box', args: [2, 3, 4] })
    await list.deleteAt(1)
    expect(requests[1]).toEqual({ op: 'setitem', target: { $ref: 'list' }, index: 0, value: { $call: 'Box', args: [2, 3, 4] } })
    expect(requests[2]).toEqual({ op: 'delitem', target: { $ref: 'list' }, index: 1 })
  })
})
