// ── design scratchpad ───────────────────────────────────────────────────────
// Every archetype builds the same shape, so analysis, meshing, rendering and
// export never branch on archetype:
//
//   nodes[]  — geometry in mm, rest pose, tagged by joint. Node kinds:
//              box, rbox (chamfered), cyl (segs/radius2 → hex, cone, taper),
//              ring (hollow cyl), torus, wedge (triangular prism), sphere,
//              gear (module+teeth), rack (toothed bar), bend (tube elbow).
//              `rot:[rx,ry,rz]` orients any of them around their centre.
//   joints[] — revolute chain (axis + deg limits) OR linear slides (mm travel,
//              driven through node.slide) so mechanisms like grippers pose right
//   parts[]  — { key, qty, role } against PARTS
//   notes[]  — design decisions worth showing the user

function newDesign(archetype, brief) {
  return {
    archetype,
    brief,
    title: '',
    subtitle: '',
    nodes: [],
    joints: [],
    metrics: {},
    parts: [],
    notes: [],
    checks: [],
  }
}

function addPart(d, key, qty, role) {
  const found = d.parts.find((p) => p.key === key)
  if (found) {
    found.qty += qty
    // One line item, every job it does: "Wrist pitch · Wrist roll · Gripper".
    if (role && !found.roles.includes(role)) {
      found.roles.push(role)
      found.role = found.roles.join(' · ')
    }
    return
  }
  d.parts.push({ key, qty, role: role || '', roles: role ? [role] : [] })
}

/** Box node. `pos` is the CENTRE. `r` rounds it into a chamfered `rbox`. */
function box(d, id, size, pos, mat, extra) {
  d.nodes.push({ id, kind: 'box', size, pos, mat, ...extra })
}

/** Chamfered box — the machined/printed-edge look. `r` is the chamfer in mm. */
/**
 * Print-bed aware box: anything longer or wider than the bed becomes a grid of
 * pieces with seams and joiner plates. A design that cannot be printed is not a
 * design, so the geometry splits itself rather than leaving a 410mm part and a
 * warning the user cannot act on.
 */
/**
 * Payload has a physical envelope per archetype — a 400kg quadruped is not a
 * quadruped. Clamping is right; clamping *silently* is not, because the checks
 * then pass for a machine that cannot carry what was asked. Say it out loud.
 */
function clampPayload(d, requested, lo, hi) {
  const want = Number(requested)
  const safe = Number.isFinite(want) && want > 0 ? want : lo
  const got = Math.min(hi, Math.max(lo, safe))
  if (safe > hi) {
    d.checks.push({
      level: 'fail',
      msg: `Asked to carry ${safe}kg. A ${d.archetype === 'robot' ? 'mobile robot' : d.archetype} tops out around ${hi}kg — sizing below uses ${hi}kg, so this drawing will not carry ${safe}kg. Smaller payload, or a different machine class.`,
    })
  } else if (safe < lo) {
    d.checks.push({
      level: 'warn',
      msg: `${safe}kg is below what this class is sized for (${lo}kg) — the structure is fine, the resolution is not: a servo this small cannot hold position against a real load.`,
    })
  }
  return got
}

// ── pose presets: named joint configurations per archetype ─────────────────
// Angles in degrees, keyed by joint id; 'max'/'min' resolve against the
// joint's own limits so presets survive re-sizing. Values were verified
// against forward kinematics — the humanoid WAVE is the right arm because
// the left arm's workspace genuinely cannot reach overhead (IK err >90mm).
const POSE_PRESETS = {
  arm: [
    { name: 'EXTEND', pose: { yaw: 0, shoulder: 0, elbow: 0, 'wrist-pitch': 0, 'wrist-roll': 0 } },
    { name: 'STOW', pose: { yaw: 0, shoulder: 55, elbow: -125, 'wrist-pitch': -20, 'wrist-roll': 0 } },
    { name: 'UP', pose: { yaw: 0, shoulder: 0, elbow: 90, 'wrist-pitch': 0, 'wrist-roll': 0 } },
  ],
  robot: [
    { name: 'EXTEND', pose: { yaw: 0, shoulder: 0, elbow: 0, wrist: 0, roll: 0, 'head-pan': 0 } },
    { name: 'STOW', pose: { yaw: 0, shoulder: 50, elbow: -120, wrist: 0, roll: 0, 'head-pan': 0 } },
    { name: 'UP', pose: { yaw: 0, shoulder: 0, elbow: 90, wrist: 0, roll: 0, 'head-pan': 0 } },
  ],
  humanoid: [
    { name: 'WAVE', pose: { 'r-shoulder-roll': 55, 'r-shoulder-pitch': 13, 'r-elbow': -121, 'r-wrist': -80 } },
    { name: 'REACH', pose: { 'r-shoulder-pitch': -37, 'r-elbow': -13, 'r-wrist': 8, 'l-shoulder-pitch': 41, 'l-elbow': 4, 'l-wrist': -2 } },
    // stance presets name the foot tip joint + a world-mm delta from where
    // that foot actually is — IK replants it, so feet never float on a
    // differently-sized humanoid brief
    { name: 'WIDE', legs: { 'l-ankle-roll': [15, 0, 0], 'r-ankle-roll': [-15, 0, 0] } },
  ],
  quadruped: [
    // PROWL: front pair steps forward, rear pair back — a real weight shift
    // the gait engine can then walk out of
    { name: 'PROWL', legs: { 'tibia-fl': [20, 0, 0], 'tibia-fr': [20, 0, 0], 'tibia-rl': [-20, 0, 0], 'tibia-rr': [-20, 0, 0] } },
  ],
  gripper: [
    { name: 'OPEN', pose: { jaw: 'max' } },
    { name: 'CLOSE', pose: { jaw: 'min' } },
  ],
  rover: [
    { name: 'SCAN-L', pose: { 'head-pan': -60 } },
    { name: 'CENTER', pose: { 'head-pan': 0 } },
    { name: 'SCAN-R', pose: { 'head-pan': 60 } },
  ],
}

/** Resolve a named preset to a full angle array in design.joints order.
 *  Joints the preset doesn't mention return to rest (0). Unknown names
 *  and archetypes without presets return null — callers keep the pose.
 *  `legs` presets instead IK each named foot tip to a delta from its live
 *  position; `actualAngles` seeds that solve (live sim pose preferred). */
function applyPosePreset(design, name, actualAngles) {
  const preset = (POSE_PRESETS[design && design.archetype] || []).find((p) => p.name === name)
  const joints = (design && design.joints) || []
  if (!preset || !joints.length) return null
  const base = actualAngles && actualAngles.length === joints.length
    ? actualAngles.slice() : joints.map(() => 0)
  if (preset.legs) {
    const scratch = { ...design, joints: joints.map((j, i) => ({ ...j, angle: base[i] || 0 })) }
    const out = base.slice()
    const chains = chainsFor(scratch)
    for (const [tipId, delta] of Object.entries(preset.legs)) {
      const chain = (chains.get(tipId) || [])
        .map((j) => scratch.joints.find((s) => s.id === j.id)).filter((j) => j && !j.slide)
      if (chain.length < 3) continue
      const cands = (scratch.nodes || []).filter((n) => n.joint === tipId && n.pos)
      const foot = cands.find((n) => n.id.includes('sole'))
        || cands.find((n) => /foot/.test(n.id))
        || cands.slice().sort((a, b) => a.pos[2] - b.pos[2])[0]
      if (!foot) continue
      const tipW = (d) => benchNodeWorld(d, chainsFor(d), foot)
      const cur = tipW(scratch)
      const tgt = [cur[0] + delta[0], cur[1] + delta[1], Math.max(2, cur[2] + (delta[2] || 0))]
      const r = solveChainIK(scratch, chain, tgt, tipW, 60)
      if (r.err > 20) continue // unreachable delta — keep this leg's pose rather than float the foot
      chain.forEach((j) => { out[joints.findIndex((x) => x.id === j.id)] = j.angle })
    }
    return out
  }
  return joints.map((j) => {
    const spec = preset.pose[j.id]
    if (spec == null) return 0
    const v = spec === 'max' ? j.max : spec === 'min' ? j.min : Number(spec)
    return Number.isFinite(v) ? clamp(v, j.min, j.max) : 0
  })
}

function splitBox(d, base, size, pos, fillet, mat, bed, extra = {}) {
  const usable = Math.max(60, (bed || 256) - 16)
  const gap = 2
  const nA = Math.max(1, Math.ceil(size[0] / usable))
  const nB = Math.max(1, Math.ceil(size[1] / usable))
  if (nA === 1 && nB === 1) {
    rbox(d, base, size, pos, fillet, mat, extra)
    return 1
  }
  const segX = (size[0] - gap * (nA - 1)) / nA
  const segY = (size[1] - gap * (nB - 1)) / nB
  let count = 0
  for (let i = 0; i < nA; i += 1) {
    for (let j = 0; j < nB; j += 1) {
      count += 1
      const ps = [
        pos[0] - size[0] / 2 + segX / 2 + i * (segX + gap),
        pos[1] - size[1] / 2 + segY / 2 + j * (segY + gap),
        pos[2],
      ]
      rbox(d, `${base}-${i + 1}x${j + 1}of${nA}x${nB}`, [segX, segY, size[2]], ps, fillet, mat, extra)
    }
  }
  // joiner bars across every seam, on the underside
  for (let i = 1; i < nA; i += 1) {
    rbox(d, `${base}-joinX-${i}`, [26, Math.min(size[1] * 0.7, 60), 2.6], [
      pos[0] - size[0] / 2 + i * segX + (i - 0.5) * gap,
      pos[1], pos[2] - size[2] / 2 - 1.4,
    ], 0.8, mat, { print: true })
  }
  for (let j = 1; j < nB; j += 1) {
    rbox(d, `${base}-joinY-${j}`, [Math.min(size[0] * 0.7, 60), 26, 2.6], [
      pos[0], pos[1] - size[1] / 2 + j * segY + (j - 0.5) * gap,
      pos[2] - size[2] / 2 - 1.4,
    ], 0.8, mat, { print: true })
  }
  if (d.notes) {
    d.notes.push(`${base} prints in ${count} pieces (${Math.round(segX)}×${Math.round(segY)}mm) with joiner plates — glue or bolt the seams.`)
  }
  return count
}

/** A vendored CAD mesh: `part` names an entry in globalThis.__RF_PARTS. */
function mesh(d, id, part, size, pos, mat, extra) {
  d.nodes.push({ id, kind: 'mesh', part, size, pos, mat, rot: [0, 0, 0], ...(extra || {}) })
}

function rbox(d, id, size, pos, r, mat, extra) {
  d.nodes.push({ id, kind: 'rbox', size, pos, r: r || 1.5, mat, ...extra })
}

/** Cylinder node. axis 'x'|'y'|'z', `pos` is the CENTRE.
 *  extra.segs (default 18 → 6 = hex bolt/nut), extra.radius2 (≠radius → cone/taper). */
function cyl(d, id, radius, height, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'cyl', radius, height, pos, axis, mat, ...extra })
}

/** Hollow cylinder — bearing races, washers, tubes. */
function ring(d, id, outer, inner, height, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'ring', outer, inner, height, pos, axis, mat, ...extra })
}

/** Torus — tyre profiles, O-rings, rounded rims. `R` major, `r` minor. */
function torus(d, id, R, r, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'torus', R, r, pos, axis, mat, ...extra })
}

/** Triangular prism (gusset, ramp, jaw chamfer). dir: px|nx|py|ny — the slope
 *  rises toward that side; cross-section in the x/z or y/z plane, extruded the
 *  remaining axis. size is the full bounding box. */
function wedge(d, id, size, pos, dir, mat, extra) {
  d.nodes.push({ id, kind: 'wedge', size, pos, dir: dir || 'px', mat, ...extra })
}

/** UV sphere — ball joints, domed caps, rounded feet. */
function ball(d, id, radius, pos, mat, extra) {
  d.nodes.push({ id, kind: 'sphere', radius, pos, mat, ...extra })
}

/** Spur gear: real tooth count, pitch radius r = m·z/2. */
function gear(d, id, m, teeth, width, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'gear', module: m, teeth, width, pos, axis, mat, ...extra })
}

/** Toothed rack bar of `size`, `teeth` boxes on the +z face. */
function rack(d, id, size, teeth, pos, mat, extra) {
  d.nodes.push({ id, kind: 'rack', size, teeth, pos, mat, ...extra })
}

/** Bent tube, a `deg`-arc elbow of tube radius r at bend radius R. `rot` aims it. */
function bend(d, id, R, r, deg, pos, rot, mat, extra) {
  d.nodes.push({ id, kind: 'bend', R, r, arc: deg, pos, rot, mat, ...extra })
}

/**
 * A revolute joint. `parent` defaults to the previously declared joint (a
 * serial chain); a branching machine passes it explicitly.
 */
function joint(d, id, label, axis, pivot, min, max, parent) {
  const fallback = d.joints.length ? d.joints[d.joints.length - 1].id : null
  d.joints.push({ id, label, axis, pivot, angle: 0, min, max, parent: parent === undefined ? fallback : parent })
}

/**
 * A linear slide, in mm. Nodes ride it via slide:{joint, sign} — a gripper puts
 * jaw A on sign -1 and jaw B on sign +1 so one slider opens and closes the pair.
 */
function slideJoint(d, id, label, axis, travelMm) {
  d.joints.push({ id, label, axis, slide: true, pivot: [0, 0, 0], angle: 0, min: 0, max: travelMm, parent: null })
}

/** mm³ of a node, for mass + print estimates. */
function nodeVolume(node) {
  const s = node.size
  switch (node.kind) {
    case 'box': case 'rbox': return s[0] * s[1] * s[2] * (node.kind === 'rbox' ? 0.93 : 1)
    case 'wedge': return s[0] * s[1] * s[2] * 0.5
    case 'rack': return s[0] * s[1] * s[2] * 1.12
    case 'cyl': {
      const r2 = node.radius2 != null ? node.radius2 : node.radius
      return (Math.PI * node.height / 3) * (node.radius ** 2 + node.radius * r2 + r2 ** 2)
    }
    case 'ring': return Math.PI * (node.outer ** 2 - node.inner ** 2) * node.height
    case 'torus': return 2 * Math.PI * Math.PI * node.R * node.r ** 2
    case 'sphere': return (4 / 3) * Math.PI * node.radius ** 3
    case 'gear': {
      const root = (node.module * node.teeth) / 2 - 1.25 * node.module
      const tip = (node.module * node.teeth) / 2 + node.module
      return Math.PI * (root ** 2 + (tip ** 2 - root ** 2) * 0.45) * node.width
    }
    case 'bend': return (node.arc / 360) * 2 * Math.PI * Math.PI * node.R * node.r ** 2
    default: return 0
  }
}

/**
 * Volume of PRINTED material, modelled the way a slicer sees it: a box is a
 * WALL SHELL (2.4mm) with infill, not a solid block. Treating these as solid
 * is how a 400mm rover ends up "weighing" 2.3kg on paper.
 */
const WALL = 2.4

// Lightening holes, cable routes and motor pockets remove roughly a quarter of
// every large plate — modelled as a cap rather than as cutout geometry.
const LIGHTENING = 0.72

function shellVolume(n) {
  // Rings are already the shell — wall thickness IS the part.
  if (n.kind === 'ring' || n.kind === 'bend' || n.kind === 'torus') return nodeVolume(n)
  const solid = nodeVolume(n)
  if (n.kind === 'cyl' || n.kind === 'sphere' || n.kind === 'gear') {
    const r = n.radius || n.outer || ((n.module * n.teeth) / 4)
    if (r <= WALL * 1.6) return solid
    const h = n.height || n.width || r * 2
    const tube = Math.PI * (r * r - (r - WALL) * (r - WALL)) * h
    const caps = 2 * Math.PI * r * r * WALL * LIGHTENING
    return Math.min(solid * LIGHTENING, tube + caps)
  }
  // box, rbox, wedge, rack — shell of the bounding shape
  const [x, y, z] = n.size
  if (Math.min(x, y, z) <= WALL * 2.2) return solid * LIGHTENING
  const surface = 2 * (x * y + y * z + x * z)
  return Math.min(solid * LIGHTENING, surface * WALL)
}

function printedVolume(nodes) {
  let v = 0
  for (const n of nodes) if (n.print) v += shellVolume(n)
  return v
}

// ── composite part builders ─────────────────────────────────────────────────
// Real assemblies are made of these, not of naked boxes. Each emits the nodes
// a renderer can shade AND the parts a BOM can count.

/**
 * M3 bolt: shank + hex head + washer. `pos` is the surface the head sits on;
 * the shank runs along -axis into the part (flip → +axis). `len` = shank.
 */
function bolt(d, id, pos, axis, len, extra) {
  const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis || 'z']
  const f = extra && extra.flip ? 1 : -1
  const at = (dist) => [pos[0] + dir[0] * f * dist, pos[1] + dir[1] * f * dist, pos[2] + dir[2] * f * dist]
  cyl(d, `${id}-hd`, 2.85, 3, at(-2.1), axis, 'steel', { segs: 6, ...extra })
  ring(d, `${id}-wa`, 3.4, 1.7, 0.8, at(-0.4), axis, 'steel', extra)
  cyl(d, `${id}-sh`, 1.5, len, at(len / 2), axis, 'steel', extra)
}

/** M3 hex nut. */
function nut(d, id, pos, axis, extra) {
  cyl(d, id, 3.0, 2.4, pos, axis, 'steel', { segs: 6, ...extra })
}

/** A press-fit bearing drawn honestly: outer race, inner race, gap between. */
function bearing(d, id, pos, axis, od, bore, w, extra) {
  ring(d, `${id}-o`, od / 2, od / 2 - 1.4, w, pos, axis, 'steel', extra)
  ring(d, `${id}-i`, bore / 2 + 1.4, bore / 2, w + 0.3, pos, axis, 'steel', extra)
  cyl(d, `${id}-b`, (od / 2 + bore / 2) / 2 - 0.6, w - 1.2, pos, axis, 'metal', { segs: 10, ...extra })
}

/**
 * A servo drawn as a servo: case with chamfered sides, mounting ears, output
 * spline and horn disc. `pos` is where the shaft FACE sits; the case hangs
 * behind it along -axis (or +axis with opts.flip).
 * `joint` carries the case (the side it bolts to); `hornJoint` carries the
 * spline+horn — the side it DRIVES. Pass the same joint when both rotate.
 */
function servoBody(d, prefix, pos, axis, partKey, joint, hornJoint, opts) {
  const p = PARTS[partKey]
  const [L, W, H] = (p && p.dims) || [40, 20, 40]
  const caseH = H * 0.62
  const o = { joint, ...(opts || {}) }
  const ho = { ...(opts || {}), joint: hornJoint === undefined ? joint : hornJoint }
  const a = axis || 'z'
  const f = o.flip ? -1 : 1
  const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[a]
  const at = (dist) => [pos[0] + dir[0] * f * dist, pos[1] + dir[1] * f * dist, pos[2] + dir[2] * f * dist]
  const sizeFor = (along) => (a === 'z' ? [along, W, caseH] : a === 'y' ? [along, caseH, W] : [caseH, along, W])
  const earSize = a === 'z' ? [L + 8, W, 2.6] : a === 'y' ? [L + 8, 2.6, W] : [2.6, L + 8, W]

  rbox(d, `${prefix}-case`, sizeFor(L), at(-(caseH / 2 + 4)), 2.2, 'servo', o)
  box(d, `${prefix}-ear-a`, earSize, at(-3), 'servo', o)
  box(d, `${prefix}-ear-b`, earSize, at(-(caseH + 5)), 'servo', o)
  cyl(d, `${prefix}-spline`, 3, 4, at(1), a, 'steel', ho)
  cyl(d, `${prefix}-horn`, 11, 2.5, at(4), a, 'accent', ho)
}

/** Wheel drawn as a wheel: torus tyre + rim ring + hub boss. */
function wheelAssy(d, id, pos, axis, dia, width, joint, side) {
  const o = { joint }
  const out = side || 1 // which face carries the lug heads (outboard)
  const R = dia / 2 - width * 0.30
  torus(d, `${id}-tire`, R, width * 0.30, pos, axis, 'rubber', o)
  ring(d, `${id}-rim`, R, R * 0.32, width * 0.42, pos, axis, 'accent', { print: true, joint })
  cyl(d, `${id}-hub`, R * 0.3, width * 0.55, pos, axis, 'accent', { print: true, joint })
  // lug bolts, because detail lives in the fastener heads
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2
    const rr = R * 0.62
    const bp = axis === 'y'
      ? [pos[0] + Math.cos(a) * rr, pos[1] + out * width * 0.22, pos[2] + Math.sin(a) * rr]
      : [pos[0] + Math.cos(a) * rr, pos[1] + Math.sin(a) * rr, pos[2] + out * width * 0.22]
    cyl(d, `${id}-lug${i}`, 1.6, 2.5, bp, axis, 'steel', { segs: 6, joint })
  }
}

/** U-bracket: base + two cheeks, sized for a servo case width `gap`. */
function bracketU(d, id, pos, size, t, mat, joint) {
  const [w, h, len] = size
  const o = { print: true, joint }
  box(d, `${id}-base`, [len, w, t], [pos[0], pos[1], pos[2] - h / 2 + t / 2], mat || 'shell', o)
  box(d, `${id}-chk-l`, [len, t, h], [pos[0], pos[1] - w / 2 + t / 2, pos[2]], mat || 'shell', o)
  box(d, `${id}-chk-r`, [len, t, h], [pos[0], pos[1] + w / 2 - t / 2, pos[2]], mat || 'shell', o)
}

/** Corner gusset pair (thin wedges) between two faces meeting at `pos`. */
function gusset(d, id, pos, size, dir, mat, joint) {
  wedge(d, id, size, pos, dir, mat || 'shell', { print: true, joint })
}

/** Stiffening rib row on a plate: n thin vertical fins. */
function ribs(d, id, n, size, gap, pos, mat, joint) {
  for (let i = 0; i < n; i += 1) {
    box(d, `${id}-${i}`, size, [pos[0] + (i - (n - 1) / 2) * gap, pos[1], pos[2]], mat || 'accent', { print: true, joint })
  }
}

/** Heatsink/fin block. */
function fins(d, id, n, size, gap, pos, mat, extra) {
  for (let i = 0; i < n; i += 1) {
    box(d, `${id}-${i}`, size, [pos[0] + (i - (n - 1) / 2) * gap, pos[1], pos[2]], mat || 'metal', extra)
  }
}
