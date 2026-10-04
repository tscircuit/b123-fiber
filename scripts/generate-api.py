#!/usr/bin/env python3
"""Generate the TypeScript API and inventory from the installed native kernel.

Run with the project's pinned Python environment. No hand-maintained list of CAD
symbols is used: root exports, inherited members, overloads and metaclass
properties are inspected from the same build123d runtime used by the service.
"""

from __future__ import annotations

import argparse
import enum
import inspect
import json
from pathlib import Path
import re
import types
import typing

import build123d


ROOT = Path(__file__).resolve().parents[1]
DATA_CLASSES = {
    "Axis", "BoundBox", "OrientedBoundBox", "Color", "Vector", "Matrix",
    "Plane", "Location", "Rotation", "Rot", "Pos", "GeomEncoder",
    "SheetMetalParameters", "FontManager", "DraftAngleError", "Draft",
    "Export2D", "ExportDXF", "ExportSVG", "Mesher", "ShapeList", "UVFrame",
    "Joint", "RigidJoint", "RevoluteJoint", "LinearJoint", "CylindricalJoint",
    "BallJoint",
}


def display(value: object) -> str:
    return re.sub(r"0x[0-9a-fA-F]+", "0x…", str(value))


def encode(value: object) -> object:
    if isinstance(value, enum.Enum):
        return {"$enum": f"{type(value).__name__}.{value.name}"}
    if value is None or isinstance(value, (bool, str, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return {"repr": "{" + ", ".join(sorted(display(v) for v in value)) + "}"}
    if isinstance(value, dict):
        return {
            str(k.value if isinstance(k, enum.Enum) else k): encode(v)
            for k, v in value.items()
        }
    return {"repr": display(value)}


def signature(callable_object: object, strip_self: bool = False) -> dict:
    try:
        sig = inspect.signature(callable_object)
    except (TypeError, ValueError):
        return {"text": None, "parameters": [], "return": None}
    parameters = []
    for parameter in sig.parameters.values():
        if strip_self and parameter.name in ("self", "cls"):
            continue
        item = {"name": parameter.name, "kind": parameter.kind.name,
                "required": parameter.default is inspect.Parameter.empty
                and parameter.kind not in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD)}
        if parameter.annotation is not inspect.Parameter.empty:
            item["annotation"] = display(parameter.annotation)
        if parameter.default is not inspect.Parameter.empty:
            item["default"] = encode(parameter.default)
        parameters.append(item)
    return {"text": display(sig), "parameters": parameters,
            "return": None if sig.return_annotation is inspect.Signature.empty
            else display(sig.return_annotation)}


def overloads(callable_object: object, strip_self: bool = False) -> list[dict]:
    try:
        definitions = typing.get_overloads(callable_object)
    except (AttributeError, TypeError):
        definitions = []
    return [signature(overload, strip_self) for overload in definitions]


def class_members(value: type) -> dict:
    result = {}
    # Plane.XY and Axis.Z are metaclass properties and are absent from
    # dir(Plane)/dir(Axis). Include only custom metaclasses, avoiding unrelated
    # members inherited from type. getmembers_static also finds Enum.name/value.
    metaclass_members = set()
    for meta in type(value).__mro__:
        if meta in (type, object):
            break
        metaclass_members.update(meta.__dict__)
    names = {name for name, _ in inspect.getmembers_static(value)} | metaclass_members
    for member in sorted(names):
        if member.startswith("_"):
            continue
        try:
            raw = inspect.getattr_static(value, member)
        except AttributeError:
            raw = inspect.getattr_static(type(value), member)
        if isinstance(raw, property):
            result[member] = {
                "kind": "property", "static": member in metaclass_members,
                "readable": raw.fget is not None, "writable": raw.fset is not None,
                "signature": signature(raw.fget, True) if raw.fget else None,
            }
        elif isinstance(raw, (classmethod, staticmethod)):
            fn = raw.__func__
            result[member] = {
                "kind": "method", "static": True,
                "classMethod": isinstance(raw, classmethod),
                "signature": signature(fn, isinstance(raw, classmethod)),
                "overloads": overloads(fn, isinstance(raw, classmethod)),
            }
        elif callable(raw):
            result[member] = {
                "kind": "method", "static": False,
                "signature": signature(raw, True), "overloads": overloads(raw, True),
            }
        else:
            result[member] = {"kind": "attribute", "static": True, "value": encode(raw)}
    return result


def inventory() -> dict:
    symbols = {}
    for name in build123d.__all__:
        value = getattr(build123d, name)
        item = {"name": name, "module": getattr(value, "__module__", "build123d")}
        if isinstance(value, (types.UnionType, typing._GenericAlias)):
            item.update(kind="typeAlias", annotation=display(value))
        elif inspect.isclass(value) and issubclass(value, enum.Enum):
            item.update(kind="enum", enumMembers={member: encode(v) for member, v in value.__members__.items()},
                        members=class_members(value),
                        values={member: encode(v.value) for member, v in value.__members__.items()})
        elif inspect.isclass(value):
            item.update(kind="class", bases=[base.__name__ for base in value.__bases__],
                        signature=signature(value.__init__, True),
                        overloads=overloads(value.__init__, True), members=class_members(value))
        elif callable(value):
            item.update(kind="function", signature=signature(value), overloads=overloads(value))
        else:
            item.update(kind="constant", value=encode(value))
        doc = inspect.getdoc(value)
        if doc and item["kind"] in ("class", "function"):
            item["description"] = doc.split("\n\n", 1)[0]
        symbols[name] = item
    return {"schemaVersion": 1, "build123dVersion": build123d.__version__,
            "exportCount": len(symbols), "symbols": symbols}


def ts_type(parameter: dict) -> str:
    annotation = parameter.get("annotation", "")
    if annotation in ("float", "int", "<class 'float'>", "<class 'int'>"):
        return "number"
    if annotation in ("str", "<class 'str'>"):
        return "string"
    if annotation in ("bool", "<class 'bool'>"):
        return "boolean"
    return "unknown"


def generated_files(data: dict) -> dict[Path, str]:
    symbols = data["symbols"]
    grouped = {kind: [name for name, item in symbols.items() if item["kind"] == kind]
               for kind in ("class", "function", "enum", "constant", "typeAlias")}
    banner = f"// Generated by scripts/generate-api.py from build123d {data['build123dVersion']}. Do not edit.\n"
    exports = banner + f"export const build123dVersion = {json.dumps(data['build123dVersion'])} as const\n"
    exports += f"export const publicSymbols = {json.dumps(list(symbols), indent=2)} as const\n"
    for kind in ("class", "function", "enum", "constant"):
        exports += f"export const {kind}Symbols = {json.dumps(grouped[kind], indent=2)} as const\n"
    components = [name for name in grouped["class"] if name not in DATA_CLASSES] + grouped["function"]
    exports += f"export const componentSymbols = {json.dumps(components, indent=2)} as const\n"
    exports += f"export const symbolKinds = {json.dumps({n: x['kind'] for n,x in symbols.items()}, indent=2)} as const\n"
    exports += "export type PublicSymbol = (typeof publicSymbols)[number]\n"
    exports += "export type ClassSymbol = (typeof classSymbols)[number]\n"
    exports += "export type FunctionSymbol = (typeof functionSymbols)[number]\n"

    values = banner + 'import { createSymbol } from "./runtime"\n'
    values += 'import type { NativeCallValue } from "./runtime"\n'
    values += 'import type { NativeHandle } from "../client"\n'
    values += 'export { expr } from "./runtime"\n'
    for kind in ("enum", "constant"):
        for name in grouped[kind]:
            item = symbols[name]
            value = item["enumMembers"] if kind == "enum" else item["value"]
            values += f"export const {name} = Object.freeze({json.dumps(value, indent=2)})\n"
    for name in grouped["typeAlias"]:
        values += f"export const {name} = Object.freeze({{ $type: {json.dumps(name)} }} as const)\n"
        alias = "readonly number[]" if name == "VectorLike" else "readonly [number, number, number]"
        values += f"export type {name} = {alias} | NativeCallValue | NativeHandle\n"
    values += "export const native = {\n"
    for name in grouped["class"] + grouped["function"]:
        members = symbols[name].get("members", {})
        static = {n: ("call" if m["kind"] == "method" else "value")
                  for n, m in members.items() if m.get("static")}
        values += f"  {name}: createSymbol({json.dumps(name)}, {json.dumps(static)} as const),\n"
    values += "} as const\n"
    values += "export const values = { ...native, " + ", ".join(grouped["enum"] + grouped["constant"] + grouped["typeAlias"]) + " } as const\n"
    # Nonrendering geometry helpers can be exported alongside JSX components.
    for name in grouped["class"]:
        if name in DATA_CLASSES:
            values += f"export const {name} = native.{name}\n"

    props = banner + "export type NativeKwargs = Record<string, unknown>\n"
    for name in components:
        item = symbols[name]
        prop_name = name + "Props" if item["kind"] == "class" else name[0].upper() + name[1:] + "OperationProps"
        props += f"export type {prop_name} = NativeKwargs & {{\n"
        for parameter in item["signature"]["parameters"]:
            if parameter["kind"] in ("POSITIONAL_ONLY", "VAR_POSITIONAL", "VAR_KEYWORD"):
                continue
            optional = "" if parameter["required"] else "?"
            props += f"  {parameter['name']}{optional}: {ts_type(parameter)}\n"
        props += "}\n"
    props += "export interface ComponentPropsMap {\n"
    for name in components:
        prop_name = name + "Props" if symbols[name]["kind"] == "class" else name[0].upper() + name[1:] + "OperationProps"
        props += f"  {name}: {prop_name}\n"
    props += "}\n"

    docs = f"# Native API inventory\n\nThis package targets **build123d {data['build123dVersion']}**, using its native OpenCascade kernel. The generated [inventory](api-inventory.json) contains all **{data['exportCount']} root exports**, constructor and function signatures, overloads, inherited methods, writable properties, and metaclass properties such as `Plane.XY`. Regenerate it with `.venv/bin/python scripts/generate-api.py`; `--check` verifies reproducibility.\n\n"
    docs += "The native service preserves the original Python API. JavaScript uses asynchronous RPC because geometry executes in the Python service. JSX compiles to the same native builders and operations. Python names and keyword arguments retain their spelling and angles remain in degrees.\n\n"
    docs += "```ts\nimport { NativeClient, native, Align, Axis } from 'build123d-fiber'\n\nconst client = new NativeClient({ url: 'http://127.0.0.1:8765' })\nconst box = await client.construct('Box', [], { length: 20, width: 12, height: 6 })\nconst volume = await box.get('volume')\nconst edges = await box.call('edges')\nconst vertical = await edges.call('filter_by', [Axis.Z])\nconst filleted = await box.call('fillet', [1, vertical])\nconst other = await client.api.Cylinder({ radius: 3, height: 10, align: Align.CENTER })\nconst cut = await box.operator('sub', other)\nconst solid = await client.callStatic('Solid', 'make_box', [2, 3, 4])\nawait client.callFunction('export_step', [cut, 'part.step'])\nawait Promise.all([box.release(), edges.release(), vertical.release(), filleted.release(), other.release(), cut.release(), solid.release()])\n```\n\n"
    docs += "`construct(name, args, kwargs)` and `callFunction(name, args, kwargs)` cover every exported constructor/function. `client.api.Name(kwargs)` is a convenient asynchronous namespace for keyword calls. Native objects return `NativeHandle` values, whose `.call(name, args, kwargs)`, `.get(name)`, `.set(name, value)`, `.at(index)`, `.slice(start, stop, step)`, `.operator(name, ...args)` and `.release()` expose methods, properties, indexing, algebra and lifetime management. ShapeList and other native collections support `.length()`, `.contains(value)` and `.toArray()`. Static/class methods use `callStatic(typeName, method, args, kwargs)`. Values recursively decode inside arrays and records, and handles recursively encode when passed to later operations. Call `.release()` once a handle is no longer needed; use `client.releaseAll()` to release all handles retained by that client. Handles belong to their originating client, and using released or cross-client handles throws before any request.\n\n"
    docs += "`native.Name(...args)` and `native.Name.withKwargs(kwargs, ...args)` create serializable symbolic calls for JSX props. Symbolic class attributes and static calls work as `native.Plane.XY` and `native.Solid.make_box(2, 3, 4)`. These calls execute when the service decodes the plan or RPC arguments. `values` combines symbolic classes/functions, enums, and constants into one namespace. Direct RPC objects remain native objects; their attributes are read explicitly with `.get()`. JavaScript does not overload Python's algebra operators; `.operator('add' | 'sub' | 'and' | 'mul', ...)` forwards their native equivalents.\n\n"
    docs += "The `expr` namespace composes native method/property/index/operator expressions for JSX props. For example, `expr.method(expr.call('edges'), 'filter_by', [Axis.Z])` selects vertical edges while the enclosing builder is active. `expr.index(target, -1)` and `expr.slice(target, 1, 3)` retain Python selection behavior. Native callbacks can be expressed with `expr.lambda(edge => expr.operator(expr.get(edge, 'length'), 'gt', [5]))`; this JavaScript function builds a serializable callback body once, and the native service evaluates that body for each actual edge. `expr.arg(index)` supports explicit callback arguments and `expr.conditional(condition, thenValue, elseValue)` branches on native expressions. JavaScript arithmetic/comparisons inside a callback are not transmitted; compose `expr.operator` calls instead.\n\n"
    docs += "`client.render(plan, { tolerance, angularTolerance, signal })` executes headless plans and returns OCCT mesh data using the client's configured URL, headers and error handling. RPC methods accept optional request options with a signal; `client.request(request, { signal })` exposes the complete protocol. The constructor signal is the default, and a per-request signal overrides it.\n\n"
    docs += "The bridge exposes native capabilities rather than approximating missing operations. Some APIs require their original native context or resource: builder selectors need an active builder, text needs an installed font, import/export needs a service-side path, and assembly methods need native joint/shape handles. Backend errors retain the Python exception type and message. Declarative native callbacks are supported through `expr.lambda`; arbitrary JavaScript closures, arbitrary Python code, private attributes, and raw OCP objects are outside the JSON protocol. Root coverage is not a claim that every context or every overload has its own visual regression fixture.\n\n"
    for kind, heading in (("class", "Classes"), ("function", "Functions"), ("enum", "Enums"), ("constant", "Constants"), ("typeAlias", "Type aliases")):
        docs += f"## {heading}\n\n" + ", ".join(f"`{name}`" for name in grouped[kind]) + "\n\n"
    return {
        ROOT / "docs/api-inventory.json": json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        ROOT / "docs/API.md": docs.rstrip() + "\n",
        ROOT / "lib/generated/symbols.ts": exports,
        ROOT / "lib/generated/values.ts": values,
        ROOT / "lib/generated/props.ts": props,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if generated files differ from the current runtime")
    args = parser.parse_args()
    files = generated_files(inventory())
    stale = []
    for path, content in files.items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if stale:
        parser.exit(1, "Generated API files are stale: " + ", ".join(stale) + "\n")
    print(f"{'Verified' if args.check else 'Generated'} {len(build123d.__all__)} public build123d {build123d.__version__} exports")


if __name__ == "__main__":
    main()
