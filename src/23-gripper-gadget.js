// ── gripper: a tool, but a machine you can build ────────────────────────────
// A real rack-and-pinion parallel gripper: servo under the deck drives a pinion,
// two opposing racks slide on a linear rail, L-fingers do the gripping. Force is
// torque over the pinion pitch radius; hold is the friction cone at the pads.

function buildGripper(brief) {
  const d = newDesign('gripper', brief)
  const span = clamp(brief.reachMm || 80, 30, 240) // jaw opening, mm
  const payload = clampPayload(d, brief.payloadKg || 1, 0.1, 6)
  const mat = MATERIALS[brief.material] || MATERIALS.petg

  d.title = `${Math.round(span)}mm parallel gripper`
  d.subtitle = `${payload}kg class · rack & pinion · servo actuated`

  // ── mechanism numbers first: the gear decides the force ──────────────────
  const mod = 1.25 // gear module, mm
  const zTeeth = 14
  const pitchR = (mod * zTeeth) / 2 / 1000 // m
  // PWM servos only — the firmware drives a plain 50Hz channel, not a TTL bus
  const servo = SERVO_LADDER.filter((k) => k !== 'sts3215')
    .find((k) => (PARTS[k].torque * 0.35) / pitchR >= payload * G / 0.6 / 2) || 'ds3225'
  const T = PARTS[servo].torque
  const jawF = Math.min((T * 0.35) / pitchR, 150) // N per jaw, continuous — 35% stall is the honest hold
  const gripMass = (0.6 * 2 * jawF) / G // µ_eff 0.6 rubber pads, two contact faces

  const sd = PARTS[servo].dims || [40, 20, 40]
  const deckW = Math.max(92, sd[0] + 52)
  const deckL = span * 0.72 + 86
  const deckZ = 52 // top of deck
  const railY = 26

  // ── frame: mounting flange + pillars + deck ──────────────────────────────
  rbox(d, 'flange', [deckL, deckW, 7], [0, 0, 3.5], 2, 'accent', { print: true })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    rbox(d, `pillar-${sx}${sy}`, [14, 14, 40], [sx * (deckL / 2 - 12), sy * (deckW / 2 - 12), 27], 1.5, 'shell', { print: true })
    bolt(d, `flange-bolt-${sx}${sy}`, [sx * (deckL / 2 - 12), sy * (deckW / 2 - 12), 7], 'z', 10)
    bolt(d, `deck-bolt-${sx}${sy}`, [sx * (deckL / 2 - 12), sy * (deckW / 2 - 12), deckZ], 'z', 10)
  }
  rbox(d, 'deck', [deckL, deckW, 7], [0, 0, deckZ - 3.5], 2, 'shell', { print: true })
  // servo bay cheeks keep it rigid + give the ears somewhere to bolt
  for (const sy of [-1, 1]) box(d, `cheek-${sy}`, [deckL - 26, 5, 38], [0, sy * (deckW / 2 - 12), 27], 'shell', { print: true })

  // ── servo, shaft up through the deck ─────────────────────────────────────
  servoBody(d, 'servo', [0, 0, deckZ + 5], 'z', servo, null)
  bolt(d, 'servo-ear-a', [-sd[0] / 2 - 2, -8, deckZ - 12], 'y', 8, { flip: true })
  bolt(d, 'servo-ear-b', [sd[0] / 2 + 2, -8, deckZ - 12], 'y', 8, { flip: true })
  // cable sneaks out the back
  bend(d, 'servo-lead', 16, 2.2, 80, [-deckL / 2 + 16, -6, 30], [0, Math.PI / 2, Math.PI], 'belt')

  // ── pinion + opposing racks on the deck ──────────────────────────────────
  gear(d, 'pinion', mod, zTeeth, 9, [0, 0, deckZ + 9], 'z', 'steel')
  // racks must still engage the pinion AND reach their jaw at full close
  const rackLen = span * 0.75 + 80
  const rackH = 6
  const travel = span / 2 - 8
  slideJoint(d, 'jaw', 'Jaw travel', 'x', Math.max(8, travel))
  const rackY = pitchR * 1000 + rackH / 2 + 0.6 // pitch line kisses the pinion
  // rack A: teeth face -y (down toward pinion), jaw on the -x end
  rack(d, 'rack-a', [rackLen, 8, rackH], Math.round(rackLen / (Math.PI * mod)), [-span * 0.05, rackY, deckZ + 6], 'brass',
    { rot: [Math.PI / 2, 0, 0], print: true, slide: { joint: 'jaw', sign: 1 } })
  rack(d, 'rack-b', [rackLen, 8, rackH], Math.round(rackLen / (Math.PI * mod)), [span * 0.05, -rackY, deckZ + 6], 'brass',
    { rot: [-Math.PI / 2, 0, 0], print: true, slide: { joint: 'jaw', sign: -1 } })

  // ── linear rail + carriages carry the jaw load, racks only drive ─────────
  cyl(d, 'rail', 3, Math.min(deckL * 0.86, span * 0.9 + 60), [0, 0, deckZ + 3], 'x', 'steel', { segs: 10 })
  // the BOM's mgn12×2 are these: ground aluminum rail sections the carriage
  // trucks straddle — not printed drawer slides pretending to be linear guides
  for (const sy of [-1, 1]) {
    box(d, `rail-keeper-${sy}`, [Math.min(deckL * 0.8, span * 0.9 + 44), 12, 10], [0, sy * railY, deckZ + 5], 'metal')
  }

  // ── jaw assemblies: carriage pair + riser + L-finger + replaceable pad ────
  // At rest the PAD FACES sit ±span/2 — that is the rated opening. Closing
  // slides each jaw toward centre; pads meet at ~16mm residual gap.
  for (const s of [-1, 1]) {
    const sign = -s // jaw A (-x) rides slide +1 (toward centre = close)
    const tag = s < 0 ? 'a' : 'b'
    const slideOpt = { joint: 'jaw', sign }
    // carriage blocks on the keeper rails
    const jx = s * (span / 2 + 3)
    for (const sy of [-1, 1]) {
      rbox(d, `carriage-${tag}${sy}`, [26, 13, 8], [jx - s * 6, sy * railY, deckZ + 4], 1.2, 'metal', { slide: slideOpt })
    }
    // riser ties the carriages to the rack ends
    rbox(d, `riser-${tag}`, [10, railY * 2 + 13, 5], [jx - s * 6, 0, deckZ + 6.5], 1, 'accent', { print: true, slide: slideOpt })
    // L-finger: horizontal ear over the riser, vertical blade out at span/2
    const bladeX = s * (span / 2 + 7)
    const earX = s * (span / 2 - 10)
    rbox(d, `finger-ear-${tag}`, [36, 26, 5], [earX, 0, deckZ + 12], 1, 'accent', { print: true, slide: slideOpt })
    rbox(d, `blade-${tag}`, [6, 30, 46], [bladeX, 0, deckZ + 35], 1.5, 'shell', { print: true, slide: slideOpt })
    wedge(d, `gusset-${tag}`, [10, 26, 12], [earX - s * 8, 0, deckZ + 20], s < 0 ? 'nx' : 'px', 'accent', { print: true, slide: slideOpt })
    // replaceable fingertip pad on the blade's inboard face — inner face = span/2
    rbox(d, `pad-${tag}`, [4, 26, 30], [s * (span / 2 + 2), 0, deckZ + 30], 0.8, 'rubber', { slide: slideOpt })
    bolt(d, `blade-bolt-${tag}`, [s * (span / 2), 0, deckZ + 44], 'x', 8, { flip: s > 0, slide: slideOpt })
    bolt(d, `ear-bolt-${tag}`, [earX + s * 8, 0, deckZ + 14.5], 'z', 8, { slide: slideOpt })
  }

  // ── homing switch + jaw-position encoder ─────────────────────────────────
  box(d, 'limitsw', [20, 10, 7], [deckL / 2 - 14, -railY, deckZ + 10.5], 'pcb')
  rbox(d, 'limitsw-lever', [22, 2, 6], [deckL / 2 - 26, -railY, deckZ + 12], 0.5, 'steel')
  // jaw encoder relocated to the keeper lane: the magnet rides the moving
  // carriage at y≈27 (inside the keeper channel), the AS5600 sits on the
  // keeper top reading down through a ~2mm air gap — clear of the finger
  // sweep that made the old deck-level placement impossible
  rbox(d, 'enc-bracket', [6, 20, 26], [deckL / 2 - 8, 27, deckZ + 24], 1, 'shell', { print: true })
  elec(d, 'enc-pcb', 'as5600', [deckL / 2 - 24, 27, deckZ + 13])
  // controller stack on a printed backplate behind the deck — the deck top
  // is all mechanism (rail, keepers, carriages), so the boards stand on the
  // plate's rear face like a real gadget's rear cover
  rbox(d, 'elec-plate', [110, 12, 75], [0, -deckW / 2 - 6, 47.5], 2, 'shell', { print: true })
  elec(d, 'esp32', brief.mcu && PARTS[brief.mcu] ? brief.mcu : 'esp32s3', [0, -deckW / 2 - 16.5, 62], [0, 2, 1])
  elec(d, 'bus-adapter', 'bus_adapter', [-22, -deckW / 2 - 15.5, 35], [0, 2, 1])
  elec(d, 'buck5a', 'buck5a', [22, -deckW / 2 - 18.5, 30], [0, 2, 1])
  // power path on the front deck strip: ATO fuse, rail cap, power rocker —
  // clear of keepers (y≤29.5) and the cheek (z≤46)
  elec(d, 'fuse', 'fuse', [0, deckW / 2 - 6, deckZ + 9])
  elec(d, 'cap1000', 'cap1000', [deckL / 2 - 42, deckW / 2 - 7, deckZ + 8])
  // rocker stays BOM-only: the jaw sweeps every deck/plate face at OPEN —
  // there is no honest place for a panel switch on this machine
  cyl(d, 'enc-magnet', 3, 2, [deckL / 2 - 26, 27, deckZ + 7], 'y', 'steel', { slide: { joint: 'jaw', sign: 1 } })

  // ── parts: counted like a real kit list ──────────────────────────────────
  addPart(d, servo, 1, 'rack & pinion actuator')
  addPart(d, 'mgn12', 2, 'jaw linear guides')
  addPart(d, 'limit_sw', 1, 'homing end-stop')
  addPart(d, 'as5600', 1, 'jaw position feedback')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bus_adapter', 1, 'serial servo bus')
  addPart(d, 'buck5a', 1, '6V servo rail')
  addPart(d, brief.battery === 'pd5v' || !brief.battery ? 'pd5v' : brief.battery, 1, 'energy')
  addPart(d, 'fuse', 1, 'rail protection')
  addPart(d, 'cap1000', 1, 'servo rail smoothing')
  addPart(d, 'insert_m3', 2, 'heat-set threads (~16 pcs)')
  addPart(d, 'm3_screws', 2, 'frame + jaw bolts (~20 pcs)')
  addPart(d, 'm2_screws', 1, 'switch + encoder mounting')
  addPart(d, 'wire22', 1, 'signal harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, mat.priceId, 1, 'printed structure')

  // ── the honest numbers ────────────────────────────────────────────────────
  d.notes.push(`${PARTS[servo].name} on a Ø${fmt(pitchR * 2000, 1)}mm pinion → ${fmt(jawF, 0)}N continuous per jaw, ~${fmt(gripMass, 1)}kg held on rubber pads (µ 0.6).`)
  d.notes.push(`Two MGN12 rails carry the jaw side-load; the printed racks only see drive force. Jaw pads are the only wear part — print spares.`)
  if (gripMass < payload) {
    d.checks.push({ level: 'fail', msg: `Continuous grip holds ~${fmt(gripMass, 1)}kg but the brief asks ${payload}kg — step to a ${PARTS.ds3225.name}, shrink the pinion to 10T, or add a 2:1 gear stage.` })
  }
  if (jawF >= 150) {
    d.checks.push({ level: 'warn', msg: `${fmt(jawF, 0)}N per jaw is the printed-rack shear limit — go module 1.5 → 2.0 or machine the racks in acetal if this lives at full grip.` })
  }
  const opening = span
  if (opening < 40) d.checks.push({ level: 'warn', msg: `Jaw opening ${Math.round(opening)}mm — check the object fits with 6mm clearance past the pads.` })

  d.metrics = { gripForceN: jawF, gripMassKg: gripMass, spanMm: span, pinionMm: pitchR * 1000, joints: 1, servo }
  d.mech = [
    { label: 'Jaw force (continuous)', value: `${fmt(jawF, 0)} N`, limit: 'rack shear ~150 N', ok: jawF < 150 },
    { label: 'Pinion pitch radius', value: `${fmt(pitchR * 1000, 1)} mm`, limit: `m${mod} × ${zTeeth}T`, ok: null },
    { label: 'Hold capacity', value: `${fmt(gripMass, 1)} kg`, limit: `${payload} kg brief`, ok: gripMass >= payload },
    { label: 'Jaw travel', value: `${fmt(Math.max(8, travel), 0)} mm/side`, limit: 'stroke > obj/2', ok: null },
  ]
  // The jaw is driven by the servo already priced in the BOM; publish the link so
  // the jaw joint carries a stall torque instead of zero.
  d.actuators = (d.joints || []).map((jj) => ({
    label: jj.label, need: 0, servo, ratio: 1, effective: PARTS[servo].torque,
  }))
  return d
}

// ── gadget: the ESP32 build — small, but the same rigour ────────────────────
// Parts are chosen from the mission text, which is the one place the design is
// allowed to be "smart" rather than parametric.

const GADGET_RULES = [
  { re: /weather|climate|humidity|air|co2|barometer/i, parts: [['bme280', 'environment']], label: 'environmental' },
  { re: /plant|soil|garden|water/i, parts: [['soil', 'soil moisture']], label: 'plant care' },
  { re: /clock|timer|pomodoro|focus|countdown/i, parts: [['ili9341', 'main display']], label: 'timing' },
  { re: /camera|security|doorbell|vision|esp32-cam/i, parts: [['ov2640', 'camera']], label: 'vision' },
  { re: /voice|mic|listen|speech|assistant/i, parts: [['inmp441', 'microphone']], label: 'voice' },
  { re: /speaker|music|sound|beep|alarm|siren/i, parts: [['max98357', 'audio out']], label: 'audio' },
  { re: /distance|parking|radar|presence|tripwire/i, parts: [['vl53l0x', 'ranging']], label: 'ranging' },
  { re: /gps|track|location|hike|bike/i, parts: [['gps', 'positioning']], label: 'tracking' },
  { re: /scale|weight|coffee|dose/i, parts: [['hx711', 'load cell']], label: 'weighing' },
  { re: /motion|intruder|pir|detect/i, parts: [['pir', 'motion']], label: 'motion' },
  { re: /robot face|emotion|eyes|companion|pet/i, parts: [['gc9a01', 'face display']], label: 'character' },
  { re: /tilt|balance|orientation|self-balanc/i, parts: [['mpu6050', 'IMU']], label: 'attitude' },
]

function buildGadget(brief) {
  const d = newDesign('gadget', brief)
  const mission = brief.mission || ''
  const w = 90
  const h = 70
  const thick = 38

  d.title = 'ESP32 desk device'
  d.subtitle = 'pine enclosure · USB-C powered'

  // clamshell: base slab + four walls + lid — a solid case box buried the
  // pcb and pinned the screen under the lid where nothing could see it
  const WT = 2.4
  box(d, 'base', [w, h, 3], [0, 0, 1.5], 'shell', { print: true })
  for (const sx of [-1, 1]) box(d, `wall-x${sx}`, [WT, h, 35], [sx * (w / 2 - WT / 2), 0, 20.5], 'shell', { print: true })
  for (const sy of [-1, 1]) box(d, `wall-y${sy}`, [w - WT * 2, WT, 35], [0, sy * (h / 2 - WT / 2), 20.5], 'shell', { print: true })
  box(d, 'lid', [w - 4, h - 4, 4], [0, 0, thick + 2], 'accent', { print: true })
  box(d, 'pcb', [w - 16, h - 16, 2], [0, 0, 4], 'pcb')
  cyl(d, 'port-usb', 5, 10, [w / 2 - 2, 0, 8], 'x', 'metal')
  // louvered vent: sawtooth prism through the left wall — corrugated slots
  // instead of a flat plate; non-convex profile exercises ear-clipped caps
  prism(d, 'vent', [[-15, -6], [15, -6], [15, 2], [10, 6], [5, 2], [0, 6], [-5, 2], [-10, 6], [-15, 2]], 3, [-w / 2 - 0.5, 0, 20], 'x', 'metal')

  const chosen = []
  for (const rule of GADGET_RULES) {
    if (!rule.re.test(mission)) continue
    for (const [key, role] of rule.parts) {
      if (chosen.some((c) => c[0] === key)) continue
      chosen.push([key, role])
    }
  }
  // Default face: an OLED is never the wrong answer for a desk device.
  if (!chosen.some(([k]) => PARTS[k].cat === 'display')) chosen.push(['ssd1306', 'status display'])
  if (!chosen.some(([k]) => PARTS[k].cat === 'sensor')) chosen.push(['bme280', 'fallback sensor'])

  const isDisplay = (k) => PARTS[k].cat === 'display'
  const big = chosen.find(([k]) => k === 'ili9341' || k === 'gc9a01')
  const face = big ? big[0] : 'ssd1306'
  const faceSize = face === 'ili9341' ? [62, 47] : face === 'gc9a01' ? [36, 36] : [34, 18]

  // display stack rides ON the lid — screen-behind is the bezel plate,
  // glass sits proud on top; knob/button/sensor-window likewise
  const lidTop = thick + 4
  box(d, 'screen-behind', [faceSize[0] + 6, faceSize[1] + 6, 3], [-6, 2, lidTop + 1.5], 'metal')
  box(d, 'screen', [faceSize[0], faceSize[1], 2], [0, 0, lidTop + 3.5], 'glass')
  cyl(d, 'knob', 9, 12, [w / 2 - 18, -h / 2 + 16, lidTop + 6], 'z', 'accent', { print: true })
  cyl(d, 'button', 5, 8, [-w / 2 + 18, -h / 2 + 16, lidTop + 4], 'z', 'metal')
  box(d, 'sensor-window', [16, 8, 2], [0, -h / 2 + 8, lidTop + 1], 'glass')

  for (const [key, role] of chosen) addPart(d, key, 1, role)
  addPart(d, 'esp32s3', 1, 'controller')
  const gadgetPower = brief.battery === 'pd5v' || !brief.battery ? 'pd5v' : (PARTS[brief.battery] ? brief.battery : 'pd5v')
  addPart(d, gadgetPower, 1, gadgetPower === 'pd5v' ? 'USB-C power' : 'battery')
  addPart(d, 'jst_kit', 1, 'internal harness')
  addPart(d, 'hw_m3', 1, 'case screws')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'pla_kg', 1, 'printed case')

  d.notes.push(`Mission read as ${chosen.map(([, r]) => r).join(' + ')} — those parts are in the BOM, wired on the pin map.`)
  d.metrics = {
    parts: d.parts.length,
    width: w, height: h, depth: thick,
    joints: 0,
  }
  return d
}
