// ── arm: the canonical robot ────────────────────────────────────────────────
// A serial revolute chain with real proportions and a real torque cascade. The
// servo at each joint is PICKED from the ladder by the load it actually
// carries at full extension — the honesty of the whole app lives in this file.
// Sizing runs BEFORE geometry so every joint gets the servo body it earned.

const ARM_SEG = { w: 46, h: 40 }

function buildArm(brief) {
  const d = newDesign('arm', brief)
  const reach = clamp(brief.reachMm || 450, 180, 1200)
  // The slider stops at 8kg, but the brief does not: a sentence or a build code
  // can ask for 40. Sizing must use what was asked for, or the machine is
  // quietly undersized and the checks pass anyway.
  const askedPayload = Math.max(0.1, Number(brief.payloadKg) || 1)
  const payload = askedPayload
  const dof = clamp(brief.dof || 5, 3, 6)
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000 // g/mm³

  const L1 = reach * 0.42
  const L2 = reach * 0.36
  const L3 = reach * 0.13
  const baseH = 74

  d.title = `${dof}-DoF arm · ${Math.round(reach)}mm reach`
  d.subtitle = `${askedPayload}kg payload · ${mat.name} links`

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
  const pickServo = (need, key, label) => {
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
        return { servo, ratio: 0 }
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

  const svc = (key, fallback) => picks[key] || fallback

  // ── base: flange plate, tower, thrust race, yaw servo inside ────────────
  rbox(d, 'base-plate', [150, 150, 12], [0, 0, 6], 2.5, 'accent', { print: true })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    bolt(d, `base-bolt-${sx}${sy}`, [sx * 66, sy * 66, 12], 'z', 12)
  }
  ring(d, 'base-tower', 46, 38, 54, [0, 0, 39], 'z', 'shell', { print: true })
  // yaw carries the arm's overhung moment — that is a thrust bearing's job
  servoBody(d, 'yaw-servo', [0, 0, 56], 'z', svc('yaw', 'ds3218'), null, 'yaw')
  bearing(d, 'yaw-race', [0, 0, 68], 'z', 30, 17, 9, { joint: 'yaw' })

  joint(d, 'yaw', 'Base yaw', 'z', [0, 0, baseH], -170, 170)

  // ── shoulder bracket + upper arm ────────────────────────────────────────
  rbox(d, 'shoulder-block', [58, ARM_SEG.w, 54], [10, 0, baseH + 20], 2, 'shell', { joint: 'yaw', print: true })
  wedge(d, 'gusset-l', [30, 6, 30], [16, -ARM_SEG.w / 2 + 3, baseH + 24], 'px', 'accent', { joint: 'yaw', print: true })
  wedge(d, 'gusset-r', [30, 6, 30], [16, ARM_SEG.w / 2 - 3, baseH + 24], 'px', 'accent', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 22, ARM_SEG.w + 10, [0, 0, baseH], 'y', 'metal', { joint: 'yaw' })
  servoBody(d, 'shoulder-servo', [0, -ARM_SEG.w / 2 - 5, baseH], 'y', svc('shoulder', 'ds3218'), 'yaw', 'shoulder')
  bearing(d, 'shoulder-race', [0, ARM_SEG.w / 2 + 6, baseH], 'y', 22, 8, 7, { joint: 'yaw' })
  bolt(d, 'shoulder-bolt', [0, ARM_SEG.w / 2 + 13, baseH], 'y', 10, { joint: 'yaw' })

  joint(d, 'shoulder', 'Shoulder pitch', 'y', [0, 0, baseH], -85, 85)

  box(d, 'upper-arm', [L1, ARM_SEG.w, ARM_SEG.h], [L1 / 2, 0, baseH], 'shell', { joint: 'shoulder', print: true })
  for (const sy of [-1, 1]) {
    box(d, `upper-rib-${sy}`, [L1 * 0.86, 4, ARM_SEG.h * 0.42], [L1 / 2, sy * (ARM_SEG.w / 2 + 2), baseH + 2], 'accent', { joint: 'shoulder', print: true })
  }
  cyl(d, 'elbow-hub', 18, ARM_SEG.w + 8, [L1, 0, baseH], 'y', 'metal', { joint: 'shoulder' })
  servoBody(d, 'elbow-servo', [L1, -ARM_SEG.w / 2 - 3, baseH], 'y', svc('elbow', 'mg996r'), 'shoulder', 'elbow')
  bearing(d, 'elbow-race', [L1, ARM_SEG.w / 2 + 5, baseH], 'y', 22, 8, 7, { joint: 'shoulder' })
  bolt(d, 'elbow-bolt', [L1, ARM_SEG.w / 2 + 11, baseH], 'y', 10, { joint: 'shoulder' })

  joint(d, 'elbow', 'Elbow pitch', 'y', [L1, 0, baseH], -140, 140)

  box(d, 'forearm', [L2, ARM_SEG.w - 6, ARM_SEG.h - 4], [L1 + L2 / 2, 0, baseH], 'shell', { joint: 'elbow', print: true })
  for (const sy of [-1, 1]) {
    box(d, `fore-rib-${sy}`, [L2 * 0.84, 4, (ARM_SEG.h - 4) * 0.4], [L1 + L2 / 2, sy * (ARM_SEG.w / 2 - 1), baseH + 1], 'accent', { joint: 'elbow', print: true })
  }

  // ── wrist stack (only the DOF the brief asks for) ───────────────────────
  let tipX = L1 + L2
  let chain = 'elbow'
  const wristX = L1 + L2

  if (dof >= 4) {
    cyl(d, 'wrist-hub', 15, ARM_SEG.w, [wristX, 0, baseH], 'y', 'metal', { joint: chain })
    servoBody(d, 'wrist-servo', [wristX, -ARM_SEG.w / 2 + 2, baseH], 'y', svc('wrist', 'mg90s'), chain, 'wrist-pitch')
    joint(d, 'wrist-pitch', 'Wrist pitch', 'y', [wristX, 0, baseH], -110, 110)
    chain = 'wrist-pitch'
    box(d, 'wrist-link', [L3, 36, 32], [wristX + L3 / 2, 0, baseH], 'shell', { joint: chain, print: true })
    tipX = wristX + L3
  }
  if (dof >= 5) {
    joint(d, 'wrist-roll', 'Wrist roll', 'x', [tipX, 0, baseH], -180, 180)
    chain = 'wrist-roll'
    cyl(d, 'collar', 17, 26, [tipX + 13, 0, baseH], 'x', 'accent', { joint: chain, print: true })
    ring(d, 'roll-race', 11, 4, 5, [tipX + 4, 0, baseH], 'x', 'steel', { joint: chain })
    tipX += 26
  }
  if (dof >= 6) {
    joint(d, 'wrist-yaw', 'Tool yaw', 'z', [tipX, 0, baseH], -90, 90)
    chain = 'wrist-yaw'
    rbox(d, 'tool-flange', [22, 38, 38], [tipX + 11, 0, baseH], 2, 'metal', { joint: chain })
    for (const sy of [-1, 1]) bolt(d, `flange-bolt${sy}`, [tipX + 11, sy * 14, baseH + 19], 'z', 6, { joint: chain })
    tipX += 22
  }

  // ── tool: parallel jaw pair on a micro servo ────────────────────────────
  const jawOpen = 18 + payload * 6
  rbox(d, 'gripper-body', [34, 54, 40], [tipX + 17, 0, baseH], 2.5, 'accent', { joint: chain, print: true })
  servoBody(d, 'tool-servo', [tipX + 17, 0, baseH + 22], 'z', 'mg90s', chain, chain)
  gear(d, 'tool-pinion', 1, 12, 8, [tipX + 44, 0, baseH], 'z', 'steel', { joint: chain })
  for (const s of [-1, 1]) {
    rbox(d, `jaw-${s < 0 ? 'a' : 'b'}`, [26, 7, 34], [tipX + 44, s * (jawOpen / 2 + 4), baseH], 1.5, 'steel', { joint: chain })
    box(d, `pad-${s < 0 ? 'a' : 'b'}`, [22, 3, 26], [tipX + 44, s * (jawOpen / 2 + 1), baseH], 'rubber', { joint: chain })
  }
  tipX += 60

  // ── structure check: the numbers a reviewer asks for ────────────────────
  // Worst link = forearm box-beam as a cantilever under the shoulder moment.
  const t = WALL
  const bSec = ARM_SEG.w - 6
  const hSec = ARM_SEG.h - 4
  const I2 = (bSec * hSec ** 3 - (bSec - 2 * t) * (hSec - 2 * t) ** 3) / 12 // mm⁴
  const I1 = (ARM_SEG.w * ARM_SEG.h ** 3 - (ARM_SEG.w - 2 * t) * (ARM_SEG.h - 2 * t) ** 3) / 12
  const EMpa = mat.elastic * 1000 // GPa → MPa = N/mm²
  const Msh = req.shoulder / SAFETY * 1000 // N·mm actual (no safety factor for stress)
  const sigma = (Msh * (hSec / 2)) / I2 // MPa on the forearm section
  const allow = mat.yield * 0.24 // inter-layer derate — printed parts are not isotropic
  const tipDefl = (Msh * (L1 + L2) ** 2) / (3 * EMpa * I2) + (Msh * L1 * L2) / (2 * EMpa * I1)
  d.mech = [
    { label: 'Link bending stress', value: `${fmt(sigma, 1)} MPa`, limit: `${fmt(allow, 0)} MPa (${mat.name}, layer-derated)`, ok: sigma < allow },
    { label: 'Tip deflection @ payload', value: `${fmt(tipDefl, 1)} mm`, limit: '±2 mm repeatable', ok: tipDefl < 4 },
    { label: 'Shoulder margin', value: `${fmt(((PARTS[picks.shoulder]?.torque || 0) * (d.actuators[1]?.ratio || 1)) / Math.max(req.shoulder, 0.01), 2)}× stall`, limit: `${SAFETY}× design`, ok: null },
  ]
  if (sigma > allow) {
    d.checks.push({ level: 'fail', msg: `Forearm bending stress ${fmt(sigma, 1)} MPa exceeds the printed-layer limit (~${fmt(allow, 0)} MPa ${mat.name}) — stiffer material (PETG-CF), a taller section, or a shorter reach.` })
  } else if (sigma > allow * 0.7) {
    d.checks.push({ level: 'warn', msg: `Links run at ${Math.round((sigma / allow) * 100)}% of printed bending limit — tip deflection ~${fmt(tipDefl, 1)}mm under full payload. Stiffer material buys accuracy here, not torque.` })
  }

  const servoCount = d.joints.length + 1
  addPart(d, 'pca9685', 1, `${servoCount} servo channels`)
  addPart(d, brief.mcu && brief.mcu !== 'esp32s3' ? brief.mcu : 'esp32s3', 1, 'controller')
  addPart(d, 'buck5a', 1, '6V servo rail')
  // Honour the tethered choice: substituting a pack adds a battery the user did
  // not ask for and reports a runtime for a machine that has no runtime.
  const energy = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'pack3s')
  addPart(d, energy, 1, energy === 'pd5v' ? 'USB-C tethered supply' : 'energy')
  addPart(d, 'fuse', 1, 'pack protection')
  addPart(d, 'cap1000', 1, 'servo rail smoothing')
  addPart(d, 'thrust51103', 1, 'yaw axial load')
  addPart(d, 'as5600', 2, 'shoulder + elbow feedback')
  addPart(d, 'hw_m3', 1, 'nuts + washers')
  addPart(d, 'bearing608', 4, 'joint bearings')
  addPart(d, 'wire22', 1, 'signal harness')
  addPart(d, 'wire18', 1, 'servo rail run')
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
    payloadKg: askedPayload,
    massKg: (mUpper + mFore + mWrist + mTool) / 1000,
  }
  return d
}

function MAT_PART(material) {
  return (MATERIALS[material] || MATERIALS.petg).priceId
}
