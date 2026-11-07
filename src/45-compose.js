// ── brief → machine ─────────────────────────────────────────────────────────

const DEFAULT_BRIEF = {
  archetype: 'arm',
  mission: '5-DoF servo arm for pick and place on a workbench',
  payloadKg: 1,
  reachMm: 450,
  dof: 5,
  material: 'petg',
  mcu: 'esp32s3',
  battery: 'pack3s',
  wheelMm: 100,
  bedMm: 256,
}

const PRESETS = [
  { id: 'iot', label: 'IoT sensor node', brief: { archetype: 'iot', mission: 'a plant sensor that reports soil moisture to my phone', reachMm: 0, payloadKg: 0, battery: 'lipo2s' } },
  { id: 'drone', label: 'FPV drone', brief: { archetype: 'drone', mission: 'a 5-inch FPV quad that carries a camera for 6 minutes', reachMm: 127, payloadKg: 0.2, battery: 'lipo4s' } },
  { id: 'pcb', label: 'Controller board', brief: { archetype: 'pcb', mission: 'a 120mm controller board: ESP32-S3, climate sensor, OLED, power', reachMm: 120, payloadKg: 0 } },
  { id: 'arm', label: 'Pick & place arm', brief: { archetype: 'arm', mission: '5-DoF arm that sorts 3D-printed parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 } },
  { id: 'rover', label: 'Survey rover', brief: { archetype: 'rover', mission: '4WD rover with a camera mast that maps a room', payloadKg: 2, wheelMm: 100 } },
  { id: 'quad', label: 'Quadruped', brief: { archetype: 'quadruped', mission: '12-servo quadruped that trots and holds its attitude', payloadKg: 1, reachMm: 400, battery: 'lipo3s' } },
  { id: 'grip', label: 'Parallel gripper', brief: { archetype: 'gripper', mission: 'Servo gripper for a 60mm object, 1.5kg hold', reachMm: 80, payloadKg: 1.5 } },
  { id: 'humanoid', label: 'Humanoid', brief: { archetype: 'humanoid', mission: '550mm bipedal humanoid, 23 joints, balance IMU', payloadKg: 0.5, reachMm: 550, battery: 'lipo3s' } },
  { id: 'robot', label: 'Full robot', brief: { archetype: 'robot', mission: 'mobile manipulator: 4WD base, 5-DoF arm, camera head, 1kg payload', payloadKg: 1, reachMm: 450, wheelMm: 130, battery: 'lipo3s' } },
  { id: 'desk', label: 'ESP32 desk device', brief: { archetype: 'gadget', mission: 'ESP32 desk clock with temperature and humidity on an OLED', reachMm: 0, payloadKg: 0 } },
  { id: 'gantry', label: 'Full-scale gantry', brief: { archetype: 'gantry', mission: '1m gantry mill that cuts plywood, belts XY, leadscrew Z', reachMm: 1000, payloadKg: 2, battery: 'pack3s' } },
  { id: 'scene', label: 'Workshop scene', brief: { archetype: 'scene', mission: 'a lineup: pick-and-place arm, survey rover and a sensor node sharing one bench', scene: SCENE_DEFAULT } },
  // The spec card: nodes/joints ARE the design — agents author these through
  // rigforge_build, humans through build codes. This starter is a real machine
  // (pan-tilt survey mast) so the card is never an empty promise.
  { id: 'custom', label: 'Custom machine', brief: {
    archetype: 'custom', mission: 'spec-driven machine — the nodes/joints in this brief are the design',
    title: 'Pan-tilt survey mast', payloadKg: 0.4,
    nodes: [
      { kind: 'rbox', size: [150, 150, 10], at: [0, 0, 5], print: true, mat: 'accent' },
      { kind: 'cyl', r: 14, h: 150, axis: 'z', at: [0, 0, 85], mat: 'metal' },
      { kind: 'ring', ro: 20, ri: 14, h: 8, axis: 'z', at: [0, 0, 163], mat: 'steel' },
      { kind: 'rbox', size: [64, 44, 30], at: [0, 0, 180], joint: 'yaw', print: true },
      { kind: 'gear', m: 0.8, z: 20, w: 6, axis: 'x', at: [0, -26, 180], joint: 'tilt', mat: 'brass' },
      { kind: 'cyl', r: 4, h: 20, axis: 'x', at: [0, 0, 196], joint: 'tilt', mat: 'steel' },
      { kind: 'cyl', r: 16, h: 34, axis: 'y', at: [0, 42, 192], joint: 'tilt', mat: 'servo' },
      { kind: 'wedge', size: [30, 26, 18], dir: 'ny', at: [0, 58, 192], joint: 'tilt', print: true, mat: 'accent' },
      { kind: 'sphere', r: 9, at: [0, 62, 192], joint: 'tilt', mat: 'glass' },
    ],
    joints: [
      { id: 'yaw', label: 'Pan', axis: 'z', pivot: [0, 0, 158], min: -160, max: 160 },
      { id: 'tilt', label: 'Tilt', axis: 'x', pivot: [0, 0, 196], min: -70, max: 25, parent: 'yaw' },
    ],
  } },
]

// Same ladder, but it admits when nothing matched — the difference between
// "I heard you" and "here is a guess", which the UI must not blur.
/**
 * Which machine does this sentence name?
 *
 * This used to be first-rule-wins, which means the ORDER of the list silently
 * decides the answer: "a robot dog that carries tools" hit the quadruped rule
 * only because it happened to come before rover, and one stray word ("workshop")
 * could drag a vacuum into the scene builder. A person describing a machine says
 * several things at once, so every archetype now scores its own evidence and the
 * strongest reading wins. Ties keep list order, which is roughly specialisation
 * order (a lineup is more specific than a rover).
 */
const ARCH_TERMS = [
  ['scene', [
    /\b(?:two|three|four|five|several|multiple|a few)\b[^.]{0,24}\b(?:robots?|machines?|arms?|rovers?|drones?)\b/,
    /lineup|line.?up|assembly line|production line|fleet of|bench of machines/,
  ]],
  ['drone', [
    /\bdrones?\b/, /quad.?copter/, /\bquad\b/, /multirotor|hexacopter/,
    /\bfpv\b/, /\buav\b/, /flying|airborne/, /propellers?|copter/,
  ]],
  ['gantry', [
    /gantry/, /\bcnc\b/, /router|plotter/, /\bmill\b/, /laser cut/,
    /full.?scale|metre class|meter class/, /overhead/, /3.?axis machin/,
  ]],
  ['pcb', [
    /\bpcb\b/, /circuit board|controller board/, /breakout|carrier board/,
    /schematic|gerber/, /(custom|my own|design .{0,10}) ?board/,
    /board with (a|an|the)?\s*(screen|sensor|chip|relay)/,
  ]],
  ['iot', [
    /\biot\b/, /sensor node/, /thermostat|weather station/, /plant|soil|moisture/,
    /logger|beacon|tracker/, /\btag\b/, /door sensor|air quality/,
  ]],
  ['humanoid', [ /humanoid/, /biped|two.?leg/, /android|mannequin/ ]],
  ['robot', [
    /full robot|whole robot/, /mobile manipulator/,
    /robot arm on a (rover|base|chassis)/, /drive.*(and|&).*(grab|pick)/,
  ]],
  ['quadruped', [ /quadruped|quad pod/, /four.?leg/, /walking|\bdog\b|trot/ ]],
  ['gripper', [
    /gripper|claw|\bjaw\b/, /end.?effector/, /\bgrab\b|clamp|pinch|squeeze/,
    /hold (an? )?(egg|cup|block)/,
  ]],
  ['arm', [
    /\barm\b/, /manipulator/, /pick.?(and|&).?place/, /[56].?dof/, /delta/,
    /\bsort(s|ing|ed)?\b/, /\bweld(s|ing)?\b/, /assembly robot/,
  ]],
  ['rover', [
    /rover/, /\bcar\b|robot car/, /\btank\b/, /wheels?|mecanum/, /\bdrive\b|chassis/,
    /vacuum|roomba|sweeper/, /mower|lawn|tractor/,
  ]],
]

function matchArchetype(text) {
  const t = String(text || '').toLowerCase()
  let best = null
  ARCH_TERMS.forEach(([id, terms], order) => {
    let score = 0
    for (const re of terms) if (re.test(t)) score += 1
    if (!score) return
    // strict >, so an earlier (more specialised) archetype wins a tie
    if (!best || score > best.score) best = { id, archetype: id, score, order, confident: score >= 2, matched: true }
  })
  if (best) return best
  // "a robot that carries 40 kg of soil" names no chassis, but it is plainly a
  // load carrier: catching it here beats building an enclosure and calling it a
  // misunderstanding
  if (/(carry|carries|carrying|haul|hauls|transport|transports|pull|pulls|tow|tows|move|moves|shift|shifts|drag|drags)\b[^.]{0,24}\d+\s*(kg|kilo|g\b)/.test(t)) {
    return { id: 'rover', archetype: 'rover', confident: true, matched: true, score: 1, order: 99 }
  }
  return { id: 'gadget', archetype: 'gadget', confident: false, matched: false, score: 0, order: 99 }
}

function detectArchetype(text) {
  return matchArchetype(text).archetype
}

/** Pull numbers out of prose. "a 1.2kg payload with 500mm reach, 6 dof". */
function parseBrief(text) {
  const verdict = matchArchetype(text)
  const out = { ...DEFAULT_BRIEF, mission: text.trim(), archetype: verdict.archetype }
  // Whether the words actually named a machine. Nonsense used to fall through to
  // the smallest enclosure and build it without a word, which reads as "it
  // understood me" when it did not.
  out.archetypeMatched = verdict.matched
  if (!verdict.matched && out.mission.length < 4) out.archetypeMatched = true
  const kg = text.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)/i)
  if (kg) out.payloadKg = parseFloat(kg[1].replace(',', '.'))
  const g = text.match(/(\d{2,4})\s*g(?:ram)?\b/i)
  if (!kg && g) out.payloadKg = Math.max(0.1, parseFloat(g[1]) / 1000)
  // "130mm wheels" is a wheel Ø, not a reach — the units are the same, the
  // noun is what tells them apart.
  const wheel = text.match(/(\d{2,3})\s*mm[^.,;]{0,14}?wheels?/i) || text.match(/wheels?[^.,;]{0,14}?(\d{2,3})\s*mm/i)
  if (wheel) out.wheelMm = clamp(parseInt(wheel[1], 10), 60, 160)
  const mm = text.match(/(\d{2,4})\s*mm(?!\s*[^.,;]{0,10}wheels?)/i)
  if (mm && !(out.wheelMm && parseInt(mm[1], 10) === out.wheelMm)) out.reachMm = parseInt(mm[1], 10)
  const cm = text.match(/(\d{1,3})\s*cm/i)
  if (!mm && cm) out.reachMm = parseInt(cm[1], 10) * 10
  const dof = text.match(/([3-6])\s*(?:dof|degrees? of freedom|axis)/i)
  if (dof) out.dof = parseInt(dof[1], 10)
  if (/petg/i.test(text)) out.material = 'petg'
  if (/pla\b/i.test(text)) out.material = 'pla'
  if (/raspberry|pico|rp2/i.test(text)) out.mcu = 'pico'
  if (/c6|thread|zigbee/i.test(text)) out.mcu = 'esp32c6'
  if (/lipo/i.test(text)) out.battery = /3s/i.test(text) ? 'lipo3s' : 'lipo2s'
  if (/usb|tethered|desk/i.test(text)) out.battery = 'pd5v'
  if (out.archetype === 'gadget' && !/mm/i.test(text)) out.reachMm = 0
  // DEFAULT_BRIEF carries wheelMm:100, so "not set" has to be decided by the
  // regex, not by the inherited value.
  if (out.archetype === 'robot' && !wheel) out.wheelMm = 130
  if (out.archetype === 'humanoid' && !/\d{2,4}\s*mm/.test(text)) out.reachMm = 550
  return out
}

const cache = new Map()

/** The one entry point everything (UI, exports, tests) goes through. */
function composeDesign(brief) {
  const b = { ...DEFAULT_BRIEF, ...brief }
  const key = JSON.stringify(b)
  if (cache.has(key)) return cache.get(key)
  const design = b.archetype === 'scene' ? buildScene(b)
    : b.archetype === 'drone' ? buildDrone(b)
    : b.archetype === 'pcb' ? buildPcb(b)
    : b.archetype === 'iot' ? buildIot(b)
    : b.archetype === 'gantry' ? buildGantry(b)
    : b.archetype === 'custom' ? buildCustom(b)
    : b.archetype === 'humanoid' ? buildHumanoid(b)
    : b.archetype === 'robot' ? buildFullRobot(b)
    : b.archetype === 'rover' ? buildRover(b)
    : b.archetype === 'quadruped' ? buildQuadruped(b)
      : b.archetype === 'gripper' ? buildGripper(b)
        : b.archetype === 'gadget' ? buildGadget(b)
          : buildArm(b)
  const analysis = analyze(design)
  design.firmware = firmwareFor(design, analysis)
  design.steps = stepsFor(design, analysis)
  const out = { design, analysis }
  if (cache.size > 24) cache.clear()
  cache.set(key, out)
  return out
}

/** What we hand the agent: the brief, the numbers, and the contract back. */
function agentPrompt(brief, spec, instruction) {
  const { design, analysis } = spec
  const m = design.metrics || {}
  const lines = [
    instruction || 'Redesign this machine and hand it back.',
    '',
    'I am in the Rigforge build studio. Current machine:',
    `- archetype: ${brief.archetype}`,
    `- brief: ${brief.mission}`,
    `- payload ${brief.payloadKg}kg, reach ${brief.reachMm}mm, ${brief.dof || '-'} DoF, ${design.parts.length} line items`,
    `- mass ${Math.round(analysis.mass.totalG)}g, cost ${money(analysis.cost)}, peak ${fmt(analysis.power.peak, 1)}A`,
    m.joints || m.motor ? `- actuators: ${m.joints || 4} joints / motor ${m.motor ? PARTS[m.motor].name : 'n/a'}` : '',
    analysis.checks.filter((c) => c.level !== 'ok').map((c) => `- ${c.level}: ${c.msg}`).join('\n'),
    '',
    'Reply with a short justification AND a directive I can load straight into the studio:',
    '',
    '::rigforge{brief=<json with archetype, mission, payloadKg, reachMm, dof, material, mcu, battery>}',
    '',
    'Keep it inside these archetypes: pcb | iot | gadget | gripper | arm | rover | quadruped | humanoid | robot | gantry | custom.',
    'custom takes a nodes[] + joints[] spec instead of reach/dof — only numbers the engine can act on, no prose inside the json.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** `::rigforge{...}` on the way back in. Tolerant: agents are not parsers. */
function parseDirective(attrs) {
  const raw = attrs && (attrs.brief || attrs.spec || attrs.json)
  if (!raw) return null
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    const brief = JSON.parse(text.replace(/&quot;/g, '"'))
    if (!brief || typeof brief !== 'object') return null
    return { ...DEFAULT_BRIEF, ...brief }
  } catch {
    return null
  }
}
