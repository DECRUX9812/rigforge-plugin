// Autopilot certification — one click runs the machine through a scripted
// maneuver suite and scores each check against live teleop state. Every
// check is a real measurement; nothing passes by default, so a machine that
// can't climb wet ice, reach the bench, or cycle its jaw fails here exactly
// as it would on the floor.
//
// createAutotest(teleop) dispatches on teleop.kind — drive machines get the
// maneuver suite, arms get a reach tour over the desk props, legged bots a
// stride test, grippers a jaw-cycle test, sensor nodes a stimulus sweep.

const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a }
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Shared facade: page/HUD/report only ever touch these members. */
function facade(script) {
  return {
    get running() { return script.running },
    get done() { return script.done },
    get results() { return script.results },
    get phase() { return script.phase },
    get score() { return `${script.results.filter((r) => r.pass).length}/${script.results.length}` },
    start() { script.start() },
    stop() { script.stop() },
    tick(dt, actual) { return script.tick(dt, actual) },
  }
}

function begin(script, label, dur, n) {
  script.phase = { label, t: 0, dur, n }
}
function pushResult(script, id, label, pass, detail) {
  script.results.push({ id, label, pass: !!pass, detail })
}

// ── drive: sprint / turn / climb / shove / return ────────────────────────────

const DRIVE_PHASES = [
  { id: 'sprint', label: 'SPRINT', dur: 2.5, throttle: 1, steer: 0 },
  { id: 'turn',   label: 'TURN',   dur: 1.6, throttle: 0.4, steer: -1 },
  { id: 'climb',  label: 'CLIMB',  dur: 4.0, throttle: 1, steer: 0 },
  { id: 'shove',  label: 'SHOVE',  dur: 1.8, throttle: 1.0, steer: 0, shoveAt: 0.4, shoveN: 15 },
  { id: 'return', label: 'RETURN', dur: 2.2, throttle: 0.6, steer: 1 },
]

function driveAutotest(drive) {
  const st = { running: false, done: false, idx: 0, t: 0, results: [], phase: null }
  let mark = null

  function beginPhase(i) {
    const p = DRIVE_PHASES[i]
    const s = drive.state
    mark = {
      x0: s.x, y0: s.y, yaw0: s.yaw, z0: s.z, bumps0: s.bumps || 0,
      maxV: 0, stallT: 0, slipT: 0, gradeT: 0, vPreShove: null, shoved: false,
    }
    st.idx = i; st.t = 0
    begin(st, p.label, p.dur, DRIVE_PHASES.length)
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
    const p = DRIVE_PHASES[st.idx]
    const r = score(p, mark, drive.state)
    pushResult(st, p.id, p.label, r.pass, r.detail)
    st.phase = null
  }

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      drive.reset()
      st.running = true; st.done = false; st.results = []; st.idx = 0; st.t = 0
      beginPhase(0)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { throttle: 0, steer: 0 }
      const p = DRIVE_PHASES[st.idx]
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
        if (st.idx + 1 >= DRIVE_PHASES.length) {
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
        steer = clampN((0.9 * s.w - 2.2 * err) / kYaw, -1, 1)
      }
      return { throttle: p.throttle, steer }
    },
  })
}

// ── reach: waypoint tour over the desk props, scored on real IK error ────────

function reachAutotest(ik) {
  const st = { running: false, done: false, results: [], phase: null, home: null, seedAngles: null }
  // one leg per prop: seek the descend point, then wait for the live tip to
  // arrive (the joint sim slews at real servo speed — that lag is the test).
  // Every seek seeds from the SAME rest pose — certification asks "can the
  // arm reach this point from standing", not "can CCD escape the last
  // leg's local minimum".
  const legs = []
  for (const p of DESK_PROPS) {
    const top = p.pos[2] + p.size[2] / 2
    legs.push({ kind: 'prop', prop: p, wp: [p.pos[0], p.pos[1], top + 8], pose: null, t: 0, err: null })
  }
  legs.push({ kind: 'home', wp: null, pose: null, t: 0, err: null })
  let li = 0

  const legLabel = (l) => (l.kind === 'home' ? 'HOME' : `REACH ${l.prop.name}`)

  function scoreLeg() {
    const leg = legs[li]
    const err = leg.err == null ? 999 : leg.err
    if (leg.kind === 'home') pushResult(st, 'home', 'HOME', err <= 45, `returned, err ${err.toFixed(0)}mm`)
    else pushResult(st, `reach-${leg.prop.id}`, leg.prop.name.toUpperCase(), err <= 30, `err ${err.toFixed(0)}mm`)
  }
  function advance() {
    li++
    if (li >= legs.length) { st.running = false; st.done = true; st.phase = null; return false }
    begin(st, legLabel(legs[li]), 6, legs.length)
    return true
  }

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      ik.reset()
      st.running = true; st.done = false; st.results = []; st.home = null; st.seedAngles = null
      li = 0
      legs.forEach((l) => { l.t = 0; l.err = null; l.pose = null; l.wp = l.kind === 'home' ? null : l.wp })
      begin(st, legLabel(legs[0]), 6, legs.length)
    },
    stop() { st.running = false; st.phase = null },
    /**
     * tick(dt, actual) — `actual` is the live joint-angle array. Returns
     * {pose} for the page to apply directly (the IK seek already solved it),
     * or {x,y,z} for callers without a pose channel.
     */
    tick(dt, actual) {
      if (!st.running) return { x: 0, y: 0, z: 0 }
      const leg = legs[li]
      leg.t += dt
      st.phase.t = leg.t
      if (!st.seedAngles) st.seedAngles = (actual || []).slice()
      if (leg.kind === 'home' && !leg.wp) {
        // home = wherever the tip started this run
        leg.wp = ik.tipPos ? ik.tipPos(st.seedAngles) : [0, 0, 150]
      }
      if (!leg.pose) leg.pose = ik.seek(leg.wp[0], leg.wp[1], leg.wp[2], st.seedAngles)
      const e = typeof ik.liveErr === 'function' ? ik.liveErr(actual || []) : (ik.state.err || 999)
      leg.err = leg.err == null ? e : Math.min(leg.err, e)
      const need = leg.kind === 'home' ? 45 : 30
      if (e <= need || leg.t > 6) {
        scoreLeg()
        if (!advance()) return { x: 0, y: 0, z: 0, pose: leg.pose }
      }
      return { x: 0, y: 0, z: 0, pose: leg.pose }
    },
  })
}

// ── gait: trot N strides, then stand — checks cadence and clean stop ─────────

function gaitAutotest(gait) {
  const st = { running: false, done: false, results: [], phase: null }
  let leg = 'walk', t = 0, strides0 = 0

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      gait.reset()
      st.running = true; st.done = false; st.results = []
      leg = 'walk'; t = 0; strides0 = gait.state.strides
      begin(st, 'TROT', 10, 2)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { x: 0 }
      t += dt
      if (leg === 'walk') {
        const gained = gait.state.strides - strides0
        if (gained >= 8 || t > 10) {
          pushResult(st, 'strides', 'STRIDES', gained >= 6, `${gained.toFixed(1)} strides in ${t.toFixed(1)}s`)
          leg = 'stand'; t = 0
          begin(st, 'STAND', 2, 2)
          return { x: 0 }
        }
        st.phase.t = t
        return { x: 0.85 }
      }
      st.phase.t = t
      if (t >= 1.6) {
        const stopped = gait.state.speed < 0.03
        pushResult(st, 'stand', 'STAND', stopped, `settled at ${gait.state.speed.toFixed(2)} speed`)
        st.running = false; st.done = true; st.phase = null
      }
      return { x: 0 }
    },
  })
}

// ── grip: jaw must cycle open↔closed on command ──────────────────────────────

function gripAutotest(grip) {
  const st = { running: false, done: false, results: [], phase: null }
  let t = 0, pulses = 0, prevOpen = null, toggles = 0

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      grip.reset()
      st.running = true; st.done = false; st.results = []
      t = 0; pulses = 0; toggles = 0; prevOpen = grip.state.open
      begin(st, 'JAW', 9, 1)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { grip: false, gripEdge: false }
      t += dt
      st.phase.t = t
      if (grip.state.open !== prevOpen) { toggles++; prevOpen = grip.state.open }
      // one edge pulse every 1.4s — six commanded cycles
      const edge = pulses < 6 && t >= (pulses + 1) * 1.4 - dt / 2 && t < (pulses + 1) * 1.4 + dt
      if (edge) pulses++
      if (t >= 9.2) {
        pushResult(st, 'jaw', 'JAW', toggles >= 5, `${toggles} jaw transitions`)
        st.running = false; st.done = true; st.phase = null
      }
      return { grip: false, gripEdge: !!edge }
    },
  })
}

// ── sense: sweep one stimulus into alert territory and back ──────────────────

function senseAutotest(sense) {
  const st = { running: false, done: false, results: [], phase: null }
  // pick the first field whose alert actually fires at an extreme
  const field = (sense.fields || []).find((f) => f.alert && (f.alert(f.max) || f.alert(f.min)))
  const target = field ? (field.alert(field.max) ? field.max : field.min) : null
  let leg = 'restore', t = 0, fired = false

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      sense.reset()
      st.running = true; st.done = false; st.results = []
      leg = 'restore'; t = 0; fired = false
      if (field) sense.set(field.k, field.def)
      begin(st, field ? `STIM ${field.label}` : 'STIM', 6, 1)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return null
      t += dt
      st.phase.t = t
      if (!field || target == null) {
        pushResult(st, 'sense', 'SENSE', false, 'no alertable stimulus field')
        st.running = false; st.done = true; st.phase = null
        return null
      }
      if (leg === 'restore' && t >= 0.8) { leg = 'stim'; t = 0; begin(st, `STIM ${field.label}`, 6, 1) }
      else if (leg === 'stim') {
        // ramp toward the alert extreme — sensors respond instantly, so the
        // crossing itself is the test
        const u = Math.min(1, t / 1.5)
        sense.set(field.k, field.def + (target - field.def) * u)
        if (t >= 1.5) { leg = 'hold'; t = 0 }
      } else if (leg === 'hold') {
        if (sense.hud().alerts.length) fired = true
        if (t >= 1.2) { leg = 'restore2'; t = 0 }
      } else if (leg === 'restore2') {
        sense.set(field.k, field.def + (field.def - target) * Math.min(1, t / 0.8))
        if (t >= 0.9) {
          pushResult(st, 'sense', 'SENSE', fired, fired ? `${field.label} alert fired` : `${field.label} never alerted`)
          st.running = false; st.done = true; st.phase = null
        }
      }
      return null
    },
  })
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function createAutotest(teleop) {
  if (!teleop) return null
  if (teleop.kind === 'drive' || teleop.wheelD) return driveAutotest(teleop)
  if (teleop.kind === 'ik') return reachAutotest(teleop)
  if (teleop.kind === 'gait') return gaitAutotest(teleop)
  if (teleop.kind === 'grip') return gripAutotest(teleop)
  if (teleop.kind === 'sense') return senseAutotest(teleop)
  return null
}
