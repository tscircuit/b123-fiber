import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { OrthographicCamera, Vector3 } from 'three'

/** Frame the camera first: OrbitControls caches its up-axis at construction. */
export function createCadControls(camera: OrthographicCamera, canvas: HTMLCanvasElement, target: Vector3): OrbitControls {
  const controls = new OrbitControls(camera, canvas)
  controls.target.copy(target)
  controls.enableDamping = false
  controls.screenSpacePanning = true
  controls.listenToKeyEvents(canvas)
  controls.minZoom = 0.15
  controls.maxZoom = 20
  controls.update()
  controls.saveState()
  return controls
}
