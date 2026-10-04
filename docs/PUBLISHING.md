# Publishing to jscdn

The source repository is [tscircuit/b123-fiber](https://github.com/tscircuit/b123-fiber).
The package is `@tscircuit/b123-fiber`, hosted in GitHub Packages. jscdn proxies
GitHub Packages using its server-side token; package authors do not upload files
to the CDN. Released package files are available through jscdn when its bot has
read access to the linked package.

## Release workflow

Every push to `main` runs TypeScript, native, visual and CDN browser validation.
Only after validation passes does the CI workflow publish the version in
`package.json`, using the workflow's `GITHUB_TOKEN` with `packages: write`.
No npm token, bot token or external deployment secret is required in this
repository. Already published versions are skipped; authentication and network
failures fail the job instead of being treated as missing versions.

To release a new version:

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release the next package version"
git push origin main
```

Commit implementation changes with the version change, or bump the version
after merging them. Use the CI workflow's **Run workflow** button to retry the
current version; this also reruns validation. Published versions are immutable.

## CDN endpoints

For version `0.2.0`:

| Purpose | URL |
| --- | --- |
| Installable tarball | `https://jscdn.tscircuit.com/@tscircuit/b123-fiber/0.2.0.tgz` |
| Package metadata | `https://jscdn.tscircuit.com/@tscircuit/b123-fiber/0.2.0/package.json` |
| Browser module | `https://jscdn.tscircuit.com/@tscircuit/b123-fiber/0.2.0/dist/cdn.js` |
| Browser declarations | `https://jscdn.tscircuit.com/@tscircuit/b123-fiber/0.2.0/dist/cdn.d.ts` |

Use explicit versions for repeatable installations. jscdn also supports
`latest`, cached for ten minutes. The dedicated `dist/cdn.js` browser module
bundles the reconciler, ReactDOM and Three.js, and references the exact React
version in `package-lock.json`. It exports `React` and `createDOMRoot` alongside
the library exports. Normal npm entrypoints use the application's React and
Three.js peer dependencies. Use the dedicated browser module instead of the
generic root `+esm` endpoint: the CDN currently rewrites bare dependencies to
`latest`, and its CommonJS transformation cannot load this reconciler version.

The package contains Python source, `pyproject.toml` and `uv.lock`, so installed
clients can start the native OpenCascade service. Browser delivery distributes
the renderer and client; it does not host the geometry service.

## Verification

```sh
npm run build
npm run test:cdn
B123_CDN_BUNDLE_URL=https://jscdn.tscircuit.com/@tscircuit/b123-fiber/0.2.0/dist/cdn.js npm run test:cdn
```

The browser check loads the actual pinned React CDN module and either the local
build or published browser module. It verifies hooks in both ReactDOM and the
CAD reconciler, context, a state update that changes native volume from 24 to
60 mm³, and visible OpenCascade mesh pixels. Screenshots and results go to
`artifacts/cdn/`. Requests use verified TLS through the execution environment's
HTTP proxy where configured.

If publishing succeeds but jscdn returns 404, check that the service's
`GITHUB_PACKAGES_TOKEN` can read `tscircuit/b123-fiber` and its linked package.
The service's token configuration belongs to jscdn; changing the repository
visibility is not required.
