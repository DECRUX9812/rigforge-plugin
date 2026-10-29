// Engine smoke test: compose every archetype, print the numbers that matter.
// Runs in plain node against src (no SDK, no app) — the engine must stand alone.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const files = ['00-head.js', '10-parts.js', '15-design.js', '20-arm.js', '21-rover.js', '22-quadruped.js', '23-gripper-gadget.js', '30-analysis.js', '35-firmware.js', '40-geometry.js', '45-compose.js']
let src = files.map((f) => readFileSync(join(here, '../src', f), 'utf8')).join('\n')
src = src
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export default /m, 'globalThis.plugin = ')

const ctx = { console, jsx: () => null, jsxs: () => null, host: {} }
vm.createContext(ctx)
vm.runInContext(src + '\nglobalThis.API = { composeDesign, parseBrief, buildMesh, toSTL, toOpenSCAD, toSpecMarkdown, toBOMCsv, PRESETS, DEFAULT_BRIEF, PARTS, analyze, parseDirective }', ctx)

const api = ctx.API
const cases = [
  'ESP32 desk clock with temperature and humidity on an OLED',
  '4WD rover with a camera mast, 3kg payload',
  '12-servo quadruped that trots, 1kg',
  '5 dof arm, 0.8kg payload, 450mm reach',
  'parallel gripper for a 60mm object',
]

for (const text of cases) {
  const brief = api.parseBrief(text)
  const spec = api.composeDesign(brief)
  const a = spec.analysis
  const tris = api.buildMesh(spec.design)
  const stl = api.toSTL(tris)
  console.log(`\n── ${text}`)
  console.log(`   ${spec.design.archetype.padEnd(10)} ${spec.design.title}`)
  console.log(`   parts=${spec.design.parts.length} tris=${tris.length} stl=${stl.byteLength}B cost=${a.cost.toFixed(2)} mass=${Math.round(a.mass.totalG)}g print=${a.print.grams.toFixed(0)}g/${a.print.hours.toFixed(1)}h`)
  console.log(`   power typ=${a.power.typ.toFixed(2)}A peak=${a.power.peak.toFixed(2)}A runtime=${a.power.runtimeMin ? Math.round(a.power.runtimeMin) + 'min' : 'n/a'} pins=${a.pins.rows.length}`)
  console.log(`   checks: ${a.checks.map((c) => c.level).join(',')}`)
  console.log(`   first check: ${a.checks[0].msg.slice(0, 110)}`)
  console.log(`   fw: ${spec.design.firmware.split('\n')[0].slice(0, 70)} | ${spec.design.firmware.split('\n').length} lines`)
  console.log(`   steps: ${spec.design.steps.length}, scad: ${api.toOpenSCAD(spec.design).split('\n').length} lines, md: ${api.toSpecMarkdown(spec.design, a).length}b`)
  if (a.checks.some((c) => c.level === 'fail')) {
    console.log('   FAILS: ' + a.checks.filter((c) => c.level === 'fail').map((c) => c.msg).join(' | '))
  }
}

// directive round-trip
const dir = api.parseDirective({ brief: '{"archetype":"rover","mission":"moon rover","payloadKg":4}' })
console.log('\ndirective parse:', dir && dir.archetype, dir && dir.payloadKg)
console.log('bad directive:', api.parseDirective({ brief: 'not json' }))
