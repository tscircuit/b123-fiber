"""Vercel and container entrypoint for the native, stateless CAD plan service."""

from __future__ import annotations

import os
import ctypes
import json
import platform
import sys
from pathlib import Path
import tempfile

from fastapi import Request
from fastapi.responses import JSONResponse


DEFAULT_ORIGINS = (
    "https://b123.tscircuit.com",
    "https://temporary-racing-aurora-9ontiux.vercel.app",
)
MAX_REQUEST_BYTES = 4 * 1024 * 1024


def load_native_libraries() -> None:
    """Load OCCT's system GL/X11 dependencies missing from minimal runtimes."""
    if sys.platform != "linux" or platform.machine() != "x86_64":
        return
    libraries = Path(__file__).parent / "native-libs"
    manifest = libraries / "manifest.json"
    if manifest.is_file():
        for entry in json.loads(manifest.read_text()):
            ctypes.CDLL(str(libraries / entry["filename"]), mode=ctypes.RTLD_GLOBAL)


def configure_fonts(workspace: Path) -> None:
    """Give native fontconfig a bundled font even in a minimal function image."""
    fonts = Path(__file__).parent / "fonts"
    if not fonts.is_dir():
        return
    cache = workspace / "fontconfig-cache"
    cache.mkdir(parents=True, exist_ok=True)
    config = workspace / "fonts.conf"
    config.write_text(
        '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n'
        f"<fontconfig><dir>{fonts}</dir><cachedir>{cache}</cachedir></fontconfig>\n"
    )
    os.environ.setdefault("FONTCONFIG_FILE", str(config))


def register_bundled_fonts() -> None:
    """Register the hosted font in OCCT before build123d initializes its manager.

    build123d's FontManager resets FONTCONFIG_FILE, so fontconfig alone cannot
    make the TTF available on a minimal runtime. CheckFont retains its real
    family name, unlike FontManager.register_font's display-name conversion.
    """
    font_path = Path(__file__).parent / "fonts" / "DejaVuSans.ttf"
    if not font_path.is_file():
        return
    from OCP.Font import Font_FontMgr
    from OCP.TCollection import TCollection_AsciiString

    manager = Font_FontMgr.GetInstance_s()
    font = manager.CheckFont(str(font_path.resolve()))
    if font is None:
        raise RuntimeError("OCCT cannot load the bundled DejaVu Sans font")
    manager.ClearFontDataBase()
    if not manager.RegisterFont(font, True):
        raise RuntimeError("OCCT cannot register the bundled DejaVu Sans font")
    manager.AddFontAlias(TCollection_AsciiString("Arial"), font.FontName())


workspace = Path(os.environ.get("BUILD123D_FIBER_WORKSPACE", tempfile.gettempdir() + "/build123d-fiber"))
workspace.mkdir(parents=True, exist_ok=True)
configure_fonts(workspace)
load_native_libraries()
register_bundled_fonts()

# build123d can now add its upstream single-line fonts and canary alias normally.
from build123d_fiber.server import create_app  # noqa: E402


origins = [origin.strip() for origin in os.environ.get("BUILD123D_FIBER_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",") if origin.strip()]
app = create_app(workspace, origins=origins)


@app.middleware("http")
async def limit_request_body(request: Request, call_next):
    """Reject oversized CAD plans before JSON parsing or native execution."""
    def too_large():
        origin = request.headers.get("origin")
        headers = {"Access-Control-Allow-Origin": origin, "Vary": "Origin"} if origin in origins else {}
        return JSONResponse({"error": {"type": "PayloadTooLarge", "message": "CAD request exceeds 4 MiB", "path": "request"}}, status_code=413, headers=headers)

    if request.method == "POST":
        content_length = request.headers.get("content-length")
        if content_length and content_length.isdecimal() and int(content_length) > MAX_REQUEST_BYTES:
            return too_large()
        content = bytearray()
        async for chunk in request.stream():
            if len(content) + len(chunk) > MAX_REQUEST_BYTES:
                return too_large()
            content.extend(chunk)
        # Starlette's cached request replays this bounded body to downstream
        # middleware and FastAPI, including the raw CAD-file upload handlers.
        request._body = bytes(content)
    return await call_next(request)
