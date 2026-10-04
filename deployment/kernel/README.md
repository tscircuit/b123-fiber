# Native kernel hosting

The sandbox sends complete CAD plans to a separate FastAPI service. The service
uses the same canonical `python/build123d_fiber` package, build123d 0.13.0 and
OpenCascade 8 as local development; geometry is computed on each request.

## Vercel

The `tscircuit/b123-fiber-kernel` Vercel project serves
`https://b123-fiber-kernel.vercel.app`. For Git deployments, set its root directory
to `deployment/kernel`, with **Include source files outside the Root Directory**
enabled. The local uv dependency in `pyproject.toml` installs the repository's
canonical Python package, and `uv.lock` pins all native dependencies.

Enable Fluid Compute and set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` for production
and preview. The native dependencies require approximately 790 MB uncompressed,
which exceeds Python's standard 500 MB function limit and uses Vercel's large
functions support. This fits its 5 GB limit. Each invocation has a 300 second
timeout and the existing plan's default memory allocation. See
[Vercel function limits](https://vercel.com/docs/functions/limitations).

To deploy a kernel-only snapshot from an authenticated Vercel CLI:

```sh
python deployment/kernel/build-context.py --output /tmp/b123-kernel-repository-deploy
cd /tmp/b123-kernel-repository-deploy
npx vercel link --project b123-fiber-kernel --scope tscircuit --yes
npx vercel --prod --scope tscircuit
```

The snapshot contains only the canonical Python service, dependency manifests,
hosting entrypoint and native runtime resources. It excludes the frontend,
tests and local credentials. Keep `.vercel` and `.env.local` outside Git.

The entrypoint bundles DejaVu Sans and preloads OCCT's OpenGL/X11 dependencies,
which Vercel's minimal Python runtime does not provide. These are native shared
libraries for Linux amd64; `native-libs/manifest.json` records their hashes and
upstream package names, with license notices in `native-libs/licenses`. The
OpenCascade and build123d wheels retain all their original modules and APIs.

## Container

Build from the repository root and run the included non-root, single-worker
container:

```sh
docker build -f deployment/kernel/Dockerfile -t b123-fiber-kernel .
docker run --rm -p 8765:8765 \
  -e BUILD123D_FIBER_ORIGINS=https://b123.tscircuit.com \
  -v b123-kernel-files:/data \
  b123-fiber-kernel
```

`PORT` defaults to `8765`. `BUILD123D_FIBER_WORKSPACE` selects the writable file
workspace, and `BUILD123D_FIBER_ORIGINS` is a comma-separated browser origin
list. Set `BUILD123D_FIBER_TOKEN` to require bearer authentication for a private
service; never put a private service token in the static frontend bundle.
The Dockerfile accepts an optional `proxy_ca` BuildKit secret for environments
with a session HTTPS proxy, without retaining the certificate in image layers.

## Requests and native state

The hosted entrypoint accepts requests up to **4 MiB**, including uploaded file
content, and Vercel limits function responses to 4.5 MB. Its `/tmp` workspace is
temporary. Hosted sandbox edits use self-contained `/render` plans; uploaded
content required by a plan should be included with that request.

`/rpc` native handles, `/streams` handles and separately uploaded `/files`
identifiers belong to a process. Vercel can start another process or discard a warm instance between
requests, so those identifiers cannot be treated as persistent hosted sessions.
Use a single-worker container with a persistent workspace when a client needs
long-lived handles or files. The sandbox does not rely on persisted handles.

Verify the running native service:

```sh
curl https://b123-fiber-kernel.vercel.app/health
curl https://b123-fiber-kernel.vercel.app/render \
  -H 'Content-Type: application/json' \
  --data '{"plan":{"version":1,"children":[{"type":"Box","props":{"args":[2,3,4]},"children":[]}]}}'
```

The native box has a volume of 24 mm³ and twelve triangles. No precomputed mesh
is used for this request.
