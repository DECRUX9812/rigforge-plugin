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
// ── colour management ───────────────────────────────────────────────────────
// Everything below works in linear light and is encoded to sRGB only at the
// last moment. Shading sRGB numbers directly is what makes a render look like
// an old game instead of a photograph: the darks collapse and the highlights
// clip.
const srgbToLin = (c) => {
  const v = c <= 1 ? c : c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const EXPOSURE = 0.92
/** linear radiance → 0-255 sRGB, through an ACES-ish filmic curve. */
function encode8(x) {
  const v = x * EXPOSURE
  const t = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)
  const g = t <= 0.0031308 ? t * 12.92 : 1.055 * Math.pow(t, 1 / 2.4) - 0.055
  return (g < 0 ? 0 : g > 1 ? 1 : g) * 255 | 0
}
const L = (r, g, b) => [srgbToLin(r), srgbToLin(g), srgbToLin(b)]

// ── materials ───────────────────────────────────────────────────────────────
// albedo is stored LINEAR (converted once at load). spec = highlight strength,
// shine = highlight tightness, metal = albedo tints the reflection and the
// highlight (0 plastic, 1 metal), glow = self-lit.
const MAT = {
  shell: { alb: L(234, 229, 218), spec: 0.22, shine: 26, metal: 0.0, glow: 0, rough: 0.62 },
  accent: { alb: L(255, 118, 28), spec: 0.30, shine: 34, metal: 0.0, glow: 0, rough: 0.55 },
  metal: { alb: L(206, 214, 222), spec: 0.85, shine: 70, metal: 0.92, glow: 0, rough: 0.24 },
  steel: { alb: L(150, 164, 178), spec: 0.75, shine: 60, metal: 1.0, glow: 0, rough: 0.3 },
  brass: { alb: L(226, 182, 96), spec: 0.8, shine: 64, metal: 1.0, glow: 0, rough: 0.28 },
  pcb: { alb: L(26, 112, 82), spec: 0.25, shine: 44, metal: 0.0, glow: 0.05, rough: 0.5 },
  rubber: { alb: L(38, 41, 46), spec: 0.06, shine: 12, metal: 0.0, glow: 0, rough: 0.9 },
  glass: { alb: L(128, 226, 246), spec: 0.9, shine: 96, metal: 0.1, glow: 0.18, rough: 0.12 },
  servo: { alb: L(60, 72, 98), spec: 0.34, shine: 40, metal: 0.15, glow: 0, rough: 0.45 },
  belt: { alb: L(48, 50, 56), spec: 0.09, shine: 16, metal: 0.0, glow: 0, rough: 0.85 },
}

// Multi-colour print: printed shell parts take a filament colour by node order,
// so a machine reads as an assembled multi-material build — the maker look.
const FILAMENT = [
  L(226, 74, 46), // vermilion
  L(38, 152, 142), // teal
  L(232, 178, 58), // amber
  L(124, 96, 190), // violet
  L(58, 108, 184), // cobalt
  L(228, 236, 232), // white
  L(198, 148, 88), // copper
  L(96, 176, 96), // leaf
]

// three-point studio rig: [direction toward the light, colour, intensity]
const LIGHTS = [
  [norm3([0.46, -0.50, 0.72]), L(255, 244, 230), 1.38], // warm key, upper front-left
  [norm3([-0.66, -0.14, 0.26]), L(120, 170, 255), 0.42], // cool fill, left rear
  [norm3([0.05, 0.66, 0.34]), L(150, 226, 255), 0.46], // cyan rim, behind
]
const SKY = [0.13, 0.16, 0.22]
const GROUND = [0.035, 0.04, 0.05]
const SHADOW_DIR = norm3([-0.46, 0.5, -0.72]) // opposite the key light

function norm3(v) {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * The studio the parts reflect. No HDRI file to ship: two softboxes over a dim
 * room, sampled by direction. This is the term that turns dead grey metal into
 * brushed aluminium — a metal is mostly the room it sits in.
 */
function envAt(dx, dy, dz) {
  let r = 0.07
  let g = 0.085
  let b = 0.115
  const up = dz > 0 ? dz : 0
  r += 0.13 * up
  g += 0.17 * up
  b += 0.24 * up
  // broad warm softbox, upper front-left (integer powers: Math.pow is slow here)
  const kd = dx * 0.42 + dy * -0.52 + dz * 0.74
  if (kd > 0) {
    const k2 = kd * kd
    const k = k2 * k2 * kd * 2.3
    r += k
    g += k * 0.95
    b += k * 0.86
  }
  // narrow cool strip, rear-right
  const cd = dx * -0.55 + dy * 0.62 + dz * 0.18
  if (cd > 0) {
    const c3 = cd * cd * cd
    const k = c3 * c3 * cd * 1.9
    r += k * 0.5
    g += k * 0.75
    b += k
  }
  // floor bounce
  const dn = dz < 0 ? -dz : 0
  r += dn * 0.02
  g += dn * 0.018
  b += dn * 0.016
  return [r, g, b]
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
  const rel0 = p[0] - b.eye[0]
  const rel1 = p[1] - b.eye[1]
  const rel2 = p[2] - b.eye[2]
  const vx = rel0 * b.x[0] + rel1 * b.x[1]
  const vy = rel0 * b.y[0] + rel1 * b.y[1] + rel2 * b.y[2]
  const depth = -(rel0 * b.back[0] + rel1 * b.back[1] + rel2 * b.back[2])
  const f = ((w < h ? w : h) * 0.9) / (cam.dist > 1 ? cam.dist : 1)
  const s = cam.ortho ? f : f * (cam.dist / (depth > 1 ? depth : 1))
  return { x: w / 2 + vx * s, y: h / 2 - vy * s, depth }
}

/** Material for a triangle, with the multicolour-print tint applied to shells. */
function materialFor(t, tint) {
  const m = MAT[t.mat] || MAT.shell
  if (!tint || t.mat !== 'shell') return m
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
    rough: m.rough,
  }
}

/**
 * Linear radiance for one normal, seen from one view vector, at one occlusion
 * value. Directional lights, so the only per-vertex inputs are the normal, the
 * view vector and the baked AO — which is what turns a faceted cylinder into a
 * smooth one and keeps a crevice dark.
 */
function shadeNormal(n, vx, vy, vz, m, specTerm, ao) {
  const alb = m.alb
  const up = 0.5 + 0.5 * n[2]
  const sky = SKY[0] * up * 0.9 + GROUND[0] * (1 - up) * 1.6
  const amb = sky * (0.34 + 0.66 * ao)
  let r = alb[0] * amb
  let gg = alb[1] * amb
  let b = alb[2] * amb

  for (let i = 0; i < 3; i += 1) {
    const Lt = LIGHTS[i]
    const d = n[0] * Lt[0][0] + n[1] * Lt[0][1] + n[2] * Lt[0][2]
    if (d <= 0) continue
    // half-lambert lift keeps the shadow side from going flat black
    const k = (d * 0.86 + 0.14) * Lt[2] * 0.55 * (0.55 + 0.45 * ao)
    r += alb[0] * k * Lt[1][0]
    gg += alb[1] * k * Lt[1][1]
    b += alb[2] * k * Lt[1][2]
  }

  const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1
  const nx = vx / vlen
  const ny = vy / vlen
  const nz = vz / vlen

  // Schlick fresnel: grazing angles mirror the room, dead-on they do not
  let ndv = n[0] * nx + n[1] * ny + n[2] * nz
  if (ndv < 0) ndv = -ndv
  const f = 1 - ndv
  const f2 = f * f
  const fres = f2 * f2 * f * 0.9 + 0.05

  // reflection vector, sampled against the procedural studio
  const dnv = 2 * (n[0] * nx + n[1] * ny + n[2] * nz)
  const rx = dnv * n[0] - nx
  const ry = dnv * n[1] - ny
  const rz = dnv * n[2] - nz
  const env = envAt(rx, ry, rz)
  const mir = (m.metal || 0) > 0.4
  const kEnv = mir ? (0.55 + 0.45 * fres) : (0.16 + 0.55 * fres)
  if (mir) {
    r += env[0] * kEnv * alb[0] * 2.4
    gg += env[1] * kEnv * alb[1] * 2.4
    b += env[2] * kEnv * alb[2] * 2.4
  } else {
    r += env[0] * kEnv
    gg += env[1] * kEnv
    b += env[2] * kEnv
  }

  if (specTerm > 0) {
    const sr = specTerm * 2.6
    r += mir ? sr * alb[0] * 1.5 : sr
    gg += mir ? sr * alb[1] * 1.5 : sr
    b += mir ? sr * alb[2] * 1.5 : sr
  }

  if (m.glow) {
    r += m.glow * alb[0] * 0.8
    gg += m.glow * alb[1] * 0.8
    b += m.glow * alb[2] * 0.8
  }

  return [r, gg, b]
}

const css = (c, a) => (a == null
  ? `rgb(${encode8(c[0])},${encode8(c[1])},${encode8(c[2])})`
  : `rgba(${encode8(c[0])},${encode8(c[1])},${encode8(c[2])},${a})`)

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

function bakeAO(mesh) {
  // baked ambient occlusion: voxelise the assembly, score every voxel by how
  // much of its neighbourhood is empty, read it back per vertex corner. Cached
  // per mesh, so the per-frame cost is one array lookup per vertex.
  const cornerAO = new Float32Array(mesh.length * 3).fill(1)
  if (mesh.length > 8) {
    let lox = Infinity; let loy = Infinity; let loz = Infinity
    let hix = -Infinity; let hiy = -Infinity; let hiz = -Infinity
    for (const t of mesh) {
      for (const p of t.pts) {
        if (p[0] < lox) lox = p[0]
        if (p[0] > hix) hix = p[0]
        if (p[1] < loy) loy = p[1]
        if (p[1] > hiy) hiy = p[1]
        if (p[2] < loz) loz = p[2]
        if (p[2] > hiz) hiz = p[2]
      }
    }
    const span = Math.max(hix - lox, hiy - loy, hiz - loz, 1)
    const step = span / 42
    const nx = Math.ceil((hix - lox) / step) + 1
    const ny = Math.ceil((hiy - loy) / step) + 1
    const nz = Math.ceil((hiz - loz) / step) + 1
    const occ = new Float32Array(nx * ny * nz)
    const mark = (x, y, z) => {
      const ix = Math.round((x - lox) / step)
      const iy = Math.round((y - loy) / step)
      const iz = Math.round((z - loz) / step)
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return
      occ[(iz * ny + iy) * nx + ix] = 1
    }
    const mid = (a, b, k) => a + (b - a) * k
    for (const t of mesh) {
      const [p0, p1, p2] = t.pts
      mark(p0[0], p0[1], p0[2]); mark(p1[0], p1[1], p1[2]); mark(p2[0], p2[1], p2[2])
      mark(mid(p0[0], p1[0], 0.5), mid(p0[1], p1[1], 0.5), mid(p0[2], p1[2], 0.5))
      mark(mid(p1[0], p2[0], 0.5), mid(p1[1], p2[1], 0.5), mid(p1[2], p2[2], 0.5))
      mark(mid(p0[0], p2[0], 0.5), mid(p0[1], p2[1], 0.5), mid(p0[2], p2[2], 0.5))
      mark((p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3)
    }
    // separable box filter, radius 3 → occupancy fraction in a 7³ window
    const R = 3
    const box = (src, axis) => {
      const out = new Float32Array(src.length)
      const dx = axis === 0 ? 1 : 0
      const dy = axis === 1 ? 1 : 0
      const dz = axis === 2 ? 1 : 0
      for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) {
        let sum = 0
        let n = 0
        for (let k = -R; k <= R; k += 1) {
          const xx = x + k * dx
          const yy = y + k * dy
          const zz = z + k * dz
          if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue
          sum += src[(zz * ny + yy) * nx + xx]
          n += 1
        }
        out[(z * ny + y) * nx + x] = sum / n
      }
      return out
    }
    let f1 = box(occ, 0)
    f1 = box(f1, 1)
    f1 = box(f1, 2)
    for (let i = 0; i < mesh.length; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        const p = mesh[i].pts[k]
        const ix = Math.round((p[0] - lox) / step)
        const iy = Math.round((p[1] - loy) / step)
        const iz = Math.round((p[2] - loz) / step)
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue
        const occFrac = f1[(iz * ny + iy) * nx + ix]
        const open = 1 - occFrac
        cornerAO[i * 3 + k] = Math.max(0, Math.min(1, (open - 0.34) / 0.36))
      }
    }
  }
  return cornerAO
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
  // ambient occlusion is baked once, on demand: thumbnails and the wire view
  // do not need it, and a page with seven thumbnails must not pay for seven bakes
  if (data && opts.ao !== false && !data.cornerAO) data.cornerAO = bakeAO(mesh)

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
  // Sort each pass by the NEAREST vertex, not the centroid. A long panel's
  // centroid can sit behind the parts it encloses; its nearest corner cannot,
  // so the shell always lands on top of its own interior.
  let order = faces
  if (!wire) {
    const back = faces.filter((f) => !f.facing).sort((p, q) => q.dmax - p.dmax)
    const front = faces.filter((f) => f.facing).sort((p, q) => q.dmin - p.dmin)
    order = back.concat(front)
  }
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
    const ca0 = data && opts.ao !== false ? data.cornerAO[f.i * 3] : 1
    const ca1 = data && opts.ao !== false ? data.cornerAO[f.i * 3 + 1] : 1
    const ca2 = data && opts.ao !== false ? data.cornerAO[f.i * 3 + 2] : 1
    if (f.area > (opts.flat ? 1e9 : 260)) {
      // per-vertex radiance → a linear gradient across the face: this is what
      // makes a cylinder look round and a flat panel look printed, not pasted
      const ca = shadeNormal(n0, vx, vy, vz, f.m, specTerm, ca0)
      const cb = shadeNormal(n1, vx, vy, vz, f.m, specTerm, ca1)
      const cc = shadeNormal(n2, vx, vy, vz, f.m, specTerm, ca2)
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
      const col = shadeNormal(f.n, vx, vy, vz, f.m, specTerm, (ca0 + ca1 + ca2) / 3)
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
  if (opts.gizmo === false) {
    // thumbnails: no gizmo, no vignette — the card carries the framing
  } else {
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
  }

  // vignette: keeps the eye on the machine
  const vg = g.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.32, w * 0.5, h * 0.5, Math.max(w, h) * 0.78)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.42)')
  g.fillStyle = vg
  g.fillRect(0, 0, w, h)
}

/** Orbitable viewport. Pure presentational: all state lives in the page. */
/** Drawing revision: a stable letter per design, so two builds are comparable. */
function revOf(design) {
  const key = `${design.archetype}|${design.title}|${design.brief ? design.brief.mission : ''}`
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 100003
  return String.fromCharCode(65 + (h % 26))
}

/** Drawing number: machine class, revision and a stable sheet number. */
function dwgNo(design) {
  const cls = { arm: 'ARM', rover: 'RVR', quadruped: 'QDP', humanoid: 'HUM', robot: 'RBT', gripper: 'GRP', gadget: 'GDG', iot: 'IOT', pcb: 'PCB', gantry: 'GAN' }[design.archetype] || 'MCH'
  const key = `${design.title}|${design.archetype}`
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 17 + key.charCodeAt(i)) % 997
  return `DWG ${cls}-${String(h).padStart(3, '0')}`
}

/** `coxa-fl` → `Coxa FL`: an id an engineer can read back in the parts table. */
// Ids are machine names ('upper-arm', 'jaw-b', 'pcb-mount'). Uppercasing every
// short word produced 'Upper ARM' and 'JAW B', which reads like shouting; only
// real acronyms and single letters stay upper.
const ACRONYMS = new Set(['pcb', 'led', 'ic', 'usb', 'imu', 'esc', 'stl', 'mcu', 'iot', 'rfid',
  'gpio', 'pwm', 'uart', 'spi', 'dof', 'psu', 'lipo', 'bldc', 'cnc', 'pla', 'petg', 'abs', 'soc', 'som'])
function humanNode(id) {
  const words = String(id).split(/[-_]/).filter(Boolean)
  if (!words.length) return String(id)
  return words
    .map((w) => {
      const low = w.toLowerCase()
      if (w.length === 1) return w.toUpperCase()
      if (ACRONYMS.has(low)) return low === 'dof' ? 'DoF' : low.toUpperCase()
      return w[0].toUpperCase() + w.slice(1)
    })
    .join(' ')
}

/** Model bounds in mm, for the GPU camera and the light frustum. */
function boundsOfMesh(mesh) {
  if (!mesh || !mesh.length) return { min: [-100, 0, -100], max: [100, 200, 100] }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const t of mesh) for (const p of t.pts) for (let i = 0; i < 3; i += 1) {
    if (p[i] < min[i]) min[i] = p[i]
    if (p[i] > max[i]) max[i] = p[i]
  }
  return { min, max }
}

/** What 1:1 would be on a sheet: the longest dimension against a 150mm field. */
function scaleOf(dims) {
  const longest = Math.max(...(dims || [1]))
  const n = Math.max(1, Math.round(longest / 150))
  return n === 1 ? '1:1' : `1:${n}`
}

function Viewport({ mesh, cam, setCam, opts, design, analysis, overlay, focus }) {
  const ref = useRef(null)
  const glRef = useRef(null)
  const paintRef = useRef(null)
  const fallback = useRef(false)
  const target = useMemo(() => {
    if (focus) return focus
    if (!mesh.length) return [0, 0, 120]
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const t of mesh) for (const p of t.pts) for (let i = 0; i < 3; i += 1) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  }, [mesh, focus])

  useEffect(() => {
    const cv = ref.current
    if (!cv) return undefined
    let raf = 0
    paintRef.current = null
    // GPU first: WebGL2 gives a shadow map, per-pixel roughness and MSAA, which
    // is the difference between a CAD preview and a product photograph. The 2D
    // canvas path stays as the fallback for a context the plugin cannot get.
    const paint = () => {
      raf = 0
      if (!fallback.current) {
        if (!glRef.current) glRef.current = createGLRenderer(cv)
        const r = glRef.current
        if (r && r.ok) {
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const w = cv.clientWidth
          const h = cv.clientHeight
          if (w && h && (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr))) {
            cv.width = Math.round(w * dpr)
            cv.height = Math.round(h * dpr)
          }
          const data = mesh.length ? meshData(mesh) : null
          const tints = data && opts.colour !== false ? data.tints : null
          // filament tints are 0-255 sRGB; mixing them into a linear albedo has
          // to happen in linear light or every printed part turns flat grey
          globalThis.__rfTints = tints ? tints.size : -1
          const matOf = (t) => {
            const m = MAT[t.mat] || MAT.shell
            if (picked && picked.node && t.node === picked.node) {
              return {
                alb: [Math.min(1, m.alb[0] * 1.25 + 0.10), Math.min(1, m.alb[1] * 1.2 + 0.08), Math.min(1, m.alb[2] * 1.15 + 0.06)],
                rough: m.rough, metal: m.metal, glow: 0.16, printed: true,
              }
            }
            const tint = tints && t.mat === 'shell' ? tints.get(t.node) : null
            if (!tint) return m
            const k = 0.82
            const tl = tint.map((c) => srgbToLin(c))
            return {
              alb: [
                m.alb[0] * (1 - k) + tl[0] * k,
                m.alb[1] * (1 - k) + tl[1] * k,
                m.alb[2] * (1 - k) + tl[2] * k,
              ],
              rough: m.rough, metal: m.metal, glow: m.glow, spec: m.spec, shine: m.shine, printed: true,
            }
          }
          r.draw(mesh, cam, opts, matOf, boundsOfMesh(mesh), overlay)
          return
        }
        fallback.current = true
      }
      drawScene(cv, mesh, cam, target, opts)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint)
    }
    paintRef.current = schedule
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(cv)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [mesh, cam, target, opts])

  // Occlusion is baked on idle, ~350 ms after the last change: the ray cast costs
  // a few hundred milliseconds on a real mesh, and dragging a joint has to stay
  // at frame rate. Until it lands the view is simply unoccluded.
  useEffect(() => {
    const cv = ref.current
    if (!cv || !mesh.length) return undefined
    let cancelled = false
    const run = () => {
      if (cancelled) return
      const gl = glRef.current
      if (!gl || !gl.ok) return
      const data = bakeVertexAO(mesh)
      if (!data) return
      gl.setAO(mesh, data)
      let mn = 1, mx = 0, sum = 0
      for (let i = 0; i < data.length; i += 1) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v }
      globalThis.__rfAOStats = { n: data.length, min: +mn.toFixed(2), max: +mx.toFixed(2), mean: +(sum / data.length).toFixed(2) }
      paintRef.current?.()
    }
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 800 })
      else run()
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mesh])

  const drag = useRef(null)
  const [picked, setPicked] = useState(null)

  const onDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, moved: 0, cx: e.clientX, cy: e.clientY }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.cx, e.clientY - d.cy))
    setCam({
      ...cam,
      yaw: d.yaw - dx * 0.008,
      pitch: clamp(d.pitch + dy * 0.006, -0.2, 1.45),
    })
  }
  const onUp = (e) => {
    const d = drag.current
    drag.current = null
    // a click, not a drag: pick the part under the pointer
    if (!d || d.moved > 5 || !glRef.current || !glRef.current.pick) return
    const cv = ref.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    const scaleX = cv.width / rect.width
    const scaleY = cv.height / rect.height
    const px = (e.clientX - rect.left) * scaleX
    const py = (e.clientY - rect.top) * scaleY
    const hit = glRef.current.pick(mesh, px, py)
    if (!hit) { setPicked(null); return }
    // clicking the same part again closes the inspector
    if (picked && picked.node && picked.node === hit.node) { setPicked(null); return }
    const node = design.nodes.find((n) => n.id === hit.node) || null
    if (!node) { setPicked({ label: hit.mat, sub: 'material', x: e.clientX - rect.left, y: e.clientY - rect.top }); return }
    const material = (analysis && analysis.print && analysis.print.material) || { name: 'PETG', density: 1.27 }
    // shellVolume is mm³; grams wants cm³ at the material density
    const grams = node.print ? Math.round((shellVolume(node) / 1000) * material.density) : 0
    setPicked({
      node: node.id,
      label: humanNode(node.id),
      sub: node.print ? `printed · ${material.name} · ${grams} g` : `modelled · ${node.mat}`,
      joint: node.joint || null,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }
  const onWheel = (e) => {
    e.preventDefault()
    setCam({ ...cam, dist: clamp(cam.dist * (1 + Math.sign(e.deltaY) * 0.12), 180, 4200) })
  }

  useEffect(() => {
    if (!picked) return undefined
    const onKey = (ev) => { if (ev.key === 'Escape') setPicked(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked])

  const dims = analysis ? analysis.dims.map((d) => Math.round(d)) : [0, 0, 0]

  return h('div', { style: S.viewWrap },
    h('canvas', {
      ref,
      // A canvas is a picture of a machine, not a widget: give it a name and a
      // description so a screen reader announces it instead of skipping it, and
      // say where the accessible controls live.
      role: 'img',
      'aria-label': `3D view of ${design.title}`,
      'aria-describedby': 'rf-view-desc',
      style: S.canvas,
      onPointerDown: onDown,
      onPointerMove: onMove,
      onPointerUp: onUp,
      onPointerCancel: onUp,
      onWheel,
    }),
    // corner HUD
    h('div', { style: S.hudTL, 'data-rf': 'hud' },
      h('div', { style: S.hudRow }, h('span', { style: S.hudKey }, 'DIMS'), h('span', { style: S.hudVal }, `${dims.join(' × ')} mm`)),
      h('div', { style: S.hudRow }, h('span', { style: S.hudKey }, 'MASS'), h('span', { style: S.hudVal }, `${Math.round(analysis?.mass.totalG || 0)} g`)),
      h('div', { style: S.hudRow }, h('span', { style: S.hudKey }, 'TRIS'), h('span', { style: S.hudVal }, String(mesh.length))),
    ),
    h('span', {
      id: 'rf-view-desc',
      style: {
        position: 'absolute', width: '1px', height: '1px', margin: '-1px',
        padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
      },
    }, `${design.subtitle}. Drag to orbit, scroll to zoom. Pose it with the joint sliders below the view.`),
    picked ? h('div', {
      style: { ...S.partChip, left: `${Math.min(picked.x + 14, 9999)}px`, top: `${Math.min(picked.y + 14, 9999)}px` },
      'data-rf': 'partchip',
    },
      h('div', { style: S.chipTitle }, picked.label),
      h('div', {}, picked.sub),
      picked.joint ? h('div', {}, `on joint ${picked.joint}`) : null,
      h('div', { style: S.chipHint }, 'click the part again to clear'),
    ) : null,
    h('div', { style: S.viewTitle, 'data-rf': 'viewtitle' }, design.title, h('span', { style: S.viewSub }, ' — ', design.subtitle)),
    // Drawing title block, bottom right: drawing number, revision, scale,
    // units and tolerance, material and the review state. This is what turns a
    // viewport into a sheet an engineer can hand to a client.
    h('div', { style: S.titleBlock, 'data-rf': 'titleblock' },
      h('div', { style: { ...S.tbHead, display: 'flex', justifyContent: 'space-between' } },
        h('span', {}, 'assembly drawing'),
        h('span', {}, dwgNo(design))),
      h('div', { style: S.tbName }, design.title),
      h('div', { style: S.tbRow }, h('span', { style: S.tbKey }, 'REV'), h('span', { style: S.tbVal }, revOf(design))),
      h('div', { style: S.tbRow }, h('span', { style: S.tbKey }, 'SHEET'), h('span', { style: S.tbVal }, '1/1')),
      h('div', { style: S.tbRow }, h('span', { style: S.tbKey }, 'SCALE'), h('span', { style: S.tbVal }, scaleOf(dims))),
      h('div', { style: S.tbRow }, h('span', { style: S.tbKey }, 'UNITS'), h('span', { style: S.tbVal }, 'mm · tol ±0.2')),
      h('div', { style: S.tbRow }, h('span', { style: S.tbKey }, 'MATERIAL'), h('span', { style: S.tbVal }, `${(analysis && analysis.print.material ? analysis.print.material.name : 'PETG')} (FDM)`)),
      h('div', { style: S.tbRow },
        h('span', { style: S.tbKey }, 'STATUS'),
        h('span', { style: { ...S.tbVal, color: (analysis && analysis.checks.some((c) => c.level === 'fail')) ? C.red : (analysis && analysis.checks.some((c) => c.level === 'warn')) ? C.amber : C.green } },
          analysis ? `${analysis.checks.length - analysis.checks.filter((c) => c.level !== 'ok').length} pass · ${analysis.checks.filter((c) => c.level !== 'ok').length} open` : '—')),
    ),
  )
}
