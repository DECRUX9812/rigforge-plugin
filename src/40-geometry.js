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

/** Apply a joint chain's rotations (root → leaf) to a rest-pose point. */
function applyChain(chain, point) {
  let p = point
  if (!chain) return p
  for (const j of chain) {
    if (j.slide) continue
    // Pitch joints read positive = UP: a slider that raises the arm should not
    // drive it into the table. (Servo direction is flipped in the firmware.)
    const sign = j.axis === 'y' ? -1 : 1
    p = rotAxis(p, j.pivot, j.axis, (sign * j.angle * Math.PI) / 180)
  }
  return p
}

/** Linear-joint displacement for a node that rides a slide. */
function slideDisp(design, node) {
  if (!node.slide) return [0, 0, 0]
  const j = design.joints.find((jj) => jj.id === node.slide.joint)
  if (!j || !j.slide) return [0, 0, 0]
  const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[j.axis]
  const t = j.angle * (node.slide.sign || 1)
  return [dir[0] * t, dir[1] * t, dir[2] * t]
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
function rboxTris(sx, sy, sz, r) {
  const rr = Math.min(r, Math.min(sx, sy, sz) * 0.45)
  const P = (sxn, syn, szn, ex, ey, ez) => [
    sxn * (sx - ex * rr), syn * (sy - ey * rr), szn * (sz - ez * rr),
  ]
  const C = []
  for (const szn of [-1, 1]) for (const syn of [-1, 1]) for (const sxn of [-1, 1]) {
    C.push({ s: [sxn, syn, szn], x: P(sxn, syn, szn, 1, 0, 0), y: P(sxn, syn, szn, 0, 1, 0), z: P(sxn, syn, szn, 0, 0, 1) })
  }
  const at = (sxn, syn, szn) => C.find((c) => c.s[0] === sxn && c.s[1] === syn && c.s[2] === szn)
  const tris = []
  const fan = (verts) => { for (let i = 1; i < verts.length - 1; i += 1) tris.push([verts[0], verts[i], verts[i + 1]]) }

  // face octagons
  const faces = [
    { axis: 'z', sign: 1, pts: (c) => [c.x, c.y], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'z', sign: -1, pts: (c) => [c.x, c.y], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'y', sign: 1, pts: (c) => [c.x, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'y', sign: -1, pts: (c) => [c.x, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'x', sign: 1, pts: (c) => [c.y, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'x', sign: -1, pts: (c) => [c.y, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
  ]
  for (const f of faces) {
    const verts = []
    for (const [u, v] of f.order) {
      const s = f.axis === 'z' ? [u, v, f.sign] : f.axis === 'y' ? [u, f.sign, v] : [f.sign, u, v]
      const c = at(s[0], s[1], s[2])
      const [p0, p1] = f.pts(c)
      verts.push(p0)
      verts.push(p1 === p0 ? p0 : p1)
    }
    // order the 8 pts correctly: each corner contributes two edge points;
    // walking the perimeter: [c0.p0, c1.p0, c1.p1, c2.p0? ...]
    const oct = [
      f.pts(at(...(f.axis === 'z' ? [-1, -1, f.sign] : f.axis === 'y' ? [-1, f.sign, -1] : [f.sign, -1, -1])))[0],
      f.pts(at(...(f.axis === 'z' ? [1, -1, f.sign] : f.axis === 'y' ? [1, f.sign, -1] : [f.sign, 1, -1])))[0],
      f.pts(at(...(f.axis === 'z' ? [1, -1, f.sign] : f.axis === 'y' ? [1, f.sign, -1] : [f.sign, 1, -1])))[1],
      f.pts(at(...(f.axis === 'z' ? [1, 1, f.sign] : f.axis === 'y' ? [1, f.sign, 1] : [f.sign, 1, 1])))[1],
      f.pts(at(...(f.axis === 'z' ? [1, 1, f.sign] : f.axis === 'y' ? [1, f.sign, 1] : [f.sign, 1, 1])))[0],
      f.pts(at(...(f.axis === 'z' ? [-1, 1, f.sign] : f.axis === 'y' ? [-1, f.sign, 1] : [f.sign, -1, 1])))[0],
      f.pts(at(...(f.axis === 'z' ? [-1, 1, f.sign] : f.axis === 'y' ? [-1, f.sign, 1] : [f.sign, -1, 1])))[1],
      f.pts(at(...(f.axis === 'z' ? [-1, -1, f.sign] : f.axis === 'y' ? [-1, f.sign, -1] : [f.sign, -1, -1])))[1],
    ]
    fan(oct)
  }

  // 12 edge chamfers
  for (const syn of [-1, 1]) for (const szn of [-1, 1]) {
    const c0 = at(-1, syn, szn); const c1 = at(1, syn, szn)
    tris.push([c0.y, c1.y, c1.z]); tris.push([c0.y, c1.z, c0.z])
  }
  for (const sxn of [-1, 1]) for (const szn of [-1, 1]) {
    const c0 = at(sxn, -1, szn); const c1 = at(sxn, 1, szn)
    tris.push([c0.x, c0.z, c1.z]); tris.push([c0.x, c1.z, c1.x])
  }
  for (const sxn of [-1, 1]) for (const syn of [-1, 1]) {
    const c0 = at(sxn, syn, -1); const c1 = at(sxn, syn, 1)
    tris.push([c0.x, c1.x, c1.y]); tris.push([c0.x, c1.y, c0.y])
  }
  // 8 corner triangles
  for (const c of C) tris.push([c.x, c.z, c.y])
  return tris
}

/** Triangular prism: tall face on the dir side, hypotenuse falling away. */
function wedgeTris(sx, sy, sz, dir) {
  const A = [-sx, -sy, -sz]; const B = [-sx, -sy, sz]
  const C = [-sx, sy, -sz]; const D = [-sx, sy, sz]
  const E = [sx, -sy, -sz]; const F = [sx, sy, -sz]
  const tris = [
    [A, B, D], [A, D, C],   // tall face at -x
    [A, E, F], [A, F, C],   // bottom face at -z
    [B, E, F], [B, F, D],   // hypotenuse
    [A, B, E],              // -y triangle
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

function ringTris(outer, inner, h, axis, segs) {
  const tris = []
  const pt = (r, t, side) => {
    const a = (t / segs) * Math.PI * 2
    const u = Math.cos(a) * r; const v = Math.sin(a) * r
    if (axis === 'z') return [u, v, side ? h : -h]
    if (axis === 'y') return [u, side ? h : -h, v]
    return [side ? h : -h, u, v]
  }
  for (let i = 0; i < segs; i += 1) {
    const t0 = i; const t1 = i + 1
    tris.push([pt(outer, t0, 1), pt(outer, t1, 1), pt(outer, t1, 0)])
    tris.push([pt(outer, t0, 1), pt(outer, t1, 0), pt(outer, t0, 0)])
    tris.push([pt(inner, t0, 0), pt(inner, t1, 0), pt(inner, t1, 1)])
    tris.push([pt(inner, t0, 0), pt(inner, t1, 1), pt(inner, t0, 1)])
    tris.push([pt(outer, t0, 1), pt(inner, t0, 1), pt(inner, t1, 1)])
    tris.push([pt(outer, t0, 1), pt(inner, t1, 1), pt(outer, t1, 1)])
    tris.push([pt(outer, t1, 0), pt(inner, t0, 0), pt(inner, t1, 0)])
    tris.push([pt(outer, t0, 0), pt(inner, t0, 0), pt(outer, t1, 0)])
  }
  return tris
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
    if (axis === 'z') return [x, y, z]
    if (axis === 'y') return [x, z, y]
    return [z, y, x]
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
      return axis === 'z' ? [x, y, 0] : axis === 'y' ? [x, 0, y] : [0, y, x]
    }
    const c0 = centre(0); const cM = centre(uM)
    for (let j = 0; j < N; j += 1) {
      tris.push([c0, pt(0, j + 1), pt(0, j)])
      tris.push([cM, pt(M, j), pt(M, j + 1)])
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
  for (let i = 0; i < M; i += 1) for (let j = 0; j < N - 1; j += 1) {
    tris.push([pt(i, j), pt(i + 1, j), pt(i + 1, j + 1)])
    tris.push([pt(i, j), pt(i + 1, j + 1), pt(i, j + 1)])
  }
  return tris
}

/** Spur gear: root disc + tooth boxes around it. */
function gearTris(m, teeth, width, axis) {
  const tris = []
  const pitchR = (m * teeth) / 2
  const rootR = Math.max(1, pitchR - 1.1 * m)
  const tipR = pitchR + 0.85 * m
  const hh = width / 2
  tris.push(...cylTris(rootR, hh, axis, Math.max(teeth * 2, 16)))
  // hub bore suggestion: darker inner disc is skipped — a bore ring costs tris
  const tw = Math.max(0.7, m * 0.85) // tooth thickness (tangential)
  const th = tipR - rootR + m * 0.4  // tooth radial depth
  for (let i = 0; i < teeth; i += 1) {
    const a = (i / teeth) * Math.PI * 2
    const cx = Math.cos(a) * (rootR + th / 2 - m * 0.2)
    const cy = Math.sin(a) * (rootR + th / 2 - m * 0.2)
    const tooth = boxTris(th / 2, tw / 2, hh * 0.92)
    for (const t of tooth) {
      tris.push(t.map((p) => {
        // local tooth box points radially along +x before spin to angle a
        const x = p[0]; const y = p[1]; const z = p[2]
        const rx = x * Math.cos(a) - y * Math.sin(a) + cx
        const ry = x * Math.sin(a) + y * Math.cos(a) + cy
        if (axis === 'z') return [rx, ry, z]
        if (axis === 'y') return [rx, z, ry]
        return [z, ry, rx]
      }))
    }
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
function nodeTriangles(design, node, chain, shift) {
  const tris = []
  const slide = slideDisp(design, node)
  const world = (p) => {
    const q = rotEuler(p, node.rot)
    let w = [q[0] + node.pos[0] + slide[0], q[1] + node.pos[1] + slide[1], q[2] + node.pos[2] + slide[2]]
    w = applyChain(chain, w)
    return shift ? [w[0] + shift[0], w[1] + shift[1], w[2] + shift[2]] : w
  }
  const push = (a, b, c) => tris.push({ pts: [world(a), world(b), world(c)], mat: node.mat })

  let local = []
  switch (node.kind) {
    case 'box': local = boxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2); break
    case 'rbox': local = rboxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.r || 1.5); break
    case 'wedge': local = wedgeTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.dir); break
    case 'rack': local = rackTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.teeth); break
    case 'cyl': local = cylTris(node.radius, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS, node.radius2); break
    case 'ring': local = ringTris(node.outer, node.inner, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS); break
    case 'torus': local = torusTris(node.R, node.r, node.axis || 'z', 360); break
    case 'bend': local = torusTris(node.R, node.r, node.axis || 'z', node.arc || 90); break
    case 'sphere': local = sphereTris(node.radius); break
    case 'gear': local = gearTris(node.module, node.teeth, node.width, node.axis || 'z'); break
    default: local = []
  }
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
    // `node` is the filament-colour key for the viewport; STL/SCAD ignore it.
    for (const t of add) { t.node = node.id; tris.push(t) }
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
function printReadyTris(tris) {
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
  // biggest two dims into XY, thinnest into Z: that is "largest face down"
  const order = [0, 1, 2].sort((a, b) => dims[b] - dims[a])
  const perm = order // perm[0] -> X, perm[1] -> Y, perm[2] -> Z
  // a coordinate permutation with odd parity mirrors the solid, which would
  // turn every normal inward — flip two corners to compensate
  let inversions = 0
  for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) if (perm[i] > perm[j]) inversions += 1
  const mirrored = inversions % 2 === 1
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

// Convex primitives: every face's normal must point away from the part's own
// centre. Rings, gears and tubes are not convex (their inner wall faces inward
// on purpose), so they are left exactly as generated.
const CONVEX_KINDS = new Set(['box', 'rbox', 'cyl', 'cone', 'sphere', 'wedge'])

function orientConvex(tris) {
  if (!tris.length) return tris
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) for (const p of t.pts) for (let i = 0; i < 3; i += 1) {
    if (p[i] < min[i]) min[i] = p[i]
    if (p[i] > max[i]) max[i] = p[i]
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
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

/** Parametric source, not a baked mesh: the user can edit dimensions. */
function toOpenSCAD(design) {
  const lines = [
    `// ${design.title} — Rigforge export`,
    `// Rest pose, mm. Edit the numbers, or $fn for smoother cylinders.`,
    '$fn = 48;',
    '',
  ]
  for (const n of design.nodes) {
    const pos = `translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}])`
    const c = ` // ${n.id}`
    // translate outermost, then local Euler, then axis flip — matches nodeEuler
    const euler = n.rot ? `rotate([${n.rot.map((r) => (r * 180 / Math.PI).toFixed(0)).join(', ')}]) ` : ''
    const axRot = n.axis === 'x' ? 'rotate([0, 90, 0]) ' : n.axis === 'y' ? 'rotate([90, 0, 0]) ' : ''
    const wrap = `${pos} ${euler}${axRot}`
    if (n.kind === 'box' || n.kind === 'rbox') {
      lines.push(`${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true);${c}`)
    } else if (n.kind === 'wedge' || n.kind === 'rack') {
      lines.push(`${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true);${c} (simplified)`)
    } else if (n.kind === 'gear') {
      lines.push(`${wrap}cylinder(h=${n.width.toFixed(1)}, r=${(((n.module * n.teeth) / 2) - n.module).toFixed(1)}, center=true);${c} ${n.teeth}T m${n.module}`)
    } else if (n.kind === 'ring') {
      lines.push(`${wrap}difference() { cylinder(h=${n.height.toFixed(1)}, r=${n.outer.toFixed(1)}, center=true); cylinder(h=${(n.height + 1).toFixed(1)}, r=${n.inner.toFixed(1)}, center=true); }${c}`)
    } else if (n.kind === 'torus' || n.kind === 'bend') {
      lines.push(`${wrap}rotate_extrude() translate([${n.R.toFixed(1)},0,0]) circle(r=${n.r.toFixed(1)});${c}`)
    } else if (n.kind === 'sphere') {
      lines.push(`${wrap}sphere(r=${n.radius.toFixed(1)});${c}`)
    } else {
      const r2 = n.radius2 != null ? `, r2=${n.radius2.toFixed(1)}` : ''
      lines.push(`${wrap}cylinder(h=${n.height.toFixed(1)}, r=${n.radius.toFixed(1)}${r2}, center=true);${c}`)
    }
  }
  return lines.join('\n')
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
function toSpecMarkdown(design, a) {
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
  if (m.runtimeMin) L.push(`| Runtime | ~${Math.round(m.runtimeMin)} min |`)
  L.push('')

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

function boundRadius(n) {
  switch (n.kind) {
    case 'cyl': return Math.max(n.radius, n.radius2 || 0, n.height / 2)
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
    } else {
      // radial extent, NOT boundRadius: a 123mm rail is 6mm Ø, not 123 in y
      const r = n.kind === 'cyl' ? Math.max(n.radius, n.radius2 || 0)
        : n.kind === 'ring' ? n.outer
          : boundRadius(n)
      const along = n.kind === 'cyl' || n.kind === 'ring' ? n.height / 2 : n.kind === 'gear' ? n.width / 2 : r
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
