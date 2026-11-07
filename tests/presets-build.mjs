// Every preset must produce a buildable machine: no failing checks, real parts,
// real geometry, real mass. The "anyone can build anything" promise is only as
// wide as the preset list, so the whole list is exercised, not the two I happen
// to be working on.
import { loadEngine } from './lib-engine.mjs'

const A = loadEngine()
let passed = 0
const failures = []
function check(name, fn) {
  try { const detail = fn(); passed += 1; console.log(`PASS  ${name} — ${detail}`) }
  catch (e) { failures.push({ name, msg: e.message }); console.log(`FAIL  ${name} — ${e.message}`) }
}
function summary() {
  console.log(`\n${passed}/${passed + failures.length} preset claims hold`)
  if (failures.length) process.exitCode = 1
}

check('every preset builds with no failing checks', () => {
  const bad = []
  for (const p of A.PRESETS) {
    const { design, analysis } = A.composeDesign({ ...p.brief })
    const fails = (analysis.checks || []).filter((c) => c.level === 'fail' || c.level === 'error')
    if (fails.length) bad.push(`${p.id}: ${fails[0].msg.slice(0, 70)}`)
    if (!design.parts.length) bad.push(`${p.id}: no parts`)
    if (!design.nodes.length) bad.push(`${p.id}: no geometry`)
    if (!(analysis.mass.totalG > 0)) bad.push(`${p.id}: no mass`)
    if (!design.title) bad.push(`${p.id}: no title`)
  }
  if (bad.length) throw new Error(bad.join(' · '))
  return `${A.PRESETS.length} presets, each with parts, geometry, mass and a clean check list`
})

// A preset is a demonstration, so it must also be reachable from its own
// sentence — otherwise the list is a menu nobody can order from.
// 'scene' and 'custom' are not sentences — one is a composed lineup, the other
// is a hand-built spec. Excluding them by name is honest; quietly dropping them
// from the loop would make the count look better than it is.
const NOT_A_SENTENCE = new Set(['scene', 'custom'])

check('every machine preset is reachable from a sentence', () => {
  const missed = []
  for (const p of A.PRESETS) {
    if (NOT_A_SENTENCE.has(p.id)) continue
    if (!p.brief || !p.brief.archetype) continue
    const got = A.parseBrief(p.label + ' please').archetype
    if (got !== p.brief.archetype) missed.push(`${p.id} → ${got}`)
  }
  if (missed.length) throw new Error(missed.join(' · '))
  return `${A.PRESETS.length - NOT_A_SENTENCE.size} machine presets each route back to their own archetype`
})

summary()
