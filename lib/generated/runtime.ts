/** JSON values understood by the native build123d service. */
export type NativeEnumValue = Readonly<{ $enum: string }>
export type NativeTypeValue = Readonly<{ $type: string; path?: string }>
export type NativeCallValue = Readonly<{
  $call: string
  args: readonly unknown[]
  kwargs: Readonly<Record<string, unknown>>
}>

export function lambdaExpression(body: (...args: Readonly<{ $arg: number }>[]) => unknown): Readonly<{ $lambda: unknown }>
export function lambdaExpression(body: unknown): Readonly<{ $lambda: unknown }>
export function lambdaExpression(body: unknown): Readonly<{ $lambda: unknown }> {
  const expression = typeof body === "function"
    ? body(...Array.from({ length: Math.max(body.length, 1) }, (_, index) => ({ $arg: index })))
    : body
  return { $lambda: expression }
}

/** Compose native calls without evaluating geometry on the JavaScript side. */
export const expr = Object.freeze({
  call(name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}) {
    return { $call: name, args, kwargs } as const
  },
  type(name: string, path?: string) {
    return path === undefined ? { $type: name } as const : { $type: name, path } as const
  },
  enum(name: string) { return { $enum: name } as const },
  ref(id: string) { return { $ref: id } as const },
  method(target: unknown, name: string, args: readonly unknown[] = [], kwargs: Readonly<Record<string, unknown>> = {}) {
    return { $method: { target, name, args, kwargs } } as const
  },
  get(target: unknown, name: string) { return { $get: { target, name } } as const },
  index(target: unknown, index: unknown) { return { $index: { target, index } } as const },
  slice(target: unknown, start?: number | null, stop?: number | null, step?: number | null) {
    return { $index: { target, index: { $slice: [start ?? null, stop ?? null, step ?? null] } } } as const
  },
  operator(target: unknown, name: string, args: readonly unknown[] = []) {
    return { $operator: { target, name, args } } as const
  },
  arg(index = 0) { return { $arg: index } as const },
  /** A callback body is an expression, or a function that builds one once. */
  lambda: lambdaExpression,
  conditional(condition: unknown, thenValue: unknown, elseValue: unknown) {
    return { $if: { condition, then: thenValue, else: elseValue } } as const
  },
})

export type NativeFactory = {
  (...args: readonly unknown[]): NativeCallValue
  withKwargs(kwargs: Readonly<Record<string, unknown>>, ...args: readonly unknown[]): NativeCallValue
  static(path: string): NativeTypeValue
}

/** Build a callable symbolic type/function with its real static API. */
export function createSymbol<const Members extends Readonly<Record<string, "value" | "call">>>(
  name: string,
  members: Members,
): NativeFactory & {
  readonly [Key in keyof Members]: Members[Key] extends "call" ? NativeFactory : NativeTypeValue
} {
  const makeCall = (args: readonly unknown[], kwargs: Readonly<Record<string, unknown>>) =>
    Object.freeze({ $call: name, args, kwargs })
  const factory = ((...args: readonly unknown[]) => makeCall(args, {})) as NativeFactory
  Object.defineProperties(factory, {
    withKwargs: { value: (kwargs: Readonly<Record<string, unknown>>, ...args: readonly unknown[]) => makeCall(args, kwargs) },
    static: { value: (path: string) => Object.freeze({ $type: name, path }) },
  })
  for (const [member, kind] of Object.entries(members)) {
    // A few inherited Python members share JavaScript Function properties.
    // They are available via `.static(name)` and client.callStatic instead.
    if (["name", "length", "prototype", "arguments", "caller", "withKwargs", "static"].includes(member)) continue
    Object.defineProperty(factory, member, {
      value: kind === "call"
        ? createSymbol(`${name}.${member}`, {})
        : Object.freeze({ $type: name, path: member }),
      enumerable: true,
    })
  }
  return Object.freeze(factory) as NativeFactory & {
    readonly [Key in keyof Members]: Members[Key] extends "call" ? NativeFactory : NativeTypeValue
  }
}
