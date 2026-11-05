// ── chassis drive: throttle, steer, traction — the machine actually moves ────
// Differential-drive model on the numbers the design already computed:
//   · per-side tractive force = 2 wheels × torquePerWheel / wheel radius
//   · traction cap = μ·m·g (rubber on the studio floor, μ = 0.8)
//   · yaw from differential wheel speeds about the track width
//   · speed asymptotes to the design's own speedMps (motor rpm × wheel Ø)
// Only wheeled archetypes get a drive state — legged gait is a different
// problem (footfall IK) and static nodes honestly have nothing to drive.

const DRIVE_MU = 0.8 // rubber pneumatic-ish on sealed floor
const DRIVE_VMAX_CAP = 1.4 // m/s — bench scale, not a highway

/** Returns null for machines with nothing to drive. */
function createDrive(design, analysis) {
  const m = (design && design.metrics) || {}
  if (!m.wheelD || !m.massKg || !m.motor) return null
  const motor = PARTS[m.motor]
  const wheelR = m.wheelD / 2000 // m
  const track = (m.trackMm || 300) / 1000 // m
  const mass = m.massKg
  // two driven wheels per side on a 4WD machine; torquePerWheel is N·m at the
  // wheel, so F = τ/r per wheel
  const fSide = 2 * (m.torquePerWheel || (motor && motor.torque) || 0.5) / Math.max(wheelR, 0.01)
  const vmax = Math.min(m.speedMps || 1, DRIVE_VMAX_CAP)
  // tractive limit: the floor can only push back μ·N before the wheels spin
  const fMax = DRIVE_MU * mass * 9.81
  const aMax = Math.min(fSide / mass, fMax / mass, 6) // m/s², capped for feel

  return {
    wheelD: m.wheelD,
    trackMm: m.trackMm || 300,
    vmax,
    fSide,
    aMax,
    state: { x: 0, y: 0, yaw: 0, v: 0, w: 0, throttle: 0, steer: 0 },
    /** cmd: {throttle: -1..1, steer: -1..1}; dt seconds. Mutates state. */
    step(cmd, dt) {
      const s = this.state
      s.throttle = Math.max(-1, Math.min(1, cmd.throttle || 0))
      s.steer = Math.max(-1, Math.min(1, cmd.steer || 0))
      // command velocity: throttle scales vmax; steer yaw rate falls off with
      // speed so the machine can still turn on the spot
      const vCmd = s.throttle * vmax
      const wCmd = -s.steer * (vmax / Math.max(track * 0.5, 0.05)) * (Math.abs(s.throttle) > 0.05 ? 1 : 0.6)
      // accelerate toward the command with a 0.3 s time constant, capped by
      // what the contact patches can actually transmit (μ·N) — that cap IS
      // the traction model: demand beyond it is wheelspin, not motion
      const aWant = (vCmd - s.v) / 0.3
      s.v += Math.sign(aWant) * Math.min(Math.abs(aWant), aMax) * dt
      const wWant = (wCmd - s.w) / 0.18
      const wMax = 3.2 // rad/s² yaw accel — steering geometry, not traction
      s.w += Math.sign(wWant) * Math.min(Math.abs(wWant), wMax) * dt
      s.x += s.v * Math.cos(s.yaw) * dt
      s.y += s.v * Math.sin(s.yaw) * dt
      s.yaw += s.w * dt
      if (s.yaw > Math.PI) s.yaw -= Math.PI * 2
      if (s.yaw < -Math.PI) s.yaw += Math.PI * 2
      return s
    },
    /** Reset to the origin, facing +X. */
    reset() { const s = this.state; s.x = 0; s.y = 0; s.yaw = 0; s.v = 0; s.w = 0; s.throttle = 0; s.steer = 0 },
    /** Telemetry for the HUD. */
    hud() {
      const s = this.state
      return { speed: Math.abs(s.v), yawDeg: Math.round((s.yaw * 180) / Math.PI), throttle: s.throttle, steer: s.steer }
    },
  }
}

/**
 * Transform every triangle of the viewport mesh by the chassis pose —
 * translate (x,y) then rotate about Z through the origin (machines are
 * modelled nose-on-+X, centred near origin). Returns a new array; the input
 * mesh is untouched so STL/exports never see the drive offset.
 */
function chassisTransformTris(mesh, st) {
  if (!st) return mesh
  const c = Math.cos(st.yaw), sn = Math.sin(st.yaw)
  const out = new Array(mesh.length)
  for (let i = 0; i < mesh.length; i++) {
    const t = mesh[i]
    const pts = new Array(3)
    for (let k = 0; k < 3; k++) {
      const p = t.pts[k]
      const rx = p[0] * c - p[1] * sn + st.x
      const ry = p[0] * sn + p[1] * c + st.y
      pts[k] = [rx, ry, p[2]]
    }
    out[i] = { ...t, pts }
  }
  return out
}
