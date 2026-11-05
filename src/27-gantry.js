// ── gantry: the top of the ladder ───────────────────────────────────────────
// A metre-class machine: 2m of aluminium extrusion, three steppers, belts on X
// and Y, a leadscrew on Z. Nothing here is a toy, so the checks are the ones
// that actually bite at this size — beam deflection across the span, belt sag,
// motor torque against a moving gantry mass, and a bed that no hobby printer
// can hold in one piece.

function buildGantry(brief) {
  const d = newDesign('gantry', brief)
  const spanX = clamp(Math.round(brief.reachMm || 800), 400, 2000) // travel in X, mm
  const spanY = clamp(Math.round(spanX * 0.75), 300, 1600)
  const spanZ = clamp(Math.round(spanX * 0.35), 150, 700)

  const railW = 60 // gantry beam depth, mm
  const beamH = 80
  const z0 = 90 // gantry height above the bed
  const bedZ = 0

  d.title = `${spanX}mm gantry machine`
  d.subtitle = `${spanX}×${spanY}×${spanZ}mm travel · belt XY · leadscrew Z`
  d.metrics = { spanX, spanY, spanZ }

  // ── frame: two side rails, a bed, and the moving gantry bridge ───────────
  for (const sx of [-1, 1]) {
    rbox(d, `side-rail-${sx > 0 ? 'r' : 'l'}`, [20, spanY + 120, railW], [sx * (spanX / 2 + 40), 0, railW / 2], 2, 'metal')
    for (const fy of [-1, 1]) {
      rbox(d, `foot-${sx}${fy}`, [90, 90, 12], [sx * (spanX / 2 + 40), fy * (spanY / 2 + 30), 6], 2, 'metal')
      for (const bx of [-1, 1]) for (const by of [-1, 1]) {
        bolt(d, `foot-bolt-${sx}${fy}${bx}${by}`, [sx * (spanX / 2 + 40) + bx * 32, fy * (spanY / 2 + 30) + by * 32, 12], 'z', 12)
      }
    }
  }
  rbox(d, 'bed', [spanX - 60, spanY - 40, 6], [0, 0, bedZ + railW + 3], 2, 'metal')
  for (let i = -2; i <= 2; i += 1) {
    rbox(d, `bed-rib-${i}`, [spanX - 70, 8, 14], [0, i * ((spanY - 60) / 5), bedZ + railW + 13], 1, 'metal')
  }

  // gantry bridge: one beam carrying X, two uprights riding Y
  rbox(d, 'bridge', [railW, spanY + 60, beamH], [0, 0, z0 + beamH / 2], 3, 'accent', { print: false })
  for (const sy of [-1, 1]) {
    rbox(d, `upright-${sy > 0 ? 'b' : 'f'}`, [railW, 26, z0], [0, sy * (spanY / 2 + 10), z0 / 2], 2, 'accent', { print: false })
    // Y carriage: rail block + rollers
    rbox(d, `y-carriage-${sy}`, [railW + 20, 60, 26], [0, sy * (spanY / 2 + 10), railW + 14], 2, 'metal')
    for (const bx of [-1, 1]) cyl(d, `y-roller-${sy}${bx}`, 9, 12, [bx * 22, sy * (spanY / 2 + 10), railW + 6], 'x', 'steel')
  }
  // X carriage + Z column
  rbox(d, 'x-carriage', [44, railW, 34], [0, 0, z0 + beamH + 10], 2, 'metal')
  rbox(d, 'z-column', [34, 34, spanZ + 60], [0, 0, z0 + beamH + 10 - (spanZ + 60) / 2 + 30], 2, 'accent', { print: false })
  rbox(d, 'z-carriage', [60, 60, 22], [0, 0, z0 + beamH + 28], 2, 'metal')
  cyl(d, 'spindle', 16, 46, [0, 0, z0 + beamH + 6], 'z', 'steel')

  // drive: motors, belts (as flat straps), leadscrew, limit switches
  cyl(d, 'motor-x', 21, 40, [spanX / 2 + 10, -(spanY / 2 + 10), z0 + beamH + 6], 'x', 'servo')
  cyl(d, 'motor-y', 21, 40, [0, -(spanY / 2 + 10), railW + 10], 'y', 'servo')
  cyl(d, 'motor-z', 21, 40, [0, 0, z0 + beamH + 40], 'z', 'servo')
  rbox(d, 'belt-x', [8, spanY + 40, 6], [spanX / 2 + 10, 0, z0 + beamH - 10], 1, 'belt')
  rbox(d, 'belt-y', [spanX, 8, 6], [0, -(spanY / 2 + 10), railW + 22], 1, 'belt')
  cyl(d, 'leadscrew', 6, spanZ + 60, [0, 0, z0 + beamH + 10 - (spanZ + 60) / 2 + 30], 'z', 'steel')
  for (const [ax, pos] of [['x', [spanX / 2 - 20, -(spanY / 2 + 10), z0 + 10]], ['y', [0, -(spanY / 2 + 20), railW + 10]], ['z', [30, 0, z0 + beamH + 40]]]) {
    rbox(d, `limit-${ax}`, [12, 8, 6], pos, 1, 'pcb')
  }

  // printed corner brackets + motor mounts: the only custom geometry, and the
  // reason a metre-class machine still needs a 3D printer
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    rbox(d, `corner-${sx}${sy}`, [70, 70, 30], [sx * (spanX / 2 + 22), sy * (spanY / 2 + 22), railW + 12], 3, 'accent', { print: true })
  }
  for (const sy of [-1, 1]) {
    rbox(d, `motor-mount-${sy}`, [56, 56, 10], [spanX / 2 + 10 + sy * 24, -(spanY / 2 + 10), z0 + beamH + 6], 2, 'accent', { print: true })
  }
  rbox(d, 'z-mount', [70, 70, 16], [0, 0, z0 + beamH + 30], 2, 'accent', { print: true })
  rbox(d, 'spindle-clamp', [70, 70, 40], [0, 0, z0 + beamH + 2], 3, 'accent', { print: true })

  // ── parts ────────────────────────────────────────────────────────────────
  const railMetres = Math.ceil((2 * (spanY + 120) + 2 * spanX + 4 * 400) / 1000 * 2) / 2
  const braceMetres = Math.ceil((2 * spanX + 2 * spanY) / 1000 * 2) / 2
  addPart(d, 'extrusion_2040', railMetres, 'rails, legs, beam')
  addPart(d, 'extrusion_2020', braceMetres, 'bracing + bed frame')
  addPart(d, 'bed_plate', 1, 'spoilboard')
  addPart(d, 'spindle_500w', 1, 'cutting spindle')
  addPart(d, 'drag_chain', 1, 'harness')
  addPart(d, 'nema17', 3, 'X / Y / Z drive')
  addPart(d, 'drv8825', 3, 'stepper drivers')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller (GRBL-firmware)')
  addPart(d, 'gt2_kit', 1, 'X/Y belts + pulleys')
  addPart(d, 'leadscrew_t8', 1, 'Z axis')
  addPart(d, 'mgn12', 3, 'linear rails')
  addPart(d, 'limit_sw', 3, 'homes')
  addPart(d, 'buck5a', 1, 'logic rail')
  addPart(d, 'fuse', 1, 'main protection')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, 'cap1000', 1, 'motor rail')
  // Steppers want 24V; a 5V or 7.4V supply is not quietly upgraded without a word
  const askedSupply = brief.battery || null
  const supplyOk = askedSupply && PARTS[askedSupply] && PARTS[askedSupply].volts >= 11
  const supply = supplyOk ? askedSupply : 'pack3s'
  if (askedSupply && !supplyOk) {
    d.checks.push({ level: 'warn', msg: `${PARTS[askedSupply].name} at ${PARTS[askedSupply].volts}V cannot drive 24V steppers — the BOM uses a 3S pack instead. A 24V supply is the honest answer for this machine.` })
  }
  addPart(d, supply, 1, 'machine power')
  addPart(d, 'hw_m3', 2, 'frame fasteners')
  addPart(d, 'm3_screws', 2, 'rail + carriage hardware')
  addPart(d, 'wire18', 1, 'motor harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'xt60', 1, 'pack connector')

  // ── the numbers that actually matter at this size ────────────────────────
  const gantryMassKg = 2.4 + (spanY / 1000) * 1.7 // beam + carriages + spindle
  const rpm = PARTS.nema17.speed || 200
  const torque = PARTS.nema17.torque
  const pulleyR = 0.0125 // GT2 20T ≈ 12.5 mm pitch radius
  const force = torque / pulleyR // N at the belt
  const accelNeed = (gantryMassKg * 2.0) // F = ma, 2 m/s²
  const beltDeflect = Math.pow(Math.max(1, spanY) / 1000, 3) * 0.42 // mm, ~N/1kg preload, empirical
  const beamDeflect = (gantryMassKg * G * Math.pow(spanX / 1000, 3)) / (48 * 70000e6 * 1.2e-7) * 1000 // mm, I≈1.2e-7 m⁴ for 60×80 extrusion

  d.notes.push(`Belt drive on X and Y: ${fmt(force, 0)}N available at the pulley, ${fmt(accelNeed, 0)}N wanted for ${fmt(gantryMassKg, 1)}kg at 2m/s².`)
  d.notes.push(`Y belt sag over ${spanY}mm is about ${fmt(beltDeflect, 2)}mm unless it is tensioned hard — that is your ripple in the surface finish.`)
  d.notes.push(`Bridge beam deflects ~${fmt(beamDeflect, 3)}mm at the middle under its own carriage — fine. Past ~1.2m span it is not: go to a taller extrusion or two beams.`)

  if (spanX > 1000) {
    d.checks.push({ level: 'warn', msg: `${spanX}mm travel: the print/step files for the bed and side rails exceed a 256mm bed several times over. Plan a 4-part bed with dowel joins, or buy extrusion by the metre and cut it.` })
  }
  if (beamDeflect > 0.5) {
    d.checks.push({ level: 'warn', msg: `Bridge deflection ${fmt(beamDeflect, 2)}mm across the span is visible in a cut. Stiffen the beam or shorten X.` })
  }
  if (force < accelNeed) {
    d.checks.push({ level: 'warn', msg: `NEMA17 at the belt gives ${fmt(force, 0)}N against ${fmt(accelNeed, 0)}N demanded — reduce gantry mass or gear the pulleys down.` })
  }
  d.checks.push({ level: 'ok', msg: 'Frame, rails, drivers and homes are all standard parts — the only custom geometry is the mounts.' })

  Object.assign(d.metrics, {
    gantryMassKg,
    beltForce: force,
    beamDeflect,
    beltDeflect,
    motors: 3,
  })
  return d
}
