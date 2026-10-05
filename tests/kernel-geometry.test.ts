import { beforeAll, describe, expect, test } from 'vitest'
import { initializeOpenCascade } from '../lib/kernel/runtime'
import { isEmptyShape, meshShape, registerGeometry, transformShape, unionShapes } from '../lib/kernel/geometry'
import type { KernelContext, KernelShape } from '../lib/kernel/types'

let context: KernelContext
beforeAll(async () => {
  const runtime = await initializeOpenCascade()
  context = { ...runtime, handlers: {}, references: new Map(), builders: [], current() { return this.builders.at(-1) }, invoke(name, args = [], kwargs = {}) { return this.handlers[name](args, kwargs, this) }, decode(value) { return value }, encode(value) { return value }, render() { throw new Error('Not required by geometry handlers') }, evaluatePlan() { throw new Error('Not required by geometry handlers') } }
  context.handlers = registerGeometry(context)
}, 120_000)
describe('browser OpenCascade geometry', () => {
  test('meshes analytic solids with exact BRep volume', () => {
    for (const [name, args, expected] of [ ['Box', [2,3,4], 24], ['Cylinder',[2,3],12*Math.PI], ['Cone',[2,1,3],7*Math.PI], ['Sphere',[2],32*Math.PI/3], ['Torus',[4,1],8*Math.PI*Math.PI] ] as const) {
      const value = context.invoke(name, [...args]) as KernelShape
      const mesh = meshShape(value)
      expect(mesh.volume, name).toBeCloseTo(expected, 7)
      expect(mesh.valid, name).toBe(true)
      expect(mesh.indices.length, name).toBeGreaterThan(0)
      expect(mesh.edges.every(edge => edge.length >= 6), name).toBe(true)
    }
  })
  test('performs BRep subtraction rather than changing mesh buffers', () => {
    const box = context.invoke('Box', [8,6,4]), hole = context.invoke('Cylinder', [1,8])
    const result = unionShapes([box,hole], 'SUBTRACT')!
    const mesh = meshShape(result)
    expect(mesh.volume).toBeCloseTo(192 - 4*Math.PI, 7)
    expect(mesh.valid).toBe(true)
  })
  test('preserves empty boolean identities and disjoint intersections',()=>{
    const box=context.invoke('Box',[2,3,4]), other=transformShape(box,{position:[20,0,0]})
    expect(unionShapes([box,other],'INTERSECT')).toBeNull()
    expect(unionShapes([box,box],'SUBTRACT')).toBeNull()
    const empty={__cadShape:true as const,shape:context.replicad.makeCompound([]),kind:'Compound'}
    expect(isEmptyShape(empty)).toBe(true)
    expect(unionShapes([empty,box],'SUBTRACT')).toBeNull()
    expect(unionShapes([empty,box],'INTERSECT')).toBeNull()
    expect(meshShape(unionShapes([empty,box],'ADD')!).volume).toBeCloseTo(24,7)
    expect(meshShape(unionShapes([box,empty],'SUBTRACT')!).volume).toBeCloseTo(24,7)
  })
  test('boolean assembly results retain their new BRep instead of stale children',()=>{
    const box=context.invoke('Box',[8,6,4]),hole=context.invoke('Cylinder',[1,8])
    const assembly=context.invoke('Compound',[],{children:[box]})
    const result=unionShapes([assembly,hole],'SUBTRACT')!
    expect(result.children).toBeUndefined()
    expect(meshShape(result).volume).toBeCloseTo(192-4*Math.PI,7)
    expect(box.shape.isNull).toBe(false)
  })
  test('extrudes a face in its native plane and applies edge fillets', () => {
    const face = { __cadShape: true as const, shape: context.replicad.sketchCircle(2).face(), kind: 'Circle' }
    const solid = context.invoke('extrude', [], {to_extrude:face,amount:3})
    expect(meshShape(solid).volume).toBeCloseTo(12*Math.PI, 7)
    context.builders.push({kind:'BuildPart',shape:context.invoke('Box',[10,8,6]),pending:[],plane:null,locations:[]})
    const filleted = context.invoke('fillet', [], {radius:1})
    expect(meshShape(filleted).volume).toBeLessThan(480)
    expect(meshShape(filleted).valid).toBe(true)
    context.builders.pop()
  })
  test('offsets planar faces and makes a genuine swept trace', () => {
    const face={__cadShape:true as const,shape:context.replicad.sketchRectangle(10,6).face(),kind:'Rectangle'}
    const offset=context.invoke('offset',[],{objects:face,amount:1,kind:'INTERSECTION'})[0]
    expect(meshShape(offset).area).toBeCloseTo(96,7)
    const line={__cadShape:true as const,shape:context.replicad.makeLine([0,0,0],[10,0,0]),kind:'Line'}
    const traced=context.invoke('trace',[],{lines:line,line_width:2})
    expect(meshShape(traced).area).toBeCloseTo(20,7)
    expect(meshShape(traced).valid).toBe(true)
  })
  test('constructs exact convex hulls from straight topology',()=>{
    const points=[[0,0,0],[4,0,0],[4,3,0],[0,3,0],[1,1,0]] as [number,number,number][]
    const edges=points.slice(1).map((point,index)=>({__cadShape:true as const,shape:context.replicad.makeLine(points[index],point),kind:'Edge'}))
    const hull=context.invoke('make_hull',[],{edges})
    expect(meshShape(hull).area).toBeCloseTo(12,7)
    expect(meshShape(hull).valid).toBe(true)
  })
  test('builds oriented convex polyhedra with native tetrahedron and cube volumes',()=>{
    const tetrahedron=context.invoke('ConvexPolyhedron',[],{points:[[0,0,0],[1,0,0],[0,1,0],[0,0,1]]})
    expect(meshShape(tetrahedron).volume).toBeCloseTo(1/6,7)
    expect(meshShape(tetrahedron).valid).toBe(true)
    for(const coordinate of tetrahedron.shape.boundingBox.bounds[0])expect(coordinate).toBeCloseTo(0,12)
    const points=[0,1].flatMap(x=>[0,1].flatMap(y=>[0,1].map(z=>[x,y,z])))
    const cube=context.invoke('ConvexPolyhedron',[],{points:[...points,[.5,.5,.5],[.5,.5,0]]})
    expect(meshShape(cube).volume).toBeCloseTo(1,7)
    expect(meshShape(cube).valid).toBe(true)
    expect(()=>context.invoke('ConvexPolyhedron',[],{points:[[0,0],[1,0],[1,1],[0,1]]})).toThrow(/three dimensions/)
  })
  test('base objects wrap retained topology without consuming original shapes',()=>{
    const box=context.invoke('Box',[2,3,4])
    const object=context.invoke('BasePartObject',[],{part:box,align:['MIN','MIN','MIN']})
    expect(meshShape(object).volume).toBeCloseTo(24,7)
    expect(object.shape.boundingBox.bounds[0].every((v:number)=>Math.abs(v)<1e-7)).toBe(true)
    expect(meshShape(box).volume).toBeCloseTo(24,7)
    const edge={__cadShape:true as const,shape:context.replicad.makeLine([0,0,0],[1,0,0]),kind:'Edge'}
    expect(context.invoke('BaseEdgeObject',[],{curve:edge}).shape.isSame(edge.shape)).toBe(true)
  })
  test('normalizes extrusion directions and honors the uniform scaling center',()=>{
    const face={__cadShape:true as const,shape:context.replicad.sketchCircle(2).face(),kind:'Face'}
    const extruded=context.invoke('extrude',[],{to_extrude:face,amount:3,dir:[0,0,2]})
    expect(meshShape(extruded).volume).toBeCloseTo(12*Math.PI,7)
    expect(extruded.shape.boundingBox.depth).toBeCloseTo(3,7)
    expect(()=>context.invoke('extrude',[],{to_extrude:face,amount:3,dir:[0,0,0]})).toThrow(/nonzero/)
    const box=context.invoke('Box',[2,3,4]),scaled=context.invoke('scale',[],{objects:box,by:2,about:[10,0,0]})[0]
    expect(meshShape(scaled).volume).toBeCloseTo(192,7)
    expect(scaled.shape.boundingBox.center[0]).toBeCloseTo(-10,7)
    expect(()=>context.invoke('sweep',[],{multisection:true})).toThrow(/not yet available/)
    expect(()=>context.invoke('sweep',[],{normal:[0,0,1]})).toThrow(/not yet available/)
  })
  test('uses canonical positional hole depth and countersink angle',()=>{
    const sink=context.invoke('CounterSinkHole',[1,2,8,90])
    expect(meshShape(sink).volume).toBeCloseTo(28*Math.PI/3,6)
    const bore=context.invoke('CounterBoreHole',[1,2,2,8])
    expect(meshShape(bore).volume).toBeCloseTo(14*Math.PI,6)
    expect(()=>context.invoke('Hole',[1])).toThrow(/depth must be provided/)
  })
})
