// ── quadruped: the machine everyone wants and nobody budgets for ────────────
// 12 servos is not a detail, it is the whole electrical problem: peak current
// at gait contact is what browns out a DevKit.

function buildQuadruped(brief) {
  const d = newDesign('quadruped', brief)
  const payload = clamp(brief.payloadKg || 1, 0.2, 6)
  const legLen = clamp((brief.reachMm || 400) * 0.28, 90, 260)
  const hipW = clamp(Math.round(legLen * 1.35), 120, 340)
  const bodyLen = clamp(Math.round(hipW * 1.5), 160, 460)
  const bodyH = 46

  d.title = `12-servo quadruped · ${Math.round(legLen)}mm leg`
  d.subtitle = `${Math.round(bodyLen)}mm body · ${payload}kg carried`

  const z0 = legLen * 1.35
  box(d, 'body', [bodyLen, hipW, bodyH], [0, 0, z0], 'shell', { print: true })
  box(d, 'spine', [bodyLen * 0.9, 30, 12], [0, 0, z0 + bodyH / 2 + 6], 'accent', { print: true })
  box(d, 'pack', [bodyLen * 0.42, hipW * 0.52, 24], [0, 0, z0 + bodyH / 2 + 18], 'pcb')
  cyl(d, 'head', 30, 40, [bodyLen / 2 + 18, 0, z0 + 6], 'x', 'accent', { print: true })
  cyl(d, 'eye', 10, 6, [bodyLen / 2 + 40, 0, z0 + 12], 'x', 'glass')

  const femur = legLen * 0.62
  const tibia = legLen * 0.78
  const corners = [
    ['fl', 1, 1], ['fr', 1, -1], ['rl', -1, 1], ['rr', -1, -1],
  ]
  const jointIds = []
  corners.forEach(([name, sx, sy]) => {
    const ax = (sx * bodyLen) / 2 - sx * 14
    const ay = (sy * hipW) / 2 + sy * 10
    cyl(d, `coxa-${name}`, 16, 26, [ax, ay, z0], 'z', 'metal')
    box(d, `femur-${name}`, [24, 26, femur], [ax, ay + sy * 10, z0 - femur / 2], 'shell', { print: true })
    box(d, `tibia-${name}`, [20, 22, tibia], [ax, ay + sy * 10, z0 - femur - tibia / 2], 'accent', { print: true })
    cyl(d, `foot-${name}`, 12, 8, [ax, ay + sy * 10, z0 - femur - tibia], 'z', 'rubber')
    jointIds.push(`hip-${name}`)
    joint(d, `hip-${name}`, `Hip ${name.toUpperCase()}`, 'y', [ax, ay, z0], -60, 60)
  })

  // ── servo sizing at the worst leg phase ─────────────────────────────────
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const legMassKg = (printedVolume(d.nodes) / 4 / 1000) * mat.density / 1000
  const reqFoot = G * ((legMassKg * 0.5 + payload / 4) * (legLen / 1000)) * 1.8
  const key = SERVO_LADDER.find((k) => PARTS[k].torque >= reqFoot) || 'ds3218'
  const servo = PARTS[key]
  addPart(d, key, 12, '12 joints (3 per leg)')
  addPart(d, 'pca9685', 2, '24 channels of PWM')
  addPart(d, 'buck5a', 2, 'split servo rails')
  addPart(d, 'pack3s', 1, 'servo pack')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bno085', 1, 'body attitude')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed frame')

  const peakAll = servo.curr.peak * 12
  const peakGait = servo.curr.peak * 4 + servo.curr.typ * 8 // two legs lifting at once
  d.notes.push(`${servo.name} at every joint: ${fmt(reqFoot, 2)} N·m required at the worst gait phase.`)
  d.checks.push({
    level: 'warn',
    msg: `Servo peak ${fmt(peakGait, 1)}A on a 3S pack — split the rails across two UBECs and put a 1000µF cap at each PCA9685 terminal.`,
  })
  if (peakAll > PARTS.pack3s.maxA * 3) {
    d.checks.push({ level: 'warn', msg: `All-stall current is ${fmt(peakAll, 1)}A; the pack cannot do that. Firmware must stagger leg lifts.` })
  }

  Object.assign(d.metrics, {
    joints: 12,
    legMm: Math.round(legLen),
    massKg: (printedVolume(d.nodes) / 1000) * mat.density / 1000 + (servo.mass * 12) / 1000 + 0.3,
    peakAmps: peakGait,
    servo: key,
  })
  return d
}
