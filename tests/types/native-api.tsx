import { b, Box, Cylinder, Fillet, Plane, Align, Mode, Axis, native, expr, NativeClient, NativeHandle } from '../../lib/index'

function expectType<Type>(_value: Type): void {}

// These declarations are checked by `npm run typecheck`; they never execute.
export async function nativeTypeConformance() {
  const client = new NativeClient()
  const box = await client.api.Box({ length: 20, width: 10, height: 8, align: Align.CENTER })
  expectType<NativeHandle<'Box'>>(box)
  const volume = await box.get('volume')
  expectType<number>(volume)
  const edges = await box.call('edges')
  expectType<NativeHandle<'ShapeList', NativeHandle<'Edge'>>>(edges)
  const vertical = await edges.call('filter_by', [Axis.Z])
  expectType<NativeHandle<'ShapeList', NativeHandle<'Edge'>>>(vertical)
  expectType<NativeHandle<'Edge'>>(await vertical.at(0))
  expectType<NativeHandle<'Edge'>[]>(await vertical.toArray())
  expectType<number>(await (await vertical.at(0)).get('length'))
  expectType<NativeHandle<'Solid'> | NativeHandle<'Part'>>(await box.call('fillet', [1, vertical]))
  await box.set('label', 'Mount')
  await box.set('color', native.Color(0.3, 0.4, 0.5))
  expectType<NativeHandle<'Solid'>>(await client.callStatic('Solid', 'make_box', [2, 3, 4]))
  expectType<NativeHandle<'Plane'>>(await client.getStatic('Plane', 'XY'))
  expectType<NativeHandle<'Box'>>(await client.construct('Box', [2], { width: 3, height: 4 }))
  expectType<boolean>(await client.callFunction('export_step', [box, 'mount.step']))
  const vector = await client.api.Vector({ X: 1, Y: 2, Z: 3 })
  expectType<NativeHandle<'Vector'>>(vector)
  expectType<NativeHandle<'Vector'>>(await vector.operator('round', 2))
  expectType<NativeHandle<'BytesIO'>>(await client.api.BytesIO({ initial_bytes: expr.bytes('AA==') }))
  expectType<NativeHandle<'StringIO'>>(await client.api.StringIO({ initial_value: 'svg' }))
  expectType<NativeHandle<'StringIO'>>(await client.api.StringIO({ initial_value: 'svg', newline: null }))
  expectType<typeof client.api.ColorIndex.RED>(client.api.ColorIndex.RED)

  const components = <>
    <Box length={20} width={10} height={8} mode={Mode.SUBTRACT} />
    <Box length={20} width={10} height={8} color={native.Color('red')} position={native.Vector(1, 2, 3)} />
    <Cylinder args={[2]} height={8} />
    <b.Box args={[2, 3, 4]} />
    <b.BuildSketch args={[Plane.XY]}><b.Circle radius={2} /></b.BuildSketch>
    <b.Compound label="Assembly"><Box length={2} width={3} height={4} /></b.Compound>
    <Fillet radius={1}><Box length={2} width={3} height={4} /></Fillet>
    <Fillet radius={1} objects={native.edges()} />
    <b.Line args={[[0, 0, 0], [10, 0, 0]]} />
    <b.extrude amount={expr.operator(2, 'mul', [3])}><b.Circle radius={2} /></b.extrude>
  </>
  expectType<React.ReactNode>(components)
  native.Vector(1, 2, 3)
  native.Vector([1, 2, 3])
  native.Location.withKwargs({ position: [1, 2, 3], orientation: [0, 0, 30] })
  native.Box.withKwargs({ width: 3, height: 4 }, 2)
  native.Solid.make_box(2, 3, 4)

  // @ts-expect-error Required dimensions also apply to named aliases.
  const missing = <Box />
  // @ts-expect-error Unknown constructor keyword.
  const misspelt = <Box length={2} width={3} height={4} lenght={5} />
  // @ts-expect-error Enum values are specific to their native enum.
  const wrongEnum = <Box length={2} width={3} height={4} align={Mode.ADD} />
  // @ts-expect-error Native symbolic vectors are not scalar dimensions.
  const wrongSymbol = <Box length={native.Vector(1, 2, 3)} width={3} height={4} />
  // @ts-expect-error Positionally supplied parameters cannot also be kwargs.
  const duplicate = <Box args={[2, 3, 4]} length={5} />
  // @ts-expect-error Overloads do not accept string coordinates.
  native.Vector('one', 'two')
  // @ts-expect-error Static calls use their actual required signature.
  native.Solid.make_box(2)
  // @ts-expect-error Closed keyword objects catch misspellings.
  await client.api.Box({ lenght: 2, width: 3, height: 4 })
  // @ts-expect-error Required root constructor arguments.
  await client.construct('Box')
  // @ts-expect-error Parameter type in positional/keyword combinations.
  await client.construct('Box', [2], { width: 'three', height: 4 })
  // @ts-expect-error Typed native handles constrain public method names.
  await box.call('definitely_not_a_method')
  // @ts-expect-error Known method arguments are not arbitrary JSON.
  await box.call('fillet', [true, vertical])
  // @ts-expect-error Typed native properties have concrete result types.
  expectType<string>(await box.get('volume'))
  // @ts-expect-error Read-only native properties cannot be set.
  await box.set('volume', 1)
  // @ts-expect-error Typed property names are validated.
  await box.get('volumme')
  // @ts-expect-error Typed native writable property values are validated.
  await box.set('label', 12)
  // @ts-expect-error Static member names are validated.
  await client.callStatic('Solid', 'not_a_method', [])
  // @ts-expect-error Static method argument types are validated.
  await client.callStatic('Solid', 'make_box', ['two', 3, 4])
  // @ts-expect-error Constructor overload keyword names are validated.
  await client.api.Vector({ xx: 1, yy: 2 })
  // @ts-expect-error Collection elements retain their actual native type.
  expectType<NativeHandle<'Face'>>(await vertical.at(0))
  void [missing, misspelt, wrongEnum, wrongSymbol, duplicate]
}

export async function nativeValueTypeConformance() {
  const client = new NativeClient()
  const shape = await client.api.Box({ length: 2, width: 3, height: 4 })
  await shape.set('position', [1, 2, 3])
  await shape.set('orientation', [0, 0, 45])
  await shape.set('color', 'red')
  await shape.set('color', [0.2, 0.4, 0.8, 0.5])
  await shape.set('material', 'PLA')
  expectType<string>(await shape.get('shape_type'))
  await shape.call('entities', ['Face'])
  expectType<Readonly<Record<string, NativeHandle<'Joint'>>> | null>(await shape.get('joints'))
  const selection = await (await shape.call('edges')).operator('gt', Axis.Z)
  expectType<NativeHandle<'ShapeList', NativeHandle<'Edge'>>>(selection)
  const stream = await client.api.BytesIO({ initial_bytes: expr.bytes('AA==') })
  expectType<Uint8Array>(await stream.call('getvalue'))
  expectType<number>(await stream.call('write', [new Uint8Array([1, 2])]))
  expectType<boolean>(await stream.get('closed'))
  native.import_svg(expr.file('model.svg', 'PHN2Zz48L3N2Zz4='))
  native.Edge.static('length')
  // @ts-expect-error Position setters accept vectors, not text.
  await shape.set('position', 'here')
  // @ts-expect-error Native material/opaque handles cannot be used as color scalars.
  await shape.set('color', 12)
  // @ts-expect-error Native stream writes require bytes.
  await stream.call('write', ['string'])
  // @ts-expect-error File markers apply to filenames, not geometric sweep paths.
  native.sweep.withKwargs({ path: expr.file('path.step', 'AA==') })
  // @ts-expect-error JSX colors accept native colors and color values, not booleans.
  const wrongMetadata = <Box length={2} width={3} height={4} color={true} />
  // @ts-expect-error StringIO newline has a string-or-null signature.
  await client.api.StringIO({ initial_value: 'text', newline: true })
  void wrongMetadata
}

export async function nativeCallableTypeConformance() {
  const client = new NativeClient()
  const box = await client.api.Box({ length: 2, width: 3, height: 4 })
  const reference = await (await box.call('faces')).at(0)
  const distance = await client.api.topo_distance_to({ other: reference })
  expectType<number>(await distance.invoke([reference]))
  await (await box.call('faces')).call('sort_by', [distance])
  // @ts-expect-error Callable annotations validate argument types.
  await distance.invoke(['shape'])
  // @ts-expect-error Callable annotations validate result types.
  expectType<string>(await distance.invoke([reference]))
  // @ts-expect-error Geometric shape instances are not callable sorting keys.
  await (await box.call('faces')).call('sort_by', [box])
  const expression = expr.apply(native.topo_distance_to(reference), [reference])
  const deferred = <Box length={expression} width={2} height={3} />
  void deferred
}
