import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { OrthographicCamera, Vector3 } from 'three'

/** Construct after framing: OrbitControls caches the camera's up-axis at creation. */
export function createCadControls(camera: OrthographicCamera, canvas: HTMLCanvasElement, target: Vector3) {
  const controls = new OrbitControls(camera, canvas)
  controls.target.copy(target)
  controls.enableDamping = false
  controls.screenSpacePanning = true
  controls.listenToKeyEvents(canvas)
  controls.minZoom = 0.15
  controls.maxZoom = 20
  controls.update()
  return controls
}
