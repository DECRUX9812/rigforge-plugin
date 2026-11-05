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

// ── 28. the fast transform is the same transform ────────────────────────────
check('node transform: the affine matrix agrees with rotEuler + applyChain, rest and posed', () => {
  let checked = 0
  eachPreset((p, { design }) => {
    // pose every joint somewhere odd, then compare the two paths point by point
    design.joints.forEach((j, i) => {
      const span = j.max - j.min
      j.angle = Math.round(j.min + ((i * 37) % 100) / 100 * span)
    })
    const chains = A.chainsFor(design)
    for (const node of design.nodes) {
      if (!node.pos) continue
      const chain = node.joint ? chains.get(node.joint) : null
      const slide = A.slideDisp(design, node)
      const { m, t } = A.nodeAffine(node, chain, slide, null)
      for (const pt of [[0, 0, 0], [7.5, -3, 12], [-11, 4.25, 0.5]]) {
        const fast = [
          m[0] * pt[0] + m[1] * pt[1] + m[2] * pt[2] + t[0],
          m[3] * pt[0] + m[4] * pt[1] + m[5] * pt[2] + t[1],
          m[6] * pt[0] + m[7] * pt[1] + m[8] * pt[2] + t[2],
        ]
        const q = A.rotEuler(pt, node.rot)
        const slow = A.applyChain(chain, [q[0] + node.pos[0] + slide[0], q[1] + node.pos[1] + slide[1], q[2] + node.pos[2] + slide[2]])
        for (let i = 0; i < 3; i += 1) {
          assert(Math.abs(fast[i] - slow[i]) < 1e-6, `${p.id}/${node.id}: transform drift ${fast[i]} vs ${slow[i]}`)
        }
        checked += 1
      }
    }
  })
  return `${checked} node points identical between the matrix and the reference path`
})

// ── 29. OpenSCAD is a file a maker can work in ──────────────────────────────
check('OpenSCAD export: one named module per node, each instantiated once, every archetype', () => {
  let total = 0
  eachPreset((p, { design }) => {
    const scad = A.toOpenSCAD(design)
    const modules = [...scad.matchAll(/^module (p_\w+)\(\)/gm)].map((m) => m[1])
    const calls = [...scad.matchAll(/^  (p_\w+)\(\);/gm)].map((m) => m[1])
    assert(modules.length === design.nodes.length, `${p.id}: ${modules.length} modules for ${design.nodes.length} nodes`)
    assert(new Set(modules).size === modules.length, `${p.id}: duplicate module name — one part would shadow another`)
    assert(calls.length === modules.length, `${p.id}: ${calls.length} instantiations for ${modules.length} modules`)
    for (const m of modules) {
      assert(calls.filter((c) => c === m).length === 1, `${p.id}: module ${m} instantiated ${calls.filter((c) => c === m).length} times`)
    }
    assert(scad.split('{').length === scad.split('}').length, `${p.id}: unbalanced braces in the SCAD file`)
    assert(scad.includes('PART = "all"') && scad.includes('module assembly()'), `${p.id}: no PART switch / assembly`)
    total += modules.length
  })
  return `${total} named modules across ten machines`
})

// ── 30. a brief that names no machine says so ──────────────────────────────
check('unmatched briefs warn instead of building silently; load-carrying prose lands on a rover', () => {
  const cases = [
    ['asdkjhaskjd qwpoeiru zxcv', 'gadget', false],
    ['a superyacht with a helipad', 'gadget', false],
    ['a rover that maps my room', 'rover', true],
    ['12-servo quadruped that trots', 'quadruped', true],
    ['a robot that carries 500 kg of soil', 'rover', true],
    ['a cart that hauls 40kg of bricks', 'rover', true],
  ]
  for (const [text, archetype, matched] of cases) {
    const brief = A.parseBrief(text)
    assert(brief.archetype === archetype, `"${text}" → ${brief.archetype}, expected ${archetype}`)
    assert(brief.archetypeMatched === matched, `"${text}" matched=${brief.archetypeMatched}, expected ${matched}`)
    const { analysis } = A.composeDesign(brief)
    const told = analysis.checks.some((c) => /did not name a machine/i.test(c.msg))
    assert(told === !matched, `"${text}" warning=${told}, expected ${!matched}`)
  }
  return '6 briefs classified, and every unmatched one is told to the user'
})

// ── 31. baked occlusion is real occlusion ──────────────────────────────────
check('baked AO: an enclosed corner is darker than open sky, and the bake is deterministic', () => {
  const quad = (a, b, c, d, mat) => [
    { pts: [a, b, c], mat }, { pts: [a, c, d], mat },
  ]
  // an open plane, sitting in the air
  const open = quad([0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0], 'shell')
  // a crevice: a 4 mm slot between two plates, which is what a servo sitting on
  // a plate actually looks like from the plate's point of view
  const corner = [
    ...quad([0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0], 'shell'),
    ...quad([0, 40, 4], [40, 40, 4], [40, 0, 4], [0, 0, 4], 'shell'),
  ]
  const aoOpen = A.bakeVertexAO(open, { maxDist: 7 })
  const aoCorner = A.bakeVertexAO(corner, { maxDist: 7 })
  const mean = (a) => Array.from(a).reduce((s, v) => s + v, 0) / a.length
  const mOpen = mean(aoOpen)
  const mCorner = mean(aoCorner)
  assert(mOpen > 0.9, `an open plane should see the sky, got ${mOpen.toFixed(2)}`)
  assert(mCorner < mOpen - 0.08, `the corner must be darker than the open plane (${mCorner.toFixed(2)} vs ${mOpen.toFixed(2)})`)
  for (const v of aoOpen) assert(v >= 0 && v <= 1, 'AO outside 0..1')
  // deterministic: bake again on the same mesh object uses the cache, a fresh
  // copy must produce identical values
  const again = A.bakeVertexAO(corner.map((t) => ({ ...t, pts: t.pts.map((p) => p.slice()) })), { maxDist: 7 })
  for (let i = 0; i < aoCorner.length; i += 1) {
    assert(Math.abs(aoCorner[i] - again[i]) < 1e-6, 'bake is not deterministic')
  }
  return `open ${mOpen.toFixed(2)} vs crevice ${mCorner.toFixed(2)}`
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}${r.ok ? ` — ${r.detail}` : ''}`)
  if (!r.ok) console.log(`      ${r.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} claims hold`)
process.exit(failed.length ? 1 : 0)
