// Plain English → machine. The product's first promise is "describe it and get
// it", so the sentence has to land on the right builder. This gate runs a table
// of sentences people actually type, and fails when one lands on the wrong
// archetype — or on no archetype at all when the words plainly name a machine.
import { loadEngine } from './lib-engine.mjs'

const A = loadEngine()
const results = []
function check(claim, fn) {
  try {
    results.push({ claim, ok: true, detail: fn() || '' })
  } catch (e) {
    results.push({ claim, ok: false, detail: e.message })
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
const arch = (text) => A.parseBrief(text).archetype

// Sentences as a user types them, and the machine they name.
const TABLE = [
  ['a plant sensor that texts me when it is dry', 'iot'],
  ['a weather station for the roof', 'iot'],
  ['a drone that follows me on a bike', 'drone'],
  ['a 5 inch fpv quad with a camera', 'drone'],
  ['a quadcopter that maps my garden', 'drone'],
  ['a robot vacuum for my workshop', 'rover'],
  ['a mower that cuts the lawn on a schedule', 'rover'],
  ['a line following car', 'rover'],
  ['a tank with 130mm wheels', 'rover'],
  ['a rover that maps my room', 'rover'],
  ['a robot that can climb stairs and carry 5kg', 'rover'],
  ['a 6 axis arm that welds', 'arm'],
  ['a chess playing arm', 'arm'],
  ['something that sorts lego by colour', 'arm'],
  ['a pick and place machine for pcbs', 'arm'],
  ['a robot dog that carries tools', 'quadruped'],
  ['a walking robot with four legs', 'quadruped'],
  ['a humanoid that waves at people', 'humanoid'],
  ['a biped that walks to the door', 'humanoid'],
  ['a gripper that holds an egg', 'gripper'],
  ['a claw for picking up bolts', 'gripper'],
  ['a full robot with a base and an arm', 'robot'],
  ['a mobile manipulator', 'robot'],
  ['a cnc router for plywood', 'gantry'],
  ['a metre scale gantry', 'gantry'],
  ['a controller board with an esp32 and an oled', 'pcb'],
  ['a custom pcb for a relay', 'pcb'],
  ['a desk device with a screen', 'gadget'],
  ['a sensor node in a box', 'iot'],
  ['a production line of three machines', 'scene'],
  ['an assembly line with a rover and an arm', 'scene'],
]

// The parser is allowed to emit these; every one of them must have a builder,
// or a sentence lands on an archetype that throws when the user presses BUILD.
const BUILDABLE = ['iot', 'pcb', 'drone', 'arm', 'rover', 'quadruped', 'gripper', 'gadget', 'humanoid', 'robot', 'gantry', 'scene', 'custom']

check('brief: everyday sentences route to the machine they name', () => {
  const wrong = []
  for (const [text, want] of TABLE) {
    const got = arch(text)
    if (got !== want) wrong.push(`"${text}" → ${got}, expected ${want}`)
  }
  assert(!wrong.length, `${wrong.length}/${TABLE.length} misrouted:\n      ${wrong.join('\n      ')}`)
  return `${TABLE.length}/${TABLE.length} sentences land on the right builder`
})

check('brief: every archetype the parser can emit is one the engine can build', () => {
  const emitted = [...new Set(TABLE.map(([t]) => arch(t)))]
  const missing = emitted.filter((a) => !BUILDABLE.includes(a))
  assert(!missing.length, `emitted but not buildable: ${missing.join(', ')}`)
  // and prove it: every expected archetype actually composes a design
  const built = []
  for (const a of emitted) {
    const { design } = A.composeDesign({ archetype: a })
    assert(design && design.nodes.length > 0, `${a} produced an empty design`)
    built.push(a)
  }
  return `${built.length} archetypes compose real geometry: ${built.join(', ')}`
})

check('brief: numbers in the sentence become numbers in the design', () => {
  const b = A.parseBrief('a 6 axis arm with 700mm reach that lifts 2.5kg of PETG')
  assert(b.archetype === 'arm', `archetype ${b.archetype}`)
  assert(b.dof === 6, `dof ${b.dof}`)
  assert(b.reachMm === 700, `reach ${b.reachMm}`)
  assert(Math.abs(b.payloadKg - 2.5) < 1e-9, `payload ${b.payloadKg}`)
  assert(b.material === 'petg', `material ${b.material}`)
  return `6 dof · 700mm · 2.5kg · PETG`
})

check('brief: nonsense is refused, not quietly built as a box', () => {
  const b = A.parseBrief('hello there')
  assert(b.archetypeMatched === false, 'nonsense was accepted as a machine')
  const ok = A.parseBrief('a rover that maps my room')
  assert(ok.archetypeMatched === true, 'a real machine was marked as unmatched')
  return 'unmatched flagged honestly'
})

const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}${r.ok ? ` — ${r.detail}` : ''}`)
  if (!r.ok) console.log(`      ${r.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} brief claims hold`)
process.exit(failed.length ? 1 : 0)
