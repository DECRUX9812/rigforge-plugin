// Concatenate src/*.js (sorted) into the single-plugin bundle.
// Order matters; the numeric prefixes are the build order.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, 'src')
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
let out = ''
for (const f of files) {
  out += readFileSync(join(srcDir, f), 'utf8').replace(/\s+$/, '') + '\n\n'
}
mkdirSync(join(here, 'desktop'), { recursive: true })
writeFileSync(join(here, 'web/plugin.js'), out)
console.log(`built web/plugin.js from ${files.length} files — ${out.split('\n').length} lines, ${(out.length / 1024).toFixed(1)} KB`)
