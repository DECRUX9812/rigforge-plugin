// Claim probes. Each entry: what the product says, the code that produces it,
// and an independent recomputation. A failure prints the numbers that disagree.
import { loadEngine } from './lib-engine.mjs'

const A = loadEngine()
const results = []
const check = (claim, fn) => {
  try {
    const detail = fn()
    results.push({ claim, ok: true, detail })
  } catch (e) {
    results.push({ claim, ok: false, detail: e.message })
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const near = (a, b, tol, label) => assert(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`)

const eachPreset = (fn) => A.PRESETS.forEach((p) => fn(p, A.composeDesign({ ...p.brief })))

// ── 1. cost is Σ price×qty + filament, recomputed from PARTS ─────────────────
check('cost = Σ(unit price × qty) + filament used', () => {
  eachPreset((p, { design, analysis }) => {
    let sum = 0
    for (const { key, qty } of design.parts) {
      const part = A.PARTS[key]
      assert(part, `${p.id}: unknown part key ${key}`)
      sum += part.price * qty
    }
    const mat = A.MATERIALS[design.brief.material] || A.MATERIALS.petg
    const spool = (analysis.print.grams / 1000) * (A.PARTS[mat.priceId]?.price || 20)
    near(analysis.cost, sum + spool, 0.02, `${p.id} cost`)
  })
  return `${A.PRESETS.length} archetypes reconcile to the catalogue`
})

// ── 2. mass = hardware + printed volume × density ────────────────────────────
check('mass = Σ(part mass) + printed volume × density', () => {
  eachPreset((p, { design, analysis }) => {
    let hardware = 0
    for (const { key, qty } of design.parts) {
      const part = A.PARTS[key]
      if (!part || part.print || part.shop) continue
      hardware += part.mass * qty
    }
    const printed = analysis.print.grams
    near(analysis.mass.totalG, hardware + printed, 0.5, `${p.id} mass`)
  })
  return 'hardware + printed, shop stock excluded'
})

// ── 3. print time is volume ÷ 18 cm³/h ───────────────────────────────────────
check('print time = printed volume ÷ 18 cm³/h', () => {
  eachPreset((p, { design, analysis }) => {
    const mat = A.MATERIALS[design.brief.material] || A.MATERIALS.petg
    const volCm3 = analysis.print.grams / mat.density
    near(analysis.print.hours, volCm3 / 18, 0.02, `${p.id} print hours`)
  })
  return 'grams → cm³ → hours at 18 cm³/h'
})

// ── 4. the bed claim and the geometry agree, at every bed size ───────────────
// The product may legitimately refuse a small bed (a 176mm arm link is not
// gluable), but it may never claim everything fits while a part is over.
check('bed claim agrees with the parts, at every bed size', () => {
  let cases = 0
  for (const bed of [180, 220, 256, 300, 350]) {
    A.PRESETS.forEach((p) => {
      // the checks are produced with the brief's bed, so compose AT this bed
      const { design, analysis } = A.composeDesign({ ...p.brief, bedMm: bed })
      const fit = A.printFit(design, bed)
      const over = fit.rows.filter((r) => !r.fits)
      const claimsOk = analysis.checks.some((c) => /Every printed part fits/i.test(c.msg))
      const claimsBad = analysis.checks.some((c) => c.level === 'fail' && /too big for a/i.test(c.msg))
      if (fit.count === 0) {
        // a board is not printed: it must make no bed claim either way
        assert(!claimsOk && !claimsBad, `${p.id} @${bed}: makes a bed claim with no printed parts`)
        return
      }
      if (over.length) {
        assert(!claimsOk, `${p.id} @${bed}: claims all parts fit but ${over[0].id} is ${over[0].largest}mm`)
        assert(claimsBad, `${p.id} @${bed}: ${over[0].id} oversize but no failure raised`)
      } else {
        assert(claimsOk && !claimsBad, `${p.id} @${bed}: parts fit but the checks disagree`)
      }
      cases += 1
    })
  }
  return `${cases} archetype×bed combinations consistent`
})

// ── 5. every sized joint is actually inside its actuator's stall ─────────────
check('actuator sizing: effective ≥ required at every joint', () => {
  let joints = 0
  eachPreset((p, { design }) => {
    for (const a of design.actuators || []) {
      if (a.ratio === 0) continue // out-of-scope joints are excluded by design
      joints += 1
      const torque = A.PARTS[a.servo].torque * a.ratio
      assert(torque + 1e-9 >= a.need, `${p.id} ${a.label}: ${torque.toFixed(2)} < ${a.need.toFixed(2)} N·m`)
    }
  })
  return `${joints} joints across the archetypes`
})

// ── 6. an over-weight brief fails loudly (no silent clamp passes) ────────────
check('payload beyond the envelope produces a fail, not a silent clamp', () => {
  for (const [id, kg] of [['rover', 400], ['quad', 40], ['humanoid', 20], ['robot', 60], ['grip', 60]]) {
    const brief = { ...A.PRESETS.find((p) => p.id === id).brief, payloadKg: kg }
    const { analysis } = A.composeDesign(brief)
    assert(
      analysis.checks.some((c) => c.level === 'fail' && /carry/i.test(c.msg)),
      `${id} at ${kg}kg passed without a failure`,
    )
  }
  return 'rover 400kg · quad 40kg · humanoid 20kg · robot 60kg · gripper 60kg all fail'
})

// ── 7. pin map has no duplicates ─────────────────────────────────────────────
check('pin map: no pin is assigned twice', () => {
  eachPreset((p, { analysis }) => {
    const used = analysis.pins.rows.map((r) => r.pin).filter((n) => /^\d+$/.test(String(n)))
    const dupes = used.filter((n, i) => used.indexOf(n) !== i)
    assert(dupes.length === 0, `${p.id}: duplicated ${[...new Set(dupes)].join(',')}`)
  })
  return 'no collisions in any archetype'
})

// ── 8. firmware references only pins the map allocated ───────────────────────
check('firmware pins come from the pin map', () => {
  eachPreset((p, { design, analysis }) => {
    const mapPins = new Set(analysis.pins.rows.map((r) => Number(r.pin)).filter(Number.isFinite))
    const fw = design.firmware || ''
    const consts = [...fw.matchAll(/^#define\s+[A-Z0-9_]+\s+(\d{1,2})\b/gm)].map((m) => Number(m[1]))
    const stray = consts.filter((n) => !mapPins.has(n))
    assert(stray.length === 0, `${p.id}: firmware references ${stray.join(',')} not in the map`)
  })
  return 'every #define pin is in the map'
})

// ── 9. STL triangle count matches the file length, and parts are slice-ready ─
check('STL: header count = (size-84)/50; parts centred, on Z=0', () => {
  let parts = 0
  eachPreset((p, { design }) => {
    const files = A.printedPartSTLs(design)
    for (const f of files) {
      const buf = Buffer.from(f.buf)
      const tris = buf.readUInt32LE(80)
      near(tris, Math.round((buf.length - 84) / 50), 0, `${p.id}/${f.name} triangle count`)
      let minZ = Infinity
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (let i = 0; i < tris; i += 1) {
        const off = 84 + i * 50 + 12
        for (let v = 0; v < 3; v += 1) {
          const x = buf.readFloatLE(off + v * 12)
          const y = buf.readFloatLE(off + v * 12 + 4)
          minZ = Math.min(minZ, buf.readFloatLE(off + v * 12 + 8))
          minX = Math.min(minX, x); maxX = Math.max(maxX, x)
          minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
      }
      near(minZ, 0, 0.01, `${p.id}/${f.name} minZ`)
      // centring is by bounding box, which is what a slicer plate wants
      near((minX + maxX) / 2, 0, 0.05, `${p.id}/${f.name} x centre`)
      near((minY + maxY) / 2, 0, 0.05, `${p.id}/${f.name} y centre`)
      parts += 1
    }
  })
  return `${parts} STL files validated`
})

// ── 9b. DFM overhang: bed orientation uses real contact area ─────────────────
// The dims heuristic used to stand wedges and ring towers on edge — the
// overhang check caught it, bestBedPerm fixed it. These presets must stay
// self-supporting; the gantry corner bracket is the honest positive control.
check('DFM overhang: presets self-support, gantry bracket flags honestly', () => {
  const designOf = (arch) => A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === arch).brief }).design
  for (const arch of ['arm', 'rover', 'robot', 'quadruped', 'humanoid', 'gripper', 'iot', 'gadget']) {
    const oh = A.overhangReport(designOf(arch))
    assert(oh.unsupportedMm2 <= 60, `${arch}: ${oh.unsupportedMm2}mm² unsupported — bed orientation regressed`)
  }
  const oh = A.overhangReport(designOf('gantry'))
  assert(oh.unsupportedMm2 > 100, `gantry corner overhang should be detected, got ${oh.unsupportedMm2}`)
  return `gantry flags ${oh.unsupportedMm2}mm² unsupported; all other presets self-support`
})

// ── 10. build codes round-trip ───────────────────────────────────────────────
check('build code round-trips to the same machine', () => {
  eachPreset((p, { design }) => {
    const code = A.encodeBuild(p.brief)
    assert(/^RF1-/.test(code), `${p.id}: code does not start RF1-`)
    assert(code.length < 400, `${p.id}: code is ${code.length} chars`)
    const back = A.decodeBuild(code)
    const again = A.composeDesign({ ...back })
    assert(again.design.title === design.title, `${p.id}: rebuilt title differs`)
    assert(again.analysis.cost === A.composeDesign({ ...p.brief }).analysis.cost, `${p.id}: rebuilt cost differs`)
  })
  return 'encode → decode → identical title and cost'
})

// ── 11. determinism ─────────────────────────────────────────────────────────
check('same brief twice gives identical numbers', () => {
  eachPreset((p) => {
    const a = JSON.stringify(A.composeDesign({ ...p.brief }).analysis.mass)
    const b = JSON.stringify(A.composeDesign({ ...p.brief }).analysis.mass)
    assert(a === b, `${p.id}: not deterministic`)
  })
  return 'no randomness in the engine'
})

// ── 12. centroid file only exists where it means something ───────────────────
check('CPL: every placement has designator, layer and coordinates', () => {
  let rows = 0
  eachPreset((p, { design }) => {
    if (!design.pcb) return
    const csv = A.toCentroidCsv(design)
    const lines = csv.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('Designator'))
    assert(lines.length === design.pcb.placed.length, `${p.id}: ${lines.length} rows for ${design.pcb.placed.length} placements`)
    for (const line of lines) {
      const [des, x, y, layer, rot] = line.split(',')
      assert(/^[A-Z]+\d+$/.test(des), `${p.id}: bad designator ${des}`)
      assert(Number.isFinite(Number(x)) && Number.isFinite(Number(y)), `${p.id}: bad coords for ${des}`)
      assert(layer === 'top' || layer === 'bottom', `${p.id}: bad layer for ${des}`)
      assert(Number.isFinite(Number(rot)), `${p.id}: bad rotation for ${des}`)
      rows += 1
    }
  })
  return `${rows} centroid rows`
})

// ── 13. wiring: the wire carries the stall case, the fuse never exceeds it ──
check('wiring: wire ≥ peak, fuse ≤ wire ampacity, no rail beyond the table', () => {
  let rows = 0
  let splits = 0
  eachPreset((p, { analysis }) => {
    for (const w of analysis.power.wiring) {
      rows += 1
      if (w.split) splits += 1
      assert(!w.over, `${p.id} ${w.rail}: rail beyond 14AWG`)
      assert(w.ampacity > 0, `${p.id} ${w.rail}: no ampacity recorded`)
      assert(w.peak <= w.ampacity + 1e-9, `${p.id} ${w.rail}: peak ${w.peak.toFixed(1)}A > ${w.ampacity}A wire`)
      if (w.fuse != null) {
        assert(w.fuse <= w.ampacity, `${p.id} ${w.rail}: fuse ${w.fuse}A on ${w.ampacity}A wire`)
      }
    }
  })
  return `${rows} rail feeds validated, ${splits} parallel feeds`
})

// ── 14. the machines we ship as presets are buildable as shown ──────────────
check('every preset builds with zero failures', () => {
  eachPreset((p, { analysis }) => {
    const fails = analysis.checks.filter((c) => c.level === 'fail')
    if (fails.length) assert(false, `${p.id}: ${fails[0].msg.slice(0, 90)}`)
  })
  return `${A.PRESETS.length} presets clean out of the box`
})

// ── 15. the ENERGY control actually changes the energy in the BOM ───────────
check('choosing a battery changes the BOM, or says why it cannot', () => {
  let changed = 0
  let explained = 0
  eachPreset((p) => {
    const batOf = (r) => {
      const e = r.design.parts.find((x) => A.PARTS[x.key]?.cat === 'battery')
      return e ? e.key : 'none'
    }
    const base = A.composeDesign({ ...p.brief })
    for (const choice of ['pack2s', 'lipo3s', 'pd5v']) {
      if (choice === batOf(base)) continue
      const alt = A.composeDesign({ ...p.brief, battery: choice })
      if (batOf(alt) === choice) { changed += 1; continue }
      const says = alt.analysis.checks.some((c) => c.level !== 'ok' && /pack|supply|3S|24V|tethered/i.test(c.msg))
      assert(says, `${p.id}: asked for ${choice}, BOM has ${batOf(alt)}, and nothing explains the substitution`)
      explained += 1
    }
  })
  return `${changed} choices honoured, ${explained} substitutions explained`
})

// ── 16. firmware drives exactly the actuators the BOM buys ──────────────────
check('firmware channel count equals the servos in the BOM', () => {
  let declared = 0
  eachPreset((p, { design }) => {
    const servos = design.parts.reduce((n, x) => (A.PARTS[x.key]?.cat === 'servo' ? n + x.qty : n), 0)
    const fw = design.firmware || ''
    const m = fw.match(/SERVO_COUNT\s*=\s*(\d+)/)
    if (m) {
      declared += 1
      assert(Number(m[1]) === servos, `${p.id}: firmware drives ${m[1]} servos, BOM buys ${servos}`)
    }
    if (servos === 0) {
      assert(!/SERVO_COUNT/.test(fw), `${p.id}: servo code with no servo in the BOM`)
    }
    assert(/void setup\(/.test(fw) && /void loop\(/.test(fw), `${p.id}: firmware missing setup/loop`)
    const braces = fw.split('{').length - fw.split('}').length
    assert(braces === 0, `${p.id}: unbalanced braces (${braces})`)
  })
  return `${declared} sketches declare a channel count; all balanced`
})

// ── 17. the BOM sheet sums to the headline cost ─────────────────────────────
check('BOM csv: line items + filament = the headline cost', () => {
  eachPreset((p, { design, analysis }) => {
    const lines = A.toBOMCsv(design, analysis).split('\n')
    const totalRow = lines[lines.length - 1]
    assert(/^TOTAL,/.test(totalRow), `${p.id}: no TOTAL row`)
    const total = Number(totalRow.split(',')[4])
    near(total, analysis.cost, 0.02, `${p.id} csv total`)
  })
  return 'ten sheets reconcile to the cent'
})

// ── 18. the spec document says the same numbers as the studio ────────────────
check('spec markdown quotes the same cost, mass and print time', () => {
  eachPreset((p, { design, analysis }) => {
    const md = A.toSpecMarkdown(design, analysis)
    const money = `$${analysis.cost >= 100 ? Math.round(analysis.cost) : analysis.cost.toFixed(2)}`
    assert(md.includes(money), `${p.id}: spec cost ${money} missing`)
    assert(md.includes(`${Math.round(analysis.mass.totalG)}g`), `${p.id}: spec mass missing`)
    assert(md.includes(`${analysis.print.hours.toFixed(1)}h`) || md.includes(`${Math.round(analysis.print.hours)}h`), `${p.id}: spec print hours missing`)
  })
  return 'cost, mass and print time agree'
})

// ── 19. the build order is complete enough to follow ────────────────────────
check('build steps: every step has a title, a how, and time on it', () => {
  eachPreset((p, { design, analysis }) => {
    const steps = A.stepsFor(design, analysis)
    assert(steps.length >= 4, `${p.id}: only ${steps.length} steps`)
    let minutes = 0
    for (const st of steps) {
      assert(st.title && st.title.length > 4, `${p.id}: step ${st.n} has no title`)
      assert(st.detail && st.detail.length > 30, `${p.id}: step "${st.title}" has no detail`)
      assert(Number(st.min) > 0, `${p.id}: step "${st.title}" has no time`)
      minutes += Number(st.min)
    }
    // the print step must dominate: a guide that forgets the printer is a lie
    assert(minutes >= analysis.print.hours * 40, `${p.id}: ${minutes} min of work for ${Math.round(analysis.print.hours)}h of printing`)
  })
  return `${A.PRESETS.length} build orders complete`
})

// ── 20. no step tells you to use a material you did not choose ──────────────
check('build steps name only the chosen material', () => {
  const NAMES = [['PLA', 'PLA'], ['PETG', 'PETG'], ['ASA', 'ASA'], ['PETG-CF', 'PETG-CF'], ['PETGCF', 'PETG-CF']]
  eachPreset((p, { design, analysis }) => {
    const chosen = analysis.print.material.name.toUpperCase()
    const text = A.stepsFor(design, analysis).map((s) => `${s.title} ${s.detail}`).join(' ')
    for (const [pattern, label] of NAMES) {
      if (label === chosen) continue
      const re = new RegExp(`\\b${pattern.replace('-', '\\-')}\\b`, 'i')
      assert(!re.test(text), `${p.id}: step mentions ${label} but the build is ${chosen}`)
    }
  })
  return 'every guide matches the material in the BOM'
})

// ── 21. the simulation exports describe the same machine ────────────────────
check('URDF/MJCF: one link per joint, real limits, an actuator per driven joint', () => {
  let checked = 0
  eachPreset((p, { design, analysis }) => {
    const urdf = A.toURDF ? A.toURDF(design, analysis) : ''
    const mjcf = A.toMJCF ? A.toMJCF(design, analysis) : ''
    assert(urdf.startsWith('<?xml') && urdf.includes('<robot'), `${p.id}: no URDF`)
    assert(mjcf.includes('<mujoco'), `${p.id}: no MJCF`)
    const links = (urdf.match(/<link /g) || []).length
    const joints = (urdf.match(/<joint /g) || []).length
    assert(links === design.joints.length + 1, `${p.id}: ${links} links for ${design.joints.length} joints`)
    assert(joints === design.joints.length, `${p.id}: ${joints} URDF joints vs ${design.joints.length} in the design`)
    for (const m of urdf.matchAll(/<limit[^>]*effort="([\d.]+)"/g)) {
      assert(Number(m[1]) > 0, `${p.id}: a joint has zero effort and cannot move`)
    }
    const motors = (mjcf.match(/<motor /g) || []).length
    assert(motors === design.joints.length || motors === 0, `${p.id}: ${motors} motors for ${design.joints.length} joints`)
    checked += 1
  })
  return `${checked} machines exported with matching topology`
})

// ── 22. mesh parts resolve to real geometry, not to a silent fallback ───────
check('imported CAD meshes are present and non-degenerate', () => {
  const parts = A.RF_PARTS || {}
  const names = Object.keys(parts)
  let used = 0
  eachPreset((p, { design }) => {
    for (const n of design.nodes) {
      if (n.kind !== 'mesh') continue
      used += 1
      const table = parts[n.part]
      assert(table, `${p.id}: node ${n.id} wants mesh "${n.part}" which is not vendored`)
      assert(table.tris.length % 9 === 0 && table.tris.length > 0, `${p.id}: ${n.part} has a broken triangle table`)
      assert(table.scale > 0, `${p.id}: ${n.part} has no scale`)
    }
  })
  return `${used} mesh nodes across the archetypes, ${names.length} vendored part(s)`
})

// ── 23. teleop: every articulated archetype gets an honest mode ─────────────
check('teleop coverage: wheels drive, arm reaches, legs walk, jaw grips', () => {
  const kind = (arch) => {
    const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === arch).brief })
    if (A.createDrive(design, analysis)) return 'drive'
    if (A.createArmTeleop(design)) return 'ik'
    if (A.createGaitTeleop(design)) return 'gait'
    if (A.createGripTeleop(design)) return 'grip'
    return null
  }
  const got = { rover: kind('rover'), robot: kind('robot'), arm: kind('arm'), quadruped: kind('quadruped'), humanoid: kind('humanoid'), gripper: kind('gripper') }
  assert(got.rover === 'drive', `rover teleop: ${got.rover}`)
  assert(got.robot === 'drive', `robot teleop: ${got.robot}`)
  assert(got.arm === 'ik', `arm teleop: ${got.arm}`)
  assert(got.quadruped === 'gait', `quadruped teleop: ${got.quadruped}`)
  assert(got.humanoid === 'gait', `humanoid teleop: ${got.humanoid}`)
  assert(got.gripper === 'grip', `gripper teleop: ${got.gripper}`)
  return '6 archetypes interactive: ' + Object.entries(got).map(([k, v]) => `${k}:${v}`).join(' ')
})

// ── 24. IK reach converges on a reachable target, inside joint limits ───────
check('IK reach: end-effector converges <5mm, joints stay in limits', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const ik = A.createArmTeleop(design)
  assert(ik, 'arm offers no IK teleop')
  let actual = design.joints.map(() => 0)
  ik.step({ x: 0, y: 0, z: 0 }, 1 / 60, actual) // anchor at the rest tip
  for (let i = 0; i < 48; i++) { const d = ik.step({ x: 0.3, y: 0, z: -0.2 }, 1 / 60, actual); if (d) actual = d }
  for (let i = 0; i < 240; i++) { const d = ik.step({ x: 0.13, y: 0, z: -0.13 }, 1 / 60, actual); if (d) actual = d }
  assert(ik.state.err < 5, `IK error ${ik.state.err.toFixed(1)}mm — should settle under 5mm`)
  design.joints.forEach((j, i) => assert(actual[i] >= j.min - 1 && actual[i] <= j.max + 1, `${j.id} at ${actual[i].toFixed(1)}° outside [${j.min},${j.max}]`))
  return `err ${ik.state.err.toFixed(1)}mm on target ${ik.state.tx.toFixed(0)},${ik.state.ty.toFixed(0)},${ik.state.tz.toFixed(0)}`
})

// ── 25. drive physics: ice stalls, hardwood climbs, payload steals grade ────
check('drive physics: wet ice stalls where hardwood climbs', () => {
  // unladen rover — the 2 kg payload preset honestly cannot climb 20°
  const { design, analysis } = A.composeDesign({ ...A.DEFAULT_BRIEF, archetype: 'rover' })
  const run = (env, secs) => {
    const d = A.createDrive(design, analysis)
    d.setEnv(env)
    for (let i = 0; i < 140; i++) d.step({ throttle: 1, steer: 0 }, 1 / 60) // reach the ramp
    const x0 = d.state.x
    for (let i = 0; i < secs * 60; i++) d.step({ throttle: 1, steer: 0 }, 1 / 60)
    return { dx: d.state.x - x0, stall: d.state.stall, slip: d.state.slip }
  }
  const ice = run({ surface: 'ice', slopeDeg: 20 }, 6)
  const wood = run({ surface: 'hardwood', slopeDeg: 20 }, 6)
  assert(ice.stall || ice.slip, 'ice 20° should stall or wheelspin')
  assert(ice.dx < 0.6, `ice 20° gained ${ice.dx.toFixed(2)}m — should barely move`)
  assert(wood.dx > 0.6, `hardwood 20° gained only ${wood.dx.toFixed(2)}m — should climb`)
  return `ice +${ice.dx.toFixed(2)}m (${ice.stall ? 'stall' : 'slip'}), hardwood +${wood.dx.toFixed(2)}m`
})

// ── 25b. living-room course: threshold climbs, props block, bumps count ────
check('living-room course: obstacles stop the chassis and count bumps', () => {
  const { design, analysis } = A.composeDesign({ ...A.DEFAULT_BRIEF, archetype: 'rover' })
  const d = A.createDrive(design, analysis)
  d.setEnv({ course: 'room', surface: 'hardwood', slopeDeg: 0, payloadKg: 0 })
  // centre lane is blocked by the toy bin — a straight driver must stop
  for (let i = 0; i < 60 * 12; i++) d.step({ throttle: 1, steer: 0 }, 1 / 60)
  assert(d.state.bumps >= 1, `centre lane: expected bumps, got ${d.state.bumps}`)
  assert(d.state.x < 2.6, `centre lane reached x=${d.state.x.toFixed(2)} — drove through a prop`)
  // the wide-left lane is clear — same machine, offset start, runs the course
  const d2 = A.createDrive(design, analysis)
  d2.setEnv({ course: 'room', surface: 'hardwood', slopeDeg: 0, payloadKg: 0 })
  d2.state.y = 0.5
  for (let i = 0; i < 60 * 10; i++) d2.step({ throttle: 1, steer: 0 }, 1 / 60)
  assert(d2.state.x > 5, `wide lane only reached x=${d2.state.x.toFixed(2)} — corridor should be open`)
  assert(d2.state.bumps === 0, `wide lane bumped ${d2.state.bumps}× — should be clear`)
  return `centre pinned at x=${d.state.x.toFixed(2)} (${d.state.bumps} bumps), wide lane x=${d2.state.x.toFixed(2)}`
})

// ── 25c. sensor bench: fitted sensors read injected stimulus, alerts fire ──
check('sensor bench: stimulus drives readings and threshold alerts', () => {
  const iot = A.PRESETS.find((p) => p.id === 'iot')
  const { design } = A.composeDesign({ ...iot.brief, mission: 'a plant sensor that reports soil moisture and temperature' })
  const t = A.createSensorTeleop(design)
  assert(t, 'iot design offers no sensor teleop')
  assert(t.fields.length >= 3, `expected temp+humid+soil fields, got ${t.fields.length}`)
  t.set('humid', 96)
  t.set('soil', 12)
  const h = t.hud()
  assert(h.alerts.length >= 2, `expected humidity+soil alerts, got ${h.alerts.length}: ${h.alerts}`)
  assert(/\d/.test(h.oled) && !/node/.test(h.oled), `oled line should lead with a sensor reading: ${h.oled}`)
  t.reset()
  assert(t.hud().alerts.length === 0, 'reset should clear alerts')
  return `${t.fields.length} stimulus fields, alerts: ${h.alerts.join('; ')}`
})

// ── 26. gait: legs cycle within joint limits, diagonal pairs phase-locked ───
check('gait: quadruped trot moves all legs inside limits', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'quadruped').brief })
  const g = A.createGaitTeleop(design)
  assert(g, 'quadruped offers no gait teleop')
  let actual = design.joints.map(() => 0)
  const lo = actual.slice(), hi = actual.slice()
  let moved = 0
  for (let i = 0; i < 600; i++) {
    const d = g.step({ x: 1 }, 1 / 60, actual)
    if (d) {
      actual = d; moved += 1
      for (let k = 0; k < actual.length; k++) { if (actual[k] < lo[k]) lo[k] = actual[k]; if (actual[k] > hi[k]) hi[k] = actual[k] }
    }
  }
  assert(moved > 300, `gait only commanded ${moved} frames`)
  design.joints.forEach((j, i) => assert(actual[i] >= j.min - 1 && actual[i] <= j.max + 1, `${j.id} at ${actual[i].toFixed(1)}° outside [${j.min},${j.max}]`))
  const swing = (id) => { const i = design.joints.findIndex((j) => j.id === id); return hi[i] - lo[i] }
  assert(swing('femur-fl') > 10 && swing('tibia-rr') > 10, `legs barely move: femur-fl ${swing('femur-fl').toFixed(1)}°, tibia-rr ${swing('tibia-rr').toFixed(1)}°`)
  return `${g.state.strides.toFixed(1)} strides, femur swing ${swing('femur-fl').toFixed(0)}°, all joints inside limits`
})

// ── 26b. locomotion: legs traverse the bench courses with honest limits ────
check('locomotion: quadruped walks, derates on grade/ice, blocked by stairs', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'quadruped').brief })
  const g = A.createGaitTeleop(design)
  assert(g && g.locomote, 'quadruped gait offers no locomotion')
  let actual = design.joints.map(() => 0)
  const run = (env, secs, cmd) => {
    for (let i = 0; i < secs * 60; i++) {
      const r = g.locomote(cmd || { x: 1 }, 1 / 60, actual, env)
      if (r && r.pose) actual = r.pose
    }
    return { ...g.locomoteState } // snapshot — the live object keeps mutating
  }
  g.reset(); actual = design.joints.map(() => 0)
  const flat = run({ surface: 'hardwood', slopeDeg: 0, course: 'rack' }, 3)
  assert(flat.x > 0.8, `walked only ${flat.x.toFixed(2)}m in 3s`)
  assert(Math.abs(flat.v - 0.39) < 0.08, `cruise ${flat.v.toFixed(2)} m/s — gait kinematics say ~0.39`)
  const ice = run({ surface: 'ice', slopeDeg: 0, course: 'rack' }, 3)
  assert(ice.slip && ice.v < flat.v * 0.6, `ice should slip and crawl: v=${ice.v.toFixed(2)} slip=${ice.slip}`)
  g.reset(); actual = design.joints.map(() => 0)
  const stairs = run({ surface: 'hardwood', slopeDeg: 0, course: 'stairs' }, 10)
  assert(stairs.x < 1.8 && stairs.stall && stairs.bumps > 0, `small quad should be stopped by 80mm risers: x=${stairs.x.toFixed(2)} bumps=${stairs.bumps} stall=${stairs.stall}`)
  return `flat ${flat.x.toFixed(2)}m @${flat.v.toFixed(2)}m/s · ice ${ice.v.toFixed(2)}m/s slip · stairs blocked @x=${stairs.x.toFixed(2)}`
})

check('locomotion: tall humanoid climbs porch stairs the quad cannot', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'humanoid').brief })
  const g = A.createGaitTeleop(design)
  assert(g && g.locomote, 'humanoid gait offers no locomotion')
  let actual = design.joints.map(() => 0)
  for (let i = 0; i < 60 * 12; i++) {
    const r = g.locomote({ x: 1 }, 1 / 60, actual, { surface: 'hardwood', slopeDeg: 0, course: 'stairs' })
    if (r && r.pose) actual = r.pose
  }
  const st = g.locomoteState
  assert(st.x > 3.0, `humanoid should top the stair flight: x=${st.x.toFixed(2)}`)
  return `topped stairs at x=${st.x.toFixed(2)} — leg reach decides, not motors`
})

// ── 27. endurance: sustained load cooks servos to cutoff, pack drains ───────
check('endurance: sustained stall-load triggers thermal cutoff, SoC drains', () => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const pwr = A.createPowerSim(design)
  assert(pwr, 'arm has a battery — power sim should exist')
  const sim = A.createJointSim(design, analysis)
  sim.snap(design.joints.map(() => design.joints[0].max * 0.85))
  let soc0 = pwr.state.soc
  for (let i = 0; i < 60 * 30; i++) {
    sim.step(1 / 60, i * 16)
    pwr.step(1 / 60, sim.state, 0)
    sim.state.thermal = pwr.state.cut
  }
  const h = pwr.hud()
  assert(h.cuts > 0, 'no servo hit thermal cutoff under 30s sustained load')
  assert(h.tempMax >= 80, `peak joint temp ${h.tempMax.toFixed(0)}°C — cutoff should engage`)
  assert(h.soc < soc0, `SoC did not drain: ${soc0} → ${h.soc}`)
  assert(h.vbus < 12, `bus voltage did not sag: ${h.vbus.toFixed(1)}V`)
  return `peak ${h.tempMax.toFixed(0)}°C, ${h.cuts} cutout(s), SoC ${soc0.toFixed(0)}→${h.soc.toFixed(1)}%, bus ${h.vbus.toFixed(1)}V`
})

// ── 30/31. autopilot certification scores maneuvers honestly ───────────────
const runAutotest = (env) => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'rover').brief })
  const drive = A.createDrive(design, analysis)
  drive.setEnv(env || {})
  const at = A.createAutotest(drive)
  at.start()
  for (let i = 0; i < 60 * 20 && at.running; i++) drive.step(at.tick(1 / 60), 1 / 60)
  return at
}

check('autotest: rover passes the certification suite on a real climb', () => {
  const at = runAutotest({ surface: 'hardwood', slopeDeg: 10 })
  assert(at.done, 'autotest did not finish within 20s sim')
  assert(at.results.length === 6, `expected 6 phase results, got ${at.results.length}`)
  const fails = at.results.filter((r) => !r.pass)
  assert(fails.length === 0, `unexpected failures: ${fails.map((f) => `${f.label}(${f.detail})`).join(', ')}`)
  return `${at.score} — ${at.results.map((r) => `${r.label}:${r.detail}`).join(' · ')}`
})

check('autotest: wet-ice ramp fails the climb check honestly', () => {
  const at = runAutotest({ surface: 'ice', slopeDeg: 10 })
  assert(at.done, 'autotest did not finish')
  const climb = at.results.find((r) => r.id === 'climb')
  assert(climb && !climb.pass, `climb passed on wet ice — ${climb && climb.detail}`)
  return `climb FAIL — ${climb.detail}`
})

// ── 32. stairs course: risers taller than wheel bite block honestly ─────────
check('stairs: 80mm nosing blocks a 100mm-wheel chassis', () => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'rover').brief })
  const drive = A.createDrive(design, analysis)
  drive.setEnv({ course: 'stairs' })
  let stalled = false
  for (let i = 0; i < 60 * 10; i++) {
    drive.step({ throttle: 1, steer: 0 }, 1 / 60)
    if (drive.state.stall) stalled = true
  }
  const s = drive.state
  assert(s.bumps > 0, 'never registered a stair hit')
  assert(stalled, 'never flagged stall at the nosing')
  assert(s.x < 1.9, `rode through the stairs to x=${s.x.toFixed(2)}`)
  assert(s.z < 0.01, `climbed to z=${s.z.toFixed(2)} without wheel bite`)
  return `blocked at x=${s.x.toFixed(2)}, ${s.bumps} bumps, stall=${stalled}`
})

// ── 33-36. autopilot certification covers every teleop kind ────────────────
const presetDesign = (archetype) => A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === archetype).brief })

check('autotest reach: arm tour scores reach AND lift capacity per desk prop', () => {
  const { design } = presetDesign('arm')
  const ik = A.createArmTeleop(design)
  const at = A.createAutotest(ik)
  at.start()
  let actual = design.joints.map(() => 0)
  for (let i = 0; i < 60 * 50 && at.running; i++) {
    const c = at.tick(1 / 60, actual)
    const pose = c && c.pose ? c.pose : (c ? ik.step(c, 1 / 60, actual) : null)
    if (pose) pose.forEach((a, j) => { actual[j] = a }) // engine has no servo lag — apply instantly
  }
  assert(at.done, 'reach tour did not finish')
  assert(at.results.length === 7, `expected 7 results (3 reach + home + 3 lift), got ${at.results.length}`)
  const steel = at.results.find((r) => r.id === 'reach-steel')
  assert(steel && steel.pass, `arm should reach the steel block — ${steel && steel.detail}`)
  const bin = at.results.find((r) => r.id === 'reach-bin')
  assert(bin && !bin.pass, `parts bin should be honestly unreachable for this arm — ${bin && bin.detail}`)
  // the lift legs must differentiate by mass: 80g bin passes on stall margin,
  // the 1.2kg steel block must fail — reaching is not lifting
  const liftBin = at.results.find((r) => r.id === 'lift-bin')
  const liftSteel = at.results.find((r) => r.id === 'lift-steel')
  assert(liftBin && liftBin.pass, `80g bin should be liftable — ${liftBin && liftBin.detail}`)
  assert(liftSteel && !liftSteel.pass, `1.2kg steel should fail the torque check — ${liftSteel && liftSteel.detail}`)
  assert(/stall|carry/.test(liftSteel.detail), 'lift verdict lacks the measured margin')
  return at.results.map((r) => `${r.label}:${r.pass ? 'P' : 'F'}(${r.detail})`).join(' · ')
})

check('autotest gait: quadruped locomotion suite passes on rack', () => {
  const { design } = presetDesign('quadruped')
  const gait = A.createGaitTeleop(design)
  const at = A.createAutotest(gait)
  at.start()
  let actual = design.joints.map(() => 0)
  const env = { surface: 'hardwood', slopeDeg: 8, course: 'rack' }
  for (let i = 0; i < 60 * 25 && at.running; i++) {
    const c = at.tick(1 / 60)
    const r = gait.locomote(c, 1 / 60, actual, env)
    if (r && r.pose) actual = r.pose
  }
  assert(at.done, 'gait locomotion test did not finish')
  const fails = at.results.filter((r) => !r.pass)
  assert(fails.length === 0, `gait failures: ${fails.map((r) => `${r.label}(${r.detail})`).join(',')}`)
  return `${at.score} — ${at.results.map((r) => `${r.label}:${r.detail}`).join(' · ')}`
})

check('autotest gait: quad honestly fails porch stairs, humanoid climbs', () => {
  const env = { surface: 'hardwood', slopeDeg: 0, course: 'stairs' }
  const run = (arch) => {
    const { design } = presetDesign(arch)
    const gait = A.createGaitTeleop(design)
    const at = A.createAutotest(gait)
    at.start()
    let actual = design.joints.map(() => 0)
    for (let i = 0; i < 60 * 25 && at.running; i++) {
      const c = at.tick(1 / 60)
      const r = gait.locomote(c, 1 / 60, actual, env)
      if (r && r.pose) actual = r.pose
    }
    return at.results.find((r) => r.id === 'obstacle')
  }
  const quad = run('quadruped')
  const hum = run('humanoid')
  assert(quad && quad.pass, `quad obstacle check should pass-by-blocking: ${quad && quad.detail}`)
  assert(/can't mount|blocked/i.test(quad.detail), `quad should report an honest block, got: ${quad.detail}`)
  assert(hum && hum.pass, `humanoid should top the flight: ${hum && hum.detail}`)
  return `quad: ${quad.detail} · humanoid: ${hum.detail}`
})

check('autotest grip: jaw cycles open/closed on command', () => {
  const { design } = presetDesign('gripper')
  const grip = A.createGripTeleop(design)
  const at = A.createAutotest(grip)
  at.start()
  for (let i = 0; i < 60 * 15 && at.running; i++) grip.step(at.tick(1 / 60))
  assert(at.done && at.results[0] && at.results[0].pass, `jaw test: ${at.results[0] && at.results[0].detail}`)
  return at.results[0].detail
})

check('autotest sense: stimulus sweep fires a real threshold alert', () => {
  const { design } = presetDesign('iot')
  const sense = A.createSensorTeleop(design)
  const at = A.createAutotest(sense)
  at.start()
  for (let i = 0; i < 60 * 10 && at.running; i++) at.tick(1 / 60)
  assert(at.done && at.results[0] && at.results[0].pass, `sense test: ${at.results[0] && at.results[0].detail}`)
  return at.results[0].detail
})

// ── 33. one machine, one mass ────────────────────────────────────────────────
check('bench CoM: the stability line reports the same mass as the header', () => {
  let checked = 0
  eachPreset((p, { design, analysis }) => {
    const rep = A.benchReport(design, analysis, {})
    assert(Math.abs(rep.massG - analysis.mass.totalG) < 0.5,
      `${p.id}: stability panel says ${Math.round(rep.massG)}g, header says ${Math.round(analysis.mass.totalG)}g`)
    // the verdict is about geometry. Scaling the total must not move the margin,
    // or the pass/fail depends on which mass model happened to run.
    const dbl = A.benchReport(design, { ...analysis, mass: { ...analysis.mass, totalG: analysis.mass.totalG * 2 } }, {})
    assert(Math.abs(dbl.flatMm - rep.flatMm) < 1e-6,
      `${p.id}: CoM margin moved ${rep.flatMm} -> ${dbl.flatMm} when only the total mass changed`)
    checked += 1
  })
  return `${checked} machines report one mass, and the margin ignores scale`
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}${r.ok ? ` — ${r.detail}` : ''}`)
  if (!r.ok) console.log(`      ${r.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} claims hold`)
process.exit(failed.length ? 1 : 0)
