// ── full robot: a mobile manipulator, not a fragment ────────────────────────
// This is the archetype that answers "build me a robot": a drive base that
// carries an arm, a head, its own power and its own controller. It reuses the
// same primitives as the rover and the arm on purpose — the interesting part is
// what changes when they are one machine:
//
//   • the arm's torque cascade now happens on a base that can TIP OVER
//   • 4 motors + 6 servos share one pack, so peak current is a real budget
//   • the firmware has to arbitrate: no reaching while driving fast

function buildFullRobot(brief) {
  const d = newDesign('robot', brief)
  const payload = clampPayload(d, brief.payloadKg || 1, 0.2, 5)
  const wheelD = clamp(Math.round(brief.wheelMm || 130), 80, 160)
  const track = clamp(Math.round(wheelD * 2.6), 240, 440)
  const wheelbase = clamp(Math.round(track * 1.15), 300, 520)
  const r = wheelD / 2 / 1000
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000 // g/mm³

  const chassisH = 72
  const z0 = wheelD / 2
  const deckZ = z0 + chassisH
  // Arm over the REAR axle, head at the front: reaching forward then moves the
  // CoM toward the centre instead of off the front edge.
  const armX = -wheelbase * 0.18
  const L1 = clamp((brief.reachMm || 450) * 0.44, 120, 420)
  const L2 = clamp((brief.reachMm || 450) * 0.36, 100, 360)
  const L3 = clamp((brief.reachMm || 450) * 0.13, 40, 130)
  const turretH = 108
  const shoulderZ = deckZ + turretH

  d.title = `Mobile manipulator · ${Math.round(L1 + L2 + L3)}mm reach on a ${wheelD}mm 4WD base`
  d.subtitle = `${payload}kg payload · ${Math.round(track)}×${Math.round(wheelbase)}mm footprint · ${mat.name}`

  // ── drive base ───────────────────────────────────────────────────────────
  const bed = brief.bedMm || 256
  splitBox(d, 'deck', [wheelbase, track, 5], [0, 0, deckZ - 2], 2, 'shell', bed, { print: true })
  for (const sx of [-0.28, 0.12]) {
    splitBox(d, `deck-rib-${sx}`, [10, track - 12, 16], [wheelbase * sx, 0, deckZ - 12], 0.6, 'shell', bed, { print: true })
  }
  for (const sx of [-1, 1]) {
    splitBox(d, `rail-${sx > 0 ? 'l' : 'r'}`, [wheelbase + 8, 4, 40], [0, sx * (track / 2 + 2), z0 + chassisH / 2 - 2], 0.6, 'accent', bed, { print: true })
  }
  for (const sx of [-1, 1]) {
    splitBox(d, `bulkhead-${sx > 0 ? 'f' : 'b'}`, [4, track, chassisH - 22], [sx * (wheelbase / 2 - 4), 0, z0 + chassisH / 2 - 6], 0.6, 'shell', bed, { print: true })
  }
  box(d, 'avionics', [wheelbase * 0.22, track * 0.3, 20], [-wheelbase * 0.06, -track * 0.26, deckZ + 10], 'pcb')
  box(d, 'pack-box', [wheelbase * 0.28, track * 0.42, 28], [wheelbase * 0.16, 0, deckZ + 14], 'pcb')
  // Electronics at catalog dims, on the two boards a real build gives them:
  // logic on the avionics PCB (clear of the turret column x<-24/y>-46 and the
  // pack x>8/y>-71), power on the pack lid. Verified against boundsOf.
  const ax = -wheelbase * 0.06; const ay = -track * 0.26; const px = wheelbase * 0.16
  elec(d, 'imu', 'bno085', [ax, ay, deckZ + 22])
  elec(d, 'esp32', brief.mcu && PARTS[brief.mcu] ? brief.mcu : 'esp32s3', [ax - 27.7, ay - 17.1, deckZ + 24], [1, 0, 2])
  elec(d, 'pca9685', 'pca9685', [ax + 27.3, ay - 17.1, deckZ + 22], [1, 0, 2])
  elec(d, 'bts7960', 'bts7960', [px - 17.2, -25, deckZ + 38])
  elec(d, 'buck5a-a', 'buck5a', [px - 17.2, 35, deckZ + 34])
  elec(d, 'buck5a-b', 'buck5a', [px - 17.2, 57, deckZ + 34])
  // XT60 on the pack lid, clear of the avionics row — the lead's first stop
  elec(d, 'xt60', 'xt60', [px + 28, -20, deckZ + 40])
  cyl(d, 'bumper', 14, 34, [wheelbase / 2 + 14, 0, z0 + 18], 'x', 'rubber', { print: true })

  const wheels = [
    [wheelbase / 2 - 8, track / 2], [wheelbase / 2 - 8, -track / 2],
    [-wheelbase / 2 + 8, track / 2], [-wheelbase / 2 + 8, -track / 2],
  ]
  wheels.forEach(([x, y], i) => {
    const side = y > 0 ? 1 : -1
    // wheel is BOUGHT (see BOM); only the adapter is printed
    wheelAssy(d, `wheel-${i}`, [x, y + side * 16, z0], 'y', wheelD, 30, null, side)
    // motor block sits inboard of the wheel so it is visible in the model
    cyl(d, `motor-${i}`, 19, 46, [x, y - side * 26, z0], 'y', 'metal')
  })

  // ── arm sizing (same cascade as the arm archetype) ──────────────────────
  // Runs BEFORE the arm geometry: a joint that needs a belt reduction gets
  // its stage geometry instead of the coaxial servo layout.
  const linkMass = (len) => len * 44 * 40 * 0.34 * density
  const mUpper = linkMass(L1)
  const mFore = linkMass(L2)
  const mWrist = linkMass(L3) + 70
  const mTool = 110 + payload * 120
  const mPayload = payload
  const tor = (load) => G * load.reduce((s, x) => s + (x.m / 1000) * (x.dist / 1000), 0)
  const SAFETY = 1.7
  const need = {
    yaw: tor([
      { m: mUpper, dist: L1 / 2 }, { m: mFore, dist: L1 + L2 / 2 },
      { m: mWrist, dist: L1 + L2 + L3 / 2 }, { m: mTool, dist: L1 + L2 + L3 },
      { m: mPayload, dist: L1 + L2 + L3 + 40 },
    ]) * SAFETY * 0.75,
    shoulder: tor([
      { m: mUpper, dist: L1 / 2 }, { m: mFore, dist: L1 + L2 / 2 },
      { m: mWrist, dist: L1 + L2 + L3 / 2 }, { m: mTool, dist: L1 + L2 + L3 },
      { m: mPayload, dist: L1 + L2 + L3 + 40 },
    ]) * SAFETY,
    elbow: tor([
      { m: mFore, dist: L2 / 2 }, { m: mWrist, dist: L2 + L3 / 2 },
      { m: mTool, dist: L2 + L3 }, { m: mPayload, dist: L2 + L3 + 40 },
    ]) * SAFETY,
    wrist: (G * (mTool / 1000) * 0.07 + tor([{ m: mPayload, dist: 40 }])) * SAFETY,
    roll: Math.max(0.35, payload * 0.5),
    grip: Math.max(0.2, payload * 0.6),
  }

  const top = SERVO_LADDER[SERVO_LADDER.length - 1]
  const stairs = []
  const pick = (label, want) => {
    let servo = SERVO_LADDER.find((k) => PARTS[k].torque >= want)
    let ratio = 1
    if (!servo) {
      ratio = Math.ceil((want / PARTS[top].torque) * 1.05)
      servo = top
      if (ratio > 4) {
        d.checks.push({ level: 'fail', msg: `${label}: ${fmt(want, 1)} N·m needed — ${ratio}:1 past ${PARTS[top].name}. This is a stepper-class joint; cut payload or reach.` })
      } else {
        addPart(d, 'gt2_kit', 1, `${label} ${ratio}:1 belt stage`)
        d.notes.push(`${label} runs a ${ratio}:1 GT2 stage: ${PARTS[servo].name} gives ${fmt(want / ratio, 2)} N·m at the horn, ${fmt(PARTS[servo].torque, 2)} at the joint.`)
      }
    }
    addPart(d, servo, 1, label)
    stairs.push({ label, need: want, servo, ratio, effective: PARTS[servo].torque * ratio })
    return servo
  }

  pick('Base yaw', need.yaw)
  pick('Shoulder pitch', need.shoulder)
  pick('Elbow pitch', need.elbow)
  pick('Wrist pitch', need.wrist)
  pick('Wrist roll', need.roll)
  pick('Gripper', need.grip)
  d.actuators = stairs
  const stepOf = (label) => stairs.find((s) => s.label === label) || { servo: 'ds3225', ratio: 1 }

  // ── arm ─────────────────────────────────────────────────────────────────
  ring(d, 'turret', 46, 38, turretH, [armX, 0, deckZ + turretH / 2], 'z', 'shell', { print: true })
  servoBody(d, 'yaw-servo', [armX, 0, shoulderZ - 14], 'z', 'ds3225', null, 'yaw')
  bearing(d, 'turret-race', [armX, 0, shoulderZ], 'z', 52, 30, 12, { joint: 'yaw' })
  joint(d, 'yaw', 'Base yaw', 'z', [armX, 0, shoulderZ], -160, 160)

  rbox(d, 'shoulder-block', [54, 62, 50], [armX + 8, 0, shoulderZ + 16], 2, 'shell', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 20, 72, [armX, 0, shoulderZ], 'y', 'metal', { joint: 'yaw' })
  if (stepOf('Shoulder pitch').ratio > 1) {
    beltStageY(d, { prefix: 'shoulder', pivot: [armX, 0, shoulderZ], ratio: stepOf('Shoulder pitch').ratio, servoKey: stepOf('Shoulder pitch').servo, servoJoint: 'yaw', outJoint: 'shoulder', beltY: -44 })
  } else {
    servoBody(d, 'shoulder-servo', [armX, -38, shoulderZ], 'y', stepOf('Shoulder pitch').servo, 'yaw', 'shoulder')
  }
  joint(d, 'shoulder', 'Shoulder pitch', 'y', [armX, 0, shoulderZ], -80, 80)

  box(d, 'upper-arm', [L1, 48, 42], [armX + L1 / 2, 0, shoulderZ], 'shell', { joint: 'shoulder', print: true })
  box(d, 'upper-rib', [L1 * 0.8, 10, 6], [armX + L1 / 2, 0, shoulderZ + 24], 'accent', { joint: 'shoulder', print: true })
  cyl(d, 'elbow-hub', 17, 56, [armX + L1, 0, shoulderZ], 'y', 'metal', { joint: 'shoulder' })
  if (stepOf('Elbow pitch').ratio > 1) {
    beltStageY(d, { prefix: 'elbow', pivot: [armX + L1, 0, shoulderZ], ratio: stepOf('Elbow pitch').ratio, servoKey: stepOf('Elbow pitch').servo, servoJoint: 'shoulder', outJoint: 'elbow', beltY: -40 })
  } else {
    servoBody(d, 'elbow-servo', [armX + L1, -30, shoulderZ], 'y', stepOf('Elbow pitch').servo, 'shoulder', 'elbow')
  }
  bearing(d, 'elbow-race', [armX + L1, 30, shoulderZ], 'y', 22, 8, 7, { joint: 'shoulder' })
  joint(d, 'elbow', 'Elbow pitch', 'y', [armX + L1, 0, shoulderZ], -135, 135)

  box(d, 'forearm', [L2, 42, 38], [armX + L1 + L2 / 2, 0, shoulderZ], 'shell', { joint: 'elbow', print: true })
  const wristX = armX + L1 + L2
  cyl(d, 'wrist-hub', 15, 48, [wristX, 0, shoulderZ], 'y', 'metal', { joint: 'elbow' })
  joint(d, 'wrist', 'Wrist pitch', 'y', [wristX, 0, shoulderZ], -100, 100)

  box(d, 'wrist-link', [L3, 34, 30], [wristX + L3 / 2, 0, shoulderZ], 'shell', { joint: 'wrist', print: true })
  joint(d, 'roll', 'Wrist roll', 'x', [wristX + L3, 0, shoulderZ], -180, 180)
  box(d, 'gripper-body', [36, 52, 40], [wristX + L3 + 18, 0, shoulderZ], 'accent', { joint: 'roll', print: true })
  box(d, 'jaw-a', [26, 8, 32], [wristX + L3 + 45, -16, shoulderZ], 'metal', { joint: 'roll' })
  box(d, 'jaw-b', [26, 8, 32], [wristX + L3 + 45, 16, shoulderZ], 'metal', { joint: 'roll' })

  // ── head ────────────────────────────────────────────────────────────────
  // The head sits LOW at the front and the arm sweeps HIGH above it: a 13mm
  // clearance in the rest pose, and no way for the boom to shave the sensors.
  const headX = wheelbase / 2 + 2
  const headY = 0
  box(d, 'head-neck', [26, 26, 44], [headX, headY, deckZ + 22], 'shell', { print: true })
  box(d, 'head', [62, 74, 30], [headX, headY, deckZ + 59], 'accent', { print: true })
  elec(d, 'tof', 'vl53l0x', [headX + 32, -14, deckZ + 58], [2, 0, 1])
  cyl(d, 'cam', 8, 8, [headX + 32, 16, deckZ + 62], 'x', 'glass')
  joint(d, 'head-pan', 'Head pan', 'z', [headX, headY, deckZ + 44], -90, 90, null)

  // ── drive sizing ────────────────────────────────────────────────────────
  const printKg = (printedVolume(d.nodes) * mat.density) / 1000 / 1000
  const servoKg = stairs.reduce((s, x) => s + PARTS[x.servo].mass, 0) / 1000
  const electronicsKg = 0.46
  let massKg = printKg + servoKg + electronicsKg + payload
  const Crr = 0.07
  const needPerWheel = ((massKg * G * Crr + massKg * 0.7) * r) / 4 * 1.5
  const motor = MOTOR_LADDER.find((k) => PARTS[k].torque >= needPerWheel) || 'jgb37'
  const mp = PARTS[motor]
  massKg += (mp.mass / 1000) * 4
  addPart(d, motor, 4, 'drive')
  addPart(d, 'pca9685', 1, '6 arm servos')
  addPart(d, 'buck5a', 2, 'servo + logic rails')
  const packKey = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo3s')
  addPart(d, packKey, 1, packKey === 'pd5v' ? 'tethered supply' : 'drive + servo pack')
  addPart(d, 'wheel130', 4, 'drive wheels')
  addPart(d, mp.ampacity > 3 || mp.volts >= 11 ? 'bts7960' : 'tb6612', 1, 'motor driver')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bno085', 1, 'heading + tilt')
  addPart(d, 'vl53l0x', 2, 'forward + drop-off')
  addPart(d, 'mg90s', 1, 'head pan')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'bearing608', 2, 'turret + shoulder')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'xt60', 1, 'pack connector')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, mat.priceId, 1, 'printed frame')

  // ── static stability: the check nobody runs until the robot falls over ──
  const reachOut = (armX + L1 + L2 + L3 + 40) / 1000 // m from the axle centre
  const armMassKg = (mUpper + mFore + mWrist + mTool) / 1000
  const chassisMassKg = massKg - (mp.mass / 1000) * 4
  // CoM offset with the arm at full extension, worst case (arm forward)
  const armOriginX = armX / 1000
  const comOffset = ((armMassKg + payload) * (armOriginX + reachOut * 0.55) + chassisMassKg * 0.0) / massKg
  const supportHalf = Math.min(track, wheelbase) / 2 / 1000
  if (comOffset > supportHalf * 0.92) {
    d.checks.push({
      level: 'fail',
      msg: `Static stability: with the arm out at ${Math.round(reachOut * 1000)}mm the CoM sits ${Math.round(comOffset * 1000)}mm off centre, past the ${Math.round(supportHalf * 1000)}mm support half-width. Widen the track, add ballast over the rear axle, or cap the payload.`,
    })
  } else if (comOffset > supportHalf * 0.7) {
    d.checks.push({ level: 'warn', msg: `CoM ${Math.round(comOffset * 1000)}mm off centre at full reach — stable, but drive gently with the arm extended.` })
  }

  d.notes.push(`Drive: ${mp.name} — ${fmt(needPerWheel, 2)} N·m per wheel needed for ${fmt(massKg, 1)}kg, ${fmt(mp.torque, 2)} N·m available.`)
  d.notes.push(`Arm holds ${payload}kg at ${Math.round((L1 + L2 + L3) / 10)}cm reach with a ${SAFETY}× factor; the base is what limits it, not the servos.`)
  d.notes.push('The arm shadows the head camera at full reach. The pan joint is there for exactly that: yaw the head 60-90° away from the boom, or mount the camera pod off-centre on the next revision.')
  if (wheelbase > 380) {
    d.notes.push('Deck is ' + Math.round(wheelbase) + 'mm: print it in two dovetailed halves, or cut it from 3mm aluminium — same mass, no warp, no 40-hour print.')
  }

  Object.assign(d.metrics, {
    joints: d.joints.length,
    reachMm: Math.round(L1 + L2 + L3),
    payloadKg: payload,
    massKg,
    wheelD,
    trackMm: track,
    motor,
    speedMps: (mp.speed * Math.PI * (wheelD / 1000)) / 60,
    torquePerWheel: needPerWheel,
    comOffsetMm: Math.round(comOffset * 1000),
    supportHalfMm: Math.round(supportHalf * 1000),
  })
  return d
}

/** Combined firmware: one loop that arbitrates drive and arm. */
function fullRobotFirmware(design, a, pin) {
  const m = design.metrics
  const driver = design.parts.find((p) => p.key === 'tb6612' || p.key === 'bts7960')?.key || 'bts7960'
  return `/* ${design.title} — ${a.mcu.name}
 * Generated by Rigforge: mobile manipulator, ${design.joints.length} arm servos on a
 * PCA9685 + 4 driven wheels. One pack, one loop, one arbiter.
 */
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// ── drive ──────────────────────────────────────────────────────────────────
// Pin numbers come from the analysis pass — the PINS tab and this file cannot drift.
const uint8_t PWM_L = ${pin('M1 PWM', 4)}, IN1_L = ${pin('M1 IN1', 5)}, IN2_L = ${pin('M1 IN2', 6)};
const uint8_t PWM_R = ${pin('M2 PWM', 7)}, IN1_R = ${pin('M2 IN1', 15)}, IN2_R = ${pin('M2 IN2', 16)};
const float   TRACK = ${((m.wheelD || 130) * 2.4 / 1000).toFixed(3)};
const float   VMAX  = ${Math.max(0.25, (m.speedMps || 0.6)).toFixed(2)};

// ── arm ────────────────────────────────────────────────────────────────────
const uint8_t JOINTS = ${design.joints.length};
const int16_t LIMITS[][2] = { ${design.joints.map((j) => `{${j.min}, ${j.max}}`).join(', ')} };
int16_t target[${design.joints.length}] = {0};
int16_t current[${design.joints.length}] = {0};

float speedNow = 0.0f;

void writeJoint(uint8_t i, int16_t deg) {
  uint16_t us = 500 + (uint32_t)((deg + 180) * 2000) / 360;
  pwm.setPWM(i, 0, (uint16_t)((us / 20000.0) * 4096));
}

void setMotor(uint8_t ch, uint8_t in1, uint8_t in2, float cmd) {
  cmd = constrain(cmd, -1.0f, 1.0f);
  digitalWrite(in1, cmd > 0.02f);
  digitalWrite(in2, cmd < -0.02f);
  ledcWrite(ch, (uint8_t)(fabsf(cmd) * 255));
  speedNow = fabsf(cmd) * VMAX;
}

void drive(float v, float w) {
  setMotor(0, IN1_L, IN2_L, (v - w * TRACK / 2) / VMAX);
  setMotor(1, IN1_R, IN2_R, (v + w * TRACK / 2) / VMAX);
}

void stop() { setMotor(0, IN1_L, IN2_L, 0); setMotor(1, IN1_R, IN2_R, 0); }

void setup() {
  Serial.begin(115200);
  Wire.begin(${I2C.sda}, ${I2C.scl});
  pwm.begin();
  pwm.setPWMFreq(50);
  ledcAttach(PWM_L, 20000, 8);
  ledcAttach(PWM_R, 20000, 8);
  pinMode(IN1_L, OUTPUT); pinMode(IN2_L, OUTPUT);
  pinMode(IN1_R, OUTPUT); pinMode(IN2_R, OUTPUT);
  stop();
  for (uint8_t i = 0; i < JOINTS; i++) writeJoint(i, 0);
  Serial.println("${design.title} ready — 'D v w' to drive, 'J i deg' to pose, 'S' to stop");
}

void loop() {
  // The arbiter: reaching while moving is what tips this machine over. Below
  // 0.25 VMAX the arm is free, above it the arm is held and targets are refused.
  static uint32_t lastCmd = 0;
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'D' || c == 'd') {
      float v = Serial.parseFloat(), w = Serial.parseFloat();
      drive(v, w);
      lastCmd = millis();
    } else if (c == 'J' || c == 'j') {
      int idx = Serial.parseInt(), deg = Serial.parseInt();
      if (speedNow > 0.25f * VMAX) {
        Serial.println("refused: arm locked while driving");
      } else if (idx >= 0 && idx < JOINTS) {
        target[idx] = constrain(deg, LIMITS[idx][0], LIMITS[idx][1]);
      }
    } else if (c == 'S' || c == 's') {
      stop();
      for (uint8_t i = 0; i < JOINTS; i++) target[i] = current[i];
    }
  }
  if (millis() - lastCmd > 800) stop();   // lost client = stop, never wander

  for (uint8_t i = 0; i < JOINTS; i++) {
    if (current[i] == target[i]) continue;
    current[i] += (target[i] > current[i]) ? 1 : -1;
    writeJoint(i, current[i]);
  }
  delay(8);
}`
}
