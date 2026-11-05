// ── bench core: pre-print test math ─────────────────────────────────────────
// The "field test before you print" layer. Everything here is rigid-body
// statics on the SAME FK the renderer and exporters use — no fake numbers:
//   · whole-body centre of mass, live under the current pose
//   · support polygon = convex hull of ground-contact nodes
//   · tip-over margin on flat ground AND on an inclined ramp
//   · per-joint gravity torque vs the stall torque the servo was picked for
//   · CCD IK so a target point can drive a joint chain (bench teleop later)
// All units mm / grams / N·m / radians internally consistent with the engine.

const BENCH_G = 9810 // mm/s²  (g in mm units — keeps torque in N·mm→N·m clean)

/** Mass of one node in grams: bought part → catalog mass; printed → volume×density. */
function benchNodeMassG(design, node, mat) {
  const p = node.part ? PARTS[node.part] : null
  if (p) return (p.mass || 0) * (node.qty || 1)
  const density = (mat && mat.density) || 1.24 // g/cm³
  return (nodeVolume(node) / 1000) * density
}

/** World position of a node centre under the current joint pose (mm). */
function benchNodeWorld(design, chains, node) {
  const j = node.joint ? design.joints.find((jj) => jj.id === node.joint) : null
  const chain = j ? chains.get(j.id) : null
  const p = applyChain(chain, node.pos || [0, 0, 0])
  const s = slideDisp(design, node)
  return [p[0] + s[0], p[1] + s[1], p[2] + s[2]]
}

/** Whole-body CoM under the current pose. Returns {com:[x,y,z] mm, massG}. */
function benchCoM(design, mat) {
  const chains = chainsFor(design)
  let mx = 0, my = 0, mz = 0, m = 0
  for (const n of design.nodes) {
    const w = benchNodeWorld(design, chains, n)
    const g = benchNodeMassG(design, n, mat)
    if (!isFinite(g) || g <= 0) continue
    mx += w[0] * g; my += w[1] * g; mz += w[2] * g; m += g
  }
  return m > 0 ? { com: [mx / m, my / m, mz / m], massG: m } : { com: [0, 0, 0], massG: 0 }
}

/** Rough "how far below centre is the bottom of this node" for contact tests. */
function benchNodeDrop(node) {
  if (node.kind === 'cyl' || node.kind === 'ring') {
    return node.axis === 'z' ? (node.height || node.outer || 0) / 2 : (node.radius || node.outer || 10)
  }
  if (node.kind === 'box' || node.kind === 'rbox' || node.kind === 'wedge') return (node.size?.[2] || 10) / 2
  if (node.kind === 'torus' || node.kind === 'bend') return (node.R || 20) - (node.r || 5)
  return Math.min(node.size?.[0] || node.radius || node.outer || 20, 30) / 2
}

/** Ground-contact points (x,y mm): nodes whose bottom sits at the design's floor.
 *  Plates contribute their footprint corners, not just the centre — otherwise a
 *  base plate hulls as a single point and every margin reads nonsense. */
function benchContacts(design, mat) {
  const chains = chainsFor(design)
  const items = design.nodes.map((n) => {
    const w = benchNodeWorld(design, chains, n)
    return { n, w, bottom: w[2] - benchNodeDrop(n) }
  })
  const floor = Math.min(...items.map((i) => i.bottom))
  const pts3 = []
  for (const { n, w } of items) {
    if (w[2] - benchNodeDrop(n) - floor >= 15) continue
    const z = w[2] - benchNodeDrop(n)
    const k = n.kind
    if ((k === 'box' || k === 'rbox' || k === 'wedge') && n.size) {
      const [sx, sy] = n.size
      pts3.push([w[0] - sx / 2, w[1] - sy / 2, z], [w[0] + sx / 2, w[1] - sy / 2, z],
                [w[0] + sx / 2, w[1] + sy / 2, z], [w[0] - sx / 2, w[1] + sy / 2, z])
    } else if (k === 'cyl' || k === 'ring') {
      const r = n.radius || n.outer || 10
      if (n.axis === 'z') {
        for (let a = 0; a < 8; a++) { const t = (a / 8) * Math.PI * 2; pts3.push([w[0] + Math.cos(t) * r, w[1] + Math.sin(t) * r, z]) }
      } else {
        // horizontal axle: contact patch is a line along the perpendicular
        pts3.push([w[0] - r, w[1], z], [w[0] + r, w[1], z], [w[0], w[1] - r, z], [w[0], w[1] + r, z])
      }
    } else {
      pts3.push([w[0], w[1], z])
    }
  }
  return pts3
}

/** 2D contact points for hull work. */
function benchContacts2D(design) {
  return benchContacts(design).map((p) => [p[0], p[1]])
}

/** Andrew's monotone chain — 2D convex hull, returns CCW vertices. */
function hull2D(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  const hi = []
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q) }
  lo.pop(); hi.pop()
  return lo.concat(hi)
}

/** Signed distance (mm) from pt to hull edge; positive = inside. */
function benchHullMargin(pt, hull) {
  if (hull.length < 3) return -999
  let min = Infinity
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    const ex = b[0] - a[0], ey = b[1] - a[1]
    const len = Math.hypot(ex, ey) || 1
    // CCW hull → inside is to the LEFT of each edge (positive 2D cross product)
    const d = ex * (pt[1] - a[1]) - ey * (pt[0] - a[0])
    min = Math.min(min, d / len)
  }
  return min
}

/**
 * Tip-over margin on a slope inclined `slopeDeg` about the X axis (rising +Y).
 * Transforms contacts + CoM into the slope frame, hulls the contacts there,
 * and measures how far the CoM's gravity projection sits inside the hull.
 */
function benchSlopeMargin(design, mat, slopeDeg) {
  const th = (slopeDeg * Math.PI) / 180
  const c = Math.cos(th), s = Math.sin(th)
  const chains = chainsFor(design)
  const com = benchCoM(design, mat).com
  // rotate about X: slope-frame coords (x, yAlong, zUp-from-slope)
  const tf = (p) => [p[0], p[1] * c + p[2] * s, -p[1] * s + p[2] * c]
  const contacts = benchContacts(design, mat).map(tf).map((p) => [p[0], p[1]])
  const cp = tf(com)
  return benchHullMargin([cp[0], cp[1]], hull2D(contacts))
}

/**
 * Per-joint gravity torque at the CURRENT pose vs the stall torque the
 * actuator was actually picked for. τ = Σ m·g·lever about each joint axis —
 * exact rigid-body statics; yaw axes read ~0 because gravity can't load them.
 */
function benchTorqueMargins(design, mat) {
  const chains = chainsFor(design)
  const acts = design.actuators || []
  const byId = new Map(design.joints.map((j) => [j.id, j]))
  const out = []
  // descendant joints of j (inclusive) via parent chain
  const subtree = (jid) => {
    const ids = new Set([jid])
    for (const j of design.joints) {
      let cur = j, guard = 0
      while (cur && guard < 24) { if (cur.id === jid) { ids.add(j.id); break } cur = cur.parent ? byId.get(cur.parent) : null; guard++ }
    }
    return ids
  }
  for (const j of design.joints) {
    if (j.slide || j.axis === 'z') continue
    const act = acts.find((a) => a.label === j.label)
    if (!act) continue
    const ids = subtree(j.id)
    // τ about the joint axis = Σ m·g·lever. In N·m with mm units:
    //   τ = (massG/1000 kg)·9.81·(lever_mm/1000 m) = massG·lever_mm·9.81e-6
    // For a vertical-axis (yaw) joint gravity produces ~0 — the cross product
    // handles that naturally, no special-casing needed.
    let tauNm = 0
    for (const n of design.nodes) {
      const nj = n.joint ? byId.get(n.joint) : null
      if (!nj || !ids.has(nj.id)) continue
      const w = benchNodeWorld(design, chains, n)
      const r = [w[0] - j.pivot[0], w[1] - j.pivot[1], w[2] - j.pivot[2]]
      const mg = benchNodeMassG(design, n, mat) * 9.81e-3 // N
      // F = (0,0,-mg); τ = r×F → only x,y components survive
      const tx = -r[1] * mg, ty = r[0] * mg, tz = 0
      const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[j.axis]
      const leverNmm = Math.abs(tx * ax[0] + ty * ax[1] + tz * ax[2]) // N·mm
      tauNm += leverNmm / 1000 // N·mm → N·m
    }
    const need = tauNm // N·m
    const stall = act.effective || 0
    out.push({ joint: j.id, label: j.label, needNm: need, stallNm: stall, margin: stall > 0 ? stall / Math.max(need, 1e-6) : 0 })
  }
  return out
}

/**
 * The pre-print verdict: one report a human can act on before spending money.
 * opts: { mat, slopeDeg, payloadG }
 */
function benchReport(design, analysis, opts = {}) {
  const mat = opts.mat || (analysis && analysis.material) || PARTS.pla && null
  const slopeDeg = opts.slopeDeg != null ? opts.slopeDeg : 15
  const { com, massG } = benchCoM(design, mat)
  const contacts = benchContacts2D(design)
  const hull = hull2D(contacts)
  const flatMm = benchHullMargin([com[0], com[1]], hull)
  const slopeMm = benchSlopeMargin(design, mat, slopeDeg)
  const torques = benchTorqueMargins(design, mat)
  const worst = torques.reduce((a, b) => (b.needNm / Math.max(b.stallNm, 1e-6)) > (a.needNm / Math.max(a.stallNm, 1e-6)) ? b : a, torques[0] || { needNm: 0, stallNm: 1, label: '—', joint: '—' })
  const verdicts = []
  const status = (ok, warn, label, detail) => verdicts.push({ label, status: ok ? 'pass' : warn ? 'warn' : 'fail', detail })
  status(flatMm > 15, flatMm > 0, 'Stability (flat)', `${Math.round(flatMm)}mm CoM margin inside the ${hull.length}-point support polygon · ${Math.round(massG)}g`)
  status(slopeMm > 0, slopeMm > -10, `Stability @ ${slopeDeg}° slope`, `${Math.round(slopeMm)}mm margin on the ramp plane`)
  const tj = torques.length ? torques.reduce((a, b) => (a.margin < b.margin ? a : b)) : null
  if (tj) status(tj.margin > 1.5, tj.margin > 1.0, 'Worst joint torque', `${tj.label}: needs ${tj.needNm.toFixed(2)} N·m, stall ${tj.stallNm.toFixed(2)} N·m → ${tj.margin.toFixed(1)}× margin`)
  else status(true, true, 'Actuators', 'no gravity-loaded revolute joints')
  return { com, massG, contacts: contacts.length, hull, flatMm, slopeMm, slopeDeg, torques, worst, verdicts }
}

// ── CCD IK: drive a joint chain so a tip node reaches a target point ────────
/**
 * Cyclic-coordinate-descent IK over a joint chain (root→tip order in `chain`).
 * `tipWorld(design)` returns the current world pos of the end-effector node.
 * Mutates joint.angle (clamped to [min,max]); returns final tip→target error mm.
 */
function solveChainIK(design, chain, target, tipWorld, iters = 6) {
  if (!chain || !chain.length) return { err: 1e9, iters: 0 }
  const byId = new Map(design.joints.map((j) => [j.id, j]))
  let err = 1e9
  for (let it = 0; it < iters; it++) {
    const tip = tipWorld(design)
    err = Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2])
    if (err < 0.5) break
    for (let k = chain.length - 1; k >= 0; k--) {
      const j = chain[k]
      if (j.slide || j.axis === 'z') continue
      const chains = chainsFor(design)
      const sub = chain.slice(0, k + 1)
      const pivot = j.pivot
      const tipP = tipWorld(design)
      const toTip = [tipP[0] - pivot[0], tipP[1] - pivot[1], tipP[2] - pivot[2]]
      const toTgt = [target[0] - pivot[0], target[1] - pivot[1], target[2] - pivot[2]]
      const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[j.axis]
      // project both vectors onto the plane ⊥ axis, angle between them
      const proj = (v) => {
        const d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]
        return [v[0] - d * ax[0], v[1] - d * ax[1], v[2] - d * ax[2]]
      }
      const a = proj(toTip), b = proj(toTgt)
      const ang = Math.atan2(
        a[0] * b[1] - a[1] * b[0] + a[1] * b[2] - a[2] * b[1] + a[2] * b[0] - a[0] * b[2],
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      )
      // yaw joints read positive CCW about +axis; pitch 'y' is inverted like applyChain
      const sign = j.axis === 'y' ? -1 : 1
      let next = j.angle + (sign * ang * 180) / Math.PI
      next = Math.min(j.max, Math.max(j.min, next))
      j.angle = next
    }
  }
  const tip = tipWorld(design)
  err = Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2])
  return { err, iters }
}

/**
 * GL overlay: support-polygon hull (dashed), CoM plumb line, CoM reticle.
 * Returns interleaved [x,y,z,r,g,b] vertices for GL_LINES, or null when the
 * machine has no ground contacts (shouldn't happen, but be honest).
 */
function benchOverlay(design, mat) {
  const { com } = benchCoM(design, mat)
  const c3 = benchContacts(design, mat)
  if (!c3.length) return null
  const floorZ = Math.min(...c3.map((p) => p[2]))
  const hull = hull2D(c3.map((p) => [p[0], p[1]]))
  const margin = benchHullMargin([com[0], com[1]], hull)
  const col = margin > 15 ? [0.30, 0.95, 0.55] : margin > 0 ? [1.0, 0.72, 0.18] : [1.0, 0.32, 0.28]
  const cyan = [0.25, 0.85, 1.0]
  const arr = []
  const seg = (a, b, c) => { arr.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], c[0], c[1], c[2]) }
  const Z = floorZ + 0.8
  if (hull.length >= 3) {
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const dash = 12, gap = 8, n = Math.max(1, Math.floor(len / (dash + gap)))
      for (let d = 0; d < n; d++) {
        const t0 = (d * (dash + gap)) / len, t1 = Math.min(1, (d * (dash + gap) + dash) / len)
        seg([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, Z],
            [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, Z], cyan)
      }
    }
  }
  seg(com, [com[0], com[1], Z], col)
  const s = 14
  seg([com[0] - s, com[1], com[2]], [com[0] + s, com[1], com[2]], col)
  seg([com[0], com[1] - s, com[2]], [com[0], com[1] + s, com[2]], col)
  seg([com[0], com[1], com[2] - s], [com[0], com[1], com[2] + s], col)
  seg([com[0] - 9, com[1], Z], [com[0] + 9, com[1], Z], col)
  seg([com[0], com[1] - 9, Z], [com[0], com[1] + 9, Z], col)
  return { data: new Float32Array(arr), verts: arr.length / 6 }
}
