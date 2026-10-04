"""Loopback HTTP service; native geometry calls are serialized in Kernel."""

from __future__ import annotations

import hmac
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .kernel import Kernel, KernelError


def create_app(workspace_root: str | Path | None = None, token: str | None = None, origins: list[str] | None = None) -> FastAPI:
    app = FastAPI(title="build123d-fiber OpenCascade kernel", version="0.1.0")
    app.state.kernel = Kernel(workspace_root)
    token = token or os.environ.get("BUILD123D_FIBER_TOKEN")
    origins = origins or ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type", "Authorization"])

    @app.middleware("http")
    async def authorize(request: Request, call_next):
        if token and request.method != "OPTIONS":
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied, f"Bearer {token}"):
                return JSONResponse({"error": {"type": "Unauthorized", "message": "Kernel bearer token is required", "path": "authorization"}}, status_code=401)
        return await call_next(request)

    @app.exception_handler(KernelError)
    async def kernel_error(_request: Request, exception: KernelError):
        return JSONResponse(exception.json(), status_code=422)

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

    return app


app = create_app()
