// ── quadruped: the machine everyone wants and nobody budgets for ────────────
// 12 servos is not a detail, it is the whole electrical problem: peak current
// at gait contact is what browns out a DevKit.

function buildQuadruped(brief) {
  const d = newDesign('quadruped', brief)
  const payload = clampPayload(d, brief.payloadKg || 1, 0.2, 6)
  const legLen = clamp((brief.reachMm || 400) * 0.28, 90, 260)
  const hipW = clamp(Math.round(legLen * 1.35), 120, 340)
  const bodyLen = clamp(Math.round(hipW * 1.5), 160, 460)
  const bodyH = 46

  d.title = `12-servo quadruped · ${Math.round(legLen)}mm leg`
  d.subtitle = `${Math.round(bodyLen)}mm body · ${payload}kg carried`

  const z0 = legLen * 1.35
  const bed = brief.bedMm || 256
  splitBox(d, 'body', [bodyLen, hipW, bodyH], [0, 0, z0], 3, 'shell', bed, { print: true })
  splitBox(d, 'spine', [bodyLen * 0.9, 30, 12], [0, 0, z0 + bodyH / 2 + 6], 1, 'accent', bed, { print: true })
  rbox(d, 'pack', [bodyLen * 0.42, hipW * 0.52, 24], [0, 0, z0 + bodyH / 2 + 18], 2, 'pcb')
  // the BOM's brains are real parts: IMU centered on the spine shelf for
  // body attitude, controller board on the body top outboard of the spine
  const bodyTop = z0 + bodyH / 2
  elec(d, 'imu', 'bno085', [bodyLen * 0.3, 0, z0 + bodyH / 2 + 14])
  elec(d, 'esp32', brief.mcu && PARTS[brief.mcu] ? brief.mcu : 'esp32s3', [-bodyLen * 0.35, -hipW * 0.4, bodyTop + 5])
  // the BOM's driver boards at catalog dims: two PCA9685 on the pack lid,
  // two UBECs on the body-top front strip clear of spine and pack
  elec(d, 'pca9685-a', 'pca9685', [-20, 0, bodyTop + 32], [1, 0, 2])
  elec(d, 'pca9685-b', 'pca9685', [20, 0, bodyTop + 32], [1, 0, 2])
  elec(d, 'buck5a-a', 'buck5a', [-25, 57, bodyTop + 6])
  elec(d, 'buck5a-b', 'buck5a', [25, 57, bodyTop + 6])
  cyl(d, 'head', 23, 34, [bodyLen / 2 + 14, 0, z0 + 10], 'x', 'accent', { print: true })
  cyl(d, 'eye', 8, 6, [bodyLen / 2 + 32, 0, z0 + 14], 'x', 'glass')

  const femur = legLen * 0.62
  const tibia = legLen * 0.78
  // Servo sizing first: the worst gait phase is a leg levering the body up on
  // one foot — torque at the femur, 1.8× on top. One servo everywhere.
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const legMassKg = ((22 * 24 * femur * 0.62 + 16 * 18 * tibia * 0.72) * 0.34 * mat.density) / 1e6 + 0.09
  const reqFoot = G * ((legMassKg * 0.5 + payload / 4) * (legLen / 1000)) * 1.8
  const servoKey = SERVO_LADDER.find((k) => PARTS[k].torque >= reqFoot) || 'ds3218'
  const servo = PARTS[servoKey]

  const corners = [
    ['fl', 1, 1], ['fr', 1, -1], ['rl', -1, 1], ['rr', -1, -1],
  ]
  // 3 DOF per leg, the way the firmware already walks it: coxa yaw (z),
  // femur pitch (y), tibia pitch (y) — each with its own servo body.
  corners.forEach(([name, sx, sy]) => {
    const ax = (sx * bodyLen) / 2 - sx * 14
    const ay = (sy * hipW) / 2 + sy * 10
    const hipZ = z0 - 4

    joint(d, `coxa-${name}`, `Coxa ${name.toUpperCase()}`, 'z', [ax, ay, hipZ], -30, 30, null)
    // coxa servo: case bolted under the deck, horn swings the whole leg
    servoBody(d, `coxasv-${name}`, [ax, ay, hipZ + 4], 'z', servoKey, null, `coxa-${name}`, { flip: true })
    bracketU(d, `coxa-br-${name}`, [ax, ay, hipZ - 2], [30, 20, 34], 4, 'accent', `coxa-${name}`)

    const fy = ay + sy * 12
    joint(d, `femur-${name}`, `Femur ${name.toUpperCase()}`, 'y', [ax, fy, hipZ - 8], -60, 60, `coxa-${name}`)
    servoBody(d, `femursv-${name}`, [ax, fy - sy * 6, hipZ - 8], 'y', servoKey, `coxa-${name}`, `femur-${name}`)
    box(d, `femur-${name}`, [22, 24, femur * 0.62], [ax, fy, hipZ - 8 - femur * 0.31], 'shell', { print: true, joint: `femur-${name}` })
    // tibia servo rides the femur link, shaft at the knee
    const kneeZ = hipZ - 8 - femur * 0.66
    joint(d, `tibia-${name}`, `Tibia ${name.toUpperCase()}`, 'y', [ax, fy, kneeZ], -80, 80, `femur-${name}`)
    servoBody(d, `tibiasv-${name}`, [ax, fy - sy * 5, kneeZ], 'y', servoKey, `femur-${name}`, `tibia-${name}`)
    rbox(d, `tibia-${name}`, [16, 18, tibia * 0.72], [ax, fy, kneeZ - tibia * 0.36], 1.5, 'accent', { print: true, joint: `tibia-${name}` })
    cyl(d, `foot-${name}`, 11, 9, [ax, fy, kneeZ - tibia * 0.78], 'z', 'rubber', { joint: `tibia-${name}` })
  })

  // ── parts: the electrical problem is the BOM ────────────────────────────
  addPart(d, servoKey, 12, '12 joints (3 per leg)')
  addPart(d, 'pca9685', 2, '24 channels of PWM')
  addPart(d, 'buck5a', 2, 'split servo rails')
  // Honour the ENERGY selector: hardcoding the pack meant the control did nothing.
  const packKey = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo3s')
  addPart(d, packKey, packKey === 'pd5v' ? 1 : 1, packKey === 'pd5v' ? 'tethered supply' : 'servo pack')
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

  // The bench matches actuators to joints by label. The quadruped published none,
  // so its torque margins came back empty — which the lift test used to read as
  // "infinitely strong". One row per joint, sized by the same worst-phase need.
  d.actuators = (d.joints || []).map((j) => ({
    label: j.label, need: reqFoot, servo: servoKey, ratio: 1, effective: servo.torque,
  }))

  Object.assign(d.metrics, {
    joints: 12,
    legMm: Math.round(legLen),
    massKg: (printedVolume(d.nodes) / 1000) * mat.density / 1000 + (servo.mass * 12) / 1000 + 0.3,
    peakAmps: peakGait,
    servo: servoKey,
  })
  return d
}
