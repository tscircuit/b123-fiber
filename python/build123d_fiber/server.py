"""Loopback HTTP service; native geometry calls are serialized in Kernel."""

from __future__ import annotations

import hmac
import io
import os
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .files import MAX_FILE_BYTES, FileStore, FileTransferError, decode_options
from .kernel import Kernel, KernelError


def create_app(workspace_root: str | Path | None = None, token: str | None = None, origins: list[str] | None = None) -> FastAPI:
    app = FastAPI(title="build123d-fiber OpenCascade kernel", version="0.2.0")
    app.state.kernel = Kernel(workspace_root)
    app.state.files = FileStore(app.state.kernel)
    token = token or os.environ.get("BUILD123D_FIBER_TOKEN")
    origins = origins or ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"]
    @app.middleware("http")
    async def authorize(request: Request, call_next):
        if token and request.method != "OPTIONS":
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied.encode("utf-8"), f"Bearer {token}".encode("utf-8")):
                return JSONResponse({"error": {"type": "Unauthorized", "message": "Kernel bearer token is required", "path": "authorization"}}, status_code=401)
        return await call_next(request)

    # CORS wraps authentication so permitted origins can read structured 401s.
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "Authorization"], expose_headers=["Content-Disposition"])

    @app.exception_handler(KernelError)
    async def kernel_error(_request: Request, exception: KernelError):
        return JSONResponse(exception.json(), status_code=422)

    @app.exception_handler(FileTransferError)
    async def file_error(_request: Request, exception: FileTransferError):
        return JSONResponse(exception.json(), status_code=exception.status)

    async def file_body(request: Request) -> bytes:
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) > MAX_FILE_BYTES:
                    raise FileTransferError("Files must be no larger than 32 MiB", "file", 413)
            except ValueError as exception:
                raise FileTransferError("Invalid Content-Length", "file") from exception
        content = bytearray()
        async for chunk in request.stream():
            if len(content) + len(chunk) > MAX_FILE_BYTES:
                raise FileTransferError("Files must be no larger than 32 MiB", "file", 413)
            content.extend(chunk)
        return bytes(content)

    def download_response(content: bytes | str, filename: str, content_type: str) -> Response:
        return Response(content, media_type=content_type, headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        })

    @app.get("/health")
    def health():
        return {"status": "ok", "kernel": "build123d/OpenCascade", "version": "0.13.0"}

    @app.get("/api")
    def api():
        return app.state.kernel.api()

    @app.post("/rpc")
    def rpc(request: dict):
        return app.state.kernel.rpc(request)

    @app.post("/render")
    def render(request: dict):
        return app.state.kernel.render(request)

    @app.post("/files")
    async def upload(request: Request, filename: str = "model.bin"):
        content = await file_body(request)
        return {"file": app.state.files.save(content, filename, request.headers.get("content-type"))}

    @app.get("/files/{file_id}")
    def download(file_id: str):
        with app.state.kernel.lock:
            record, path = app.state.files.lookup(file_id)
            return download_response(path.read_bytes(), record["name"], record["contentType"])

    @app.delete("/files/{file_id}")
    def delete_file(file_id: str):
        app.state.files.delete(file_id)
        return {"deleted": True}

    @app.post("/files/import")
    async def import_file(request: Request, filename: str = "model.step", format: str | None = None, options: str | None = None):
        content = await file_body(request)
        try:
            return await run_in_threadpool(app.state.files.import_content, content, filename, format, decode_options(options))
        except (KernelError, FileTransferError):
            raise
        except Exception as exception:
            raise KernelError(str(exception), "files.import", type(exception).__name__) from exception

    @app.post("/files/export")
    def export_file(request: dict):
        try:
            content, filename, content_type = app.state.files.export_content(request)
            return download_response(content, filename, content_type)
        except (KernelError, FileTransferError):
            raise
        except Exception as exception:
            raise KernelError(str(exception), "files.export", type(exception).__name__) from exception

    @app.post("/streams")
    async def create_stream(request: Request, kind: str = "bytes"):
        content = await file_body(request)
        if kind not in {"bytes", "text"}:
            raise FileTransferError("stream kind must be bytes or text", "kind")
        try:
            stream = io.BytesIO(content) if kind == "bytes" else io.StringIO(content.decode("utf-8"))
        except UnicodeDecodeError as exception:
            raise FileTransferError("Text stream content must be valid UTF-8", "stream") from exception
        with app.state.kernel.lock:
            return {"value": app.state.kernel.retain(stream)}

    @app.get("/streams/{stream_id}")
    def read_stream(stream_id: str):
        with app.state.kernel.lock:
            stream = app.state.files.stream({"$ref": stream_id})
            binary = isinstance(stream, io.BytesIO)
            return download_response(stream.getvalue(), "stream.bin" if binary else "stream.txt", "application/octet-stream" if binary else "text/plain")

    @app.post("/streams/{stream_id}")
    async def replace_stream(stream_id: str, request: Request):
        content = await file_body(request)
        with app.state.kernel.lock:
            stream = app.state.files.stream({"$ref": stream_id})
            try:
                value = content if isinstance(stream, io.BytesIO) else content.decode("utf-8")
            except UnicodeDecodeError as exception:
                raise FileTransferError("Text stream content must be valid UTF-8", "stream") from exception
            stream.seek(0)
            stream.truncate(0)
            stream.write(value)
            stream.seek(0)
        return {"value": {"$ref": stream_id, "kind": type(stream).__name__}}

    return app


app = create_app()
