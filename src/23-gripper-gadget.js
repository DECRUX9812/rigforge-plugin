// ── gripper: a tool, but a machine you can build ────────────────────────────
// Grip force is a real calculation: servo torque over the lever arm, then the
// friction cone decides whether the object actually stays in the jaws.

function buildGripper(brief) {
  const d = newDesign('gripper', brief)
  const span = clamp(brief.reachMm || 80, 30, 240) // jaw opening, mm
  const payload = clamp(brief.payloadKg || 1, 0.1, 6)

  d.title = `${Math.round(span)}mm parallel gripper`
  d.subtitle = `${payload}kg class · servo actuated`

  box(d, 'body', [span * 0.9, 62, 46], [0, 0, 0], 'shell', { print: true })
  box(d, 'servo-mount', [30, 56, 50], [-span * 0.55, 0, 0], 'accent', { print: true })
  cyl(d, 'pinion', 14, 30, [0, 0, 24], 'z', 'metal')
  box(d, 'rack-a', [span * 0.8, 10, 12], [0, -14, 10], 'metal')
  box(d, 'rack-b', [span * 0.8, 10, 12], [0, 14, 10], 'metal')
  box(d, 'jaw-a', [span * 0.7, 8, 40], [span * 0.1, -(span / 2), 0], 'accent', { print: true })
  box(d, 'jaw-b', [span * 0.7, 8, 40], [span * 0.1, span / 2, 0], 'accent', { print: true })
  box(d, 'pad-a', [span * 0.6, 4, 30], [span * 0.14, -(span / 2) + 6, 0], 'rubber')
  box(d, 'pad-b', [span * 0.6, 4, 30], [span * 0.14, span / 2 - 6, 0], 'rubber')

  joint(d, 'jaw-slide', 'Jaw travel', 'y', [0, 0, 0], -span / 2, span / 2)

  // torque → force → what it can hold
  const lever = 0.014 // m, pinion radius
  const key = SERVO_LADDER.find((k) => PARTS[k].torque / lever >= payload * G * 6) || 'ds3218'
  const force = PARTS[key].torque / lever
  const gripMass = (force * 0.4) / G // rubber-on-rubber µ≈0.8, derated
  addPart(d, key, 1, 'jaw actuator')
  addPart(d, 'bearing608', 2, 'jaw guides')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'pca9685', 1, 'PWM channel')
  addPart(d, 'as5600', 1, 'jaw position feedback')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed jaws')

  d.notes.push(`${PARTS[key].name} → ${fmt(force, 0)}N at the jaw face, ~${fmt(gripMass, 1)}kg held with rubber pads.`)
  if (gripMass < payload) {
    d.checks.push({ level: 'fail', msg: `Grip force supports ${fmt(gripMass, 1)}kg but the brief asks ${payload}kg — add a 2:1 rack reduction or a stronger servo.` })
  }

  d.metrics = { gripForceN: force, gripMassKg: gripMass, spanMm: span, joints: 1 }
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

  box(d, 'case', [w, h, thick], [0, 0, thick / 2], 'shell', { print: true })
  box(d, 'lid', [w - 4, h - 4, 4], [0, 0, thick + 2], 'accent', { print: true })
  box(d, 'pcb', [w - 16, h - 16, 2], [0, 0, 16], 'pcb')
  cyl(d, 'port-usb', 5, 10, [w / 2 - 2, 0, 8], 'x', 'metal')
  box(d, 'vent', [w * 0.5, 6, 3], [0, h / 2 - 6, 18], 'metal')

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

  box(d, 'screen-behind', [faceSize[0] + 6, faceSize[1] + 6, 3], [-6, 2, thick - 2], 'metal')
  box(d, 'screen', [faceSize[0], faceSize[1], 2], [0, 0, thick - 1], 'glass')
  cyl(d, 'knob', 9, 12, [w / 2 - 18, -h / 2 + 16, thick], 'z', 'accent', { print: true })
  cyl(d, 'button', 5, 8, [-w / 2 + 18, -h / 2 + 16, thick], 'z', 'metal')
  box(d, 'sensor-window', [16, 8, 2], [0, -h / 2 + 8, thick - 1], 'glass')

  for (const [key, role] of chosen) addPart(d, key, 1, role)
  addPart(d, 'esp32s3', 1, 'controller')
  addPart(d, 'pd5v', 1, 'USB-C power')
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
