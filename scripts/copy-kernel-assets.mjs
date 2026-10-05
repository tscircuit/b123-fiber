import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
await mkdir(resolve(root, 'dist/kernel'), { recursive: true })
for (const directory of ['dist', 'dist/kernel']) {
  await copyFile(require.resolve('replicad-opencascadejs/wasm'), resolve(root, directory, 'opencascade.wasm'))
  await copyFile(resolve(root, 'assets/fonts/DejaVuSans.ttf'), resolve(root, directory, 'DejaVuSans.ttf'))
}
await copyFile(resolve(root, 'assets/fonts/LICENSE.txt'), resolve(root, 'dist/FONT-LICENSE.txt'))
await copyFile(resolve(root, 'node_modules/replicad-opencascadejs/LICENSE'), resolve(root, 'dist/OPENCASCADE-LICENSE.txt'))
const manifest = JSON.parse(await readFile(resolve(root, 'node_modules/replicad-opencascadejs/package.json'), 'utf8'))
await writeFile(resolve(root, 'dist/OPENCASCADE-NOTICE.txt'), `OpenCascade WebAssembly: replicad-opencascadejs ${manifest.version}\nLicense: ${manifest.license}\nSource and build instructions: https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs\nOpenCascade license and exception: https://dev.opencascade.org/resources/licensing\n`)
