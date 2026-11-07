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
function jointLoadNm(design, mat, poseAngles, extras) {
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
    // A carried load is weight at the end of the chain, not a bigger machine.
    // It used to be invisible here: payloadKg changed the BOM and the sizing
    // checks, but the joints never felt it, so the stall branch could never
    // fire no matter how much you hung on the gripper.
    const loads = []
    for (const n of design.nodes) {
      if (!n.joint) continue
      const g = benchNodeMassG(design, n, mat) * 9.81e-3 // N
      if (g > 0) loads.push({ joint: n.joint, w: benchNodeWorld(design, chains, n), g })
    }
    for (const e of extras || []) {
      if (!e || !(e.massG > 0)) continue
      // hang it 35mm below the tip node — a gripped block sits under the jaw
      const host = design.nodes.find((n) => n.joint === e.joint)
      const base = host ? benchNodeWorld(design, chains, host) : [0, 0, 0]
      loads.push({ joint: e.joint, w: [base[0], base[1], base[2] - (e.dz || 35)], g: e.massG * 9.81e-3 })
    }
    for (const item of loads) {
      const nj = byId.get(item.joint)
      if (!nj) continue
      const w = item.w
      const g = item.g
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
  // The brief's payload is a mass the machine CARRIES, so it belongs in the
  // load model at the tip — otherwise a 6kg gripper load is free and no joint
  // can ever stall.
  const payloadG = Math.max(0, ((design.brief && design.brief.payloadKg) || 0) * 1000)
  const tipChain = typeof armTipChain === 'function' ? armTipChain(design) : null
  const tipJoint = (tipChain && tipChain.tipNode && tipChain.tipNode.joint) || (n ? joints[n - 1].id : null)
  const extras = payloadG > 0 && tipJoint ? [{ joint: tipJoint, massG: payloadG }] : []

  function refreshLoad(now) {
    if (now - state._loadAt < LOAD_MS) return
    state._loadAt = now
    const load = jointLoadNm(design, mat, state.angles, extras)
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
        // A joint past stall torque cannot hold a pose either: it sags even when
        // it already sits on its target. Checking "arrived" first let a stalled
        // joint freeze at the commanded angle, which is the one thing a servo
        // beyond stall torque does NOT do.
        if (state.stalled[i]) {
          const dir = a > 0 ? -1 : 1
          const sag = Math.min(Math.abs(a), SAG_DPS * dt)
          if (sag > 1e-9) { state.angles[i] = a + dir * sag; moved = true }
          state.vel[i] = 0
          continue
        }
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
