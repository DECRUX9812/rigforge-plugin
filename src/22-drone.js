// ── drone: disk loading, thrust and hover time ──────────────────────────────
// A quadcopter is not a robot with wheels: every gram is either thrust margin or
// flight time, and the two trade against each other. The geometry here is the
// easy part (four arms, four motors, four props). The interesting part is the
// arithmetic in droneReport(): how much lift four discs of this size actually
// make, at what throttle it hovers, and how many minutes that buys on the pack.

const DRONE_AIR_RHO = 1.225 // kg/m³ at sea level, 15°C
const DRONE_PROP_SLIP = 0.72 // real exit velocity is ~72% of geometric pitch speed
const DRONE_FOM = 0.55 // figure of merit: motor + ESC + prop, lumped
// Stall torque per 32g motor class, calibrated so a 2207 on 4S with a 5x4.3
// tri-blade lands on the published ~1.2kg of static thrust per motor. Every
// other prop and pack then follows from the same two equations instead of a
// per-size lookup nobody could check.
const DRONE_TAU_REF = 1.10 // N·m at 32g

/**
 * Momentum theory, no fudge factors beyond the two constants above.
 *   thrust  T = ½·ρ·A·v²        (v = exit velocity through the disc)
 *   power   P = T^1.5 / √(2ρA)   (ideal induced power)
 * Everything the product claims about a quad comes out of those two lines, so a
 * design that says 12 minutes has 12 minutes of arithmetic behind it.
 */
function droneReport(params, massG) {
  const D = params.propMm / 1000
  const A = (Math.PI * D * D) / 4
  const pitch = D * 0.86
  const vPack = params.cells * 3.7 * 0.9
  const omega0 = (params.kv * vPack * 2 * Math.PI) / 60 // rad/s, no-load

  // Thrust coefficient from momentum theory: T = cT·ω², because the exit
  // velocity is pitch·ω/2π.
  const vPerRad = (pitch * DRONE_PROP_SLIP) / (2 * Math.PI)
  const cT = 0.5 * DRONE_AIR_RHO * A * vPerRad * vPerRad

  // Prop drag torque from the induced power: P = T^1.5/√(2ρA), τ = P/ω.
  const kp = Math.pow(cT, 1.5) / (DRONE_FOM * Math.sqrt(2 * DRONE_AIR_RHO * A))

  // The operating point is where the motor's falling torque meets the prop's
  // rising drag: τs(1 − ω/ω0) = kp·ω². This is the whole fix: the old model ran
  // the disc at geometric pitch speed, which assumes the motor is never loaded
  // and made big props look free.
  const tauStall = DRONE_TAU_REF * (params.motorMassG / 32) // N·m, scaled by motor mass
  const a = kp
  const b = tauStall / omega0
  const c = -tauStall
  const omega = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a) // rad/s at the operating point
  const rpm = (omega * 60) / (2 * Math.PI)

  const vExit = (omega / (2 * Math.PI)) * pitch * DRONE_PROP_SLIP
  const tOne = cT * omega * omega // N
  const thrustG = (4 * tOne * 1000) / 9.81
  const massKg = Math.max(0.001, massG / 1000)
  const weightN = massKg * 9.81
  // hover: each motor carries a quarter of the weight
  const tHover = weightN / 4
  const vHover = Math.sqrt((2 * tHover) / (DRONE_AIR_RHO * A))
  const pHover = Math.pow(tHover, 1.5) / Math.sqrt(2 * DRONE_AIR_RHO * A) // W, ideal, per motor
  const pElec = (4 * pHover) / DRONE_FOM
  const amps = pElec / vPack
  const minutes = ((params.mah / 1000) * 0.8 * 60) / amps
  return {
    propMm: params.propMm,
    diskAreaM2: A,
    omega,
    vExit,
    thrustG,
    tOneN: tOne,
    twr: thrustG / massG,
    hoverThrottle: Math.min(1, vHover / Math.max(vExit, 1e-6)),
    hoverAmps: amps,
    hoverWatts: pElec,
    minutes,
    rpm,
    tipSpeed: Math.PI * D * (rpm / 60),
  }
}

function buildDrone(brief) {
  const d = newDesign('drone', brief)
  // the prop size is the whole design: 5" and 7" are different machines, not a
  // style choice. Take it from propMm, else from the reach slider the UI shows.
  // DEFAULT_BRIEF carries reachMm 450, so taking reach as the prop size turned
  // every default drone into a 7-inch machine. Only a reach that could plausibly
  // BE a prop diameter is read as one.
  const reach = brief.reachMm
  const wanted = brief.propMm || (reach && reach >= 90 && reach <= 220 ? reach : 127)
  const propKey = wanted >= 160 ? 'prop7' : 'prop5'
  const propMm = propKey === 'prop7' ? 178 : 127
  const motorKey = propKey === 'prop7' ? 'motor2806' : 'motor2207'
  const kv = propKey === 'prop7' ? 1300 : 2450
  const battKey = brief.battery === 'lipo6s' ? 'lipo6s' : propKey === 'prop7' ? 'lipo6s' : 'lipo4s'
  const batt = PARTS[battKey]
  const cells = Math.round(batt.volts / 3.7)

  // motor diagonal: a 5" quad carries props that just clear each other, so the
  // diagonal is the prop diameter plus a margin — 1.78× is the real-world ratio
  const diagonal = clamp(Math.round(propMm * 1.78), 160, 900)
  const armLen = Math.round(diagonal / 2 - 18)
  const core = Math.round(diagonal * 0.42)
  const payload = clampPayload(d, brief.payloadKg || 0, 0, 6)

  d.title = `${propMm}mm ${propKey === 'prop7' ? '7' : '5'}-inch quad`
  d.subtitle = `${diagonal}mm motor diagonal · ${batt.name.split(' ').slice(0, 2).join(' ')} · ${payload}kg payload`
  d.metrics = {}

  const zArm = 6
  const zTop = 20

  // ── plates and arms: the frame, printed ───────────────────────────────────
  splitBox(d, 'plate-bottom', [core, core, 3], [0, 0, 3], 2, 'shell', 256, { print: true })
  splitBox(d, 'plate-top', [Math.round(core * 0.72), Math.round(core * 0.72), 3], [0, 0, zTop], 2, 'shell', 256, { print: true })
  for (let i = 0; i < 4; i += 1) {
    const ang = (Math.PI / 4) + (i * Math.PI) / 2
    const cx = Math.cos(ang)
    const sy = Math.sin(ang)
    const mid = armLen / 2 + 10
    box(d, `arm-${i}`, [armLen, 14, 5], [cx * mid, sy * mid, zArm], 'shell', {
      print: true,
      rot: [0, 0, ang],
    })
    // motor mount pad, slightly wider than the arm so the bolts have material
    cyl(d, `arm-pad-${i}`, 13, 4, [cx * (armLen + 12), sy * (armLen + 12), zArm + 2], 'z', 'shell', { print: true })

    // motor: stator can + bell, then the prop on top of the bell
    const mx = cx * (armLen + 12)
    const my = sy * (armLen + 12)
    cyl(d, `${nameOf(i)}-motor`, 13.5, 26, [mx, my, zArm + 15], 'z', 'metal')
    cyl(d, `${nameOf(i)}-bell`, 14.5, 10, [mx, my, zArm + 30], 'z', 'steel')
    // Rotors spin opposite their diagonal partner — that is how a quad yaws, and
    // getting it wrong is why a first build flips on arm.
    const dir = i === 0 || i === 3 ? 1 : -1
    cyl(d, `${nameOf(i)}-hub`, 5, 5, [mx, my, zArm + 36], 'z', 'accent', { rotor: { dir } })
    for (let b = 0; b < 3; b += 1) {
      const ba = (b * 2 * Math.PI) / 3
      // a blade: length from the hub, thin, pitched a few degrees out of flat
      box(d, `${nameOf(i)}-blade-${b}`, [propMm * 0.46, 11, 1.6],
        [mx + Math.cos(ba) * propMm * 0.24, my + Math.sin(ba) * propMm * 0.24, zArm + 37],
        'rubber', { rot: [0.18, 0, ba], rotor: { dir } })
    }
    // leg: the frame has to stand on something
    cyl(d, `leg-${i}`, 4.5, 22, [cx * (core / 2 - 6), sy * (core / 2 - 6), -8], 'z', 'shell', { print: true })
  }

  // ── the stack: ESC under the flight controller, both on the 30.5 grid ─────
  elec(d, 'esc', 'esc4in1', [0, 0, zArm + 6], null)
  elec(d, 'fc', 'fc405', [0, 0, zArm + 14], null)
  box(d, 'stack-standoff-a', [3, 3, 8], [15, 15, zArm + 10], 'steel')
  box(d, 'stack-standoff-b', [3, 3, 8], [-15, -15, zArm + 10], 'steel')

  // ── battery on top, strapped, with the camera out front ───────────────────
  const bd = PARTS[battKey].dims
  box(d, 'battery', [bd[0], bd[1], bd[2]], [0, Math.round(core * 0.06), zTop + 3 + bd[2] / 2], 'pcb')
  // the pack is held by straps, and a pack without straps is a pack that leaves
  // the frame on the first punch-out
  for (const s of [-1, 1]) {
    box(d, `strap-${s > 0 ? 'a' : 'b'}`, [11, bd[1] + 10, 3],
      [s * Math.round(bd[0] * 0.26), Math.round(core * 0.06), zTop + 3 + bd[2] + 1.5], 'accent')
  }
  box(d, 'strap-lock', [16, 6, 6], [0, Math.round(core * 0.06) - bd[1] / 2 - 4, zTop + 3 + bd[2] + 1], 'pcb')
  box(d, 'cam-bracket', [26, 8, 22], [core * 0.42, 0, zTop + 4], 'shell', { print: true, rot: [0.5, 0, 0] })
  elec(d, 'cam', 'ov2640', [Math.round(core * 0.46), 0, zTop + 14], [0, 2, 1])
  cyl(d, 'antenna', 1.4, 46, [0, -Math.round(core * 0.34), zTop + 26], 'z', 'steel')
  cyl(d, 'antenna-tip', 3.2, 6, [0, -Math.round(core * 0.34), zTop + 48], 'z', 'accent')

  // ── what you buy ─────────────────────────────────────────────────────────
  addPart(d, motorKey, 4, 'Drive')
  addPart(d, propKey, 4, 'Lift')
  addPart(d, 'esc4in1', 1, 'Drive')
  addPart(d, 'fc405', 1, 'Flight control')
  addPart(d, battKey, 1, 'Power')
  addPart(d, 'ov2640', 1, 'FPV')
  addPart(d, 'xt60', 1, 'Power')
  addPart(d, 'm3_screws', 16, 'Frame')

  d.drone = {
    propMm, kv, cells, mah: batt.mah, motors: 4, propKey, motorKey, battery: battKey, payloadKg: payload,
    motorMassG: (PARTS[motorKey] && PARTS[motorKey].mass) || 32,
  }
  return d
}

function nameOf(i) {
  return ['prop-fl', 'prop-fr', 'prop-rr', 'prop-rl'][i] || `prop-${i}`
}
