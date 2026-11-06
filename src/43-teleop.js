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
function createArmTeleop(design, side) {
  const joints = design.joints || []
  if (!joints.length) return null
  // Explicit side picks that arm's chain (humanoid L/R); otherwise the
  // unambiguous whole-design scan, then the right-arm fallback.
  const tipWhole = side ? null : armTipChain(design)
  const tip = tipWhole || armChainFor(design, side || 'r')
  if (!tip) return null
  const { tipChain, tipNode } = tip

  // Scratch design: IK mutates joint angles, so it must never touch `design`.
  const scratch = { ...design, joints: joints.map((j) => ({ ...j })) }
  const scratchById = new Map(scratch.joints.map((j) => [j.id, j]))
  const ikChain = tipChain.map((j) => scratchById.get(j.id)).filter(Boolean)
  if (ikChain.length < 3 || ikChain.length > 8) return null

  const tipWorld = (d) => benchNodeWorld(d, chainsFor(d), tipNode)
  const state = {
    tx: 0, ty: 0, tz: 0,      // target point, world mm — set on first step
    err: 0, ready: false,
    reach: Math.max(...(design.nodes || []).map((n) => Math.hypot(n.pos[0], n.pos[1], n.pos[2])), 200),
  }

  const MOVE = 220 // mm/s at full deflection
  const ZONE = { x: 0.12, y: 0.12, z: 0.12 } // stick deadzone per axis

  // Workspace bound for the REACH overlay — shared with the spec's reach row.
  const reachSphere = armReachBound(tip)
  // The joints this arm actually drives — certification scopes its LIMITS
  // sweep and lift margins to these so a humanoid's legs can't fail an arm test.
  const chainIds = tipChain.map((j) => j.id)
  const chainIdx = chainIds.map((id) => joints.findIndex((j) => j.id === id)).filter((i) => i >= 0)

  return {
    kind: 'ik',
    state,
    design,          // read-only: autotest poses a clone for torque checks
    distalJoint: tipNode.joint, // the joint the tip rides — payloads hang here
    chainIds, chainIdx, // design.joints scope this arm's certification covers
    reachSphere,     // {c,r} mm — outer bound of the arm's workspace
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
    /** One-shot reachability solve: point the target anywhere and run the
     *  CCD solver hard (30 iters vs the 5 the live path uses). Certification
     *  asks "can it get there", not "can it track a moving stick". */
    seek(tx, ty, tz, actualAngles, iters = 30) {
      state.tx = tx; state.ty = ty; state.tz = tz; state.ready = true
      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      const r = solveChainIK(scratch, ikChain, [tx, ty, tz], tipWorld, iters)
      state.err = r.err
      return scratch.joints.map((j) => j.angle)
    },
    reset() { state.ready = false; state.err = 0 },
    /** Where the tip actually is under the live joint angles, world mm. */
    tipPos(actualAngles) {
      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      return tipWorld(scratch)
    },
    /** Physical tip-to-target distance under the live joint angles — what
     *  the bench actually measures, vs state.err which is solver residual. */
    liveErr(actualAngles) {
      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      const t = tipWorld(scratch)
      return Math.hypot(t[0] - state.tx, t[1] - state.ty, t[2] - state.tz)
    },
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

  /** Desired joint angles (deg) for one gait instant.
   *  `anchor` (optional) = {x, y, yaw} of the body origin in mm world space.
   *  With an anchor, stance feet are world-locked: the IK target is the
   *  planted foothold pulled back into body frame, so the leg reaches
   *  backward as the body advances — real walking, not a treadmill. */
  function poseAt(phase, speedNorm, actual, anchor) {
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
    const anchorOn = anchor && speedNorm > 0.02
    const ay = anchor ? Math.cos(anchor.yaw) : 1
    const asy = anchor ? Math.sin(anchor.yaw) : 0
    for (const s of specs) {
      const ph = phase + s.offset
      const cyc = ((ph % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      const swing = cyc >= Math.PI
      const u = swing ? (cyc - Math.PI) / Math.PI : cyc / Math.PI
      // stance: foot sweeps hip+stride/2 → hip-stride/2 at ground; swing: returns lifted
      const fx = s.rootPivot[0] + (swing ? -1 : 1) * stride * (0.5 - u)
      const fz = s.restZ + (swing ? clear * Math.sin(u * Math.PI) : 0)
      let target = [fx, s.rootPivot[1], Math.max(20, fz)]
      if (anchorOn) {
        if (swing) s.plant = null
        else if (s.plant) {
          // world→body: the plant stays fixed while the body walks over it
          const dx = s.plant[0] - anchor.x, dy = s.plant[1] - anchor.y
          target = [dx * ay + dy * asy, -dx * asy + dy * ay, Math.max(20, fz)]
        }
        // touchdown frame (no plant yet): aim with the sweep target below,
        // then measure where the foot actually landed
      }
      solveChainIK(scratch, s.chain, target, (d) => benchNodeWorld(d, scratchChains, s.foot), 4)
      if (anchorOn && !swing && !s.plant) {
        const fw = benchNodeWorld(scratch, scratchChains, s.foot)
        s.plant = [anchor.x + fw[0] * ay - fw[1] * asy, anchor.y + fw[0] * asy + fw[1] * ay]
      }
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

  // ── locomotion state ────────────────────────────────────────────────────
  // Same shape as createDrive's state so setChassis/applyChassis consume it
  // unchanged: x,y in metres, yaw/grade in radians.
  const loco = { x: 0, y: 0, yaw: 0, v: 0, w: 0, vl: 0, throttle: 0, steer: 0, grade: 0, z: 0, slip: false, stall: false, bumps: 0, stepHit: false, mu: 0, surf: '' }
  // slip-free walk speed: a foot travels `stride` mm during half a cycle at
  // freq·speedNorm Hz → body speed = 2·stride·freq·speedNorm m/s
  const WALK_V = (2 * GAIT.stride * GAIT.freq) / 1000
  // tallest riser the legs can mount: ~45% of leg extension, min over legs.
  // An 80mm porch nosing stops a small quad honestly; a tall humanoid may pass.
  const maxStepM = Math.max(0.005, Math.min(...specs.map((s) => Math.max(0, (s.rootPivot[2] - s.restZ) * 0.00045))))

  return {
    kind: 'gait',
    state,
    maxStepM, // tallest riser the legs can mount — the autotest predicts with it
    legSpecs: specs, // read-only: per-leg chain/foot/rootPivot for workspace sampling
    bodyKg: (design.metrics && design.metrics.massKg) || 6, // carried-load tests scale off this
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
    // ── locomotion: the treadmill becomes a walk ──────────────────────────
    // locoStep integrates a body through the same bench courses the wheeled
    // machines use. Walk speed is derived from the gait kinematics — a foot
    // travels `stride` mm during half a cycle at freq·speedNorm, so the
    // slip-free body speed is 2·stride·freq·speedNorm m/s. The bench does
    // not get to pretend feet are glued down when the math says they slide.
    locomote(cmd, dt, actualAngles, env) {
      const e = env || {}
      const course = e.course === 'room' ? 'room' : e.course === 'stairs' ? 'stairs' : 'rack'
      loco.course = course
      dt = Math.min(dt, 0.05)
      loco.throttle = Math.max(-1, Math.min(1, cmd.x || 0))
      loco.steer = Math.max(-1, Math.min(1, cmd.y || 0))
      const grade = terrainGrade(loco.x, e.slopeDeg || 0, course)
      loco.grade = grade
      loco.z = terrainHeight(loco.x, e.slopeDeg || 0, course)
      const gradeDeg = Math.abs(grade) * 180 / Math.PI
      const mu = muAt(loco.x, { surface: e.surface, slopeDeg: e.slopeDeg || 0, course })
      loco.mu = mu
      loco.surf = course === 'room' ? (loco.x >= ROOM.rug.x0 && loco.x < ROOM.rug.x1 ? 'rug' : 'hardwood')
        : course === 'stairs' ? 'stairs' : ((DRIVE_SURFACES[e.surface] || DRIVE_SURFACES.hardwood).label || 'hardwood')
      const sp = Math.abs(state.speed)

      // gait cadence tracks the same eased speed the in-place gait uses
      const want = loco.throttle
      state.speed += (want - state.speed) * Math.min(1, dt * 4)
      state.speed = Math.max(-1, Math.min(1, state.speed))
      const spd = Math.abs(state.speed)
      if (spd < 0.004 && want === 0) { state.speed = 0; state.armBase = null; for (const s of specs) s.plant = null }
      state.strides += spd * GAIT.freq * dt
      state.phase += Math.sign(state.speed) * GAIT.freq * spd * dt * Math.PI * 2

      // carried load: mass on the back costs leg torque — speed derates
      // with the load ratio, exposed so the HUD and autotest can see it
      const bodyKg = (design.metrics && design.metrics.massKg) || 6
      const payKg = Math.max(0, e.payloadKg || 0)
      const loadR = payKg / Math.max(bodyKg, 0.5)
      const payF = payKg > 0 ? clamp(1 / (1 + loadR * 1.8), 0.3, 1) : 1
      loco.payloadKg = payKg
      loco.loadR = loadR

      // commanded speed: kinematic walk speed × grade/mu/load derating
      const dir = Math.sign(state.speed) || 1
      let vT = state.speed * WALK_V
      const gradeEff = grade * Math.cos(loco.yaw) * dir // slope along travel dir
      const gDeg = Math.abs(gradeEff) * 180 / Math.PI
      const gf = clamp(1 - Math.max(0, gDeg - 4) / 20, 0.15, 1)
      const slipF = mu < 0.35 ? clamp(mu / 0.35, 0.3, 1) : 1
      vT *= gf * slipF * payF
      // legs accelerate ~2.5 m/s² and brake harder — no ice-skating starts
      loco.v += clamp(vT - loco.v, -4 * dt, 2.5 * dt)
      loco.slip = mu < 0.35 && Math.abs(loco.v) > 0.05
      // yaw: turning while walking is a curved path, capped so feet keep up
      const wWant = -loco.steer * 1.1 * Math.min(1, Math.abs(loco.v) / 0.15 + 0.25)
      loco.w += clamp(wWant - loco.w, -2.5 * dt, 2.5 * dt)

      const xPrev = loco.x, yPrev = loco.y
      const fx = Math.cos(loco.yaw), fy = Math.sin(loco.yaw)
      loco.x += (loco.v * fx - loco.vl * fy) * dt
      loco.y += (loco.v * fy + loco.vl * fx) * dt
      loco.yaw += loco.w * dt
      // lateral slide (shove) scrubbed by foot friction, same as wheels
      const aLat = mu * 9.81 * Math.cos(grade) * 1.6
      loco.vl -= Math.sign(loco.vl) * Math.min(Math.abs(loco.vl), aLat * dt)
      if (Math.abs(loco.vl) < 0.005) loco.vl = 0

      // stairs: a riser above leg reach is a wall — same honesty as wheels
      if (course === 'stairs') {
        const rise = terrainHeight(loco.x, e.slopeDeg || 0, course) - loco.z
        if (rise > maxStepM) {
          loco.x = xPrev; loco.y = yPrev
          loco.v = 0; loco.vl = 0; loco.stall = true
          if (!loco.stepHit) { loco.bumps += 1; loco.stepHit = true }
        } else loco.stepHit = false
      } else loco.stepHit = false
      // living-room obstacles: same circle-vs-AABB rule as the wheeled bench
      if (course === 'room') {
        const r = 0.20
        for (const pr of ROOM.props) {
          const nx = Math.max(pr.c[0] - pr.half[0], Math.min(loco.x, pr.c[0] + pr.half[0]))
          const ny = Math.max(pr.c[1] - pr.half[1], Math.min(loco.y, pr.c[1] + pr.half[1]))
          const ddx = loco.x - nx, ddy = loco.y - ny
          const d2 = ddx * ddx + ddy * ddy
          if (d2 >= r * r || loco.z >= pr.top) continue
          const d = Math.sqrt(d2) || 1e-6
          const px = ddx / d, py = ddy / d
          loco.x = nx + px * r; loco.y = ny + py * r
          let vx = loco.v * fx - loco.vl * fy
          let vy = loco.v * fy + loco.vl * fx
          const vn = vx * px + vy * py
          if (vn < 0) {
            if (-vn > 0.15) loco.bumps += 1
            vx -= vn * px * 1.15; vy -= vn * py * 1.15
            loco.v = vx * fx + vy * fy; loco.vl = -vx * fy + vy * fx
          }
        }
      }
      loco.stall = Math.abs(loco.throttle) > 0.5 && Math.abs(loco.v) < 0.04 &&
        (gDeg > 18 || (course === 'stairs' && loco.stepHit))
      if (loco.yaw > Math.PI) loco.yaw -= Math.PI * 2
      if (loco.yaw < -Math.PI) loco.yaw += Math.PI * 2

      const anchor = { x: loco.x * 1000, y: loco.y * 1000, yaw: loco.yaw }
      const pose = state.speed !== 0 || want !== 0
        ? poseAt(state.phase, spd, actualAngles, anchor)
        : null
      return { pose, chassis: loco }
    },
    shove(forceN) {
      const mNow = (design.metrics && design.metrics.massKg) || 2
      loco.vl += (forceN * 0.25) / mNow
      loco.w += (forceN * 0.12) / Math.max(mNow * 0.3, 0.5)
    },
    reset() {
      state.phase = 0; state.speed = 0; state.strides = 0; state.armBase = null
      for (const s of specs) s.plant = null
      Object.assign(loco, { x: 0, y: 0, yaw: 0, v: 0, w: 0, vl: 0, throttle: 0, steer: 0, grade: 0, z: 0, slip: false, stall: false, bumps: 0, stepHit: false })
    },
    locomoteState: loco,
    hud() {
      return {
        kind: 'gait',
        speed: Math.abs(state.speed),
        cadence: (GAIT.freq * Math.abs(state.speed)).toFixed(1),
        strides: Math.round(state.strides),
        loco: {
          v: Math.abs(loco.v),
          yawDeg: Math.round((loco.yaw * 180) / Math.PI),
          gradeDeg: Math.round(Math.abs(loco.grade) * 180 / Math.PI),
          surface: loco.surf,
          mu: loco.mu,
          course: loco.course,
          slip: loco.slip, stall: loco.stall, bumps: loco.bumps,
        },
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
    design,
    // the same rating the bench HUD prints — certification must test the
    // number the sizing checks claim, not a friendlier one
    holdKg: (design.metrics && design.metrics.gripMassKg) || 0,
    /** cmd: {grip: space held, gripEdge: space keydown edge}; returns desired angle or null. */
    step(cmd) {
      const held = !!(cmd && cmd.grip)
      const edge = !!(cmd && cmd.gripEdge)
      // edge covers tap-to-toggle: a press shorter than one frame still counts
      if (edge || (held && !state.was)) state.open = !state.open
      state.was = held
      return [state.open ? j.max : j.min]
    },
    reset() { state.open = false; state.was = false },
    hud() {
      return { kind: 'grip', open: state.open }
    },
  }
}

// ── desk bench: weighted pick-place props for the reach mode ────────────────
// Three honest objects on the bench at pick heights — the light bin, the
// printed part, the steel block. The IK HUD names whichever one the
// end-effector is over and flags it when its mass beats the arm's payload
// rating. Props are world-space tris appended to the viewport mesh.

const DESK_PROPS = [
  { id: 'bin', name: 'parts bin', massG: 80, size: [120, 80, 90], pos: [300, -70, 205], mat: 'accent' },
  { id: 'print', name: 'printed part', massG: 350, size: [60, 60, 40], pos: [350, 50, 180], mat: 'pcb' },
  { id: 'steel', name: 'steel block', massG: 1200, size: [80, 80, 80], pos: [390, -10, 200], mat: 'steel' },
]
// the bench slab the props sit on: top at z=160, spanning the workspace
const DESK_SLICE = { size: [560, 340, 14], pos: [280, -10, 153], mat: 'metal' }

function deskBoxTris(cx, cy, cz, sx, sy, sz, mat, node) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2
  const y0 = cy - sy / 2, y1 = cy + sy / 2
  const z0 = cz - sz / 2, z1 = cz + sz / 2
  const P = (x, y, z) => [x, y, z]
  const T = (a, b, c) => ({ pts: [a, b, c], mat, node })
  return [
    T(P(x0,y0,z0),P(x1,y0,z0),P(x1,y1,z0)), T(P(x0,y0,z0),P(x1,y1,z0),P(x0,y1,z0)), // bottom
    T(P(x0,y0,z1),P(x0,y1,z1),P(x1,y1,z1)), T(P(x0,y0,z1),P(x1,y1,z1),P(x1,y0,z1)), // top
    T(P(x0,y0,z0),P(x0,y0,z1),P(x1,y0,z1)), T(P(x0,y0,z0),P(x1,y0,z1),P(x1,y0,z0)), // -y
    T(P(x1,y1,z0),P(x1,y1,z1),P(x0,y1,z1)), T(P(x1,y1,z0),P(x0,y1,z1),P(x0,y1,z0)), // +y
    T(P(x0,y0,z0),P(x0,y1,z0),P(x0,y1,z1)), T(P(x0,y0,z0),P(x0,y1,z1),P(x0,y0,z1)), // -x
    T(P(x1,y0,z0),P(x1,y0,z1),P(x1,y1,z1)), T(P(x1,y0,z0),P(x1,y1,z1),P(x1,y1,z0)), // +x
  ]
}

let _deskTris = null
function deskPropsTris() {
  if (_deskTris) return _deskTris
  _deskTris = deskBoxTris(DESK_SLICE.pos[0], DESK_SLICE.pos[1], DESK_SLICE.pos[2], ...DESK_SLICE.size, DESK_SLICE.mat, 'desk')
  for (const p of DESK_PROPS) {
    _deskTris.push(...deskBoxTris(p.pos[0], p.pos[1], p.pos[2], ...p.size, p.mat, `prop-${p.id}`))
  }
  return _deskTris
}

/** Nearest desk prop to a world point, within `r` mm — for the reach HUD. */
function deskPropNear(x, y, z, r = 110) {
  let best = null, bd = r
  for (const p of DESK_PROPS) {
    const d = Math.hypot(p.pos[0] - x, p.pos[1] - y, (p.pos[2] - z) * 0.7)
    if (d < bd) { bd = d; best = p }
  }
  return best ? { prop: best, dist: bd } : null
}

/**
 * "Break → Fix": turn live failure signals into one concrete next step each.
 * Consumes the bench verdicts plus whichever teleop/power HUDs are live.
 * Returns up to 3 fixes, failures first — the bench detects, this prescribes.
 */
function fixSuggestions(s) {
  const out = []
  const push = (sev, msg, apply) => {
    if (out.length < 3 && !out.some((f) => f.msg === msg)) out.push({ sev, msg, apply: apply || null })
  }
  const brief = s.brief || {}
  for (const v of s.bench ? s.bench.verdicts : []) {
    if (v.status !== 'fail' && v.status !== 'warn') continue
    if (/stab|tip|balance/i.test(v.label)) {
      push('fail', `Fix stability: ${v.detail || v.label} — widen the base/track or lower the CoM`)
    } else if (/torque|servo|joint|bend/i.test(v.label)) {
      push('warn', `Fix torque: ${v.detail || v.label} — bigger servo or shorter reach`)
    }
  }
  // legged locomotion reports under .loco; wheeled drive reports flat —
  // normalize so the same failure rules apply to both
  const drv = s.drive ? (s.drive.loco || s.drive) : null
  if (drv) {
    if (drv.stall || (drv.slide && drv.throttle)) {
      // gradeDeg/surface are absent on a flat push in the stairs course, and
      // 'undefined° undefined' is what that printed
      const grade = Number.isFinite(drv.gradeDeg) ? `${drv.gradeDeg}° ` : ''
      const surf = drv.surface || 'the ground'
      push('fail', `Fix drive: wheels can't pull ${drv.mass ? drv.mass.toFixed(1) + 'kg ' : ''}up ${grade}${surf} — more torque, lower grade, or shed payload`)
    } else if (drv.slip) {
      push('warn', `Fix traction: slipping on ${drv.surface} (μ${drv.mu}) — rubber wheels or less payload`)
    }
    if (drv.course === 'stairs' && (drv.stall || (drv.bumps || 0) > 0)) {
      const isLegged = !!(s.drive && s.drive.loco)
      if (isLegged) {
        const reach = brief.reachMm || 400
        push('fail', 'Fix steps: 80mm risers beat leg reach — longer legs or a different gait',
          reach < 700 ? { reachMm: Math.min(900, reach + 200) } : null)
      } else {
        const wheelMm = brief.wheelMm || 100
        push('fail', 'Fix steps: 80mm risers beat wheel bite — fit ≥150mm wheels or articulated suspension',
          wheelMm < 150 ? { wheelMm: 150 } : null)
      }
    }
  }
  if (s.prop && s.prop.over) {
    const pay = brief.payloadKg || 1
    push('warn', `Fix payload: ${s.prop.name} is ${s.prop.massG}g vs the arm's ${Math.round((s.prop.ratingG || 0) / 100) / 10}kg rating — pick lighter or upsize`,
      { payloadKg: Math.max(0.1, Math.round(pay * 0.7 * 10) / 10) })
  }
  // arm reach: a prop fully outside the bound sphere can't be touched at ANY
  // joint angle — that's geometry, not tuning, so the fix is a longer arm.
  // Point-to-box distance keeps the check honest: near-misses stay the IK
  // solver's problem, only provable outsiders get the prescription.
  if (s.reach && s.reach.c && s.reach.r) {
    let worst = null
    for (const p of DESK_PROPS) {
      const dx = Math.max(Math.abs(p.pos[0] - s.reach.c[0]) - p.size[0] / 2, 0)
      const dy = Math.max(Math.abs(p.pos[1] - s.reach.c[1]) - p.size[1] / 2, 0)
      const dz = Math.max(Math.abs(p.pos[2] - s.reach.c[2]) - p.size[2] / 2, 0)
      const gap = Math.hypot(dx, dy, dz) - s.reach.r
      if (gap > 0 && (!worst || gap > worst.gap)) worst = { prop: p, gap }
    }
    if (worst) {
      const arch = brief.archetype || ''
      const DEF = { arm: 450, robot: 450, humanoid: 620 }
      const cur = brief.reachMm || DEF[arch] || 450
      const next = Math.min(1200, Math.ceil((cur + worst.gap * 1.2) / 20) * 20)
      push('warn', `Fix reach: ${worst.prop.name} sits ${Math.round(worst.gap)}mm outside the arm's ${Math.round(s.reach.r)}mm bound — lengthen the arm`,
        next > cur ? { reachMm: next } : null)
    }
  }
  // certification lift legs: the AUTO run measured exactly which joint ran out
  // of torque at the carry pose. On arm-type designs payloadKg upsizes the
  // servos (verified: wrist-pitch 0.22→1.08 N·m going 1→3kg) — declaring the
  // load is the honest fix. Humanoid arm servos are sized by structure, so
  // there the prescription stays verbal.
  const certFails = []
  for (const r of s.autotest || []) {
    if (r.pass) continue
    const m = /best carry (.+?) at ([\d.]+)× stall holding (\d+)g/.exec(r.detail || '')
    if (!m) { certFails.push(r.label || r.id || 'leg'); continue }
    const [, joint, margin, grams] = m
    const kg = Math.ceil((Number(grams) / 1000) * 10) / 10
    const cur = brief.payloadKg || 0
    const canUpsize = brief.archetype === 'arm' || brief.archetype === 'robot'
    if (canUpsize && kg > cur) {
      push('warn', `Fix lift: ${joint} held ${grams}g at ${margin}× stall — declare ${kg}kg payload so the servos size for it`,
        { payloadKg: kg })
    } else {
      push('warn', `Fix lift: ${joint} held ${grams}g at ${margin}× stall — shorten the arm or accept the limit`)
    }
  }
  // every other failed leg (reach, limits, gait…) still deserves a row —
  // aggregated so a humanoid's 6 arm fails don't eat the whole panel
  if (certFails.length) {
    const shown = certFails.slice(0, 2).join(', ')
    push('warn', `Cert: ${certFails.length} leg(s) failed (${shown}${certFails.length > 2 ? '…' : ''}) — see TEST for the full log`)
  }
  if (s.sense && s.sense.kind === 'sense' && s.sense.alerts && s.sense.alerts.length) {
    push('warn', `Fix sense: ${s.sense.alerts[0]} — check the installation, the threshold, or the case seal`)
  }
  if (s.grip && !s.grip.ok) {
    push('fail', `Fix grip: ${s.grip.blockKg}kg test mass beats ${s.grip.holdKg.toFixed(2)}kg hold — bigger servo/pinion or lighter test piece`)
  }
  if (s.power) {
    if (s.power.dead) {
      const bat = brief.battery || 'pack3s'
      push('fail', 'Fix power: battery flat — bigger pack or shorter duty cycle',
        bat !== 'lipo3s' && bat !== 'pd5v' ? { battery: 'lipo3s' } : null)
    } else if (s.power.cuts > 0 || s.power.tempMax > 75) {
      push('warn', `Fix thermal: servo hit ${Math.round(s.power.tempMax)}°C${s.power.cuts ? ` after ${s.power.cuts} cutoff${s.power.cuts > 1 ? 's' : ''}` : ''} — ease off stalls or pick hotter-rated servos`)
    }
  }
  return out.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'fail' ? -1 : 1))
}


// ── grip bench: one test mass between the pads ──────────────────────────────
// The gripper's bench piece: a 1kg test block fixtured at pad height on a
// dark pedestal. Closing the jaw is the test — hold capacity comes straight
// from design.metrics.gripMassKg, the same number the sizing checks print.

const GRIP_BENCH = { massG: 1000, size: [36, 24, 30], pos: [0, 0, 82], mat: 'steel' }
let _gripTris = null
function gripBenchTris() {
  if (_gripTris) return _gripTris
  _gripTris = deskBoxTris(0, 0, 59.5, 50, 40, 15, 'metal', 'grip-pedestal')
  _gripTris.push(...deskBoxTris(GRIP_BENCH.pos[0], GRIP_BENCH.pos[1], GRIP_BENCH.pos[2], ...GRIP_BENCH.size, GRIP_BENCH.mat, 'grip-testmass'))
  return _gripTris
}


// ── sensor stimulus bench: inject the environment, watch the readings ────────
// IoT nodes have no joints — the honest teleop is stimulus, not motion.
// Sliders set the physical world (temp, humidity, light, soil moisture,
// weight, motion, button); hud() reports what each fitted sensor would read
// and which thresholds alert. Nothing animates that isn't sensed.

const SENSOR_DEFS = {
  air:     { label: 'BME280 air', fields: [
    { k: 'tempC', label: 'TEMP', min: -10, max: 50, unit: '°C', def: 22, alert: (v) => v > 30 || v < 5 },
    { k: 'humid', label: 'RHUM', min: 5, max: 100, unit: '%', def: 45, alert: (v) => v > 70 || v < 20 },
  ]},
  motion:  { label: 'PIR motion', fields: [
    { k: 'motion', label: 'PRESENCE', min: 0, max: 1, unit: '', def: 0, alert: (v) => v > 0.5, bool: true },
  ]},
  soil:    { label: 'soil probe', fields: [
    { k: 'soil', label: 'MOIST', min: 0, max: 100, unit: '%', def: 55, alert: (v) => v < 30 },
  ]},
  weight:  { label: 'HX711 scale', fields: [
    { k: 'weightG', label: 'LOAD', min: 0, max: 5000, unit: 'g', def: 0, alert: () => false },
  ]},
  display: { label: 'SSD1306 OLED', fields: [] }, // shows the primary reading
}

function createSensorTeleop(design) {
  const sensors = (design.metrics && design.metrics.sensors) || []
  if (!sensors.length) return null
  const state = {}
  for (const sk of sensors) {
    for (const f of (SENSOR_DEFS[sk] || { fields: [] }).fields) state[f.k] = f.def
  }
  // OLED line: whichever real sensor exists leads the display
  const lead = sensors.find((k) => k !== 'display') || sensors[0]
  const fmt1 = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
  const alerts = () => {
    const out = []
    for (const sk of sensors) {
      for (const f of (SENSOR_DEFS[sk] || { fields: [] }).fields) {
        if (f.alert && f.alert(state[f.k])) out.push(`${SENSOR_DEFS[sk].label} ${f.label} ${fmt1(state[f.k])}${f.unit}`)
      }
    }
    return out
  }
  return {
    kind: 'sense',
    state,
    fields: sensors.flatMap((sk) => (SENSOR_DEFS[sk] || { fields: [] }).fields.map((f) => ({ ...f, sensor: sk, sensorLabel: SENSOR_DEFS[sk].label }))),
    /** Sliders write straight into state — sensors respond instantly. */
    set(key, value) { if (key in state) state[key] = value },
    step() { return null },
    reset() { for (const sk of sensors) for (const f of (SENSOR_DEFS[sk] || { fields: [] }).fields) state[f.k] = f.def },
    hud() {
      const lines = []
      for (const sk of sensors) {
        const def = SENSOR_DEFS[sk]
        if (!def || !def.fields.length) continue
        lines.push(`${def.label}: ${def.fields.map((f) => `${f.label} ${fmt1(state[f.k])}${f.unit}`).join(' · ')}`)
      }
      const al = alerts()
      const oled = lead && lead !== 'display'
        ? `${SENSOR_DEFS[lead].label.split(' ')[0]} ${SENSOR_DEFS[lead].fields.map((f) => `${fmt1(state[f.k])}${f.unit}`).join(' ')}`
        : 'rigforge node'
      return { kind: 'sense', lines, alerts: al, oled, ok: !al.length }
    },
  }
}
