# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.8.24 AS uv
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_CACHE_DIR=/tmp/uv-cache \
    BUILD123D_FIBER_WORKSPACE=/data \
    PORT=8765

RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY python ./python
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi \
    && uv sync --frozen --no-dev \
    && rm -rf /tmp/uv-cache
COPY deployment/kernel/app.py ./app.py
COPY deployment/kernel/fonts ./fonts
RUN useradd --system --uid 10001 --create-home kernel \
    && mkdir -p /data \
    && chown kernel:kernel /data \
    && chmod -R a+rX /app
USER kernel
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s CMD ["/app/.venv/bin/python", "-c", "import os,urllib.request; token=os.environ.get('BUILD123D_FIBER_TOKEN'); urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+os.environ.get('PORT','8765')+'/health',headers={'Authorization':'Bearer '+token} if token else {}))"]
CMD ["/bin/sh", "-c", "exec /app/.venv/bin/uvicorn app:app --host 0.0.0.0 --port \"${PORT:-8765}\" --workers 1"]
