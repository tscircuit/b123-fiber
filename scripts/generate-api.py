#!/usr/bin/env python3
"""Generate the TypeScript API and inventory from the installed native kernel.

Run with the project's pinned Python environment. No hand-maintained list of CAD
symbols is used: root exports, inherited members, overloads and metaclass
properties are inspected from the same build123d runtime used by the service.
"""

from __future__ import annotations

import argparse
import ast
import enum
import io
import inspect
import json
from pathlib import Path
import re
import types
import typing
import textwrap

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


AUXILIARY = {"ColorIndex": build123d.ColorIndex, "BytesIO": io.BytesIO, "StringIO": io.StringIO}
CHILD_OPERANDS = {
    "extrude": "to_extrude", "revolve": "profiles", "loft": "sections", "sweep": "sections",
    "thicken": "to_thicken", "fillet": "objects", "chamfer": "objects", "offset": "objects",
    "mirror": "objects", "scale": "objects", "split": "objects", "make_face": "edges",
    "make_hull": "edges", "trace": "lines", "add": "objects", "insert": "objects",
    "section": "obj", "project": "objects", "draft": "faces", "full_round": "edge",
    "make_brake_formed": "line", "bounding_box": "objects", "pack": "objects", "edges_to_wires": "edges",
}


def binding_symbols(data: dict) -> dict:
    """Bindings include useful native auxiliaries without changing __all__ coverage."""
    symbols = dict(data["symbols"])
    # Root selectors are contextual wrappers of Builder methods: their public
    # call binds `self` from the active builder, unlike the introspected wrapper.
    for name in ("solids", "faces", "wires", "edges", "vertices", "solid", "face", "wire", "edge", "vertex"):
        item = symbols[name]
        sig = item["signature"]
        symbols[name] = {**item, "signature": {**sig, "parameters": [p for p in sig["parameters"] if p["name"] != "self"]}}
    for name, value in {"Shape": build123d.Shape, **AUXILIARY}.items():
        if inspect.isclass(value) and issubclass(value, enum.Enum):
            symbols[name] = {"kind": "enum", "enumMembers": {k: encode(v) for k, v in value.__members__.items()}}
        else:
            symbols[name] = {"kind": "class", "signature": signature(value.__init__, True),
                             "overloads": overloads(value.__init__, True), "members": class_members(value)}
    # Built-in stream constructors do not publish usable __init__ annotations.
    for name, parameter, annotation, default in (
        ("BytesIO", "initial_bytes", "bytes", {"$bytes": ""}),
        ("StringIO", "initial_value", "str", ""),
    ):
        symbols[name]["signature"] = {"parameters": [{"name": parameter, "kind": "POSITIONAL_OR_KEYWORD", "required": False,
                                                       "annotation": annotation, "default": default}], "return": None}
    symbols["StringIO"]["signature"]["parameters"].append({"name": "newline", "kind": "POSITIONAL_OR_KEYWORD",
                                                         "required": False, "annotation": "str | None", "default": "\n"})
    for name in ("BytesIO", "StringIO"):
        kind = "bytes" if name == "BytesIO" else "str"
        for method, result in (("read", kind), ("readline", kind), ("getvalue", kind), ("write", "int"),
                               ("seek", "int"), ("tell", "int"), ("truncate", "int"), ("close", "None")):
            member = symbols[name]["members"].get(method)
            if member and member.get("signature"):
                sig = {**member["signature"], "return": result}
                parameters = []
                for parameter in sig["parameters"]:
                    annotation = kind if method == "write" else "int | None" if method == "truncate" else "int"
                    parameters.append({**parameter, "annotation": annotation})
                symbols[name]["members"][method] = {**member, "signature": {**sig, "parameters": parameters}}
        if "closed" in symbols[name]["members"]:
            symbols[name]["members"]["closed"] = {"kind": "property", "static": False, "writable": False,
                                                     "signature": {"parameters": [], "return": "bool"}}
    # Public fields initialized in Python constructors (e.g. Shape.label) are
    # absent from dir(Class). Infer only annotations and simple parameter/literal
    # assignments, without constructing objects or running modeling code.
    for name, item in list(symbols.items()):
        if item["kind"] != "class":
            continue
        cls = getattr(build123d, name, AUXILIARY.get(name))
        members = dict(item.get("members", {}))
        for base in reversed(getattr(cls, "__mro__", [])):
            for field, annotation in base.__dict__.get("__annotations__", {}).items():
                if field.startswith("_") or field in members or "ClassVar" in str(annotation):
                    continue
                members[field] = {"kind": "property", "static": False, "writable": True,
                                  "signature": {"parameters": [], "return": str(annotation)}}
            initializer = base.__dict__.get("__init__")
            if initializer is None:
                continue
            try:
                tree = ast.parse(textwrap.dedent(inspect.getsource(initializer)))
                params = {p["name"]: p for p in signature(initializer, True)["parameters"]}
            except (OSError, TypeError, IndentationError, SyntaxError):
                continue
            for assignment in ast.walk(tree):
                if not isinstance(assignment, (ast.Assign, ast.AnnAssign)):
                    continue
                targets = assignment.targets if isinstance(assignment, ast.Assign) else [assignment.target]
                for target in targets:
                    if not isinstance(target, ast.Attribute) or not isinstance(target.value, ast.Name) or target.value.id != "self" or target.attr.startswith("_") or target.attr in members:
                        continue
                    annotation = None
                    if isinstance(assignment, ast.AnnAssign):
                        annotation = ast.unparse(assignment.annotation)
                    elif isinstance(assignment.value, ast.Name) and assignment.value.id in params:
                        annotation = params[assignment.value.id].get("annotation")
                    elif isinstance(assignment.value, ast.IfExp):
                        for branch in (assignment.value.body, assignment.value.orelse):
                            if isinstance(branch, ast.Name) and branch.id in params:
                                annotation = params[branch.id].get("annotation")
                    elif isinstance(assignment.value, ast.Constant):
                        annotation = type(assignment.value.value).__name__
                    if annotation:
                        members[target.attr] = {"kind": "property", "static": False, "writable": True,
                                                "signature": {"parameters": [], "return": annotation}}
        for field, member in list(members.items()):
            if not member.get("writable"):
                continue
            try:
                descriptor = inspect.getattr_static(cls, field)
            except AttributeError:
                continue
            if isinstance(descriptor, property) and descriptor.fset:
                params = signature(descriptor.fset, True)["parameters"]
                if params and params[0].get("annotation"):
                    members[field] = {**member, "setterAnnotation": params[0]["annotation"]}
        symbols[name] = {**item, "members": members}
    # Public computed constructor fields whose values are not simple assignments.
    supplemental = {
        "BasePartObject": {"rotation": "Rotation"},
        "Color": {"wrapped": "Quantity_ColorRGBA | None"},
        "Mesher": {"wrapper": "Lib3MF.Wrapper", "model": "Lib3MF.Model"},
        **{name: {"output_placements": "tuple[Location, ...]", "placements": "tuple[Location, ...]"}
           for name in ("BuildPart", "BuildSketch", "BuildLine")},
    }
    for name, item in list(symbols.items()):
        if item["kind"] != "class":
            continue
        cls = getattr(build123d, name, AUXILIARY.get(name))
        members = dict(item.get("members", {}))
        for base in reversed(getattr(cls, "__mro__", [])):
            for field, annotation in supplemental.get(base.__name__, {}).items():
                members[field] = {"kind": "property", "static": False, "writable": True,
                                  "signature": {"parameters": [], "return": annotation}}
        symbols[name] = {**item, "members": members}
    return symbols


def annotation_type(annotation: str | None, symbols: dict, *, output: bool = False) -> str:
    """Translate Python typing syntax, retaining opaque native objects as handles."""
    annotation = annotation or "Any"
    annotation = re.sub(r"<(?:class|enum) '([^']+)'>", r"\1", annotation)
    try:
        node = ast.parse(annotation, mode="eval").body
    except SyntaxError:
        return "unknown" if output else "NativeValue"

    def wrap(value: str) -> str:
        return value if output else f"NativeInput<{value}>"

    def leaf(value: ast.AST) -> str:
        if isinstance(value, ast.Attribute):
            return value.attr
        if isinstance(value, ast.Name):
            return value.id
        return ""

    def render(value: ast.AST) -> str:
        if isinstance(value, ast.Constant):
            if value.value is None:
                return "null"
            if isinstance(value.value, str):
                return annotation_type(value.value, symbols, output=output)
            return json.dumps(value.value)
        if isinstance(value, ast.BinOp) and isinstance(value.op, ast.BitOr):
            return f"{render(value.left)} | {render(value.right)}"
        if isinstance(value, ast.Subscript):
            name = leaf(value.value)
            args = list(value.slice.elts) if isinstance(value.slice, ast.Tuple) else [value.slice]
            if name == "Literal":
                return wrap(" | ".join(json.dumps(arg.value) if isinstance(arg, ast.Constant) else render(arg) for arg in args))
            if name in {"Union", "Optional"}:
                return " | ".join([*(render(arg) for arg in args), *(["null"] if name == "Optional" else [])])
            if name in {"tuple", "Tuple"}:
                if len(args) == 2 and isinstance(args[-1], ast.Constant) and args[-1].value is Ellipsis:
                    return wrap(f"readonly ({render(args[0])})[]")
                return wrap("readonly [" + ", ".join(render(arg) for arg in args) + "]")
            if name == "ShapeList":
                item = render(args[0]) if args else "Item"
                return f"NativeHandle<'ShapeList', {item}>" if output else f"NativeIterable<{item}>"
            if name == "Iterator" and output:
                return f"NativeHandle<'Iterator', {render(args[0]) if args else 'unknown'}>"
            if name in {"set", "Set", "frozenset"} and output:
                return f"NativeHandle<'Set', {render(args[0]) if args else 'unknown'}>"
            if name in {"list", "List", "Iterable", "Iterator", "Sequence", "Collection", "set", "Set", "frozenset"}:
                item = render(args[0]) if args else ("unknown" if output else "NativeValue")
                if output:
                    return f"readonly ({item})[]" + (f" | NativeHandle<'Iterable', {item}>" if name in {"Iterable", "Sequence", "Collection"} else "")
                return f"NativeIterable<{item}>"
            if name in {"dict", "Dict", "Mapping", "MutableMapping"}:
                key = render(args[0]) if args else "string"
                # Enum/object keys are stringified by the JSON transport.
                if key not in {"string", "number"}:
                    key = "string"
                item = render(args[1]) if len(args) > 1 else ("unknown" if output else "NativeValue")
                return wrap(f"Readonly<Record<{key}, {item}>>")
            if name in {"Callable", "property", "type", "Type"}:
                if name == "Callable" and output and len(args) == 2:
                    callback_arguments = args[0].elts if isinstance(args[0], ast.List) else []
                    inputs = [annotation_type(ast.unparse(argument), symbols) for argument in callback_arguments]
                    positional = "readonly [" + ", ".join(f"arg{index}: {input_type}" for index, input_type in enumerate(inputs)) + "]" if isinstance(args[0], ast.List) else "readonly unknown[]"
                    result = annotation_type(ast.unparse(args[1]), symbols, output=True)
                    signature = "{ args: " + positional + "; kwargs: EmptyNativeKwargs; invoke: [args: " + positional + ", kwargs?: EmptyNativeKwargs]; withKwargs: never; result: " + result + " }"
                    return "NativeHandle<'Callable', " + signature + ">"
                return "NativeHandle" if output else "NativeLambdaValue | NativeTypeValue<unknown> | NativeReference<'Callable'> | NativeHandle"
            if name in {"PathLike"}:
                return wrap("string | NativeFileValue")
            return render(value.value)
        name = leaf(value)
        if name in {"float", "int"}:
            return wrap("number")
        if name == "str":
            return wrap("string")
        if name == "bool":
            return wrap("boolean")
        if name in {"None", "NoneType"}:
            return "null"
        if name in {"Any", "object"}:
            return "unknown" if output else "NativeValue"
        if name in {"Self"}:
            return "NativeHandle<Self, Item>" if output else "NativeObjectInput<Self>"
        if name == "T":
            return "Item" if output else "NativeInput<Item>"
        if name in {"K", "V"}:
            return "unknown" if output else "NativeValue"
        if name == "VectorLike":
            return "NativeVectorLike"
        if name == "RotationLike":
            return "NativeRotationLike"
        if name == "ColorLike":
            return "NativeHandle<'Color'>" if output else "NativeInput<string | readonly number[] | NativeObjectInput<'Color'>>"
        if name in {"date", "datetime"}:
            return "NativeDateValue" if output else wrap("NativeDateValue")
        if name == "UUID":
            return "NativeUuidValue" if output else wrap("NativeUuidValue")
        if name in {"bytes", "bytearray", "memoryview"}:
            return "Uint8Array" if output else wrap("NativeBytesValue | Uint8Array")
        if name == "PathLike":
            return wrap("string | NativeFileValue")
        if name in {"BinaryIO", "TextIO"}:
            return "NativeOpaque<'BinaryIO'>" if output else "NativeObjectInput<'BytesIO' | 'StringIO'>"
        if name in {"Callable", "property", "type", "Type", "CompositeFactory", "GeometryConstructor", "ShapeConstructor"}:
            return "NativeHandle" if output else "NativeLambdaValue | NativeTypeValue<unknown> | NativeReference<'Callable'> | NativeHandle"
        if name == "Shapes":
            return wrap("'Vertex' | 'Edge' | 'Wire' | 'Face' | 'Shell' | 'Solid' | 'Compound'")
        if name == "TrimmingTool":
            return "NativeHandle<'Plane' | 'Shell' | 'Face'>" if output else "NativeObjectInput<'Plane' | 'Shell' | 'Face'>"
        if name == "ShapeT":
            return "NativeHandle<'Shape'>" if output else "NativeObjectInput<'Shape'>"
        if name == "Builder":
            return "NativeHandle<'BuildPart' | 'BuildSketch' | 'BuildLine'>" if output else "NativeObjectInput<'BuildPart' | 'BuildSketch' | 'BuildLine'>"
        if name in {"FinishedMaterial"}:
            return "NativeOpaque<'FinishedMaterial'>" if output else wrap("NativeOpaque<'FinishedMaterial'>")
        if name in {"dict", "Mapping"}:
            return wrap("Readonly<Record<string, " + ("unknown" if output else "NativeValue") + ">>")
        if name in {"list", "tuple", "Sequence", "Iterable"}:
            return "readonly unknown[]" if output else "NativeIterable<NativeValue>"
        if name in symbols and symbols[name]["kind"] == "enum":
            return wrap(name)
        if name in symbols and symbols[name]["kind"] == "class":
            return f"NativeHandle<'{name}'>" if output else f"NativeObjectInput<'{name}'>"
        return f"NativeOpaque<{json.dumps(name or annotation)}>" if output else wrap(f"NativeOpaque<{json.dumps(name or annotation)}>")

    return render(node)


def parameter_type(parameter: dict, symbols: dict) -> str:
    annotation = parameter.get("annotation")
    if not annotation:
        value = parameter.get("default")
        if isinstance(value, bool):
            annotation = "bool"
        elif isinstance(value, (int, float)):
            annotation = "float"
        elif isinstance(value, str):
            annotation = "str"
        elif isinstance(value, dict) and "$enum" in value:
            annotation = value["$enum"].split(".")[0]
    result = annotation_type(annotation, symbols)
    path_input = not annotation or any(token in annotation for token in ("str", "Path", "IO"))
    if path_input and parameter["name"] in {"file_path", "file_name", "filename", "path", "font_path", "dxf_file", "svg_file"}:
        result += " | NativeFileValue"
    return result


def variants(item: dict) -> list[dict]:
    return item.get("overloads") or [item.get("signature") or {"parameters": [], "return": None}]


def fields(parameters: list[dict], symbols: dict, *, component: bool = False) -> str:
    entries = []
    for parameter in parameters:
        if parameter["kind"] in {"VAR_POSITIONAL", "POSITIONAL_ONLY"}:
            continue
        if parameter["kind"] == "VAR_KEYWORD":
            entries.append("readonly [key: string]: NativeValue | undefined")
        else:
            entries.append(f"{json.dumps(parameter['name'])}{'' if parameter['required'] else '?'}: {parameter_type(parameter, symbols)}")
    return "{ " + "; ".join(entries) + " }" if entries or component else "EmptyNativeKwargs"


def positional_tuple(parameters: list[dict], symbols: dict, *, optional: bool) -> str:
    entries = []
    for parameter in parameters:
        if parameter["kind"] == "VAR_POSITIONAL":
            entries.append(f"...{parameter['name']}: readonly ({parameter_type(parameter, symbols)})[]")
        else:
            entries.append(f"{parameter['name']}{'?' if optional and not parameter['required'] else ''}: {parameter_type(parameter, symbols)}")
    return "readonly [" + ", ".join(entries) + "]"


def bindings(sig: dict, symbols: dict) -> list[tuple[str, str, bool, list[dict]]]:
    parameters = sig["parameters"]
    positional = [p for p in parameters if p["kind"] in {"POSITIONAL_ONLY", "POSITIONAL_OR_KEYWORD"}]
    rest = [p for p in parameters if p["kind"] == "VAR_POSITIONAL"]
    output = []
    for count in range(len(positional) + 1):
        taken = positional[:count]
        # A required positional-only argument cannot move into kwargs.
        if any(p["kind"] == "POSITIONAL_ONLY" and p["required"] for p in positional[count:]):
            continue
        remaining = [p for p in parameters if p not in taken and p["kind"] != "VAR_POSITIONAL"]
        keyword = fields(remaining, symbols)
        required = any(p["required"] for p in remaining if p["kind"] not in {"POSITIONAL_ONLY", "VAR_KEYWORD"})
        prefix = taken + (rest if count == len(positional) else [])
        output.append((positional_tuple(prefix, symbols, optional=False), keyword, required, remaining))
    return output


def signature_type(item: dict, symbols: dict, result: str | None = None) -> str:
    output = []
    for sig in variants(item):
        parameters = sig["parameters"]
        args = positional_tuple([p for p in parameters if p["kind"] in {"POSITIONAL_ONLY", "POSITIONAL_OR_KEYWORD", "VAR_POSITIONAL"}], symbols, optional=True)
        if any(p["required"] and p["kind"] == "KEYWORD_ONLY" for p in parameters):
            args = "never"
        invocations, symbolic_kwargs = [], []
        for prefix, keyword, required, remaining in bindings(sig, symbols):
            no_args = prefix == "readonly []" or prefix.startswith("readonly [...")
            invocations.append(f"[args{'?' if no_args and not required else ''}: {prefix}, kwargs{'?' if not required else ''}: {keyword}]")
            tuple_entries = prefix[len("readonly ["):-1]
            symbolic_kwargs.append(f"[kwargs: {keyword}" + (", " + tuple_entries if tuple_entries else "") + "]")
        value = result or annotation_type(sig.get("return"), symbols, output=True)
        output.append("{ args: " + args + "; kwargs: " + fields(parameters, symbols) + "; invoke: " + (" | ".join(invocations) or "never")
                      + "; withKwargs: " + (" | ".join(symbolic_kwargs) or "never") + "; result: " + value + " }")
    return " | ".join(dict.fromkeys(output))


def component_props(item: dict, symbols: dict, name: str) -> str:
    output = []
    for sig in variants(item):
        for prefix, keyword, required, remaining in bindings(sig, symbols):
            keyword = fields([p for p in remaining if p["name"] != "children"], symbols, component=True)
            no_args = prefix == "readonly []" or prefix.startswith("readonly [...")
            output.append(keyword + f" & {{ args{'?' if no_args else ''}: {prefix} }}")
        operand = CHILD_OPERANDS.get(name)
        if operand and any(p["name"] == operand and p["required"] for p in sig["parameters"]):
            child_parameters = [{**p, "required": False} if p["name"] == operand else p for p in sig["parameters"]]
            output.append(fields(child_parameters, symbols, component=True) + " & { children: ReactNode; args?: readonly [] }")
    return " | ".join(dict.fromkeys(output)) or "{}"


def api_types(data: dict, symbols: dict, banner: str) -> str:
    classes = {name: item for name, item in symbols.items() if item["kind"] == "class"}
    result = banner + "import type { NativeHandle } from '../client'\n"
    result += "import type { NativeInput, NativeValue, NativeOpaque, NativeObjectInput, NativeIterable, NativeVectorLike, NativeRotationLike, NativeReference, EmptyNativeKwargs } from '../native-types'\n"
    result += "import type { NativeTypeValue, NativeBytesValue, NativeDateValue, NativeUuidValue, NativeFileValue, NativeLambdaValue } from './runtime'\n\n"
    result += "export type NativeClassName = " + " | ".join(json.dumps(name) for name in classes) + "\n"
    for name, item in symbols.items():
        if item["kind"] == "enum":
            result += f"export type {name} = Readonly<{{ $enum: " + " | ".join(json.dumps(value["$enum"]) for value in item["enumMembers"].values()) + " }>\n"
    result += "export interface NativeSubclasses {\n"
    runtime = {name: getattr(build123d, name, AUXILIARY.get(name)) for name in classes}
    for name, cls in runtime.items():
        children = [key for key, value in runtime.items() if inspect.isclass(value) and inspect.isclass(cls) and issubclass(value, cls)]
        result += f"  {json.dumps(name)}: " + " | ".join(json.dumps(child) for child in children) + "\n"
    result += "}\n\n"
    maps = {"methods": {}, "properties": {}, "writable": {}, "staticMethods": {}, "staticProperties": {}}
    for name, item in classes.items():
        members = item.get("members", {})
        methods = {key: value for key, value in members.items() if value["kind"] == "method"}
        instance_properties = {key: value for key, value in members.items() if value["kind"] == "attribute" or value["kind"] == "property" and not value.get("static")}
        writable = {key: value for key, value in instance_properties.items() if value.get("writable")}
        static_methods = {key: value for key, value in methods.items() if value.get("static")}
        static_properties = {key: value for key, value in members.items() if value["kind"] == "attribute" or value["kind"] == "property" and value.get("static")}
        for field, entries in (("methods", methods), ("properties", instance_properties), ("writable", writable), ("staticMethods", static_methods), ("staticProperties", static_properties)):
            maps[field][name] = entries
    for field, classes_entries in maps.items():
        for name, entries in classes_entries.items():
            cls = runtime[name]
            parent = next((base.__name__ for base in getattr(cls, "__mro__", [])[1:] if base.__name__ in classes), None)
            inherited = classes_entries.get(parent, {})
            changed = {key: value for key, value in entries.items() if inherited.get(key) != value}
            removed = set(inherited) - set(entries)
            title = name + field[0].upper() + field[1:]
            parent_title = (parent or "") + field[0].upper() + field[1:]
            omit = set(changed) & set(inherited) | removed
            base = f"{parent_title}<Self, Item>" if parent else "{}"
            if omit:
                base = f"Omit<{base}, " + " | ".join(json.dumps(key) for key in sorted(omit)) + ">"
            result += f"type {title}<Self extends string, Item> = {base} & {{\n"
            for key, value in changed.items():
                if field.endswith("Methods") or field == "methods":
                    value_type = signature_type(value, symbols)
                else:
                    ann = value.get("setterAnnotation") if field == "writable" else None
                    ann = ann or (value.get("signature", {}).get("return") if value.get("signature") else None)
                    value_type = annotation_type(ann, symbols, output=field != "writable")
                    # Metaclass planes/axes have annotations; unresolved static data remains unknown.
                result += f"  {json.dumps(key)}: {value_type}\n"
            result += "}\n"
    result += "\nexport type NativeClassMap<Self extends string = NativeClassName, Item = NativeHandle> = {\n"
    for name in classes:
        result += f"  {json.dumps(name)}: {{ " + "; ".join(f"{field}: {name}{field[0].upper() + field[1:]}<Self, Item>" for field in maps) + " }\n"
    result += "}\n\nexport interface NativeCallableMap {\n"
    for name, item in symbols.items():
        if item["kind"] in {"class", "function"}:
            result += f"  {json.dumps(name)}: " + signature_type(item, symbols, f"NativeHandle<'{name}'>" if item["kind"] == "class" else None) + "\n"
    result += "}\n"
    return result


def generated_files(data: dict) -> dict[Path, str]:
    symbols = data["symbols"]
    bindings_data = binding_symbols(data)
    grouped = {kind: [name for name, item in symbols.items() if item["kind"] == kind]
               for kind in ("class", "function", "enum", "constant", "typeAlias")}
    banner = f"// Generated by scripts/generate-api.py from build123d {data['build123dVersion']}. Do not edit.\n"
    exports = banner + f"export const build123dVersion = {json.dumps(data['build123dVersion'])} as const\n"
    exports += f"export const publicSymbols = {json.dumps(list(symbols), indent=2)} as const\n"
    exports += f"export const auxiliarySymbols = {json.dumps(['Shape', *AUXILIARY])} as const\n"
    exports += "export const auxiliarySymbolKinds = { Shape: 'class', ColorIndex: 'enum', BytesIO: 'class', StringIO: 'class' } as const\n"
    for kind in ("class", "function", "enum", "constant"):
        exports += f"export const {kind}Symbols = {json.dumps(grouped[kind], indent=2)} as const\n"
    components = [name for name in grouped["class"] if name not in DATA_CLASSES] + grouped["function"]
    exports += f"export const componentSymbols = {json.dumps(components, indent=2)} as const\n"
    exports += f"export const symbolKinds = {json.dumps({n: x['kind'] for n,x in symbols.items()}, indent=2)} as const\n"
    exports += "export type PublicSymbol = (typeof publicSymbols)[number]\n"
    exports += "export type ClassSymbol = (typeof classSymbols)[number]\n"
    exports += "export type FunctionSymbol = (typeof functionSymbols)[number]\n"
    exports += "export type AuxiliarySymbol = (typeof auxiliarySymbols)[number]\n"

    values = banner + 'import { createSymbol } from "./runtime"\n'
    values += 'import type { NativeCallValue } from "./runtime"\n'
    values += 'import type { NativeHandle } from "../client"\n'
    values += 'import type { NativeSymbolFactory, NativeVectorLike, NativeRotationLike } from "../native-types"\n'
    values += 'import type { NativeCallableMap, NativeClassMap } from "./api-types"\n'
    values += 'export { expr } from "./runtime"\n'
    for kind in ("enum", "constant"):
        for name in grouped[kind]:
            item = symbols[name]
            value = item["enumMembers"] if kind == "enum" else item["value"]
            values += f"export const {name} = Object.freeze({json.dumps(value, indent=2)} as const)\n" if kind == "enum" else f"export const {name} = Object.freeze({json.dumps(value, indent=2)})\n"
    for name, value in AUXILIARY.items():
        if inspect.isclass(value) and issubclass(value, enum.Enum):
            values += f"export const {name} = Object.freeze({json.dumps({k: encode(v) for k, v in value.__members__.items()}, indent=2)} as const)\n"
    for name in grouped["typeAlias"]:
        values += f"export const {name} = Object.freeze({{ $type: {json.dumps(name)} }} as const)\n"
        alias = "NativeVectorLike" if name == "VectorLike" else "NativeRotationLike"
        values += f"export type {name} = {alias}\n"
    values += "export const native = {\n"
    for name in grouped["class"] + grouped["function"] + [name for name, item in bindings_data.items() if name not in symbols and item["kind"] == "class"]:
        item = bindings_data[name]
        members = item.get("members", {})
        static = {n: ("call" if m["kind"] == "method" else "value")
                  for n, m in members.items() if m.get("static")}
        native_type = f"NativeSymbolFactory<NativeCallableMap[{json.dumps(name)}]"
        if item["kind"] == "class":
            native_type += f", NativeClassMap<{json.dumps(name)}>[{json.dumps(name)}]['staticMethods'], NativeClassMap<{json.dumps(name)}>[{json.dumps(name)}]['staticProperties']"
        native_type += ">"
        values += f"  {name}: createSymbol({json.dumps(name)}, {json.dumps(static)} as const) as unknown as {native_type},\n"
    values += "} as const\n"
    values += "export const values = { ...native, " + ", ".join(grouped["enum"] + grouped["constant"] + grouped["typeAlias"] + ["ColorIndex"]) + " } as const\n"
    values += "export type * from './api-types'\n"
    # Nonrendering geometry helpers can be exported alongside JSX components.
    for name in grouped["class"]:
        if name in DATA_CLASSES:
            values += f"export const {name} = native.{name}\n"

    props = banner + "import type { ReactNode } from 'react'\nimport type { NativeHandle } from '../client'\n"
    props += "import type { NativeInput, NativeValue, NativeOpaque, NativeObjectInput, NativeIterable, NativeVectorLike, NativeRotationLike, NativeReference, EmptyNativeKwargs, StrictNativeUnion } from '../native-types'\n"
    props += "import type { NativeTypeValue, NativeBytesValue, NativeDateValue, NativeUuidValue, NativeFileValue, NativeLambdaValue } from './runtime'\n"
    props += "import type { " + ", ".join(name for name, item in bindings_data.items() if item["kind"] == "enum") + " } from './api-types'\n"
    props += "export type NativeKwargs = Record<string, NativeValue>\n"
    for name in components:
        item = bindings_data[name]
        prop_name = name + "Props" if item["kind"] == "class" else name[0].upper() + name[1:] + "OperationProps"
        props += f"export type {prop_name} = StrictNativeUnion<" + component_props(item, bindings_data, name) + ">\n"
    props += "export interface ComponentPropsMap {\n"
    for name in components:
        prop_name = name + "Props" if symbols[name]["kind"] == "class" else name[0].upper() + name[1:] + "OperationProps"
        props += f"  {name}: {prop_name}\n"
    props += "}\n"

    docs = f"# Native API inventory\n\nThis package targets **build123d {data['build123dVersion']}**, using its native OpenCascade kernel. The generated [inventory](api-inventory.json) contains all **{data['exportCount']} root exports**, constructor and function signatures, overloads, inherited methods, writable properties, and metaclass properties such as `Plane.XY`. Regenerate it with `.venv/bin/python scripts/generate-api.py`; `--check` verifies reproducibility.\n\n"
    docs += "The native service preserves the original Python API. JavaScript uses asynchronous RPC because geometry executes in the Python service. JSX compiles to the same native builders and operations. Python names and keyword arguments retain their spelling and angles remain in degrees.\n\n"
    docs += "```ts\nimport { NativeClient, native, Align, Axis } from '@tscircuit/b123-fiber'\n\nconst client = new NativeClient({ url: 'http://127.0.0.1:8765' })\nconst box = await client.construct('Box', [], { length: 20, width: 12, height: 6 })\nconst volume = await box.get('volume')\nconst edges = await box.call('edges')\nconst vertical = await edges.call('filter_by', [Axis.Z])\nconst filleted = await box.call('fillet', [1, vertical])\nconst other = await client.api.Cylinder({ radius: 3, height: 10, align: Align.CENTER })\nconst cut = await box.operator('sub', other)\nconst solid = await client.callStatic('Solid', 'make_box', [2, 3, 4])\nawait client.callFunction('export_step', [cut, 'part.step'])\nawait Promise.all([box.release(), edges.release(), vertical.release(), filleted.release(), other.release(), cut.release(), solid.release()])\n```\n\n"
    docs += "`construct(name, args, kwargs)` and `callFunction(name, args, kwargs)` cover every exported constructor/function. `client.api.Name(kwargs)` is a convenient asynchronous namespace for keyword calls. Native objects return `NativeHandle` values, whose `.call(name, args, kwargs)`, `.get(name)`, `.set(name, value)`, `.at(index)`, `.slice(start, stop, step)`, `.operator(name, ...args)` and `.release()` expose methods, properties, indexing, algebra and lifetime management. Native callable results support `.invoke(args, kwargs)` or `client.invoke(target, args, kwargs)`. ShapeList and other native collections support `.length()`, `.contains(value)` and `.toArray()`. Static/class methods use `callStatic(typeName, method, args, kwargs)`. Values recursively decode inside arrays and records, and handles recursively encode when passed to later operations. Call `.release()` once a handle is no longer needed; use `client.releaseAll()` to release all handles retained by that client. Handles belong to their originating client, and using released or cross-client handles throws before any request.\n\n"
    docs += "`native.Name(...args)` and `native.Name.withKwargs(kwargs, ...args)` create serializable symbolic calls for JSX props. Symbolic class attributes and static calls work as `native.Plane.XY` and `native.Solid.make_box(2, 3, 4)`. These calls execute when the service decodes the plan or RPC arguments. `values` combines symbolic classes/functions, enums, and constants into one namespace. Direct RPC objects remain native objects; their attributes are read explicitly with `.get()`. JavaScript does not overload Python's algebra operators; `.operator('add' | 'sub' | 'and' | 'mul', ...)` forwards their native equivalents.\n\n"
    docs += "The `expr` namespace composes native method/property/index/operator expressions for JSX props. For example, `expr.method(expr.call('edges'), 'filter_by', [Axis.Z])` selects vertical edges while the enclosing builder is active. `expr.index(target, -1)` and `expr.slice(target, 1, 3)` retain Python selection behavior. Native callbacks can be expressed with `expr.lambda(edge => expr.operator(expr.get(edge, 'length'), 'gt', [5]))`; this JavaScript function builds a serializable callback body once, and the native service evaluates that body for each actual edge. `expr.apply(target, args, kwargs)` executes a retained or symbolic native callable, such as a key returned by `native.topo_distance_to`. `expr.arg(index)` supports explicit callback arguments and `expr.conditional(condition, thenValue, elseValue)` branches on native expressions. JavaScript arithmetic/comparisons inside a callback are not transmitted; compose `expr.operator` calls instead.\n\n"
    docs += "`client.render(plan, { tolerance, angularTolerance, signal })` executes headless plans and returns OCCT mesh data using the client's configured URL, headers and error handling. RPC methods accept optional request options with a signal; `client.request(request, { signal })` exposes the complete protocol. The constructor signal is the default, and a per-request signal overrides it.\n\n"
    docs += "Browser File/Blob imports, CAD downloads, native BytesIO/StringIO, and durable hosted file plans are documented in [file transport](FILE-TRANSPORT.md). Native handles and upload IDs belong to one service process; hosted applications should render self-contained plans. See [compatibility](COMPATIBILITY.md) and [deployment limits](DEPLOYMENT.md).\n\n"
    docs += "The bridge exposes native capabilities rather than approximating missing operations. Some APIs require their original native context or resource: builder selectors need an active builder, text needs an installed font, import/export accepts native workspace paths or the browser file/stream bridge, and assembly methods need native joint/shape handles. Backend errors retain the Python exception type and message. Declarative native callbacks are supported through `expr.lambda`; arbitrary JavaScript closures, arbitrary Python code, private attributes, and raw OCP objects are outside the JSON protocol. Generated TypeScript bindings cover inspected overloads, positional/keyword argument combinations, specific enums, native value inputs, and typed retained object methods/properties. Known kwargs and named JSX component props are closed; explicit return-type generics and dynamic RPC names remain escape hatches. Unannotated native APIs accept wire values, and raw OCP values retain opaque handle types. Python value ranges, builder-context availability, and mathematical shape validity are checked by the native service. Root coverage is not a claim that every context or every overload has its own visual regression fixture.\n\n"
    for kind, heading in (("class", "Classes"), ("function", "Functions"), ("enum", "Enums"), ("constant", "Constants"), ("typeAlias", "Type aliases")):
        docs += f"## {heading}\n\n" + ", ".join(f"`{name}`" for name in grouped[kind]) + "\n\n"
    return {
        ROOT / "docs/api-inventory.json": json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        ROOT / "docs/API.md": docs.rstrip() + "\n",
        ROOT / "lib/generated/symbols.ts": exports,
        ROOT / "lib/generated/values.ts": values,
        ROOT / "lib/generated/props.ts": props,
        ROOT / "lib/generated/api-types.ts": api_types(data, bindings_data, banner),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if generated files differ from the current runtime")
    args = parser.parse_args()
    files = generated_files(inventory())
    stale = []
    for path, content in files.items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    if stale:
        parser.exit(1, "Generated API files are stale: " + ", ".join(stale) + "\n")
    print(f"{'Verified' if args.check else 'Generated'} {len(build123d.__all__)} public build123d {build123d.__version__} exports")


if __name__ == "__main__":
    main()
