// ── arm: the canonical robot ────────────────────────────────────────────────
// A serial revolute chain with real proportions and a real torque cascade. The
// servo at each joint is PICKED from the ladder by the load it actually
// carries at full extension — the honesty of the whole app lives in this file.

const ARM_SEG = { w: 46, h: 40 }

function buildArm(brief) {
  const d = newDesign('arm', brief)
  const reach = clamp(brief.reachMm || 450, 180, 1200)
  const payload = clamp(brief.payloadKg || 1, 0.1, 8)
  const dof = clamp(brief.dof || 5, 3, 6)
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000 // g/mm³

  const L1 = reach * 0.42
  const L2 = reach * 0.36
  const L3 = reach * 0.13
  const baseH = 74

  d.title = `${dof}-DoF arm · ${Math.round(reach)}mm reach`
  d.subtitle = `${payload}kg payload · ${mat.name} links`

  // ── base ────────────────────────────────────────────────────────────────
  box(d, 'base-plate', [150, 150, 14], [0, 0, 7], 'accent', { print: true, part: 'plate' })
  cyl(d, 'base-tower', 46, 54, [0, 0, 41], 'z', 'shell', { print: true })
  cyl(d, 'base-bearing', 24, 12, [0, 0, 68], 'z', 'metal', { part: 'bearing608' })

  joint(d, 'yaw', 'Base yaw', 'z', [0, 0, baseH], -170, 170)

  // ── shoulder bracket + upper arm ────────────────────────────────────────
  box(d, 'shoulder-block', [58, ARM_SEG.w, 54], [10, 0, baseH + 20], 'shell', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 22, ARM_SEG.w + 10, [0, 0, baseH], 'y', 'metal', { joint: 'yaw', part: 'bearing608' })

  joint(d, 'shoulder', 'Shoulder pitch', 'y', [0, 0, baseH], -85, 85)

  box(d, 'upper-arm', [L1, ARM_SEG.w, ARM_SEG.h], [L1 / 2, 0, baseH], 'shell', { joint: 'shoulder', print: true })
  cyl(d, 'elbow-hub', 18, ARM_SEG.w + 8, [L1, 0, baseH], 'y', 'metal', { joint: 'shoulder' })

  joint(d, 'elbow', 'Elbow pitch', 'y', [L1, 0, baseH], -140, 140)

  box(d, 'forearm', [L2, ARM_SEG.w - 6, ARM_SEG.h - 4], [L1 + L2 / 2, 0, baseH], 'shell', { joint: 'elbow', print: true })

  // ── wrist stack (only the DOF the brief asks for) ───────────────────────
  let tipX = L1 + L2
  let chain = 'elbow'
  const wristX = L1 + L2

  if (dof >= 4) {
    cyl(d, 'wrist-hub', 15, ARM_SEG.w, [wristX, 0, baseH], 'y', 'metal', { joint: chain })
    joint(d, 'wrist-pitch', 'Wrist pitch', 'y', [wristX, 0, baseH], -110, 110)
    chain = 'wrist-pitch'
    box(d, 'wrist-link', [L3, 36, 32], [wristX + L3 / 2, 0, baseH], 'shell', { joint: chain, print: true })
    tipX = wristX + L3
  }
  if (dof >= 5) {
    joint(d, 'wrist-roll', 'Wrist roll', 'x', [tipX, 0, baseH], -180, 180)
    chain = 'wrist-roll'
    cyl(d, 'collar', 17, 26, [tipX + 13, 0, baseH], 'x', 'accent', { joint: chain, print: true })
    tipX += 26
  }
  if (dof >= 6) {
    joint(d, 'wrist-yaw', 'Tool yaw', 'z', [tipX, 0, baseH], -90, 90)
    chain = 'wrist-yaw'
    box(d, 'tool-flange', [22, 38, 38], [tipX + 11, 0, baseH], 'metal', { joint: chain })
    tipX += 22
  }

  // ── tool: parallel gripper ──────────────────────────────────────────────
  const jawOpen = 18 + payload * 6
  box(d, 'gripper-body', [34, 54, 40], [tipX + 17, 0, baseH], 'accent', { joint: chain, print: true })
  box(d, 'jaw-a', [26, 8, 34], [tipX + 44, -(jawOpen / 2 + 4), baseH], 'metal', { joint: chain })
  box(d, 'jaw-b', [26, 8, 34], [tipX + 44, jawOpen / 2 + 4, baseH], 'metal', { joint: chain })
  tipX += 60

  // ── mass + torque cascade ───────────────────────────────────────────────
  const linkMass = (len) => (len * ARM_SEG.w * ARM_SEG.h * 0.34 * density) // shelled, ~34% solid
  const mUpper = linkMass(L1)
  const mFore = linkMass(L2)
  const mWrist = linkMass(dof >= 4 ? L3 : 0) + 60 // hub + servo hardware
  const mTool = 90 + payload * 1000 * 0.12 // gripper + gripped inertia
  const mPayload = payload

  const at = (m, dist) => ({ m, dist })
  // Shoulder sees the whole arm at full extension; elbow sees everything past it.
  const shoulderLoad = [
    at(mUpper, L1 / 2),
    at(mFore, L1 + L2 / 2),
    at(mWrist, L1 + L2 + L3 / 2),
    at(mTool, L1 + L2 + L3),
    at(mPayload, L1 + L2 + L3 + 40),
  ]
  const elbowLoad = [
    at(mFore, L2 / 2),
    at(mWrist, L2 + L3 / 2),
    at(mTool, L2 + L3),
    at(mPayload, L2 + L3 + 40),
  ]

  const torqueOf = (load) => (G * load.reduce((s, x) => s + (x.m / 1000) * (x.dist / 1000), 0))
  const SAFETY = 1.7
  const req = {
    shoulder: torqueOf(shoulderLoad) * SAFETY,
    elbow: torqueOf(elbowLoad) * SAFETY,
    wrist: (G * (mTool / 1000) * (60 / 1000) + torqueOf([at(mPayload, 40)])) * SAFETY,
    yaw: torqueOf(elbowLoad) * SAFETY * 0.7,
  }

  const picks = {}
  const pickServo = (need, key, label, reduction) => {
    const top = SERVO_LADDER[SERVO_LADDER.length - 1]
    let servo = SERVO_LADDER.find((k) => PARTS[k].torque >= need)
    let ratio = 1
    if (!servo) {
      // Real builds answer an over-torqued joint with a belt reduction before
      // they reach for a bigger servo — so do that, up to a 4:1 GT2 stage.
      ratio = Math.ceil((need / PARTS[top].torque) * 1.05)
      servo = top
      if (ratio > 4) {
        picks[key] = servo
        d.checks.push({
          level: 'fail',
          msg: `${label}: needs ${fmt(need, 1)} N·m at full extension — that is ${ratio}:1 beyond ${PARTS[top].name}. This is a stepper/harmonic-drive machine: use NEMA17 + 5:1 or cut reach/payload.`,
        })
        addPart(d, servo, 1, label)
        return { servo, ratio }
      }
      addPart(d, 'gt2_kit', 1, `${label} ${ratio}:1 belt reduction`)
      d.notes.push(`${label} uses a ${ratio}:1 GT2 belt stage — ${PARTS[servo].name} alone gives ${fmt(PARTS[servo].torque, 2)} N·m, ${fmt(PARTS[servo].torque * ratio, 2)} N·m at the joint.`)
    }
    picks[key] = servo
    addPart(d, servo, 1, label)
    return { servo, ratio }
  }

  d.actuators = []
  const sized = (label, need, key) => {
    const pick = pickServo(need, key, label)
    d.actuators.push({ label, need, servo: pick.servo, ratio: pick.ratio, effective: PARTS[pick.servo].torque * pick.ratio })
    return pick.servo
  }
  sized('Base yaw', req.yaw, 'yaw')
  sized('Shoulder pitch', req.shoulder, 'shoulder')
  sized('Elbow pitch', req.elbow, 'elbow')
  if (dof >= 4) sized('Wrist pitch', req.wrist, 'wrist')
  if (dof >= 5) sized('Wrist roll', Math.max(0.35, req.wrist * 0.55), 'roll')
  if (dof >= 6) sized('Tool yaw', Math.max(0.3, req.wrist * 0.4), 'tool')
  sized('Gripper', Math.max(0.15, payload * 0.6), 'grip')

  const servoCount = d.joints.length + 1
  addPart(d, 'pca9685', 1, `${servoCount} servo channels`)
  addPart(d, brief.mcu && brief.mcu !== 'esp32s3' ? brief.mcu : 'esp32s3', 1, 'controller')
  addPart(d, 'buck5a', 1, '6V servo rail')
  addPart(d, brief.battery && brief.battery !== 'pd5v' ? brief.battery : 'pack3s', 1, 'energy')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'bearing608', 4, 'joint bearings')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, MAT_PART(brief.material), 1, 'printed links')

  if (servoCount > 8) addPart(d, 'pca9685', 1, 'second servo bank')

  d.notes.push(`Servo sizing at full extension with a ${SAFETY}× safety factor: ` +
    `shoulder needs ${fmt(req.shoulder, 2)} N·m → ${PARTS[picks.shoulder].name}, ` +
    `elbow ${fmt(req.elbow, 2)} N·m → ${PARTS[picks.elbow].name}.`)
  if (picks.elbow === picks.shoulder && servoCount > 4) {
    d.notes.push('Same servo at shoulder and elbow — buy 6, the spares are the spare parts bin.')
  }
  d.metrics = {
    joints: servoCount,
    reachMm: Math.round(tipX),
    payloadKg: payload,
    massKg: (mUpper + mFore + mWrist + mTool) / 1000,
  }
  return d
}

function MAT_PART(material) {
  return (MATERIALS[material] || MATERIALS.petg).priceId
}
