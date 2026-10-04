"""Browser file transport using workspace-confined paths and native import/export."""

from __future__ import annotations

import base64
import copy
import io
import json
import mimetypes
from pathlib import Path
import tempfile
from typing import TYPE_CHECKING, Any
import uuid

import build123d as b

if TYPE_CHECKING:
    from .kernel import Kernel

MAX_FILE_BYTES = 32 * 1024 * 1024
FORMATS = {"step", "stl", "brep", "svg", "dxf"}
ALIASES = {"stp": "step", "brp": "brep"}
CONTENT_TYPES = {"step": "application/step", "stl": "model/stl", "brep": "application/octet-stream", "svg": "image/svg+xml", "dxf": "image/vnd.dxf"}


class FileTransferError(Exception):
    def __init__(self, message: str, path: str = "file", status: int = 422):
        self.message, self.path, self.status = message, path, status

    def json(self) -> dict:
        return {"error": {"type": "FileTransferError", "message": self.message, "path": self.path}}


def safe_filename(name: str | None, fallback: str = "model.bin") -> str:
    name = name or fallback
    if not isinstance(name, str) or not name or len(name) > 255 or name in {".", ".."}:
        raise FileTransferError("filename must be a nonempty basename", "filename")
    if any(character in name for character in ("/", "\\")) or any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise FileTransferError("filename must not contain path separators or control characters", "filename")
    return name


def cad_format(value: str | None, filename: str | None = None) -> str:
    value = (value or Path(filename or "").suffix.lstrip(".")).lower()
    value = ALIASES.get(value, value)
    if value not in FORMATS:
        raise FileTransferError("format must be step, stl, brep, svg, or dxf", "format")
    return value


def shapes_in(value: Any) -> list[b.Shape]:
    if isinstance(value, b.Shape):
        return [value]
    if isinstance(value, (list, tuple, b.ShapeList)):
        return [shape for item in value for shape in shapes_in(item)]
    raise FileTransferError("CAD export requires a native shape or collection of shapes", "target")


class FileStore:
    """Only generated file IDs can be downloaded or deleted over HTTP."""

    def __init__(self, kernel: Kernel):
        self.kernel = kernel
        self.records: dict[str, dict] = {}

    @property
    def directory(self) -> Path:
        directory = (self.kernel.workspace_root / ".b123-fiber-files").resolve()
        if not directory.is_relative_to(self.kernel.workspace_root):
            raise FileTransferError("File storage must remain inside the kernel workspace", "file")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def save(self, content: bytes, filename: str, content_type: str | None = None) -> dict:
        filename = safe_filename(filename)
        if len(content) > MAX_FILE_BYTES:
            raise FileTransferError("Files must be no larger than 32 MiB", "file", 413)
        with self.kernel.lock:
            file_id = uuid.uuid4().hex
            suffix = Path(filename).suffix.lower()
            suffix = suffix if len(suffix) <= 16 and suffix[1:].isalnum() else ".bin"
            path = self.directory / f"{file_id}{suffix}"
            # Exclusive creation avoids following a pre-existing symlink.
            with path.open("xb") as output:
                output.write(content)
            record = {
                "id": file_id, "name": filename,
                "path": str(path.relative_to(self.kernel.workspace_root)),
                "size": len(content),
                "contentType": content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream",
            }
            self.records[file_id] = record
            return dict(record)

    def lookup(self, file_id: str) -> tuple[dict, Path]:
        with self.kernel.lock:
            if file_id not in self.records:
                raise FileTransferError("Unknown or deleted uploaded file", "file.id", 404)
            record = self.records[file_id]
            path = (self.kernel.workspace_root / record["path"]).resolve()
            if not path.is_relative_to(self.directory) or not path.is_relative_to(self.kernel.workspace_root):
                raise FileTransferError("Uploaded file must remain inside the kernel workspace", "file.path")
            if not path.is_file():
                raise FileTransferError("Uploaded file no longer exists", "file.id", 404)
            return dict(record), path

    def delete(self, file_id: str) -> None:
        with self.kernel.lock:
            _, path = self.lookup(file_id)
            path.unlink()
            self.records.pop(file_id, None)

    def import_content(self, content: bytes, filename: str, format: str | None, options: dict | None = None) -> dict:
        filename = safe_filename(filename)
        format = cad_format(format, filename)
        if len(content) > MAX_FILE_BYTES:
            raise FileTransferError("Files must be no larger than 32 MiB", "file", 413)
        if not isinstance(options or {}, dict):
            raise FileTransferError("options must be a native keyword argument object", "options")
        if any(key in (options or {}) for key in {"args", "children", "id", "ref"}):
            raise FileTransferError("Import options cannot override plan arguments or references", "options")
        # The plan is durable across processes: the wire interpreter materializes
        # this content into a confined, hashed path for each native invocation.
        marker = {"$file": {"name": filename, "base64": base64.b64encode(content).decode("ascii")}}
        plan = {"version": 1, "children": [{"type": f"import_{format}", "props": {"args": [marker], **(options or {})}, "children": []}]}
        with self.kernel.lock:
            value = self.kernel.invoke(self.kernel.resolve(f"import_{format}"), [self.kernel.decode(marker)], self.kernel.decode(options or {}))
            result = self.kernel.render({"plan": plan})
            if not result["meshes"]:
                raise FileTransferError("The native importer produced no geometry; check the file content and format", "files.import")
            encoded = self.kernel.encode(value)
        return {"value": encoded, "plan": plan, "result": result}

    def export_content(self, request: dict) -> tuple[bytes, str, str]:
        format = cad_format(request.get("format"), request.get("filename"))
        filename = safe_filename(request.get("filename"), f"model.{format}")
        options = request.get("options", {})
        if not isinstance(options, dict):
            raise FileTransferError("options must be a native keyword argument object", "options")
        if ("plan" in request) == ("target" in request):
            raise FileTransferError("Specify exactly one plan or native target", "target")
        with self.kernel.lock:
            if "plan" in request:
                shapes = []
                for value, metadata in self.kernel.evaluate(request["plan"]):
                    for shape in shapes_in(value):
                        shape = copy.copy(shape)
                        if "name" in metadata:
                            shape.label = metadata["name"]
                        if "color" in metadata:
                            color = metadata["color"]
                            shape.color = b.Color(color) if isinstance(color, str) else b.Color(*color)
                        shapes.append(shape)
            else:
                shapes = shapes_in(self.kernel.decode(request["target"]))
            if not shapes:
                raise FileTransferError("The CAD plan produced no exportable shapes", "target")
            shape = shapes[0] if len(shapes) == 1 else b.Compound(children=shapes)
            kwargs = self.kernel.decode(options)
            with tempfile.TemporaryDirectory(prefix="export-", dir=self.directory) as directory:
                path = Path(directory) / f"model.{format}"
                if format in {"step", "stl", "brep"}:
                    self.kernel.invoke(self.kernel.resolve(f"export_{format}"), [shape, str(path)], kwargs)
                else:
                    write_kwargs = {"ascii_format": kwargs.pop("ascii_format")} if format == "dxf" and "ascii_format" in kwargs else {}
                    exporter = self.kernel.invoke(self.kernel.resolve("ExportSVG" if format == "svg" else "ExportDXF"), [], kwargs)
                    for item in shapes:
                        self.kernel.invoke(exporter.add_shape, [item], {})
                    self.kernel.invoke(exporter.write, [str(path)], write_kwargs)
                if not path.is_file():
                    raise FileTransferError("The native exporter produced no file", "export")
                content = path.read_bytes()
        return content, filename, CONTENT_TYPES[format]

    def stream(self, value: Any) -> io.BytesIO | io.StringIO:
        with self.kernel.lock:
            try:
                result = self.kernel.decode(value)
            except ValueError as exception:
                raise FileTransferError(str(exception), "stream", 404) from exception
            if not isinstance(result, (io.BytesIO, io.StringIO)):
                raise FileTransferError("Expected a BytesIO or StringIO native handle", "stream")
            if result.closed:
                raise FileTransferError("The native stream is closed", "stream")
            return result


def decode_options(value: str | None) -> dict:
    if value is None:
        return {}
    try:
        result = json.loads(value)
    except (TypeError, ValueError) as exception:
        raise FileTransferError("options must contain valid JSON", "options") from exception
    if not isinstance(result, dict):
        raise FileTransferError("options must be an object", "options")
    return result
