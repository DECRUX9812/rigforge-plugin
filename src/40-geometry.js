// ── geometry: nodes → world triangles ───────────────────────────────────────
// A forward-kinematics pass over the joint tree plus a slide pass for linear
// axes. The renderer and the STL exporter read the SAME triangle list, so what
// you orbit is what you print.
//
// Node local verts are generated centred at origin, oriented by `axis` and
// optionally `rot` (Euler, radians), translated to `pos`, slid by any linear
// joint, then rotated through the revolute chain.

const MAT_RGB = {
  shell: [198, 206, 214],
  accent: [255, 107, 26],
  metal: [140, 150, 162],
  steel: [96, 108, 122],
  brass: [188, 152, 74],
  pcb: [32, 96, 70],
  rubber: [38, 42, 48],
  glass: [112, 214, 232],
  servo: [30, 34, 42],
  belt: [34, 36, 40],
}

function rotAxis(p, pivot, axis, angle) {
  if (!angle) return p
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const x = p[0] - pivot[0]
  const y = p[1] - pivot[1]
  const z = p[2] - pivot[2]
  if (axis === 'z') return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, p[2]]
  if (axis === 'y') return [pivot[0] + x * c + z * s, p[1], pivot[2] - x * s + z * c]
  return [p[0], pivot[1] + y * c - z * s, pivot[2] + y * s + z * c]
}

/** Euler XYZ about the node's own centre — how wedges, bends and gears aim. */
function rotEuler(p, rot) {
  if (!rot || (!rot[0] && !rot[1] && !rot[2])) return p
  let [x, y, z] = p
  const [rx, ry, rz] = rot
  if (rx) { const c = Math.cos(rx), s = Math.sin(rx); const y2 = y * c - z * s, z2 = y * s + z * c; y = y2; z = z2 }
  if (ry) { const c = Math.cos(ry), s = Math.sin(ry); const x2 = x * c + z * s, z2 = -x * s + z * c; x = x2; z = z2 }
  if (rz) { const c = Math.cos(rz), s = Math.sin(rz); const x2 = x * c - y * s, y2 = x * s + y * c; x = x2; y = y2 }
  return [x, y, z]
}

/** Every joint's ancestor list, root first. One pass per mesh build. */
function chainsFor(design) {
  const byId = new Map(design.joints.map((j) => [j.id, j]))
  const chains = new Map()
  for (const j of design.joints) {
    const chain = []
    let cur = j
    let guard = 0
    while (cur && guard < 24) {
      chain.unshift(cur)
      cur = cur.parent ? byId.get(cur.parent) : null
      guard += 1
    }
    chains.set(j.id, chain)
  }
  return chains
}

/**
 * The end-effector chain of an arm-like machine: the joint with the deepest
 * revolute ancestry plus the node rigidly attached to it, farthest from its
 * pivot. Ambiguous machines (humanoid legs, quadruped) have several equal
 * chains — picking one silently would be a lie, so they get null.
 * Shared by IK teleop, the reach overlay and the spec's reach bound.
 */
function armTipChain(design) {
  const joints = design.joints || []
  if (!joints.length || joints.length > 8) return null
  const chains = chainsFor(design)
  let tipJoint = null, tipChain = null, tie = false
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
  const attached = (design.nodes || []).filter((n) => n.joint === tipJoint.id && n.pos)
  if (!attached.length) return null
  let tipNode = attached[0], bestD = -1
  for (const n of attached) {
    const d = Math.hypot(n.pos[0] - tipJoint.pivot[0], n.pos[1] - tipJoint.pivot[1], n.pos[2] - tipJoint.pivot[2])
    if (d > bestD) { bestD = d; tipNode = n }
  }
  return { tipJoint, tipChain, tipNode }
}

/** End-effector chain for one named limb side ('l'/'r'): the chain ending at
 *  that side's wrist/tool joint. armTipChain refuses ambiguous or >8-joint
 *  designs (the humanoid: two arms plus legs); this picks ONE arm honestly —
 *  the right one by convention — so a biped can still IK a single arm. */
function armChainFor(design, side) {
  const pre = `${side}-`
  const chains = chainsFor(design)
  let tipJoint = null, tipChain = null
  for (const j of design.joints || []) {
    // 'ee' must be a delimited token — bare /ee/ matches 'knee', which made
    // the humanoid's "arm" IK chain its leg (r-knee ahead of r-wrist in order)
    if (j.slide || !j.id.startsWith(pre) || !/wrist|tool|gripper|hand|(?:^|[-_])ee(?:[-_]|$)/.test(j.id)) continue
    const ch = (chains.get(j.id) || []).filter((x) => !x.slide)
    if (ch.length >= 3 && (!tipChain || ch.length > tipChain.length)) { tipChain = ch; tipJoint = j }
  }
  if (!tipChain || !tipJoint) return null
  const attached = (design.nodes || []).filter((n) => n.joint === tipJoint.id && n.pos)
  if (!attached.length) return null
  let tipNode = attached[0], bestD = -1
  for (const n of attached) {
    const d = Math.hypot(n.pos[0] - tipJoint.pivot[0], n.pos[1] - tipJoint.pivot[1], n.pos[2] - tipJoint.pivot[2])
    if (d > bestD) { bestD = d; tipNode = n }
  }
  return { tipJoint, tipChain, tipNode }
}

/** The arm a machine would IK: unambiguous whole-design scan first, then the
 *  right-arm (or requested side) fallback for multi-limb machines. */
function primaryArmTip(design, side) {
  return (side ? null : armTipChain(design)) || armChainFor(design, side || 'r')
}

/** Workspace outer bound: link lengths along the chain + tool offset — the
 *  triangle-inequality bound; every reachable tip point sits inside. */
function armReachBound(tip) {
  if (!tip) return null
  const { tipChain, tipNode } = tip
  const last = tipChain[tipChain.length - 1].pivot
  let r = Math.hypot(tipNode.pos[0] - last[0], tipNode.pos[1] - last[1], tipNode.pos[2] - last[2])
  for (let i = 0; i < tipChain.length - 1; i++) {
    const a = tipChain[i].pivot, b = tipChain[i + 1].pivot
    r += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  const c = tipChain[0].pivot
  return { c: [c[0], c[1], c[2]], r: Math.round(r) }
}

/** Joint axis as a unit vector — 'x'/'y'/'z' or an explicit [x,y,z]. */
function axisVec3(axis) {
  if (Array.isArray(axis)) {
    const l = Math.hypot(axis[0], axis[1], axis[2]) || 1
    return [axis[0] / l, axis[1] / l, axis[2] / l]
  }
  return axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1]
}

/** Rodrigues rotation about a unit axis, row-major 3×3. */
function rotMatAxis(axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), C = 1 - c
  const [x, y, z] = axis
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ]
}

function mulMM(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ]
}

/**
 * Forward kinematics for one chain (root→leaf). Joint pivots and axes are
 * stored in MODEL coordinates at the rest pose, so a descendant's pivot and
 * axis must be carried through every ancestor's rotation — rotating about the
 * stale rest pivot is what let a posed arm's forearm hinge drift ~100 mm off
 * its upper arm. child→parent for joint i is  p_parent = A_i·p_child + d_i
 * with d_i = pivot_i − pivot_parent; composing root→leaf gives each link's
 * world rotation R and origin t, and t IS the world position of pivot_i.
 * Slide joints stay transparent here — they displace through slideDisp.
 */
function chainFrames(chain) {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  let Rp = I, tp = [0, 0, 0], prevPivot = [0, 0, 0]
  const out = []
  for (const j of chain) {
    if (j.slide || !j.pivot) continue
    const d = [j.pivot[0] - prevPivot[0], j.pivot[1] - prevPivot[1], j.pivot[2] - prevPivot[2]]
    const a = axisVec3(j.axis)
    // Pitch joints read positive = UP (same sign convention applyChain had).
    // axis0 preserves the model letter when a scene yaw turned axis into a
    // vector — the pitch check must still recognise it.
    const sign = (j.axis0 || j.axis) === 'y' ? -1 : 1
    const A = rotMatAxis(a, (sign * (j.angle || 0) * Math.PI) / 180)
    const pivotW = [
      Rp[0] * d[0] + Rp[1] * d[1] + Rp[2] * d[2] + tp[0],
      Rp[3] * d[0] + Rp[4] * d[1] + Rp[5] * d[2] + tp[1],
      Rp[6] * d[0] + Rp[7] * d[1] + Rp[8] * d[2] + tp[2],
    ]
    const axisW = [Rp[0] * a[0] + Rp[1] * a[1] + Rp[2] * a[2], Rp[3] * a[0] + Rp[4] * a[1] + Rp[5] * a[2], Rp[6] * a[0] + Rp[7] * a[1] + Rp[8] * a[2]]
    const R = mulMM(Rp, A)
    out.push({ joint: j, pivotW, axisW, R, t: pivotW })
    Rp = R
    tp = pivotW
    prevPivot = j.pivot
  }
  return out
}

/** World pivot + axis of one joint under the current pose, or null. */
function jointFrameWorld(chains, jid) {
  const ch = chains.get(jid)
  if (!ch) return null
  const frames = chainFrames(ch)
  return frames.length ? frames[frames.length - 1] : null
}

/** Apply a joint chain's rotations (root → leaf) to a rest-pose point. */
function applyChain(chain, point) {
  if (!chain || !chain.length) return point
  const frames = chainFrames(chain)
  const f = frames[frames.length - 1]
  if (!f) return point
  // `point` is model-frame coords rigid in the deepest link: link coords are
  // model coords minus that link's pivot, then W_last carries it to the world.
  const P = f.joint.pivot
  const q = [point[0] - P[0], point[1] - P[1], point[2] - P[2]]
  const R = f.R, t = f.t
  return [
    R[0] * q[0] + R[1] * q[1] + R[2] * q[2] + t[0],
    R[3] * q[0] + R[4] * q[1] + R[5] * q[2] + t[1],
    R[6] * q[0] + R[7] * q[1] + R[8] * q[2] + t[2],
  ]
}

/** Linear-joint displacement for a node that rides a slide. Slide joints
 *  chain like revolute ones: a node tagged on a child slide inherits every
 *  slide ancestor's displacement (gantry quill = Z drop + saddle Y + portal
 *  X). Each joint contributes dir·angle·(j.sign||1); the node's own sign
 *  flips only the joint it is tagged on. */
function slideDisp(design, node) {
  if (!node.slide) return [0, 0, 0]
  const j0 = design.joints.find((jj) => jj.id === node.slide.joint)
  if (!j0 || !j0.slide) return [0, 0, 0]
  const out = [0, 0, 0]
  const seen = new Set()
  let j = j0, own = true
  while (j && j.slide && !seen.has(j.id)) {
    seen.add(j.id)
    const dir = axisVec3(j.axis)
    const t = j.angle * (j.sign || 1) * (own ? node.slide.sign || 1 : 1)
    out[0] += dir[0] * t; out[1] += dir[1] * t; out[2] += dir[2] * t
    own = false
    j = j.parent ? design.joints.find((jj) => jj.id === j.parent) : null
  }
  return out
}

// ── local vertex generators (centred at origin) ─────────────────────────────

/** Axis-aligned box corners → 12 tris. */
function boxTris(sx, sy, sz) {
  const corner = (i) => [(i & 1 ? sx : -sx), (i & 2 ? sy : -sy), (i & 4 ? sz : -sz)]
  // every face declares the way it faces, and the winding is checked against it:
  // a cube with half its faces wound inward exports an STL that slicers have to
  // repair, and "repair the mesh" is not something a buyer should have to do.
  const faces = [
    { idx: [0, 1, 3, 2], n: [0, 0, -1] },
    { idx: [4, 6, 7, 5], n: [0, 0, 1] },
    { idx: [0, 4, 5, 1], n: [0, -1, 0] },
    { idx: [2, 3, 7, 6], n: [0, 1, 0] },
    { idx: [0, 2, 6, 4], n: [-1, 0, 0] },
    { idx: [1, 5, 7, 3], n: [1, 0, 0] },
  ]
  const faceNormal = (a, b, c) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  }
  const tris = []
  for (const f of faces) {
    const v = f.idx.map(corner)
    const quad = [[v[0], v[1], v[2]], [v[0], v[2], v[3]]]
    for (const t of quad) {
      const n = faceNormal(t[0], t[1], t[2])
      const dot = n[0] * f.n[0] + n[1] * f.n[1] + n[2] * f.n[2]
      tris.push(dot < 0 ? [t[0], t[2], t[1]] : t)
    }
  }
  return tris
}

/**
 * Chamfered box: each corner cut at distance r along its three edges.
 * 6 octagonal faces + 12 edge chamfers + 8 corner triangles — the machined look.
 */
// Convex shapes: a face's outward normal always has positive dot with the
// vector from an interior point to the face — flip stragglers so winding is
// uniform. Generators can't be trusted per-axis (cyl caps wind inward
// off-axis, and the wedge's ramp plane threads the origin itself).
function orientTrisOutward(tris) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  // Reference point must be strictly inside the solid. Bbox centre fails
  // for the wedge: its bbox is origin-centred AND the ramp plane threads
  // that centre, leaving n·(g−c)≈0 — a floating-point coin toss that shipped
  // mixed winding (BRepCheck-invalid solids). The vertex average is a
  // convex combination of solid points, so it is always interior.
  const c = [0, 0, 0]; let nv = 0
  for (const t of tris) for (const p of t) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; nv += 1 }
  c[0] /= nv; c[1] /= nv; c[2] /= nv
  for (const t of tris) {
    const n = cr(sub(t[1], t[0]), sub(t[2], t[0]))
    const g = [(t[0][0] + t[1][0] + t[2][0]) / 3 - c[0], (t[0][1] + t[1][1] + t[2][1]) / 3 - c[1], (t[0][2] + t[1][2] + t[2][2]) / 3 - c[2]]
    if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] < 0) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp }
  }
  return tris
}

function rboxTris(sx, sy, sz, r) {
  const rr = Math.min(r, Math.min(sx, sy, sz) * 0.45)
  const ix = sx - rr, iy = sy - rr, iz = sz - rr
  const tris = []
  const quad = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]) }
  // Chamfered box = 6 face plates + 12 chamfer quads + 8 corner triangles.
  // Face plates are squares inset rr on both in-plane axes; chamfers span
  // only the inner ix/iy/iz extents so they meet the corner triangles
  // exactly — no overlapping fins (the previous construction self-
  // intersected: quads ran the full edge length and skewered the corners).
  quad([-ix, -iy, sz], [ix, -iy, sz], [ix, iy, sz], [-ix, iy, sz])
  quad([-ix, -iy, -sz], [-ix, iy, -sz], [ix, iy, -sz], [ix, -iy, -sz])
  quad([-ix, -sy, -iz], [ix, -sy, -iz], [ix, -sy, iz], [-ix, -sy, iz])
  quad([-ix, sy, -iz], [-ix, sy, iz], [ix, sy, iz], [ix, sy, -iz])
  quad([-sx, -iy, -iz], [-sx, -iy, iz], [-sx, iy, iz], [-sx, iy, -iz])
  quad([sx, -iy, -iz], [sx, iy, -iz], [sx, iy, iz], [sx, -iy, iz])
  for (const syn of [-1, 1]) for (const szn of [-1, 1])
    quad([-ix, syn * iy, szn * sz], [ix, syn * iy, szn * sz], [ix, syn * sy, szn * iz], [-ix, syn * sy, szn * iz])
  for (const sxn of [-1, 1]) for (const szn of [-1, 1])
    quad([sxn * ix, -iy, szn * sz], [sxn * ix, iy, szn * sz], [sxn * sx, iy, szn * iz], [sxn * sx, -iy, szn * iz])
  for (const sxn of [-1, 1]) for (const syn of [-1, 1])
    quad([sxn * sx, syn * iy, -iz], [sxn * sx, syn * iy, iz], [sxn * ix, syn * sy, iz], [sxn * ix, syn * sy, -iz])
  for (const sxn of [-1, 1]) for (const syn of [-1, 1]) for (const szn of [-1, 1])
    tris.push([[sxn * ix, syn * iy, szn * sz], [sxn * ix, syn * sy, szn * iz], [sxn * sx, syn * iy, szn * iz]])
  return orientTrisOutward(tris)
}

/** Triangular prism: tall face on the dir side, hypotenuse falling away. */
function wedgeTris(sx, sy, sz, dir) {
  const A = [-sx, -sy, -sz]; const B = [-sx, -sy, sz]
  const C = [-sx, sy, -sz]; const D = [-sx, sy, sz]
  const E = [sx, -sy, -sz]; const F = [sx, sy, -sz]
  const tris = [
    [A, B, D], [A, D, C],   // tall face at -x
    [A, F, E], [A, C, F],   // bottom face at -z
    [B, E, F], [B, F, D],   // hypotenuse
    [A, E, B],              // -y triangle
    [C, D, F],              // +y triangle
  ]
  // base has the tall face at -x; spin about z until dir is where it rises
  const rot = dir === 'px' ? [0, 0, Math.PI]
    : dir === 'py' ? [0, 0, -Math.PI / 2]
      : dir === 'ny' ? [0, 0, Math.PI / 2]
        : [0, 0, 0]
  return tris.map((t) => t.map((p) => rotEuler(p, rot)))
}

function cylTris(r, h, axis, segs, r2) {
  const tris = []
  const rt = r2 == null ? r : r2
  const pt = (t, side) => {
    const a = (t / segs) * Math.PI * 2
    const u = Math.cos(a); const v = Math.sin(a)
    const rr = side ? rt : r
    if (axis === 'z') return [u * rr, v * rr, (side ? h : -h)]
    if (axis === 'y') return [u * rr, (side ? h : -h), v * rr]
    return [(side ? h : -h), u * rr, v * rr]
  }
  for (let i = 0; i < segs; i += 1) {
    const t0 = i; const t1 = i + 1
    tris.push([pt(t0, 1), pt(t1, 1), pt(t1, 0)])
    tris.push([pt(t0, 1), pt(t1, 0), pt(t0, 0)])
    // caps
    const c0 = axis === 'z' ? [0, 0, -h] : axis === 'y' ? [0, -h, 0] : [-h, 0, 0]
    const c1 = axis === 'z' ? [0, 0, h] : axis === 'y' ? [0, h, 0] : [h, 0, 0]
    if (r > 0.01) { tris.push([pt(t0, 0), pt(t1, 0), c0]) }
    if (rt > 0.01) { tris.push([pt(t0, 1), c1, pt(t1, 1)]) }
  }
  return tris
}

/** Cone: base disc at -h, apex on the +axis end. cylTris(r2=0) would leave
 *  `segs` degenerate wall triangles — this emits one clean triangle per face. */
function coneTris(r, h, axis, segs) {
  const tris = []
  const pt = (t) => {
    const a = (t / segs) * Math.PI * 2
    const u = Math.cos(a) * r; const v = Math.sin(a) * r
    if (axis === 'z') return [u, v, -h]
    if (axis === 'y') return [u, -h, v]
    return [-h, u, v]
  }
  const apex = axis === 'z' ? [0, 0, h] : axis === 'y' ? [0, h, 0] : [h, 0, 0]
  const c0 = axis === 'z' ? [0, 0, -h] : axis === 'y' ? [0, -h, 0] : [-h, 0, 0]
  for (let i = 0; i < segs; i += 1) {
    const t0 = i; const t1 = i + 1
    tris.push([apex, pt(t0), pt(t1)])
    tris.push([pt(t0), pt(t1), c0])
  }
  return tris
}

/** Lathe: revolve a closed (radius,height) profile polygon around the axis.
 *  profile = [[r,z],…] with r≥0 and z measured from the node centre; the
 *  loop closes automatically. Touch r=0 to close the solid on the axis,
 *  stay off it for rings/flanges. Axis maps are proper rotations (det=+1)
 *  and winding is enforced by signed volume — non-convex profiles (stepped
 *  shafts, vases) can't rely on the convex-kind orient guard. */
function latheTris(profile, segs, axis) {
  const n = profile.length
  const map = (r, z, i) => {
    const a = (i / segs) * Math.PI * 2
    const u = Math.cos(a) * r; const v = Math.sin(a) * r
    if (axis === 'z') return [u, v, z]
    if (axis === 'y') return [u, z, -v]
    return [z, u, v]
  }
  const tris = []
  const area2 = (a, b, c) => {
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2]
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2]
    const cx = uy * vz - uz * vy; const cy = uz * vx - ux * vz; const cz = ux * vy - uy * vx
    return cx * cx + cy * cy + cz * cz
  }
  for (let e = 0; e < n; e += 1) {
    const [r1, z1] = profile[e]; const [r2, z2] = profile[(e + 1) % n]
    if (r1 === r2 && z1 === z2) continue
    for (let i = 0; i < segs; i += 1) {
      const j = i + 1
      const p1a = map(r1, z1, i); const p1b = map(r1, z1, j)
      const p2a = map(r2, z2, j); const p2b = map(r2, z2, i)
      for (const t of [[p1a, p1b, p2a], [p1a, p2a, p2b]]) {
        if (area2(...t) > 1e-9) tris.push(t)
      }
    }
  }
  let vol = 0
  for (const [a, b, c] of tris) {
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }
  if (vol < 0) for (const t of tris) t.reverse()
  return tris
}

/** Drop consecutive duplicates, closing-point repeats and near-collinear
 *  vertices — walls and caps must iterate the SAME vertex list or shared
 *  edges become T-junctions (a wall vertex mid-cap-edge pairs with nothing). */
function cleanPoly(pts) {
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const clean = []
  for (const p of pts) {
    const last = clean[clean.length - 1]
    if (!last || Math.abs(p[0] - last[0]) > 1e-6 || Math.abs(p[1] - last[1]) > 1e-6) clean.push(p)
  }
  if (clean.length > 1 && clean[0][0] === clean[clean.length - 1][0] && clean[0][1] === clean[clean.length - 1][1]) clean.pop()
  const out = []
  for (let i = 0; i < clean.length; i += 1) {
    const a = clean[(i + clean.length - 1) % clean.length]; const b = clean[i]; const c = clean[(i + 1) % clean.length]
    if (Math.abs(cross(a, b, c)) > 1e-6 || clean.length <= 3) out.push(b)
  }
  return out.length >= 3 ? out : clean
}

/** Ear-clipping triangulation of a simple polygon — returns point triples.
 *  Handles concave outlines (L-brackets, U-channels, arrows); degenerate
 *  input falls back to a fan so the caller always gets *some* caps. */
function earClip(pts) {
  const poly = cleanPoly(pts)
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const n = poly.length
  let area2 = 0
  for (let i = 0; i < n; i += 1) { const a = poly[i]; const b = poly[(i + 1) % n]; area2 += a[0] * b[1] - b[0] * a[1] }
  const ccw = area2 > 0
  const inside = (q, a, b, c) => {
    const d1 = cross(a, b, q); const d2 = cross(b, c, q); const d3 = cross(c, a, q)
    return ccw ? (d1 > 1e-6 && d2 > 1e-6 && d3 > 1e-6) : (d1 < -1e-6 && d2 < -1e-6 && d3 < -1e-6)
  }
  const idx = poly.map((_, i) => i)
  const tris = []
  let guard = 0
  while (idx.length > 3 && guard++ < 10000) {
    const m = idx.length
    // smallest-area valid ear first: big greedy ears can swallow boundary
    // edges and strand reflex vertices in a degenerate remainder (T-junctions)
    let best = -1; let bestArea = Infinity
    for (let i = 0; i < m; i += 1) {
      const i0 = idx[(i + m - 1) % m]; const i1 = idx[i]; const i2 = idx[(i + 1) % m]
      const a = poly[i0]; const b = poly[i1]; const c = poly[i2]
      const cr = cross(a, b, c)
      if (ccw ? cr <= 1e-6 : cr >= -1e-6) continue
      let ok = true
      for (const j of idx) {
        if (j !== i0 && j !== i1 && j !== i2 && inside(poly[j], a, b, c)) { ok = false; break }
      }
      if (!ok) continue
      const ar = Math.abs(cr)
      if (ar < bestArea) { bestArea = ar; best = i }
    }
    if (best < 0) break
    const i0 = idx[(best + m - 1) % m]; const i1 = idx[best]; const i2 = idx[(best + 1) % m]
    tris.push([i0, i1, i2])
    idx.splice(best, 1)
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]])
  else for (let i = 1; i < idx.length - 1; i += 1) tris.push([idx[0], idx[i], idx[i + 1]])
  return tris.map(([a, b, c]) => [poly[a], poly[b], poly[c]])
}

/** Prism: extrude a closed simple (u,v) polygon `depth` along the axis,
 *  centred on the node. profile coords are centred by the helper, so the
 *  polygon's bbox centre sits at pos. Concave outlines work — caps are
 *  ear-clipped, not centroid fans. Axis maps are proper rotations;
 *  winding enforced by signed volume. */
function prismTris(profile, depth, axis) {
  const map = (u, v, z) => {
    if (axis === 'z') return [u, v, z]
    if (axis === 'y') return [u, z, -v]
    return [z, u, v]
  }
  const h = depth / 2
  const tris = []
  const area2 = (a, b, c) => {
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2]
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2]
    const cx = uy * vz - uz * vy; const cy = uz * vx - ux * vz; const cz = ux * vy - uy * vx
    return cx * cx + cy * cy + cz * cz
  }
  // walls iterate the cleaned polygon so every wall edge coincides with a
  // cap edge — a collinear profile vertex would otherwise T-junction the cap
  const poly = cleanPoly(profile)
  for (let i = 0; i < poly.length; i += 1) {
    const [u1, v1] = poly[i]; const [u2, v2] = poly[(i + 1) % poly.length]
    if (u1 === u2 && v1 === v2) continue
    const b1 = map(u1, v1, -h); const b2 = map(u2, v2, -h)
    const t1 = map(u1, v1, h); const t2 = map(u2, v2, h)
    tris.push([b1, b2, t2], [b1, t2, t1])   // side wall
  }
  for (const [a, b, c] of earClip(profile)) {
    // top cap in polygon order, bottom reversed — opposite windings so the
    // pair agrees with the walls for either polygon direction
    tris.push([map(a[0], a[1], h), map(b[0], b[1], h), map(c[0], c[1], h)])
    tris.push([map(a[0], a[1], -h), map(c[0], c[1], -h), map(b[0], b[1], -h)])
  }
  let vol = 0
  for (const [a, b, c] of tris) {
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }
  const out = tris.filter((t) => area2(...t) > 1e-9)
  if (vol < 0) for (const t of out) t.reverse()
  return out
}

function ringTris(outer, inner, h, axis, segs) {
  const tris = []
  const pt = (r, t, side) => {
    const a = (t / segs) * Math.PI * 2
    const u = Math.cos(a) * r; const v = Math.sin(a) * r
    if (axis === 'z') return [u, v, side ? h : -h]
    if (axis === 'y') return [u, side ? h : -h, -v]
    return [side ? h : -h, u, v]
  }
  for (let i = 0; i < segs; i += 1) {
    const t0 = i; const t1 = i + 1
    // wall order verified outward in the canonical z-frame; the y/x maps
    // below are proper rotations (det=+1) so it stays outward on every axis
    tris.push([pt(outer, t0, 0), pt(outer, t1, 0), pt(outer, t1, 1)])
    tris.push([pt(outer, t0, 0), pt(outer, t1, 1), pt(outer, t0, 1)])
    tris.push([pt(inner, t0, 0), pt(inner, t1, 1), pt(inner, t1, 0)])
    tris.push([pt(inner, t0, 0), pt(inner, t0, 1), pt(inner, t1, 1)])
    tris.push([pt(outer, t0, 1), pt(inner, t0, 1), pt(inner, t1, 1)])
    tris.push([pt(outer, t0, 1), pt(inner, t1, 1), pt(outer, t1, 1)])
    tris.push([pt(outer, t1, 0), pt(inner, t0, 0), pt(inner, t1, 0)])
    tris.push([pt(outer, t0, 0), pt(inner, t0, 0), pt(outer, t1, 0)])
  }
  // The cap windings above only face outward for some axes — enforce it
  // geometrically: a cap tri's normal must point along its own side's axis.
  // Only true caps qualify: every ring vertex sits at axial=±h, so wall tris
  // ALSO have all |axial|=h — the old |p[ax]|===h test caught them too and
  // flipped walls at random (ring/y collapsed to vol −616). Same-sign test
  // separates caps (all verts one side) from walls (verts on both sides).
  const ax = axis === 'z' ? 2 : axis === 'y' ? 1 : 0
  return tris.map((t) => {
    const s0 = Math.sign(t[0][ax])
    if (!t.every((p) => Math.sign(p[ax]) === s0)) return t
    const [a, b, c] = t
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    return Math.sign(n[ax]) === s0 ? t : [a, c, b]
  })
}

function torusTris(R, r, axis, arcDeg) {
  const tris = []
  const M = Math.max(8, Math.round(24 * (arcDeg || 360) / 360))
  const N = 10
  const pt = (i, j) => {
    const u = (i / M) * Math.PI * 2 * ((arcDeg || 360) / 360)
    const v = (j / N) * Math.PI * 2
    const rr = R + r * Math.cos(v)
    const x = Math.cos(u) * rr; const y = Math.sin(u) * rr; const z = r * Math.sin(v)
    // proper rotations only (det=+1) — mirrors wind the tube inside-out
    if (axis === 'z') return [x, y, z]
    if (axis === 'y') return [x, z, -y]
    return [z, x, y]
  }
  for (let i = 0; i < M; i += 1) for (let j = 0; j < N; j += 1) {
    tris.push([pt(i, j), pt(i + 1, j), pt(i + 1, j + 1)])
    tris.push([pt(i, j), pt(i + 1, j + 1), pt(i, j + 1)])
  }
  // cap the arc ends if it's a partial bend — centre of each end ring
  if (arcDeg && arcDeg < 360) {
    const uM = Math.PI * 2 * (arcDeg / 360)
    const centre = (u) => {
      const x = Math.cos(u) * R; const y = Math.sin(u) * R
      // matches pt()'s proper rotations so cap winding stays consistent
      return axis === 'z' ? [x, y, 0] : axis === 'y' ? [x, 0, -y] : [0, x, y]
    }
    const c0 = centre(0); const cM = centre(uM)
    for (let j = 0; j < N; j += 1) {
      // ring edges must run opposite to the wall quads that share them:
      // the i=0 wall closes its ring edges j+1→j, ring M closes j→j+1
      tris.push([c0, pt(0, j), pt(0, j + 1)])
      tris.push([cM, pt(M, j + 1), pt(M, j)])
    }
  }
  return tris
}

function sphereTris(r) {
  const tris = []
  const M = 14; const N = 10
  const pt = (i, j) => {
    const u = (i / M) * Math.PI * 2
    const v = (j / N) * Math.PI
    return [r * Math.sin(v) * Math.cos(u), r * Math.sin(v) * Math.sin(u), r * Math.cos(v)]
  }
  // pole rings degenerate to points — fan them from real apex vertices
  // instead of emitting zero-area tris, and cover the polar caps the old
  // j<N-1 loop silently dropped (the sphere was open at the bottom)
  const Np = [0, 0, r]; const Sp = [0, 0, -r]
  for (let i = 0; i < M; i += 1) {
    tris.push([Np, pt(i, 1), pt(i + 1, 1)])
    tris.push([Sp, pt(i + 1, N - 1), pt(i, N - 1)])
  }
  for (let i = 0; i < M; i += 1) for (let j = 1; j < N - 1; j += 1) {
    tris.push([pt(i, j), pt(i + 1, j), pt(i + 1, j + 1)])
    tris.push([pt(i, j), pt(i + 1, j + 1), pt(i, j + 1)])
  }
  return tris
}

/** Spur gear: trapezoid-tooth profile extruded — one clean solid. The old
 *  build fused a root disc with penetrating tooth boxes: intersecting
 *  surfaces, non-manifold edges, BRepCheck-invalid solids. */
// Involute gear outline: tooth flanks follow the true involute curve so meshing
// pairs actually look like gears, not trapezoids. θ(ρ) is the standard tooth
// half-thickness at radius ρ: π/2T at pitch, thinner toward the tip, thicker
// toward the root — falls back to the old 4-pt trapezoid when the space between
// teeth gets too thin for an involute (very high tooth counts).
function gearOutline(T, pitchR, rootR, tipR) {
  const aPitch = Math.PI / (2 * T)
  const ALPHA = 0.34906585 // 20° pressure angle
  const rb = pitchR * Math.cos(ALPHA)
  const inv = (x) => Math.tan(x) - x
  const invA = inv(ALPHA)
  const halfThick = (rho) => {
    const r = Math.max(rho, rb * 1.000001)
    return aPitch + invA - inv(Math.acos(Math.min(1, rb / r)))
  }
  const flankBot = Math.max(rootR, rb)
  const thRoot = halfThick(flankBot)
  const space = Math.PI / T
  if (space - thRoot < space * 0.08) {
    // tooth gap nearly closed — trapezoid fallback
    const aRoot = Math.min(aPitch * pitchR / rootR, space * 0.42)
    const aTip = Math.max(0.15 * aPitch, aPitch * pitchR / tipR)
    const out = []
    for (let i = 0; i < T; i += 1) {
      const a = (i / T) * Math.PI * 2
      out.push([Math.cos(a - aRoot) * rootR, Math.sin(a - aRoot) * rootR])
      out.push([Math.cos(a - aTip) * tipR, Math.sin(a - aTip) * tipR])
      out.push([Math.cos(a + aTip) * tipR, Math.sin(a + aTip) * tipR])
      out.push([Math.cos(a + aRoot) * rootR, Math.sin(a + aRoot) * rootR])
    }
    return out
  }
  const FLANK = 5
  const out = []
  for (let i = 0; i < T; i += 1) {
    const a = (i / T) * Math.PI * 2
    const pt = (rho, ang) => [Math.cos(ang) * rho, Math.sin(ang) * rho]
    out.push(pt(rootR, a - space))                    // root-land midpoint
    if (rootR < flankBot - 1e-6) out.push(pt(rootR, a - thRoot)) // back root
    for (let k = 0; k <= FLANK; k += 1) {             // back flank, root→tip
      const rho = flankBot + ((tipR - flankBot) * k) / FLANK
      out.push(pt(rho, a - halfThick(rho)))
    }
    const thTip = halfThick(tipR)
    for (let k = 1; k <= 2; k += 1)                   // tip land arc
      out.push(pt(tipR, a - thTip + (2 * thTip * k) / 3))
    for (let k = FLANK; k >= 0; k -= 1) {             // front flank, tip→root
      const rho = flankBot + ((tipR - flankBot) * k) / FLANK
      out.push(pt(rho, a + halfThick(rho)))
    }
    if (rootR < flankBot - 1e-6) out.push(pt(rootR, a + thRoot)) // front root
  }
  return out
}

function gearTris(m, teeth, width, axis) {
  const T = Math.max(3, Math.round(teeth))
  const pitchR = (m * T) / 2
  const rootR = Math.max(0.5, pitchR - 1.1 * m)
  const tipR = pitchR + 0.85 * m
  const hh = width / 2
  const mm = Math.max(0.2, m)
  const outline = gearOutline(T, pitchR, rootR, tipR)
  const N = outline.length
  // proper rotations only (det=+1) — a mirrored map flips every face inward
  const map = (x, y, z) => axis === 'z' ? [x, y, z] : axis === 'y' ? [x, z, -y] : [z, x, y]
  const tris = []
  // caps: fan from centre — outline is star-shaped about the origin
  for (let i = 0; i < N; i += 1) {
    const j = (i + 1) % N
    tris.push([map(0, 0, hh), map(outline[i][0], outline[i][1], hh), map(outline[j][0], outline[j][1], hh)])
    tris.push([map(0, 0, -hh), map(outline[j][0], outline[j][1], -hh), map(outline[i][0], outline[i][1], -hh)])
  }
  // sides: one quad per outline edge
  for (let i = 0; i < N; i += 1) {
    const j = (i + 1) % N
    const a = outline[i]; const b = outline[j]
    tris.push([map(a[0], a[1], -hh), map(b[0], b[1], -hh), map(b[0], b[1], hh)])
    tris.push([map(a[0], a[1], -hh), map(b[0], b[1], hh), map(a[0], a[1], hh)])
  }
  return tris
}

/** Rack: bar + tooth wedges along the +z face. */
function rackTris(sx, sy, sz, teeth) {
  const tris = [...boxTris(sx, sy, sz)]
  const n = Math.max(2, teeth | 0)
  const pitch = (sx * 2) / n
  const tw = pitch * 0.42
  const th = pitch * 0.5
  for (let i = 0; i < n; i += 1) {
    const cx = -sx + pitch * (i + 0.5)
    for (const t of boxTris(tw / 2, sy * 0.96, th / 2)) {
      tris.push(t.map((p) => [p[0] + cx, p[1], p[2] + sz + th / 2]))
    }
  }
  return tris
}

const CYL_SEGS = 18

/** One node → triangles in world space. `shift` is the explode offset. */
/**
 * A real CAD mesh, converted offline from the Sand3D library
 * (tools/sand3d-fetch.mjs) and vendored as quantised int16 in src/parts-*.js.
 * `node.size` scales it per axis, so one part can be a small bracket or a large
 * gusset. If the part is missing the box stands in, so layout never collapses.
 */
function importedMeshTris(node) {
  const table = globalThis.__RF_PARTS && globalThis.__RF_PARTS[node.part]
  const fallback = () => boxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2)
  if (!table || !table.tris || !table.tris.length) return fallback()
  // Manifold guard: a vendored mesh whose edges aren't shared by exactly two
  // tris would ship holes/T-junctions into every slicer and CAD export. The
  // BRACKET source data failed exactly this (edges shared by up to 8 faces),
  // so verify topology on the quantised source before trusting it.
  const t = table.tris
  const edges = new Map()
  for (let i = 0; i + 8 < t.length; i += 9) {
    for (let e = 0; e < 3; e += 1) {
      const a = [t[i + e * 3], t[i + e * 3 + 1], t[i + e * 3 + 2]]
      const b = [t[i + ((e + 1) % 3) * 3], t[i + ((e + 1) % 3) * 3 + 1], t[i + ((e + 1) % 3) * 3 + 2]]
      const k = [a.join(','), b.join(',')].sort().join('|')
      edges.set(k, (edges.get(k) || 0) + 1)
    }
  }
  for (const c of edges.values()) if (c !== 2) { console.warn(`rigforge: imported mesh '${node.part}' is non-manifold — using bounding box`); return fallback() }
  const radiusMm = table.scale || 20
  const sx = node.size[0] / (radiusMm * 2)
  const sy = node.size[1] / (radiusMm * 2)
  const sz = node.size[2] / (radiusMm * 2)
  const k = radiusMm / 32767
  const out = []
  for (let i = 0; i < t.length; i += 9) {
    out.push([
      [t[i] * k * sx, t[i + 1] * k * sy, t[i + 2] * k * sz],
      [t[i + 3] * k * sx, t[i + 4] * k * sy, t[i + 5] * k * sz],
      [t[i + 6] * k * sx, t[i + 7] * k * sy, t[i + 8] * k * sz],
    ])
  }
  return out
}

/**
 * The whole node transform — its Euler rotation, its position, the slide it is
 * on and every joint above it — collapsed into one affine matrix, computed once
 * per node. Calling rotEuler + applyChain per *vertex* meant a 3 900-triangle
 * machine ran trigonometry about 12 000 times per rebuild; this runs it once.
 */
function nodeAffine(node, chain, slide, shift) {
  // Euler X→Y→Z, matching rotEuler
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ]
  const rot = node.rot
  if (rot) {
    const [rx, ry, rz] = rot
    if (rx) {
      const c = Math.cos(rx), s = Math.sin(rx)
      m = mul([1, 0, 0, 0, c, -s, 0, s, c], m)
    }
    if (ry) {
      const c = Math.cos(ry), s = Math.sin(ry)
      m = mul([c, 0, s, 0, 1, 0, -s, 0, c], m)
    }
    if (rz) {
      const c = Math.cos(rz), s = Math.sin(rz)
      m = mul([c, -s, 0, s, c, 0, 0, 0, 1], m)
    }
  }
  const t = [
    node.pos[0] + slide[0],
    node.pos[1] + slide[1],
    node.pos[2] + slide[2],
  ]
  if (chain) {
    const frames = chainFrames(chain)
    const f = frames[frames.length - 1]
    if (f) {
      // world = R_link·(pos + slide − pivot_link) + t_link, orientation R_link·R_node
      const P = f.joint.pivot
      const q = [t[0] - P[0], t[1] - P[1], t[2] - P[2]]
      const R = f.R
      t[0] = R[0] * q[0] + R[1] * q[1] + R[2] * q[2] + f.t[0]
      t[1] = R[3] * q[0] + R[4] * q[1] + R[5] * q[2] + f.t[1]
      t[2] = R[6] * q[0] + R[7] * q[1] + R[8] * q[2] + f.t[2]
      m = mul(R, m)
    }
  }
  if (shift) { t[0] += shift[0]; t[1] += shift[1]; t[2] += shift[2] }
  return { m, t }
}

function nodeTriangles(design, node, chain, shift) {
  const tris = []
  const slide = slideDisp(design, node)
  const { m, t } = nodeAffine(node, chain, slide, shift)
  // p' = M·p + t, nine multiplies and no trigonometry per vertex
  const world = (p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t[0],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t[1],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t[2],
  ]
  // `node` rides along so the viewport can pick a part by clicking it
  const push = (a, b, c) => tris.push({ pts: [world(a), world(b), world(c)], mat: node.mat, node: node.id })

  let local = []
  switch (node.kind) {
    case 'box': local = boxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2); break
    case 'rbox': local = rboxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.r || 1.5); break
    case 'wedge': local = wedgeTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.dir); break
    case 'rack': local = rackTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.teeth); break
    case 'cyl': local = cylTris(node.radius, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS, node.radius2); break
    case 'cone': local = coneTris(node.radius, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS); break
    case 'lathe': local = latheTris(node.profile || [], node.segs || CYL_SEGS, node.axis || 'z'); break
    case 'prism': local = prismTris(node.profile || [], node.height || 10, node.axis || 'z'); break
    case 'ring': local = ringTris(node.outer, node.inner, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS); break
    case 'torus': local = torusTris(node.R, node.r, node.axis || 'z', 360); break
    case 'bend': local = torusTris(node.R, node.r, node.axis || 'z', node.arc || 90); break
    case 'sphere': local = sphereTris(node.radius); break
    case 'gear': local = gearTris(node.module, node.teeth, node.width, node.axis || 'z'); break
    case 'mesh': local = importedMeshTris(node); break
    default: local = []
  }
  if (CONVEX_KINDS.has(node.kind)) local = orientTrisOutward(local)
  for (const t of local) push(t[0], t[1], t[2])
  return tris
}

/** Explode vectors: radially out of the model's rest bounding box. */
function explodeShifts(design, f) {
  if (!f) return null
  const b = boundsOf(design.nodes)
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
  const out = new Map()
  for (const n of design.nodes) {
    const v = [n.pos[0] - c[0], n.pos[1] - c[1], (n.pos[2] - c[2]) * 1.35]
    const len = Math.hypot(v[0], v[1], v[2])
    if (len < 3) { out.set(n.id, [0, 0, f * 20]); continue }
    out.set(n.id, [(v[0] / len) * f * 55, (v[1] / len) * f * 55, (v[2] / len) * f * 55])
  }
  return out
}

/** Full mesh for the current pose. */
function buildMesh(design, explode) {
  const tris = []
  const chains = chainsFor(design)
  const shifts = explodeShifts(design, explode || 0)
  for (const node of design.nodes) {
    const chain = node.joint ? chains.get(node.joint) : null
    const add = nodeTriangles(design, node, chain, shifts ? shifts.get(node.id) : null)
    // `node`/`mat` key the viewport colours and the GLB materials; STL/SCAD ignore them.
    for (const t of add) { t.node = node.id; t.mat = node.mat; tris.push(t) }
  }
  return tris
}

// ── exporters ───────────────────────────────────────────────────────────────
/**
 * Centroid / pick-and-place file (CPL). The third of the three files an
 * assembly house quotes from, and the one people forget. Coordinates are mm
 * from the board's centre, rotation in degrees, both in the board frame.
 */
function toCentroidCsv(design) {
  const placed = (design.pcb && design.pcb.placed) || []
  const head = 'Designator,Mid X (mm),Mid Y (mm),Layer,Rotation,Package'
  const rows = placed.map((p) => [p.des, p.x.toFixed(3), p.y.toFixed(3), p.layer || 'top', p.rot || 0, p.pkg || ''].join(','))
  const note = `# ${design.title} — centroid from Rigforge. Origin = board centre; X right, Y up, degrees CCW.`
  return [note, head, ...rows].join('\n')
}


/** Binary STL — the file a slicer actually opens. */
function toSTL(tris, headerText) {
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const view = new DataView(buf)
  const header = new Uint8Array(buf, 0, 80)
  const text = (headerText || 'Rigforge export - mm - generated, not modelled').padEnd(80, ' ').slice(0, 80)
  for (let i = 0; i < 80; i += 1) header[i] = text.charCodeAt(i) & 0x7f
  view.setUint32(80, tris.length, true)
  let o = 84
  for (const t of tris) {
    const [a, b, c] = t.pts
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    n = n.map((x) => x / len)
    for (const val of n) { view.setFloat32(o, val, true); o += 4 }
    for (const p of [a, b, c]) for (const val of p) { view.setFloat32(o, val, true); o += 4 }
    view.setUint16(o, 0, true)
    o += 2
  }
  return buf
}

/** One STL per printed node — the print pack, in rest pose as it leaves the bed. */
/**
 * A part leaves the studio the way a slicer wants it: largest face down, centred
 * on the bed, sitting on Z=0. Axis-aligned permutation only — no arbitrary
 * rotations, because a wrong "clever" angle is worse than the model's own frame.
 */
/**
 * Pick the bed orientation by actual contact area, not bounding-box dims.
 * The dims heuristic stands wedges and chamfered parts on edge — parts that
 * then need support or tip in the printer. For each of the 6 axis
 * permutations, score = area of faces that land nearly flat facing down
 * (they rest on the bed); ties go to the lower profile. Normals permute
 * with the coordinates, so n[perm[2]] < 0 is a bed-contact face.
 */
function bestBedPerm(tris, dims) {
  const lo = [Infinity, Infinity, Infinity]
  for (const t of tris) for (const p of t.pts) for (let i = 0; i < 3; i += 1) lo[i] = Math.min(lo[i], p[i])
  let best = null, bestKey = -Infinity
  for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) {
    if (b === a) continue
    const perm = [a, b, 3 - a - b]
    const up = perm[2]
    let contact = 0
    for (const t of tris) {
      const [p, q, r] = t.pts
      const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
      const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
      const nx = e1[1] * e2[2] - e1[2] * e2[1]
      const ny = e1[2] * e2[0] - e1[0] * e2[2]
      const nz = e1[0] * e2[1] - e1[1] * e2[0]
      const nup = [nx, ny, nz][up]
      const nl = Math.hypot(nx, ny, nz) || 1
      if (-nup / nl <= 0.85) continue
      // real bed contact means the whole face lies in the bed plane — a
      // curved wall strip has the right normal but only touches along a line
      if (p[up] > lo[up] + 0.4 || q[up] > lo[up] + 0.4 || r[up] > lo[up] + 0.4) continue
      contact += 0.5 * nl
    }
    const key = contact * 1e6 - dims[up] // contact first, lower profile breaks ties
    if (key > bestKey) { bestKey = key; best = perm }
  }
  let inversions = 0
  for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) if (best[i] > best[j]) inversions += 1
  return { perm: best, mirrored: inversions % 2 === 1 }
}

/**
 * The bed-frame transform every printed part gets: best face down, centred
 * on the bed, sitting on Z=0. Axis-aligned permutation only — no arbitrary
 * rotations, because a wrong "clever" angle is worse than the model's own frame.
 * Shared by printReadyTris (the STL bytes) and overhangReport (the DFM check)
 * so the analysis always describes the file the slicer actually opens.
 */
function bedFrameTris(tris) {
  if (!tris.length) return tris
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) {
    for (const p of t.pts) {
      for (let i = 0; i < 3; i += 1) {
        if (p[i] < min[i]) min[i] = p[i]
        if (p[i] > max[i]) max[i] = p[i]
      }
    }
  }
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const { perm, mirrored } = bestBedPerm(tris, dims)
  const sizeX = dims[perm[0]]
  const sizeY = dims[perm[1]]
  return tris.map((t) => {
    const pts = t.pts.map((p) => [
      p[perm[0]] - min[perm[0]] - sizeX / 2,
      p[perm[1]] - min[perm[1]] - sizeY / 2,
      p[perm[2]] - min[perm[2]],
    ])
    // a coordinate swap mirrors the solid; flip two corners to keep normals out
    return { ...t, pts: mirrored ? [pts[0], pts[2], pts[1]] : pts }
  })
}

function printReadyTris(tris) {
  return bedFrameTris(tris)
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Shelf-pack every printed node onto plates of bedMm — the exact layout the
 * 3MF export ships, bed-aware and plate-aware. Each item gets a 0-based
 * `plate` and plate-local bed coords in `rect`; `offBed` marks parts whose
 * footprint can't sit on ANY plate (bigger than the usable square), as
 * opposed to parts that simply need a second plate. Nothing is dropped.
 */
function packBedLayout(design, bedMm) {
  const bed = Math.max(100, Math.min(600, Math.round(bedMm || 256)))
  const usable = bed - 8, GAP = 8
  // measure every printed part first, then place biggest-footprint-first —
  // design order leaves half-empty rows; sorted order is what a slicer's
  // own arranger would do and it measurably cuts the plate count.
  const pending = []
  design.nodes.forEach((node, ord) => {
    if (!node.print) return
    let raw = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) raw = orientConvex(raw)
    const tris = printReadyTris(raw)
    if (!tris.length) return
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
    for (const t of tris) for (const p of t.pts) {
      if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]
      if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]
    }
    pending.push({ node, tris, minx, miny, w: maxx - minx, d: maxy - miny, ord })
  })
  // shelf-pack each ordering and keep the best — the measurement pass above
  // dominates the cost, placement is nearly free, and no single sort key wins
  // on every machine. Score: fewest plates, then tightest last plate.
  const place = (sorted) => {
    const items = []
    let plate = 0, cx = 10, cy = 10, rowH = 0
    const newRow = () => { cx = 10; cy += rowH + GAP; rowH = 0 }
    const newPlate = () => { plate += 1; cx = 10; cy = 10; rowH = 0 }
    for (const { node, tris, minx, miny, w, d } of sorted) {
      // bigger than the usable square → can't print on any plate. Flag it and
      // keep it in the flow (still visible in the file) without letting it
      // start plates or corrupt the packing of parts that do fit.
      const tooBig = w > usable - 10 || d > usable - 10
      if (!tooBig) {
        if (cx + w > usable) newRow()
        if (cy + Math.max(rowH, d) > usable) newPlate()
      }
      items.push({
        id: node.id, tris,
        x: cx - minx, y: cy - miny,        // 3MF transform offsets (plate-local)
        plate,
        rect: { x: cx, y: cy, w, d },      // plate-local footprint, mm
        offBed: tooBig || cx + w > usable || cy + d > usable,
      })
      cx += w + GAP
      if (!tooBig) rowH = Math.max(rowH, d)
    }
    return { items, plates: items.length ? plate + 1 : 0, lastDepth: cy + rowH }
  }
  const KEYS = [
    (a, b) => b.d - a.d || b.w - a.w || a.node.id.localeCompare(b.node.id),
    (a, b) => b.w - a.w || b.d - a.d || a.node.id.localeCompare(b.node.id),
    (a, b) => b.w * b.d - a.w * a.d || b.d - a.d || a.node.id.localeCompare(b.node.id),
    (a, b) => a.ord - b.ord,
  ]
  let best = null
  for (const key of KEYS) {
    const sorted = [...pending].sort(key)
    const res = place(sorted)
    const score = res.plates * 1e6 + res.lastDepth
    if (!best || score < best.score) best = { ...res, score }
  }
  const items = best.items
  return { bed, usable, items, plates: items.length ? best.plates : 0, offBed: items.filter((i) => i.offBed).length }
}

/**
 * 3MF print pack — what modern slicers (Bambu Studio, Orca, Prusa) actually
 * want: one file, named bodies, real units, laid out on a virtual bed.
 * Every printed node becomes an object with its bed-oriented triangles
 * inline; items are shelf-packed so parts don't overlap at origin.
 */
function to3MF(design, material, plate) {
  const matName = typeof material === 'string' ? material : material && material.name
  const objects = []
  const items = []
  const layout = packBedLayout(design, design.brief && design.brief.bedMm)
  // plate == null → one build with every plate banded below the last (global
  // coords, slicer flags the overflow honestly); plate = n → that plate only,
  // plate-local coords, a file that slices clean on its own.
  const sel = plate == null ? layout.items : layout.items.filter((it) => it.plate === plate)
  sel.forEach((it, i) => {
    const oid = i + 1
    const tris = it.tris
    const vmap = new Map()
    const verts = []
    const faces = []
    for (const t of tris) {
      const idx = []
      for (const p of t.pts) {
        const k = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`
        let vi = vmap.get(k)
        if (vi == null) { vi = verts.length / 3; vmap.set(k, vi); verts.push(p[0], p[1], p[2]) }
        idx.push(vi)
      }
      faces.push(`<triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"${matName ? ' pid="1"' : ''}/>`)
    }
    const vxml = []
    for (let i = 0; i < verts.length; i += 3) {
      vxml.push(`<vertex x="${verts[i].toFixed(3)}" y="${verts[i + 1].toFixed(3)}" z="${verts[i + 2].toFixed(3)}"/>`)
    }
    objects.push(`<object id="${oid}" type="model" name="${xmlEsc(it.id)}"><mesh><vertices>${vxml.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`)
    const ty = it.y + (plate == null ? it.plate * layout.usable : 0)
    items.push(`<item objectid="${oid}" transform="1 0 0 0 1 0 0 0 1 ${it.x.toFixed(3)} ${ty.toFixed(3)} 0"/>`)
  })
  if (!objects.length) return null
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>${matName ? `<basematerials id="1"><base name="${xmlEsc(matName)}" displaycolor="#B8B8B8"/></basematerials>` : ''}${objects.join('')}</resources>
<build>${items.join('')}</build>
</model>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`
  return zipStore([
    { name: '[Content_Types].xml', buf: contentTypes },
    { name: '_rels/.rels', buf: rels },
    { name: '3D/3dmodel.model', buf: model },
  ])
}

// Convex primitives: every face's normal must point away from the part's own
// centre. Rings, gears and tubes are not convex (their inner wall faces inward
// on purpose), so they are left exactly as generated.
const CONVEX_KINDS = new Set(['box', 'rbox', 'cyl', 'cone', 'sphere', 'wedge'])

function orientConvex(tris) {
  if (!tris.length) return tris
  // Interior reference = vertex average (a convex combination, always inside
  // the solid). Bbox centre sits exactly on the wedge's ramp plane — the
  // per-tri dot product degenerates to a coin toss and ships mixed winding.
  const c = [0, 0, 0]; let nv = 0
  for (const t of tris) for (const p of t.pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; nv += 1 }
  c[0] /= nv; c[1] /= nv; c[2] /= nv
  return tris.map((t) => {
    const [a, b, d] = t.pts
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const m = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]]
    return n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0 ? { ...t, pts: [t.pts[0], t.pts[2], t.pts[1]] } : t
  })
}

function printedPartSTLs(design) {
  const out = []
  for (const node of design.nodes) {
    if (!node.print) continue
    let raw = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) raw = orientConvex(raw)
    out.push({ name: `${slug(node.id)}.stl`, buf: toSTL(printReadyTris(raw), `rigforge printed part ${node.id}`) })
  }
  return out
}

/**
 * DFM overhang check, run on the exact bed-oriented tris the STL pack ships.
 *
 * A printed part is a solid shell: in every (x,y) column the lowest exterior
 * surface prints first. A downward-facing face that IS the column minimum but
 * sits above the bed is an overhang — there is air beneath it all the way down,
 * so the slicer needs support (or the part fails). Faces above the column
 * minimum have material printing underneath them and need nothing.
 *
 * "Downward-facing" uses the wound normal: n.z < -0.6 is steeper than ~53°
 * from vertical — past what a 0.4mm nozzle bridges unaided. Heightfield cell
 * size adapts to part size so big plates and tiny brackets both resolve.
 */
/**
 * Overhang + bed-contact stats for one bed-oriented tri list ({pts:[[x,y,z]…]}).
 * Split out of overhangReport so the measurement can be exercised directly —
 * bedFrameTris always finds SOME flat-ish orientation for a single solid, so
 * a real cantilever can only be proven by feeding it pre-oriented tris.
 */
function overhangTrisStats(tris) {
  let maxDim = 0
  for (const t of tris) for (const p of t.pts) {
    maxDim = Math.max(maxDim, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))
  }
  const cell = Math.min(10, Math.max(1.5, maxDim / 90))
  // XY footprint for the brim check — bed contact vs the area it could
  // plausibly cover. A tower on 20% contact wants a brim, not optimism.
  let fx0 = Infinity, fx1 = -Infinity, fy0 = Infinity, fy1 = -Infinity
  for (const t of tris) for (const p of t.pts) {
    fx0 = Math.min(fx0, p[0]); fx1 = Math.max(fx1, p[0])
    fy0 = Math.min(fy0, p[1]); fy1 = Math.max(fy1, p[1])
  }
  const footprint = Math.max(1, (fx1 - fx0) * (fy1 - fy0))
  const cols = new Map() // "ix,iy" -> lowest surface z in that column
  const colMin = (x, y) => {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`
    return cols.has(k) ? cols.get(k) : Infinity
  }
  const colSet = (x, y, z) => {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`
    if (!cols.has(k) || z < cols.get(k)) cols.set(k, z)
  }
  const normal = (t) => {
    const [a, b, c] = t.pts
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  }
  // pass 1: rasterize every near-horizontal surface into the columns it
  // actually covers — cell centre inside the tri's XY projection, height
  // interpolated on the tri plane. Bbox stamping would let a big plate
  // face claim columns it never touches and hide real overhangs.
  for (const t of tris) {
    const n = normal(t)
    const nl = Math.hypot(n[0], n[1], n[2]) || 1
    if (Math.abs(n[2]) / nl < 0.4) continue
    const [a, b, c] = t.pts
    const minx = Math.min(a[0], b[0], c[0]), maxx = Math.max(a[0], b[0], c[0])
    const miny = Math.min(a[1], b[1], c[1]), maxy = Math.max(a[1], b[1], c[1])
    // plane: n·p = d → z = (d - nx*x - ny*y) / nz
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2]
    const den = n[2] || 1e-9
    for (let ix = Math.floor(minx / cell); ix <= Math.floor(maxx / cell); ix++) {
      for (let iy = Math.floor(miny / cell); iy <= Math.floor(maxy / cell); iy++) {
        const px = ix * cell + cell / 2, py = iy * cell + cell / 2
        // barycentric in XY — inside the projected tri?
        const v0x = b[0] - a[0], v0y = b[1] - a[1]
        const v1x = c[0] - a[0], v1y = c[1] - a[1]
        const v2x = px - a[0], v2y = py - a[1]
        const den2 = v0x * v1y - v1x * v0y
        if (Math.abs(den2) < 1e-9) continue
        const u = (v2x * v1y - v1x * v2y) / den2
        const v = (v0x * v2y - v2x * v0y) / den2
        if (u < -0.02 || v < -0.02 || u + v > 1.02) continue
        colSet(px, py, (d - n[0] * px - n[1] * py) / den)
      }
    }
  }
  // pass 2: downward faces that are their column's floor, above bed level
  let unsupported = 0, steep = 0, bed = 0
  for (const t of tris) {
    const n = normal(t)
    const nl = Math.hypot(n[0], n[1], n[2]) || 1
    const nz = n[2] / nl
    if (nz > -0.35) continue // not a downward face worth judging
    const [a, b, c] = t.pts
    const area = 0.5 * Math.hypot(
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    )
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3
    const zc = (a[2] + b[2] + c[2]) / 3
    if (zc < 0.8) { bed += area; continue }
    // strict column test only for overhangs steeper than ~48° — a 45°
    // chamfer (nz≈-0.71) is the FDM self-support limit, not a failure
    if (nz < -0.75) {
      if (zc <= colMin(cx, cy) + 0.6) unsupported += area
    } else {
      steep += area
    }
  }
  // Shell parts carry inner+outer bottom faces, so `bed` can exceed the
  // footprint — coverage can't, so cap at 1. brim only cares about the low end.
  const contact = Math.min(1, bed / footprint)
  return {
    unsupported: Math.round(unsupported * 10) / 10,
    steep: Math.round(steep * 10) / 10, bed: Math.round(bed * 10) / 10,
    footprint: Math.round(footprint), contact: Math.round(contact * 100) / 100,
    brim: contact < 0.3,
  }
}

function overhangReport(design) {
  const parts = []
  for (const node of design.nodes) {
    if (!node.print) continue
    let tris = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) tris = orientConvex(tris)
    tris = bedFrameTris(tris)
    if (!tris.length) continue
    parts.push({ id: node.id, ...overhangTrisStats(tris) })
  }
  parts.sort((a, b) => b.unsupported - a.unsupported)
  const unsupportedMm2 = Math.round(parts.reduce((s, p) => s + p.unsupported, 0))
  const steepMm2 = Math.round(parts.reduce((s, p) => s + p.steep, 0))
  return {
    parts, unsupportedMm2, steepMm2,
    worst: parts.find((p) => p.unsupported > 0) || null,
    brim: parts.filter((p) => p.brim),
  }
}

/**
 * DFM wall-thickness check on the bed-oriented tris the STL pack ships.
 *
 * From sampled surface points, a ray along the face normal that comes back
 * hits the far side of the wall — counted only when the hit face's own
 * normal opposes the ray (~180°), which rejects corner and rib-edge hits.
 * Open edges return no hit: infinite thickness, correctly not "thin". The
 * part metric is a low percentile of finite samples so a few bad rays can't
 * condemn a good part. 1.2mm ≈ three 0.4mm nozzle lines — thinner prints as
 * a skin that strings or splits.
 */
const MIN_WALL_MM = 1.2

function wallReport(design) {
  // Möller–Trumbore, origins/dirs/dists in mm — returns hit distance or null
  const rayTri = (ox, oy, oz, dx, dy, dz, t) => {
    const [a, b, c] = t.pts
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-9) return null
    const inv = 1 / det
    const tx = ox - a[0], ty = oy - a[1], tz = oz - a[2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < -0.001 || u > 1.001) return null
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < -0.001 || u + v > 1.001) return null
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv
    return d > 0.05 ? d : null
  }
  const parts = []
  let thinnest = null
  for (const node of design.nodes) {
    if (!node.print) continue
    let tris = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) tris = orientConvex(tris)
    tris = printReadyTris(tris)
    if (tris.length < 6) continue
    // per-tri unit normal + centroid once; rays reuse them for the facing test
    const info = []
    for (const t of tris) {
      const [a, b, c] = t.pts
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
      const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
      const nl = Math.hypot(nx, ny, nz)
      if (nl < 1e-6) continue
      info.push({
        t, area2: nl,
        nx: nx / nl, ny: ny / nl, nz: nz / nl,
        cx: (a[0] + b[0] + c[0]) / 3, cy: (a[1] + b[1] + c[1]) / 3, cz: (a[2] + b[2] + c[2]) / 3,
      })
    }
    if (info.length < 6) continue
    // Wall thickness = material between opposing surfaces along a principal
    // axis. Face-normal rays fail here: near edges they measure edge gap,
    // not wall. So rays run axis-aligned, cast only from cap faces
    // (|normal·axis| > 0.6) — the two sides of the part along that axis —
    // and the first hit whose face is also axis-perpendicular is the far
    // wall (or a rib inside a cavity, which is thin too, honestly).
    const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    let partP10 = null
    for (const axis of AXES) {
      const cap = info.filter((s) => Math.abs(s.nx * axis[0] + s.ny * axis[1] + s.nz * axis[2]) > 0.9)
      if (cap.length < 2) continue
      const step = Math.max(1, Math.floor(cap.length / 24))
      const reads = []
      for (let i = 0; i < cap.length; i += step) {
        const s = cap[i]
        if (s.area2 < 0.02) continue
        for (const dir of [1, -1]) {
          const dx = axis[0] * dir, dy = axis[1] * dir, dz = axis[2] * dir
          let best = Infinity
          for (const o of info) {
            if (o === s) continue
            const d = rayTri(s.cx, s.cy, s.cz, dx, dy, dz, o.t)
            if (d == null || d >= best) continue
            if (Math.abs(o.nx * axis[0] + o.ny * axis[1] + o.nz * axis[2]) > 0.8) best = d
          }
          if (best < 500) reads.push({ d: best, w: s.area2 })
        }
      }
      if (reads.length < 4) continue
      reads.sort((a, b) => a.d - b.d)
      const totalW = reads.reduce((acc, x) => acc + x.w, 0)
      let acc = 0, p10 = reads[reads.length - 1].d
      for (const x of reads) { acc += x.w; if (acc >= totalW * 0.1) { p10 = x.d; break } }
      partP10 = partP10 == null ? p10 : Math.min(partP10, p10)
    }
    if (partP10 == null) continue
    const row = { id: node.id, p10: Math.round(partP10 * 100) / 100, reads: info.length }
    parts.push(row)
    thinnest = thinnest == null ? row.p10 : Math.min(thinnest, row.p10)
  }
  return { parts, thinnest, minWall: MIN_WALL_MM, thin: parts.filter((p) => p.p10 < MIN_WALL_MM) }
}

/**
 * Do two printed parts occupy the same space in the assembled machine?
 * Each part exports as its own STL, so per-file geometry is always clean —
 * the failure only shows up at assembly time, which is exactly what a builder
 * needs warned about BEFORE printing a pack.
 *
 * Scope, honestly: only printed-vs-printed pairs at the rest pose, and pairs
 * whose joint chains intersect are skipped — links legitimately nest around
 * the servo that joins them (the presets model joints that way on purpose).
 * What remains are static collisions: joiner plates crossing, pillars sunk
 * into decks, shells penetrating shells — all unassemblable as modeled.
 */
function interferenceReport(design) {
  const printedIds = new Set(design.nodes.filter((n) => n.print).map((n) => n.id))
  if (printedIds.size < 2) return { pairs: [], count: 0 }
  const byNode = new Map()
  for (const t of buildMesh(design)) {
    if (!printedIds.has(t.node)) continue
    if (!byNode.has(t.node)) byNode.set(t.node, [])
    byNode.get(t.node).push(t.pts)
  }
  if (byNode.size < 2) return { pairs: [], count: 0 }

  // joint ancestry per node — pairs sharing a joint are expected to nest
  const jParent = new Map((design.joints || []).map((j) => [j.id, j.parent || null]))
  const nodeById = new Map(design.nodes.map((n) => [n.id, n]))
  const chainCache = new Map()
  const chainOf = (id) => {
    if (chainCache.has(id)) return chainCache.get(id)
    const set = new Set()
    let cur = (nodeById.get(id) || {}).joint || null
    let guard = 0
    while (cur && guard < 24) { set.add(cur); cur = jParent.get(cur) || null; guard += 1 }
    chainCache.set(id, set)
    return set
  }
  const related = (a, b) => {
    const ca = chainOf(a); const cb = chainOf(b)
    for (const j of ca) if (cb.has(j)) return true
    return false
  }

  const boxOf = (tris) => {
    const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity]
    for (const t of tris) for (const p of t) for (let i = 0; i < 3; i += 1) {
      if (p[i] < mn[i]) mn[i] = p[i]
      if (p[i] > mx[i]) mx[i] = p[i]
    }
    return { mn, mx }
  }
  const boxes = [...byNode.entries()].map(([id, tris]) => ({ id, tris, box: boxOf(tris) }))
  const hit = (a, b) => a.mn[0] <= b.mx[0] && a.mx[0] >= b.mn[0] && a.mn[1] <= b.mx[1] && a.mx[1] >= b.mn[1] && a.mn[2] <= b.mx[2] && a.mx[2] >= b.mn[2]

  // signed-distance ray cast; irrational direction avoids axis-aligned
  // degeneracy, |t|>0.05 ignores hits on the surface itself
  const DIRS = [[1, 0.371390676, 0.217218839], [0.531, 1, 0.417], [0.291, 0.577, 1]]
    .map((d) => { const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l] })
  const rayTri = (ox, oy, oz, dx, dy, dz, t) => {
    const a = t[0]; const b = t[1]; const c = t[2]
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-9) return null
    const inv = 1 / det
    const tx = ox - a[0], ty = oy - a[1], tz = oz - a[2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < -0.001 || u > 1.001) return null
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < -0.001 || u + v > 1.001) return null
    return (e2x * qx + e2y * qy + e2z * qz) * inv
  }
  const inside = (x, y, z, tris) => {
    const [dx, dy, dz] = DIRS[0]
    let n = 0
    for (const t of tris) { const d = rayTri(x, y, z, dx, dy, dz, t); if (d != null && d > 0.05) n += 1 }
    return n % 2 === 1
  }
  // penetration estimate: nearest surface hit over 3 rays — shallow grazes
  // and intentional press-fit slop stay under the floor
  const depthAt = (x, y, z, tris) => {
    let best = Infinity
    for (const [dx, dy, dz] of DIRS) {
      for (const t of tris) {
        const d = rayTri(x, y, z, dx, dy, dz, t)
        if (d != null && Math.abs(d) > 0.05 && Math.abs(d) < best) best = Math.abs(d)
      }
    }
    return best === Infinity ? 0 : best
  }

  const pairs = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const A = boxes[i]; const B = boxes[j]
      if (related(A.id, B.id) || !hit(A.box, B.box)) continue
      const [small, big] = A.tris.length <= B.tris.length ? [A, B] : [B, A]
      const step = Math.max(1, Math.floor(small.tris.length / 120))
      let deep = 0; let worst = 0
      for (let k = 0; k < small.tris.length; k += step) {
        const t = small.tris[k]
        const cx = (t[0][0] + t[1][0] + t[2][0]) / 3
        const cy = (t[0][1] + t[1][1] + t[2][1]) / 3
        const cz = (t[0][2] + t[1][2] + t[2][2]) / 3
        if (!inside(cx, cy, cz, big.tris)) continue
        const d = depthAt(cx, cy, cz, big.tris)
        if (d > 0.8) { deep += 1; if (d > worst) worst = d }
        if (deep >= 3) break
      }
      if (deep >= 3) pairs.push({ a: A.id, b: B.id, depth: Math.round(worst * 10) / 10 })
    }
  }
  pairs.sort((p, q) => q.depth - p.depth)
  return { pairs, count: pairs.length }
}

/**
 * The bundle an assembly house or a fab actually wants, in one zip. Named files
 * rather than a folder of guesses: BOM with MPNs, the centroid file, the spec.
 */
function boardPack(design, analysis, base) {
  const pcb = design.pcb || { W: 0, H: 0, placed: [], joints: 0 }
  const readme = [
    `RIGFORGE — ${design.title}`,
    '',
    `Board: ${Math.round(pcb.W)} x ${Math.round(pcb.H)} mm, 2 layers, 1.6 mm FR4`,
    `Placements: ${(pcb.placed || []).length}   Solder joints on the board: ${pcb.joints || 0}`,
    '',
    'FILES IN THIS PACK',
    `  ${base}-bom.csv   bill of materials with manufacturer part numbers`,
    `  ${base}-cpl.csv   centroid / pick-and-place: designator, mid X, mid Y, layer, rotation`,
    `  ${base}.md         the build spec: checks, power, mass, notes`,
    '',
    'WHAT TO SEND',
    '  Fab:       the Gerbers you export from your EDA tool, plus this BOM.',
    '  Assembly:  Gerbers + BOM + centroid. Ask for consigned/kitted assembly.',
    '  Centroid coordinates are mm from the board centre, X right, Y up, degrees CCW.',
    '',
    'Built with Rigforge. Prices in the BOM are catalogue estimates unless you',
    'refreshed live supplier prices first.',
  ].join('\n')
  return [
    { name: `${base}-bom.csv`, buf: toBOMCsv(design) },
    { name: `${base}-cpl.csv`, buf: toCentroidCsv(design) },
    { name: `${base}.md`, buf: toSpecMarkdown(design, analysis) },
    { name: 'README.txt', buf: readme },
  ]
}

/**
 * glTF binary (.glb) — the format every 3D viewer, game engine and AR tool
 * opens natively. One named mesh node per machine part, positions only
 * (viewers flat-shade, which matches the faceted parts anyway). Units are
 * metres with +Y up per the glTF spec; source tris are mm Z-up, so each
 * vertex maps (x, y, z) → (x·0.001, z·0.001, −y·0.001).
 */
function toGLB(tris) {
  const groups = new Map()
  for (const t of tris) {
    const k = t.node || '_'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(t)
  }
  const keys = [...groups.keys()]
  const f32 = []
  // PBR-ish stand-ins from the same palette the viewport uses — enough for a
  // viewer to show plastic shell vs steel vs brass vs rubber correctly.
  const MAT_DEFS = {
    shell: { c: [0.776, 0.808, 0.839], m: 0.05, r: 0.6 },
    accent: { c: [1.0, 0.42, 0.1], m: 0.0, r: 0.5 },
    metal: { c: [0.549, 0.588, 0.635], m: 0.7, r: 0.45 },
    steel: { c: [0.376, 0.424, 0.478], m: 0.85, r: 0.4 },
    brass: { c: [0.737, 0.596, 0.29], m: 0.8, r: 0.4 },
    pcb: { c: [0.125, 0.376, 0.275], m: 0.0, r: 0.7 },
    copper: { c: [0.59, 0.33, 0.13], m: 0.15, r: 0.6 },
    silk: { c: [0.93, 0.94, 0.92], m: 0.0, r: 0.8 },
    pcbblue: { c: [0.05, 0.11, 0.30], m: 0.0, r: 0.6 },
    rubber: { c: [0.149, 0.165, 0.188], m: 0.0, r: 0.95 },
    glass: { c: [0.439, 0.839, 0.91], m: 0.0, r: 0.15 },
    servo: { c: [0.118, 0.133, 0.165], m: 0.3, r: 0.6 },
    belt: { c: [0.133, 0.141, 0.157], m: 0.0, r: 0.9 },
  }
  const matIndex = new Map()
  const materials = []
  const matFor = (name) => {
    const key = name || 'shell'
    if (!matIndex.has(key)) {
      const d = MAT_DEFS[key] || MAT_DEFS.shell
      matIndex.set(key, materials.length)
      materials.push({ name: key, pbrMetallicRoughness: { baseColorFactor: [...d.c, 1], metallicFactor: d.m, roughnessFactor: d.r } })
    }
    return matIndex.get(key)
  }
  const parts = keys.map((k) => {
    const trisK = groups.get(k)
    const mat = trisK.length && trisK[0].mat ? trisK[0].mat : 'shell'
    const mn = [Infinity, Infinity, Infinity]
    const mx = [-Infinity, -Infinity, -Infinity]
    const start = f32.length / 3
    for (const t of groups.get(k)) {
      for (const p of t.pts) {
        const v = [p[0] * 0.001, p[2] * 0.001, -p[1] * 0.001]
        for (let i = 0; i < 3; i += 1) {
          f32.push(v[i])
          if (v[i] < mn[i]) mn[i] = v[i]
          if (v[i] > mx[i]) mx[i] = v[i]
        }
      }
    }
    return { name: k, mat, start, count: f32.length / 3 - start, min: mn, max: mx }
  }).filter((p) => p.count > 0)
  const binLen = f32.length * 4
  const bufferViews = []
  const accessors = []
  const meshes = []
  const nodes = []
  parts.forEach((p, i) => {
    bufferViews.push({ buffer: 0, byteOffset: p.start * 12, byteLength: p.count * 12 })
    accessors.push({ bufferView: i, componentType: 5126, count: p.count, type: 'VEC3', min: p.min, max: p.max })
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: i }, material: matFor(p.mat), mode: 4 }] })
    nodes.push({ name: p.name, mesh: i })
  })
  const json = {
    asset: { version: '2.0', generator: 'RigForge', extras: { sourceUnits: 'millimeter', upAxis: 'Y' } },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, accessors, bufferViews,
    materials,
    buffers: [{ byteLength: binLen }],
  }
  let jsonStr = JSON.stringify(json)
  while (jsonStr.length % 4) jsonStr += ' '
  const jsonBytes = new TextEncoder().encode(jsonStr)
  const binPad = (4 - (binLen % 4)) % 4
  const chunkLen = binLen + binPad
  const total = 12 + 8 + jsonBytes.length + 8 + chunkLen
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  dv.setUint32(0, 0x46546c67, true)  // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  new Uint8Array(buf, 20, jsonBytes.length).set(jsonBytes)
  let o = 20 + jsonBytes.length
  dv.setUint32(o, chunkLen, true); o += 4
  dv.setUint32(o, 0x004e4942, true); o += 4 // 'BIN\0'
  const out = new Float32Array(buf, o, f32.length)
  for (let i = 0; i < f32.length; i += 1) out[i] = f32[i]
  return buf
}

/**
 * STEP (ISO 10303-21, AP214) — the neutral CAD format a fab shop, CNC
 * programmer or SolidWorks/Fusion seat actually opens. Every node becomes a
 * PRODUCT whose shape is a FACETED_BREP: polygonal faces on explicit planes,
 * one shell per part, world-millimetre coordinates — the same posed geometry
 * the STL/GLB exporters ship, in the format CAD kernels validate.
 *
 * Faceted B-rep is the honest representation for a triangle mesh: the
 * triangles ARE the surface, so nothing is smoothed or invented. Parts whose
 * winding runs inward get flipped per-part (signed-volume check) so every
 * solid reads positive in a CAD kernel.
 */
function toSTEP(design) {
  const q = (v) => Math.round(v * 10000) / 10000
  const num = (v) => { const r = q(v); return Object.is(r, -0) ? '0' : String(r) }
  // entity values get 6 decimals — 4-decimal coords put vertices ~1e-4mm off
  // their quantised face planes, past the declared uncertainty, and strict
  // kernels (BRepCheck) rejected those solids. Dedup keys stay at 4 decimals
  // so near-coincident verts still merge into one shared point.
  const numP = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r) }
  const pt = (p, f = numP) => `(${f(p[0])},${f(p[1])},${f(p[2])})`
  const lines = []
  let n = 1
  const push = (body) => { const id = n; n += 1; lines.push(`#${id} = ${body};`); return id }
  // header + protocol, then the shared unit/uncertainty context every rep
  // points at — same block real CAD kernels emit, millimetres declared
  lines.push("ISO-10303-21;", "HEADER;",
    "FILE_DESCRIPTION(('RigForge STEP export — faceted B-rep, millimetres'),'2;1');",
    `FILE_NAME('${String(design.title || 'rigforge').replace(/'/g, '')}.step','2026-01-01T00:00:00',('RigForge'),('RigForge'),'STEP processor','RigForge','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;", "DATA;")
  n = 1
  push(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#2)`)
  push(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`)
  const uLen = push(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`)
  const uAng = push(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`)
  const uSol = push(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`)
  const uUnc = push(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-4),#${uLen},'distance_accuracy_value','')`)
  const ctx = push(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uUnc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${uLen},#${uAng},#${uSol})) REPRESENTATION_CONTEXT('','') )`)
  const pointIds = new Map()   // "x,y,z" → CARTESIAN_POINT id (shared across parts)
  const planeIds = new Map()   // quantised normal+offset → PLANE id
  const dirIds = new Map()     // "x,y,z" → DIRECTION id
  const P = (p) => {
    const k = `${q(p[0])},${q(p[1])},${q(p[2])}`
    if (!pointIds.has(k)) pointIds.set(k, push(`CARTESIAN_POINT('',${pt(p)})`))
    return pointIds.get(k)
  }
  const DIR = (v) => {
    const k = `${q(v[0])},${q(v[1])},${q(v[2])}`
    if (!dirIds.has(k)) dirIds.set(k, push(`DIRECTION('',${pt(v)})`))
    return dirIds.get(k)
  }
  const PLANE = (normal, origin) => {
    const d = normal[0] * origin[0] + normal[1] * origin[1] + normal[2] * origin[2]
    const k = `${q(normal[0])},${q(normal[1])},${q(normal[2])}|${q(d)}`
    if (planeIds.has(k)) return planeIds.get(k)
    // placement ref must be ⊥ the normal: cross with the least-parallel axis
    const h = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    let rx = h[1] * normal[2] - h[2] * normal[1]
    let ry = h[2] * normal[0] - h[0] * normal[2]
    let rz = h[0] * normal[1] - h[1] * normal[0]
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl; ry /= rl; rz /= rl
    const axisId = DIR(normal), refId = DIR([rx, ry, rz]), orgId = P(origin)
    const plc = push(`AXIS2_PLACEMENT_3D('',#${orgId},#${axisId},#${refId})`)
    const pl = push(`PLANE('',#${plc})`)
    planeIds.set(k, pl)
    return pl
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
  const signedVol = (list) => {
    let v = 0
    for (const t of list) {
      const [a, b, c] = t.pts
      v += a[0] * (b[1] * c[2] - b[2] * c[1])
        + a[1] * (b[2] * c[0] - b[0] * c[2])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    }
    return v / 6
  }

  const byNode = new Map()
  for (const t of buildMesh(design)) {
    if (!t.pts || t.pts.length !== 3) continue
    const e1 = sub(t.pts[1], t.pts[0]); const e2 = sub(t.pts[2], t.pts[0])
    if (Math.hypot(...cross(e1, e2)) < 1e-6) continue // degenerate — no face
    const k = t.node || '_'
    if (!byNode.has(k)) byNode.set(k, [])
    byNode.get(k).push(t)
  }
  const partPDs = []
  // Shared identity frame: first item of every part rep and the source side
  // of each placement transform — same role OCC's compound origin plays.
  let originPlc = 0
  const identAxis = () => {
    if (!originPlc) {
      const o = P([0, 0, 0]); const z = DIR([0, 0, 1]); const x = DIR([1, 0, 0])
      originPlc = push(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${x})`)
    }
    return originPlc
  }
  const slotAxis = () => {
    const o = P([0, 0, 0]); const z = DIR([0, 0, 1]); const x = DIR([1, 0, 0])
    return push(`AXIS2_PLACEMENT_3D('',#${o},#${z},#${x})`)
  }
  for (const [name, list] of byNode) {
    // inward-wound parts get flipped so the solid's volume reads positive
    const flip = signedVol(list) < 0
    const safe = String(name).replace(/'/g, '')
    const faceIds = []
    for (const t of list) {
      const p = flip ? [t.pts[0], t.pts[2], t.pts[1]] : t.pts
      const e1 = sub(p[1], p[0]); const e2 = sub(p[2], p[0])
      const normal = norm(cross(e1, e2))
      const a = P(p[0]); const b = P(p[1]); const c = P(p[2])
      const loop = push(`POLY_LOOP('',(#${a},#${b},#${c}))`)
      const bound = push(`FACE_OUTER_BOUND('',#${loop},.T.)`)
      const plane = PLANE(normal, p[0])
      faceIds.push(push(`FACE_SURFACE('',(#${bound}),#${plane},.T.)`))
    }
    const shell = push(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`)
    const brep = push(`FACETED_BREP('${safe}',#${shell})`)
    const rep = push(`FACETED_BREP_SHAPE_REPRESENTATION('${safe}',(#${identAxis()},#${brep}),#${ctx})`)
    // product chain — one PRODUCT per node, positioned in world mm
    const pctx = push(`PRODUCT_CONTEXT('',#2,'mechanical')`)
    const prod = push(`PRODUCT('${safe}','${safe}','',(#${pctx}))`)
    const pdf = push(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prod},.NOT_KNOWN.)`)
    const pdc = push(`PRODUCT_DEFINITION_CONTEXT('part definition',#2,'design')`)
    const pd = push(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`)
    const pds = push(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)
    push(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`)
    partPDs.push({ name: safe, pd, rep })
  }
  // Assembly level (AP214, same shape OCC emits): a COMPOUND-style product
  // owns a SHAPE_REPRESENTATION listing one placement slot per component;
  // each part is linked back through CONTEXT_DEPENDENT_SHAPE_REPRESENTATION →
  // REPRESENTATION_RELATIONSHIP(+TRANSFORMATION) → ITEM_DEFINED_TRANSFORMATION
  // → NEXT_ASSEMBLY_USAGE_OCCURRENCE. Breps are authored in machine/world mm,
  // so every placement is honestly the identity — no invented local frames.
  if (partPDs.length > 1) {
    const apc = push(`PRODUCT_CONTEXT('',#2,'mechanical')`)
    const title = String(design.title || 'rigforge assembly').replace(/'/g, '')
    const aprod = push(`PRODUCT('assembly','${title}','',(#${apc}))`)
    const apdf = push(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${aprod},.NOT_KNOWN.)`)
    const apdc = push(`PRODUCT_DEFINITION_CONTEXT('assembly definition',#2,'design')`)
    const apd = push(`PRODUCT_DEFINITION('design','',#${apdf},#${apdc})`)
    const apsds = push(`PRODUCT_DEFINITION_SHAPE('','',#${apd})`)
    const slots = [identAxis(), ...partPDs.map(() => slotAxis())]
    const aprep = push(`SHAPE_REPRESENTATION('',(${slots.map((s) => `#${s}`).join(',')}),#${ctx})`)
    push(`SHAPE_DEFINITION_REPRESENTATION(#${apsds},#${aprep})`)
    partPDs.forEach(({ name, pd, rep }, i) => {
      const slot = slots[i + 1]
      const idt = push(`ITEM_DEFINED_TRANSFORMATION('','',#${identAxis()},#${slot})`)
      const rel = push(`( REPRESENTATION_RELATIONSHIP('','',#${rep},#${aprep}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt}) SHAPE_REPRESENTATION_RELATIONSHIP() )`)
      const nauo = push(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${i + 1}','${name}','',#${apd},#${pd},$)`)
      const ppds = push(`PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item',#${nauo})`)
      push(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${ppds})`)
    })
  }
  lines.push("ENDSEC;", "END-ISO-10303-21;")
  return lines.join('\n') + '\n'
}

// Minimal ZIP (store-only): what a slicer folder wants, no compression library.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// Fixed timestamp: a build pack should be byte-identical when rebuilt, so no
// Date.now() here. 2026-01-01 12:00:00 in DOS format.
const DOS_TIME = (12 << 11) | (0 << 5) | 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

function zipStore(entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const { name, buf } of entries) {
    const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf instanceof Uint8Array ? buf : enc.encode(buf)
    const nameB = enc.encode(name)
    const crc = crc32(data)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true)
    head.setUint16(6, 0, true); head.setUint16(8, 0, true)
    head.setUint16(10, DOS_TIME, true); head.setUint16(12, DOS_DATE, true)
    head.setUint32(14, crc, true)
    head.setUint32(18, data.length, true); head.setUint32(22, data.length, true)
    head.setUint16(26, nameB.length, true); head.setUint16(28, 0, true)
    parts.push(new Uint8Array(head.buffer), nameB, data)

    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true)
    cen.setUint16(12, DOS_TIME, true); cen.setUint16(14, DOS_DATE, true)
    cen.setUint32(16, crc, true)
    cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true)
    cen.setUint16(28, nameB.length, true)
    cen.setUint32(42, offset, true)
    central.push(new Uint8Array(cen.buffer), nameB)
    offset += 30 + nameB.length + data.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true)
  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const chunk of parts) { out.set(chunk, p); p += chunk.length }
  for (const chunk of central) { out.set(chunk, p); p += chunk.length }
  out.set(new Uint8Array(end.buffer), p)
  return out.buffer
}

/**
 * OpenSCAD source a maker can actually edit.
 *
 * A flat list of positioned primitives is readable but useless to work with:
 * you cannot isolate the base tower, you cannot print one part, and you cannot
 * move a part as a unit. So every node becomes a named module and an
 * `assembly()` instantiates them all, with a `PART` switch at the top. Values
 * stay in world millimetres, because that is how the rest of the studio thinks.
 */
function scadName(id) {
  // keep underscores as they are: `base-bolt--1-1-hd` and `base-bolt-1-1-hd`
  // are different nodes, and collapsing the runs made one module shadow the
  // other, so one bolt was drawn twice and its twin never appeared
  const clean = String(id).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
  return `p_${clean || 'part'}`
}

/** Parametric source, not a baked mesh: the user can edit dimensions. */
function toOpenSCAD(design) {
  const head = [
    `// ${design.title} — Rigforge export`,
    `// Rest pose, millimetres. $fn controls cylinder smoothness.`,
    `// Set PART to a module name to print or edit that part alone:`,
    `// PART = "p_base_plate";   // "all" builds the whole machine`,
    '$fn = 48;',
    '',
    'PART = "all";',
    '',
  ]
  const bodies = []
  const names = []
  const used = new Map()
  for (const n of design.nodes) {
    let name = scadName(n.id)
    // a module name has to be unique or OpenSCAD silently uses the last one
    if (used.has(name)) {
      const n2 = used.get(name) + 1
      used.set(name, n2)
      name = `${name}_${n2}`
    } else {
      used.set(name, 1)
    }
    names.push(name)
    const pos = `translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}])`
    const euler = n.rot ? `rotate([${n.rot.map((r) => (r * 180 / Math.PI).toFixed(0)).join(', ')}]) ` : ''
    // rotate([-90,0,0]) sends +z to +y — the same convention every mesh
    // y-map uses; [90,0,0] mirrored asymmetric parts (cone apex, bend arc)
    const axRot = n.axis === 'x' ? 'rotate([0, 90, 0]) ' : n.axis === 'y' ? 'rotate([-90, 0, 0]) ' : ''
    const wrap = `${pos} ${euler}${axRot}`
    let prim
    if (n.kind === 'box' || n.kind === 'rbox') {
      prim = `${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true);`
    } else if (n.kind === 'wedge' || n.kind === 'rack') {
      prim = `${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true); /* simplified from ${n.kind} */`
    } else if (n.kind === 'gear') {
      prim = `${wrap}cylinder(h=${n.width.toFixed(1)}, r=${(((n.module * n.teeth) / 2) - n.module).toFixed(1)}, center=true); /* ${n.teeth}T module ${n.module} */`
    } else if (n.kind === 'ring') {
      prim = `${wrap}difference() { cylinder(h=${n.height.toFixed(1)}, r=${n.outer.toFixed(1)}, center=true); cylinder(h=${(n.height + 1).toFixed(1)}, r=${n.inner.toFixed(1)}, center=true); }`
    } else if (n.kind === 'torus' || n.kind === 'bend') {
      prim = `${wrap}rotate_extrude() translate([${n.R.toFixed(1)}, 0, 0]) circle(r=${n.r.toFixed(1)});`
    } else if (n.kind === 'sphere') {
      prim = `${wrap}sphere(r=${n.radius.toFixed(1)});`
    } else if (n.kind === 'mesh') {
      // imported CAD mesh: OpenSCAD gets its bounding box, because the STL is
      // the authoritative geometry and this is a worked-in-space placeholder
      prim = `${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true); /* imported mesh (${n.part || 'part'}) */`
    } else if (n.kind === 'cone') {
      prim = `${wrap}cylinder(h=${n.height.toFixed(1)}, r1=${n.radius.toFixed(1)}, r2=0, center=true); /* cone */`
    } else if (n.kind === 'lathe') {
      const pts = (n.profile || []).map((p) => `[${(+p[0]).toFixed(1)}, ${(+p[1]).toFixed(1)}]`).join(', ')
      prim = `${wrap}rotate_extrude() polygon([${pts}]); /* lathe */`
    } else if (n.kind === 'prism') {
      const pts = (n.profile || []).map((p) => `[${(+p[0]).toFixed(1)}, ${(+p[1]).toFixed(1)}]`).join(', ')
      prim = `${wrap}linear_extrude(height=${(+n.height).toFixed(1)}, center=true) polygon([${pts}]); /* prism */`
    } else if (n.radius == null) {
      prim = `${wrap}cube([${(n.size || [10, 10, 10]).map((v) => v.toFixed(1)).join(', ')}], center=true); /* ${n.kind || 'node'} */`
    } else {
      const r2 = n.radius2 != null ? `, r2=${n.radius2.toFixed(1)}` : ''
      prim = `${wrap}cylinder(h=${n.height.toFixed(1)}, r=${n.radius.toFixed(1)}${r2}, center=true);`
    }
    bodies.push(`// ${n.id}${n.print ? ' · printed' : ''}`)
    bodies.push(`module ${name}() { ${prim} }`)
    bodies.push('')
  }
  const assembly = [
    'module assembly() {',
    ...names.map((n) => `  ${n}();`),
    '}',
    '',
    'if (PART == "all") assembly();',
    ...names.map((n) => `if (PART == "${n}") ${n}();`),
    '',
  ]
  return [...head, ...bodies, ...assembly].join('\n')
}

function toBOMCsv(design, analysis) {
  const rows = [['part', 'category', 'qty', 'unit_usd', 'line_usd', 'dims_mm', 'connector', 'mount', 'sku_search', 'role']]
  let sum = 0
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    const line = p.price * qty
    sum += line
    rows.push([
      p.name, p.cat, String(qty), p.price.toFixed(2), line.toFixed(2),
      p.dims ? p.dims.join('x') : '', p.conn || '', p.mount || '', p.sku || '', role,
    ])
  }
  // Filament is money too. Without this line the CSV summed to less than the
  // headline cost, so anyone checking the sheet found a different total.
  if (analysis && analysis.print && analysis.print.grams > 0.5) {
    const mat = analysis.print.material || { name: 'filament', priceId: 'petg_kg' }
    const spool = PARTS[mat.priceId]?.price || 20
    const grams = analysis.print.grams
    const line = (grams / 1000) * spool
    sum += line
    rows.push([
      `${mat.name} filament used`, 'material', `${Math.round(grams)} g`,
      ((spool / 1000) * 100).toFixed(2), line.toFixed(2),
      '', '', '', mat.priceId || '', 'printed parts',
    ])
  }
  rows.push(['TOTAL', '', '', '', sum.toFixed(2), '', '', '', '', 'sums to the studio headline'])
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n')
}

/** The build pack: everything a person needs, in one document. */
function toSpecMarkdown(design, a, extras) {
  const L = []
  const m = design.metrics || {}
  L.push(`# ${design.title}`, '', `_${design.subtitle}_`, '')
  L.push(`**Brief:** ${design.brief.mission || '(no mission text)'}`, '')
  L.push(`| | |`, `|---|---|`)
  L.push(`| Material | ${a.print.material.name} |`)
  L.push(`| Mass | ${Math.round(a.mass.totalG)}g (${Math.round(a.mass.printedG)}g printed) |`)
  L.push(`| Footprint | ${a.dims.map((d) => Math.round(d)).join(' × ')} mm |`)
  L.push(`| Cost | ${money(a.cost)} |`)
  L.push(`| Print | ${fmt(a.print.hours, 0)} h |`)
  L.push(`| Controller | ${a.mcu.name} |`)
  if (m.joints) L.push(`| Actuated joints | ${m.joints} |`)
  if (a.reach && a.reach.r) L.push(`| Reach bound | ~${a.reach.r} mm (links fully extended${a.reach.side ? `, ${a.reach.side} arm` : ''}) |`)
  if (extras && extras.ws && extras.ws.stats && extras.ws.stats.reach) {
    const s = extras.ws.stats
    L.push(`| Sampled workspace | ${s.reach}/${s.total} IK-verified targets reachable · ${s.lift} also lift ${s.payloadG}g |`)
  }
  if (m.runtimeMin) L.push(`| Runtime | ~${Math.round(m.runtimeMin)} min |`)
  L.push('')

  if (extras && extras.legWs && extras.legWs.legs && extras.legWs.legs.length) {
    L.push('## Foot workspace (IK-sampled)', '',
      'Each leg was solved against a sphere of targets around its hip; a point counts only when the joint chain reaches it within joint limits.', '',
      '| Leg | Reachable targets |', '|---|---|')
    for (const leg of extras.legWs.legs) L.push(`| ${leg.key.toUpperCase()} | ${leg.reach}/${leg.total} |`)
    L.push('')
  }

  L.push('## Readiness', '')
  for (const c of a.checks) L.push(`- ${c.level === 'ok' ? 'PASS' : c.level.toUpperCase()} — ${c.msg}`)
  L.push('')

  if (design.mech && design.mech.length) {
    L.push('## Mechanics', '', '| Check | Value | Limit | Status |', '|---|---|---|---|')
    for (const r of design.mech) L.push(`| ${r.label} | ${r.value} | ${r.limit} | ${r.ok == null ? '—' : r.ok ? 'ok' : 'LOW'} |`)
    L.push('')
  }

  L.push('## Bill of materials', '', '| Part | Qty | Unit | Line | Details | Role |', '|---|---|---|---|---|---|')
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    const det = [p.dims ? p.dims.join('×') + 'mm' : '', p.conn || '', p.mount || ''].filter(Boolean).join(' · ')
    L.push(`| ${p.name} | ${qty} | ${money(p.price)} | ${money(p.price * qty)} | ${det} | ${role} |`)
  }
  L.push('', `**Total: ${money(a.cost)}**`, '')

  L.push('## Pin map', '', '| Pin | Signal | Dir | Note |', '|---|---|---|---|')
  for (const r of a.pins.rows) L.push(`| ${r.pin} | ${r.signal} | ${r.dir} | ${r.note} |`)
  L.push('')

  L.push('## Power budget', '', '| Rail | Typical | Peak | Wire | Fuse |', '|---|---|---|---|---|')
  for (const w of (a.power.wiring || [])) L.push(`| ${w.rail} | ${fmt(w.amps, 2)} A | ${fmt(w.peak, 2)} A | AWG ${w.awg} | ${w.fuse ? `${w.fuse} A` : '—'} |`)
  L.push('', `Typical ${fmt(a.power.typ, 2)}A, peak ${fmt(a.power.peak, 2)}A${a.power.runtimeMin ? `, ~${Math.round(a.power.runtimeMin)} min on ${a.power.bat.name}` : ''}.`, '')

  if (a.harness && a.harness.rows.length) {
    L.push('## Servo harness', '', '| Joint | Run (est.) | Lead | V drop @ stall |', '|---|---|---|---|')
    for (const r of a.harness.rows) {
      L.push(`| ${r.label || r.id} | ~${r.run}mm | ${r.lead === 'daisy-chain' ? 'TTL bus' : r.lead === 'stock' ? 'stock ok' : r.lead === 'check' ? 'check lead length' : r.lead === 'extend' ? 'needs extension' : r.lead} | ${r.vdrop}V |`)
    }
    const totalM = a.harness.rows.reduce((s, r) => s + (r.run || 0), 0) / 1000
    const ext = a.harness.rows.filter((r) => r.lead === 'extend').length
    L.push('', a.harness.note,
      `Estimated joint-run total: ~${totalM.toFixed(2)} m across ${a.harness.rows.length} joints (includes 35% routing slack)` +
      (ext ? `; ${ext} extension lead${ext > 1 ? 's' : ''} in the BOM` : '') + '.', '')
  }

  // the print pack section: which bed, how many plates, what the slicer files
  // are — the numbers the checks warn about, stated as a build instruction
  const pk = a.print && a.print.pack
  if (pk && pk.items.length) {
    L.push('## Print pack', '')
    L.push(`- Bed ${pk.bed}mm · ${pk.items.length} parts packed on ${pk.plates === 1 ? 'one plate' : `~${pk.plates} plates`} — the print-pack ZIP ships one ready-to-slice 3MF per plate plus per-part STLs.`)
    if (pk.offBed) L.push(`- **${pk.offBed} part(s) can't fit any ${pk.bed}mm plate** — split them or pick a bigger bed before printing.`)
    const wl = a.print.wall
    if (wl && wl.thinnest != null) {
      L.push(`- Thinnest measured wall ~${wl.thinnest}mm${wl.thin.length ? ` — ${wl.thin.length} part(s) under the ${wl.minWall}mm printable floor` : ' — every wall clears the printable floor'}.`)
    }
    const oh = a.print.overhang
    if (oh && oh.unsupportedMm2 > 0) L.push(`- Overhang: ~${oh.unsupportedMm2}mm² of surface needs support material.`)
    L.push('')
  }

  L.push('## Firmware', '', '```cpp', design.firmware.trim(), '```', '')
  L.push('## Assembly', '')
  for (const s of design.steps) L.push(`${s.n}. **${s.title}** (${fmtMinutes(s.min)}) — ${s.detail}${s.tools.length ? ` _Tools: ${s.tools.join(', ')}._` : ''}`)
  L.push('')
  if (design.notes.length) {
    L.push('## Design notes', '')
    for (const n of design.notes) L.push(`- ${n}`)
  }
  L.push('', '---', '_Generated by Rigforge — deterministic spec, no model in the loop._')
  return L.join('\n')
}

/**
 * Plain-text build sheet that travels inside the print-pack ZIP — the slicer
 * facing twin of the spec's Print pack section. Everything in it comes from
 * the measured pack layout, wall raycasts and overhang heightfield; nothing
 * is asserted from parameters.
 */
function printPackReadme(design, a, fileBase) {
  const p = (a && a.print) || {}
  const pk = p.pack || { items: [], plates: 0, bed: 0, offBed: 0 }
  const base = fileBase || slug(design.title || 'rigforge')
  const L = []
  L.push(`RIGFORGE PRINT PACK — ${design.title || 'untitled machine'}`)
  L.push('='.repeat(54))
  L.push(`Material ....... ${p.material ? p.material.name : 'as briefed'}`)
  L.push(`Print bed ...... ${pk.bed || '?'} mm plate`)
  L.push(`Plates ......... ${pk.plates === 1 ? '1 — single plate' : `~${pk.plates} — one 3MF per plate`}`)
  L.push(`Parts .......... ${pk.items.length} printed pieces`)
  L.push('')
  L.push('FILES')
  if (pk.plates > 1) {
    L.push(`  ${base}-plate1.3mf … ${base}-plate${pk.plates}.3mf   one per print job,`)
    L.push('                                            parts already arranged')
    L.push('  plates.csv                               part → plate map for STL slicing')
  } else {
    L.push(`  ${base}-plate1.3mf                        single plate, ready to slice`)
  }
  L.push('  *.stl                                    one per printed part')
  L.push('')
  L.push('The .stl files are pre-oriented flat on the bed for printing. For')
  L.push('assembly orientation use the .glb or .scad export.')
  L.push('')
  L.push('MEASURED SLICER NOTES')
  const wl = p.wall
  if (wl && wl.thinnest != null) {
    L.push(`  Walls ......... thinnest ~${wl.thinnest}mm` +
      (wl.thin.length
        ? ` — ${wl.thin.length} part(s) under the ${wl.minWall}mm floor: ${wl.thin.slice(0, 4).map((t) => prettyPart(t.id)).join(', ')}${wl.thin.length > 4 ? '…' : ''}`
        : ' — every wall clears the printable floor'))
  }
  const oh = p.overhang
  if (oh) {
    L.push(oh.unsupportedMm2 > 0
      ? `  Overhang ....... ~${oh.unsupportedMm2}mm² needs support${oh.worst ? ` — worst: ${prettyPart(oh.worst.id)}` : ''}`
      : '  Overhang ....... none measured — self-supporting')
    if (oh.brim && oh.brim.length) {
      L.push(`  Brim ........... enable — ${oh.brim.slice(0, 4).map((b) => `${prettyPart(b.id)} (${Math.round(b.contact * 100)}% contact)`).join(', ')}${oh.brim.length > 4 ? '…' : ''}`)
    }
  }
  if (pk.offBed) L.push(`  !! ${pk.offBed} part(s) can't fit ANY ${pk.bed}mm plate — split them or pick a bigger bed`)
  L.push('')
  if (p.grams != null) L.push(`ESTIMATE ....... ~${Math.round(p.grams)}g filament · ~${Math.round(p.hours)}h print time (the slicer will refine)`)
  L.push('')
  L.push('Generated by RigForge — every number above is measured from the')
  L.push('actual geometry, not asserted from parameters.')
  return L.join('\n')
}

function boundRadius(n) {
  switch (n.kind) {
    case 'cyl': case 'cone': case 'lathe': case 'prism': return Math.max(n.radius, n.radius2 || 0, n.height / 2)
    case 'ring': return Math.max(n.outer, n.height / 2)
    case 'torus': case 'bend': return n.R + n.r
    case 'sphere': return n.radius
    case 'gear': return Math.max((n.module * n.teeth) / 2 + n.module, n.width / 2)
    default: return Math.hypot(n.size[0], n.size[1], n.size[2]) / 2
  }
}

function boundsOf(nodes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const n of nodes) {
    let half
    if (n.kind === 'box' || n.kind === 'rbox' || n.kind === 'wedge' || n.kind === 'rack') {
      half = [n.size[0] / 2, n.size[1] / 2, n.size[2] / 2]
    } else if (n.kind === 'prism') {
      // profile bbox in the (u,v) plane × depth along the axis
      const p = n.profile || []
      const us = p.map((q) => q[0]); const vs = p.map((q) => q[1])
      const hu = (Math.max(...us) - Math.min(...us)) / 2
      const hv = (Math.max(...vs) - Math.min(...vs)) / 2
      const along = (n.height || 0) / 2
      half = n.axis === 'x' ? [along, hu, hv] : n.axis === 'y' ? [hu, along, hv] : [hu, hv, along]
    } else {
      // radial extent, NOT boundRadius: a 123mm rail is 6mm Ø, not 123 in y
      const r = n.kind === 'cyl' || n.kind === 'cone' || n.kind === 'lathe' ? Math.max(n.radius, n.radius2 || 0)
        : n.kind === 'ring' ? n.outer
          : boundRadius(n)
      const along = n.kind === 'cyl' || n.kind === 'cone' || n.kind === 'lathe' || n.kind === 'ring' ? n.height / 2 : n.kind === 'gear' ? n.width / 2 : r
      half = n.axis === 'x' ? [along, r, r] : n.axis === 'y' ? [r, along, r] : [r, r, along]
      if (n.kind === 'torus' || n.kind === 'bend' || n.kind === 'sphere') half = [r, r, r]
    }
    if (n.rot) {
      // world AABB of a rotated box: rotate the 8 local corners, take abs max
      const w = [0, 0, 0]
      for (let c = 0; c < 8; c += 1) {
        const p = rotEuler([half[0] * (c & 1 ? 1 : -1), half[1] * (c & 2 ? 1 : -1), half[2] * (c & 4 ? 1 : -1)], n.rot)
        for (let i = 0; i < 3; i += 1) w[i] = Math.max(w[i], Math.abs(p[i]))
      }
      half = w
    }
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], n.pos[i] - half[i])
      max[i] = Math.max(max[i], n.pos[i] + half[i])
    }
  }
  return { min, max }
}
