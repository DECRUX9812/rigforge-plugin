// ── rover: wheels, torque and runtime ───────────────────────────────────────
// The interesting part is not the box. It is: can this motor move this mass,
// and how long does the pack last doing it.

function buildRover(brief) {
  const d = newDesign('rover', brief)
  const payload = clampPayload(d, brief.payloadKg || 2, 0.2, 15)
  const wheelD = clamp(Math.round(brief.wheelMm || (brief.reachMm || 400) * 0.22), 60, 220) // wheel Ø, mm
  const track = clamp(Math.round(wheelD * 3.2), 150, 420)
  const wheelbase = clamp(Math.round(track * 1.25), 180, 520)
  const r = wheelD / 2 / 1000 // m

  d.title = `${wheelD}mm 4WD rover`
  d.subtitle = `${track}×${wheelbase}mm wheelbase · ${payload}kg cargo`
  d.metrics = {}

  const chassisH = 34
  const z0 = wheelD / 2

  const bed = brief.bedMm || 256
  splitBox(d, 'chassis-deck', [wheelbase, track, 5], [0, 0, z0 + chassisH - 2], 2, 'shell', bed, { print: true })
  for (const sx of [-1, 1]) {
    splitBox(d, `bulkhead-${sx > 0 ? 'f' : 'b'}`, [4, track, chassisH - 8], [sx * (wheelbase / 2 - 3), 0, z0 + chassisH / 2 - 2], 0.8, 'shell', bed, { print: true })
    // two half-bumpers instead of one 288mm wedge: each fits a small bed
    for (const side of [-1, 1]) {
      wedge(d, `bumper-${sx > 0 ? 'f' : 'b'}-${side > 0 ? 'r' : 'l'}`, [16, track * 0.44, 22], [sx * (wheelbase / 2 + 6), side * track * 0.23, z0 + 8], sx > 0 ? 'nx' : 'px', 'accent', { print: true })
    }
  }
  for (const sx of [-1, 1]) {
    splitBox(d, `rail-${sx > 0 ? 'l' : 'r'}`, [wheelbase + 10, 7, chassisH + 10], [0, sx * (track / 2 + 3), z0 + 2], 1.5, 'accent', bed, { print: true })
    for (const fx of [-1, 1]) {
      bolt(d, `rail-bolt-${sx}${fx}`, [fx * (wheelbase / 2 - 8), sx * (track / 2 + 6.5), z0 + chassisH + 4], 'y', 8, { flip: sx < 0 })
    }
  }
  // battery well, electronics shelf, payload plate
  rbox(d, 'battery-well', [wheelbase * 0.42, track * 0.5, 18], [-wheelbase * 0.2, 0, z0 + 12], 2, 'pcb')

  // wheels + motors: torus tire, printed rim, lug hardware — a wheel, not a disc
  const wheels = [
    [wheelbase / 2 - 6, track / 2],
    [wheelbase / 2 - 6, -track / 2],
    [-wheelbase / 2 + 6, track / 2],
    [-wheelbase / 2 + 6, -track / 2],
  ]
  wheels.forEach(([x, y], i) => {
    const side = y > 0 ? 1 : -1
    wheelAssy(d, `wheel-${i}`, [x, y + side * 14, z0], 'y', wheelD, 26, null, side)
    cyl(d, `motor-${i}`, 18.5, 52, [x, y - side * 6, z0], 'y', 'metal')
    cyl(d, `shaft-${i}`, 3, 22, [x, y + side * 4, z0], 'y', 'steel')
    box(d, `motor-brkt-${i}`, [30, 5, 30], [x, y - side * 30, z0], 'metal')
    bearing(d, `wheel-race-${i}`, [x, y + side * 2, z0], 'y', 22, 8, 7)
  })

  // sensor mast + head
  rbox(d, 'mast', [26, 26, 150], [wheelbase * 0.34, 0, z0 + chassisH + 75], 1.5, 'shell', { print: true })
  rbox(d, 'head', [70, 86, 34], [wheelbase * 0.34, 0, z0 + chassisH + 167], 3, 'accent', { print: true })
  cyl(d, 'head-tof', 9, 8, [wheelbase * 0.34 + 34, 0, z0 + chassisH + 167], 'x', 'glass')
  cyl(d, 'head-cam', 7, 8, [wheelbase * 0.34 + 34, 26, z0 + chassisH + 173], 'x', 'glass')

  // the BOM's electronics are real parts, not implied: controller + IMU on
  // the deck, and the second VL53L0X faces down under the rear bumper as the
  // drop-off ranger the BOM line names
  const deckTop = z0 + chassisH + 0.5
  box(d, 'esp32', [55, 28, 10], [-wheelbase * 0.3, -track * 0.3, deckTop + 5], 'pcb')
  box(d, 'imu', [10, 10, 4], [-wheelbase * 0.3 + 38, -track * 0.3, deckTop + 2], 'pcb')
  cyl(d, 'tof-drop', 9, 8, [-wheelbase / 2 - 6, 0, z0 - 8], 'z', 'glass')

  // ── mass, torque, motor choice ──────────────────────────────────────────
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const printedCm3 = printedVolume(d.nodes) / 1000
  const printMassKg = (printedCm3 * mat.density) / 1000
  const electronicsKg = 0.32 // MCU, driver, DC-DC, wiring, fasteners
  const batteryKg = PARTS[brief.battery] ? PARTS[brief.battery].mass / 1000 : 0.14

  // First guess, then refine once the motor is known.
  let massKg = printMassKg + electronicsKg + batteryKg + payload
  const Crr = 0.06 // printed wheels on carpet — the honest number
  const accel = 0.8 // m/s²
  const needPerWheel = ((massKg * G * Crr + massKg * accel) * r) / 4 * 1.5

  const motorKey = MOTOR_LADDER.find((k) => k !== 'n20_100' || needPerWheel < 0.04) &&
    MOTOR_LADDER.find((k) => PARTS[k].torque >= needPerWheel)
  const motor = motorKey || 'jgb37'
  const motorPart = PARTS[motor]
  addPart(d, motor, 4, 'drive')
  massKg += (motorPart.mass / 1000) * 4

  const v = motorPart.volts
  const battery = brief.battery && PARTS[brief.battery] ? brief.battery : v >= 11 ? 'pack3s' : 'pack2s'
  const bat = PARTS[battery]
  const asked = battery === 'pd5v' ? 'pd5v' : battery
  const swapped = asked === 'pack2s' && v >= 11
  addPart(d, swapped ? 'pack3s' : asked, 1, `${v}V motor rail`)
  if (swapped) {
    d.checks.push({ level: 'warn', msg: `2S chosen, but ${v}V motors need 3S — the BOM uses the 3S pack. Use a 2S motor (or a boost stage) if you want a lighter pack.` })
  }
  addPart(d, 'buck5a', 1, '5V logic rail')
  // TB6612 tops out at 1.2A/channel — a bigger motor or a 3S pack wants the
  // BTS7960, and a BTS7960 is a single channel so it takes two for L/R drive.
  const driverKey = motorPart.curr.peak > 1.1 || v >= 11 ? 'bts7960' : 'tb6612'
  addPart(d, driverKey, driverKey === 'bts7960' ? 2 : 1, `motor driver${driverKey === 'bts7960' ? ' (one per side)' : ''}`)
  addPart(d, 'fuse', 1, 'pack protection')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, 'cap1000', 1, 'motor rail smoothing')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bno085', 1, 'heading + tilt')
  addPart(d, 'vl53l0x', 2, 'forward + drop-off')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'xt60', 1, 'pack connector')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed chassis')

  const speed = (motorPart.speed * Math.PI * (wheelD / 1000)) / 60 // m/s
  const driveCurrent = motorPart.curr.typ * 2 // two channels under load
  const idleCurrent = 0.22
  const runtimeMin = bat.mah > 0 ? Math.round(((bat.mah / 1000) * 0.8 * 60) / (driveCurrent + idleCurrent)) : null

  d.notes.push(`${motorPart.name} chosen: ${fmt(needPerWheel, 3)} N·m per wheel needed, ${fmt(motorPart.torque, 2)} N·m available.`)
  d.notes.push(`Top speed ${fmt(speed * 3.6, 1)} km/h at ${motorPart.speed} rpm through ${wheelD}mm wheels.`)
  if (bat.maxA < motorPart.curr.peak * 2) {
    d.checks.push({ level: 'warn', msg: `${bat.name} can supply ${bat.maxA}A; four motors stalling want ${fmt(motorPart.curr.peak * 4, 1)}A. Add a current limit in firmware.` })
  }
  if (d.joints.length === 0) {
    joint(d, 'head-pan', 'Head pan', 'z', [wheelbase * 0.34, 0, z0 + chassisH + 150], -90, 90)
    cyl(d, 'head-servo', 12, 24, [wheelbase * 0.34, 0, z0 + chassisH + 150], 'z', 'metal', { joint: 'head-pan' })
    addPart(d, 'mg90s', 1, 'head pan')
  }

  Object.assign(d.metrics, {
    massKg,
    wheelD,
    trackMm: track,
    speedMps: speed,
    runtimeMin,
    torquePerWheel: needPerWheel,
    motor,
    battery,
  })
  return d
}
