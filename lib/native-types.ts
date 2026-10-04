import type { NativeHandle, NativeRequestOptions } from './client'
import type { NativeClassMap, NativeClassName, NativeCallableMap, NativeSubclasses } from './generated/api-types'
import type { NativeCallValue, NativeDeferredValue, NativeTypeValue, NativeBytesValue, NativeDateValue, NativeUuidValue, NativeFileValue, NativeLambdaValue } from './generated/runtime'

/** Native arguments can defer computation to an active builder or retained object. */
export type NativeInput<Value> = Value | NativeCallValue<Value> | NativeTypeValue<Value> | Exclude<NativeDeferredValue, NativeCallValue | NativeTypeValue>
export type NativeReference<Name extends string = string> = Pick<NativeHandle, 'id' | 'kind' | 'client' | 'toJSON' | 'isReleased' | 'release'> & { readonly __nativeClass: Name }
export type NativeValue = null | boolean | number | string | NativeDeferredValue | NativeCallValue<unknown> | NativeTypeValue<unknown> | NativeBytesValue | NativeDateValue | NativeUuidValue | NativeFileValue | NativeLambdaValue | NativeReference | readonly NativeValue[] | { readonly [key: string]: NativeValue }
type UnionKeys<Union> = Union extends unknown ? keyof Union : never
export type StrictNativeUnion<Union, Whole = Union> = Union extends unknown ? Union & Partial<Record<Exclude<UnionKeys<Whole>, keyof Union>, never>> : never
export type NativeOpaque<Name extends string = string> = NativeHandle & { readonly __nativeOpaqueType?: Name }
export type NativeObjectInput<Name extends string> = NativeInput<NativeReference<Name extends keyof NativeSubclasses ? NativeSubclasses[Name] : Name> | NativeHandle>
export type NativeIterable<Value> = NativeInput<readonly Value[] | NativeReference<'ShapeList' | 'Iterator' | 'Iterable' | 'Set'> | NativeHandle>
export type NativeVectorLike = NativeInput<readonly number[] | NativeReference<'Vector' | 'Vertex'> | NativeHandle>
export type NativeRotationLike = NativeInput<readonly [number, number, number] | NativeReference<'Rotation' | 'Rot' | 'Location'> | NativeHandle>
export type EmptyNativeKwargs = { readonly [key: string]: never }

export interface NativeSignature {
  args: readonly unknown[]
  kwargs: object
  invoke: readonly unknown[]
  withKwargs: readonly unknown[]
  result: unknown
}
export type NativeInvocation<Signature> = Signature extends NativeSignature ? Signature['invoke'] : never
export type NativeResult<Signature> = Signature extends NativeSignature ? Signature['result'] : unknown
type WithOptions<Invocation> = Invocation extends readonly unknown[] ? [...Invocation, options?: NativeRequestOptions] : never
export type NativeRequestInvocation<Signature> = WithOptions<NativeInvocation<Signature>>
export type NativeKeywordCallable<Signature> = Signature extends NativeSignature
  ? keyof Signature['kwargs'] extends never ? (kwargs?: EmptyNativeKwargs) => Promise<Signature['result']>
    : {} extends Signature['kwargs'] ? (kwargs?: Signature['kwargs']) => Promise<Signature['result']>
    : (kwargs: Signature['kwargs']) => Promise<Signature['result']>
  : never

/** Overloaded symbolic calls retain positional and keyword signatures. */
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Intersection) => void ? Intersection : never
export type NativeSymbolicCallable<Signature> = UnionToIntersection<Signature extends NativeSignature ? {
  (...args: Signature['args']): NativeCallValue<Signature['result']>
  withKwargs(...invocation: Signature['withKwargs']): NativeCallValue<Signature['result']>
} : never>
export type NativeOverloadedKeywordCallable<Signature> = UnionToIntersection<NativeKeywordCallable<Signature>>
export type NativeSymbolFactory<Signature, Statics extends object = {}, Properties extends object = {}> = NativeSymbolicCallable<Signature> & {
  static<Name extends Extract<keyof Statics | keyof Properties, string>>(path: Name): NativeTypeValue<Name extends keyof Properties ? Properties[Name] : unknown>
  /** Dynamic path escape hatch, including descriptors such as Edge.static('length'). */
  static(path: string): NativeTypeValue
} & { readonly [Name in keyof Statics]: NativeSymbolicCallable<Statics[Name]> }
  & { readonly [Name in keyof Properties]: NativeTypeValue<Properties[Name]> }

type ClassInfo<Kind extends string, Item> = Kind extends NativeClassName ? NativeClassMap<Kind, Item>[Kind] : never
export type NativeMethodNames<Kind extends string> = string extends Kind ? string : Extract<keyof ClassInfo<Kind, unknown>['methods'], string>
export type NativeMethodSignature<Kind extends string, Name extends string, Item> = Kind extends NativeClassName
  ? Name extends keyof ClassInfo<Kind, Item>['methods'] ? ClassInfo<Kind, Item>['methods'][Name] : never
  : NativeSignature & { result: any }
export type NativePropertyNames<Kind extends string> = string extends Kind ? string : Extract<keyof ClassInfo<Kind, unknown>['properties'], string>
export type NativeProperty<Kind extends string, Name extends string, Item> = Kind extends NativeClassName
  ? Name extends keyof ClassInfo<Kind, Item>['properties'] ? ClassInfo<Kind, Item>['properties'][Name] : never
  : any
export type NativeWritableNames<Kind extends string> = string extends Kind ? string : Extract<keyof ClassInfo<Kind, unknown>['writable'], string>
export type NativeWritable<Kind extends string, Name extends string, Item> = Kind extends NativeClassName
  ? Name extends keyof ClassInfo<Kind, Item>['writable'] ? ClassInfo<Kind, Item>['writable'][Name] : never
  : NativeValue
export type NativeStaticMethodNames<Kind extends NativeClassName> = Kind extends NativeClassName ? Extract<keyof NativeClassMap<Kind>[Kind]['staticMethods'], string> : never
export type NativeStaticSignature<Kind extends NativeClassName, Name extends NativeStaticMethodNames<Kind>> = NativeClassMap<Kind>[Kind]['staticMethods'][Name]
export type NativeStaticPropertyNames<Kind extends NativeClassName> = Kind extends NativeClassName ? Extract<keyof NativeClassMap<Kind>[Kind]['staticProperties'], string> : never
export type NativeStaticProperty<Kind extends NativeClassName, Name extends NativeStaticPropertyNames<Kind>> = NativeClassMap<Kind>[Kind]['staticProperties'][Name]
export type NativeCallableNames = keyof NativeCallableMap
export type NativeCallableSignature<Name extends string> = Name extends NativeCallableNames ? NativeCallableMap[Name] : NativeSignature & { result: any }
export type NativeExplicitResult<Result, Inferred> = [NoInfer<Result>] extends [never] ? Inferred : NoInfer<Result>
export type NativeDynamicInvocation = [args?: readonly unknown[], kwargs?: Readonly<Record<string, unknown>>]
export type NativeDynamicRequestInvocation = [...NativeDynamicInvocation, options?: NativeRequestOptions]
export type NativeCallableInvocation<Kind extends string, Signature> = Kind extends 'Callable' ? NativeInvocation<Signature> : NativeDynamicInvocation
export type NativeCallableResult<Kind extends string, Signature> = Kind extends 'Callable' ? NativeResult<Signature> : unknown

export type NativeOperatorName = 'add' | '+' | 'sub' | '-' | 'mul' | '*' | 'truediv' | '/' | 'and' | '&' | 'or' | '|' | 'xor' | '^' | 'pow' | '**' | 'neg' | 'pos' | 'invert' | 'equal' | 'eq' | '==' | 'ne' | '!=' | 'lt' | '<' | 'le' | '<=' | 'gt' | '>' | 'ge' | '>=' | 'div' | 'matmul' | '@' | 'len' | 'contains' | 'list' | 'iter' | 'mod' | '%' | 'lshift' | '<<' | 'rshift' | '>>' | 'floordiv' | '//' | 'divmod' | 'abs' | 'bool' | 'int' | 'float' | 'round' | 'reversed' | 'next' | 'setitem' | 'delitem'
export type NativeOperatorResult<Kind extends string, Name extends string, Item> = Name extends 'round' ? Kind extends 'Vector' ? NativeHandle<'Vector'> : unknown
  : Name extends 'len' | 'int' | 'float' ? number
  : Name extends 'setitem' | 'delitem' ? null
  : Kind extends 'ShapeList' ? Name extends 'lt' | '<' | 'gt' | '>' ? NativeHandle<'ShapeList', Item>
    : Name extends 'list' ? Item[] : Name extends 'contains' | 'bool' | 'equal' | 'eq' | '==' | 'ne' | '!=' ? boolean
    : Name extends 'next' ? Item : NativeHandle<'ShapeList', Item>
  : Name extends 'equal' | 'eq' | '==' | 'ne' | '!=' | 'lt' | '<' | 'le' | '<=' | 'gt' | '>' | 'ge' | '>=' | 'bool' | 'contains' ? boolean
  : Name extends 'list' ? Item[] : Name extends 'next' ? Item
  : NativeHandle

export type { NativeClassName, NativeBytesValue, NativeDateValue, NativeUuidValue, NativeFileValue, NativeLambdaValue }
