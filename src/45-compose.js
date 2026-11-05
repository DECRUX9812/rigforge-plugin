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
}

const PRESETS = [
  { id: 'iot', label: 'IoT sensor node', brief: { archetype: 'iot', mission: 'a plant sensor that reports soil moisture to my phone', reachMm: 0, payloadKg: 0, battery: 'lipo2s' } },
  { id: 'arm', label: 'Pick & place arm', brief: { archetype: 'arm', mission: '5-DoF arm that sorts 3D-printed parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 } },
  { id: 'rover', label: 'Survey rover', brief: { archetype: 'rover', mission: '4WD rover with a camera mast that maps a room', payloadKg: 2, wheelMm: 100 } },
  { id: 'quad', label: 'Quadruped', brief: { archetype: 'quadruped', mission: '12-servo quadruped that trots and holds its attitude', payloadKg: 1, reachMm: 400 } },
  { id: 'grip', label: 'Parallel gripper', brief: { archetype: 'gripper', mission: 'Servo gripper for a 60mm object, 1.5kg hold', reachMm: 80, payloadKg: 1.5 } },
  { id: 'humanoid', label: 'Humanoid', brief: { archetype: 'humanoid', mission: '550mm bipedal humanoid, 23 joints, balance IMU', payloadKg: 0.5, reachMm: 550 } },
  { id: 'robot', label: 'Full robot', brief: { archetype: 'robot', mission: 'mobile manipulator: 4WD base, 5-DoF arm, camera head, 1kg payload', payloadKg: 1, reachMm: 450, wheelMm: 130 } },
  { id: 'desk', label: 'ESP32 desk device', brief: { archetype: 'gadget', mission: 'ESP32 desk clock with temperature and humidity on an OLED', reachMm: 0, payloadKg: 0 } },
  { id: 'gantry', label: 'Full-scale gantry', brief: { archetype: 'gantry', mission: '1m gantry mill that cuts plywood, belts XY, leadscrew Z', reachMm: 1000, payloadKg: 2, battery: 'pack3s' } },
]

function detectArchetype(text) {
  const t = text.toLowerCase()
  if (/gantry|cnc|router|mill\b|plotter|laser cut|full.?scale|metre class|meter class|overhead|3.?axis machin/.test(t)) return 'gantry'
  if (/iot|sensor node|thermostat|weather station|plant|logger|beacon|tracker|tag\b|door sensor|air quality/.test(t)) return 'iot'
  if (/humanoid|biped|two.?leg|android|mannequin/.test(t)) return 'humanoid'
  if (/full robot|mobile manipulator|robot arm on a (rover|base|chassis)|drive.*(and|&).*(grab|pick)|whole robot/.test(t)) return 'robot'
  if (/quadruped|quad pod|four.?leg|walking|dog\b|trot/.test(t)) return 'quadruped'
  if (/gripper|claw|jaw|end.?effector/.test(t)) return 'gripper'
  if (/\barm\b|manipulator|pick.?(and|&).?place|6.?dof|5.?dof|delta/.test(t)) return 'arm'
  if (/rover|car\b|robot car|tank|wheels?|mecanum|drive|chassis/.test(t)) return 'rover'
  return 'gadget'
}

/** Pull numbers out of prose. "a 1.2kg payload with 500mm reach, 6 dof". */
function parseBrief(text) {
  const out = { ...DEFAULT_BRIEF, mission: text.trim(), archetype: detectArchetype(text) }
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
  const design = b.archetype === 'iot' ? buildIot(b)
    : b.archetype === 'gantry' ? buildGantry(b)
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
    'Keep it inside these archetypes: iot | gadget | gripper | arm | rover | quadruped | humanoid | robot | gantry.',
    'Only numbers the engine can act on — no prose inside the json.',
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
