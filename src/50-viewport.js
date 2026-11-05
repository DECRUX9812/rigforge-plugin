// ── viewport: a software 3D renderer, because a CAD view cannot be a DIV ────
// Painter's algorithm on 2D canvas: sub-millisecond for these meshes, no
// WebGL context to lose, no three.js to ship. Shading is a three-light studio
// rig (warm key, cool fill, cyan rim) with per-material specular, a hemispheric
// ambient term and per-vertex gradients, so curved parts read as real plastic
// and metal instead of flat clay. Every triangle here is the same triangle the
// STL exporter writes.

const CAM0 = { yaw: -0.62, pitch: 0.42, dist: 900, ortho: false }

// ── materials ───────────────────────────────────────────────────────────────
// albedo in 0-255, spec = highlight strength, shine = highlight tightness,
// metal = how much the albedo tints that highlight (0 plastic, 1 metal), glow
// = self-lit parts so a PCB or an LED strip does not go black in shadow.
const MAT = {
  shell: { alb: [234, 229, 218], spec: 0.20, shine: 26, metal: 0.0, glow: 0 },
  accent: { alb: [255, 118, 28], spec: 0.30, shine: 34, metal: 0.0, glow: 0 },
  metal: { alb: [186, 195, 206], spec: 0.85, shine: 70, metal: 0.85, glow: 0 },
  steel: { alb: [104, 118, 134], spec: 0.75, shine: 60, metal: 1.0, glow: 0 },
  brass: { alb: [216, 172, 88], spec: 0.8, shine: 64, metal: 1.0, glow: 0 },
  pcb: { alb: [26, 112, 82], spec: 0.25, shine: 44, metal: 0.0, glow: 0.05 },
  rubber: { alb: [30, 33, 38], spec: 0.06, shine: 12, metal: 0.0, glow: 0 },
  glass: { alb: [128, 226, 246], spec: 0.9, shine: 96, metal: 0.0, glow: 0.18 },
  servo: { alb: [44, 54, 78], spec: 0.34, shine: 40, metal: 0.15, glow: 0 },
  belt: { alb: [42, 44, 50], spec: 0.09, shine: 16, metal: 0.0, glow: 0 },
}

// Multi-colour print: printed shell parts take a filament colour by node order,
// so a machine reads as an assembled multi-material build — the maker look.
const FILAMENT = [
  [226, 74, 46], // vermilion
  [38, 152, 142], // teal
  [232, 178, 58], // amber
  [124, 96, 190], // violet
  [58, 108, 184], // cobalt
  [228, 236, 232], // white
  [198, 148, 88], // copper
  [96, 176, 96], // leaf
]

// three-point studio rig: [direction toward the light, colour, intensity]
const LIGHTS = [
  [norm3([0.46, -0.50, 0.72]), [1.0, 0.955, 0.9], 1.32], // warm key, upper front-left
  [norm3([-0.66, -0.14, 0.26]), [0.38, 0.6, 1.0], 0.34], // cool fill, left rear
  [norm3([0.05, 0.66, 0.34]), [0.5, 0.92, 1.0], 0.42], // cyan rim, behind
]
const SKY = [0.17, 0.21, 0.29]
const GROUND = [0.045, 0.052, 0.07]

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function camBasis(cam, target) {
  const cy = Math.cos(cam.yaw)
  const sy = Math.sin(cam.yaw)
  const cp = Math.cos(cam.pitch)
  const sp = Math.sin(cam.pitch)
  // unit vector from target to eye
  const back = [cy * cp, sy * cp, sp]
  const eye = [target[0] + back[0] * cam.dist, target[1] + back[1] * cam.dist, target[2] + back[2] * cam.dist]
  // right and up must both be orthogonal to `back` — up = back × right, which
  // is [-cy·sp, -sy·sp, cp]. (The naive [sy·sp, -cy·sp, cp] is NOT orthogonal
  // and throws the whole frame off-centre downward.)
  const x = [-sy, cy, 0]
  const y = [-cy * sp, -sy * sp, cp]
  return { eye, x, y, back }
}

function project(p, cam, target, w, h) {
  const b = cam._basis || camBasis(cam, target)
  const rel = [p[0] - b.eye[0], p[1] - b.eye[1], p[2] - b.eye[2]]
  const vx = rel[0] * b.x[0] + rel[1] * b.x[1]
  const vy = rel[0] * b.y[0] + rel[1] * b.y[1] + rel[2] * b.y[2]
  const depth = -(rel[0] * b.back[0] + rel[1] * b.back[1] + rel[2] * b.back[2])
  const f = (w < h ? w : h) * 0.9 / (cam.dist > 1 ? cam.dist : 1)
  const s = cam.ortho ? f : f * (cam.dist / (depth > 1 ? depth : 1))
  return { x: w / 2 + vx * s, y: h / 2 - vy * s, depth }
}

/** Material for a triangle, with the multicolour-print tint applied to shells. */
function materialFor(t, tint) {
  const m = MAT[t.mat] || MAT.shell
  if (!tint || t.mat !== 'shell') return m
  // blend the filament colour into the shell albedo — still reads as plastic,
  // not as a sticker.
  const k = 0.82
  return {
    alb: [
      m.alb[0] * (1 - k) + tint[0] * k,
      m.alb[1] * (1 - k) + tint[1] * k,
      m.alb[2] * (1 - k) + tint[2] * k,
    ],
    spec: m.spec,
    shine: m.shine,
    metal: m.metal,
    glow: m.glow,
  }
}

/**
 * Radiance for one normal, seen from one view vector. Directional lights, so
 * the only per-vertex inputs are the normal and the rim term — which is what
 * turns a faceted cylinder into a smooth one.
 */
function shadeNormal(n, vx, vy, vz, m, specTerm) {
  const up = 0.5 + 0.5 * n[2]
  const amb = SKY[0] * up * 0.92 + GROUND[0] * (1 - up) * 2.2
  const alb = m.alb
  let r = alb[0] * amb
  let gg = alb[1] * amb
  let b = alb[2] * amb

  for (let i = 0; i < 3; i += 1) {
    const L = LIGHTS[i]
    const d = n[0] * L[0][0] + n[1] * L[0][1] + n[2] * L[0][2]
    if (d <= 0) continue
    const k = d * L[2] * 0.86
    r += alb[0] * k * L[1][0]
    gg += alb[1] * k * L[1][1]
    b += alb[2] * k * L[1][2]
  }

  // rim: grazing angles pick up the cool studio light
  let ndv = (n[0] * vx + n[1] * vy + n[2] * vz) / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1)
  if (ndv < 0) ndv = -ndv
  const fr = 1 - ndv
  const rim = fr * fr * fr * 0.22
  r += rim * 92
  gg += rim * 118
  b += rim * 158

  if (specTerm > 0) {
    const sr = specTerm * 255
    r += m.metal > 0.5 ? sr * (alb[0] / 255) : sr
    gg += m.metal > 0.5 ? sr * (alb[1] / 255) : sr
    b += m.metal > 0.5 ? sr * (alb[2] / 255) : sr
  }

  if (m.glow) {
    r += m.glow * alb[0] * 0.5
    gg += m.glow * alb[1] * 0.5
    b += m.glow * alb[2] * 0.5
  }

  return [r > 255 ? 255 : r, gg > 255 ? 255 : gg, b > 255 ? 255 : b]
}

const css = (c, a) => (a == null
  ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
  : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`)

/** Per-face specular from the Blinn half-vector. */
function specularFor(n, cx, cy, cz, eye, m) {
  let best = 0
  for (let i = 0; i < 3; i += 1) {
    const L = LIGHTS[i]
    const d = n[0] * L[0][0] + n[1] * L[0][1] + n[2] * L[0][2]
    if (d <= 0) continue
    const vx = eye[0] - cx
    const vy = eye[1] - cy
    const vz = eye[2] - cz
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1
    let hx = L[0][0] + vx / vl
    let hy = L[0][1] + vy / vl
    let hz = L[0][2] + vz / vl
    const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1
    hx /= hl; hy /= hl; hz /= hl
    const ndh = n[0] * hx + n[1] * hy + n[2] * hz
    if (ndh <= 0) continue
    const s = Math.pow(ndh, m.shine) * m.spec * L[2]
    if (s > best) best = s
  }
  return best > 1 ? 1 : best
}

// ── per-mesh cache: topology (silhouette), tints, shadow footprints ─────────
// All three depend on the mesh, not the camera, so they are built once.
const MESH_CACHE = new WeakMap()

function meshData(mesh) {
  let d = MESH_CACHE.get(mesh)
  if (d) return d

  // tints: one filament colour per printed node, in declaration order
  const tints = new Map()
  let n = 0
  for (const t of mesh) {
    if (t.mat !== 'shell' || !t.node || tints.has(t.node)) continue
    tints.set(t.node, FILAMENT[n % FILAMENT.length])
    n += 1
  }

  // topology: which two triangles share each edge — the silhouette pass only
  // has to ask "does this edge cross front/back", two array lookups.
  const q = (p) => `${Math.round(p[0] * 40)}|${Math.round(p[1] * 40)}|${Math.round(p[2] * 40)}`
  const keys = new Map()
  const edgeList = []
  for (let i = 0; i < mesh.length; i += 1) {
    const t = mesh[i]
    const ks = [q(t.pts[0]), q(t.pts[1]), q(t.pts[2])]
    for (let e = 0; e < 3; e += 1) {
      const j = (e + 1) % 3
      const ka = ks[e] < ks[j] ? ks[e] + '>' + ks[j] : ks[j] + '>' + ks[e]
      const idx = keys.get(ka)
      if (idx === undefined) {
        keys.set(ka, edgeList.length)
        edgeList.push({ i, j: -1, e })
      } else if (edgeList[idx].j === -1) {
        edgeList[idx].j = i
      } else {
        edgeList[idx].multi = true
      }
    }
  }

  // corner normals: averaged across the faces that meet at a vertex, but only
  // within a crease angle — a box keeps its hard edges, a cylinder goes smooth.
  // Cached because it is model-space, not camera-space.
  const cornerN = new Float32Array(mesh.length * 9)
  const faceN = new Float32Array(mesh.length * 3)
  for (let i = 0; i < mesh.length; i += 1) {
    const p0 = mesh[i].pts[0]
    const p1 = mesh[i].pts[1]
    const p2 = mesh[i].pts[2]
    const ux = p1[0] - p0[0]
    const uy = p1[1] - p0[1]
    const uz = p1[2] - p0[2]
    const vx = p2[0] - p0[0]
    const vy = p2[1] - p0[1]
    const vz = p2[2] - p0[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    faceN[i * 3] = nx / l
    faceN[i * 3 + 1] = ny / l
    faceN[i * 3 + 2] = nz / l
  }
  const incident = new Map()
  for (let i = 0; i < mesh.length; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = q(mesh[i].pts[k])
      let list = incident.get(key)
      if (!list) { list = []; incident.set(key, list) }
      list.push(i)
    }
  }
  const CREASE = Math.cos((42 * Math.PI) / 180)
  for (let i = 0; i < mesh.length; i += 1) {
    const fn = [faceN[i * 3], faceN[i * 3 + 1], faceN[i * 3 + 2]]
    for (let k = 0; k < 3; k += 1) {
      const list = incident.get(q(mesh[i].pts[k]))
      let ax = 0
      let ay = 0
      let az = 0
      for (const j of list) {
        const ox = faceN[j * 3]
        const oy = faceN[j * 3 + 1]
        const oz = faceN[j * 3 + 2]
        if (fn[0] * ox + fn[1] * oy + fn[2] * oz < CREASE) continue
        ax += ox; ay += oy; az += oz
      }
      const l = Math.sqrt(ax * ax + ay * ay + az * az)
      if (l < 1e-6) { ax = fn[0]; ay = fn[1]; az = fn[2] } else { ax /= l; ay /= l; az /= l }
      cornerN[i * 9 + k * 3] = ax
      cornerN[i * 9 + k * 3 + 1] = ay
      cornerN[i * 9 + k * 3 + 2] = az
    }
  }

  // shadow footprints: 34 mm world buckets, so a cast shadow costs ~60 polys
  const buckets = new Map()
  for (const t of mesh) {
    for (const p of t.pts) {
      const key = Math.round(p[0] / 34) * 100003 + Math.round(p[1] / 34)
      let bb = buckets.get(key)
      if (!bb) { bb = [p[0], p[1], p[2], p[0], p[1], p[2]]; buckets.set(key, bb) }
      if (p[2] < bb[2]) bb[2] = p[2]
      if (p[2] > bb[5]) bb[5] = p[2]
      if (p[0] < bb[0]) bb[0] = p[0]
      if (p[0] > bb[3]) bb[3] = p[0]
      if (p[1] < bb[1]) bb[1] = p[1]
      if (p[1] > bb[4]) bb[4] = p[1]
    }
  }

  d = { tints, edgeList, buckets: [...buckets.values()], cornerN }
  MESH_CACHE.set(mesh, d)
  return d
}

// ── scratch layers (shadow + reflection), reused across frames ───────────────
// Both render below display resolution and are scaled up on composite: a
// blurred shadow and a faint reflection do not need full pixels, and this keeps
// a 5k-triangle orbit well inside a frame budget.
const LAYERS = { shadow: null, reflect: null }

function layer(name, w, h, scale) {
  let cv = LAYERS[name]
  if (!cv) {
    cv = document.createElement('canvas')
    LAYERS[name] = cv
  }
  const W = Math.max(1, Math.round(w * scale))
  const H = Math.max(1, Math.round(h * scale))
  if (cv.width !== W || cv.height !== H) {
    cv.width = W
    cv.height = H
  }
  const g = cv.getContext('2d')
  g.setTransform(scale, 0, 0, scale, 0, 0)
  g.clearRect(0, 0, w, h)
  return { cv, g }
}

/** Sun direction the shadow is cast along (opposite the key light). */
const SHADOW_DIR = norm3([-0.46, 0.50, -0.72])

function floorPoint(p) {
  // slide the point along the shadow ray until z = 0
  if (p[2] <= 0.01) return [p[0], p[1], 0]
  const t = p[2] / -SHADOW_DIR[2]
  return [p[0] + SHADOW_DIR[0] * t, p[1] + SHADOW_DIR[1] * t, 0]
}

function hull2(pts) {
  const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop()
    lower.push(pt)
  }
  const upper = []
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const pt = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop()
    upper.push(pt)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

function drawScene(canvas, mesh, cam, target, opts) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const g = canvas.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  const PROF = globalThis.__rfProf
  const mark = (label) => { if (PROF) PROF.push([label, Math.round(performance.now() - t0)]) }
  const t0 = performance.now()

  // backdrop: a photo studio wall, dark at the edges, lit behind the machine
  const bg = g.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#0b1016')
  bg.addColorStop(0.52, '#141c25')
  bg.addColorStop(1, '#070a0d')
  g.fillStyle = bg
  g.fillRect(0, 0, w, h)
  const glow = g.createRadialGradient(w * 0.54, h * 0.34, 20, w * 0.54, h * 0.42, Math.max(w, h) * 0.72)
  glow.addColorStop(0, 'rgba(74,110,140,0.30)')
  glow.addColorStop(0.45, 'rgba(38,58,78,0.14)')
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = glow
  g.fillRect(0, 0, w, h)

  mark('bg')
  cam._basis = camBasis(cam, target)
  const eye = cam._basis.eye
  const data = mesh.length ? meshData(mesh) : null

  // ── colours: filament tint by node order, so printed links are multicolour ─
  const tints = data && opts.colour !== false ? data.tints : null

  // ── triangles: project, cull, sort far→near, fill ───────────────────────
  const faces = []
  const facingArr = new Uint8Array(mesh.length)
  for (let i = 0; i < mesh.length; i += 1) {
    const t = mesh[i]
    const a = t.pts[0]
    const b = t.pts[1]
    const c = t.pts[2]
    const pa = project(a, cam, target, w, h)
    const pb = project(b, cam, target, w, h)
    const pc = project(c, cam, target, w, h)
    if (pa.depth < 2 || pb.depth < 2 || pc.depth < 2) continue
    const ux = b[0] - a[0]
    const uy = b[1] - a[1]
    const uz = b[2] - a[2]
    const vx = c[0] - a[0]
    const vy = c[1] - a[1]
    const vz = c[2] - a[2]
    let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1
    n = [n[0] / len, n[1] / len, n[2] / len]
    const cx = (a[0] + b[0] + c[0]) / 3
    const cy = (a[1] + b[1] + c[1]) / 3
    const cz = (a[2] + b[2] + c[2]) / 3
    const facing = n[0] * (eye[0] - cx) + n[1] * (eye[1] - cy) + n[2] * (eye[2] - cz)
    // two-sided: flip the normal toward the eye so back faces are not black
    if (facing < 0) n = [-n[0], -n[1], -n[2]]
    facingArr[i] = facing > 0 ? 1 : 0
    const m = materialFor(t, tints ? tints.get(t.node) : null)
    faces.push({
      pa, pb, pc, a, b, c, n, m, facing, i, cx, cy, cz,
      depth: (pa.depth + pb.depth + pc.depth) / 3,
      area: Math.abs((pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)) * 0.5,
    })
  }
  mark('project')
  faces.sort((p, q) => q.depth - p.depth)

  // ── scene bounds + stage ────────────────────────────────────────────────
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  let span = 0
  const centre = [0, 0]
  if (mesh.length) {
    for (const t of mesh) for (const p of t.pts) {
      const r2 = p[0] * p[0] + p[1] * p[1]
      if (r2 > span) span = r2
      for (let i = 0; i < 3; i += 1) {
        if (p[i] < lo[i]) lo[i] = p[i]
        if (p[i] > hi[i]) hi[i] = p[i]
      }
    }
    centre[0] = (lo[0] + hi[0]) / 2
    centre[1] = (lo[1] + hi[1]) / 2
  }
  const discR = Math.max(70, Math.sqrt(span) * 1.16)

  // ground grid at z=0, faded with distance so it never fights the machine
  if (opts.grid) {
    const gridSpan = Math.max(620, discR * 2.4)
    const step = gridSpan > 900 ? 100 : 50
    g.lineWidth = 1
    for (let i = -gridSpan; i <= gridSpan; i += step) {
      const major = i % (step * 4) === 0
      const a = project([centre[0] + i, centre[1] - gridSpan, 0], cam, target, w, h)
      const b = project([centre[0] + i, centre[1] + gridSpan, 0], cam, target, w, h)
      const c = project([centre[0] - gridSpan, centre[1] + i, 0], cam, target, w, h)
      const dd = project([centre[0] + gridSpan, centre[1] + i, 0], cam, target, w, h)
      g.strokeStyle = major ? 'rgba(104,146,176,0.20)' : 'rgba(96,132,156,0.075)'
      if (a.depth > 1 && b.depth > 1) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }
      if (c.depth > 1 && dd.depth > 1) { g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(dd.x, dd.y); g.stroke() }
    }
  }

  const ringPoint = (r, a) => project([centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r, 0], cam, target, w, h)
  const ring = []
  for (let i = 0; i < 56; i += 1) {
    const pt = ringPoint(discR, (i / 56) * Math.PI * 2)
    if (pt.depth < 2) { ring.length = 0; break }
    ring.push(pt)
  }
  const c0 = project([centre[0], centre[1], 0], cam, target, w, h)
  let stageR = 0
  if (ring.length && c0.depth > 1) {
    const edge = project([centre[0] + discR, centre[1], 0], cam, target, w, h)
    stageR = Math.max(40, Math.hypot(edge.x - c0.x, edge.y - c0.y))
    g.save()
    g.beginPath()
    g.moveTo(ring[0].x, ring[0].y)
    for (const pt of ring) g.lineTo(pt.x, pt.y)
    g.closePath()
    const disc = g.createRadialGradient(c0.x - stageR * 0.22, c0.y - stageR * 0.3, stageR * 0.04, c0.x, c0.y, stageR)
    disc.addColorStop(0, '#2b3946')
    disc.addColorStop(0.55, '#1a242e')
    disc.addColorStop(1, '#0b1116')
    g.fillStyle = disc
    g.fill()

    // a soft sheen across the plate — the studio softbox landing on it
    g.save()
    g.clip()
    const sheen = g.createLinearGradient(c0.x - stageR, c0.y - stageR * 0.5, c0.x + stageR * 0.7, c0.y + stageR * 0.4)
    sheen.addColorStop(0, 'rgba(150,186,214,0.16)')
    sheen.addColorStop(0.5, 'rgba(120,160,190,0.05)')
    sheen.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = sheen
    g.fillRect(c0.x - stageR, c0.y - stageR, stageR * 2, stageR * 2)

    mark('plate')
    // ── reflection: the silhouette, flipped about the contact line ─────────
    // A real mirrored pass would re-project every vertex; flipping the faces we
    // already projected is the same picture at a third of the cost, and at 32%
    // opacity the difference is not visible on a matte plate.
    if (opts.reflect !== false && !opts.wire && faces.length < 14000) {
      const refl = layer('reflect', w, h, 0.35)
      const rg = refl.g
      const axis = c0.y
      rg.fillStyle = 'rgba(150,168,186,0.6)'
      for (const f of faces) {
        if (!f.facing || f.area < 4) continue
        rg.beginPath()
        rg.moveTo(f.pa.x, axis * 2 - f.pa.y)
        rg.lineTo(f.pb.x, axis * 2 - f.pb.y)
        rg.lineTo(f.pc.x, axis * 2 - f.pc.y)
        rg.closePath()
        rg.fill()
      }
      rg.globalCompositeOperation = 'destination-in'
      const fade = rg.createLinearGradient(0, axis - stageR * 0.1, 0, axis + stageR * 0.9)
      fade.addColorStop(0, 'rgba(0,0,0,0.9)')
      fade.addColorStop(0.4, 'rgba(0,0,0,0.28)')
      fade.addColorStop(1, 'rgba(0,0,0,0)')
      rg.fillStyle = fade
      rg.fillRect(0, 0, w, h)
      rg.globalCompositeOperation = 'source-over'
      g.globalAlpha = 0.34
      g.drawImage(refl.cv, 0, 0, w, h)
      g.globalAlpha = 1
    }

    mark('reflect')
    // ── cast shadow: cached world footprints slid along the key ray ────────
    if (!opts.wire && data) {
      const sh = layer('shadow', w, h, 0.12)
      const sg = sh.g
      sg.fillStyle = 'rgba(3,6,9,0.9)'
      sg.beginPath()
      const tmp = [0, 0, 0]
      for (const bb of data.buckets) {
        const corners = []
        for (let ix = 0; ix < 2; ix += 1) for (let iy = 0; iy < 2; iy += 1) for (let iz = 0; iz < 2; iz += 1) {
          const sp = floorPoint([ix ? bb[3] : bb[0], iy ? bb[4] : bb[1], iz ? bb[5] : bb[2]], tmp)
          const fp = project([sp[0], sp[1], 0], cam, target, w, h)
          corners.push([fp.x, fp.y])
        }
        const poly = hull2(corners)
        if (poly.length < 3) continue
        sg.moveTo(poly[0][0], poly[0][1])
        for (const pt of poly) sg.lineTo(pt[0], pt[1])
        sg.closePath()
      }
      sg.fill()
      // the hull is drawn at one-eighth scale and blown back up: one composite,
      // and an eight-pixel penumbra for free
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.globalAlpha = 0.7
      g.drawImage(sh.cv, 0, 0, w, h)
      g.globalAlpha = 1
    }

    mark('shadow')
    // contact darkening right under the machine
    const cs = g.createRadialGradient(c0.x, c0.y, 2, c0.x, c0.y, stageR * 0.7)
    cs.addColorStop(0, 'rgba(0,0,0,0.55)')
    cs.addColorStop(0.55, 'rgba(0,0,0,0.22)')
    cs.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = cs
    g.beginPath()
    g.ellipse(c0.x, c0.y, stageR * 0.72, stageR * 0.4, 0, 0, Math.PI * 2)
    g.fill()
    g.restore()

    // rim light on the plate edge
    g.beginPath()
    g.moveTo(ring[0].x, ring[0].y)
    for (const pt of ring) g.lineTo(pt.x, pt.y)
    g.closePath()
    g.strokeStyle = 'rgba(120,190,225,0.28)'
    g.lineWidth = 1.4
    g.stroke()
  }

  mark('stage')

  const wire = opts.wire
  // Two-pass painter: every back-facing triangle first, then every front-facing
  // one, each far→near. A single depth sort lets a long panel's centroid land
  // behind the parts it encloses, which is what makes a solid shell read as
  // glass; splitting the passes makes an enclosing shell always cover its own
  // interior.
  const order = wire ? faces : faces.filter((f) => !f.facing).concat(faces.filter((f) => f.facing))
  for (const f of order) {
    if (!wire && f.area < 0.7) continue // sub-pixel triangles cost a fill and show nothing
    g.beginPath()
    g.moveTo(f.pa.x, f.pa.y)
    g.lineTo(f.pb.x, f.pb.y)
    g.lineTo(f.pc.x, f.pc.y)
    g.closePath()
    if (wire) {
      g.strokeStyle = 'rgba(150,206,230,0.55)'
      g.lineWidth = 0.8
      g.stroke()
      continue
    }
    const cx = (f.a[0] + f.b[0] + f.c[0]) / 3
    const cy = (f.a[1] + f.b[1] + f.c[1]) / 3
    const cz = (f.a[2] + f.b[2] + f.c[2]) / 3
    const specTerm = specularFor(f.n, cx, cy, cz, eye, f.m)
    const vx = eye[0] - cx
    const vy = eye[1] - cy
    const vz = eye[2] - cz
    const sgn = f.facing < 0 ? -1 : 1
    const cn = data ? data.cornerN : null
    const n0 = cn ? [cn[f.i * 9] * sgn, cn[f.i * 9 + 1] * sgn, cn[f.i * 9 + 2] * sgn] : f.n
    const n1 = cn ? [cn[f.i * 9 + 3] * sgn, cn[f.i * 9 + 4] * sgn, cn[f.i * 9 + 5] * sgn] : f.n
    const n2 = cn ? [cn[f.i * 9 + 6] * sgn, cn[f.i * 9 + 7] * sgn, cn[f.i * 9 + 8] * sgn] : f.n
    if (f.area > (opts.flat ? 1e9 : 260)) {
      // per-vertex radiance → a linear gradient across the face: this is what
      // makes a cylinder look round and a flat panel look printed, not pasted
      const ca = shadeNormal(n0, vx, vy, vz, f.m, specTerm)
      const cb = shadeNormal(n1, vx, vy, vz, f.m, specTerm)
      const cc = shadeNormal(n2, vx, vy, vz, f.m, specTerm)
      const la = ca[0] * 0.3 + ca[1] * 0.56 + ca[2] * 0.14
      const lb = cb[0] * 0.3 + cb[1] * 0.56 + cb[2] * 0.14
      const lc = cc[0] * 0.3 + cc[1] * 0.56 + cc[2] * 0.14
      let hi = f.pa
      let hc = ca
      let hiL = la
      let loP = f.pa
      let loC = ca
      let loL = la
      if (lb > hiL) { hi = f.pb; hc = cb; hiL = lb }
      if (lc > hiL) { hi = f.pc; hc = cc; hiL = lc }
      if (lb < loL) { loP = f.pb; loC = cb; loL = lb }
      if (lc < loL) { loP = f.pc; loC = cc; loL = lc }
      const grad = g.createLinearGradient(hi.x, hi.y, loP.x, loP.y)
      const mid = [Math.min(255, (hc[0] + loC[0]) / 2), Math.min(255, (hc[1] + loC[1]) / 2), Math.min(255, (hc[2] + loC[2]) / 2)]
      grad.addColorStop(0, css(hc))
      grad.addColorStop(0.55, css(mid))
      grad.addColorStop(1, css(loC))
      g.fillStyle = grad
      g.strokeStyle = grad
    } else {
      const col = shadeNormal(f.n, vx, vy, vz, f.m, specTerm)
      g.fillStyle = css(col)
      g.strokeStyle = g.fillStyle
    }
    g.fill()
    // same-colour hairline closes antialiasing seams between faces
    g.lineWidth = 0.7
    g.stroke()
  }

  mark('fill')
  // ── silhouette: one dark pass over the outline makes the machine crisp ───
  if (opts.outline !== false && !wire && data && faces.length) {
    g.lineWidth = 1.1
    g.strokeStyle = 'rgba(6,10,13,0.5)'
    g.beginPath()
    for (const e of data.edgeList) {
      if (e.j < 0 || e.multi) continue
      if (facingArr[e.i] === facingArr[e.j]) continue // only a true outline crosses front/back
      const t = mesh[e.i]
      const a = project(t.pts[e.e], cam, target, w, h)
      const b = project(t.pts[(e.e + 1) % 3], cam, target, w, h)
      if (a.depth < 2 || b.depth < 2) continue
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
    }
    g.stroke()
  }

  mark('outline')
  // dimension lines on the bounding box
  if (opts.dims && mesh.length) {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const t of mesh) for (const p of t.pts) for (let i = 0; i < 3; i += 1) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
    const edges = [
      [[min[0], min[1], 0], [max[0], min[1], 0], `${Math.round(max[0] - min[0])}mm`],
      [[min[0], min[1], 0], [min[0], max[1], 0], `${Math.round(max[1] - min[1])}mm`],
      [[min[0], min[1], 0], [min[0], min[1], max[2]], `${Math.round(max[2])}mm`],
    ]
    g.setLineDash([4, 4])
    g.lineWidth = 1
    for (const [p, qq, label] of edges) {
      const a = project(p, cam, target, w, h)
      const b = project(qq, cam, target, w, h)
      if (a.depth < 2 || b.depth < 2) continue
      g.strokeStyle = 'rgba(57,211,232,0.75)'
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
      g.setLineDash([])
      const lx = (a.x + b.x) / 2 + 8
      const ly = (a.y + b.y) / 2 - 6
      g.font = '500 10px ui-monospace, monospace'
      const tw = g.measureText(label).width
      g.fillStyle = 'rgba(8,12,16,0.82)'
      g.fillRect(lx - 3, ly - 10, tw + 6, 13)
      g.fillStyle = 'rgba(57,211,232,0.95)'
      g.fillText(label, lx, ly)
      g.setLineDash([4, 4])
    }
    g.setLineDash([])
  }

  // axis gizmo, bottom-left
  const ox = 46
  const oy = h - 40
  const axes = [
    [[1, 0, 0], '#FF6A1A', 'X'],
    [[0, 1, 0], '#4ED08A', 'Y'],
    [[0, 0, 1], '#39D3E8', 'Z'],
  ]
  g.font = '600 10px ui-monospace, monospace'
  for (const [dir, color, label] of axes) {
    const b = cam._basis
    const sx = (dir[0] * b.x[0] + dir[1] * b.x[1]) * 22
    const syv = (dir[0] * b.y[0] + dir[1] * b.y[1] + dir[2] * b.y[2]) * 22
    g.strokeStyle = color
    g.lineWidth = 1.6
    g.beginPath()
    g.moveTo(ox, oy)
    g.lineTo(ox + sx, oy - syv)
    g.stroke()
    g.fillStyle = color
    g.fillText(label, ox + sx * 1.25 - 3, oy - syv * 1.25 + 3)
  }

  // vignette: keeps the eye on the machine
  const vg = g.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.32, w * 0.5, h * 0.5, Math.max(w, h) * 0.78)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.42)')
  g.fillStyle = vg
  g.fillRect(0, 0, w, h)
}

/** Orbitable viewport. Pure presentational: all state lives in the page. */
function Viewport({ mesh, cam, setCam, opts, design, analysis }) {
  const ref = useRef(null)
  const target = useMemo(() => {
    if (!mesh.length) return [0, 0, 120]
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const t of mesh) for (const p of t.pts) for (let i = 0; i < 3; i += 1) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  }, [mesh])

  useEffect(() => {
    const cv = ref.current
    if (!cv) return undefined
    let raf = 0
    const paint = () => {
      raf = 0
      drawScene(cv, mesh, cam, target, opts)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint)
    }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(cv)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [mesh, cam, target, opts])

  const drag = useRef(null)

  const onDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    setCam({
      ...cam,
      yaw: d.yaw - dx * 0.008,
      pitch: clamp(d.pitch + dy * 0.006, -0.2, 1.45),
    })
  }
  const onUp = () => {
    drag.current = null
  }
  const onWheel = (e) => {
    e.preventDefault()
    setCam({ ...cam, dist: clamp(cam.dist * (1 + Math.sign(e.deltaY) * 0.12), 180, 4200) })
  }

  const dims = analysis ? analysis.dims.map((d) => Math.round(d)) : [0, 0, 0]

  return h('div', { style: S.viewWrap },
    h('canvas', {
      ref,
      style: S.canvas,
      onPointerDown: onDown,
      onPointerMove: onMove,
      onPointerUp: onUp,
      onPointerCancel: onUp,
      onWheel,
    }),
    // corner HUD
    h('div', { style: S.hudTL },
      h('div', { style: S.hudRow }, h('span', { style: S.hudKey }, 'DIMS'), h('span', { style: S.hudVal }, `${dims.join(' × ')} mm`)),
      h('div', { style: S.hudRow }, h('span', { style: S.hudKey }, 'MASS'), h('span', { style: S.hudVal }, `${Math.round(analysis?.mass.totalG || 0)} g`)),
      h('div', { style: S.hudRow }, h('span', { style: S.hudKey }, 'TRIS'), h('span', { style: S.hudVal }, String(mesh.length))),
    ),
    h('div', { style: S.hudTR }, h('span', { style: S.hudHint }, 'drag to orbit · scroll to zoom')),
    h('div', { style: S.viewTitle }, design.title, h('span', { style: S.viewSub }, ' — ', design.subtitle)),
  )
}
