import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createCadControls } from './controls'
import { createBuild123dRoot, type Build123dRoot } from './renderer'
import { CAD_BACKGROUND, createCadGroup, disposeCadGroup, frameCadCamera, resizeCadCamera, type CadView } from './three'
import type { Build123dPlan, RenderResult } from './types'

export interface Build123dViewProps {
  children?: ReactNode
  plan?: Build123dPlan
  result?: RenderResult
  backendUrl?: string
  headers?: HeadersInit
  tolerance?: number
  angularTolerance?: number
  view?: CadView
  showEdges?: boolean
  className?: string
  style?: CSSProperties
  onLoad?: (result: RenderResult) => void
  onError?: (error: Error) => void
}

type Stage = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.OrthographicCamera; controls: OrbitControls; group: THREE.Group | null; resize: () => void; frame: () => void; redraw: () => void }

/** Interactive Z-up viewer for build123d's native OpenCascade tessellations. */
export function Build123dView({ children, plan, result, backendUrl = 'http://127.0.0.1:8765', headers, tolerance = 0.1, angularTolerance = 0.1, view = 'iso', showEdges = true, className, style, onLoad, onError }: Build123dViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const stage = useRef<Stage | null>(null)
  const cadRoot = useRef<Build123dRoot | null>(null)
  const notifiedPlanError = useRef<unknown>(undefined)
  const [graphicsError, setGraphicsError] = useState<Error>()
  const headerKey = serializeHeaders(headers)
  const [planError, setPlanError] = useState<Error>()
  const [compiledPlan, setCompiledPlan] = useState<Build123dPlan>({ version: 1, children: [] })
  const [rendered, setRendered] = useState<RenderResult | undefined>(result)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string>()
  const callbacks = useRef({ onLoad, onError })
  callbacks.current = { onLoad, onError }
  const current = useRef({ rendered, view })
  current.current = { rendered, view }

  useEffect(() => {
    if (plan || result) return
    const root = createBuild123dRoot({ onError: reason => {
      notifiedPlanError.current = reason
      const failure = reason instanceof Error ? reason : new Error(String(reason))
      setPlanError(failure); setStatus('error'); setError(failure.message); callbacks.current.onError?.(failure)
    } })
    cadRoot.current = root
    const unsubscribe = root.subscribe(setCompiledPlan)
    return () => { unsubscribe(); root.unmount(); cadRoot.current = null }
  }, [Boolean(plan), Boolean(result)])

  useEffect(() => {
    if (plan || result || !cadRoot.current) return
    setPlanError(undefined)
    notifiedPlanError.current = undefined
    try { cadRoot.current.render(children) } catch (reason) {
      if (notifiedPlanError.current === reason) return
      const failure = reason instanceof Error ? reason : new Error(String(reason))
      setPlanError(failure); setStatus('error'); setError(failure.message); callbacks.current.onError?.(failure)
    }
  }, [children, plan, result])

  useEffect(() => {
    if (result) { setRendered(result); setStatus('ready'); setError(undefined); callbacks.current.onLoad?.(result); return }
    if (planError && !plan) { setStatus('error'); setError(planError.message); return }
    const controller = new AbortController()
    let active = true
    setStatus('loading')
    setError(undefined)
    async function render() {
      try {
        const requestHeaders = new Headers(JSON.parse(headerKey) as [string, string][])
        requestHeaders.set('Content-Type', 'application/json')
        const response = await fetch(`${backendUrl.replace(/\/$/, '')}/render`, {
          method: 'POST', headers: requestHeaders, signal: controller.signal,
          body: JSON.stringify({ plan: plan ?? compiledPlan, tolerance, angularTolerance }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? `CAD service returned ${response.status}`)
        if (active) { setRendered(data); setStatus('ready'); callbacks.current.onLoad?.(data) }
      } catch (reason) {
        if (!active || controller.signal.aborted) return
        const failure = reason instanceof Error ? reason : new Error(String(reason))
        setStatus('error'); setError(failure.message); callbacks.current.onError?.(failure)
      }
    }
    void render()
    return () => { active = false; controller.abort() }
  }, [result, plan, compiledPlan, planError, backendUrl, headerKey, tolerance, angularTolerance])

  useEffect(() => {
    const container = host.current
    if (!container) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
    } catch (reason) {
      const failure = reason instanceof Error ? reason : new Error(String(reason))
      setGraphicsError(failure); setStatus('error'); setError(failure.message); callbacks.current.onError?.(failure)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(CAD_BACKGROUND)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.tabIndex = 0
    renderer.domElement.setAttribute('aria-label', 'Interactive build123d CAD model')
    container.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight('#ffffff', '#c9d1dc', 2.5))
    const light = new THREE.DirectionalLight('#ffffff', 3)
    light.position.set(2, -3, 5)
    scene.add(light)
    const fill = new THREE.DirectionalLight('#d8e6ff', 1.2)
    fill.position.set(-3, 2, 1)
    scene.add(fill)
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000)
    const initialTarget = frameCadCamera(camera, current.current.rendered?.bounds ?? null, current.current.view, Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1))
    let controls = createCadControls(camera, renderer.domElement, initialTarget)
    const redraw = () => renderer.render(scene, camera)
    const state: Stage = { renderer, scene, camera, controls, group: null, redraw, resize: () => {
      const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1)
      renderer.setSize(width, height)
      resizeCadCamera(camera, width / height)
      redraw()
    }, frame: () => {
      const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1)
      renderer.setSize(width, height)
      camera.zoom = 1
      controls.removeEventListener('change', redraw)
      controls.dispose()
      const target = frameCadCamera(camera, current.current.rendered?.bounds ?? null, current.current.view, width / height)
      // Top view uses a different up-axis, so recreate rather than reusing the
      // quaternion cached by the previous controls instance.
      controls = createCadControls(camera, renderer.domElement, target)
      controls.addEventListener('change', redraw)
      state.controls = controls
      redraw()
    } }
    stage.current = state
    const observer = new ResizeObserver(state.resize)
    observer.observe(container)
    controls.addEventListener('change', redraw)
    state.resize()
    return () => {
      observer.disconnect(); controls.removeEventListener('change', redraw); controls.dispose()
      if (state.group) disposeCadGroup(state.group)
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); stage.current = null
    }
  }, [])

  useEffect(() => {
    const state = stage.current
    if (!state) return
    if (state.group) { state.scene.remove(state.group); disposeCadGroup(state.group) }
    state.group = rendered ? createCadGroup(rendered, showEdges) : null
    if (state.group) state.scene.add(state.group)
    state.redraw()
  }, [rendered, showEdges])

  useEffect(() => { stage.current?.frame() }, [rendered, view])

  const visibleStatus = graphicsError ? 'error' : status
  return <div className={className} style={{ position: 'relative', width: '100%', height: 480, ...style }} data-cad-status={visibleStatus} data-cad-view={view}>
    <div ref={host} style={{ width: '100%', height: '100%', overflow: 'hidden' }} />
    {visibleStatus === 'loading' && <div role="status" style={overlayStyle}>Building CAD geometry…</div>}
    {visibleStatus === 'error' && <div role="alert" style={{ ...overlayStyle, color: '#a12626', background: '#fff5f5' }}>{graphicsError?.message ?? error}</div>}
  </div>
}
const overlayStyle: CSSProperties = { position: 'absolute', bottom: 16, left: 16, right: 16, padding: '10px 14px', borderRadius: 8, background: '#ffffffe6', font: '14px system-ui' }

function serializeHeaders(headers?: HeadersInit): string {
  const entries: [string, string][] = []
  new Headers(headers).forEach((value, key) => entries.push([key, value]))
  return JSON.stringify(entries)
}
