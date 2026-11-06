// ── joint dynamics: the machine physically tracks commands ──────────────────
// Pose used to teleport: drag a slider, the joint jumped. Now every revolute
// joint slews toward its target at the speed ITS servo can actually turn,
// loses speed as gravity load rises, and stalls outright when the load
// exceeds stall torque — the same numbers the BOM and power budget already
// computed. Slides slew at a lead-screw-ish rate. All deterministic, all from
// src/10-parts.js specs — no invented constants except the slew cap below.

/**
 * Gravity torque about every revolute joint at a given pose, in N·m (signed).
 * One pass: each node's world position is computed once, then contributes to
 * every ancestor joint via the exact r×F statics from 41-bench. `poseAngles`
 * optionally overrides design.joints[].angle without mutating the design.
 */
function jointLoadNm(design, mat, poseAngles) {
  const joints = design.joints
  const saved = joints.map((j) => j.angle)
  if (poseAngles) joints.forEach((j, i) => { j.angle = poseAngles[i] == null ? j.angle : poseAngles[i] })
  try {
    const chains = chainsFor(design)
    const byId = new Map(joints.map((j) => [j.id, j]))
    // ancestors of each joint (inclusive), root→tip order not needed here
    const ancestorsOf = (jid) => {
      const out = []
      let cur = byId.get(jid)
      let guard = 0
      while (cur && guard < 24) { out.push(cur); cur = cur.parent ? byId.get(cur.parent) : null; guard++ }
      return out
    }
    const load = {}
    const frameCache = new Map()
    const frameOf = (jid) => {
      if (!frameCache.has(jid)) frameCache.set(jid, jointFrameWorld(chains, jid))
      return frameCache.get(jid)
    }
    for (const n of design.nodes) {
      const nj = n.joint ? byId.get(n.joint) : null
      if (!nj) continue
      const w = benchNodeWorld(design, chains, n)
      const g = benchNodeMassG(design, n, mat) * 9.81e-3 // N
      if (g <= 0) continue
      for (const j of ancestorsOf(nj.id)) {
        if (j.slide || j.axis === 'z') continue
        const fr = frameOf(j.id)
        if (!fr) continue
        const r = [w[0] - fr.pivotW[0], w[1] - fr.pivotW[1], w[2] - fr.pivotW[2]]
        // τ = r × F with F = (0,0,-g): τx = -ry·g, τy = rx·g → along axis, N·mm → N·m
        const tau = (-r[1] * g * fr.axisW[0] + r[0] * g * fr.axisW[1]) / 1000
        load[j.id] = (load[j.id] || 0) + tau
      }
    }
    return load
  } finally {
    joints.forEach((j, i) => { j.angle = saved[i] })
  }
}

/**
 * A joint-level sim: angles slew toward targets at each servo's real speed,
 * derate under gravity load, and stall (with a gravity sag) past stall torque.
 * Load is recomputed lazily every LOAD_MS against the sim's own pose — a
 * 23-joint humanoid costs ~1k torque evals, trivial at 2 Hz.
 */
function createJointSim(design, analysis) {
  const mat = analysis && analysis.print && analysis.print.material
  const acts = design.actuators || []
  const joints = design.joints
  const n = joints.length
  const state = {
    angles: joints.map(() => 0),
    vel: joints.map(() => 0),
    targets: joints.map(() => 0),
    loadNm: joints.map(() => 0),
    stallNm: joints.map((j) => {
      const a = acts.find((x) => x.label === j.label)
      return a ? a.effective || 0 : 0
    }),
    servoKey: joints.map((j) => {
      const a = acts.find((x) => x.label === j.label)
      return a ? a.servo : null
    }),
    stalled: joints.map(() => false),
    busA: 0,
    _loadAt: 0,
    _loadPose: null,
  }
  const LOAD_MS = 500
  const SAG_DPS = 22 // °/s a stalled joint creeps toward rest under gravity

  function refreshLoad(now) {
    if (now - state._loadAt < LOAD_MS) return
    state._loadAt = now
    const load = jointLoadNm(design, mat, state.angles)
    let bus = 0
    for (let i = 0; i < n; i++) {
      const j = joints[i]
      const need = Math.abs(load[j.id] || 0)
      state.loadNm[i] = need
      const part = state.servoKey[i] ? PARTS[state.servoKey[i]] : null
      const stall = state.stallNm[i]
      const ratio = stall > 0 ? need / stall : 0
      // thermal cutoff from the endurance sim ORs into the stall verdict —
      // a cooked servo cannot hold position either
      state.stalled[i] = ratio > 1.0 || !!(state.thermal && state.thermal[i])
      if (part && part.curr) {
        bus += (part.curr.idle || 0) + (part.curr.typ || 0) * Math.min(ratio, 1)
        if (ratio > 1) bus += (part.curr.peak || 0)
      }
    }
    state.busA = bus
  }

  return {
    state,
    /** Command new target angles (deg for revolute, mm for slides). */
    setTargets(arr) {
      for (let i = 0; i < n; i++) {
        const j = joints[i]
        const t = arr[i] == null ? 0 : arr[i]
        state.targets[i] = Math.min(j.max, Math.max(j.min, t))
      }
    },
    /** Snap every joint to a pose instantly (home, preset, design change). */
    snap(arr) {
      for (let i = 0; i < n; i++) {
        const j = joints[i]
        const a = arr[i] == null ? 0 : arr[i]
        const c = Math.min(j.max, Math.max(j.min, a))
        state.angles[i] = c
        state.targets[i] = c
        state.vel[i] = 0
      }
      state._loadAt = 0
    },
    /** Advance the sim by dt seconds. Returns true if any angle moved. */
    step(dt, now) {
      refreshLoad(now || 0)
      let moved = false
      for (let i = 0; i < n; i++) {
        const j = joints[i]
        const a = state.angles[i]
        const t = state.targets[i]
        const err = t - a
        if (Math.abs(err) < 0.01) { state.vel[i] = 0; continue }
        if (j.slide) {
          // rail/belt vs leadscrew differ by ~20× — j.slideSpeed carries the
          // axis's real rate (gantry sets 250 belt / 12 screw); 45 is the
          // stock-rail fallback the jaw and generic slides already used
          const spd = j.slideSpeed || 45
          const step = Math.sign(err) * Math.min(Math.abs(err), spd * dt)
          state.angles[i] = a + step
          state.vel[i] = step / Math.max(dt, 1e-4)
          moved = true
          continue
        }
        if (state.stalled[i]) {
          // cannot hold position: creep toward rest (angle 0) under gravity
          const dir = a > 0 ? -1 : 1
          state.angles[i] = a + dir * Math.min(Math.abs(a), SAG_DPS * dt)
          state.vel[i] = 0
          moved = true
          continue
        }
        const part = state.servoKey[i] ? PARTS[state.servoKey[i]] : null
        // Datasheet-shaped torque-speed curve: full rated speed at zero load,
        // easing to ~0 as gravity torque approaches stall — no artificial
        // floor, so a joint at 90% stall genuinely crawls before it stalls.
        const loadR = state.loadNm[i] / Math.max(state.stallNm[i], 1e-6)
        const dps = part && part.speed
          ? (60 / part.speed) * Math.pow(Math.max(0, 1 - Math.min(loadR, 1)), 0.75)
          : 200
        const maxStep = dps * dt
        const step = Math.sign(err) * Math.min(Math.abs(err), maxStep)
        state.angles[i] = a + step
        state.vel[i] = step / Math.max(dt, 1e-4)
        moved = true
      }
      return moved
    },
  }
}
