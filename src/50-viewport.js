// ── viewport: a software 3D renderer, because a CAD view cannot be a DIV ────
// Painter's algorithm on 2D canvas: sub-millisecond for these meshes, no
// WebGL context to lose, no three.js to ship. Flat shading + a ground grid is
// exactly the "engineering clay" look — and every triangle here is the same
// triangle the STL exporter writes.

const CAM0 = { yaw: -0.62, pitch: 0.42, dist: 900, ortho: false }

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
  const f = (Math.min(w, h) * 0.9) / Math.max(1, cam.dist)
  const s = cam.ortho ? f : f * (cam.dist / Math.max(1, depth))
  return { x: w / 2 + vx * s, y: h / 2 - vy * s, depth }
}

function shadeColor(mat, normal, strength) {
  const base = MAT_RGB[mat] || MAT_RGB.shell
  const L1 = [0.42, 0.38, 0.82]
  const L2 = [-0.55, -0.2, 0.35]
  const d1 = Math.max(0, normal[0] * L1[0] + normal[1] * L1[1] + normal[2] * L1[2])
  const d2 = Math.max(0, normal[0] * L2[0] + normal[1] * L2[1] + normal[2] * L2[2])
  const k = clamp(0.28 + 0.66 * d1 + 0.24 * d2, 0.20, 1.26) * strength
  return `rgb(${Math.min(255, base[0] * k) | 0},${Math.min(255, base[1] * k) | 0},${Math.min(255, base[2] * k) | 0})`
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

  // backdrop: a soft studio falloff, so the machine sits in a space
  const bg = g.createRadialGradient(w * 0.5, h * 0.42, 40, w * 0.5, h * 0.5, Math.max(w, h) * 0.78)
  bg.addColorStop(0, '#16202a')
  bg.addColorStop(1, '#080b0e')
  g.fillStyle = bg
  g.fillRect(0, 0, w, h)

  cam._basis = camBasis(cam, target)

  // ground grid at z=0
  if (opts.grid) {
    const span = Math.max(420, Math.round((target[0] + 600) / 100) * 100)
    const step = span > 800 ? 100 : 50
    g.lineWidth = 1
    for (let i = -span; i <= span; i += step) {
      const major = i % (step * 4) === 0
      g.strokeStyle = major ? 'rgba(96,132,156,0.30)' : 'rgba(96,132,156,0.12)'
      const a = project([i, -span, 0], cam, target, w, h)
      const b = project([i, span, 0], cam, target, w, h)
      const c = project([-span, i, 0], cam, target, w, h)
      const dd = project([span, i, 0], cam, target, w, h)
      if (a.depth > 1 && b.depth > 1) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke() }
      if (c.depth > 1 && dd.depth > 1) { g.beginPath(); g.moveTo(c.x, c.y); g.lineTo(dd.x, dd.y); g.stroke() }
    }
  }

  // ── turntable stage ─────────────────────────────────────────────────────
  // A product shot needs a floor that belongs to the machine. The disc is
  // drawn as a projected 48-gon so perspective is honest at any orbit angle.
  const ring = []
  let span = 0
  const centre = [0, 0]
  if (mesh.length) {
    const lo = [Infinity, Infinity]
    const hi = [-Infinity, -Infinity]
    for (const t of mesh) for (const p of t.pts) {
      span = Math.max(span, Math.hypot(p[0], p[1]))
      lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1])
      hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1])
    }
    centre[0] = (lo[0] + hi[0]) / 2
    centre[1] = (lo[1] + hi[1]) / 2
  }
  const discR = Math.max(60, span * 1.12)
  const ringPoint = (r, a) => project([centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r, 0], cam, target, w, h)
  for (let i = 0; i < 48; i += 1) {
    const pt = ringPoint(discR, (i / 48) * Math.PI * 2)
    if (pt.depth < 2) { ring.length = 0; break }
    ring.push(pt)
  }
  const c0 = project([centre[0], centre[1], 0], cam, target, w, h)
  if (ring.length && c0.depth > 1) {
    const edge = project([centre[0] + discR, centre[1], 0], cam, target, w, h)
    const rr = Math.max(40, Math.hypot(edge.x - c0.x, edge.y - c0.y))
    const disc = g.createRadialGradient(c0.x, c0.y - rr * 0.18, rr * 0.05, c0.x, c0.y, rr)
    disc.addColorStop(0, 'rgba(42,56,68,0.92)')
    disc.addColorStop(0.72, 'rgba(22,32,41,0.9)')
    disc.addColorStop(1, 'rgba(11,16,21,0.75)')
    g.beginPath()
    g.moveTo(ring[0].x, ring[0].y)
    for (const pt of ring) g.lineTo(pt.x, pt.y)
    g.closePath()
    g.fillStyle = disc
    g.fill()
    g.strokeStyle = 'rgba(255,106,26,0.55)'
    g.lineWidth = 1.2
    g.stroke()

    // concentric machining rings + 8 tick marks
    for (const frac of [0.34, 0.68]) {
      g.beginPath()
      for (let i = 0; i <= 48; i += 1) {
        const pt = ringPoint(discR * frac, (i / 48) * Math.PI * 2)
        if (pt.depth < 2) continue
        if (i === 0) g.moveTo(pt.x, pt.y)
        else g.lineTo(pt.x, pt.y)
      }
      g.closePath()
      g.strokeStyle = 'rgba(120,150,170,0.16)'
      g.lineWidth = 1
      g.stroke()
    }
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2
      const p1 = ringPoint(discR * 0.965, a)
      const p2 = ringPoint(discR * (i % 3 === 0 ? 0.9 : 0.945), a)
      if (p1.depth < 2 || p2.depth < 2) continue
      g.beginPath()
      g.moveTo(p1.x, p1.y)
      g.lineTo(p2.x, p2.y)
      g.strokeStyle = i % 3 === 0 ? 'rgba(255,106,26,0.5)' : 'rgba(140,170,190,0.22)'
      g.lineWidth = 1
      g.stroke()
    }

    // contact shadow, over the disc
    const sh = g.createRadialGradient(c0.x, c0.y, 2, c0.x, c0.y, rr * 0.74)
    sh.addColorStop(0, 'rgba(0,0,0,0.5)')
    sh.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = sh
    g.beginPath()
    g.ellipse(c0.x, c0.y, rr * 0.74, rr * 0.34, 0, 0, Math.PI * 2)
    g.fill()
  }

  // triangles: project, cull, sort far→near, fill
  const draw = []
  for (const t of mesh) {
    const [a, b, c] = t.pts
    const pa = project(a, cam, target, w, h)
    const pb = project(b, cam, target, w, h)
    const pc = project(c, cam, target, w, h)
    if (pa.depth < 2 || pb.depth < 2 || pc.depth < 2) continue
    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)
    if (area > -0.02 && area < 0) continue
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    n = [n[0] / len, n[1] / len, n[2] / len]
    // two-sided: flip the normal toward the eye so back faces are not black
    const toEye = [cam._basis.eye[0] - a[0], cam._basis.eye[1] - a[1], cam._basis.eye[2] - a[2]]
    if (n[0] * toEye[0] + n[1] * toEye[1] + n[2] * toEye[2] < 0) n = n.map((x) => -x)
    draw.push({ pa, pb, pc, depth: (pa.depth + pb.depth + pc.depth) / 3, fill: shadeColor(t.mat, n, opts.wire ? 1 : 1) })
  }
  draw.sort((p, q) => q.depth - p.depth)

  const wire = opts.wire
  for (const t of draw) {
    g.beginPath()
    g.moveTo(t.pa.x, t.pa.y)
    g.lineTo(t.pb.x, t.pb.y)
    g.lineTo(t.pc.x, t.pc.y)
    g.closePath()
    if (wire) {
      g.strokeStyle = 'rgba(140,196,220,0.55)'
      g.lineWidth = 0.7
      g.stroke()
    } else {
      g.fillStyle = t.fill
      g.fill()
      // same-colour hairline stroke closes antialiasing seams between faces
      g.strokeStyle = t.fill
      g.lineWidth = 0.7
      g.stroke()
    }
  }

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
    for (const [p, q, label] of edges) {
      const a = project(p, cam, target, w, h)
      const b = project(q, cam, target, w, h)
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
