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
