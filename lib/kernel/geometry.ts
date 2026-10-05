import * as R from 'replicad'
import type { MeshData, RenderOptions } from '../types'
import { isKernelShape, shapeList, shapeValue, type KernelContext, type KernelHandler, type KernelShape } from './types'

const radians = (angle: number) => angle * Math.PI / 180
const enumName = (value: any) => String(value?.name ?? value?.value ?? value ?? '').split('.').at(-1)
export function tuple(value: any, fallback: number[] = [0, 0, 0]): [number, number, number] {
  const v = value?.toArray?.() ?? value?.toTuple?.() ?? value
  if (Array.isArray(v)) return [Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)]
  if (v && typeof v === 'object') return [Number(v.X ?? v.x ?? 0), Number(v.Y ?? v.y ?? 0), Number(v.Z ?? v.z ?? 0)]
  return fallback as [number, number, number]
}
export function asPlane(value: any): R.Plane {
  if (value instanceof R.Plane) return value
  if (typeof value === 'string') return R.makePlane(value as R.PlaneName)
  return new R.Plane(tuple(value?.origin), tuple(value?.x_dir ?? value?.xDir, [1, 0, 0]), tuple(value?.z_dir ?? value?.zDir, [0, 0, 1]))
}
function metadata(value: KernelShape): Partial<KernelShape> {
  return { label: value.label, color: value.color, assemblyPath: value.assemblyPath }
}
export function transformShape(value: KernelShape, options: { position?: any; rotation?: any; scale?: number; about?: any } = {}): KernelShape {
  const transform = (shape: R.AnyShape) => {
    let result = shape.clone()
    if (options.scale !== undefined) result = result.scale(options.scale,tuple(options.about))
    const rotation = typeof options.rotation === 'number' ? [0, 0, options.rotation] : tuple(options.rotation)
    // build123d intrinsic XYZ is the equivalent extrinsic Z, Y, X sequence.
    if (rotation[2]) result = result.rotate(rotation[2], [0, 0, 0], [0, 0, 1])
    if (rotation[1]) result = result.rotate(rotation[1], [0, 0, 0], [0, 1, 0])
    if (rotation[0]) result = result.rotate(rotation[0], [0, 0, 0], [1, 0, 0])
    if (options.position) result = result.translate(tuple(options.position))
    return result
  }
  return shapeValue(transform(value.shape), value.kind, { ...metadata(value), ...(value.children ? { children: value.children.map(child => transformShape(child, options)) } : {}) })
}
/** Empty boolean results have no vertex topology and must not reach meshing/bounds. */
export function isEmptyShape(value: KernelShape | R.AnyShape): boolean {
  const shape=isKernelShape(value)?value.shape:value
  if(shape.isNull)return true
  const oc=R.getOC() as any,explorer=new oc.TopExp_Explorer(shape.wrapped,oc.TopAbs_ShapeEnum.TopAbs_VERTEX,oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
  try{return !explorer.More()}finally{explorer.delete()}
}
export function unionShapes(values: KernelShape[], mode: any = 'ADD'): KernelShape | null {
  if (!values.length) return null
  const name = enumName(mode)
  if (name === 'PRIVATE') return isEmptyShape(values.at(-1)!)?null:values.at(-1)!
  if(name==='INTERSECT'&&values.some(isEmptyShape))return null
  if(name==='SUBTRACT'&&isEmptyShape(values[0]))return null
  const inputs=values.filter(value=>!isEmptyShape(value))
  if(!inputs.length)return null
  const bool = (left: R.AnyShape, right: R.AnyShape): R.AnyShape | null => {
    const oc = R.getOC() as any
    const operation = name === 'SUBTRACT' ? new oc.BRepAlgoAPI_Cut(left.wrapped, right.wrapped) : name === 'INTERSECT' ? new oc.BRepAlgoAPI_Common(left.wrapped, right.wrapped) : new oc.BRepAlgoAPI_Fuse(left.wrapped, right.wrapped)
    try {
      const native=operation.Shape()
      if(native.IsNull())return null
      const result=R.cast(native)
      if(isEmptyShape(result)){result.delete();return null}
      return result.simplify()
    } finally { operation.delete() }
  }
  let combined: R.AnyShape | null = inputs[0].shape.clone()
  for (const value of inputs.slice(1)) { combined=bool(combined!,value.shape);if(!combined)return null }
  return shapeValue(combined!,inputs.length===1?inputs[0].kind:'Compound',{...metadata(inputs[0]),...(inputs.length===1&&inputs[0].children?{children:inputs[0].children}:{})})
}
function get(args: any[], kwargs: Record<string, any>, name: string, index: number, fallback?: any): any {
  return kwargs[name] !== undefined ? kwargs[name] : args[index] !== undefined ? args[index] : fallback
}
function requirePositive(value: number, name: string) { if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} must be greater than zero`); return value }
function alignShape(shape: R.AnyShape, align: any = ['CENTER', 'CENTER', 'CENTER']): R.AnyShape {
  if (align === null) return shape
  const alignment = Array.isArray(align) ? align : [align, align, align]
  const [min, max] = shape.boundingBox.bounds
  const shifts = min.map((v, i) => enumName(alignment[i]) === 'MIN' ? -v : enumName(alignment[i]) === 'MAX' ? -max[i] : enumName(alignment[i]) === 'CENTER' ? -(v + max[i]) / 2 : 0)
  return shape.translate(shifts as R.Point)
}
function primitive(shape: R.AnyShape, kind: string, args: any[], kwargs: Record<string, any>, rotationIndex: number, alignIndex: number): KernelShape {
  return transformShape(shapeValue(alignShape(shape, get(args, kwargs, 'align', alignIndex)), kind), { rotation: get(args, kwargs, 'rotation', rotationIndex, [0, 0, 0]) })
}
function made(builder: any): R.AnyShape {
  try { const result = R.cast(builder.Shape()); if (result.isNull) throw new Error('OpenCascade returned an empty shape'); return result } finally { builder.delete() }
}
function operands(args: any[], kwargs: Record<string, any>, context: KernelContext, name = 'objects', index = 0): KernelShape[] {
  const explicit = get(args, kwargs, name, index)
  if (explicit !== undefined && explicit !== null) return shapeList(explicit)
  const current = context.current()
  return current?.pending.length ? current.pending.slice() : current?.shape ? [current.shape] : []
}
function requireShapes(shapes: KernelShape[], operation: string) { if (!shapes.length) throw new Error(`${operation} requires an input shape`); return shapes }
function owner(shapes: KernelShape[], ctx: KernelContext): KernelShape {
  const selectedOwner = (shapes[0] as any)?.owner
  const result = ctx.current()?.shape ?? selectedOwner ?? shapes.find(v => v.shape instanceof R.Solid || v.shape instanceof R.Compound)
  if (!result) throw new Error('This operation requires the owning shape of its selected topology')
  return result
}
function faceWires(shape: KernelShape): R.Wire[] {
  if (shape.shape instanceof R.Face) return [shape.shape.clone().outerWire()]
  if (shape.shape instanceof R.Wire) return [shape.shape]
  return shape.shape.faces.length ? shape.shape.faces.map(face => face.clone().outerWire()) : shape.shape.wires
}
function extrudeShape(value: KernelShape, amount: number, direction?: any): KernelShape {
  const input = direction ? tuple(direction) : value.shape instanceof R.Face ? value.shape.normalAt().toTuple() : value.shape.faces[0]?.normalAt().toTuple() ?? [0, 0, 1]
  const length=Math.hypot(...input)
  if(!Number.isFinite(length)||length===0)throw new Error('Extrusion direction must be a finite nonzero vector')
  const normal=input.map(v=>v/length)
  const vector = new (R.getOC() as any).gp_Vec(...normal.map((v: number) => v * amount))
  try { return shapeValue(made(new (R.getOC() as any).BRepPrimAPI_MakePrism(value.shape.wrapped, vector, true, true)), 'Part', metadata(value)) } finally { vector.delete() }
}
function draftShape(value: KernelShape, faces: R.Face[], plane: R.Plane, angle: number): KernelShape {
  const oc = R.getOC() as any
  const operation = new oc.BRepOffsetAPI_DraftAngle(value.shape.wrapped)
  const dir = R.asDir(plane.zDir), pln = R.makePln(plane.origin, plane.zDir)
  try {
    for (const face of faces) {
      operation.Add(face.wrapped, dir, radians(angle), pln, true)
      if (!operation.AddDone()) throw new Error('OpenCascade could not draft the selected face')
    }
    operation.Build()
    return shapeValue(R.cast(operation.Shape()), 'Part', metadata(value))
  } finally { dir.delete(); pln.delete(); operation.delete() }
}

function solveThree(rows: number[][]): number[] {
  const matrix = rows.map(row => row.slice())
  for (let i = 0; i < 3; i++) {
    let pivot = i
    for (let j = i + 1; j < 3; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j
    ;[matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]]
    if (Math.abs(matrix[i][i]) < 1e-10) throw new Error('Unable to construct an inscribed rounding circle')
    const denominator = matrix[i][i]
    for (let j = i; j < 4; j++) matrix[i][j] /= denominator
    for (let k = 0; k < 3; k++) if (k !== i) {
      const factor = matrix[k][i]
      for (let j = i; j < 4; j++) matrix[k][j] -= factor * matrix[i][j]
    }
  }
  return matrix.map(row => row[3])
}
/** Exact full-round solution for the three straight edges adjoining a polygon end. */
function fullRound(selected: KernelShape, invert: boolean): KernelShape {
  if (!(selected.shape instanceof R.Edge)) throw new Error('full_round requires one edge')
  const parent = (selected as any).owner as KernelShape | undefined
  if (!parent) throw new Error('full_round edge must be extracted from a face')
  const edge = selected.shape, faces = parent.shape.faces
  const face = parent.shape instanceof R.Face ? parent.shape : faces[0]
  if (!face) throw new Error('full_round requires a planar face')
  const normal = face.normalAt(), plane = new R.Plane(face.center,face.clone().outerWire().edges[0].tangentAt(),normal)
  const close = (a: R.Vector, b: R.Vector) => a.sub(b).Length < 1e-6
  const adjacent = parent.shape.edges.filter(other => !other.isSame(edge) && [other.startPoint, other.endPoint].some(point => close(point, edge.startPoint) || close(point, edge.endPoint)))
  if (adjacent.length !== 2 || [edge, ...adjacent].some(e => e.geomType !== 'LINE')) throw new Error('full_round currently requires three connected straight edges')
  const center = plane.toLocalCoords(face.center).toTuple()
  const constraints = [edge,...adjacent].map(e => {
    const start = plane.toLocalCoords(e.startPoint).toTuple(), end = plane.toLocalCoords(e.endPoint).toTuple()
    let nx = -(end[1]-start[1]), ny = end[0]-start[0]; const length = Math.hypot(nx,ny); nx/=length;ny/=length
    if (nx*(center[0]-start[0])+ny*(center[1]-start[1])<0){nx=-nx;ny=-ny}
    return [nx,ny,-1,nx*start[0]+ny*start[1]]
  })
  const [cx,cy,radius] = solveThree(constraints)
  if (!(radius>0))throw new Error('The selected polygon end cannot be rounded')
  const tangent = constraints.map(row=>plane.toWorldCoords([cx-row[0]*radius,cy-row[1]*radius,0]))
  const middle=invert?plane.toWorldCoords([2*cx-plane.toLocalCoords(tangent[0]).x,2*cy-plane.toLocalCoords(tangent[0]).y,0]):tangent[0]
  const trimmed=adjacent.map((e,i)=>{
    const far=[e.startPoint,e.endPoint].find(p=>!close(p,edge.startPoint)&&!close(p,edge.endPoint))
    if(!far)throw new Error('Adjacent edge has no remaining segment after rounding')
    return R.makeLine(far,tangent[i+1])
  })
  const remaining=parent.shape.edges.filter(e=>!e.isSame(edge)&&!adjacent.some(a=>a.isSame(e)))
  const arc=R.makeThreePointArc(tangent[1],middle,tangent[2])
  let result=R.makeFace(R.assembleWire([...remaining,...trimmed,arc]),face.clone().innerWires())
  if(result.normalAt().dot(normal)<0)result=result.flipOrientation()
  return shapeValue(result,'Sketch',metadata(parent))
}

function brakeFormed(input: KernelShape, thickness: number, stationWidths: any, side: any, kind: any): KernelShape {
  const edges=input.shape instanceof R.Edge?[input.shape]:input.shape.edges
  if(edges.length<2 || edges.some(edge=>edge.geomType!=='LINE'))throw new Error('make_brake_formed currently requires a bent straight-segment polyline')
  const points:R.Vector[]=[edges[0].startPoint]
  for(const edge of edges){const last=points.at(-1)!;points.push(last.sub(edge.startPoint).Length<1e-6?edge.endPoint:edge.startPoint)}
  const normal=points[1].sub(points[0]).cross(points[2].sub(points[1])).normalized()
  const plane=new R.Plane(points[0],points[1].sub(points[0]).normalized(),normal)
  const local=points.map(p=>plane.toLocalCoords(p).toTuple()), sign=enumName(side)==='RIGHT'?-1:1
  const directions=local.slice(1).map((p,i)=>{const dx=p[0]-local[i][0],dy=p[1]-local[i][1],n=Math.hypot(dx,dy);return[dx/n,dy/n]})
  const normals=directions.map(d=>[-d[1]*sign,d[0]*sign])
  const offsets:number[][]=[local[0].map((v,i)=>v+(normals[0][i]??0)*thickness)]
  for(let i=1;i<local.length-1;i++){
    const a=normals[i-1],b=normals[i],point=local[i]
    const determinant=a[0]*b[1]-a[1]*b[0]
    if(Math.abs(determinant)<1e-8)throw new Error('Collinear brake stations must be simplified before forming')
    const turn=directions[i-1][0]*directions[i][1]-directions[i-1][1]*directions[i][0]
    if(turn*sign<0 && enumName(kind)!=='INTERSECTION')throw new Error('Arc joins at external brake corners are not yet available')
    const ca=a[0]*point[0]+a[1]*point[1]+thickness,cb=b[0]*point[0]+b[1]*point[1]+thickness
    offsets.push([(ca*b[1]-a[1]*cb)/determinant,(a[0]*cb-ca*b[0])/determinant,0])
  }
  offsets.push(local.at(-1)!.map((v,i)=>v+(normals.at(-1)![i]??0)*thickness))
  const widths=typeof stationWidths==='number'?points.map(()=>stationWidths):Array.from(stationWidths??[]) as number[]
  if(widths.length!==points.length)throw new Error('station_widths must have one value per polyline vertex')
  // Match build123d stations: only offset vertices one thickness from each source vertex qualify.
  const stations=points.flatMap((point)=>{
    const eligible=offsets.map(p=>plane.toWorldCoords(p as R.Point)).filter(p=>Math.abs(point.sub(p).Length-thickness)<1e-2)
    return eligible.length?[{point,offset:eligible[0]}]:[]
  })
  if(stations.length<2)throw new Error('The line does not provide two suitable brake stations')
  const wires=stations.map((station,i)=>{
    const width=requirePositive(widths[i],'station_widths'),rise=normal.multiply(width)
    const face=R.makePolygon([station.point,station.offset,station.offset.add(rise),station.point.add(rise)])
    return face.outerWire()
  })
  return shapeValue(R.loft(wires,{ruled:true},false),'Part',metadata(input))
}

/** Native planar wire offset; open wires use OCCT's closed, two-sided contour. */
export function offsetShape2D(value: KernelShape, distance: number, kind: any = 'ARC', side: any = 'BOTH', closed = true): KernelShape {
  if (!Number.isFinite(distance)) throw new Error('offset distance must be finite')
  if (!distance) return shapeValue(value.shape.clone(),value.kind,metadata(value))
  const oc=R.getOC() as any, join=enumName(kind)==='INTERSECTION'?oc.GeomAbs_JoinType.GeomAbs_Intersection:oc.GeomAbs_JoinType.GeomAbs_Arc
  let source=value.shape
  if(source instanceof R.Edge){const edge=source;source=R.assembleWire(edge.geomType==='LINE'?[R.makeLine(edge.startPoint,edge.pointAt(.5)),R.makeLine(edge.pointAt(.5),edge.endPoint)]:[edge.clone()])}
  if(!(source instanceof R.Face || source instanceof R.Wire))throw new Error('2D offset requires a planar face, edge or wire')
  if(source instanceof R.Wire && !source.isClosed && enumName(side)!=='BOTH')throw new Error('One-sided offsets of open wires are not yet available')
  if(source instanceof R.Wire && !source.isClosed && !closed)throw new Error('An open two-sided offset must form a closed contour')
  const operation=new oc.BRepOffsetAPI_MakeOffset(source.wrapped,join,false)
  try{
    operation.Perform(distance,0)
    const result=R.cast(operation.Shape())
    if(source instanceof R.Face){
      const wires=result instanceof R.Wire?[result]:result.wires
      if(!wires.length)throw new Error('Offset removed all face boundaries')
      const ordered=wires.sort((a,b)=>R.measureLength(b)-R.measureLength(a))
      let face=R.makeFace(ordered[0],ordered.slice(1))
      if(face.normalAt().dot(source.normalAt())<0)face=face.flipOrientation()
      return shapeValue(face,'Sketch',metadata(value))
    }
    return shapeValue(result,'Wire',metadata(value))
  }finally{operation.delete()}
}

function convexHull(inputs: KernelShape[], plane: R.Plane): KernelShape {
  const edges=inputs.flatMap(value=>value.shape instanceof R.Edge?[value.shape]:value.shape.edges)
  if(edges.some(edge=>edge.geomType!=='LINE'))throw new Error('make_hull currently supports straight edges; curved-edge tangent hulls are not yet available')
  const points=edges.flatMap(edge=>[edge.startPoint,edge.endPoint]).map(point=>plane.toLocalCoords(point).toTuple())
  if(points.some(point=>Math.abs(point[2])>1e-6))throw new Error('make_hull inputs must lie in the workplane')
  const unique=Array.from(new Map(points.map(point=>[`${point[0]},${point[1]}`,point])).values()).sort((a,b)=>a[0]-b[0]||a[1]-b[1])
  const cross=(a:number[],b:number[],c:number[]) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
  const half=(ordered:number[][])=>{const result:number[][]=[];for(const point of ordered){while(result.length>=2&&cross(result.at(-2)!,result.at(-1)!,point)<=0)result.pop();result.push(point)}return result}
  const lower=half(unique),upper=half(unique.slice().reverse());lower.pop();upper.pop()
  const hull=[...lower,...upper]
  if(hull.length<3)throw new Error('make_hull requires three non-collinear points')
  return shapeValue(R.makePolygon(hull.map(point=>plane.toWorldCoords(point as R.Point))),'Sketch')
}

function traceWire(inputs: KernelShape[], lineWidth: number, plane: R.Plane): KernelShape {
  const edges=inputs.flatMap(value=>value.shape instanceof R.Edge?[value.shape.clone()]:value.shape.edges)
  const wire=R.assembleWire(edges), tangent=wire.tangentAt(0), normal=plane.zDir
  if(Math.abs(tangent.dot(normal))>1e-6)throw new Error('trace requires a path in the workplane')
  const offset=normal.cross(tangent).normalized().multiply(lineWidth/2),start=wire.startPoint
  const pen=R.assembleWire([R.makeLine(start.sub(offset),start.add(offset))]),oc=R.getOC() as any
  const operation=new oc.BRepOffsetAPI_MakePipeShell(wire.wrapped)
  try{
    operation.SetMode(false);operation.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner)
    operation.Add(pen.wrapped,false,false);operation.Build()
    const shell=R.cast(operation.Shape()),faces=shell.faces.map(face=>shapeValue(face,'Sketch'))
    return unionShapes(faces)!
  }finally{operation.delete()}
}

function convexPolyhedron(vertices: any[]): R.Solid {
  const points=Array.from(new Map(vertices.map(value=>{const point=tuple(value);if(point.some(v=>!Number.isFinite(v)))throw new Error('ConvexPolyhedron points must be finite');return[point.join(','),point] as const})).values())
  if(points.length<4)throw new Error('ConvexPolyhedron requires at least four non-coplanar points')
  const epsilon=Math.max(1,...points.flat().map(Math.abs))*1e-8
  const sub=(a:number[],b:number[])=>a.map((v,i)=>v-b[i]),cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a:number[],b:number[])=>a.reduce((v,x,i)=>v+x*b[i],0)
  const planes=new Map<string,{normal:number[];indices:number[]}>()
  for(let i=0;i<points.length-2;i++)for(let j=i+1;j<points.length-1;j++)for(let k=j+1;k<points.length;k++){
    let normal=cross(sub(points[j],points[i]),sub(points[k],points[i])),length=Math.hypot(...normal)
    if(length<epsilon)continue
    normal=normal.map(v=>v/length)
    const distances=points.map(point=>dot(normal,sub(point,points[i])))
    if(distances.some(d=>d>epsilon)&&distances.some(d=>d< -epsilon))continue
    if(!distances.some(d=>Math.abs(d)>epsilon))continue
    if(distances.some(d=>d>epsilon))normal=normal.map(v=>-v)
    const indices=points.flatMap((point,index)=>Math.abs(dot(normal,sub(point,points[i])))<=epsilon?[index]:[])
    const key=indices.join(',')
    planes.set(key,{normal,indices})
  }
  if(planes.size<4)throw new Error('ConvexPolyhedron points must span three dimensions')
  const faces=Array.from(planes.values()).map(({normal,indices})=>{
    const origin=points[indices[0]],xDirection=sub(points[indices[1]],origin),plane=new R.Plane(origin as R.Point,xDirection as R.Point,normal as R.Point)
    const local=indices.map(i=>plane.toLocalCoords(new R.Vector(points[i])).toTuple()).sort((a,b)=>a[0]-b[0]||a[1]-b[1])
    const turn=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    const half=(items:number[][])=>{const out:number[][]=[];for(const point of items){while(out.length>=2&&turn(out.at(-2)!,out.at(-1)!,point)<=epsilon)out.pop();out.push(point)}return out}
    const lower=half(local),upper=half(local.slice().reverse());lower.pop();upper.pop()
    let face=R.makePolygon([...lower,...upper].map(point=>plane.toWorldCoords(point as R.Point)))
    if(face.normalAt().dot(new R.Vector(normal as R.Point))<0)face=face.flipOrientation()
    return face
  })
  return R.makeSolid(faces)
}

export function registerGeometry(context: KernelContext): Record<string, KernelHandler> {
  const oc = context.oc
  const handlers: Record<string, KernelHandler> = {
    Box: (a, k) => { const x = requirePositive(get(a,k,'length',0), 'length'), y = requirePositive(get(a,k,'width',1), 'width'), z = requirePositive(get(a,k,'height',2), 'height'); return primitive(R.makeBox([0,0,0],[x,y,z]), 'Box', a,k,3,4) },
    Cylinder: (a,k) => { const r = requirePositive(get(a,k,'radius',0),'radius'), h = requirePositive(get(a,k,'height',1),'height'), arc = get(a,k,'arc_size',2,360); return primitive(made(new oc.BRepPrimAPI_MakeCylinder(r,h,radians(arc))), 'Cylinder',a,k,3,4) },
    Cone: (a,k) => { const r0 = get(a,k,'bottom_radius',0), r1 = get(a,k,'top_radius',1), h = requirePositive(get(a,k,'height',2),'height'); if (r0 < 0 || r1 < 0 || Math.max(r0,r1) <= 0) throw new Error('Cone radii must be non-negative and at least one positive'); const points = [[0,0,0],[r0,0,0],[r1,0,h],[0,0,h]].filter((p,i,v) => i === 0 || p.some((x,j) => x !== v[i-1][j])); const face = R.makePolygon(points as R.Point[]); const ax = R.makeAx1([0,0,0],[0,0,1]); let shape: R.AnyShape; try { shape = made(new oc.BRepPrimAPI_MakeRevol(face.wrapped,ax,radians(get(a,k,'arc_size',3,360)),true)) } finally { ax.delete() } return primitive(shape,'Cone',a,k,4,5) },
    Sphere: (a,k) => primitive(made(new oc.BRepPrimAPI_MakeSphere(requirePositive(get(a,k,'radius',0),'radius'),radians(get(a,k,'arc_size1',1,-90)),radians(get(a,k,'arc_size2',2,90)),radians(get(a,k,'arc_size3',3,360)))), 'Sphere',a,k,4,5),
    Torus: (a,k) => primitive(made(new oc.BRepPrimAPI_MakeTorus(requirePositive(get(a,k,'major_radius',0),'major_radius'),requirePositive(get(a,k,'minor_radius',1),'minor_radius'),radians(get(a,k,'minor_start_angle',2,0)),radians(get(a,k,'minor_end_angle',3,360)),radians(get(a,k,'major_angle',4,360)))), 'Torus',a,k,5,6),
    Wedge: (a,k) => {
      const x = requirePositive(get(a,k,'xsize',0),'xsize'), y = requirePositive(get(a,k,'ysize',1),'ysize'), z = requirePositive(get(a,k,'zsize',2),'zsize'), xmin = get(a,k,'xmin',3), zmin = get(a,k,'zmin',4), xmax = get(a,k,'xmax',5), zmax = get(a,k,'zmax',6)
      const vertices: R.Point[] = [[0,0,0],[x,0,0],[x,0,z],[0,0,z],[xmin,y,zmin],[xmax,y,zmin],[xmax,y,zmax],[xmin,y,zmax]]
      const faces = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].map(indices => R.makePolygon(indices.map(i => vertices[i])))
      return primitive(R.makeSolid(faces),'Wedge',a,k,7,8)
    },
    ConvexPolyhedron: (a,k) => primitive(convexPolyhedron(Array.from(get(a,k,'points',0)??[])),'ConvexPolyhedron',a,{align:get(a,k,'align',2,'NONE'),...k},1,2),
    Vertex: (a,k) => shapeValue(R.makeVertex(k.v !== undefined ? tuple(k.v) : a.length === 1 ? tuple(a[0]) : tuple(a)), 'Vertex'),
    extrude: (a,k,ctx) => {
      const inputs = requireShapes(operands(a,k,ctx,'to_extrude',0),'extrude'), amount = get(a,k,'amount',1)
      if (amount === undefined) throw new Error('extrude currently requires amount; until extrusion is unavailable in browser bindings')
      const results = inputs.map(input => {
        const taper = get(a,k,'taper',6,0)
        const make=(distance:number)=>{
          let value=extrudeShape(input,distance,get(a,k,'dir',2))
          if(taper){
            const dir=get(a,k,'dir',2),normal=dir?tuple(dir):input.shape instanceof R.Face?input.shape.normalAt().toTuple():input.shape.faces[0]?.normalAt().toTuple()??[0,0,1]
            const direction=new R.Vector(normal as R.Point).normalized().multiply(Math.sign(distance)||1)
            const plane=new R.Plane(input.shape.boundingBox.center,null,direction)
            value=draftShape(value,value.shape.faces.filter(face=>Math.abs(face.normalAt().dot(direction))<1e-6),plane,taper)
          }
          return value
        }
        let value=make(amount)
        if (get(a,k,'both',5,false)) value = unionShapes([value,make(-amount)])!
        return value
      })
      if (ctx.current()) ctx.current()!.pending = []
      return unionShapes(results)!
    },
    revolve: (a,k,ctx) => {
      const inputs = requireShapes(operands(a,k,ctx,'profiles',0),'revolve'), axis = get(a,k,'axis',1,{position:[0,0,0],direction:[0,0,1]}), arc = get(a,k,'revolution_arc',2,360), ax = R.makeAx1(tuple(axis.position),tuple(axis.direction,[0,0,1]))
      try { const results = inputs.map(v => shapeValue(made(new oc.BRepPrimAPI_MakeRevol(v.shape.wrapped,ax,radians(arc),true)),'Part',metadata(v))); if (ctx.current()) ctx.current()!.pending = []; return unionShapes(results)! } finally { ax.delete() }
    },
    loft: (a,k,ctx) => { const inputs = requireShapes(operands(a,k,ctx,'sections',0),'loft'); const wires = inputs.flatMap(faceWires); if (wires.length < 2) throw new Error('loft requires at least two sections'); const value = shapeValue(R.loft(wires,{ruled:get(a,k,'ruled',1,false)},false),'Part'); if (ctx.current()) ctx.current()!.pending=[]; return value },
    sweep: (a,k,ctx) => {
      if(get(a,k,'multisection',2,false))throw new Error('Sweep multisection profiles are not yet available')
      if(get(a,k,'normal',5)!=null || get(a,k,'binormal',6)!=null)throw new Error('Sweep normal and binormal guides are not yet available')
      const current = ctx.current(); const pathInput = get(a,k,'path',1) ?? current?.pending.at(-1)
      const pathShapes = shapeList(pathInput), path = pathShapes[0]?.shape instanceof R.Wire ? pathShapes[0].shape : pathShapes[0] ? R.assembleWire(pathShapes[0].shape.edges) : null
      const profiles = get(a,k,'sections',0) !== undefined ? shapeList(get(a,k,'sections',0)) : (current?.pending ?? []).filter(v => !pathShapes.some(p=>p.shape.isSame(v.shape)))
      if (!path || !profiles.length) throw new Error('sweep requires a profile and a path')
      const values = profiles.map(profile => {
        const wires=profile.shape instanceof R.Face?[profile.shape.clone().outerWire(),...profile.shape.clone().innerWires()]:faceWires(profile)
        const swept=wires.map(wire=>{
          const operation=new oc.BRepOffsetAPI_MakePipeShell(path.wrapped)
          try{
            operation.SetMode(get(a,k,'is_frenet',3,false))
            const transition=enumName(get(a,k,'transition',4,'TRANSFORMED'))
            operation.SetTransitionMode(transition==='ROUND'?oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner:transition==='RIGHT'?oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner:oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed)
            operation.Add(wire.wrapped,false,false);operation.Build()
            if(!operation.MakeSolid())throw new Error('OpenCascade could not close the swept profile')
            return shapeValue(R.cast(operation.Shape()),'Part')
          }finally{operation.delete()}
        })
        return unionShapes(swept,'SUBTRACT')!
      })
      if (current) current.pending = []
      return unionShapes(values)!
    },
    fillet: (a,k,ctx) => { const selected=shapeList(get(a,k,'objects',0)), body=owner(selected,ctx), radius=requirePositive(get(a,k,'radius',1),'radius'); return shapeValue(body.shape.asShape3D().fillet(radius, selected.length ? finder => finder.inList(selected.map(v=>v.shape as R.Edge)) : undefined),'Part',metadata(body)) },
    chamfer: (a,k,ctx) => {
      const selected=shapeList(get(a,k,'objects',0)),body=owner(selected,ctx),length=requirePositive(get(a,k,'length',1),'length'),length2=get(a,k,'length2',2),angle=get(a,k,'angle',3),reference=get(a,k,'reference',4)
      if(length2!=null&&angle!=null)throw new Error('Only one of length2 or angle may be supplied')
      if(reference!=null&&length2==null&&angle==null)throw new Error('reference requires length2 or angle')
      if(!(body.shape instanceof R.Solid || body.shape instanceof R.Compound))throw new Error('Vertex chamfers on planar faces are not yet available')
      if(length2==null&&angle==null)return shapeValue(body.shape.asShape3D().chamfer(length,selected.length?finder=>finder.inList(selected.map(v=>v.shape as R.Edge)):undefined),'Part',metadata(body))
      const other=angle!=null?length*Math.tan(radians(angle)):length2
      requirePositive(other,'length2')
      if(reference!=null && (!isKernelShape(reference)||!(reference.shape instanceof R.Face)))throw new Error('A solid chamfer reference must be a face')
      const operation=new oc.BRepFilletAPI_MakeChamfer(body.shape.wrapped)
      for(const edge of selected.length?selected.map(v=>v.shape):body.shape.edges){
        if(!(edge instanceof R.Edge))throw new Error('Solid chamfers require edges')
        const face=reference?.shape??body.shape.faces.find(face=>face.edges.some(candidate=>candidate.isSame(edge)))
        if(!face){operation.delete();throw new Error('The chamfer edge must belong to the reference face')}
        operation.Add(length,other,edge.wrapped,face.wrapped)
      }
      return shapeValue(made(operation),'Part',metadata(body))
    },
    mirror: (a,k,ctx) => { const plane=asPlane(get(a,k,'about',1)), inputs=requireShapes(operands(a,k,ctx),'mirror'); return inputs.map(v=>shapeValue(v.shape.clone().mirror(plane),'Part',metadata(v))) },
    scale: (a,k,ctx) => { const factor=get(a,k,'by',1,1); if (typeof factor!=='number') throw new Error('Nonuniform scaling requires a general affine transform and is not available'); if(!Number.isFinite(factor)||factor===0)throw new Error('Scale factor must be finite and nonzero');return operands(a,k,ctx).map(v=>transformShape(v,{scale:factor,about:get(a,k,'about',2)})) },
    split: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx),'split'), plane=asPlane(get(a,k,'bisect_by',1)), keep=enumName(get(a,k,'keep',2,'TOP')); return inputs.flatMap(v=>{const result=v.shape.split(plane); return (keep==='BOTH'?[result.positive,result.negative]:[keep==='BOTTOM'?result.negative:result.positive]).filter(Boolean).map(shape=>shapeValue(shape!,'Part',metadata(v)))}) },
    section: (a,k,ctx) => {
      const inputs = requireShapes(operands(a,k,ctx,'obj',0),'section'), planes=get(a,k,'section_by',1) ?? ctx.current()?.plane; const plane=asPlane(planes)
      return inputs.map(value=>{ const pln=R.makePln(plane.origin,plane.zDir); try { const section=made(new oc.BRepAlgoAPI_Section(value.shape.wrapped,pln,true)); const wire=R.assembleWire(section.edges); return shapeValue(R.makeFace(wire),'Sketch',metadata(value)) } finally {pln.delete()} })
    },
    draft: (a,k,ctx) => { const selected=shapeList(get(a,k,'faces',0)), body=owner(selected,ctx), plane=asPlane(get(a,k,'neutral_plane',1)); return draftShape(body,selected.map(v=>v.shape as R.Face),plane,get(a,k,'angle',2)) },
    offset: (a,k,ctx) => {
      const inputs=requireShapes(operands(a,k,ctx),'offset'), distance=get(a,k,'amount',1,0),kind=get(a,k,'kind',3,'ARC')
      return inputs.flatMap(value=>{
        if(value.shape instanceof R.Face || value.shape instanceof R.Wire || value.shape instanceof R.Edge)return [offsetShape2D(value,distance,kind,get(a,k,'side',4,'BOTH'),get(a,k,'closed',5,true))]
        if(value.shape instanceof R.Compound && !value.shape.solids.length)return value.shape.faces.map(face=>offsetShape2D(shapeValue(face,'Face'),distance,kind))
        const openings=shapeList(get(a,k,'openings',2))
        if(openings.length)return [shapeValue(value.shape.asShape3D().shell({thickness:-distance,filter:new R.FaceFinder().inList(openings.map(v=>v.shape as R.Face))}),'Part',metadata(value))]
        const operation=new oc.BRepOffsetAPI_MakeOffsetShape()
        try {operation.PerformByJoin(value.shape.wrapped,distance,1e-6,oc.BRepOffset_Mode.BRepOffset_Skin,false,false,enumName(kind)==='INTERSECTION'?oc.GeomAbs_JoinType.GeomAbs_Intersection:oc.GeomAbs_JoinType.GeomAbs_Arc,false);return [shapeValue(R.cast(operation.Shape()),value.kind,metadata(value))]} finally {operation.delete()}
      })
    },
    thicken: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx,'to_thicken',0),'thicken'); return unionShapes(inputs.map(v=>{if(!(v.shape instanceof R.Face))throw new Error('thicken requires faces');return shapeValue(R.makeOffset(v.shape,get(a,k,'amount',1)),'Part',metadata(v))})) },
    project: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx),'project'), plane=asPlane(get(a,k,'workplane',1)??ctx.current()?.plane); return inputs.map(v=>{ if (!(v.shape instanceof R.Face)) throw new Error('Browser project currently supports planar faces'); const normal=v.shape.normalAt(); if(Math.abs(normal.dot(plane.zDir))<1-1e-6)throw new Error('Browser project requires a parallel planar face'); const d=plane.origin.sub(v.shape.center).dot(plane.zDir); return shapeValue(v.shape.clone().translate(plane.zDir.multiply(d)),'Sketch',metadata(v)) }) },
    pack: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx),'pack'),padding=get(a,k,'padding',1,0); let x=0; return inputs.map(v=>{const [min,max]=v.shape.boundingBox.bounds; const value=transformShape(v,{position:[x-min[0],-min[1],0]}); x+=max[0]-min[0]+padding;return value}) },
    bounding_box: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx),'bounding_box'); const bounds=inputs.map(v=>v.shape.boundingBox.bounds); const min=[0,1,2].map(i=>Math.min(...bounds.map(b=>b[0][i]))), max=[0,1,2].map(i=>Math.max(...bounds.map(b=>b[1][i]))); return shapeValue(R.makeBox(min as R.Point,max as R.Point),'Part') },
    edges_to_wires: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx,'edges',0),'edges_to_wires');return [shapeValue(R.assembleWire(inputs.flatMap(v=>v.shape instanceof R.Edge?[v.shape]:v.shape.edges)),'Wire')] },
    make_face: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx,'edges',0),'make_face'); const wire=R.assembleWire(inputs.flatMap(v=>v.shape instanceof R.Edge?[v.shape]:v.shape.edges)); return shapeValue(R.makeFace(wire),'Sketch') },
    make_hull: (a,k,ctx) => convexHull(requireShapes(operands(a,k,ctx,'edges',0),'make_hull'),asPlane(ctx.current()?.plane)),
    trace: (a,k,ctx) => traceWire(requireShapes(operands(a,k,ctx,'lines',0),'trace'),requirePositive(get(a,k,'line_width',1,1),'line_width'),asPlane(ctx.current()?.plane)),
    full_round: (a,k) => fullRound(get(a,k,'edge',0),get(a,k,'invert',1,false)),
    make_brake_formed: (a,k,ctx) => { const inputs=requireShapes(operands(a,k,ctx,'line',2),'make_brake_formed'); return brakeFormed(inputs[0],requirePositive(get(a,k,'thickness',0),'thickness'),get(a,k,'station_widths',1),get(a,k,'side',3,'LEFT'),get(a,k,'kind',4,'ARC')) },
    add: (a,k,ctx) => operands(a,k,ctx),
    insert: (a,k,ctx) => operands(a,k,ctx),
  }
  for (const kind of ['Shape','Solid','Shell','Face','Wire','Edge','Compound','Part','Sketch','Curve','CompSolid']) handlers[kind]=(a,k) => {
    const source=get(a,k,'obj',0), children=shapeList(get(a,k,'children',6)??k.shapes)
    if (isKernelShape(source)) return shapeValue(source.shape.clone(),kind,{...metadata(source),...(source.children?{children:source.children}:{}),label:get(a,k,'label',1,source.label),color:get(a,k,'color',2,source.color)})
    if (children.length) return shapeValue(R.makeCompound(children.map(v=>v.shape.clone())),kind,{label:get(a,k,'label',1),color:get(a,k,'color',2),children})
    if (source?.ShapeType) return shapeValue(R.cast(source),kind,{label:k.label,color:k.color})
    if (Array.isArray(source)) {const values=shapeList(source);return shapeValue(R.makeCompound(values.map(v=>v.shape.clone())),kind,{children:values,label:k.label,color:k.color})}
    throw new Error(`${kind} requires a shape or children`)
  }
  for(const [name,argument,kind] of [['BasePartObject','part','Part'],['BaseSketchObject','obj','Sketch'],['BaseCurveObject','curve','Curve'],['BaseLineObject','curve','Wire'],['BaseEdgeObject','curve','Edge']])handlers[name]=(a,k)=>{
    const source=get(a,k,argument,0)
    if(!isKernelShape(source))throw new Error(`${name} requires a native shape`)
    let value=shapeValue(source.shape.clone(),kind,{...metadata(source),...(source.children?{children:source.children}:{})})
    if(name==='BasePartObject'||name==='BaseSketchObject'){
      value=shapeValue(alignShape(value.shape,get(a,k,'align',2,null)),kind,metadata(value))
      value=transformShape(value,{rotation:get(a,k,'rotation',1,name==='BasePartObject'?[0,0,0]:0)})
    }
    return Object.assign(value,{mode:enumName(get(a,k,'mode',name==='BasePartObject'||name==='BaseSketchObject'?3:1,'ADD'))})
  }
  for (const name of ['Hole','CounterBoreHole','CounterSinkHole']) handlers[name]=(a,k,ctx)=>{
    const radius=requirePositive(get(a,k,'radius',0),'radius')
    let depth=get(a,k,'depth',name==='Hole'?1:name==='CounterSinkHole'?2:3)
    if(depth==null){const body=ctx.current()?.shape;if(!body)throw new Error('A hole depth must be provided outside BuildPart');const [min,max]=body.shape.boundingBox.bounds;depth=Math.hypot(...min.map((v,i)=>max[i]-v))*2}
    requirePositive(depth,'depth')
    let tool=shapeValue(R.makeCylinder(radius,depth,[0,0,-depth]),'Hole')
    if(name==='CounterBoreHole')tool=unionShapes([tool,shapeValue(R.makeCylinder(get(a,k,'counter_bore_radius',1),get(a,k,'counter_bore_depth',2),[0,0,-get(a,k,'counter_bore_depth',2)]),'Solid')])!
    if(name==='CounterSinkHole'){const outer=get(a,k,'counter_sink_radius',1), angle=get(a,k,'counter_sink_angle',3,82), height=outer/Math.tan(radians(angle/2)); const cone=handlers.Cone([0,outer,height],{align:['CENTER','CENTER','MAX']},ctx); tool=unionShapes([tool,cone])!}
    ;(tool as any).mode='SUBTRACT'; return tool
  }
  return handlers
}

/** Tessellation is always computed from the live OpenCascade BRep. */
export function meshShape(value: KernelShape, options: RenderOptions = {}): MeshData {
  const shape=value.shape, oc=R.getOC() as any
  const mesh=shape.mesh({tolerance:options.tolerance??0.1,angularTolerance:options.angularTolerance??0.1})
  const lineMesh=shape.meshEdges({tolerance:options.tolerance??0.1,angularTolerance:options.angularTolerance??0.1})
  // Replicad stores pairs of line-segment endpoints; join each edge's segments.
  const edges=lineMesh.edgeGroups.map(group=>{
    const segments=lineMesh.lines.slice(group.start*3,(group.start+group.count)*3)
    const points:number[]=[]
    for(let i=0;i<segments.length;i+=6){if(!points.length)points.push(...segments.slice(i,i+3));points.push(...segments.slice(i+3,i+6))}
    return points
  }).filter(v=>v.length>=6)
  let area=0,volume=0
  if(shape instanceof R.Face || R.isShape3D(shape)) area=R.measureArea(shape as R.Face|R.Shape3D)
  if(R.isShape3D(shape))volume=R.measureVolume(shape as R.Shape3D)
  const analyzer=new oc.BRepCheck_Analyzer(shape.wrapped,true,false,false)
  let valid:boolean;try{valid=analyzer.IsValid()}finally{analyzer.delete()}
  const positions=Array.from(mesh.vertices), normals=Array.from(mesh.normals), indices=Array.from(mesh.triangles)
  const vertices=shape instanceof R.Vertex?tuple((shape as any).asTuple?.()??(shape as any).point??shape.boundingBox.center):[]
  const color=(value.color as any)?.toTuple?.()??(value.color as any)?.rgba??value.color
  return {positions,normals,indices,edges,vertices,volume:Math.abs(volume),area,valid,kind:value.kind,...(value.label?{name:value.label}:{}),...(color?{color}:{}),...(value.assemblyPath?{assemblyPath:value.assemblyPath}:{})}
}
