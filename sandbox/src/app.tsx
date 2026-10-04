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
    return kind ? <span key={index} className={`syntax-${kind}`}>{token}</span> : token
  })
}

function SourceCode({ source }: { source: string }) {
  return <pre className="source-code" tabIndex={0}><code>{source.split('\n').map((line, index) => <span className="code-line" key={index}><span className="line-number" aria-hidden="true">{index + 1}</span><span>{highlight(line) || ' '}</span></span>)}</code></pre>
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
  const featured = ['motor-spacer', 'loft', 'fillet', 'sweep', 'revolve', 'helix'].map(id => examples.find(example => example.id === id)!).filter(Boolean)

  return <>
    <header className="site-header">
      <a className="brand" href="?example=electronics" onClick={event => { event.preventDefault(); choose(examples.find(example => example.id === 'electronics')!) }} aria-label="b123-fiber sandbox home"><span className="brand-icon"><Icon name="cube" size={23} /></span><span>b123<span className="brand-light">-fiber</span></span></a>
      <span className="header-divider" /><span className="header-label">Sandbox</span>
      <nav className="header-links" aria-label="Project links"><a href="https://build123d.readthedocs.io/en/latest/" target="_blank" rel="noreferrer">API documentation <Icon name="external" size={13} /></a><a href="https://github.com/tscircuit/b123-fiber" target="_blank" rel="noreferrer"><Icon name="github" size={17} /><span>GitHub</span></a></nav>
    </header>

    <div className="page-shell">
      <section className="intro">
        <div><div className="eyebrow">REACT × BUILD123D</div><h1>CAD, made composable.</h1><p>Explore real geometry, inspect the JSX, and start building.</p></div>
        <div className="intro-meta"><span className="kernel-pill"><span className="status-dot" />Powered by OpenCascade</span><span className="examples-count">{examples.length} native examples <span>·</span> millimeter units</span></div>
      </section>

      <button className="mobile-browser-button" data-testid="mobile-examples-toggle" aria-expanded={browserOpen} aria-controls="example-browser" onClick={() => setBrowserOpen(!browserOpen)}><Icon name="menu" /><span>Browse {examples.length} examples</span><Icon name="chevron" /></button>
      {browserOpen && <button className="mobile-scrim" aria-label="Close example browser" onClick={() => setBrowserOpen(false)} />}
      <main className="workbench">
        <aside className={`example-browser ${browserOpen ? 'is-open' : ''}`} id="example-browser" aria-label="Example browser">
          <div className="browser-heading"><h2>Examples <span>{examples.length}</span></h2><button className="mobile-close icon-button" aria-label="Close example browser" onClick={() => setBrowserOpen(false)}><Icon name="close" /></button></div>
          <label className="search-field"><Icon name="search" /><input ref={searchRef} data-testid="example-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an example…" aria-label="Search examples" /><kbd>⌘ K</kbd></label>
          <div className="category-filters" aria-label="Filter example categories">{categoryOrder.map(item => <button key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'all' ? 'All' : categoryLabels[item]}</button>)}</div>
          <div className="browser-result-label"><span>{category === 'all' ? 'EXAMPLE LIBRARY' : categoryLabels[category]?.toUpperCase()}</span><span>{filtered.length}</span></div>
          <div className="example-list">{filtered.length ? filtered.map(example => <button key={example.id} className={`example-card ${selected.id === example.id ? 'is-selected' : ''}`} data-testid="example-card" data-example-id={example.id} aria-pressed={selected.id === example.id} onClick={() => choose(example)}><span className="example-thumbnail"><img src={example.thumbnailUrl} alt="" width="72" height="58" loading="lazy" /></span><span className="example-card-content"><strong>{displayTitle(example.title)}</strong><span>{categoryLabels[example.category]?.replace(/s$/, '') ?? example.category} <span className="card-dot">·</span> {example.stats.dimension}D</span></span>{selected.id === example.id && <span className="selected-marker" />}</button>) : <div className="empty-state" data-testid="search-empty"><Icon name="search" size={27} /><strong>No matching examples</strong><p>Try a name like “loft” or browse another category.</p><button onClick={() => { setQuery(''); setCategory('all') }}>Clear filters</button></div>}</div>
          <div className="browser-footer"><Icon name="check" size={13} /> Native kernel generated geometry</div>
        </aside>

        <section className="model-workspace" data-example-id={selected.id} aria-label="Selected example">
          <header className="model-header"><div className="model-heading"><div className="model-breadcrumb"><span>{categoryLabels[selected.category]}</span><Icon name="chevron" size={10} /><span>{geometryKind} geometry</span></div><h2 data-testid="example-title">{displayTitle(selected.title)}</h2></div><button className="icon-button share-button" title="Copy a link to this example" aria-label="Copy example link" onClick={() => { const url = new URL(window.location.href); url.searchParams.set('example', selected.id); void copy(url.toString(), 'Example link copied') }}><Icon name="external" /></button></header>
          <div className="model-stage">
            <div className="viewer-toolbar"><div className="view-buttons" aria-label="Camera view">{(['iso', 'top', 'front', 'right'] as CadView[]).map(item => <button key={item} data-testid={`view-${item}`} aria-pressed={view === item} onClick={() => setView(item)} title={`${viewLabels[item]} view`}>{item === 'iso' ? 'Iso' : viewLabels[item]}</button>)}</div><div className="viewer-tools"><button className={`icon-button ${edges ? 'tool-active' : ''}`} data-testid="toggle-edges" aria-label="Show topology edges" aria-pressed={edges} title="Toggle topology edges" onClick={() => setEdges(!edges)}><Icon name="edges" /></button><button className="icon-button" data-testid="reset-view" aria-label="Fit model to view" title="Fit model to view" onClick={() => setResetToken(token => token + 1)}><Icon name="reset" /></button><button className="icon-button" aria-label="Download view image" title="Download view image" disabled={!model} onClick={() => setScreenshotToken(token => token + 1)}><Icon name="camera" /></button></div></div>
            <CadViewer model={model} modelId={modelId} title={displayTitle(selected.title)} view={view} edges={edges} resetToken={resetToken} screenshotToken={screenshotToken} />
            {loading && <div className="model-status" role="status" data-testid="model-loading"><span className="spinner" />Loading native geometry…</div>}
            {loadError && <div className="model-status model-error" role="alert"><strong>{loadError}</strong><button onClick={() => setRetryToken(token => token + 1)}>Try again</button></div>}
            <div className="axis-widget" aria-hidden="true"><svg viewBox="0 0 65 65"><path d="M28 40 54 49" stroke="#c26a64" /><path d="M28 40 8 50" stroke="#669b78" /><path d="M28 40V10" stroke="#5a84b9" /><circle cx="28" cy="40" r="2.5" fill="#8494ac" /><text x="56" y="55" fill="#b3534d">X</text><text x="1" y="57" fill="#458160">Y</text><text x="25" y="8" fill="#4273aa">Z</text></svg></div>
            <div className="canvas-hint"><span>Drag to orbit</span><span>Scroll to zoom</span></div><span className="canvas-unit">mm</span>
          </div>
          <div className="model-metrics"><div><span>PARTS</span><strong>{selected.stats.meshCount.toString().padStart(2, '0')}</strong></div><div><span>TRIANGLES</span><strong>{count(selected.stats.triangles)}</strong></div><div><span>{selected.stats.dimension === 3 ? 'VOLUME' : 'AREA'}</span><strong>{measure(selected.stats.dimension === 3 ? selected.stats.volume : selected.stats.area)} <small>mm{selected.stats.dimension === 3 ? '³' : '²'}</small></strong></div><div><span>TOPOLOGY</span><strong className={selected.stats.valid ? 'valid-status' : 'invalid-status'}><span className="status-dot" />{selected.stats.valid ? 'Valid' : 'Invalid'}</strong></div></div>
          <div className="model-description"><span className="description-icon"><Icon name="cube" size={18} /></span><p>{selected.description}</p></div>
        </section>

        <aside className="code-panel" aria-label="Example source and metadata">
          <div className="code-tabs" role="tablist" aria-label="Example details">{(['jsx', 'plan', 'details'] as const).map(item => <button id={`tab-${item}`} key={item} role="tab" aria-selected={tab === item} aria-controls="code-content" onClick={() => setTab(item)}>{item === 'jsx' ? 'JSX' : item === 'plan' ? 'Plan' : 'Details'}</button>)}<button className="icon-button copy-button" aria-label={tab === 'details' ? 'Copy model metadata' : 'Copy source'} title="Copy to clipboard" onClick={() => void copy(tab === 'details' ? JSON.stringify({ ...selected.stats, bounds: model?.bounds, kernel: model?.kernel }, null, 2) : source)}><Icon name="copy" size={14} /></button></div>
          <div className="code-file"><Icon name={tab === 'details' ? 'layers' : 'code'} size={13} /><span>{tab === 'jsx' ? `${selected.id}.tsx` : tab === 'plan' ? `${selected.id}.plan.json` : 'Native geometry'}</span><span className="file-language">{tab === 'jsx' ? 'REACT' : tab === 'plan' ? 'JSON' : 'OCCT'}</span></div>
          <div className="code-content" role="tabpanel" id="code-content" aria-labelledby={`tab-${tab}`} tabIndex={0}>{tab !== 'details' ? <SourceCode source={source} /> : <div className="geometry-details"><h3>Geometry information</h3><dl><div><dt>Kernel</dt><dd>{model?.kernel ?? 'OpenCascade'}</dd></div><div><dt>Units</dt><dd>Millimeters</dd></div><div><dt>Dimension</dt><dd>{selected.stats.dimension}D · {geometryKind}</dd></div><div><dt>Surface area</dt><dd>{measure(selected.stats.area)} mm²</dd></div><div><dt>Bounding size</dt><dd>{dimensions ? dimensions.map(measure).join(' × ') + ' mm' : 'Loading…'}</dd></div></dl><h3>Parts <span>{selected.stats.meshCount}</span></h3>{model?.meshes.map((part, index) => <div className="part-row" key={index}><span className="part-swatch" style={{ background: typeof part.color === 'string' ? part.color : Array.isArray(part.color) ? `rgb(${part.color.slice(0, 3).map(value => value * 255).join(',')})` : '#5f9bd5' }} /><span>{part.name ?? `${part.kind || geometryKind} ${index + 1}`}</span><Icon name={part.valid ? 'check' : 'close'} size={12} /></div>)}<p className="details-note">Meshes retain native part boundaries, topology edges, and kernel validation.</p></div>}</div>
          <div className="code-footnote"><span className="status-dot" />{tab === 'jsx' ? 'Faithful build123d API, in React' : tab === 'plan' ? 'Serializable native modeling plan' : 'Generated with native OpenCascade'}</div>
          <div className="download-actions"><button onClick={() => download(`${selected.id}.plan.json`, selected.plan)}><Icon name="download" size={14} />Plan JSON</button><button disabled={!model} onClick={() => model && download(`${selected.id}.mesh.json`, model)}><Icon name="download" size={14} />Mesh JSON</button></div>
        </aside>
      </main>

      <section className="explore-section" aria-label="Featured examples"><div className="explore-heading"><h2>More to explore</h2><p>From a single curve to a complete assembly.</p></div><div className="featured-grid">{featured.map(example => <button key={example.id} className="featured-card" onClick={() => { choose(example); document.querySelector('.workbench')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} data-featured-example-id={example.id}><img src={example.thumbnailUrl} loading="lazy" alt="" /><div><span>{categoryLabels[example.category]}</span><strong>{displayTitle(example.title)}</strong></div><Icon name="arrow" size={16} /></button>)}</div></section>
      <footer className="site-footer"><span><span className="footer-brand">b123-fiber</span> <span className="footer-separator">/</span> React components. Native CAD.</span><span>Built with <a href="https://tscircuit.com" target="_blank" rel="noreferrer">tscircuit</a><span className="footer-separator">·</span>OpenCascade meshes generated ahead of time</span></footer>
    </div>
    <div className={`toast ${notice ? 'is-visible' : ''}`} role="status" aria-live="polite">{notice && <><Icon name="check" size={16} />{notice}</>}</div>
  </>
}

createRoot(document.getElementById('root')!).render(<App />)
