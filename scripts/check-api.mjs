import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { strict as assert } from 'node:assert'
const root = new URL('../', import.meta.url)
const inventory = JSON.parse(await readFile(new URL('docs/api-inventory.json', root), 'utf8'))
const compiled = await build({ entryPoints: [new URL('lib/generated/symbols.ts', root).pathname], bundle: true, format: 'esm', write: false })
const { publicSymbols, build123dVersion } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`)
assert.equal(build123dVersion, inventory.build123dVersion)
assert.equal(publicSymbols.length, inventory.exportCount)
assert.deepEqual([...publicSymbols].sort(), Object.keys(inventory.symbols).sort())
console.log(`Compatibility declarations: ${inventory.exportCount} build123d ${build123dVersion} symbols`)
