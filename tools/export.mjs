// Export a complete build package without the app.
//
//   node tools/export.mjs "mobile manipulator, 1kg payload, 130mm wheels" builds/robot
//
// Writes spec.md, bom.csv, model.stl, model.scad, firmware.ino and build.json.
// Same engine the page uses, so a headless export and the studio can never drift.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../src')
const [briefText, outDirArg] = process.argv.slice(2)
if (!briefText) {
  console.error('usage: node tools/export.mjs "<brief>" [outdir]')
  process.exit(2)
}
const outDir = resolve(outDirArg || join(here, '..', 'builds', 'export'))

const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
let code = files.map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n')
code = code.replace(/^import[^\n]*\n/gm, '').replace(/^export default /m, 'globalThis.plugin = ')
const ctx = { console, jsx: () => null, jsxs: () => null, host: {} }
vm.createContext(ctx)
vm.runInContext(
  code + '\nglobalThis.A = { composeDesign, parseBrief, buildMesh, toSTL, toOpenSCAD, toSpecMarkdown, toBOMCsv, PRESETS }',
  ctx
)
const A = ctx.A

const brief = A.parseBrief(briefText)
const { design, analysis } = A.composeDesign(brief)
const mesh = A.buildMesh(design)
const slug = (design.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'build').slice(0, 48)
const dir = join(outDir, slug)
mkdirSync(dir, { recursive: true })

const write = (name, data, binary) => writeFileSync(join(dir, name), data, binary ? undefined : 'utf8')
write('spec.md', A.toSpecMarkdown(design, analysis))
write('bom.csv', A.toBOMCsv(design))
write('model.stl', Buffer.from(A.toSTL(mesh)), true)
write('model.scad', A.toOpenSCAD(design))
write('firmware.ino', design.firmware)
write('build.json', JSON.stringify({
  brief, title: design.title, subtitle: design.subtitle,
  metrics: design.metrics, parts: design.parts,
  analysis: { cost: analysis.cost, massG: analysis.mass.totalG, print: analysis.print, power: { typ: analysis.power.typ, peak: analysis.power.peak, runtimeMin: analysis.power.runtimeMin }, dims: analysis.dims, checks: analysis.checks },
  joints: design.joints.map((j) => ({ id: j.id, label: j.label, axis: j.axis, min: j.min, max: j.max })),
  steps: design.steps,
}, null, 2))

console.log(`${design.title}`)
console.log(`  ${design.parts.length} line items · ${Math.round(analysis.mass.totalG)}g · ${analysis.cost.toFixed(2)} USD · ${analysis.print.hours.toFixed(1)}h print · ${mesh.length} tris`)
console.log(`  checks: ${analysis.checks.map((c) => c.level).join(' ')}`)
console.log(`  → ${dir}`)
