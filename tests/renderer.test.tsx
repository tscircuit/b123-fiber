import { Component, createContext, createRef, forwardRef, memo, useContext, useEffect, useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Box, Group, Sphere } from '../lib/components.js'
import { createBuild123dRoot, type Build123dInstance } from '../lib/renderer.js'
import type { Build123dPlan } from '../lib/types.js'

describe('live React CAD renderer', () => {
  it('uses real React state and context, emits committed plans, and cleans up effects', () => {
    const Color = createContext('red')
    let setSize!: (size: number) => void
    let mounted = 0
    let cleaned = 0
    const commits: Build123dPlan[] = []
    function Model() {
      const [size, update] = useState(2)
      setSize = update
      const color = useContext(Color)
      useEffect(() => { mounted++; return () => { cleaned++ } }, [])
      return <Box length={size} width={size} height={1} color={color} />
    }
    const root = createBuild123dRoot({ onCommit: plan => commits.push(plan) })
    expect(root.render(<Color value="blue"><Model /></Color>).children[0].props).toMatchObject({ length: 2, color: 'blue' })
    expect(mounted).toBe(1)
    expect(root.flush(() => setSize(5)).children[0].props.length).toBe(5)
    expect(commits.map(plan => plan.children[0]?.props.length)).toEqual([2, 5])
    // A caller cannot mutate either the previous committed plan or renderer state.
    commits[0].children[0].props.length = 99
    const snapshot = root.getPlan(); snapshot.children.length = 0
    expect(root.getPlan().children[0].props.length).toBe(5)
    root.unmount()
    expect(cleaned).toBe(1)
    expect(root.disposed).toBe(true)
    expect(root.getPlan().children).toEqual([])
    expect(() => root.render(<Box length={1} width={1} height={1} />)).toThrow(/unmounted/)
    root.unmount()
  })

  it('preserves keyed ordering, updates props and removes geometry', () => {
    const root = createBuild123dRoot()
    const scene = (keys: string[]) => <Group>{keys.map((key, index) => <Box key={key} name={key} length={index + 1} width={1} height={1} />)}</Group>
    root.render(scene(['a', 'b', 'c']))
    let plan = root.render(scene(['c', 'a', 'd']))
    expect(plan.children[0].children.map(node => node.props.name)).toEqual(['c', 'a', 'd'])
    expect(plan.children[0].children.map(node => node.props.length)).toEqual([1, 2, 3])
    plan = root.render(<Group><Sphere radius={2} /></Group>)
    expect(plan.children[0].children).toEqual([{ type: 'Sphere', props: { radius: 2 }, children: [] }])
    expect(root.render(null).children).toEqual([])
    root.unmount()
  })

  it('supports memo, forwardRef and host refs without leaking refs into the wire plan', () => {
    const ref = createRef<Build123dInstance>()
    const Forward = forwardRef<Build123dInstance>((_props, forwarded) => <Box ref={forwarded} length={1} width={2} height={3} />)
    const Model = memo(() => <Forward ref={ref} />)
    const root = createBuild123dRoot()
    const plan = root.render(<Model />)
    expect(ref.current?.type).toBe('Box')
    expect(plan.children[0].props).toEqual({ length: 1, width: 2, height: 3 })
    root.unmount()
    expect(ref.current).toBeNull()
  })

  it('isolates roots and unsubscribes commit observers', () => {
    const first = createBuild123dRoot()
    const second = createBuild123dRoot()
    let observed = 0
    const unsubscribe = first.subscribe(() => { observed++ })
    first.render(<Box length={2} width={1} height={1} />)
    second.render(<Sphere radius={3} />)
    unsubscribe()
    first.render(<Box length={4} width={1} height={1} />)
    expect(observed).toBe(1)
    expect(first.getPlan().children[0].props.length).toBe(4)
    expect(second.getPlan().children[0].type).toBe('Sphere')
    first.unmount(); second.unmount()
  })

  it('commits state updates scheduled normally outside root.flush', async () => {
    let update!: (value: number) => void
    function Model() {
      const [length, setLength] = useState(1)
      update = setLength
      return <Box length={length} width={1} height={1} />
    }
    const root = createBuild123dRoot()
    root.render(<Model />)
    const committed = new Promise<void>(resolve => {
      const unsubscribe = root.subscribe(plan => {
        if (plan.children[0]?.props.length === 7) { unsubscribe(); resolve() }
      })
    })
    update(7)
    await committed
    expect(root.getPlan().children[0].props.length).toBe(7)
    root.unmount()
  })

  it('surfaces native prop validation errors to the caller', () => {
    const root = createBuild123dRoot()
    expect(() => root.render(<Box length={Infinity} width={1} height={1} />)).toThrow(/Box.length must be finite/)
    root.unmount()
  })

  it('supports React error boundaries and fallback model recovery', () => {
    let caught: unknown
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(error: unknown) { caught = error }
      render() { return this.state.failed ? <Sphere radius={1} /> : this.props.children }
    }
    const Broken = () => { throw new Error('bad design') }
    const root = createBuild123dRoot()
    const plan = root.render(<Boundary><Broken /></Boundary>)
    expect((caught as Error).message).toBe('bad design')
    expect(plan.children[0].type).toBe('Sphere')
    root.unmount()
  })
})
