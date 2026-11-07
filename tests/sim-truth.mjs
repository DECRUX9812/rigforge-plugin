// Simulation truth — the motion layer, probed the same way truth.mjs probes the
// numbers. A renderer that moves is not a simulator; a simulator is one whose
// motion can be predicted, so every claim here recomputes an outcome from the
// datasheet values and the joint statics rather than trusting the sim's own HUD.
//
// Rule for this file: if a claim cannot be recomputed independently of the code
// that produced it, it does not belong here.
import { loadEngine } from './lib-engine.mjs'

const A = loadEngine()
const results = []
function check(claim, fn) {
  try {
    const detail = fn()
    results.push({ claim, ok: true, detail: detail || '' })
  } catch (e) {
    results.push({ claim, ok: false, detail: e.message })
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
const near = (a, b, tol) => Math.abs(a - b) <= tol

const DESIGN = (id) => {
  const p = A.PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`no preset ${id}`)
  return A.composeDesign({ ...p.brief })
}

// ── 1. a joint never slews faster than the servo it is built from ───────────
check('sim: no joint slews faster than its own servo can turn', () => {
  const { design, analysis } = DESIGN('arm')
  const sim = A.createJointSim(design, analysis)
  const acts = design.actuators || []
  // find the joint with the slowest servo and drive it hard in one direction
  let worst = null
  design.joints.forEach((j, i) => {
    const a = acts.find((x) => x.label === j.label)
    if (!a || !a.servo) return
    const part = A.PARTS[a.servo]
    if (!part || !part.speed) return
    const rated = 60 / part.speed // deg/s at zero load
    const dt = 1 / 120
    sim.snap(design.joints.map(() => 0))
    const targets = design.joints.map(() => 0)
    targets[i] = j.max
    sim.setTargets(targets)
    let fastest = 0
    for (let step = 0; step < 240; step += 1) {
      sim.step(dt, step * dt * 1000)
      fastest = Math.max(fastest, Math.abs(sim.state.vel[i]))
    }
    if (!worst || fastest / rated > worst.ratio) worst = { j: j.id, fastest, rated, ratio: fastest / rated }
  })
  assert(worst, 'no joint with a datasheet servo speed')
  assert(worst.ratio <= 1.001, `${worst.j}: ${worst.fastest.toFixed(1)}°/s beats its ${worst.rated.toFixed(1)}°/s servo`)
  return `worst case ${worst.j} at ${(worst.ratio * 100).toFixed(0)}% of rated speed`
})

// ── 2. the stall flag never lies, in either direction ───────────────────────
check('sim: a joint is flagged stalled if and only if it fell short', () => {
  const { design, analysis } = DESIGN('arm')
  const sim = A.createJointSim(design, analysis)
  sim.snap(design.joints.map(() => 0))
  sim.setTargets(design.joints.map((j) => j.max))
  for (let step = 0; step < 1500; step += 1) sim.step(1 / 60, step * 16)
  const rows = design.joints.map((j, i) => ({
    id: j.id,
    err: Math.abs(sim.state.targets[i] - sim.state.angles[i]),
    stalled: sim.state.stalled[i],
    load: sim.state.loadNm[i],
    stall: sim.state.stallNm[i],
  }))
  for (const r of rows) {
    if (r.stalled) assert(r.err > 0.01, `${r.id} is flagged stalled but arrived at its target — a false alarm`)
    if (r.err > 0.5) assert(r.stalled, `${r.id} fell ${r.err.toFixed(1)}° short and is not flagged`)
    assert(Number.isFinite(sim.state.angles[0]), 'non-finite angle')
  }
  const near = rows.filter((r) => r.stall > 0 && r.load / r.stall > 0.7)
  return near.length
    ? `${rows.length} joints honest · ${near.length} above 70% of stall: ${near.map((r) => `${r.id} ${(100 * r.load / r.stall).toFixed(0)}%`).join(', ')}`
    : `${rows.length} joints honest · none loaded past 70% of stall`
})

// ── 3. the motion is deterministic ──────────────────────────────────────────
check('sim: two identical sims stepped identically produce identical motion', () => {
  const { design, analysis } = DESIGN('humanoid')
  const a = A.createJointSim(design, analysis)
  const b = A.createJointSim(design, analysis)
  const targets = design.joints.map((j, i) => (i % 2 ? j.max * 0.4 : j.min * 0.4))
  a.setTargets(targets); b.setTargets(targets)
  for (let step = 0; step < 300; step += 1) { a.step(1 / 60, step * 16.7); b.step(1 / 60, step * 16.7) }
  for (let i = 0; i < a.state.angles.length; i += 1) {
    assert(a.state.angles[i] === b.state.angles[i], `joint ${i} diverged: ${a.state.angles[i]} vs ${b.state.angles[i]}`)
  }
  return `${a.state.angles.length} joints agree exactly after 5s`
})

// ── 4. the bench reports the BOM's mass, not a geometry sum ────────────────
check('sim: CoM is the geometric distribution; the reported mass is the BOM', () => {
  const { design, analysis } = DESIGN('rover')
  const mat = (analysis.print && analysis.print.material) || { density: 1.27 }
  const chains = A.chainsFor(design)
  let m = 0
  const c = [0, 0, 0]
  for (const n of design.nodes) {
    const g = A.benchNodeMassG(design, n, mat)
    if (!(g > 0)) continue
    const w = A.benchNodeWorld(design, chains, n)
    m += g
    c[0] += w[0] * g; c[1] += w[1] * g; c[2] += w[2] * g
  }
  assert(m > 0, 'no mass in the design')
  const manual = [c[0] / m, c[1] / m, c[2] / m]
  const bench = A.benchCoM(design, mat)
  const d = Math.hypot(manual[0] - bench.com[0], manual[1] - bench.com[1], manual[2] - bench.com[2])
  assert(d < 0.5, `CoM differs by ${d.toFixed(2)}mm`)
  // geometry nodes stand in for purchased parts (a motor modelled as a metal
  // can), so the node sum runs heavy. The bench must still report the number on
  // the BOM — two masses for one machine is the bug this asserts against.
  assert(near(bench.massG, analysis.mass.totalG, 1),
    `bench says ${bench.massG.toFixed(0)}g, BOM says ${analysis.mass.totalG.toFixed(0)}g`)
  return `com within ${d.toFixed(2)}mm · bench ${bench.massG.toFixed(0)}g = BOM · node sum ${m.toFixed(0)}g (geometry stand-ins)`
})

// ── 5. a shove delivers the impulse it claims ───────────────────────────────
check('sim: a shove changes lateral speed by F·Δt/mass', () => {
  const { design, analysis } = DESIGN('rover')
  const drive = A.createDrive(design, analysis)
  assert(drive && drive.shove, 'no drive sim to shove')
  const m = drive.state && drive.state.massG ? drive.state.massG / 1000 : (design.metrics.massKg || 1)
  const before = drive.state.vl
  drive.shove(12)
  const dv = drive.state.vl - before
  const expect = (12 * 0.25) / m
  assert(near(dv, expect, Math.max(0.02, Math.abs(expect) * 0.05)),
    `12N shove moved lateral speed ${dv.toFixed(3)} m/s, expected ${expect.toFixed(3)} for ${m.toFixed(2)}kg`)
  return `12N → ${dv.toFixed(3)} m/s on ${m.toFixed(2)}kg`
})

// ── 6. cargo is weight the joints actually feel ────────────────────────────
check('sim: a carried payload loads the joints, and enough of it stalls one', () => {
  const p = A.PRESETS.find((x) => x.id === 'arm')
  const run = (payload) => {
    const { design, analysis } = A.composeDesign({ ...p.brief, payloadKg: payload })
    const sim = A.createJointSim(design, analysis)
    sim.snap(design.joints.map(() => 0))
    sim.setTargets(design.joints.map(() => 0))
    for (let step = 0; step < 240; step += 1) sim.step(1 / 60, step * 16)
    const i = design.joints.findIndex((j) => /wrist-pitch/.test(j.id))
    return { load: sim.state.loadNm[i], stalled: sim.state.stalled.filter(Boolean).length }
  }
  const empty = run(0)
  const loaded = run(6)
  assert(loaded.load > empty.load * 3, `6kg barely changed the wrist load: ${empty.load.toFixed(2)} → ${loaded.load.toFixed(2)} N·m`)
  assert(loaded.stalled >= 1, 'a 6kg payload stalled nothing — the stall branch is unreachable')
  return `wrist load ${empty.load.toFixed(2)} → ${loaded.load.toFixed(2)} N·m · ${loaded.stalled} joint(s) stalled at 6kg`
})

// ── 7. a parked machine holds the friction angle and not one degree more ────
check('sim: a parked rover holds at the friction angle, slides past it', () => {
  const { design, analysis } = DESIGN('rover')
  const drive = A.createDrive(design, analysis)
  const mu = A.DRIVE_SURFACES.hardwood.mu
  const frictionDeg = (Math.atan(mu) * 180) / Math.PI
  const settle = (deg) => {
    const d = A.createDrive(design, analysis)
    d.setEnv({ surface: 'hardwood', slopeDeg: deg })
    // put it ON the ramp: the rack is flat until x = 1.4, so a machine parked at
    // the origin is on level ground and the claim would be vacuous
    d.state.x = 2.2
    for (let i = 0; i < 240; i += 1) d.step({ throttle: 0, steer: 0 }, 1 / 60)
    return d.state
  }
  const held = settle(Math.max(1, frictionDeg - 1))
  const slipped = settle(frictionDeg + 6)
  assert(Math.abs(held.v) < 0.02, `parked at ${(frictionDeg - 1).toFixed(0)}° (< friction angle ${frictionDeg.toFixed(0)}°) but slid at ${held.v.toFixed(3)} m/s`)
  assert(Math.abs(slipped.v) > 0.05, `parked at ${(frictionDeg + 6).toFixed(0)}° (> friction angle) and did not slide — friction ignored`)
  return `holds at ${(frictionDeg - 1).toFixed(0)}°, slides at ${(frictionDeg + 6).toFixed(0)}° (μ=${mu}, friction angle ${frictionDeg.toFixed(1)}°)`
})

// ── 8. motion has inertia: it ramps up, and it settles ──────────────────────
check('sim: a joint ramps to speed and settles on its stop', () => {
  const { design, analysis } = DESIGN('arm')
  const sim = A.createJointSim(design, analysis)
  const i = 0
  sim.snap(design.joints.map(() => 0))
  const targets = design.joints.map(() => 0)
  targets[i] = 90
  sim.setTargets(targets)
  const dt = 1 / 120
  const early = (sim.step(dt, 0), Math.abs(sim.state.vel[i])) // one frame: inertia says slow
  for (let k = 0; k < 8; k += 1) sim.step(dt, k * dt * 1000)
  const cruising = Math.abs(sim.state.vel[i])
  assert(cruising > early * 2, `velocity did not ramp: ${early.toFixed(1)} → ${cruising.toFixed(1)} °/s`)
  // run out the move and confirm it comes to rest on the target, not past it
  const t0 = design.joints[i]
  let settleSteps = 0
  while (Math.abs(sim.state.angles[i] - 90) > 0.05 && settleSteps < 2000) { sim.step(dt, (21 + settleSteps) * dt * 1000); settleSteps += 1 }
  assert(settleSteps < 2000, 'joint never settled')
  assert(sim.state.angles[i] <= 90.0001, `overshot the stop by ${(sim.state.angles[i] - 90).toFixed(2)}° unsafely`)
  const rate = (settleSteps * dt)
  return `ramp ${early.toFixed(0)} → ${cruising.toFixed(0)} °/s · settles in ${(rate * 1000).toFixed(0)}ms · limit ${t0.min?.toFixed(0) ?? '-'}..${t0.max}`
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}${r.ok ? ` — ${r.detail}` : ''}`)
  if (!r.ok) console.log(`      ${r.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} simulation claims hold`)
process.exit(failed.length ? 1 : 0)
