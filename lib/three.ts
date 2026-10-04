import * as THREE from 'three'
import type { MeshData, RenderResult } from './types'

export type CadView = 'iso' | 'top' | 'front' | 'right'
export const CAD_BACKGROUND = '#f1f4f8'

function meshColor(color: MeshData['color']): THREE.Color {
  if (Array.isArray(color)) return new THREE.Color(color[0] ?? 0.3, color[1] ?? 0.6, color[2] ?? 0.85)
  return new THREE.Color(color ?? '#5f9bd5')
}

/** Creates real OCCT triangle surfaces and tessellated topology edges. */
export function createCadGroup(result: RenderResult, showEdges = true): THREE.Group {
  const group = new THREE.Group()
  result.meshes.forEach((data, index) => {
    const part = new THREE.Group()
    const opacity = Array.isArray(data.color) ? Math.min(1, Math.max(0, data.color[3] ?? 1)) : 1
    const transparency = { opacity, transparent: opacity < 1 }
    part.name = data.name ?? `part-${index}`
    part.userData = { volume: data.volume, area: data.area, valid: data.valid, kind: data.kind, assemblyPath: data.assemblyPath }
    if (data.positions.length && data.indices.length) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3))
      geometry.setIndex(data.indices)
      if (data.normals.length === data.positions.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3))
      else geometry.computeVertexNormals()
      geometry.computeBoundingSphere()
      const material = new THREE.MeshStandardMaterial({
        ...transparency, color: meshColor(data.color), roughness: 0.72, metalness: 0.08,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      })
      part.add(new THREE.Mesh(geometry, material))
    }
    if (!data.indices.length && !data.edges.length && data.vertices?.length) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3))
      part.add(new THREE.Points(geometry, new THREE.PointsMaterial({ ...transparency, color: meshColor(data.color), size: 9, sizeAttenuation: false })))
    }
    if (showEdges || !data.indices.length) {
      const points: number[] = []
      data.edges.forEach((edge) => {
        for (let i = 0; i + 5 < edge.length; i += 3) points.push(...edge.slice(i, i + 6))
      })
      if (points.length) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
        const material = new THREE.LineBasicMaterial({ ...transparency, color: data.indices.length ? '#20344a' : meshColor(data.color), linewidth: 1 })
        part.add(new THREE.LineSegments(geometry, material))
      }
    }
    group.add(part)
  })
  return group
}

/** Orthographic engineering views. build123d uses a Z-up coordinate system. */
export function frameCadCamera(camera: THREE.OrthographicCamera, bounds: RenderResult['bounds'], view: CadView, aspect: number): THREE.Vector3 {
  const min = new THREE.Vector3(...(bounds?.min ?? [-1, -1, -1]) as [number, number, number])
  const max = new THREE.Vector3(...(bounds?.max ?? [1, 1, 1]) as [number, number, number])
  const center = min.clone().add(max).multiplyScalar(0.5)
  const size = max.clone().sub(min)
  const diagonal = Math.max(size.length(), 1)
  const direction = ({ iso: [1, -1, 0.8], top: [0, 0, 1], front: [0, -1, 0], right: [1, 0, 0] } as const)[view]
  camera.up.set(0, 0, 1)
  if (view === 'top') camera.up.set(0, 1, 0)
  camera.position.copy(center).add(new THREE.Vector3(...direction).normalize().multiplyScalar(diagonal * 3))
  camera.lookAt(center)
  camera.updateMatrixWorld()
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const projectedWidth = Math.abs(right.x) * size.x + Math.abs(right.y) * size.y + Math.abs(right.z) * size.z
  const projectedHeight = Math.abs(up.x) * size.x + Math.abs(up.y) * size.y + Math.abs(up.z) * size.z
  const height = Math.max(projectedHeight, projectedWidth / Math.max(aspect, 0.01), diagonal * 0.18) * 1.28
  camera.left = -height * aspect / 2
  camera.right = height * aspect / 2
  camera.top = height / 2
  camera.bottom = -height / 2
  camera.near = Math.max(diagonal * 0.001, 0.0001)
  camera.far = diagonal * 10
  camera.updateProjectionMatrix()
  return center
}

/** Change viewport aspect without changing orbit, pan, or zoom. */
export function resizeCadCamera(camera: THREE.OrthographicCamera, aspect: number): void {
  const halfHeight = (camera.top - camera.bottom) / 2
  const centerX = (camera.left + camera.right) / 2
  camera.left = centerX - halfHeight * Math.max(aspect, 0.01)
  camera.right = centerX + halfHeight * Math.max(aspect, 0.01)
  camera.updateProjectionMatrix()
}

/** Frees all GPU resources, including edge materials, after rerender/unmount. */
export function disposeCadGroup(group: THREE.Object3D): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points) {
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach((material) => material.dispose())
    }
  })
  group.clear()
}
