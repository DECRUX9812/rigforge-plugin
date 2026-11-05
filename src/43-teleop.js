// ── arm teleop: WASD drives the end-effector through real IK ────────────────
// For jointed machines with nothing to drive (the 5-DoF arm and friends),
// WASD moves a target point in the world and solveChainIK — the same CCD
// solver the TEST tab trusts — converts it to joint angles every frame. The
// joint sim then slews the real servos toward those angles at their actual
// speed and stalls under load, so the arm on screen obeys the same physics
// as the numbers in the spec rail. No fake keyframing.

/**
 * Returns a teleop object for designs with one dominant revolute chain
 * (≥3 joints), else null. `step(cmd, dt, actualAngles)` returns the desired
 * joint-angle array (deg) for the pose command, or null when idle.
 */
function createArmTeleop(design) {
  const joints = design.joints || []
  if (!joints.length || joints.length > 8) return null
  const chains = chainsFor(design)

  // The end-effector chain: the joint with the deepest revolute ancestry.
  // Ambiguous machines (humanoid legs, quadruped) have several equal chains —
  // picking one silently would be a lie, so they get no IK mode.
  let tipJoint = null
  let tipChain = null
  let tie = false
  for (const j of joints) {
    if (j.slide) continue
    const ch = (chains.get(j.id) || []).filter((x) => !x.slide)
    if (!tipChain || ch.length > tipChain.length) {
      tipChain = ch; tipJoint = j; tie = false
    } else if (ch.length === tipChain.length && tipJoint && j.id !== tipJoint.id) {
      tie = true
    }
  }
  if (!tipChain || tipChain.length < 3 || tie) return null

  // Tip node: the node rigidly attached to the last joint, farthest from its
  // pivot — the business end of the arm.
  const tj = tipJoint
  const attached = (design.nodes || []).filter((n) => n.joint === tj.id && n.pos)
  if (!attached.length) return null
  let tipNode = attached[0]
  let bestD = -1
  for (const n of attached) {
    const d = Math.hypot(n.pos[0] - tj.pivot[0], n.pos[1] - tj.pivot[1], n.pos[2] - tj.pivot[2])
    if (d > bestD) { bestD = d; tipNode = n }
  }

  // Scratch design: IK mutates joint angles, so it must never touch `design`.
  const scratch = { ...design, joints: joints.map((j) => ({ ...j })) }
  const scratchById = new Map(scratch.joints.map((j) => [j.id, j]))
  const ikChain = tipChain.map((j) => scratchById.get(j.id)).filter(Boolean)
  if (ikChain.length < 3) return null

  const tipWorld = (d) => benchNodeWorld(d, chainsFor(d), tipNode)
  const state = {
    tx: 0, ty: 0, tz: 0,      // target point, world mm — set on first step
    err: 0, ready: false,
    reach: Math.max(...(design.nodes || []).map((n) => Math.hypot(n.pos[0], n.pos[1], n.pos[2])), 200),
  }

  const MOVE = 220 // mm/s at full deflection
  const ZONE = { x: 0.12, y: 0.12, z: 0.12 } // stick deadzone per axis

  return {
    kind: 'ik',
    state,
    /**
     * cmd: {x,y,z} each -1..1. actualAngles: current joint angles (deg).
     * Returns desired joint angles (deg, design.joints order) or null.
     */
    step(cmd, dt, actualAngles) {
      // First contact: aim where the tip already is, so WASD deltas feel
      // relative instead of teleporting the arm across the bench.
      if (!state.ready) {
        for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
        const t = tipWorld(scratch)
        state.tx = t[0]; state.ty = t[1]; state.tz = Math.max(t[2], 40)
        state.ready = true
      }
      const ax = Math.abs(cmd.x || 0) > ZONE.x ? cmd.x : 0
      const ay = Math.abs(cmd.y || 0) > ZONE.y ? cmd.y : 0
      const az = Math.abs(cmd.z || 0) > ZONE.z ? cmd.z : 0
      state.tx += ax * MOVE * dt
      state.ty += ay * MOVE * dt
      state.tz = Math.min(600, Math.max(40, state.tz + az * MOVE * 0.8 * dt))
      if (!ax && !ay && !az) return null // hold — joints keep tracking

      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      const r = solveChainIK(scratch, ikChain, [state.tx, state.ty, state.tz], tipWorld, 5)
      state.err = r.err
      return scratch.joints.map((j) => j.angle)
    },
    reset() { state.ready = false; state.err = 0 },
    hud() {
      return {
        kind: 'ik',
        speed: 0,
        err: state.err,
        tx: Math.round(state.tx), ty: Math.round(state.ty), tz: Math.round(state.tz),
      }
    },
  }
}

// ── legged gait: footfall IK walking in place on the bench ──────────────────
// Each leg is its own joint chain; every frame each foot gets a target on a
// proper gait curve — planted and sweeping backward in stance, lifted and
// swinging forward in swing — and solveChainIK puts the joints there. Diagonal
// pairs trot together on the quadruped, left/right alternate on the humanoid.
// Speed scales stride rate and fades to a standstill, so letting go returns
// every foot to neutral under the body. Same honesty rule: the joint sim
// still slews at servo speed and stalls under load.

const GAIT = {
  stride: 130,     // mm foot travel fore/aft
  clear: 28,       // mm swing apex
  freq: 1.5,       // Hz at full speed
  armAmp: 22,      // deg shoulder counter-swing
}

/** Detect legged machines and return a gait teleop, else null. */
function createGaitTeleop(design) {
  const joints = design.joints || []
  if (!joints.length || joints.length > 30) return null
  const chains = chainsFor(design)
  const byId = new Map(joints.map((j) => [j.id, j]))

  // Group leg joints: 'coxa-fl' style (quadruped) or 'l-hip-pitch' (humanoid).
  const legMap = new Map() // key → {ids:[], tip:id}
  const RANK_Q = { coxa: 0, femur: 1, tibia: 2 }
  const RANK_H = { 'hip-yaw': 0, 'hip-roll': 1, 'hip-pitch': 2, knee: 3, 'ankle-pitch': 4, 'ankle-roll': 5 }
  const isQuad = joints.some((j) => /^(coxa|femur|tibia)-/.test(j.id))
  const isHum = joints.some((j) => /^[lr]-(hip|knee|ankle)/.test(j.id))
  if (!isQuad && !isHum) return null

  for (const j of joints) {
    let key = null, rank = -1
    if (isQuad) {
      const m = j.id.match(/^(coxa|femur|tibia)-(.+)$/)
      if (m) { key = m[2]; rank = RANK_Q[m[1]] }
    } else {
      const m = j.id.match(/^([lr])-(hip-yaw|hip-roll|hip-pitch|knee|ankle-pitch|ankle-roll)$/)
      if (m) { key = m[1]; rank = RANK_H[m[2]] }
    }
    if (!key || rank < 0) continue
    if (!legMap.has(key)) legMap.set(key, { key, rank: {}, tip: null })
    const leg = legMap.get(key)
    leg.rank[j.id] = rank
  }
  // keep only complete legs (≥3 joints for quad, ≥5 for humanoid)
  const need = isQuad ? 3 : 5
  const legs = [...legMap.values()].filter((l) => Object.keys(l.rank).length >= need)
  if (legs.length < (isQuad ? 4 : 2)) return null

  // Per leg: ordered chain (root→tip via chainsFor of its deepest joint),
  // hip pivot (root joint), foot node (lowest node on the tip joint).
  const scratch = { ...design, joints: joints.map((j) => ({ ...j })) }
  const scratchById = new Map(scratch.joints.map((j) => [j.id, j]))
  const scratchChains = chainsFor(scratch) // topology is angle-independent
  const specs = []
  for (const leg of legs) {
    const ids = Object.keys(leg.rank)
    // deepest = member whose ancestor chain contains the most leg joints
    let tipId = ids[0], best = -1
    for (const id of ids) {
      const depth = (chains.get(id) || []).filter((a) => leg.rank[a.id] !== undefined).length
      if (depth > best) { best = depth; tipId = id }
    }
    const ordered = (chains.get(tipId) || []).filter((a) => leg.rank[a.id] !== undefined)
    if (ordered.length < need) continue
    const rootPivot = ordered[0].pivot || [0, 0, 0]
    // foot node: attached to the tip joint, lowest in the air at rest pose
    const attached = (design.nodes || []).filter((n) => n.joint === tipId && n.pos)
    let foot = null, footZ = 1e9
    for (const n of attached) {
      const w = benchNodeWorld(design, chains, n)
      if (w[2] < footZ) { footZ = w[2]; foot = n }
    }
    if (!foot) continue
    specs.push({
      key: leg.key,
      chain: ordered.map((a) => scratchById.get(a.id)).filter(Boolean),
      rootPivot,
      foot,
      // trot: diagonal pairs together (fl+rr, fr+rl); walk: left/right alternate
      offset: isQuad
        ? ((leg.key[0] === 'f') === (leg.key[1] === 'l') ? 0 : Math.PI)
        : (leg.key === 'r' ? Math.PI : 0),
      restZ: footZ,
    })
  }
  if (specs.length < (isQuad ? 4 : 2)) return null

  const state = { phase: 0, speed: 0, strides: 0, armBase: null }
  const ARM_JOINTS = isHum ? ['shoulder-pitch', 'elbow'].flatMap((s) => [`l-${s}`, `r-${s}`]) : []

  /** Desired joint angles (deg) for one gait instant. */
  function poseAt(phase, speedNorm, actual) {
    for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actual[i] || 0
    // arm counter-swing is absolute, not additive: capture the pose the arms
    // had when the gait started so stopping never drifts them
    if (isHum && !state.armBase) {
      state.armBase = {}
      for (const id of ARM_JOINTS) {
        const j = scratchById.get(id)
        if (j) state.armBase[id] = j.angle
      }
    }
    const stride = GAIT.stride * speedNorm
    const clear = GAIT.clear * speedNorm
    for (const s of specs) {
      const ph = phase + s.offset
      const cyc = ((ph % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      const swing = cyc >= Math.PI
      const u = swing ? (cyc - Math.PI) / Math.PI : cyc / Math.PI
      // stance: foot sweeps hip+stride/2 → hip-stride/2 at ground; swing: returns lifted
      const fx = s.rootPivot[0] + (swing ? -1 : 1) * stride * (0.5 - u)
      const fz = s.restZ + (swing ? clear * Math.sin(u * Math.PI) : 0)
      const target = [fx, s.rootPivot[1], Math.max(20, fz)]
      solveChainIK(scratch, s.chain, target, (d) => benchNodeWorld(d, scratchChains, s.foot), 4)
    }
    // humanoid arms counter-swing against their own leg
    if (isHum && state.armBase) {
      for (const side of ['l', 'r']) {
        const legSpec = specs.find((s) => s.key === side)
        if (!legSpec) continue
        const swingArm = Math.sin(phase + legSpec.offset) * GAIT.armAmp * speedNorm
        const sp = scratchById.get(`${side}-shoulder-pitch`)
        const el = scratchById.get(`${side}-elbow`)
        if (sp) sp.angle = (state.armBase[sp.id] || 0) + swingArm
        if (el) el.angle = (state.armBase[el.id] || 0) + swingArm * 0.4 - 8 * speedNorm
      }
    }
    return scratch.joints.map((j) => j.angle)
  }

  return {
    kind: 'gait',
    state,
    /** cmd: {x: -1..1 walk speed}; actualAngles current pose. */
    step(cmd, dt, actualAngles) {
      const want = Math.max(-1, Math.min(1, cmd.x || 0))
      state.speed += (want - state.speed) * Math.min(1, dt * 4)
      const sp = Math.abs(state.speed)
      // fully stopped: release the pose and forget the arm base so the next
      // walk captures whatever stance the user left the machine in
      if (sp < 0.004 && want === 0) { state.speed = 0; state.armBase = null; return null }
      state.speed = Math.max(-1, Math.min(1, state.speed))
      state.strides += sp * GAIT.freq * dt
      state.phase += Math.sign(state.speed) * GAIT.freq * sp * dt * Math.PI * 2
      return poseAt(state.phase, sp, actualAngles)
    },
    reset() { state.phase = 0; state.speed = 0; state.strides = 0; state.armBase = null },
    hud() {
      return {
        kind: 'gait',
        speed: Math.abs(state.speed),
        cadence: (GAIT.freq * Math.abs(state.speed)).toFixed(1),
        strides: Math.round(state.strides),
      }
    },
  }
}

// ── single-actuator teleop: the gripper's jaw opens and closes ──────────────
// Devices with exactly one joint (the parallel gripper's jaw slide) get an
// honest toggle: Space flips open↔closed and the joint sim drives the servo
// at its real speed. Nothing here pretends to be manipulation — it's a jaw.

function createGripTeleop(design) {
  const joints = design.joints || []
  if (joints.length !== 1) return null
  const j = joints[0]
  const state = { open: false, was: false }
  return {
    kind: 'grip',
    state,
    /** cmd: {grip: space held}; returns desired angle or null. */
    step(cmd) {
      const held = !!(cmd && cmd.grip)
      if (held && !state.was) state.open = !state.open
      state.was = held
      return [state.open ? j.max : j.min]
    },
    reset() { state.open = false; state.was = false },
    hud() {
      return { kind: 'grip', open: state.open }
    },
  }
}
