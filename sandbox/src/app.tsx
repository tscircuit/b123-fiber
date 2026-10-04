import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Build123dPlan, RenderResult } from '../../lib/types'
import type { CadView } from '../../lib/three'
import rawCatalog from './catalog.json'
import { CadViewer } from './viewer'
import './style.css'

interface Example {
  id: string
  title: string
  category: string
  description: string
  modelUrl: string
  thumbnailUrl: string
  source: string
  plan: Build123dPlan
  stats: { dimension: number; volume: number; area: number; meshCount: number; triangles: number; valid: boolean }
}
const featuredOrder = ['electronics', 'motor-spacer', 'fillet', 'loft', 'sweep', 'subtract']
const examples = [...rawCatalog as Example[]].sort((left, right) => {
  const leftIndex = featuredOrder.indexOf(left.id)
  const rightIndex = featuredOrder.indexOf(right.id)
  return (leftIndex < 0 ? featuredOrder.length : leftIndex) - (rightIndex < 0 ? featuredOrder.length : rightIndex)
})
const modelCache = new Map<string, RenderResult>()
const categoryLabels: Record<string, string> = { assembly: 'Assemblies', solid: 'Solids', sketch: 'Sketches', curve: 'Curves', operation: 'Operations' }
const categoryOrder = ['all', 'assembly', 'solid', 'sketch', 'curve', 'operation']
const viewLabels: Record<CadView, string> = { iso: 'Isometric', top: 'Top', front: 'Front', right: 'Right' }
const count = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
const measure = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
const displayTitle = (title: string) => title.replace('PCB · connector assembly', 'PCB connector assembly').replaceAll(' · ', ' / ')

type IconName = 'cube' | 'search' | 'chevron' | 'github' | 'arrow' | 'copy' | 'check' | 'reset' | 'download' | 'edges' | 'menu' | 'close' | 'camera' | 'external' | 'layers' | 'code'
function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    cube: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9M12 3v9" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    github: <><path d="M9 19c-4 1-4-2-6-2m12 4v-4a3.5 3.5 0 0 0-1-2.5c3-.3 6-1.5 6-6A4.8 4.8 0 0 0 18.7 5a4.5 4.5 0 0 0-.1-3s-1.1-.3-3.6 1.3a13 13 0 0 0-6 0C6.5 1.7 5.4 2 5.4 2a4.5 4.5 0 0 0-.1 3A4.8 4.8 0 0 0 4 8.5c0 4.5 3 5.7 6 6A3.5 3.5 0 0 0 9 17v4" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    reset: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    edges: <><rect x="4" y="4" width="16" height="16" rx="1" /><path d="m4 4 16 16M4 20 20 4M12 4v16M4 12h16" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    camera: <><path d="M3 7h5l2-3h4l2 3h5v14H3Z" /><circle cx="12" cy="13" r="4" /></>,
    external: <><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" /></>,
    layers: <><path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" /></>,
    code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function getInitialExample() {
  const id = new URL(window.location.href).searchParams.get('example')
  return examples.some(example => example.id === id) ? id! : 'electronics'
}

function download(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function highlight(line: string) {
  const tokens = line.split(/(\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<\/?[\w.]+|\b(?:import|from|export|default|function|return|const|true|false|null)\b|\b\d+(?:\.\d+)?\b)/g)
  return tokens.map((token, index) => {
    const kind = token.startsWith('//') ? 'comment' : /^["']/.test(token) ? 'string' : token.startsWith('<') ? 'tag' : /^\d/.test(token) ? 'number' : /^(import|from|export|default|function|return|const|true|false|null)$/.test(token) ? 'keyword' : undefined
    return kind ? <span key={index} className={{ comment: "text-gray-400", string: "text-green-700", tag: "text-blue-700", number: "text-orange-700", keyword: "text-purple-700" }[kind]}>{token}</span> : token
  })
}

function SourceCode({ source }: { source: string }) {
  return <pre className="overflow-auto p-4 font-mono text-xs leading-6" tabIndex={0}><code>{source.split('\n').map((line, index) => <span className="flex" key={index}><span className="mr-4 w-6 shrink-0 text-right text-gray-400" aria-hidden="true">{index + 1}</span><span>{highlight(line) || ' '}</span></span>)}</code></pre>
}

function App() {
  const [selectedId, setSelectedId] = useState(getInitialExample)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [view, setView] = useState<CadView>('iso')
  const [edges, setEdges] = useState(true)
  const [resetToken, setResetToken] = useState(0)
  const [screenshotToken, setScreenshotToken] = useState(0)
  const [tab, setTab] = useState<'jsx' | 'plan' | 'details'>('jsx')
  const [loadedModel, setModel] = useState<RenderResult | null>(null)
  const [modelId, setModelId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [retryToken, setRetryToken] = useState(0)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selected = examples.find(example => example.id === selectedId) ?? examples[0]!
  const model = modelId === selected.id ? loadedModel : null
  const filtered = useMemo(() => examples.filter(example => {
    const matchesCategory = category === 'all' || example.category === category
    const haystack = `${example.title} ${example.category} ${example.description} ${example.id}`.toLowerCase()
    return matchesCategory && haystack.includes(query.trim().toLowerCase())
  }), [query, category])

  useEffect(() => {
    const onPop = () => setSelectedId(getInitialExample())
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setBrowserOpen(true)
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') setBrowserOpen(false)
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('keydown', onKey)
      clearTimeout(noticeTimer.current)
    }
  }, [])

  useEffect(() => {
    document.title = `${displayTitle(selected.title)} · b123-fiber sandbox`
    const cached = modelCache.get(selected.id)
    setLoadError(undefined)
    if (cached) { setModel(cached); setModelId(selected.id); setLoading(false); return }
    const controller = new AbortController()
    setModel(null)
    setModelId('')
    setLoading(true)
    async function load() {
      try {
        const response = await fetch(selected.modelUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(`Geometry could not be loaded (${response.status}).`)
        const result = await response.json() as RenderResult
        if (!Array.isArray(result.meshes) || !('bounds' in result)) throw new Error('The model file is incomplete.')
        if (controller.signal.aborted) return
        modelCache.set(selected.id, result)
        setModel(result)
        setModelId(selected.id)
        setLoading(false)
      } catch (error) {
        if (controller.signal.aborted) return
        setLoading(false)
        setLoadError(error instanceof Error ? error.message : 'Geometry could not be loaded.')
      }
    }
    void load()
    return () => controller.abort()
  }, [selected, retryToken])

  function choose(example: Example) {
    if (example.id !== selectedId) {
      const url = new URL(window.location.href)
      url.searchParams.set('example', example.id)
      window.history.pushState({}, '', url)
      setSelectedId(example.id)
      setView('iso')
    }
    setBrowserOpen(false)
  }

  function feedback(message: string) {
    clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = setTimeout(() => setNotice(''), 3000)
  }

  async function copy(text: string, message = 'Copied to clipboard') {
    try { await navigator.clipboard.writeText(text); feedback(message) }
    catch { feedback('Clipboard unavailable. Select the source text to copy it.') }
  }

  const source = tab === 'plan' ? JSON.stringify(selected.plan, null, 2) : selected.source
  const bounds = model?.bounds
  const dimensions = bounds ? bounds.max.map((value, index) => Math.max(0, value - bounds.min[index]!)) : null
  const geometryKind = ['Point', 'Curve', 'Sketch', 'Solid'][selected.stats.dimension] ?? 'Geometry'
  const button = 'inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50'
  const active = 'aria-pressed:bg-blue-50 aria-pressed:text-blue-700 aria-pressed:border-blue-300 aria-selected:bg-blue-50 aria-selected:text-blue-700 aria-selected:border-blue-300'

  return <div className="min-h-screen bg-gray-50 font-sans text-gray-900">
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
      <a href="?example=electronics" className="font-semibold" onClick={event => { event.preventDefault(); choose(examples.find(example => example.id === 'electronics')!) }}>b123-fiber sandbox</a>
      <nav className="flex gap-4 text-sm" aria-label="Project links"><a className="text-blue-600 hover:underline" href="https://build123d.readthedocs.io/en/latest/" target="_blank" rel="noreferrer">Docs</a><a className="text-blue-600 hover:underline" href="https://github.com/tscircuit/b123-fiber" target="_blank" rel="noreferrer">GitHub</a></nav>
    </header>
    <div className="p-4">
      <button className={`${button} mb-4 lg:hidden`} data-testid="mobile-examples-toggle" aria-expanded={browserOpen} aria-controls="example-browser" onClick={() => setBrowserOpen(!browserOpen)}><Icon name="menu" />Examples ({examples.length})</button>
      {browserOpen && <button className="fixed inset-0 z-20 bg-black/30 lg:hidden" aria-label="Close example browser" onClick={() => setBrowserOpen(false)} />}
      <main className="workbench grid min-w-0 items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_24rem]">
        <aside className={`example-browser ${browserOpen ? 'fixed inset-y-0 left-0 z-30 flex w-72' : 'hidden'} flex-col rounded-lg border border-gray-200 bg-white p-3 lg:static lg:flex lg:w-auto lg:max-h-[calc(100vh-6rem)]`} id="example-browser" aria-label="Example browser">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Examples</h2><button className={`${button} lg:hidden`} aria-label="Close example browser" onClick={() => setBrowserOpen(false)}><Icon name="close" /></button></div>
          <input className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-2 focus:outline-blue-600" ref={searchRef} data-testid="example-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search examples" aria-label="Search examples" />
          <div className="my-3 flex flex-wrap gap-1" aria-label="Filter example categories">{categoryOrder.map(item => <button className={`rounded-md px-2 py-1 text-xs ${category === item ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'}`} key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'all' ? 'All' : categoryLabels[item]}</button>)}</div>
          <div className="min-h-0 overflow-y-auto">{filtered.length ? filtered.map(example => <button key={example.id} className={`my-1 flex w-full items-center gap-2 rounded-md p-2 text-left text-sm ${selected.id === example.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100'}`} data-testid="example-card" data-example-id={example.id} aria-pressed={selected.id === example.id} onClick={() => choose(example)}><img className="h-12 w-14 shrink-0 rounded object-contain" src={example.thumbnailUrl} alt="" width="72" height="58" loading="lazy" /><span>{displayTitle(example.title)}</span></button>) : <div className="space-y-3 py-4 text-sm" data-testid="search-empty"><p>No matching examples</p><button className={button} onClick={() => { setQuery(''); setCategory('all') }}>Clear filters</button></div>}</div>
        </aside>
        <section className="model-workspace min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white" data-example-id={selected.id} aria-label="Selected example">
          <header className="flex items-center justify-between border-b border-gray-200 p-4"><h2 className="font-semibold" data-testid="example-title">{displayTitle(selected.title)}</h2><button className={button} aria-label="Copy example link" title="Copy example link" onClick={() => void copy(window.location.href, 'Example link copied')}><Icon name="external" /></button></header>
          <div className="viewer-toolbar flex flex-wrap justify-between gap-2 border-b border-gray-200 p-2">
            <div className="flex gap-1" aria-label="Camera view">{(['iso', 'top', 'front', 'right'] as CadView[]).map(item => <button className={`${button} ${view === item ? active : ''}`} key={item} data-testid={`view-${item}`} aria-pressed={view === item} onClick={() => setView(item)}>{item === 'iso' ? 'Iso' : viewLabels[item]}</button>)}</div>
            <div className="flex gap-1"><button className={`${button} ${edges ? active : ''}`} data-testid="toggle-edges" aria-label="Show topology edges" aria-pressed={edges} title="Toggle topology edges" onClick={() => setEdges(!edges)}><Icon name="edges" /></button><button className={button} data-testid="reset-view" aria-label="Fit model to view" title="Fit model to view" onClick={() => setResetToken(token => token + 1)}><Icon name="reset" /></button><button className={button} aria-label="Download view image" title="Download view image" disabled={!model} onClick={() => setScreenshotToken(token => token + 1)}><Icon name="camera" /></button></div>
          </div>
          <div className="relative h-80 bg-gray-50 sm:h-[32rem]">
            <CadViewer model={model} modelId={modelId} title={displayTitle(selected.title)} view={view} edges={edges} resetToken={resetToken} screenshotToken={screenshotToken} />
            {loading && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500" role="status" data-testid="model-loading">Loading…</div>}
            {loadError && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-sm" role="alert"><p>{loadError}</p><button className={button} onClick={() => setRetryToken(token => token + 1)}>Try again</button></div>}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-gray-200 p-4 text-xs text-gray-600"><span>{count(selected.stats.meshCount)} parts</span><span>{count(selected.stats.triangles)} triangles</span><span>{measure(selected.stats.dimension === 3 ? selected.stats.volume : selected.stats.area)} mm{selected.stats.dimension === 3 ? '³' : '²'}</span></div>
        </section>
        <aside className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white lg:col-start-2 xl:col-start-auto" aria-label="Example source and metadata">
          <div className="flex items-center gap-1 border-b border-gray-200 p-2" role="tablist" aria-label="Example details">{(['jsx', 'plan', 'details'] as const).map(item => <button className={`${button} ${tab === item ? active : ''}`} id={`tab-${item}`} key={item} role="tab" aria-selected={tab === item} aria-controls="code-content" onClick={() => setTab(item)}>{item === 'jsx' ? 'JSX' : item === 'plan' ? 'Plan' : 'Details'}</button>)}<button className={`${button} ml-auto`} aria-label={tab === 'details' ? 'Copy model metadata' : 'Copy source'} title="Copy to clipboard" onClick={() => void copy(tab === 'details' ? JSON.stringify({ ...selected.stats, bounds: model?.bounds, kernel: model?.kernel }, null, 2) : source)}><Icon name="copy" /></button></div>
          <div className="max-h-[36rem] overflow-auto" role="tabpanel" id="code-content" aria-labelledby={`tab-${tab}`} tabIndex={0}>{tab !== 'details' ? <SourceCode source={source} /> : <dl className="space-y-4 p-4 text-sm">{[['Kernel', model?.kernel ?? 'OpenCascade'], ['Units', 'Millimeters'], ['Dimension', `${selected.stats.dimension}D · ${geometryKind}`], ['Surface area', `${measure(selected.stats.area)} mm²`], ['Bounding size', dimensions ? dimensions.map(measure).join(' × ') + ' mm' : 'Loading…'], ['Topology', selected.stats.valid ? 'Valid' : 'Invalid']].map(([label, value]) => <div key={label}><dt className="text-gray-500">{label}</dt><dd>{value}</dd></div>)}</dl>}</div>
          <div className="flex gap-2 border-t border-gray-200 p-3"><button className={button} onClick={() => download(`${selected.id}.plan.json`, selected.plan)}><Icon name="download" size={14} />Plan JSON</button><button className={button} disabled={!model} onClick={() => model && download(`${selected.id}.mesh.json`, model)}><Icon name="download" size={14} />Mesh JSON</button></div>
        </aside>
      </main>
    </div>
    {notice && <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md bg-gray-900 px-4 py-2 text-sm text-white" role="status" aria-live="polite">{notice}</div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
