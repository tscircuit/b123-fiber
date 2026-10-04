import React, { createContext, useContext, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Box } from '../../lib/components'
import { Build123dView } from '../../lib/viewer'
import type { RenderResult } from '../../lib/types'

const Dimensions = createContext({ width: 5, height: 4 })
declare global { interface Window { __CAD_VIEWER_TEST__: { result?: RenderResult; loads: number; errors: number; error?: string }; __SET_CAD_LENGTH__?: () => void } }
window.__CAD_VIEWER_TEST__ = { loads: 0, errors: 0 }
function HookModel({ transparent }: { transparent: boolean }) {
  const [length, setLength] = useState(6)
  const dimensions = useContext(Dimensions)
  useEffect(() => { window.__SET_CAD_LENGTH__ = () => setLength(12); return () => { delete window.__SET_CAD_LENGTH__ } }, [])
  return <Box length={length} width={dimensions.width} height={dimensions.height} color={transparent ? [0.2, 0.4, 0.8, 0.35] : undefined} />
}
function Harness() {
  const [revision, setRevision] = useState(0)
  const [invalid, setInvalid] = useState(false)
  const [transparent, setTransparent] = useState(false)
  return <div style={{ font: '14px system-ui', width: '100%', maxWidth: 900 }}>
    <button onClick={() => window.__SET_CAD_LENGTH__?.()}>Update CAD hook</button>
    <button onClick={() => setRevision(value => value + 1)}>Rerender parent</button>
    <button onClick={() => setInvalid(true)}>Invalid CAD props</button>
    <button onClick={() => setTransparent(value => !value)}>Toggle transparency</button>
    <span data-testid="revision">{revision}</span>
    <Build123dView headers={{ Authorization: 'Bearer viewer-test' }} style={{ height: 500 }} onLoad={result => { window.__CAD_VIEWER_TEST__.result = result; window.__CAD_VIEWER_TEST__.loads++ }} onError={error => { window.__CAD_VIEWER_TEST__.error = error.message; window.__CAD_VIEWER_TEST__.errors++ }}>
      {invalid ? <Box length={Number.NaN} width={5} height={4} /> : <Dimensions.Provider value={{ width: 5, height: 4 }}><HookModel transparent={transparent} /></Dimensions.Provider>}
    </Build123dView>
  </div>
}
createRoot(document.getElementById('root')!).render(<Harness />)
