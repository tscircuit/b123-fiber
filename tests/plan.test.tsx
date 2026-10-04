import { createElement, forwardRef, memo, useState, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Box, BuildPart, BuildSketch, Circle, Extrude, Group, NativeNode, build123d, components } from '../lib/components.js'
import { createBuild123dRoot, renderToBuild123dPlan } from '../lib/headless.js'
import { call, reference, serializeValue } from '../lib/plan.js'
import { componentSymbols } from '../lib/generated/symbols.js'
import { NativeClient, NativeHandle } from '../lib/client.js'

describe('static React plan compiler', () => {
  it('preserves native builder nesting, enums, constants and symbolic values', () => {
    const plan = renderToBuild123dPlan(
      <BuildPart name="plate">
        <BuildSketch plane={build123d.Plane.XY}>
          <Circle radius={5 * build123d.MM} align={build123d.Align.CENTER} />
        </BuildSketch>
        <Extrude amount={2} />
      </BuildPart>,
    )
    expect(plan).toEqual({ version: 1, children: [{
      type: 'BuildPart', props: { name: 'plate' }, children: [
        { type: 'BuildSketch', props: { plane: { $type: 'Plane', path: 'XY' } }, children: [
          { type: 'Circle', props: { radius: 5, align: { $enum: 'Align.CENTER' } }, children: [] },
        ] },
        { type: 'extrude', props: { amount: 2 }, children: [] },
      ],
    }] })
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('handles function components, nested arrays, fragments, memo and forwardRef', () => {
    const Forward = forwardRef<unknown, { size: number }>((props, ref) => <Box ref={ref} length={props.size} width={2} height={3} />)
    const Pure = memo(({ size }: { size: number }) => <><Forward size={size} />{[null, false, <Circle key="c" radius={size} />]}</>)
    const plan = renderToBuild123dPlan(<Group>{[<Pure key="p" size={4} />, ' ', undefined]}</Group>)
    expect(plan.children[0].children.map(node => node.type)).toEqual(['Box', 'Circle'])
    expect(plan.children[0].children[0].props).toEqual({ length: 4, width: 2, height: 3 })
  })

  it('exposes every generated constructor/function as an exact-name component', () => {
    for (const symbol of componentSymbols) {
      const Component = components[symbol] as ComponentType<{ args: readonly unknown[] }>
      const plan = renderToBuild123dPlan(createElement(Component, { args: [] }))
      expect(plan.children[0].type).toBe(symbol)
    }
    expect(renderToBuild123dPlan(<NativeNode type="make_brake_formed" args={[]} />).children[0].type).toBe('make_brake_formed')
    expect(renderToBuild123dPlan(<build123d.Box length={1} width={2} height={3} />).children[0].type).toBe('Box')
  })

  it('retains native static methods and defers selectors until CAD evaluation', () => {
    expect(build123d.Solid.make_box(1, 2, 3)).toEqual({ $call: 'Solid.make_box', args: [1, 2, 3], kwargs: {} })
    const edges = call('edges', [], { select: build123d.Select.LAST })
    const plan = renderToBuild123dPlan(<build123d.fillet objects={edges} radius={0.1} />)
    expect(plan.children[0].props.objects).toEqual({ $call: 'edges', args: [], kwargs: { select: { $enum: 'Select.LAST' } } })
    expect(reference('plate')).toEqual({ $ref: 'plate' })
  })

  it('rejects unsupported text, host elements and async components with useful errors', () => {
    expect(() => renderToBuild123dPlan('label')).toThrow(/Text and numbers/)
    expect(() => renderToBuild123dPlan(<div />)).toThrow(/Unknown CAD node/)
    const Async = async () => <Box length={1} width={1} height={1} />
    expect(() => renderToBuild123dPlan(<Async />)).toThrow(/asynchronous/)
  })

  it('directs hook users to the real renderer', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const WithHooks = () => { const [size] = useState(2); return <Box length={size} width={1} height={1} /> }
    try {
      expect(() => renderToBuild123dPlan(<WithHooks />)).toThrow(/createBuild123dRoot/)
    } finally { consoleError.mockRestore() }
  })

  it('rejects hooks even inside an active React render and restores the caller dispatcher', () => {
    const HookModel = () => { useState(10); return <Circle radius={1} /> }
    let compileError: unknown
    function Parent() {
      try { renderToBuild123dPlan(<HookModel />) } catch (error) { compileError = error }
      const [size] = useState(3)
      return <Box length={size} width={1} height={1} />
    }
    const root = createBuild123dRoot()
    const plan = root.render(<Parent />)
    expect((compileError as Error).message).toMatch(/createBuild123dRoot/)
    expect(plan.children[0].props.length).toBe(3)
    root.unmount()
  })

  it('rejects non-JSON values with the native parameter path', () => {
    expect(() => renderToBuild123dPlan(<Box length={NaN} width={1} height={1} />)).toThrow(/Box.length must be finite/)
    expect(() => renderToBuild123dPlan(<Box length={1} width={1} height={1} edges={() => []} />)).toThrow(/Box.edges is not serializable/)
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(() => serializeValue(cycle, 'Box.input')).toThrow(/Box.input.self contains a circular/)
    expect(() => serializeValue(new Date())).toThrow(/Date/)
    expect(serializeValue(new Float32Array([1, 2, 3]))).toEqual([1, 2, 3])
    const repeated = { x: 1 }
    expect(serializeValue([repeated, repeated])).toEqual([{ x: 1 }, { x: 1 }])
  })

  it('accepts retained native handles and rejects handles after release', () => {
    const client = new NativeClient()
    const handle = new NativeHandle(client, 'native-solid-1', 'Solid')
    const plan = renderToBuild123dPlan(<NativeNode type="add" objects={handle} />)
    expect(plan.children[0].props.objects).toEqual({ $ref: 'native-solid-1' })
    handle.markReleased()
    expect(() => serializeValue(handle)).toThrow(/has been released/)
  })
})
