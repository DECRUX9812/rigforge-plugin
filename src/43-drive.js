// ── chassis drive: throttle, steer, traction, slopes — the machine moves ────
// Differential-drive model on the numbers the design already computed:
//   · tractive force at the contact patch = 2 wheels × torquePerWheel / wheelR
//   · traction cap = μ·m·g·cos(grade) — demand beyond it is wheelspin
//   · gravity along the slope = m·g·sin(grade)·cos(yaw) — honest rollback
//   · yaw from differential wheel speeds about the track width
//   · speed asymptotes to the design's own speedMps (motor rpm × wheel Ø)
// Only wheeled archetypes get a drive state — legged gait is footfall IK,
// a different problem, and static nodes honestly have nothing to drive.

/** Bench surfaces — rubber-ish wheels on each. μ is honest, not generous. */
const DRIVE_SURFACES = {
  concrete: { mu: 0.9, label: 'dry concrete' },
  hardwood: { mu: 0.8, label: 'hardwood' },
  tile: { mu: 0.35, label: 'glazed tile' },
  ice: { mu: 0.12, label: 'wet ice' },
}

/** The traction rack: a wedge rising along +X, then a plateau. */
const RAMP = { x0: 1.4, x1: 3.0, halfW: 1.1, topX: 5.2 }

/** Terrain height at world x — flat, ramp grade, then plateau. */
function terrainHeight(x, slopeDeg, course) {
  if (course === 'stairs') return stairsHeight(x)
  if (course === 'room') return roomHeight(x)
  if (x <= RAMP.x0) return 0
  const h = (RAMP.x1 - RAMP.x0) * Math.tan((slopeDeg * Math.PI) / 180)
  if (x >= RAMP.x1) return h
  return (x - RAMP.x0) * Math.tan((slopeDeg * Math.PI) / 180)
}

/** Local grade (radians, + = uphill toward +X) at world x. */
function terrainGrade(x, slopeDeg, course) {
  if (course === 'stairs') return 0
  if (course === 'room') {
    for (const g of ROOM.segs) {
      if (x >= g[0] && x < g[1]) return g[3] !== g[2] ? Math.atan2(g[3] - g[2], g[1] - g[0]) : 0
    }
    return 0
  }
  if (x <= RAMP.x0 || x >= RAMP.x1) return 0
  return (slopeDeg * Math.PI) / 180
}

// ── living-room course ──────────────────────────────────────────────────────
// A fixed household course along +X: hardwood floor, an 18mm door-threshold
// hump at x≈1.2–1.95, a rug zone x∈[2.2,3.6] with μ=0.8, then floor again.
// Props are AABB obstacles the chassis collides with — every hit counts.

const ROOM = {
  // [x0, x1, h0, h1] piecewise-linear height profile, metres
  segs: [
    [0, 1.2, 0, 0],
    [1.2, 1.35, 0, 0.015],
    [1.35, 1.8, 0.015, 0.015],
    [1.8, 1.95, 0.015, 0],
    [1.95, 9, 0, 0],
  ],
  rug: { x0: 2.2, x1: 3.6, mu: 0.8 },
  muFloor: 0.55, // hardwood — the course sets its own surfaces
  // staggered so the centre line is blocked but a weave gets through:
  // shoebox guards the left lane, toy bin the right, books sit deeper right
  props: [
    { id: 'shoebox', name: 'shoe box', c: [2.7, 0.22], half: [0.11, 0.10], top: 0.12, size: [0.22, 0.20, 0.12], mat: 'accent' },
    { id: 'bin', name: 'toy bin', c: [2.45, -0.28], half: [0.10, 0.10], top: 0.16, size: [0.20, 0.20, 0.16], mat: 'metal' },
    { id: 'books', name: 'book stack', c: [1.7, -0.62], half: [0.09, 0.08], top: 0.10, size: [0.18, 0.16, 0.10], mat: 'pcb' },
  ],
}

function roomHeight(x) {
  for (const g of ROOM.segs) {
    if (x >= g[0] && x < g[1]) return g[2] + ((x - g[0]) / (g[1] - g[0])) * (g[3] - g[2])
  }
  return ROOM.segs[ROOM.segs.length - 1][3]
}

/** Friction at world x — the rug grips harder than the floor. */
function muAt(x, env) {
  if (env.course === 'stairs') return DRIVE_SURFACES.hardwood.mu
  if (env.course === 'room') {
    return x >= ROOM.rug.x0 && x < ROOM.rug.x1 ? ROOM.rug.mu : ROOM.muFloor
  }
  return (DRIVE_SURFACES[env.surface] || DRIVE_SURFACES.hardwood).mu
}

// Course dressing (ramps, rooms, stairs) is authored in metres to match the
// drive physics and terrainHeight(); the render space is mm — scale at the
// boundary so tris land in the same space as the machine mesh.
function courseTrisMm(tris) {
  return tris.map((t) => ({ ...t, pts: t.pts.map((p) => [p[0] * 1000, p[1] * 1000, p[2] * 1000]) }))
}

// ── stairs course ───────────────────────────────────────────────────────────
// A porch-stair run along +X: 4 risers of 80mm with 320mm treads. Whether a
// chassis mounts a nosing is decided by wheel radius, not by torque — a rigid
// bot on 50mm wheels cannot climb an 80mm step, and the bench says so.
const STAIRS = { x0: 1.6, tread: 0.32, stepH: 0.08, n: 4, halfW: 1.1 }

function stairsHeight(x) {
  if (x <= STAIRS.x0) return 0
  const i = Math.floor((x - STAIRS.x0) / STAIRS.tread)
  return Math.min(i + 1, STAIRS.n) * STAIRS.stepH
}

/** Stacked tread boxes — reads as a real stair flight, not a ramp. */
function stairsTris() {
  const tris = []
  for (let i = 0; i < STAIRS.n; i++) {
    tris.push(...deskBoxTris(
      STAIRS.x0 + (i + 0.5) * STAIRS.tread, 0, (i + 0.5) * STAIRS.stepH,
      STAIRS.tread, STAIRS.halfW * 2, STAIRS.stepH, 'metal', `stair-${i}`))
  }
  return courseTrisMm(tris)
}

/**
 * Wedge + plateau test-rack geometry as render tris. `mat` is a viewport
 * material key; the ramp reads as aluminium test equipment with an amber
 * edge stripe so it never blends into the floor.
 */
function benchRampTris(slopeDeg) {
  const h = (RAMP.x1 - RAMP.x0) * Math.tan((slopeDeg * Math.PI) / 180)
  const { x0, x1, halfW, topX } = RAMP
  const W = halfW
  const tris = []
  const T = (a, b, c, mat, node) => tris.push({ pts: [a, b, c], mat, node })
  const s0 = [x0, -W, 0], s1 = [x1, -W, h], s2 = [x1, W, h], s3 = [x0, W, 0]
  const p0 = [x1, -W, h], p1 = [topX, -W, h], p2 = [topX, W, h], p3 = [x1, W, h]
  // top surface: two quads → four tris (winding fixed by renderer anyway)
  T(s0, s1, s2, 'metal', 'bench-ramp'); T(s0, s2, s3, 'metal', 'bench-ramp')
  T(p0, p1, p2, 'metal', 'bench-ramp'); T(p0, p2, p3, 'metal', 'bench-ramp')
  // front skirt (y=-W): slope face + plateau face + bottom edge
  T([x0, -W, 0], [x0, -W, 0], [x1, -W, h], 'metal', 'bench-ramp')
  T([x0, -W, 0], [x1, -W, h], [x1, -W, 0], 'metal', 'bench-ramp')
  T([x1, -W, h], [x1, -W, 0], [topX, -W, h], 'metal', 'bench-ramp')
  T([x1, -W, 0], [topX, -W, 0], [topX, -W, h], 'metal', 'bench-ramp')
  // back skirt (y=+W), mirrored
  T([x0, W, 0], [x1, W, h], [x0, W, 0], 'metal', 'bench-ramp')
  T([x1, W, h], [x1, W, 0], [x0, W, 0], 'metal', 'bench-ramp')
  T([x1, W, h], [topX, W, h], [x1, W, 0], 'metal', 'bench-ramp')
  T([topX, W, h], [topX, W, 0], [x1, W, 0], 'metal', 'bench-ramp')
  // toe face at x0 (vertical triangle under the ramp lip)
  T([x0, -W, 0], [x0, W, 0], [x1, -W, h], 'metal', 'bench-ramp')
  T([x0, W, 0], [x1, W, h], [x1, -W, h], 'metal', 'bench-ramp')
  // end face at topX
  T([topX, -W, h], [topX, W, h], [topX, W, 0], 'metal', 'bench-ramp')
  T([topX, -W, h], [topX, W, 0], [topX, -W, 0], 'metal', 'bench-ramp')
  // amber edge stripe along both lips of the driving surface
  const stripe = (ya, yb) => {
    const a = [x0, ya, 0.012], b = [x1, yb, h + 0.012], c = [x1, yb, h - 0.012], d = [x0, ya, -0.012]
    T(a, b, c, 'accent', 'bench-ramp'); T(a, c, d, 'accent', 'bench-ramp')
    const e = [x1, ya, h + 0.012], f = [topX, yb, h + 0.012], g = [topX, yb, h - 0.012], hh = [x1, ya, h - 0.012]
    T(e, f, g, 'accent', 'bench-ramp'); T(e, g, hh, 'accent', 'bench-ramp')
  }
  stripe(-W + 0.03, -W + 0.03)
  stripe(W - 0.03, W - 0.03)
  return courseTrisMm(tris)
}

/** Returns null for machines with nothing to drive. */
function createDrive(design, analysis) {
  const m = (design && design.metrics) || {}
  if (!m.wheelD || !m.massKg || !m.motor) return null
  const motor = PARTS[m.motor]
  const wheelR = m.wheelD / 2000 // m
  const track = (m.trackMm || 300) / 1000 // m
  const baseMass = m.massKg
  // Tractive capability: two motor channels (one per side, each driving a
  // wheel pair) at ~35% of stall torque — what a brushed DC gearmotor actually
  // sustains, not the peak it dies at. F = τ/r per channel.
  const motorTorque = (motor && motor.torque) || m.torquePerWheel || 0.5
  const fMotor = (2 * motorTorque * 0.35) / Math.max(wheelR, 0.01)
  const vmax = Math.min(m.speedMps || 1, 1.4) // bench scale, not a highway
  // largest riser this chassis can mount: about a wheel radius of bite
  const maxStep = wheelR * 1.1

  const env = { surface: 'hardwood', slopeDeg: 0, payloadKg: 0 }
  const mass = () => baseMass + (env.payloadKg || 0)

  return {
    kind: 'drive',
    wheelD: m.wheelD,
    trackMm: m.trackMm || 300,
    bodyKg: m.massKg, // carried-load tests scale off this
    vmax,
    fMotor,
    env,
    surfaces: DRIVE_SURFACES,
    /** Merge bench controls; physics picks them up next step. */
    setEnv(patch) { Object.assign(env, patch) },
    state: { x: 0, y: 0, yaw: 0, v: 0, w: 0, vl: 0, throttle: 0, steer: 0, grade: 0, z: 0, slip: false, stall: false, bumps: 0, stepHit: false },
    /** cmd: {throttle: -1..1, steer: -1..1}; dt seconds. Mutates state. */
    step(cmd, dt) {
      const s = this.state
      dt = Math.min(dt, 0.05)
      s.throttle = Math.max(-1, Math.min(1, cmd.throttle || 0))
      s.steer = Math.max(-1, Math.min(1, cmd.steer || 0))
      const mNow = mass()
      const course = env.course === 'room' ? 'room' : env.course === 'stairs' ? 'stairs' : 'rack'
      const mu = muAt(s.x, env)
      const grade = terrainGrade(s.x, env.slopeDeg, course)
      s.grade = grade
      s.z = terrainHeight(s.x, env.slopeDeg, course)

      // command velocity; steer yaw rate falls off with speed so the machine
      // can still turn on the spot
      const vCmd = s.throttle * vmax
      const wCmd = -s.steer * (vmax / Math.max(track * 0.5, 0.05)) * (Math.abs(s.throttle) > 0.05 ? 1 : 0.6)

      // Torque-speed curve: full tractive effort at stall, fading linearly to
      // nothing at the commanded speed — so partial throttle means partial
      // speed, and a slope that eats the torque shows up as lost speed.
      const vT = Math.abs(vCmd) + 0.05
      const speedFrac = Math.min(1, Math.abs(s.v) / vT)
      const tAvail = fMotor * Math.max(0, 1 - speedFrac)
      const Fdem = s.throttle * tAvail
      const N = mNow *  G * Math.cos(grade)
      const Fcap = mu * N
      s.slip = Math.abs(Fdem) > Fcap + 1e-6
      const F = Math.sign(Fdem) * Math.min(Math.abs(Fdem), Fcap)
      const uphill = Math.cos(s.yaw) // heading · +X — ramp runs along +X
      const aGrav = - G * Math.sin(grade) * uphill
      // rolling resistance + viscous drag: the machine actually stops when you
      // let go, instead of coasting forever on a frictionless floor
      const aRoll = -Math.sign(s.v) * (0.35 + 0.25 * Math.abs(s.v))
      // Static friction: below the friction angle tanθ = μ a stationary machine
      // stays put. Without this a parked rover creeps down ANY slope, so "will
      // it hold on a 20° ramp" could never be answered honestly. The gate has to
      // run before the integrate — checking afterwards lets one gravity tick
      // through and the machine is already moving.
      const aStatic = mu * G * Math.cos(grade)
      const parked = Math.abs(s.throttle) < 0.02 && Math.abs(s.v) < 0.08 && Math.abs(aGrav) <= aStatic + 1e-9
      const aG = parked ? 0 : aGrav
      s.v += Math.max(-4, Math.min(4, F / mNow + aG + aRoll)) * dt
      if (parked) s.v = 0

      const wWant = (wCmd - s.w) / 0.18
      const wMax = 3.2
      s.w += Math.sign(wWant) * Math.min(Math.abs(wWant), wMax) * dt
      // lateral slide from a shove: scrubbed off fast — side contact patches
      // dig in harder than the driven wheels do
      const aLat = mu * G * Math.cos(grade) * 1.6
      s.vl -= Math.sign(s.vl) * Math.min(Math.abs(s.vl), aLat * dt)
      if (Math.abs(s.vl) < 0.005) s.vl = 0
      const fx = Math.cos(s.yaw), fy = Math.sin(s.yaw)
      const xPrev = s.x, yPrev = s.y
      s.x += (s.v * fx - s.vl * fy) * dt
      s.y += (s.v * fy + s.vl * fx) * dt
      s.yaw += s.w * dt
      // stairs: a riser taller than the wheel radius is a wall, not a grade.
      // The nose may already be over the nosing when the hull centre crosses,
      // so the check keys on centre-x — close enough for a bench verdict.
      let stepBlocked = false
      if (course === 'stairs') {
        const rise = terrainHeight(s.x, env.slopeDeg, course) - s.z
        if (rise > maxStep) {
          s.x = xPrev; s.y = yPrev
          s.v = 0; s.vl = 0
          s.stall = true
          stepBlocked = true
          if (!s.stepHit) { s.bumps = (s.bumps || 0) + 1; s.stepHit = true }
        } else s.stepHit = false
      }
      if (s.yaw > Math.PI) s.yaw -= Math.PI * 2
      if (s.yaw < -Math.PI) s.yaw += Math.PI * 2
      // living-room obstacles: circle chassis vs AABB props, kill inward vel
      if (course === 'room') {
        const r = Math.max(0.14, ((m.trackMm || 300) / 1000) * 0.55)
        const fx2 = Math.cos(s.yaw), fy2 = Math.sin(s.yaw)
        for (const pr of ROOM.props) {
          const nx = Math.max(pr.c[0] - pr.half[0], Math.min(s.x, pr.c[0] + pr.half[0]))
          const ny = Math.max(pr.c[1] - pr.half[1], Math.min(s.y, pr.c[1] + pr.half[1]))
          const ddx = s.x - nx, ddy = s.y - ny
          const d2 = ddx * ddx + ddy * ddy
          if (d2 >= r * r || s.z >= pr.top) continue
          const d = Math.sqrt(d2) || 1e-6
          const px = ddx / d, py = ddy / d
          s.x = nx + px * r
          s.y = ny + py * r
          // velocity = v·heading + vl·lateral; strip the component into the prop
          let vx = s.v * fx2 - s.vl * fy2
          let vy = s.v * fy2 + s.vl * fx2
          const vn = vx * px + vy * py
          if (vn < 0) {
            if (-vn > 0.15) s.bumps = (s.bumps || 0) + 1
            vx -= vn * px * 1.15 // slight restitution
            vy -= vn * py * 1.15
            s.v = vx * fx2 + vy * fy2
            s.vl = -vx * fy2 + vy * fx2
          }
        }
      }
      // stall = flooring it on a grade but crawling: under ~13 cm/s of
      // progress (or sliding backwards) the machine is not climbing — the
      // traction fix and this flag are the same failure seen two ways.
      s.stall = stepBlocked || (s.throttle > 0.3 && grade > 0.03 && s.v < 0.13)
      return s
    },
    /** Disturbance test: a lateral shove in newtons — slides and yaws the
     *  machine, then traction scrub kills the slide. The bench's point. */
    shove(forceN) {
      const s = this.state
      const mNow = mass()
      s.vl += (forceN * 0.25) / mNow // N·s impulse over ~0.25 s contact
      s.w += (forceN * 0.12) / Math.max(mNow * 0.3, 0.5) // off-centre hits spin it
      return s
    },
    /** Reset to the origin, facing +X (the ramp's toe). */
    reset() {
      const s = this.state
      s.x = 0; s.y = 0; s.yaw = 0; s.v = 0; s.w = 0; s.vl = 0
      s.throttle = 0; s.steer = 0; s.slip = false; s.stall = false; s.bumps = 0; s.stepHit = false
    },
    /** Telemetry for the HUD. */
    hud() {
      const s = this.state
      const surf = DRIVE_SURFACES[env.surface] || DRIVE_SURFACES.hardwood
      return {
        speed: Math.abs(s.v),
        yawDeg: Math.round((s.yaw * 180) / Math.PI),
        throttle: s.throttle,
        steer: s.steer,
        gradeDeg: Math.round((s.grade * 180) / Math.PI),
        surface: surf.label,
        mu: surf.mu,
        mass: mass(),
        slip: s.slip,
        stall: s.stall,
        slide: Math.abs(s.vl) > 0.08,
        course: env.course === 'room' ? 'room' : env.course === 'stairs' ? 'stairs' : 'rack',
        bumps: s.bumps || 0,
      }
    },
  }
}

/**
 * Rigid-body transform of every viewport triangle by the chassis pose:
 * pitch about the local Y axis through the terrain grade, yaw about Z,
 * then translate to (x, y) and lift by the terrain height under the hull.
 * A stable `out` array can be passed to keep mesh identity for caches.
 */
function applyChassis(mesh, st, slopeDeg, out, course) {
  if (!st) return mesh
  // chassis state and terrain courses are metres; mesh pts are mm
  const mx = st.x * 1000, my = st.y * 1000
  const g = st.grade || 0
  const cp = Math.cos(-g), sp = Math.sin(-g)
  const c = Math.cos(st.yaw), sn = Math.sin(st.yaw)
  const zBase = terrainHeight(st.x, slopeDeg || 0, course) * 1000
  const res = out || new Array(mesh.length)
  for (let i = 0; i < mesh.length; i++) {
    const t = mesh[i]
    let slot = res[i]
    if (!slot) {
      slot = { ...t, pts: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }
      res[i] = slot
    }
    const pts = slot.pts
    for (let k = 0; k < 3; k++) {
      const p = t.pts[k]
      // pitch about local Y (nose-up when climbing), then yaw about Z
      const px = p[0] * cp + p[2] * sp
      const pz = -p[0] * sp + p[2] * cp
      const py = p[1]
      pts[k][0] = px * c - py * sn + mx
      pts[k][1] = px * sn + py * c + my
      pts[k][2] = pz + zBase
    }
  }
  return res
}


/** Living-room course dressing: rug, threshold strip, and the three props. */
let _roomTris = null
function livingRoomTris() {
  if (_roomTris) return _roomTris
  const raw = []
  const T = (a, b, c, mat, node) => raw.push({ pts: [a, b, c], mat, node })
  // rug: thin padded rectangle under the high-mu zone
  const rug = { x0: ROOM.rug.x0 - 0.15, x1: ROOM.rug.x1 + 0.15, y: 1.25, t: 0.012 }
  const rz = rug.t / 2
  for (const zz of [0, rug.t]) {
    const z = zz + 0.001
    T([rug.x0, -rug.y, z], [rug.x1, -rug.y, z], [rug.x1, rug.y, z], 'rubber', 'rug')
    T([rug.x0, -rug.y, z], [rug.x1, rug.y, z], [rug.x0, rug.y, z], 'rubber', 'rug')
  }
  // threshold strip: metal nosing along the hump crest line
  T([1.32, -1.2, 0.016], [1.36, -1.2, 0.016], [1.36, 1.2, 0.016], 'metal', 'threshold')
  T([1.32, -1.2, 0.016], [1.36, 1.2, 0.016], [1.32, 1.2, 0.016], 'metal', 'threshold')
  // props
  for (const pr of ROOM.props) {
    const [sx, sy, sz] = pr.size
    const onRug = pr.c[0] >= ROOM.rug.x0 && pr.c[0] < ROOM.rug.x1
    const baseZ = (onRug ? rug.t : 0) + 0.001
    raw.push(...deskBoxTris(pr.c[0], pr.c[1], baseZ + sz / 2, sx, sy, sz, pr.mat, `room-${pr.id}`))
  }
  _roomTris = courseTrisMm(raw)
  return _roomTris
}
