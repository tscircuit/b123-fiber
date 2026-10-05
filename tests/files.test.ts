import { beforeAll, describe, expect, it, vi } from 'vitest'
import { NativeClient, NativeHandle, nativeFile } from '../lib/client'
import { BrowserKernel } from '../lib/kernel'
import { unzipSync, strFromU8 } from 'fflate'
import type { Build123dPlan } from '../lib/types'

const boxPlan: Build123dPlan = { version: 1, children: [{ type: 'Box', props: { length: 2, width: 3, height: 4 }, children: [] }] }
const rectanglePlan: Build123dPlan = { version: 1, children: [{ type: 'Rectangle', props: { width: 6, height: 4 }, children: [] }] }
let client: NativeClient
beforeAll(async () => { client = new NativeClient({ kernel: await BrowserKernel.create() }) }, 30000)

describe('local browser CAD files and streams', () => {
  it('uploads, downloads and deletes binary content without HTTP', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('File transport must not use HTTP') })
    try {
      const contents = new Uint8Array([0, 1, 128, 255]), file = await client.uploadFile(new File([contents], 'part.step'))
      expect(file.name).toBe('part.step'); expect(file.size).toBe(4); expect(file.path).toContain('/b123-files-')
      expect(new Uint8Array(await (await client.downloadFile(file)).arrayBuffer())).toEqual(contents)
      await client.deleteFile(file); await expect(client.downloadFile(file)).rejects.toThrow('Unknown file ID')
      await expect(client.uploadFile(new Blob(['x']), { filename: '../escape.step' })).rejects.toThrow(/traversal/)
    } finally { fetch.mockRestore() }
  })

  it.each(['step', 'stl', 'brep', 'svg', 'dxf'] as const)('exports and genuinely imports %s through OpenCascade WASM', async format => {
    const twoDimensional = format === 'svg' || format === 'dxf', original = twoDimensional ? rectanglePlan : boxPlan
    const exported = await client.exportFile(original, format)
    expect(exported.size).toBeGreaterThan(100)
    const imported = await client.importFile(exported, { filename: `model.${format}`, format })
    expect(imported.value instanceof NativeHandle || Array.isArray(imported.value)).toBe(true)
    expect(imported.result.meshes.length).toBeGreaterThan(0)
    if (!twoDimensional) expect(imported.result.meshes.reduce((sum, mesh) => sum + mesh.volume, 0)).toBeCloseTo(24, 5)
    const bounds = imported.result.bounds!
    expect(bounds.max.map((value, axis) => value - bounds.min[axis])).toEqual(expect.arrayContaining(twoDimensional ? [expect.closeTo(6, 5), expect.closeTo(4, 5)] : [expect.closeTo(2, 5), expect.closeTo(3, 5), expect.closeTo(4, 5)]))
    const fresh = new NativeClient({ kernel: await BrowserKernel.create() })
    expect((await fresh.render(imported.plan)).bounds).toEqual(imported.result.bounds)
  }, 30000)

  it('keeps retained geometry usable after repeated assembly exports', async () => {
    const first = await client.construct('Box', [2, 3, 4]), second = await client.construct('Box', [1, 1, 1])
    for (const format of ['step', 'brep', 'stl', 'obj'] as const) {
      expect((await client.exportFile([first, second], format)).size).toBeGreaterThan(100)
      expect(await first.get('volume')).toBeCloseTo(24, 6)
      expect(await second.get('volume')).toBeCloseTo(1, 6)
    }
  })

  it('creates, seeks, modifies and releases byte and text streams locally', async () => {
    const binary = new Uint8Array([0, 1, 254, 255]), stream = await client.createStream(binary)
    expect(stream.kind).toBe('BytesIO'); expect(await client.readStream(stream)).toEqual(binary)
    expect(await stream.call('read', [2])).toEqual(new Uint8Array([0, 1]))
    expect(await stream.call('tell')).toBe(2)
    await stream.call('write', [new Uint8Array([42])]); expect(await stream.call('getvalue')).toEqual(new Uint8Array([0, 1, 42, 255]))
    await client.writeStream(stream, new Uint8Array([2, 3])); expect(await stream.call('tell')).toBe(0)
    const text = await client.createStream('hello λ\nnext')
    expect(text.kind).toBe('StringIO'); expect(await text.call('readline')).toBe('hello λ\n')
    expect(await client.readStream(text)).toBe('hello λ\nnext')
    const other = new NativeClient(); await expect(other.readStream(stream)).rejects.toThrow(/different client/)
    await stream.release(); await expect(client.readStream(stream)).rejects.toThrow(/released/)
  })

  it('uses the compatible file API with byte streams and virtual paths', async () => {
    const shape = await client.construct('Box', [2, 3, 4]), stream = await client.construct('BytesIO')
    expect(await client.callFunction('export_step', [shape, stream])).toBe(true)
    const content = await stream.call('getvalue') as Uint8Array
    expect(new TextDecoder().decode(content)).toContain('ISO-10303-21')
    await stream.call('seek', [0])
    const imported = await client.callFunction('import_step', [stream] as any)
    expect(await imported.get('volume')).toBeCloseTo(24, 6)
    const file = await client.uploadFile(new Blob([content.buffer as ArrayBuffer]), { filename: 'actual.step' })
    const fileShape = await client.callFunction('import_step', [file.path])
    expect(await fileShape.get('volume')).toBeCloseTo(24, 6)
  })

  it('exports real OBJ, glTF/GLB and 3MF mesh data', async () => {
    const obj = await (await client.exportFile(boxPlan, 'obj')).text()
    expect(obj.match(/^v /gm)?.length).toBe(24); expect(obj.match(/^f /gm)?.length).toBe(12)
    expect(obj).toMatch(/^vt /m); expect(obj).toMatch(/^vn /m)
    const gltf = JSON.parse(await (await client.exportFile(boxPlan, 'gltf')).text())
    expect(gltf.asset.version).toBe('2.0'); expect(gltf.meshes[0].primitives[0].attributes.TEXCOORD_0).toBeDefined()
    expect(gltf.accessors[gltf.meshes[0].primitives[0].indices].count).toBe(36)
    expect(gltf.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/)
    const glb = new DataView(await (await client.exportFile(boxPlan, 'glb')).arrayBuffer())
    expect(glb.getUint32(0, true)).toBe(0x46546c67); expect(glb.getUint32(4, true)).toBe(2); expect(glb.getUint32(8, true)).toBe(glb.byteLength)
    const archive = unzipSync(new Uint8Array(await (await client.exportFile(boxPlan, '3mf')).arrayBuffer()))
    const model = strFromU8(archive['3D/3dmodel.model'])
    expect(model.match(/<triangle /g)?.length).toBe(12); expect(model).toContain('unit="millimeter"')
    expect(archive['_rels/.rels']).toBeDefined()
  })

  it('round-trips Mesher 3MF geometry, labels, colors, metadata and UUIDs locally', async () => {
    const part = await client.construct('Box', [2, 3, 4])
    await part.set('label', 'My part'); await part.set('color', await client.construct('Color', ['#ff0000']))
    const writer = await client.construct('Mesher')
    const uuid = '12345678-1234-5678-1234-567812345678'
    await writer.call('add_shape', [part], { part_number: 'ABC-123', uuid_value: { $uuid: uuid } })
    await writer.call('add_meta_data', ['example.org', 'test', 'value λ', 'string', true])
    expect(await writer.get('mesh_count')).toBe(1)
    expect(await writer.get('triangle_counts')).toEqual([12]); expect(await writer.get('vertex_counts')).toEqual([8])
    const stream = await client.createStream()
    await writer.call('write_stream', [stream, '3mf'])
    const content = await client.readStream(stream) as Uint8Array
    const file = await client.uploadFile(content, { filename: 'part.3mf' })
    const reader = await client.construct('Mesher'), parts = await reader.call('read', [file.path])
    expect(parts).toHaveLength(1); expect(await client.get<number>(parts[0], 'volume')).toBeCloseTo(24, 5)
    expect(await parts[0].get('label')).toBe('My part')
    expect(await reader.call('get_mesh_properties')).toEqual([{ name: 'My part', part_number: 'ABC-123', type: 'MODEL', uuid }])
    expect(await reader.call('get_meta_data_by_key', ['example.org', 'test'])).toEqual({ type: 'string', value: 'value λ' })
  })

  it('imports actual SVG curves and refuses unsupported vector content', async () => {
    const imported = await client.importFile(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><path id="curve" fill="none" d="M0 0 C0 2 2 2 2 0 A1 1 0 0 1 4 0"/></svg>']), { format: 'svg' })
    expect(imported.result.meshes[0].name).toBe('curve'); expect(imported.result.meshes[0].edges.length).toBeGreaterThan(0)
    await expect(client.importFile(new Blob(['<svg><text>unsupported text</text></svg>']), { format: 'svg' })).rejects.toThrow(/conversion to paths/)
    await expect(client.importFile(new Blob(['not STEP']), { format: 'step' })).rejects.toThrow(/STEP/)
    await expect(client.importFile(new Blob(['not DXF']), { format: 'dxf' })).rejects.toThrow(/DXF/)
  })

  it('preserves SVG annulus holes and honors evenodd versus nonzero winding', async () => {
    const path = 'M5 0 A5 5 0 0 1 -5 0 A5 5 0 0 1 5 0 Z M2 0 A2 2 0 0 1 -2 0 A2 2 0 0 1 2 0 Z'
    const annulus = await client.importFile(new Blob([`<svg><path fill-rule="evenodd" d="${path}"/></svg>`]), { format: 'svg' })
    expect(annulus.result.meshes).toHaveLength(1)
    expect(annulus.result.meshes[0].area).toBeCloseTo(Math.PI * 21, 5)
    const filled = await client.importFile(new Blob([`<svg><path fill-rule="nonzero" d="${path}"/></svg>`]), { format: 'svg' })
    expect(filled.result.meshes).toHaveLength(1)
    expect(filled.result.meshes[0].area).toBeCloseTo(Math.PI * 25, 5)
  })

  it('encodes standalone file values and honors cancellation', async () => {
    expect(await nativeFile(new File([new Uint8Array([0, 1, 255])], 'part.step'))).toEqual({ $file: { name: 'part.step', base64: 'AAH/' } })
    const abort = new AbortController(); abort.abort()
    await expect(client.uploadFile(new Blob(['cancel']), { signal: abort.signal })).rejects.toThrow()
    await expect(client.exportFile(boxPlan, 'step', { signal: abort.signal })).rejects.toThrow()
  })
})
