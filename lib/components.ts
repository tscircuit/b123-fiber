import { createElement, type ComponentType, type ReactNode, type Ref } from 'react'
import { componentSymbols } from './generated/symbols.js'
import { values } from './generated/values.js'
import type { ComponentPropsMap } from './generated/props.js'

export interface CommonProps {
  children?: ReactNode
  args?: readonly unknown[]
  color?: string | readonly number[]
  position?: readonly [number, number, number]
  name?: string
  /** Capture the resulting native object for use with reference(id). */
  id?: string
  ref?: Ref<unknown>
  [key: string]: unknown
}
export interface BoxProps extends CommonProps { length?: number; width?: number; height?: number }
export interface CylinderProps extends CommonProps { radius?: number; height?: number; arc_size?: number }
export interface SphereProps extends CommonProps { radius?: number; arc_size1?: number; arc_size2?: number; arc_size3?: number }
export interface ConeProps extends CommonProps { bottom_radius?: number; top_radius?: number; height?: number; arc_size?: number }
export interface CircleProps extends CommonProps { radius?: number }
export interface RectangleProps extends CommonProps { width?: number; height?: number }
export interface ExtrudeProps extends CommonProps { amount?: number; dir?: readonly number[]; both?: boolean; taper?: number; until?: unknown }
export interface FilletProps extends CommonProps { radius?: number; objects?: unknown }

function component<P extends CommonProps = CommonProps>(symbol: string): ComponentType<P> {
  const Component = (props: P) => createElement(symbol, props)
  Component.displayName = symbol
  const native = values[symbol as keyof typeof values]
  if (typeof native === 'function') {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(native))) {
      if (['name', 'length', 'prototype', 'arguments', 'caller'].includes(key)) continue
      Object.defineProperty(Component, key, descriptor)
    }
  }
  return Component
}

type NativeName = typeof componentSymbols[number]
type NativeProps<Name extends NativeName> = CommonProps & (Name extends keyof ComponentPropsMap ? ComponentPropsMap[Name] | { args: readonly unknown[] } : CommonProps)
type NativeComponents = { readonly [Name in NativeName]: ComponentType<NativeProps<Name>> & Omit<typeof values[Name], keyof Function> }
/** Exact Python spelling for every renderable public constructor and function. */
export const components = Object.freeze(Object.fromEntries(componentSymbols.map(name => [name, component(name)]))) as NativeComponents

/** Native symbols, enums and symbolic values, preserving build123d's spelling. */
export const build123d = Object.freeze({ ...values, ...components })
export const b = build123d

export function NativeNode({ type, ...props }: CommonProps & { type: NativeName }) {
  return createElement(type, props)
}

export function Operation({ operation, ...props }: CommonProps & { operation: NativeName }) {
  return createElement(operation, props)
}

export const BuildPart = component('BuildPart')
export const BuildSketch = component('BuildSketch')
export const BuildLine = component('BuildLine')
export const Box = component<BoxProps>('Box')
export const Cylinder = component<CylinderProps>('Cylinder')
export const Sphere = component<SphereProps>('Sphere')
export const Cone = component<ConeProps>('Cone')
export const Torus = component('Torus')
export const Wedge = component('Wedge')
export const Circle = component<CircleProps>('Circle')
export const Ellipse = component('Ellipse')
export const Rectangle = component<RectangleProps>('Rectangle')
export const RectangleRounded = component('RectangleRounded')
export const Polygon = component('Polygon')
export const RegularPolygon = component('RegularPolygon')
export const Triangle = component('Triangle')
export const Trapezoid = component('Trapezoid')
export const SlotArc = component('SlotArc')
export const SlotCenterPoint = component('SlotCenterPoint')
export const SlotCenterToCenter = component('SlotCenterToCenter')
export const SlotOverall = component('SlotOverall')
export const Text = component('Text')
export const Line = component('Line')
export const Polyline = component('Polyline')
export const Spline = component('Spline')
export const Bezier = component('Bezier')
export const CenterArc = component('CenterArc')
export const ThreePointArc = component('ThreePointArc')
export const RadiusArc = component('RadiusArc')
export const SagittaArc = component('SagittaArc')
export const TangentArc = component('TangentArc')
export const EllipticalCenterArc = component('EllipticalCenterArc')
export const Helix = component('Helix')
export const JernArc = component('JernArc')
export const PolarLine = component('PolarLine')
export const IntersectingLine = component('IntersectingLine')
export const FilletPolyline = component('FilletPolyline')
export const Hole = component('Hole')
export const CounterBoreHole = component('CounterBoreHole')
export const CounterSinkHole = component('CounterSinkHole')
export const Locations = component('Locations')
export const GridLocations = component('GridLocations')
export const HexLocations = component('HexLocations')
export const PolarLocations = component('PolarLocations')
export const Extrude = component<ExtrudeProps>('extrude')
export const Revolve = component('revolve')
export const Sweep = component('sweep')
export const Loft = component('loft')
export const Fillet = component<FilletProps>('fillet')
export const Chamfer = component('chamfer')
export const Offset = component('offset')
export const Shell = component('Shell')
export const Split = component('split')
export const Mirror = component('mirror')
export const Scale = component('scale')
export const MakeFace = component('make_face')
export const MakeHull = component('make_hull')
export const Add = component('add')
export const Project = component('project')
export const Trace = component('trace')
export const Thicken = component('thicken')
export const FullRound = component('full_round')
export const Section = component('section')
export const Union = component('Union')
export const Subtract = component('Subtract')
export const Intersect = component('Intersect')
export const Translate = component('Translate')
export const Rotate = component('Rotate')
export const Group = component('Group')
export const Shape = component('Shape')
export const Call = component('Call')
