"""A JSON interpreter for the *native* build123d API, without Python eval.

The plan interpreter deliberately enters all builders from one Python frame.
build123d uses frame identity when publishing nested builder results to parents;
ordinary recursive AST evaluation silently changes those native semantics.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import inspect
import io
import math
import operator
import threading
import uuid
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any

import build123d as b
from build123d.build_common import Builder, LocationList


class KernelError(Exception):
    def __init__(self, message: str, path: str = "request", error_type: str = "ValueError"):
        super().__init__(message)
        self.message, self.path, self.error_type = message, path, error_type

    def json(self) -> dict:
        return {"error": {"type": self.error_type, "message": self.message, "path": self.path}}


METADATA = {"args", "children", "color", "position", "name", "ref", "id"}
BUILDERS = {"BuildPart": b.BuildPart, "BuildSketch": b.BuildSketch, "BuildLine": b.BuildLine}
LOCATIONS = {"Locations", "GridLocations", "PolarLocations", "HexLocations"}
AUXILIARY_SYMBOLS = {"Shape": b.Shape, "ColorIndex": b.ColorIndex, "BytesIO": io.BytesIO, "StringIO": io.StringIO}
MAX_FILE_BYTES = 32 * 1024 * 1024
CHILD_OPERATIONS = {
    "extrude": "to_extrude", "revolve": "profiles", "loft": "sections",
    "sweep": "sections", "thicken": "to_thicken", "fillet": "objects",
    "chamfer": "objects", "offset": "objects", "mirror": "objects",
    "scale": "objects", "split": "objects", "make_face": "edges",
    "make_hull": "edges", "trace": "lines", "add": "objects", "insert": "objects",
    "section": "obj", "project": "objects", "draft": "faces",
    "full_round": "edge", "make_brake_formed": "line", "bounding_box": "objects",
    "pack": "objects", "edges_to_wires": "edges",
}
OPERATORS = {
    "add": operator.add, "+": operator.add,
    "sub": operator.sub, "-": operator.sub,
    "mul": operator.mul, "*": operator.mul,
    "truediv": operator.truediv, "/": operator.truediv,
    "and": operator.and_, "&": operator.and_,
    "or": operator.or_, "|": operator.or_,
    "xor": operator.xor, "^": operator.xor,
    "pow": operator.pow, "**": operator.pow,
    "neg": operator.neg, "pos": operator.pos, "invert": operator.invert,
    "equal": operator.eq, "eq": operator.eq, "==": operator.eq,
    "ne": operator.ne, "!=": operator.ne,
    "lt": operator.lt, "<": operator.lt,
    "le": operator.le, "<=": operator.le,
    "gt": operator.gt, ">": operator.gt,
    "ge": operator.ge, ">=": operator.ge,
    "div": operator.truediv, "matmul": operator.matmul, "@": operator.matmul,
    "len": len, "contains": operator.contains, "list": list, "iter": iter,
    "mod": operator.mod, "%": operator.mod,
    "lshift": operator.lshift, "<<": operator.lshift,
    "rshift": operator.rshift, ">>": operator.rshift,
    "floordiv": operator.floordiv, "//": operator.floordiv,
    "divmod": divmod, "abs": abs, "bool": bool, "int": int, "float": float,
    "round": round, "reversed": reversed, "next": next,
    "setitem": operator.setitem, "delitem": operator.delitem,
}


def _signature(value: Any) -> str | None:
    try:
        # build123d object metaclasses advertise *args/**kwargs; __init__ carries
        # the actual native parameter signature.
        if inspect.isclass(value) and str(inspect.signature(value)) == "(*args, **kwargs)":
            return str(inspect.signature(value.__init__))
        return str(inspect.signature(value))
    except (TypeError, ValueError):
        return None


class Kernel:
    def __init__(self, workspace_root: str | Path | None = None):
        self.workspace_root = Path(workspace_root or Path.cwd()).resolve()
        self.lock = threading.RLock()
        self.objects: dict[str, Any] = {}
        self.public = {name: getattr(b, name) for name in b.__all__}
        # Some supported signatures refer to public types omitted by __all__.
        # Register these explicitly rather than exposing arbitrary imported code.
        self.public.update(AUXILIARY_SYMBOLS)

    def resolve(self, name: str) -> Any:
        if not isinstance(name, str):
            raise ValueError("API names must be strings")
        parts = name.split(".")
        if not parts or parts[0] not in self.public:
            raise ValueError(f"Unknown build123d symbol {name!r}; see GET /api")
        result = self.public[parts[0]]
        for part in parts[1:]:
            result = self.member(result, part)
        return result

    @staticmethod
    def member(target: Any, name: str) -> Any:
        if not isinstance(name, str) or not name or name.startswith("_"):
            raise ValueError("Only public native API members may be accessed")
        return getattr(target, name)

    def decode(self, value: Any, local: dict[str, Any] | None = None) -> Any:
        local = local or {}
        if isinstance(value, list):
            # Native VectorLike and RotationLike require tuples. The top-level
            # invocation argument vector is normalized back to a list in invoke.
            return tuple(self.decode(item, local) for item in value)
        if not isinstance(value, dict):
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Numbers must be finite")
            return value
        if "$bytes" in value:
            return self._decode_bytes(value["$bytes"])
        if "$date" in value:
            iso = value["$date"]
            if not isinstance(iso, str):
                raise ValueError("$date requires an ISO date or datetime string")
            return datetime.fromisoformat(iso) if "T" in iso or " " in iso else date.fromisoformat(iso)
        if "$uuid" in value:
            if not isinstance(value["$uuid"], str):
                raise ValueError("$uuid requires a UUID string")
            return uuid.UUID(value["$uuid"])
        if "$file" in value:
            file = value["$file"]
            if not isinstance(file, dict):
                raise ValueError("$file requires {name, base64}")
            name = file.get("name")
            if not isinstance(name, str) or not name or len(name) > 255 or name in {".", ".."} or Path(name).name != name or "\\" in name or "\x00" in name:
                raise ValueError("$file.name must be a filename without directory components")
            data = self._decode_bytes(file.get("base64"))
            directory = self.workspace_root / ".uploads"
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{hashlib.sha256(data).hexdigest()}{Path(name).suffix}"
            if not path.resolve().is_relative_to(self.workspace_root):
                raise ValueError("$file must stay inside the kernel workspace")
            if not path.exists() or path.read_bytes() != data:
                path.write_bytes(data)
            return str(path)
        if "$ref" in value:
            key = value["$ref"]
            if key in local:
                return local[key]
            if key not in self.objects:
                raise ValueError(f"Unknown or released native reference {key!r}")
            return self.objects[key]
        if "$enum" in value:
            result = self.resolve(value["$enum"])
            if not isinstance(result, Enum):
                raise ValueError(f"{value['$enum']!r} is not an enum member")
            return result
        if "$type" in value:
            name = value["$type"]
            path = value.get("path")
            return self.resolve(f"{name}.{path}" if path else name)
        if "$call" in value:
            target = value.get("target")
            function = self.member(self.decode(target, local), value["$call"]) if target is not None else self.resolve(value["$call"])
            args = self.decode(value.get("args", []), local)
            kwargs = self.decode(value.get("kwargs", {}), local)
            return self.invoke(function, args, kwargs)
        if "$arg" in value:
            arguments = local.get("__lambda_args__")
            if arguments is None:
                raise ValueError("$arg is only available inside a $lambda body")
            return arguments[value["$arg"]]
        if "$lambda" in value:
            body = value["$lambda"]
            captured = dict(local)
            return lambda *arguments: self.decode(body, {**captured, "__lambda_args__": arguments})
        if "$if" in value:
            expression = value["$if"]
            condition = self.decode(expression["condition"], local)
            return self.decode(expression["then"] if condition else expression["else"], local)
        if "$method" in value:
            expression = value["$method"]
            function = self.member(self.decode(expression["target"], local), expression["name"])
            return self.invoke(function, self.decode(expression.get("args", []), local), self.decode(expression.get("kwargs", {}), local))
        if "$apply" in value:
            expression = value["$apply"]
            function = self.decode(expression["target"], local)
            return self.invoke(function, self.decode(expression.get("args", []), local), self.decode(expression.get("kwargs", {}), local))
        if "$get" in value:
            expression = value["$get"]
            return self.member(self.decode(expression["target"], local), expression["name"])
        if "$slice" in value:
            return slice(*self.decode(value["$slice"], local))
        if "$index" in value:
            expression = value["$index"]
            return self.decode(expression["target"], local)[self.decode(expression["index"], local)]
        if "$operator" in value:
            expression = value["$operator"]
            function = OPERATORS.get(expression["name"])
            if function is None:
                raise ValueError(f"Unsupported operator {expression['name']!r}")
            return function(self.decode(expression["target"], local), *self.decode(expression.get("args", []), local))
        if "$select" in value:
            context = Builder._get_context(log=False)
            target = self.decode(value["target"], local) if "target" in value else context
            if target is None:
                raise ValueError("Selection requires an active builder or target reference")
            name = value["$select"]
            if name not in {"solids", "faces", "wires", "edges", "vertices"}:
                raise ValueError(f"Unknown topology selection {name!r}")
            selected = self.member(target, name)(self.decode(value.get("select", {"$enum": "Select.ALL"}), local))
            if "axis" in value:
                selected = selected.filter_by(self.decode(value["axis"], local))
            if "sort" in value:
                selected = selected.sort_by(self.decode(value["sort"], local))
            if "index" in value:
                selected = selected[value["index"]]
            return selected
        return {key: self.decode(item, local) for key, item in value.items()}

    @staticmethod
    def _decode_bytes(encoded: Any) -> bytes:
        if not isinstance(encoded, str):
            raise ValueError("$bytes/base64 requires a base64 string")
        if len(encoded) > 4 * ((MAX_FILE_BYTES + 2) // 3):
            raise ValueError("Binary payload must be at most 32 MiB")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, UnicodeEncodeError) as exc:
            raise ValueError("Binary payload must contain valid base64") from exc
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("Binary payload must be at most 32 MiB")
        return data

    def encode(self, value: Any) -> Any:
        if isinstance(value, (bytes, bytearray, memoryview)):
            return {"$bytes": base64.b64encode(value).decode("ascii")}
        if isinstance(value, (datetime, date)):
            return {"$date": value.isoformat()}
        if isinstance(value, uuid.UUID):
            return {"$uuid": str(value)}
        if isinstance(value, Enum):
            return {"$enum": f"{type(value).__name__}.{value.name}"}
        if value is None or isinstance(value, (str, bool, int)):
            return value
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("Native API returned a non-finite value")
            return value
        if inspect.isclass(value):
            return {"$type": value.__name__}
        # ShapeList is a list subclass with native filter/group/sort/operators.
        # Retaining it is essential for exact selection semantics.
        if isinstance(value, b.ShapeList):
            return self.retain(value)
        if isinstance(value, (list, tuple)):
            return [self.encode(item) for item in value]
        if isinstance(value, dict):
            return {str(key): self.encode(item) for key, item in value.items()}
        return self.retain(value)

    def retain(self, value: Any) -> dict:
        key = uuid.uuid4().hex
        self.objects[key] = value
        return {"$ref": key, "kind": type(value).__name__}

    def _validate_paths(self, function: Any, args: list, kwargs: dict) -> None:
        """Keep native import/export file access inside the chosen work directory."""
        bound = dict(kwargs)
        try:
            signature = inspect.signature(function)
            bound.update(signature.bind_partial(*args, **kwargs).arguments)
        except (TypeError, ValueError):
            # Actual invocation still reports invalid native arguments.
            pass
        for key, value in bound.items():
            if key not in {"file_path", "file_name", "filename", "path", "font_path", "dxf_file", "svg_file"}:
                continue
            if not isinstance(value, (str, bytes, Path)):
                continue
            path = Path(value.decode() if isinstance(value, bytes) else value)
            path = (self.workspace_root / path).resolve() if not path.is_absolute() else path.resolve()
            if not path.is_relative_to(self.workspace_root):
                raise ValueError(f"{key} must be inside kernel workspace {self.workspace_root}")
            # Make relative native API paths relative to the configured workspace,
            # even if the service was launched from another directory.
            if key in kwargs:
                kwargs[key] = str(path)
            else:
                try:
                    param_names = list(inspect.signature(function).parameters)
                    arg_index = param_names.index(key)
                    if arg_index < len(args):
                        args[arg_index] = str(path)
                except (TypeError, ValueError):
                    pass

    def invoke(self, function: Any, args: list, kwargs: dict) -> Any:
        if not callable(function):
            raise TypeError("The selected native API value is not callable; use get")
        if not isinstance(args, (list, tuple)) or not isinstance(kwargs, dict):
            raise TypeError("args must be an array and kwargs must be an object")
        args = list(args)
        self._validate_paths(function, args, kwargs)
        return function(*args, **kwargs)

    def rpc(self, request: dict) -> dict:
        with self.lock:
            try:
                op = request.get("op")
                args = self.decode(request.get("args", []))
                kwargs = self.decode(request.get("kwargs", {}))
                if op in {"construct", "function"}:
                    result = self.invoke(self.resolve(request.get("name")), args, kwargs)
                elif op == "release":
                    target = request.get("target")
                    refs = target if isinstance(target, list) else [target]
                    for ref in refs:
                        if not isinstance(ref, dict) or "$ref" not in ref:
                            raise ValueError("release requires a native reference or array of references")
                        self.objects.pop(ref["$ref"], None)
                    result = None
                elif op == "clear":
                    self.objects.clear()
                    result = None
                else:
                    target = self.decode(request.get("target"))
                    name = request.get("name")
                    if op == "method":
                        result = self.invoke(self.member(target, name), args, kwargs)
                    elif op == "invoke":
                        result = self.invoke(target, args, kwargs)
                    elif op == "get":
                        result = self.member(target, name) if name else target
                    elif op == "set":
                        self.member(target, name)
                        setattr(target, name, self.decode(request.get("value")))
                        result = target
                    elif op == "index":
                        key = self.decode(request.get("value", args[0] if args else None))
                        if isinstance(key, dict) and "$slice" in key:
                            key = slice(*key["$slice"])
                        result = target[key]
                    elif op == "setitem":
                        key = self.decode(request.get("index", args[0] if args else None))
                        operator.setitem(target, key, self.decode(request.get("value")))
                        result = target
                    elif op == "delitem":
                        key = self.decode(request.get("index", request.get("value", args[0] if args else None)))
                        operator.delitem(target, key)
                        result = target
                    elif op == "operator":
                        function = OPERATORS.get(name)
                        if function is None:
                            raise ValueError(f"Unsupported operator {name!r}")
                        result = function(target, *args)
                    else:
                        raise ValueError(f"Unknown RPC operation {op!r}")
                return {"value": self.encode(result)}
            except KernelError:
                raise
            except Exception as exc:
                raise KernelError(str(exc), f"rpc.{request.get('op', '?')}.{request.get('name', '')}", type(exc).__name__) from exc

    def api(self) -> dict:
        symbols = {}
        for name in b.__all__:
            value = self.public[name]
            entry = {"name": name, "kind": "class" if inspect.isclass(value) else "function" if callable(value) else "constant", "signature": _signature(value)}
            if inspect.isclass(value):
                members = dict(inspect.getmembers_static(value))
                for meta in type(value).__mro__:
                    if meta in (type, object):
                        break
                    for member, raw in meta.__dict__.items():
                        members.setdefault(member, raw)
                entry["members"] = {}
                for member, raw in sorted(members.items()):
                    if member.startswith("_"):
                        continue
                    actual = getattr(value, member, None)
                    entry["members"][member] = {"kind": "property" if isinstance(raw, property) else "method" if callable(actual) else "attribute", "signature": _signature(actual)}
                if issubclass(value, Enum):
                    entry["values"] = list(value.__members__)
            elif not callable(value):
                if isinstance(value, (str, bool, int, float, dict)):
                    entry["value"] = value
            symbols[name] = entry
        return {"version": b.__version__, "kernel": "build123d/OpenCascade", "symbols": symbols,
                "exports": list(b.__all__), "auxiliarySymbols": list(AUXILIARY_SYMBOLS)}

    @staticmethod
    def _native_dimension(node: dict) -> type[Builder]:
        node_type = node.get("type", "")
        if node_type == "Call":
            node_type = node.get("props", {}).get("symbol", node.get("props", {}).get("name", "")).split(".")[0]
        if node_type in BUILDERS:
            return BUILDERS[node_type]
        native = getattr(b, node_type, None)
        if inspect.isclass(native):
            if issubclass(native, b.BaseSketchObject):
                return b.BuildSketch
            if issubclass(native, (b.BaseLineObject, b.Edge, b.Wire, b.Curve)):
                return b.BuildLine
            if issubclass(native, (b.Face, b.Sketch)):
                return b.BuildSketch
        children = node.get("children", [])
        return Kernel._native_dimension(children[0]) if children else b.BuildPart

    @staticmethod
    def _place_existing_shape(shape: b.Shape, mode: b.Mode = b.Mode.ADD) -> b.Shape:
        if not bool(shape):
            return shape
        # Vertices are valid loft endpoints, but native insert intentionally
        # accepts only edges/faces/solids. Keep them as operands without trying
        # to publish them to a dimensional builder product.
        if Builder._get_context(log=False) is not None and shape._dim != 0:
            product = b.insert(shape, mode=mode)
            if not getattr(shape, "children", ()):
                return product
            # Insertion may combine topology, but its return value no longer
            # carries the source assembly tree. Retain that tree for rendering.
        locations = LocationList._get_context()
        if locations is None:
            return shape
        placed = [shape.moved(location) for location in locations.locations]
        return placed[0] if len(placed) == 1 else b.Compound(placed)

    @staticmethod
    def _shape_values(value: Any, points: bool = False):
        """Extract geometry from native results without iterating shapes/points.

        ShapeList inherits list. Tuples may mix topology lists and diagnostics
        (detect_primitives), so nongeometry values remain captured but unrendered.
        """
        if isinstance(value, b.Shape):
            yield value
        elif points and isinstance(value, b.Vector):
            yield b.Vertex(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                yield from Kernel._shape_values(item, points=True)

    def _place_existing_value(self, value: Any, mode: b.Mode = b.Mode.ADD) -> Any:
        if isinstance(value, b.Shape):
            return self._place_existing_shape(value, mode)
        if isinstance(value, b.ShapeList):
            return b.ShapeList(self._place_existing_value(item, mode) for item in value)
        if isinstance(value, (list, tuple)):
            return type(value)(self._place_existing_value(item, mode) for item in value)
        return value

    @staticmethod
    def _assembly_leaves(shape: b.Shape, root_index: int, path: list | None = None):
        path = path or []
        children = getattr(shape, "children", ())
        if children:
            path = [*path, {"name": shape.label, "index": root_index}]
            for index, child in enumerate(children):
                yield from Kernel._assembly_leaves(child, index, path)
        elif path:
            # Native children are stored relative to their assembly. The native
            # global_location composes every ancestor, including rotations.
            yield shape.located(shape.global_location), path
        else:
            yield shape, []

    def evaluate(self, plan: dict) -> list[tuple[b.Shape, dict]]:
        if not isinstance(plan, dict) or plan.get("version") != 1 or not isinstance(plan.get("children"), list):
            raise KernelError("Expected plan {version: 1, children: [...]}", "plan")
        local: dict[str, Any] = {}
        output: list[tuple[b.Shape, dict]] = []
        stack = [{"event": "visit", "node": node, "path": f"plan.children[{i}]", "parent": None, "metadata": {}} for i, node in reversed(list(enumerate(plan["children"])))]
        active_contexts: list[Any] = []
        current_path = "plan"
        try:
            while stack:
                frame = stack.pop()
                current_path = frame["path"]
                node = frame["node"]
                if frame["event"] == "done":
                    context = frame.get("context")
                    if frame.get("assembly"):
                        child_shapes = []
                        for shape, child_metadata in frame["results"]:
                            child = copy.deepcopy(shape)
                            if "color" in child_metadata:
                                child.color = child_metadata["color"]
                            if "name" in child_metadata:
                                child.label = child_metadata["name"]
                            child_shapes.append(child)
                        assembly_args = self.decode(node.get("props", {}).get("args", []), local)
                        assembly_kwargs = self.decode({key: value for key, value in node.get("props", {}).items() if key not in METADATA}, local)
                        bound = inspect.signature(b.Compound).bind_partial(*assembly_args, **assembly_kwargs)
                        if "children" not in bound.arguments:
                            assembly_kwargs["children"] = child_shapes
                        frame["result"] = self.invoke(b.Compound, assembly_args, assembly_kwargs)
                        # Private child builders have already applied outer
                        # Locations. Applying them again moves the assembly
                        # twice. Publish only when this is a real builder input.
                        if Builder._get_context(log=False) is not None and not frame.get("assembly_operand"):
                            b.insert(frame["result"])
                    if frame.get("boolean"):
                        operands = [shape for shape, _ in frame["results"]]
                        product = operands[0] if operands else None
                        for operand in operands[1:]:
                            if not bool(operand):
                                if node["type"] == "Intersect":
                                    product = operand
                                    break
                                continue
                            if not bool(product):
                                if node["type"] == "Union":
                                    product = operand
                                    continue
                                break
                            if node["type"] == "Union":
                                product = product + operand
                            elif node["type"] == "Subtract":
                                product = product - operand
                            else:
                                product = product & operand
                        frame["result"] = product
                    if frame.get("deferred"):
                        raw_props = frame["operation_props"]
                        operation_args = self.decode(raw_props.get("args", []), local)
                        operation_kwargs = self.decode({key: value for key, value in raw_props.items() if key not in METADATA}, local)
                        # Boolean wrappers set a publication mode on their
                        # operands. That synthetic mode must not suppress the
                        # native operation in its initially empty working
                        # builder. Explicit user modes retain native meanings.
                        if "force_mode" in frame:
                            operation_kwargs.pop("mode", None)
                            if frame.get("operation_native_mode") is not None:
                                operation_kwargs["mode"] = self.decode(frame["operation_native_mode"], local)
                        operation = node["type"]
                        child_shapes = [shape for shape, _ in frame["results"]]
                        operand = CHILD_OPERATIONS[operation]
                        # Explicit operands always take precedence. Positional
                        # arguments begin with the native operand as well.
                        bound = inspect.signature(self.resolve(operation)).bind_partial(*operation_args, **operation_kwargs)
                        if operand not in bound.arguments:
                            if operation in {"fillet", "chamfer"}:
                                target = context._obj
                                operation_kwargs[operand] = target.edges() if target._dim == 3 else target.vertices()
                            elif operation == "sweep":
                                if "path" not in operation_kwargs:
                                    if len(child_shapes) < 2:
                                        raise ValueError("sweep children require a section followed by a path")
                                    operation_kwargs["path"] = child_shapes[-1]
                                    child_shapes = child_shapes[:-1]
                                operation_kwargs[operand] = child_shapes[0] if len(child_shapes) == 1 else child_shapes
                            elif operation == "draft":
                                operation_kwargs[operand] = [face for shape in child_shapes for face in shape.faces()]
                            elif operation == "full_round":
                                edges = [edge for shape in child_shapes for edge in shape.edges()]
                                if len(edges) != 1:
                                    raise ValueError("full_round children require an explicit single edge selection")
                                operation_kwargs[operand] = edges[0]
                            elif operation == "project":
                                projected = [item for shape in child_shapes for item in
                                             (shape.faces() if shape._dim == 2 else shape.edges() if shape._dim == 1 else shape.vertices() if shape._dim == 0 else [])]
                                operation_kwargs[operand] = projected
                            elif operation == "section":
                                operation_kwargs[operand] = child_shapes[0] if len(child_shapes) == 1 else b.Compound(child_shapes)
                            elif operation == "edges_to_wires":
                                operation_kwargs[operand] = [edge for shape in child_shapes for edge in shape.edges()]
                            else:
                                operation_kwargs[operand] = child_shapes[0] if len(child_shapes) == 1 else child_shapes
                        frame["result"] = self.invoke(self.resolve(operation), operation_args, operation_kwargs)
                    if context is not None:
                        context.__exit__(None, None, None)
                        active_contexts.pop()
                    if frame.get("return_result") and Builder._get_context(log=False) is not None:
                        signature = inspect.signature(self.resolve(node["type"]))
                        mode_parameter = signature.parameters.get("mode")
                        default_mode = mode_parameter.default if mode_parameter is not None else b.Mode.ADD
                        frame["result"] = self._place_existing_value(frame["result"], operation_kwargs.get("mode", default_mode))
                    if frame.get("boolean") and frame["result"] is not None and bool(frame["result"]):
                        frame["result"] = self._place_existing_shape(frame["result"], frame["publication_mode"])
                    placement = frame.get("placement")
                    if placement is not None:
                        placement.__exit__(None, None, None)
                        active_contexts.pop()
                    if frame.get("boolean"):
                        result = frame["result"]
                    elif frame.get("return_result"):
                        result = frame.get("result")
                    elif frame.get("preserve_child_metadata") and len(frame["results"]) == 1 and getattr(frame["results"][0][0], "children", ()):
                        child = frame["results"][0][0]
                        placed = [child.moved(publication * output)
                                  for publication in frame["publication_locations"]
                                  for output in context.output_placements]
                        result = placed[0] if len(placed) == 1 else b.Compound(children=placed)
                    elif isinstance(context, Builder):
                        # The public product carries workplane placements and
                        # outer Locations; _obj is only local construction data.
                        result = context.part if isinstance(context, b.BuildPart) else context.sketch if isinstance(context, b.BuildSketch) else context.line
                    else:
                        result = frame.get("result")
                    if result is None and frame.get("boolean_operand"):
                        result = b.Compound([])
                    if result is None and not isinstance(context, Builder):
                        # Group/transform wrappers have no new geometry; their
                        # children are already placed by native Locations.
                        results = frame["results"]
                    elif result is None and isinstance(context, Builder):
                        results = [(shape, metadata) for shape, metadata in frame["results"] if shape._dim == 0]
                    else:
                        results = [(shape, frame["metadata"]) for shape in self._shape_values(result)]
                    if frame.get("preserve_child_metadata") and results:
                        # A private child builder performs native placement but
                        # should not erase the wrapped part's JSX appearance.
                        child_metadata = [metadata for _, metadata in frame["results"]]
                        metadata = dict(frame["metadata"])
                        for key in ("color", "name"):
                            values = [item[key] for item in child_metadata if key in item]
                            if values and all(value == values[0] for value in values):
                                metadata[key] = values[0]
                        results = [(shape, metadata) for shape, _ in results]
                    props = node.get("props", {})
                    capture = props.get("id", props.get("ref"))
                    if capture:
                        local[capture] = context if node["type"] in BUILDERS else result if result is not None else results[0][0] if len(results) == 1 else b.Compound([shape for shape, _ in results]) if results else None
                    if frame["parent"] is not None:
                        frame["parent"]["results"].extend(results)
                    else:
                        output.extend(results)
                    continue
                if not isinstance(node, dict) or not isinstance(node.get("type"), str):
                    raise ValueError("Each node requires a string type")
                props = dict(node.get("props", {}))
                if "force_mode" in frame:
                    props["mode"] = {"$enum": f"Mode.{frame['force_mode']}"}
                children = node.get("children", [])
                if not isinstance(children, list):
                    raise ValueError("Node children must be an array")
                kind = node["type"]
                metadata = {**frame["metadata"], **{key: props[key] for key in ("color", "name") if key in props}}
                if "color" in metadata:
                    color = self.decode(metadata["color"], local)
                    metadata["color"] = list(color) if isinstance(color, (b.Color, tuple)) else color
                done = {**frame, "event": "done", "metadata": metadata, "results": []}
                placement = None
                if props.get("position") is not None and kind != "Translate":
                    placement = b.Locations(b.Pos(self.decode(props["position"], local)))
                    placement.__enter__()
                    active_contexts.append(placement)
                done["placement"] = placement
                assembly = kind == "Compound" and bool(children)
                deferred = kind in CHILD_OPERATIONS and bool(children)
                done["assembly"] = assembly
                args = () if deferred or assembly else self.decode(props.get("args", []), local)
                kwargs = {} if deferred or assembly else self.decode({key: value for key, value in props.items() if key not in METADATA}, local)
                context, result = None, None
                # Position metadata is interpreted as a placement context so
                # operations inside a builder participate at the correct place.
                # A native Translate wrapper is preferable for nested placement.
                if assembly:
                    # Evaluate every child in a private native builder. This
                    # keeps transforms and workplanes while avoiding fusion or
                    # premature publication into an enclosing builder.
                    pass
                elif deferred:
                    if kind in {"extrude", "revolve", "loft", "sweep", "thicken", "draft", "make_brake_formed", "section"}:
                        cls = b.BuildPart
                    elif kind in {"make_face", "make_hull", "trace", "full_round"}:
                        cls = b.BuildSketch
                    else:
                        cls = self._native_dimension(children[0])
                    context = cls(mode=self.decode(props.get("mode", {"$enum": "Mode.ADD"}), local))
                    done.update(deferred=True, operation_props=props, operation_native_mode=node.get("props", {}).get("mode"))
                    if kind in {"section", "project", "bounding_box", "pack", "edges_to_wires"}:
                        # These functions can return a different dimension or a
                        # collection; the input builder product is not output.
                        context.mode = b.Mode.PRIVATE
                        done["return_result"] = True
                elif kind in BUILDERS:
                    context = self.invoke(BUILDERS[kind], args, kwargs)
                elif kind in LOCATIONS:
                    kwargs.pop("mode", None)
                    context = self.invoke(self.resolve(kind), args, kwargs)
                elif kind in {"Union", "Subtract", "Intersect"}:
                    parent_builder = Builder._get_context(log=False)
                    cls = type(parent_builder) if parent_builder is not None else self._native_dimension(children[0]) if children else b.BuildPart
                    # Each child is one complete boolean operand. Building all
                    # descendants directly into this builder makes Intersect
                    # accidentally intersect the members of a Group serially.
                    context = cls(mode=b.Mode.PRIVATE)
                    done.update(boolean=True, publication_mode=kwargs.get("mode", b.Mode.ADD))
                elif kind in {"Translate", "Rotate"}:
                    if kind == "Translate":
                        vector = props.get("offset", props.get("position", props.get("vector", args[0] if args else [props.get("x", 0), props.get("y", 0), props.get("z", 0)])))
                        context = b.Locations(b.Pos(self.decode(vector, local)))
                    else:
                        angles = props.get("rotation", props.get("angles", args[0] if args else [props.get("x", 0), props.get("y", 0), props.get("z", 0)]))
                        context = b.Locations(b.Rot(*self.decode(angles, local)))
                elif kind == "Group":
                    pass
                elif kind == "Shape":
                    result = self.decode(props.get("shape", props.get("value", args[0] if args else None)), local)
                    if not list(self._shape_values(result)):
                        raise TypeError("Shape requires a native shape or collection of native shapes")
                    result = self._place_existing_value(result, kwargs.get("mode", b.Mode.ADD))
                elif kind == "Call":
                    symbol = props.get("symbol", props.get("function", props.get("name")))
                    target = props.get("target")
                    function = self.member(self.decode(target, local), symbol) if target is not None else self.resolve(symbol)
                    call_kwargs = self.decode(props.get("kwargs", {}), local)
                    if "force_mode" in frame:
                        signature = inspect.signature(function)
                        if "mode" in signature.parameters or any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
                            call_kwargs["mode"] = self.decode(props["mode"], local)
                    result = self.invoke(function, args, call_kwargs)
                    if getattr(function, "__module__", "").startswith("build123d.topology") or isinstance(result, (list, tuple)):
                        result = self._place_existing_value(result, self.decode(props.get("mode", {"$enum": "Mode.ADD"}), local))
                else:
                    function = self.resolve(kind)
                    result = self.invoke(function, args, kwargs)
                    if getattr(function, "__module__", "").startswith("build123d.topology") or isinstance(result, (list, tuple)):
                        result = self._place_existing_value(result)
                if context is not None:
                    if isinstance(context, Builder):
                        # Native parent detection is frame-based. Construction
                        # via invoke adds a frame, so align it with this single
                        # interpreter frame before entering native scope.
                        context._python_frame = inspect.currentframe()
                        locations = LocationList._get_context()
                        done["publication_locations"] = tuple(locations.locations) if locations is not None else (b.Location(),)
                    context.__enter__()
                    active_contexts.append(context)
                    capture = props.get("id", props.get("ref"))
                    if capture:
                        local[capture] = context
                done.update(context=context, result=result)
                capture = props.get("id", props.get("ref"))
                if capture and result is not None:
                    local[capture] = result
                stack.append(done)
                for i, child in reversed(list(enumerate(children))):
                    if assembly:
                        child_cls = self._native_dimension(child)
                        child = {"type": child_cls.__name__, "props": {"mode": {"$enum": "Mode.PRIVATE"}}, "children": [child]}
                    elif kind in {"Union", "Subtract", "Intersect"}:
                        child = {"type": type(context).__name__, "props": {"mode": {"$enum": "Mode.PRIVATE"}}, "children": [child]}
                    elif deferred and child.get("type") not in {*BUILDERS, "Vertex"}:
                        child_cls = self._native_dimension(child)
                        child = {"type": child_cls.__name__, "props": {}, "children": [child]}
                    item = {"event": "visit", "node": child, "path": f"{current_path}.children[{i}]", "parent": done, "metadata": metadata}
                    if kind in {"Union", "Subtract", "Intersect"}:
                        item["boolean_operand"] = True
                    if assembly:
                        item["preserve_child_metadata"] = True
                    if frame.get("preserve_child_metadata"):
                        item["assembly_operand"] = True
                    if "force_mode" in frame and (kind in {"Group", "Translate", "Rotate"} or kind in LOCATIONS):
                        item["force_mode"] = frame["force_mode"]
                    stack.append(item)
            return output
        except Exception as exc:
            # Properly restore native ContextVars even after invalid geometry.
            while active_contexts:
                context = active_contexts.pop()
                try:
                    context.__exit__(type(exc), exc, exc.__traceback__)
                except Exception:
                    pass
            if isinstance(exc, KernelError):
                raise
            raise KernelError(str(exc), current_path, type(exc).__name__) from exc

    @staticmethod
    def mesh(shape: b.Shape, metadata: dict, tolerance: float, angular_tolerance: float) -> dict:
        vertices, triangles = shape.tessellate(tolerance, angular_tolerance) if shape.faces() else ([], [])
        points = [(v.X, v.Y, v.Z) for v in vertices]
        normals = [[0.0, 0.0, 0.0] for _ in points]
        for i, j, k in triangles:
            a, c, d = points[i], points[j], points[k]
            ab = [c[n] - a[n] for n in range(3)]
            ac = [d[n] - a[n] for n in range(3)]
            normal = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
            for index in (i, j, k):
                for axis in range(3):
                    normals[index][axis] += normal[axis]
        for normal in normals:
            length = math.sqrt(sum(value * value for value in normal))
            if length:
                for axis in range(3):
                    normal[axis] /= length
        edges = []
        for edge in shape.edges():
            count = 2 if edge.geom_type == b.GeomType.LINE else min(2048, max(8, math.ceil(edge.length / max(tolerance, 0.01)) + 1))
            curve = []
            for index in range(count):
                point = edge.position_at(index / (count - 1))
                curve.extend([point.X, point.Y, point.Z])
            edges.append(curve)
        point_vertices = []
        if not points and not edges:
            for vertex in shape.vertices():
                point = vertex.center()
                point_vertices.extend([point.X, point.Y, point.Z])
        attributes = {}
        if shape.color is not None:
            attributes["color"] = list(shape.color)
        if shape.label:
            attributes["name"] = shape.label
        return {
            "positions": [value for point in points for value in point],
            "normals": [value for normal in normals for value in normal],
            "indices": [index for triangle in triangles for index in triangle],
            "edges": edges, "vertices": point_vertices,
            "volume": float(shape.volume), "area": float(shape.area),
            "valid": bool(shape.is_valid), "kind": type(shape).__name__,
            **attributes,
            **{key: value for key, value in metadata.items() if key in {"color", "name", "assemblyPath"}},
        }

    def render(self, request: dict) -> dict:
        with self.lock:
            tolerance = request.get("tolerance", 0.1)
            angular = request.get("angularTolerance", 0.1)
            if not isinstance(tolerance, (int, float)) or not math.isfinite(tolerance) or tolerance <= 0:
                raise KernelError("tolerance must be a positive finite number", "tolerance")
            if not isinstance(angular, (int, float)) or not math.isfinite(angular) or angular <= 0:
                raise KernelError("angularTolerance must be a positive finite number", "angularTolerance")
            shapes = self.evaluate(request.get("plan"))
            meshes, minimum, maximum = [], [math.inf]*3, [-math.inf]*3
            leaves = [(leaf, {**metadata, **({"assemblyPath": path} if path else {})})
                      for index, (shape, metadata) in enumerate(shapes)
                      for leaf, path in self._assembly_leaves(shape, index)]
            for index, (shape, metadata) in enumerate(leaves):
                if not bool(shape):
                    continue
                try:
                    meshes.append(self.mesh(shape, metadata, tolerance, angular))
                    bounds = shape.bounding_box()
                    for axis, key in enumerate(("X", "Y", "Z")):
                        minimum[axis] = min(minimum[axis], getattr(bounds.min, key))
                        maximum[axis] = max(maximum[axis], getattr(bounds.max, key))
                except Exception as exc:
                    raise KernelError(str(exc), f"meshes[{index}]", type(exc).__name__) from exc
            return {"meshes": meshes, "bounds": {"min": minimum, "max": maximum} if meshes else None, "kernel": f"build123d {b.__version__} / OpenCascade"}
