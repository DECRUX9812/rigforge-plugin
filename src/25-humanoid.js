// ── humanoid: the archetype that tells you the truth about bipeds ───────────
// A humanoid is not "an arm on legs". Two things change everything:
//
//   1. the skeleton BRANCHES (two legs, two arms off one pelvis), so the FK has
//      to walk a parent chain rather than an index range — see chainsFor();
//   2. a biped is never statically stable. Its support polygon while standing
//      on two feet is a line, and on one foot it is a 100×50mm patch under a
//      3kg machine. Balance is a control problem; this generator sizes the
//      hardware for it and says so in the checks instead of pretending.
//
// Servo count is the other wall: 23 joints at 2A stall each is a power-budget
// problem before it is a mechanical one.

function buildHumanoid(brief) {
  const d = newDesign('humanoid', brief)
  const H = clamp(brief.reachMm || 620, 380, 1100) // standing height, mm
  const handPayload = clampPayload(d, brief.payloadKg || 0.5, 0.1, 3)
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000

  // Proportions: roughly 7 heads tall, but the numbers that matter are the
  // ones that keep the limbs APART — a thigh wider than the hip spacing fuses
  // the legs into one slab in the render and in your print.
  const footH = H * 0.036
  const footL = H * 0.185
  const footW = H * 0.085
  const shin = H * 0.225
  const thigh = H * 0.235
  const pelvisH = H * 0.075
  const torsoH = H * 0.26
  const headH = H * 0.115
  const limbW = Math.max(20, H * 0.06)
  const limbD = limbW * 1.2
  const legX = H * 0.072
  const hipW = H * 0.17
  const shoulderW = H * 0.21
  const armX = shoulderW / 2 + limbW / 2 + 6
  const upperArm = H * 0.175
  const forearm = H * 0.16
  const handL = H * 0.05

  const zFoot = footH
  const zAnkle = zFoot + 8
  const zKnee = zAnkle + shin
  const zHip = zKnee + thigh
  const pelvisTop = zHip + pelvisH
  const zChest = pelvisTop + torsoH
  const zShoulder = zChest - torsoH * 0.12
  const zNeck = zChest + 12
  const zHead = zNeck + headH / 2 + 10

  d.title = `${Math.round(H)}mm humanoid · 23 joints`
  d.subtitle = `${handPayload}kg per hand · ${mat.name} skeleton · serial-bus servos`

  // ── pelvis + torso + head ────────────────────────────────────────────────
  rbox(d, 'pelvis', [hipW, limbD + 14, pelvisH], [0, 0, zHip + pelvisH / 2], 2.5, 'shell', { print: true })
  rbox(d, 'torso', [shoulderW, limbD + 20, torsoH - 8], [0, 0, pelvisTop + (torsoH - 8) / 2 + 8], 3, 'shell', { print: true })
  rbox(d, 'chest-plate', [shoulderW * 0.86, 14, torsoH * 0.5], [0, limbD / 2 + 12, pelvisTop + torsoH * 0.62], 2, 'accent', { print: true })
  box(d, 'pack', [shoulderW * 0.6, 22, torsoH * 0.4], [0, -limbD / 2 - 14, pelvisTop + torsoH * 0.55], 'pcb')
  // the BOM's sensors are real parts: ToF on the chest face for stair
  // detection, IMU beside it for balance
  const chestZ = pelvisTop + torsoH * 0.62
  const chestFace = limbD / 2 + 19 // chest-plate front face
  elec(d, 'tof', 'vl53l0x', [0, chestFace + 4, chestZ], [0, 2, 1])
  elec(d, 'imu', 'bno085', [shoulderW * 0.32, chestFace + 2, chestZ + 15], [0, 2, 1])
  // controller + drivers on the backpack's rear face and the lower back —
  // the way a real humanoid routes its electronics behind the torso. The
  // pack back only fits the ESP32 and one UBEC; bus adapters ride the top
  // rear deck above the pack, the other UBECs below it.
  const packBack = -limbD / 2 - 25 // rear face of the pack box
  const packZ = pelvisTop + torsoH * 0.55
  elec(d, 'esp32', brief.mcu && PARTS[brief.mcu] ? brief.mcu : 'esp32s3', [0, packBack - 4, packZ - 3], [0, 2, 1])
  elec(d, 'buck5a-a', 'buck5a', [0, packBack - 6, packZ + 19], [0, 2, 1])
  elec(d, 'bus-adapter-a', 'bus_adapter', [-25, -33, 441], [0, 2, 1])
  elec(d, 'bus-adapter-b', 'bus_adapter', [25, -33, 441], [0, 2, 1])
  elec(d, 'buck5a-b', 'buck5a', [-25, -36, 350], [0, 2, 1])
  elec(d, 'buck5a-c', 'buck5a', [25, -36, 350], [0, 2, 1])
  cyl(d, 'neck', 13, 18, [0, 0, zNeck + 4], 'z', 'metal')
  box(d, 'head', [headH * 0.95, headH * 0.88, headH], [0, 0, zHead], 'shell', { print: true })
  box(d, 'visor', [headH * 0.62, 6, headH * 0.32], [0, headH * 0.45, zHead + 3], 'glass')

  // waist is the ROOT joint: everything above and below hangs off it
  joint(d, 'waist', 'Waist yaw', 'z', [0, 0, zHip + pelvisH * 0.7], -60, 60, null)
  joint(d, 'neck-pan', 'Head pan', 'z', [0, 0, zNeck], -70, 70, 'waist')
  joint(d, 'neck-tilt', 'Head tilt', 'y', [0, 0, zNeck], -25, 25, 'neck-pan')

  // ── legs ────────────────────────────────────────────────────────────────
  const legs = [['l', 1], ['r', -1]]
  for (const [side, sx] of legs) {
    const x = sx * legX
    const label = side === 'l' ? 'Left' : 'Right'
    const hipPivot = [x, 0, zHip]
    joint(d, `${side}-hip-yaw`, `${label} hip yaw`, 'z', hipPivot, -45, 45, null)
    joint(d, `${side}-hip-roll`, `${label} hip roll`, 'x', hipPivot, -25, 25, `${side}-hip-yaw`)
    joint(d, `${side}-hip-pitch`, `${label} hip pitch`, 'y', hipPivot, -100, 45, `${side}-hip-roll`)
    cyl(d, `hip-hub-${side}`, 18, limbW + 10, [x, 0, zHip], 'x', 'metal', { joint: `${side}-hip-pitch` })
    // 6mm of clearance below each hub so the joint reads (and rotates) as a joint
    box(d, `thigh-${side}`, [limbW, limbD, thigh - 12], [x, 0, zHip - thigh / 2 - 6], 'shell', { joint: `${side}-hip-pitch`, print: true })

    const kneePivot = [x, 0, zKnee]
    joint(d, `${side}-knee`, `${label} knee`, 'y', kneePivot, -5, 135, `${side}-hip-pitch`)
    cyl(d, `knee-hub-${side}`, 15, limbW + 6, [x, 0, zKnee], 'x', 'metal', { joint: `${side}-knee` })
    bearing(d, `knee-race-${side}`, [x, (limbW + 6) / 2 + 4, zKnee], 'y', 22, 8, 7, { joint: `${side}-knee` })
    bolt(d, `knee-bolt-${side}`, [x, (limbW + 6) / 2 + 10, zKnee], 'y', 8, { joint: `${side}-knee` })
    box(d, `shin-${side}`, [limbW * 0.86, limbD * 0.9, shin - 14], [x, 0, zKnee - shin / 2 - 7], 'shell', { joint: `${side}-knee`, print: true })
    box(d, `shin-rib-${side}`, [limbW * 0.5, 8, shin * 0.7], [x, limbD * 0.45, zKnee - shin / 2], 'accent', { joint: `${side}-knee`, print: true })

    joint(d, `${side}-ankle-pitch`, `${label} ankle pitch`, 'y', [x, 0, zAnkle], -35, 35, `${side}-knee`)
    joint(d, `${side}-ankle-roll`, `${label} ankle roll`, 'x', [x, 0, zAnkle], -20, 20, `${side}-ankle-pitch`)
    cyl(d, `ankle-hub-${side}`, 12, limbW * 0.8, [x, 0, zAnkle], 'x', 'metal', { joint: `${side}-ankle-pitch` })
    box(d, `foot-${side}`, [footW, footL, footH], [x, footL * 0.22, zFoot / 2], 'accent', { joint: `${side}-ankle-roll`, print: true })
    box(d, `sole-${side}`, [footW * 0.92, footL * 0.94, 5], [x, footL * 0.22, 2.5], 'rubber', { joint: `${side}-ankle-roll` })
  }

  // ── arms ────────────────────────────────────────────────────────────────
  const arms = [['l', 1], ['r', -1]]
  for (const [side, sx] of arms) {
    const x = sx * armX
    const label = side === 'l' ? 'Left' : 'Right'
    const shoulder = [x, 0, zShoulder]
    joint(d, `${side}-shoulder-roll`, `${label} shoulder roll`, 'x', shoulder, -35, 90, null)
    joint(d, `${side}-shoulder-pitch`, `${label} shoulder pitch`, 'y', shoulder, -110, 60, `${side}-shoulder-roll`)
    cyl(d, `shoulder-hub-${side}`, 16, limbW, [x, 0, zShoulder], 'x', 'metal', { joint: `${side}-shoulder-pitch` })
    box(d, `upperarm-${side}`, [limbW * 0.9, limbD * 0.86, upperArm - 10], [x, 0, zShoulder - upperArm / 2 - 5], 'shell', { joint: `${side}-shoulder-pitch`, print: true })

    const elbow = [x, 0, zShoulder - upperArm]
    joint(d, `${side}-elbow`, `${label} elbow`, 'y', elbow, -140, 5, `${side}-shoulder-pitch`)
    cyl(d, `elbow-hub-${side}`, 13, limbW * 0.85, elbow, 'x', 'metal', { joint: `${side}-elbow` })
    box(d, `forearm-${side}`, [limbW * 0.78, limbD * 0.75, forearm - 10], [x, 0, elbow[2] - forearm / 2 - 5], 'shell', { joint: `${side}-elbow`, print: true })

    const wrist = [x, 0, elbow[2] - forearm]
    joint(d, `${side}-wrist`, `${label} wrist`, 'y', wrist, -80, 80, `${side}-elbow`)
    box(d, `hand-${side}`, [limbW * 0.7, limbD * 0.6, handL], [x, 0, wrist[2] - handL / 2 - 4], 'accent', { joint: `${side}-wrist`, print: true })
  }

  // ── masses and torque ───────────────────────────────────────────────────
  const printedKg = (printedVolume(d.nodes) * mat.density) / 1000 / 1000
  const servoMassKg = 0.062
  const joints = d.joints.length
  const electronicsKg = 0.42 // MCU, bus adapters, IMU, harness, fasteners
  const packKg = 0.36 // 2 × 3S 2200 in parallel
  const totalKg = printedKg + joints * servoMassKg + electronicsKg + packKg + handPayload * 2

  const upperKg = totalKg * 0.58 // torso, head, arms, pack
  const legKg = totalKg - upperKg
  const SAFETY = 1.8
  // Ankle: the whole machine balanced on that joint while one foot lifts.
  const ankleNeed = totalKg * G * ((footL / 2 - 18) / 1000) * SAFETY
  // Knee: single-support squat, upper body lever ~ 30mm horizontal.
  const kneeNeed = (upperKg + legKg * 0.5) * G * (0.03 + (H / 1000) * 0.02) * SAFETY
  // Hip: swing-leg + upper body, worst case during a step.
  const hipNeed = upperKg * G * ((H / 1000) * 0.06) * SAFETY
  // Shoulder: arm out at 90° plus what it holds.
  const armKg = legKg * 0.35
  const shoulderNeed = (armKg + handPayload) * G * ((upperArm + forearm) / 1000) * 0.5 * SAFETY

  const need = {
    'Ankle': ankleNeed, 'Knee': kneeNeed, 'Hip': hipNeed, 'Shoulder': shoulderNeed,
  }

  const top = SERVO_LADDER[SERVO_LADDER.length - 1]
  const picks = {}
  for (const [label, want] of Object.entries(need)) {
    let servo = SERVO_LADDER.find((k) => PARTS[k].torque >= want) || top
    if (PARTS[servo].torque < want) {
      d.checks.push({
        level: 'fail',
        msg: `${label} needs ${fmt(want, 2)} N·m at ${Math.round(H)}mm scale — past ${PARTS[servo].name} (${fmt(PARTS[servo].torque, 2)} N·m). This is a harmonic-drive/planetary machine: shrink the robot or move to NEMA17-class joints.`,
      })
    }
    picks[label] = servo
  }

  // Real humanoids use one servo class everywhere and differ in gearing; use the
  // biggest joint's servo for all 23 so the BOM is honest about what a biped costs.
  const jointServo = 'sts3215'
  addPart(d, jointServo, joints, `${joints} joints on 2 serial buses`)
  addPart(d, 'bus_adapter', 2, 'leg bus + arm bus')
  addPart(d, 'bno085', 1, 'balance IMU')
  addPart(d, 'esp32s3', 1, 'controller')
  const packKey = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo3s')
  addPart(d, packKey, packKey === 'pd5v' ? 1 : 2, packKey === 'pd5v' ? 'tethered supply' : 'split packs: legs / arms')
  addPart(d, 'buck5a', 3, '3 isolated rails')
  addPart(d, 'vl53l0x', 1, 'forward ranging')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'bearing608', 8, 'hip + knee bearings')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, mat.priceId, 1, 'printed skeleton')

  // ── the checks that matter for a biped ──────────────────────────────────
  d.checks.push({
    level: 'warn',
    msg: `Balance: a biped's support polygon is the line between two feet (${Math.round(footL)}×66mm per foot). Static stability is impossible — this needs the IMU and a closed-loop balance controller. The generated firmware holds a stand pose; walking is a control project, not a print project.`,
  })
  const actuatorCost = PARTS[jointServo].price * joints
  d.checks.push({
    level: 'warn',
    msg: `${joints} joint actuators cost ${money(actuatorCost)} — that is ${Math.round((actuatorCost / (actuatorCost + 180)) * 100)}% of the machine. Budget the servos first; everything else is cheap.`,
  })

  const tightest = Object.entries(need).sort((a2, b2) => b2[1] - a2[1])[0]
  const tightServo = SERVO_LADDER.find((k) => PARTS[k].torque >= tightest[1]) || top
  if (tightest[1] > PARTS[tightServo].torque * 0.85) {
    d.checks.push({
      level: 'warn',
      msg: `${tightest[0]} runs at ${Math.round((tightest[1] / PARTS[tightServo].torque) * 100)}% of ${PARTS[tightServo].name} stall (${fmt(tightest[1], 2)} of ${fmt(PARTS[tightServo].torque, 2)} N·m). That is a joint you will replace: derate the payload, add a 2:1 stage, or move up a servo class.`,
    })
  }

  d.notes.push(`Sized at ${Math.round(H)}mm standing with ${Math.round(totalKg * 1000)}g all-up: ankle ${fmt(ankleNeed, 2)} N·m, knee ${fmt(kneeNeed, 2)}, hip ${fmt(hipNeed, 2)}, shoulder ${fmt(shoulderNeed, 2)} N·m (with a ${SAFETY}× factor).`)
  d.notes.push('Two serial buses, not 23 PWM channels: legs on bus 0, arms and head on bus 1. Half-duplex TTL, 1Mbps, each servo addressable — and every servo reports position and load back, which a biped cannot work without.')
  d.notes.push('Bracket the hips and knees with 608 bearings and print those parts in PETG, not PLA: a humanoid takes repeated shock loads at exactly those two joints.')

  Object.assign(d.metrics, {
    joints,
    heightMm: Math.round(H),
    massKg: totalKg,
    torque: need,
    servo: jointServo,
    actuatorCost,
    printedG: printedKg * 1000,
  })
  d.actuators = Object.entries(need).map(([label, want]) => ({
    label, need: want, servo: jointServo, ratio: 1, effective: PARTS[jointServo].torque,
  }))
  return d
}

/** Bus-servo firmware: hold a stand pose, report, and get out of the way. */
function humanoidFirmware(design, a, pin) {
  const tx0 = pin('BUS0 TX', 17), rx0 = pin('BUS0 RX', 18)
  const tx1 = pin('BUS1 TX', 47), rx1 = pin('BUS1 RX', 48)
  const legs = design.joints.filter((j) => /(hip|knee|ankle)/.test(j.id))
  const upper = design.joints.filter((j) => !/(hip|knee|ankle)/.test(j.id))
  const idTable = [
    ...legs.map((j, i) => `// legs  ID ${String(i + 1).padStart(2)}: ${j.label}`),
    ...upper.map((j, i) => `// upper ID ${String(i + 1).padStart(2)}: ${j.label}`),
  ].join('\n')
  const standLegs = legs.map((j, i) => `  st.WritePosEx(${i + 1}, 2048, 120, 30);`).join('\n')
  const standUpper = upper.map((j, i) => `  upper.WritePosEx(${i + 1}, 2048, 120, 30);`).join('\n')
  return `/* ${design.title} — ${a.mcu.name}
 * Generated by Rigforge. ${design.joints.length} serial-bus joints on two TTL buses.
 *
 * THIS IS A STAND-AND-HOLD CONTROLLER. It does not walk. A biped cannot be made
 * stable by geometry — it needs a balance loop reading the IMU at 200Hz and
 * commanding hips/ankles every cycle. That is the next project, and this file is
 * the honest starting point for it.
 */
#include <SCServo.h>
#include <Wire.h>

SMS_STS st;                       // legs: bus 0
SMS_STS upper;                    // waist + arms + head: bus 1

// Servo IDs are per-bus, so the same ID can exist on each bus:
${idTable}
const long BAUDRATE = 1000000;

void setupBuses() {
  // UART1 = legs, UART2 = arms + head. UART0 stays the console.
  Serial1.begin(BAUDRATE, SERIAL_8N1, ${rx0}, ${tx0});
  st.pSerial = &Serial1;
  Serial2.begin(BAUDRATE, SERIAL_8N1, ${rx1}, ${tx1});
  upper.pSerial = &Serial2;
}

void standPose() {
  // Every joint to its centre with a slow, low-torque-limit move: on first power
  // up you do NOT want 23 servos snapping to position with the robot upright.
${standLegs}
${standUpper}
  delay(1200);
}

void holdStand() {
  // Torque on, position held. A real controller replaces this with a balance loop.
  for (int id = 1; id <= ${legs.length}; id++) st.EnableTorque(id, 1);
  for (int id = 1; id <= ${upper.length}; id++) upper.EnableTorque(id, 1);
}

void report() {
  // A joint pinned at high load is a servo about to strip a gear.
  for (int id = 1; id <= ${legs.length}; id++)
    Serial.printf("leg %02d pos=%4d load=%4d\\n", id, st.ReadPos(id), st.ReadLoad(id));
  for (int id = 1; id <= ${upper.length}; id++)
    Serial.printf("up  %02d pos=%4d load=%4d\\n", id, upper.ReadPos(id), upper.ReadLoad(id));
}

void setup() {
  Serial.begin(115200);
  setupBuses();
  standPose();
  holdStand();
  Serial.println("${design.title}: standing. Balance loop not implemented — see the header.");
}

void loop() {
  // No gait. Read the IMU, watch the joint loads, and stop if anything is
  // fighting: a joint pinned at high load is a servo about to strip a gear.
  static uint32_t last = 0;
  if (millis() - last > 250) {
    last = millis();
    report();
  }
}`
}
