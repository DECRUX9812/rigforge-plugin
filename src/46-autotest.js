// Autopilot certification run — scripts throttle/steer through a fixed
// maneuver suite and scores each phase against live drive state. Every
// check is a real measurement off drive.state; nothing passes by default,
// so a machine that can't climb wet ice or recover from a shove fails here
// exactly as it would on the floor.

const PHASES = [
  { id: 'sprint', label: 'SPRINT', dur: 2.5, throttle: 1, steer: 0 },
  { id: 'turn',   label: 'TURN',   dur: 1.6, throttle: 0.4, steer: -1 },
  { id: 'climb',  label: 'CLIMB',  dur: 4.0, throttle: 1, steer: 0 },
  { id: 'shove',  label: 'SHOVE',  dur: 1.8, throttle: 1.0, steer: 0, shoveAt: 0.4, shoveN: 15 },
  { id: 'return', label: 'RETURN', dur: 2.2, throttle: 0.6, steer: 1 },
]

const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a }

function createAutotest(drive) {
  const st = {
    running: false, done: false, idx: 0, t: 0,
    results: [], // {id,label,pass,detail}
    phase: null, // live phase info for the HUD
  }
  let mark = null // per-phase accumulators

  function beginPhase(i) {
    const p = PHASES[i]
    const s = drive.state
    mark = {
      x0: s.x, y0: s.y, yaw0: s.yaw, z0: s.z, bumps0: s.bumps || 0,
      maxV: 0, stallT: 0, slipT: 0, gradeT: 0, vPreShove: null, shoved: false,
    }
    st.idx = i; st.t = 0; st.phase = { ...p, t: 0, n: PHASES.length }
  }

  function score(p, m, s) {
    const dist = Math.hypot(s.x - m.x0, s.y - m.y0)
    const stallFrac = m.stallT / p.dur
    const bumps = (s.bumps || 0) - m.bumps0
    switch (p.id) {
      case 'sprint': {
        const need = drive.vmax * 0.45
        return { pass: m.maxV >= need, detail: `top ${m.maxV.toFixed(2)} m/s vs ${need.toFixed(2)} needed` }
      }
      case 'turn': {
        const dyaw = Math.abs(wrap(s.yaw - m.yaw0))
        return { pass: dyaw >= 0.5, detail: `turned ${(dyaw * 180 / Math.PI).toFixed(0)}°` }
      }
      case 'climb': {
        // elevation is the honest metric — you cannot fake altitude. On a
        // mostly-flat bench the same phase degrades to a sustained-speed run.
        if (m.gradeT / p.dur < 0.3) {
          const ok = dist >= 0.8 && stallFrac < 0.4
          return { pass: ok, detail: `flat run ${dist.toFixed(2)} m, stall ${(stallFrac * 100).toFixed(0)}%` }
        }
        const dz = s.z - m.z0
        const ok = dz >= 0.1 && stallFrac < 0.4
        return { pass: ok, detail: `+${dz.toFixed(2)} m climb, stall ${(stallFrac * 100).toFixed(0)}%${s.grade > 0.05 ? ` @ ${(s.grade * 180 / Math.PI).toFixed(0)}°` : ''}` }
      }
      case 'shove': {
        const recovered = s.v > 0.15 || dist > 0.3
        return { pass: recovered && stallFrac < 0.6, detail: `post-shove ${s.v.toFixed(2)} m/s, ${bumps} bump${bumps === 1 ? '' : 's'}` }
      }
      case 'return': {
        const ok = Math.abs(s.v) > 0.03 || dist > 0.3
        return { pass: ok && stallFrac < 0.6, detail: `finished at ${s.v.toFixed(2)} m/s, ${bumps} bump${bumps === 1 ? '' : 's'}` }
      }
      default: return { pass: false, detail: 'unknown phase' }
    }
  }

  function endPhase() {
    const p = PHASES[st.idx]
    const r = score(p, mark, drive.state)
    st.results.push({ id: p.id, label: p.label, ...r })
    st.phase = null
  }

  return {
    get running() { return st.running },
    get done() { return st.done },
    get results() { return st.results },
    get phase() { return st.phase },
    get score() { return `${st.results.filter((r) => r.pass).length}/${st.results.length}` },
    /** Begin a run from a known state. */
    start() {
      drive.reset()
      st.running = true; st.done = false; st.results = []; st.idx = 0; st.t = 0
      beginPhase(0)
    },
    stop() { st.running = false; st.phase = null },
    /**
     * Advance the script one frame. Returns the {throttle, steer} command
     * the caller must feed to drive.step — the script owns the inputs
     * while running.
     */
    tick(dt) {
      if (!st.running) return { throttle: 0, steer: 0 }
      const p = PHASES[st.idx]
      const s = drive.state
      st.t += dt
      mark.maxV = Math.max(mark.maxV, Math.abs(s.v))
      if (s.stall) mark.stallT += dt
      if (s.slip) mark.slipT += dt
      if (s.grade > 0.03) mark.gradeT += dt
      if (p.shoveAt != null && !mark.shoved && st.t >= p.shoveAt) {
        mark.shoved = true
        mark.vPreShove = s.v
        drive.shove(p.shoveN)
      }
      if (st.t >= p.dur) {
        endPhase()
        if (st.idx + 1 >= PHASES.length) {
          st.running = false; st.done = true
          return { throttle: 0, steer: 0 }
        }
        beginPhase(st.idx + 1)
      }
      st.phase.t = st.t
      // climb holds heading toward +X (the ramp direction). PD on yaw rate —
      // a saturated P-only steer overshoots through 200°+ because the
      // chassis yaw has real inertia (w slews at wMax rad/s²).
      let steer = p.steer
      if (p.id === 'climb') {
        const kYaw = drive.vmax / Math.max((drive.trackMm / 1000) * 0.5, 0.05)
        const err = wrap(-s.yaw)
        steer = Math.max(-1, Math.min(1, (0.9 * s.w - 2.2 * err) / kYaw))
      }
      return { throttle: p.throttle, steer }
    },
  }
}
