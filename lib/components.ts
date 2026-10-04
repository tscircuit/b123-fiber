import { createElement, type ComponentType, type ReactNode, type Ref } from 'react'
import { componentSymbols } from './generated/symbols.js'
import { values } from './generated/values.js'
import type { ComponentPropsMap } from './generated/props.js'
import type { NativeInput, NativeObjectInput, NativeVectorLike } from './native-types.js'

export interface CommonProps {
  children?: ReactNode
  color?: NativeInput<string | readonly number[] | NativeObjectInput<'Color'>>
  position?: NativeVectorLike
  name?: string
  /** Capture the resulting native object for use with reference(id). */
  id?: string
  ref?: Ref<unknown>
}
export type BoxProps = CommonProps & ComponentPropsMap['Box']
export type CylinderProps = CommonProps & ComponentPropsMap['Cylinder']
export type SphereProps = CommonProps & ComponentPropsMap['Sphere']
export type ConeProps = CommonProps & ComponentPropsMap['Cone']
export type CircleProps = CommonProps & ComponentPropsMap['Circle']
export type RectangleProps = CommonProps & ComponentPropsMap['Rectangle']
export type ExtrudeProps = CommonProps & ComponentPropsMap['extrude']
export type FilletProps = CommonProps & ComponentPropsMap['fillet']

function component<P extends object = CommonProps>(symbol: string): ComponentType<P> {
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
type NativeProps<Name extends NativeName> = CommonProps & ComponentPropsMap[Name]
type NativeComponents = { readonly [Name in NativeName]: ComponentType<NativeProps<Name>> & Omit<typeof values[Name], keyof Function> }
/** Exact Python spelling for every renderable public constructor and function. */
export const components = Object.freeze(Object.fromEntries(componentSymbols.map(name => [name, component(name)]))) as unknown as NativeComponents

/** Native symbols, enums and symbolic values, preserving build123d's spelling. */
export const build123d: Readonly<Omit<typeof values, NativeName> & NativeComponents> = Object.freeze({ ...values, ...components })
export const b: typeof build123d = build123d

export function NativeNode<Name extends NativeName>({ type, ...props }: NativeProps<Name> & { type: Name }) {
  return createElement(type, props)
}

export function Operation<Name extends NativeName>({ operation, ...props }: NativeProps<Name> & { operation: Name }) {
  return createElement(operation, props)
}

export const BuildPart = components.BuildPart
export const BuildSketch = components.BuildSketch
export const BuildLine = components.BuildLine
export const Box = components.Box
export const Cylinder = components.Cylinder
export const Sphere = components.Sphere
export const Cone = components.Cone
export const Torus = components.Torus
export const Wedge = components.Wedge
export const Circle = components.Circle
export const Ellipse = components.Ellipse
export const Rectangle = components.Rectangle
export const RectangleRounded = components.RectangleRounded
export const Polygon = components.Polygon
export const RegularPolygon = components.RegularPolygon
export const Triangle = components.Triangle
export const Trapezoid = components.Trapezoid
export const SlotArc = components.SlotArc
export const SlotCenterPoint = components.SlotCenterPoint
export const SlotCenterToCenter = components.SlotCenterToCenter
export const SlotOverall = components.SlotOverall
export const Text = components.Text
export const Line = components.Line
export const Polyline = components.Polyline
export const Spline = components.Spline
export const Bezier = components.Bezier
export const CenterArc = components.CenterArc
export const ThreePointArc = components.ThreePointArc
export const RadiusArc = components.RadiusArc
export const SagittaArc = components.SagittaArc
export const TangentArc = components.TangentArc
export const EllipticalCenterArc = components.EllipticalCenterArc
export const Helix = components.Helix
export const JernArc = components.JernArc
export const PolarLine = components.PolarLine
export const IntersectingLine = components.IntersectingLine
export const FilletPolyline = components.FilletPolyline
export const Hole = components.Hole
export const CounterBoreHole = components.CounterBoreHole
export const CounterSinkHole = components.CounterSinkHole
export const Locations = components.Locations
export const GridLocations = components.GridLocations
export const HexLocations = components.HexLocations
export const PolarLocations = components.PolarLocations
export const Extrude = components.extrude
export const Revolve = components.revolve
export const Sweep = components.sweep
export const Loft = components.loft
export const Fillet = components.fillet
export const Chamfer = components.chamfer
export const Offset = components.offset
export const Shell = components.Shell
export const Split = components.split
export const Mirror = components.mirror
export const Scale = components.scale
export const MakeFace = components.make_face
export const MakeHull = components.make_hull
export const Add = components.add
export const Project = components.project
export const Trace = components.trace
export const Thicken = components.thicken
export const FullRound = components.full_round
export const Section = components.section
export const Union = component<CommonProps & { mode?: typeof values.Mode[keyof typeof values.Mode] }>('Union')
export const Subtract = component<CommonProps & { mode?: typeof values.Mode[keyof typeof values.Mode] }>('Subtract')
export const Intersect = component<CommonProps & { mode?: typeof values.Mode[keyof typeof values.Mode] }>('Intersect')
export const Translate = component<CommonProps & { offset?: readonly number[]; vector?: readonly number[]; args?: readonly [readonly number[]]; x?: number; y?: number; z?: number }>('Translate')
export const Rotate = component<CommonProps & { rotation?: readonly [number, number, number]; angles?: readonly [number, number, number]; args?: readonly [readonly [number, number, number]]; x?: number; y?: number; z?: number }>('Rotate')
export const Group = component('Group')
export const Shape = component<CommonProps & { shape?: NativeObjectInput<'Shape'>; value?: NativeObjectInput<'Shape'>; args?: readonly [NativeObjectInput<'Shape'>]; mode?: typeof values.Mode[keyof typeof values.Mode] }>('Shape')
export const Call = component<CommonProps & { symbol?: string; function?: string; target?: unknown; args?: readonly unknown[]; kwargs?: Readonly<Record<string, unknown>>; mode?: typeof values.Mode[keyof typeof values.Mode] }>('Call')
