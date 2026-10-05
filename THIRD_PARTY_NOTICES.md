# Third-party software

The TypeScript compatibility layer is MIT licensed. The distributed CAD runtime
includes `replicad` (MIT), `replicad-opencascadejs` (LGPL-2.1-only), and OpenCascade
under its LGPL license and additional exception. Their license terms continue to
apply to the WebAssembly binary; the wrapper's MIT license does not replace them.

The exact runtime dependencies are pinned in `package-lock.json`. OpenCascade.js
source, binding configuration, and reproducible build instructions are available
at https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs.
OpenCascade's license and exception are available at
https://dev.opencascade.org/resources/licensing.

DejaVu Sans is distributed with its license at `assets/fonts/LICENSE.txt`, also
copied to `dist/FONT-LICENSE.txt`. Bundled JavaScript dependency notices are
included with `dist/cdn.js`.
