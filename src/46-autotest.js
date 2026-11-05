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
  { id: 'load',   label: 'LOAD',   dur: 4.0, throttle: 1, steer: 0, payloadFrac: 0.3 },
  { id: 'shove',  label: 'SHOVE',  dur: 1.8, throttle: 1.0, steer: 0, shoveAt: 0.4, shoveN: 15 },
  { id: 'return', label: 'RETURN', dur: 2.2, throttle: 0.6, steer: 1 },
]

function driveAutotest(drive) {
  const st = { running: false, done: false, idx: 0, t: 0, results: [], phase: null }
  let mark = null

  function beginPhase(i) {
    const p = DRIVE_PHASES[i]
    const s = drive.state
    // carried load rides on env.payloadKg — set it for the phase, clear after
    if (typeof drive.setEnv === 'function') {
      drive.setEnv({ payloadKg: p.payloadFrac ? (drive.bodyKg || 5) * p.payloadFrac : 0 })
    }
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
      case 'load': {
        // 30% of body mass in the bay — payload physics already live in
        // createDrive (mass() feeds traction cap, grade force and shove)
        const payKg = (drive.bodyKg || 5) * (p.payloadFrac || 0.3)
        if (m.gradeT / p.dur < 0.3) {
          const ok = dist >= 0.7 && stallFrac < 0.5
          return { pass: ok, detail: `carried ${payKg.toFixed(1)}kg — ${dist.toFixed(2)} m, stall ${(stallFrac * 100).toFixed(0)}%` }
        }
        const dz = s.z - m.z0
        const ok = dz >= 0.08 && stallFrac < 0.5
        return { pass: ok, detail: `carried ${payKg.toFixed(1)}kg — +${dz.toFixed(2)} m climb, stall ${(stallFrac * 100).toFixed(0)}%` }
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
  // LIFT legs: reach a carry point over each prop, heaviest first, then ask
  // the torque model whether the servos can actually hold that mass at that
  // pose — reaching is not lifting.
  for (const p of [...DESK_PROPS].sort((a, b) => b.massG - a.massG)) {
    const top = p.pos[2] + p.size[2] / 2
    legs.push({ kind: 'lift', prop: p, wp: [p.pos[0] - 40, p.pos[1], top + 90], pose: null, t: 0, err: null })
  }
  // LIMITS: the certification version of the manual SWEEP — every joint is
  // commanded to 85% of both extremes through the real servo sim, then scored
  // on where the joints actually got to, not where they were told to go.
  legs.push({ kind: 'limitsweep', wp: null, pose: null, t: 0, err: null, errMin: null, errMax: null })
  let li = 0

  const legLabel = (l) => (l.kind === 'home' ? 'HOME' : l.kind === 'lift' ? `LIFT ${l.prop.name}` : l.kind === 'limitsweep' ? 'LIMITS' : `REACH ${l.prop.name}`)

  function liftVerdict(leg) {
    const d = ik.design
    if (!d || !leg.pose || !ik.distalJoint) return { pass: false, detail: 'no design or pose to test' }
    const mat = MATERIALS[d.brief && d.brief.material] || null
    // payload hangs ~35mm below the tip — where a gripper would actually hold it
    const evalPose = (pose) => {
      const posed = { ...d, joints: d.joints.map((j, i) => ({ ...j, angle: pose[i] != null ? pose[i] : j.angle })) }
      const tip = typeof ik.tipPos === 'function' ? ik.tipPos(pose) : null
      const payPos = tip ? [tip[0], tip[1], tip[2] - 35] : [leg.prop.pos[0], leg.prop.pos[1], leg.prop.pos[2]]
      const tor = benchTorqueMargins(posed, mat, [{ joint: ik.distalJoint, pos: payPos, massG: leg.prop.massG }])
      return tor.reduce((w, t) => (t.margin < w.margin ? t : w), { margin: Infinity, label: '?' })
    }
    // certification asks "can it lift this at all" — so give the arm its best
    // honest shot: probe tucked carry poses and keep the most headroom found.
    // If even the probes can't get there, the honest answer is "unreachable".
    let reached = leg.err != null && leg.err <= 45
    let best = reached ? evalPose(leg.pose) : null
    for (const tuck of [20, 40, 60, 80, 100, 120]) {
      for (const dz of [50, 80]) {
        const wp = [leg.prop.pos[0] - tuck, leg.prop.pos[1], leg.prop.pos[2] + leg.prop.size[2] / 2 + dz]
        const pose = ik.seek(wp[0], wp[1], wp[2], (st.seedAngles || leg.pose || []).slice(), 30)
        if (ik.state.err > 45) continue
        reached = true
        const w = evalPose(pose)
        if (!best || w.margin > best.margin) best = w
      }
    }
    if (!reached) return { pass: false, detail: `no carry pose inside reach — closest err ${(leg.err == null ? 999 : leg.err).toFixed(0)}mm` }
    const pass = best.margin >= 1.0
    return { pass, detail: `best carry ${best.label} at ${best.margin === Infinity ? '∞' : best.margin.toFixed(2)}× stall holding ${leg.prop.massG}g` }
  }

  function scoreLeg() {
    const leg = legs[li]
    const err = leg.err == null ? 999 : leg.err
    if (leg.kind === 'home') pushResult(st, 'home', 'HOME', err <= 45, `returned, err ${err.toFixed(0)}mm`)
    else if (leg.kind === 'lift') {
      const v = liftVerdict(leg)
      pushResult(st, `lift-${leg.prop.id}`, `LIFT ${leg.prop.name.toUpperCase()}`, v.pass, v.detail)
    } else pushResult(st, `reach-${leg.prop.id}`, leg.prop.name.toUpperCase(), err <= 30, `err ${err.toFixed(0)}mm`)
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
      if (leg.kind === 'limitsweep') {
        const js = (ik.design && ik.design.joints) || []
        const PH = 1.2
        let pose
        if (leg.t < PH) pose = js.map((j) => j.min * 0.85)
        else if (leg.t < PH * 2) pose = js.map((j) => j.max * 0.85)
        else pose = js.map(() => 0)
        // snapshot shortfalls at each window's closing edge
        if (actual && actual.length) {
          if (leg.t >= PH && leg.t - dt < PH) leg.errMin = js.map((j, i) => Math.abs((actual[i] || 0) - j.min * 0.85))
          if (leg.t >= PH * 2 && leg.t - dt < PH * 2) leg.errMax = js.map((j, i) => Math.abs((actual[i] || 0) - j.max * 0.85))
        }
        if (leg.t > PH * 2 + 1.0) {
          let worst = null, worstRatio = 0
          js.forEach((j, i) => {
            const tol = Math.max(6, (j.max - j.min) * 0.15)
            const r = Math.max(leg.errMin ? leg.errMin[i] : 999, leg.errMax ? leg.errMax[i] : 999) / tol
            if (r > worstRatio) { worstRatio = r; worst = j.label || j.id }
          })
          const pass = worstRatio <= 1
          pushResult(st, 'limits', 'LIMITS', pass,
            pass ? `all ${js.length} joints reached both 85% extremes` : `${worst} fell ${(worstRatio * 100 - 100).toFixed(0)}% short of tolerance`)
          if (!advance()) return { x: 0, y: 0, z: 0, pose }
        }
        return { x: 0, y: 0, z: 0, pose }
      }
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

// ── gait locomotion: trot / sprint / climb / obstacle / stand ────────────────
// Same certification shape as the drive suite, scored on locomoteState — the
// legged machine's own chassis telemetry. OBSTACLE predicts from leg geometry
// (gait.maxStepM vs the 80mm porch riser) then checks the sim agreed: tall
// bots climb, small bots stall with bumps — nobody phases through a wall.

const GAIT_LOCO_PHASES = [
  { id: 'trot',     label: 'TROT',     dur: 4, x: 0.85 },
  { id: 'sprint',   label: 'SPRINT',   dur: 3, x: 1 },
  { id: 'climb',    label: 'CLIMB',    dur: 4, x: 1 },
  { id: 'obstacle', label: 'OBSTACLE', dur: 4, x: 1 },
  { id: 'load',     label: 'LOAD',     dur: 4, x: 1, payloadFrac: 0.3 },
  { id: 'stand',    label: 'STAND',    dur: 2, x: 0 },
]

function locoGaitAutotest(gait) {
  const st = { running: false, done: false, results: [], phase: null, stallEver: false }
  let idx = 0, t = 0, mark = null
  const loco = () => gait.locomoteState || {}

  function beginPhase(i) {
    const p = GAIT_LOCO_PHASES[i]
    const s = loco()
    mark = {
      x0: s.x || 0, y0: s.y || 0, z0: s.z || 0, bumps0: s.bumps || 0,
      strides0: gait.state.strides, maxV: 0, stallT: 0, gradeT: 0, stallSeen: false,
    }
    idx = i; t = 0
    begin(st, p.label, p.dur, GAIT_LOCO_PHASES.length)
  }

  function scorePhase(p, m) {
    const s = loco()
    const dist = Math.hypot((s.x || 0) - m.x0, (s.y || 0) - m.y0)
    const dz = (s.z || 0) - m.z0
    const stallFrac = m.stallT / p.dur
    const bumps = (s.bumps || 0) - m.bumps0
    const gained = gait.state.strides - m.strides0
    switch (p.id) {
      case 'trot':
        return { pass: gained >= 4, detail: `${gained.toFixed(1)} strides in ${p.dur}s` }
      case 'sprint':
        return { pass: dist >= 0.8 && stallFrac < 0.4,
          detail: `covered ${dist.toFixed(2)} m, top ${m.maxV.toFixed(2)} m/s, stall ${(stallFrac * 100).toFixed(0)}%` }
      case 'climb':
        if (m.gradeT / p.dur < 0.3) {
          return { pass: dist >= 0.6 && stallFrac < 0.4, detail: `flat bench — covered ${dist.toFixed(2)} m` }
        }
        return { pass: dz > 0.04, detail: `climbed ${dz.toFixed(2)} m over graded ground` }
      case 'obstacle': {
        const course = s.course || 'rack'
        const xGain = (s.x || 0) - m.x0
        if (course === 'stairs') {
          const reachMm = (gait.maxStepM || 0) * 1000
          if (reachMm > 75) {
            return { pass: xGain > 1.2, detail: `leg reach ${reachMm.toFixed(0)}mm predicts climb — covered ${xGain.toFixed(2)} m` }
          }
          // the block may have engaged in an earlier phase — count total
          // bumps and any stall seen this run, not just this window
          const blocked = (s.bumps || 0) > 0 && (m.stallSeen || stallFrac > 0.1 || st.stallEver)
          return { pass: blocked,
            detail: `leg reach ${reachMm.toFixed(0)}mm can't mount 80mm — ${blocked ? 'blocked honestly' : 'never engaged'}, ${s.bumps || 0} bumps total` }
        }
        if (course === 'room') {
          return { pass: (s.bumps || 0) >= 1 || dist > 2.5, detail: `${s.bumps || 0} prop hits over ${dist.toFixed(2)} m` }
        }
        return { pass: dist >= 0.6, detail: `covered ${dist.toFixed(2)} m` }
      }
      case 'load': {
        // 30% of body mass on the back — a real carry, not a token weight
        const payKg = (gait.bodyKg || 6) * (p.payloadFrac || 0.3)
        return { pass: dist >= 0.4 && stallFrac < 0.5,
          detail: `carried ${payKg.toFixed(1)}kg (${((payKg / (gait.bodyKg || 6)) * 100).toFixed(0)}% body) — covered ${dist.toFixed(2)} m, stall ${(stallFrac * 100).toFixed(0)}%` }
      }
      case 'stand': {
        const stopped = gait.state.speed < 0.03 && Math.abs(s.v || 0) < 0.03
        return { pass: stopped, detail: `settled at ${gait.state.speed.toFixed(2)} gait, ${Math.abs(s.v || 0).toFixed(2)} m/s` }
      }
    }
    return { pass: true, detail: '' }
  }

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      gait.reset()
      st.running = true; st.done = false; st.results = []
      beginPhase(0)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { x: 0, payloadKg: 0 }
      t += dt
      const p = GAIT_LOCO_PHASES[idx]
      const s = loco()
      mark.maxV = Math.max(mark.maxV, Math.abs(s.v || 0))
      if ((s.gradeDeg || 0) > 4) mark.gradeT += dt
      if (s.stall) { mark.stallT += dt; mark.stallSeen = true; st.stallEver = true }
      const payKg = p.payloadFrac ? (gait.bodyKg || 6) * p.payloadFrac : 0
      if (t >= p.dur) {
        const r = scorePhase(p, mark)
        pushResult(st, p.id, p.label, r.pass, r.detail)
        idx += 1
        if (idx >= GAIT_LOCO_PHASES.length) {
          st.running = false; st.done = true; st.phase = null
          return { x: 0, payloadKg: 0 }
        }
        beginPhase(idx)
        return { x: GAIT_LOCO_PHASES[idx].x, payloadKg: 0 }
      }
      st.phase.t = t
      return { x: p.x, payloadKg: payKg }
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
        // HOLD: the jaw must close on the bench's 1kg test mass — the rating
        // comes from real jaw force × pad friction ÷ pinion geometry
        const holdKg = grip.holdKg || 0
        const need = 1
        pushResult(st, 'hold', 'HOLD', holdKg >= need,
          holdKg >= need ? `holds ${need}kg test mass (rated ${holdKg.toFixed(2)}kg)` : `rated ${holdKg.toFixed(2)}kg < ${need}kg test mass — jaw slips`)
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
  if (teleop.kind === 'gait') return locoGaitAutotest(teleop)
  if (teleop.kind === 'grip') return gripAutotest(teleop)
  if (teleop.kind === 'sense') return senseAutotest(teleop)
  return null
}
