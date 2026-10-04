import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Build123dView } from '../../lib/viewer'
import type { CadView } from '../../lib/three'
import type { RenderResult } from '../../lib/types'
import { visualFixtures } from './fixtures'
import './style.css'

const query = new URLSearchParams(window.location.search)
const testMode = query.get('test') === '1'
const initial = visualFixtures.find(f => f.id === query.get('case')) ?? visualFixtures[0]!
const views: CadView[] = ['iso', 'top', 'front', 'right']
declare global { interface Window { __CAD_VISUAL__: { id: string; result?: RenderResult; error?: string }; __CAD_FIXTURES__: typeof visualFixtures } }
window.__CAD_FIXTURES__ = visualFixtures

function Gallery() {
  const [fixture, setFixture] = useState(initial)
  const [view, setView] = useState<CadView>(views.includes(query.get('view') as CadView) ? query.get('view') as CadView : 'iso')
  const [result, setResult] = useState<RenderResult>()
  const [error, setError] = useState<string>()
  const choose = (id: string) => { setFixture(visualFixtures.find(f => f.id === id)!); setResult(undefined); setError(undefined) }
  window.__CAD_VISUAL__ = { id: fixture.id, result, error }
  return <main className={testMode ? 'test-mode' : ''}>
    <header><div><span className="eyebrow">BUILD123D FIBER / OPENCASCADE</span><h1>Native CAD, composed in React.</h1><p>{visualFixtures.length} native geometry cases · four engineering views · interactive orbit controls</p></div><span className="kernel">OCCT 8 · build123d 0.13</span></header>
    <section className="workbench">
      <aside><label htmlFor="fixture-select">Geometry gallery</label><select id="fixture-select" value={fixture.id} onChange={e => choose(e.target.value)}>{visualFixtures.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}</select><nav>{visualFixtures.map(f => <button key={f.id} data-active={fixture.id === f.id} onClick={() => choose(f.id)}><span>{f.title}</span><small>{f.category}</small></button>)}</nav></aside>
      <article><div className="toolbar"><div><span className="eyebrow">{fixture.category}</span><h2>{fixture.title}</h2></div><div className="views">{views.map(v => <button key={v} data-testid={`view-${v}`} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'iso' ? 'Isometric' : v[0]!.toUpperCase() + v.slice(1)}</button>)}</div></div>
        <Build123dView plan={fixture.plan} view={view} tolerance={0.12} angularTolerance={0.15} style={{ height: testMode ? 640 : 'min(65vh, 660px)' }} onLoad={setResult} onError={e => setError(e.message)} />
        <footer>{error ? <span className="error">{error}</span> : result ? <><span>{result.meshes.length} shapes</span><span>{result.meshes.reduce((n,m) => n + m.indices.length / 3, 0).toLocaleString()} triangles</span><span>Volume {result.meshes.reduce((n,m) => n + m.volume, 0).toFixed(2)} mm³</span><span>{result.meshes.every(m => m.valid) ? '✓ Valid native geometry' : 'Invalid shape'}</span></> : <span>Computing native geometry…</span>}</footer>
      </article>
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Gallery />)
