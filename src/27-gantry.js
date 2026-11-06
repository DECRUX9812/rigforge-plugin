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
  // Bridge height above the bed. The quill stack (spindle + clamp + carriage,
  // ~125mm) has to fit *below* the beam with its tip near the spoilboard, so
  // the superstructure stands well clear of the bed — a real CNC is tall.
  const z0 = 260
  const bedZ = 0

  d.title = `${spanX}mm gantry machine`
  d.metrics = { spanX, spanY, spanZ }

  // ── motion: three chained slides — portal X, saddle Y, quill Z ──────────
  // The quill inherits saddle+portal displacement through the slide chain, so
  // one tag moves it in all three axes. X/Y are centred (min<0); Z drops from
  // the top, so its joint sign is -1 and angle 0 is the raised pose.
  slideJoint(d, 'gantry-x', 'Portal X', 'x', 720)
  slideJoint(d, 'gantry-y', 'Saddle Y', 'y', 580)
  slideJoint(d, 'gantry-z', 'Quill drop', 'z', 60)
  const jx = d.joints.find((j) => j.id === 'gantry-x')
  const jy = d.joints.find((j) => j.id === 'gantry-y')
  const jz = d.joints.find((j) => j.id === 'gantry-z')
  // travel is what the geometry honestly allows: portal edge clears the side
  // rails, saddle stays on the beam, and the quill stops ~12mm over the bed
  // ribs — spanZ is the screw's rating, not room the frame gives it
  jx.min = -360; jx.max = 360; jx.slideSpeed = 250
  jy.min = -290; jy.max = 290; jy.slideSpeed = 250; jy.parent = 'gantry-x'
  jz.min = 0; jz.max = 60; jz.sign = -1; jz.slideSpeed = 12; jz.parent = 'gantry-y'
  const onX = { slide: { joint: 'gantry-x', sign: 1 } }
  const onY = { slide: { joint: 'gantry-y', sign: 1 } }
  const onZ = { slide: { joint: 'gantry-z', sign: 1 } }
  d.subtitle = `${spanX}×${spanY}mm · belt XY · Z drop ${jz.max}mm`

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
  // control enclosure in the rail/bed channel — open-top card-cage so the
  // GRBL stack inside is visible: 3× DRV8825 stepper drivers standing on the
  // base, ESP32-S3 + buck on the outer wall. Out of the quill's X/Y envelope.
  {
    const cb = [-(spanX / 2 + 15), 0, 75]
    const cbO = { print: true }
    box(d, 'ctrl-base', [30, 150, 4], [cb[0], cb[1], cb[2] - 43], 'shell', cbO)
    for (const sy of [-1, 1]) box(d, `ctrl-wall-y${sy}`, [30, 3, 86], [cb[0], cb[1] + sy * 73.5, cb[2] + 2], 'shell', cbO)
    for (const sx of [-1, 1]) box(d, `ctrl-wall-x${sx}`, [3, 144, 86], [cb[0] + sx * 13.5, cb[1], cb[2] + 2], 'shell', cbO)
    // boards at catalog dims, stood on edge against the side walls — the
    // cage is only ~24mm deep, so flat-mounting a 62mm DevKit is impossible;
    // a real build standoffs them to the walls exactly like this.
    elec(d, 'esp32', 'esp32s3', [cb[0] - 8, cb[1] - 30, cb[2] + 2], [2, 0, 1])
    elec(d, 'buck5a', 'buck5a', [cb[0] - 6, cb[1] + 30, cb[2] - 5], [2, 0, 1])
    for (const [i, sy] of [[0, -40], [1, -15], [2, 10]])
      elec(d, `drv8825-${'abc'[i]}`, 'drv8825', [cb[0] + 8, cb[1] + sy, cb[2] + 2], [2, 0, 1])
    // power path on the cage floor: ATO fuse, rail cap, power rocker —
    // flat on the base, clear of the wall-mounted boards above
    elec(d, 'fuse', 'fuse', [cb[0], cb[1] + 40, cb[2] - 31], [1, 0, 2])
    elec(d, 'cap1000', 'cap1000', [cb[0], cb[1] - 40, cb[2] - 33])
    elec(d, 'rocker', 'rocker', [cb[0], cb[1] - 55, cb[2] - 31])
    // XT60 at the cage mouth — pack lead lands on the fuse first
    elec(d, 'xt60', 'xt60', [cb[0], cb[1] + 12, cb[2] - 34])
  }

  // X rails: the portal's fixed guidance — one extrusion per bridge end,
  // spanning frame X with the ends bedded onto the side rails. The carriage
  // cheeks below wrap them; without these the portal had nothing to ride.
  for (const sy of [-1, 1]) {
    rbox(d, `x-rail-${sy > 0 ? 'b' : 'f'}`, [spanX + 80, 26, 20], [0, sy * (spanY / 2 + 10), 68], 2, 'metal')
  }

  // gantry bridge: one beam the saddle rides in Y, two legs carrying portal X
  rbox(d, 'bridge', [railW, spanY + 60, beamH], [0, 0, z0 + beamH / 2], 3, 'accent', { print: false, ...onX })
  // Y rail on the bridge crown — the saddle's guidance, moves with the portal
  rbox(d, 'y-rail', [26, spanY + 50, 14], [0, 0, z0 + beamH + 7], 2, 'metal', onX)
  // portal legs: from the X-rail carriages up to the bridge underside
  const legBot = railW + 27 // flush on the y-carriage top
  for (const sy of [-1, 1]) {
    rbox(d, `upright-${sy > 0 ? 'b' : 'f'}`, [railW, 26, z0 - legBot], [0, sy * (spanY / 2 + 10), (z0 + legBot) / 2], 2, 'accent', { print: false, ...onX })
    // Y carriage: rail block riding the X rail (MGN-style, like the BOM's mgn12)
    rbox(d, `y-carriage-${sy}`, [railW + 20, 60, 26], [0, sy * (spanY / 2 + 10), railW + 14], 2, 'metal', onX)
  }

  // X carriage + Z axis. The column is the quill's guide post — fixed to the
  // bridge, top buried in the beam — and the quill (spindle → clamp →
  // carriage, bottom-up) slides on it, always *below* the beam where the
  // tool is visible.
  // Built positions are the raised pose; jz.max drops the stack to tipWork.
  const tipWork = bedZ + railW + 28 // spindle tip at full drop: ~8mm over spoilboard
  const colBot = 190
  const colTop = z0 + beamH - 5 // top edge stays inside the beam
  const colH = colTop - colBot
  const zCar = tipWork + 97 + jz.max // carriage centre, raised (work 185)
  const zClamp = tipWork + 62 + jz.max // clamp centre, raised (work 150)
  const zSpin = tipWork + 23 + jz.max // spindle centre, raised (work 111)
  rbox(d, 'x-carriage', [44, railW, 34], [0, 0, z0 + beamH + 10], 2, 'metal', onY)
  rbox(d, 'z-column', [34, 34, colH], [0, 0, (colTop + colBot) / 2], 2, 'accent', { print: false, ...onY })
  rbox(d, 'z-carriage', [56, 56, 30], [0, 0, zCar], 2, 'metal', onZ)
  rbox(d, 'spindle-clamp', [64, 64, 40], [0, 0, zClamp], 3, 'accent', { print: true, ...onZ })
  cyl(d, 'spindle', 16, 46, [0, 0, zSpin], 'z', 'steel', onZ)

  // drive: motors, belts (as flat straps), leadscrew, limit switches
  cyl(d, 'motor-x', 21, 40, [spanX / 2 + 10, -(spanY / 2 + 10), z0 + beamH + 6], 'x', 'servo')
  // Y motor rides the portal beside the front leg — the saddle it drives does
  cyl(d, 'motor-y', 21, 40, [-55, -(spanY / 2 + 10), (legBot + z0) / 2], 'y', 'servo', onX)
  cyl(d, 'motor-z', 21, 40, [0, 0, z0 + beamH + 40], 'z', 'servo', onY)
  rbox(d, 'belt-x', [8, spanY + 40, 6], [spanX / 2 + 10, 0, z0 + beamH - 10], 1, 'belt')
  rbox(d, 'belt-y', [spanX, 8, 6], [0, -(spanY / 2 + 10), railW + 22], 1, 'belt')
  // leadscrew: motor coupling down to the quill nut — the working span, not
  // the column's full guide length
  cyl(d, 'leadscrew', 6, z0 + beamH + 40 - (tipWork + 60), [0, 0, (z0 + beamH + 40 + tipWork + 60) / 2], 'z', 'steel', onY)
  for (const [ax, pos, tag] of [
    ['x', [spanX / 2 - 20, -(spanY / 2 + 10), z0 + 10], null],
    ['y', [40, -(spanY / 2 + 25), railW + 25], onX],
    ['z', [30, 0, z0 + beamH + 40], null],
  ]) {
    rbox(d, `limit-${ax}`, [12, 8, 6], pos, 1, 'pcb', tag || undefined)
  }

  // printed corner brackets + motor mounts: the only custom geometry, and the
  // reason a metre-class machine still needs a 3D printer
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    // a real CAD bracket mesh (converted from Sand3D), not another rounded box
    mesh(d, `corner-${sx}${sy}`, 'BRACKET', [58, 58, 26], [sx * (spanX / 2 + 26), sy * (spanY / 2 + 26), railW + 8], 'accent', { print: true })
  }
  for (const sy of [-1, 1]) {
    rbox(d, `motor-mount-${sy}`, [56, 56, 10], [spanX / 2 + 10 + sy * 32, -(spanY / 2 + 10), z0 + beamH + 6], 2, 'accent', { print: true })
  }
  rbox(d, 'z-mount', [70, 70, 16], [0, 0, z0 + beamH + 30], 2, 'accent', { print: true, ...onY })

  // drag chain outboard of the front X rail: the spindle harness crosses the
  // longest slide on a real energy chain, not a dangling cable. The chain
  // runs in the carriage's outer skirt — clear of the rail it serves — with
  // a stationary run anchored to the rail underside and a moving run riding
  // with the portal. Bend slack is implied (the 1m part carries it).
  {
    const cy = -(spanY / 2 + 10) - 22 // rail outer face + link half-width
    // end fitting: taller link that bolts up to the rail underside
    rbox(d, 'chain-anchor', [26, 30, 16], [-384, cy, 50], 1, 'metal')
    for (let x = -360, i = 0; x <= -192; x += 24, i += 1)
      rbox(d, `chain-s${i}`, [20, 15, 14], [x, cy, 51], 1, 'belt')
    for (let x = -164, i = 0; x <= 16; x += 24, i += 1)
      rbox(d, `chain-m${i}`, [20, 15, 14], [x, cy, 51], 1, 'belt', onX)
    // carrier bracket: clamps the moving end under the carriage skirt
    rbox(d, 'chain-carrier', [22, 24, 10], [2, cy - 5, 57], 1, 'metal', onX)
  }

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
  d.notes.push(`Quill drop is limited to ${jz.max}mm by the spoilboard ribs, not the screw's ${spanZ}mm rating — the frame gives less than the mechanics could use.`)

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
