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
  // The cap windings above only face outward for some axes — enforce it
  // geometrically: a cap tri's normal must point along its own side's axis.
  const ax = axis === 'z' ? 2 : axis === 'y' ? 1 : 0
  return tris.map((t) => {
    if (!t.every((p) => Math.abs(p[ax]) === h)) return t
    const side = t[0][ax] > 0 ? 1 : -1
    const [a, b, c] = t
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    return Math.sign(n[ax]) === side ? t : [a, c, b]
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
/**
 * A real CAD mesh, converted offline from the Sand3D library
 * (tools/sand3d-fetch.mjs) and vendored as quantised int16 in src/parts-*.js.
 * `node.size` scales it per axis, so one part can be a small bracket or a large
 * gusset. If the part is missing the box stands in, so layout never collapses.
 */
function importedMeshTris(node) {
  const table = globalThis.__RF_PARTS && globalThis.__RF_PARTS[node.part]
  if (!table || !table.tris || !table.tris.length) {
    return boxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2)
  }
  const radiusMm = table.scale || 20
  const sx = node.size[0] / (radiusMm * 2)
  const sy = node.size[1] / (radiusMm * 2)
  const sz = node.size[2] / (radiusMm * 2)
  const t = table.tris
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
    for (const j of chain) {
      if (j.slide) continue
      const sign = j.axis === 'y' ? -1 : 1
      const a = (sign * j.angle * Math.PI) / 180
      if (!a) continue
      const c = Math.cos(a), s = Math.sin(a)
      const R = j.axis === 'x'
        ? [1, 0, 0, 0, c, -s, 0, s, c]
        : j.axis === 'y'
          ? [c, 0, s, 0, 1, 0, -s, 0, c]
          : [c, -s, 0, s, c, 0, 0, 0, 1]
      // rotate about the joint pivot: p' = R(p − pivot) + pivot
      const pv = j.pivot || [0, 0, 0]
      const rpv = [
        R[0] * pv[0] + R[1] * pv[1] + R[2] * pv[2],
        R[3] * pv[0] + R[4] * pv[1] + R[5] * pv[2],
        R[6] * pv[0] + R[7] * pv[1] + R[8] * pv[2],
      ]
      // p' = R(p − pivot) + pivot applied to the whole transform, so the
      // translation is rotated too: t' = R·t − R·pivot + pivot
      const rt = [
        (R[0] * t[0] + R[1] * t[1] + R[2] * t[2]) - rpv[0] + pv[0],
        (R[3] * t[0] + R[4] * t[1] + R[5] * t[2]) - rpv[1] + pv[1],
        (R[6] * t[0] + R[7] * t[1] + R[8] * t[2]) - rpv[2] + pv[2],
      ]
      t[0] = rt[0]; t[1] = rt[1]; t[2] = rt[2]
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
    case 'mesh': local = importedMeshTris(node); break
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
 * 3MF print pack — what modern slicers (Bambu Studio, Orca, Prusa) actually
 * want: one file, named bodies, real units, laid out on a virtual bed.
 * Every printed node becomes an object with its bed-oriented triangles
 * inline; items are shelf-packed so parts don't overlap at origin.
 */
function to3MF(design, material) {
  const matName = typeof material === 'string' ? material : material && material.name
  const objects = []
  const items = []
  const BED_W = 300, GAP = 8
  let cx = 10, cy = 10, rowH = 0, oid = 1
  for (const node of design.nodes) {
    if (!node.print) continue
    let raw = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) raw = orientConvex(raw)
    const tris = printReadyTris(raw)
    if (!tris.length) continue
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
    for (const t of tris) for (const p of t.pts) {
      if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]
      if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]
    }
    const w = maxx - minx, d = maxy - miny
    if (cx + w > BED_W && cx > 10) { cx = 10; cy += rowH + GAP; rowH = 0 }
    items.push(`<item objectid="${oid}" transform="1 0 0 0 1 0 0 0 1 ${(cx - minx).toFixed(3)} ${(cy - miny).toFixed(3)} 0"/>`)
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
    objects.push(`<object id="${oid}" type="model" name="${xmlEsc(node.id)}"><mesh><vertices>${vxml.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`)
    cx += w + GAP
    rowH = Math.max(rowH, d)
    oid += 1
  }
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
function overhangReport(design) {
  const parts = []
  let unsupportedMm2 = 0, steepMm2 = 0
  for (const node of design.nodes) {
    if (!node.print) continue
    let tris = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) tris = orientConvex(tris)
    tris = bedFrameTris(tris)
    if (!tris.length) continue
    let maxDim = 0
    for (const t of tris) for (const p of t.pts) {
      maxDim = Math.max(maxDim, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))
    }
    const cell = Math.min(10, Math.max(1.5, maxDim / 90))
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
      if (nz < -0.6) {
        if (zc <= colMin(cx, cy) + 0.6) unsupported += area
      } else {
        steep += area
      }
    }
    unsupportedMm2 += unsupported; steepMm2 += steep
    parts.push({
      id: node.id, unsupported: Math.round(unsupported * 10) / 10,
      steep: Math.round(steep * 10) / 10, bed: Math.round(bed * 10) / 10,
    })
  }
  parts.sort((a, b) => b.unsupported - a.unsupported)
  return {
    parts, unsupportedMm2: Math.round(unsupportedMm2), steepMm2: Math.round(steepMm2),
    worst: parts.find((p) => p.unsupported > 0) || null,
  }
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
    const axRot = n.axis === 'x' ? 'rotate([0, 90, 0]) ' : n.axis === 'y' ? 'rotate([90, 0, 0]) ' : ''
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
