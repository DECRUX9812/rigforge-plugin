// ── pcb: the board itself, not just the machine around it ───────────────────
// A small custom board: the MCU module, its sensors, power and connectors, laid
// out on a real outline with mounting holes, silkscreen and the passive parts
// that actually need a pick-and-place machine. Everything placed here carries a
// designator, a package and a rotation, because that is what a centroid file is.

// designator, part key, x fraction, y fraction, rotation°, package
// Fractions map onto the usable field (half-board minus a 6mm edge margin).
// These were laid out by courtyard, not by eye: the ESP32 module owns the
// bottom-left, breakouts fill the top band, the rocker hangs the right edge —
// auditBoardFit proves no two courtyards touch at the default 120×79mm.
const PCB_PARTS = [
  ['U1', 'esp32s3', -0.39, -0.76, 0, 'MODULE 62×26'],
  ['U2', 'bme280', -0.07, 0.66, 0, 'LGA-8'],
  ['U3', 'ssd1306', -0.56, 0.60, 0, 'MODULE 27×27'],
  ['U4', 'ina219', 0.65, 0.15, 0, 'SOT-23-8'],
  ['J1', 'jst_kit', 0.56, 0.99, 0, 'JST-XH 4'],
  ['J2', 'rocker', 0.89, -0.63, 90, 'THT 3'],
]

// the passives a board like this actually needs, and the reason each exists
// x and y are fractions of the same usable field as the modules.
const PCB_PASSIVES = [
  ['C1', '0402', -0.65, -0.27, 0, 'input bulk'],
  ['C2', '0402', -0.52, -0.27, 0, 'decoupling · 3V3'],
  ['C3', '0402', -0.39, -0.27, 90, 'decoupling · 1V1'],
  ['C4', '0402', -0.26, -0.27, 0, 'decoupling · ADC ref'],
  ['R1', '0402', 0.19, 0.72, 0, 'I²C pull-up · SDA'],
  ['R2', '0402', 0.26, 0.72, 0, 'I²C pull-up · SCL'],
  ['R3', '0603', 0.37, -1.04, 90, 'LED series'],
  ['R4', '0603', 0.48, -1.04, 0, 'boot pull-up'],
]

// ── board fit audit ────────────────────────────────────────────────────────
// A placement list is a claim that this board can be built. Before we say it,
// check it: every courtyard inside the outline, no two courtyards touching,
// nothing in the antenna keep-out, nothing over a drill pad. Courtyards are
// the real part outline plus the clearance a fab needs — the drawn body is
// 0.86× the part on purpose, so auditing the drawing would understate it.

// courtyard [w, d] mm per package; modules use their catalog dims + margin
const COURTYARD = { '0402': [1.5, 1.0], '0603': [2.7, 1.6] }
const COURT_MARGIN = 0.8 // mm added to a module's catalog footprint

function courtyardOf(p) {
  if (p.kind === 'passive') return COURTYARD[p.pkg] || [2.0, 1.2]
  const part = PARTS[p.key]
  const dims = (part && part.dims) || [10, 10]
  return [dims[0] + COURT_MARGIN, dims[1] + COURT_MARGIN]
}

// AABB of a w×d rect rotated rot° about its centre, as [x0,y0,x1,y1]
function placedAabb(p, cw) {
  const [w, d] = cw
  const r = ((p.rot || 0) * Math.PI) / 180
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r))
  const hw = (w * c + d * s) / 2, hd = (w * s + d * c) / 2
  return [p.x - hw, p.y - hd, p.x + hw, p.y + hd]
}

function auditBoardFit(d, placed, W, H) {
  const edge = 0.3 // outline keeps this much copper off the board edge
  const bx0 = -W / 2 + edge, bx1 = W / 2 - edge, by0 = -H / 2 + edge, by1 = H / 2 - edge
  // antenna keep-out and the USB-C tongue zone are board features, not parts
  const keepout = [W / 2 - 16, H / 2 - 11.5, W / 2 - 2, H / 2 - 2.5]
  const usb = [-W / 2 - 0.5, -4.2, -W / 2 + 5.5, 4.2]
  const holes = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => [sx * (W / 2 - 3.5), sy * (H / 2 - 3.5)])

  const boxes = placed.map((p) => ({ p, cw: courtyardOf(p), bb: placedAabb(p, courtyardOf(p)) }))
  const name = (p) => `${p.des} ${p.pkg && p.kind === 'passive' ? p.pkg : (PARTS[p.key] && PARTS[p.key].name) || p.key}`

  // 1 — every courtyard inside the outline (fail: the board cannot be built)
  for (const { p, cw, bb } of boxes) {
    if (bb[0] < bx0 || bb[1] < by0 || bb[2] > bx1 || bb[3] > by1) {
      const needW = Math.ceil(cw[0]), needH = Math.ceil(cw[1])
      d.checks.push({ level: 'fail',
        msg: `${name(p)} needs a ${needW}×${needH}mm courtyard but the ${W}×${H}mm outline leaves ${Math.floor(bx1 - bx0)}×${Math.floor(by1 - by0)}mm usable — grow reachMm or move the part in.` })
    }
  }

  // 2 — courtyard overlaps (fail: two parts cannot occupy the same pads)
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].bb, b = boxes[j].bb
    const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
    const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
    if (ox > 0 && oy > 0) {
      d.checks.push({ level: 'fail',
        msg: `${name(boxes[i].p)} and ${name(boxes[j].p)} courtyards overlap by ${ox.toFixed(1)}×${oy.toFixed(1)}mm — the pick-and-place file would collide.` })
    }
  }

  // 3 — antenna keep-out and USB tongue are keep-outs, not courtyards
  for (const { p, bb } of boxes) {
    const hit = (k) => bb[0] < k[2] && bb[2] > k[0] && bb[1] < k[3] && bb[3] > k[1]
    if (hit(keepout)) d.checks.push({ level: 'warn', msg: `${name(p)} sits inside the antenna keep-out — the radio range claim no longer holds.` })
    if (hit(usb)) d.checks.push({ level: 'warn', msg: `${name(p)} overlaps the USB-C connector zone.` })
    // 4 — drill pads need copper clearance: no courtyard within pad r + 0.5mm
    for (const [hx, hy] of holes) {
      if (hx > bb[0] - 3.5 && hx < bb[2] + 3.5 && hy > bb[1] - 3.5 && hy < bb[3] + 3.5) {
        d.checks.push({ level: 'warn', msg: `${name(p)} courtyard reaches a mounting hole pad — keep 0.5mm drill-to-copper.` })
        break
      }
    }
  }

  // 5 — pick-and-place access: a machine passive closer than ~2mm to the
  // outline leaves no room for the nozzle, and courtyards nearer than ~0.5mm
  // leave no room to work between them. Hand-placed modules are exempt —
  // an iron doesn't need nozzle clearance.
  for (const { p, bb } of boxes) {
    if (p.kind !== 'passive') continue
    const edgeGap = Math.min(bb[0] - bx0, bb[1] - by0, bx1 - bb[2], by1 - bb[3])
    if (edgeGap < 2) {
      d.checks.push({ level: 'warn', msg: `${name(p)} courtyard sits ${Math.max(0, edgeGap).toFixed(1)}mm from the board edge — pick-and-place nozzles need ~2mm.` })
    }
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].bb, b = boxes[j].bb
    const gx = Math.max(a[0] - b[2], b[0] - a[2], 0)
    const gy = Math.max(a[1] - b[3], b[1] - a[3], 0)
    const gap = Math.hypot(gx, gy)
    if (gap > 0 && gap < 0.5 && (boxes[i].p.kind === 'passive' || boxes[j].p.kind === 'passive')) {
      d.checks.push({ level: 'warn', msg: `${name(boxes[i].p)} and ${name(boxes[j].p)} courtyards are ${gap.toFixed(2)}mm apart — under the ~0.5mm a placement nozzle needs between parts.` })
    }
  }

  // 6 — fiducials: machine assembly wants two bare-copper marks on a diagonal
  // for vision alignment. They are board features, not placements, so they
  // get their own keep-out check against every courtyard.
  for (const f of d.pcb.fiducials || []) {
    const fb = [f.x - 1.6, f.y - 1.6, f.x + 1.6, f.y + 1.6]
    for (const { p, bb } of boxes) {
      if (bb[0] < fb[2] && bb[2] > fb[0] && bb[1] < fb[3] && bb[3] > fb[1]) {
        d.checks.push({ level: 'warn', msg: `${name(p)} courtyard covers fiducial ${f.id} — the assembler's vision target must stay bare.` })
        break
      }
    }
  }
}

/**
 * Pick-and-place fiducials: two 1mm bare-copper marks the assembler's vision
 * uses for panel alignment — they belong on a diagonal so rotation is
 * observable. Scan the usable field on a coarse grid, keep spots whose 3.2mm
 * keep-out box clears every courtyard, the antenna keep-out, the USB zone and
 * the drill pads, then take the best-separated pair. Returns [] when the
 * layout genuinely has no room — the caller says so honestly.
 */
function placeFiducials(placed, W, H) {
  const edge = 0.3, margin = 4 // fiducial centre stays this far off the outline
  const bx0 = -W / 2 + edge, bx1 = W / 2 - edge, by0 = -H / 2 + edge, by1 = H / 2 - edge
  const keepout = [W / 2 - 16, H / 2 - 11.5, W / 2 - 2, H / 2 - 2.5]
  const usb = [-W / 2 - 0.5, -4.2, -W / 2 + 5.5, 4.2]
  const holes = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => [sx * (W / 2 - 3.5), sy * (H / 2 - 3.5)])
  const boxes = placed.map((p) => ({ bb: placedAabb(p, courtyardOf(p)) }))
  const clear = (x, y) => {
    const fb = [x - 1.6, y - 1.6, x + 1.6, y + 1.6]
    if (fb[0] < bx0 || fb[1] < by0 || fb[2] > bx1 || fb[3] > by1) return false
    const hit = (k) => fb[0] < k[2] && fb[2] > k[0] && fb[1] < k[3] && fb[3] > k[1]
    if (hit(keepout) || hit(usb)) return false
    for (const b of boxes) if (hit(b.bb)) return false
    for (const [hx, hy] of holes) if (Math.hypot(hx - x, hy - y) < 4) return false
    return true
  }
  const spots = []
  for (let x = -W / 2 + margin; x <= W / 2 - margin; x += 3) {
    for (let y = -H / 2 + margin; y <= H / 2 - margin; y += 3) {
      if (clear(x, y)) spots.push([x, y])
    }
  }
  // best diagonal pair: maximise separation, prefer opposite corners
  let best = null
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
    const sep = Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1])
    const diag = Math.sign(spots[i][0]) !== Math.sign(spots[j][0]) && Math.sign(spots[i][1]) !== Math.sign(spots[j][1]) ? 1 : 0
    const score = sep + diag * 20
    if (sep >= 20 && (!best || score > best.score)) best = { a: spots[i], b: spots[j], score }
  }
  if (!best) return []
  return [
    { id: 'fid-1', x: Math.round(best.a[0] * 10) / 10, y: Math.round(best.a[1] * 10) / 10 },
    { id: 'fid-2', x: Math.round(best.b[0] * 10) / 10, y: Math.round(best.b[1] * 10) / 10 },
  ]
}

function buildPcb(brief) {
  const d = newDesign('pcb', brief)
  const W = clamp(Math.round(brief.reachMm || 120), 40, 160)
  const H = clamp(Math.round(W * 0.66), 30, 120)
  const T = 1.6

  d.title = `${W}×${H}mm controller board`
  d.subtitle = 'ESP32-S3 · sensor + power + connectors · 2 layers'
  d.metrics = { boardW: W, boardH: H, layers: 2 }

  // ── the board, its holes and its silkscreen ─────────────────────────────
  rbox(d, 'board', [W, H, T], [0, 0, 0], 2, 'pcb', { print: false })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    cyl(d, `hole-${sx}${sy}`, 1.6, T + 1, [sx * (W / 2 - 3.5), sy * (H / 2 - 3.5), 0], 'z', 'rubber')
    cyl(d, `hole-pad-${sx}${sy}`, 3, 0.2, [sx * (W / 2 - 3.5), sy * (H / 2 - 3.5), T / 2 + 0.1], 'z', 'copper')
  }
  // USB-C and the antenna keep-out as silkscreen blocks the eye can read
  box(d, 'usb', [9, 7.5, 3], [-W / 2 + 1, 0, T / 2 + 1.5], 'metal')
  box(d, 'usb-mask', [6.5, 4, 2.4], [-W / 2 - 2.2, 0, T / 2 + 1.5], 'rubber')
  rbox(d, 'keepout', [14, 9, 0.25], [W / 2 - 9, H / 2 - 7, T / 2 + 0.2], 1, 'steel')

  // ── placed parts: modules, then the passives ───────────────────────────
  const rotPt = (dx, dy, deg) => {
    const r = (deg * Math.PI) / 180
    const c = Math.cos(r)
    const sn = Math.sin(r)
    return [dx * c - dy * sn, dx * sn + dy * c]
  }
  const at = (x, y, rot) => (dx, dy) => {
    const [rx, ry] = rotPt(dx, dy, rot)
    return [x + rx, y + ry]
  }

  // ── components that look like the thing you would actually buy ────────────
  // A devkit is a board with a shield can, a USB-C shell and two rows of 2.54mm
  // pins. An OLED is glass in a frame with a four-pin header. A rocker is a
  // black box with a lever. None of that is a rounded cuboid, and the rounded
  // cuboid is exactly why the board read as clay.
  const pinHeader = (d, id, x, y, rot, n, pitch, z0, along) => {
    const P = at(x, y, rot)
    const span = (n - 1) * pitch
    const rail = along === 'x' ? [span + 2.2, 2.54, 1.3] : [2.54, span + 2.2, 1.3]
    box(d, `${id}-rail`, rail, [x, y, z0 + 0.65], 'rubber')
    for (let i = 0; i < n; i += 1) {
      const t = i * pitch - span / 2
      const [px, py] = along === 'x' ? P(t, 0) : P(0, t)
      box(d, `${id}-p${i}`, [1.1, 1.1, 2.6], [px, py, z0 + 1.3], 'copper')
    }
  }

  const component = (d, des, key, x, y, rot, sx, sy, h, T) => {
    const z0 = T / 2
    const P = at(x, y, rot)
    switch (key) {
      case 'esp32s3': {
        rbox(d, `${des}-pcb`, [sx, sy, 1.6], [x, y, z0 + 0.8], 0.6, 'pcbblue')
        box(d, `${des}-can`, [sx * 0.42, sy * 0.55, 1.4], [x - sx * 0.06, y, z0 + 2.3], 'metal')
        box(d, `${des}-usbc`, [7.5, 4.2, 2.8], [x + sx / 2 - 2.6, y, z0 + 1.7], 'metal')
        box(d, `${des}-usbc-in`, [4, 2.2, 1.8], [x + sx / 2 - 1.2, y, z0 + 1.7], 'rubber')
        const n = Math.max(4, Math.floor((sy - 5) / 2.54) + 1)
        const pitch = 2.54
        for (const s of [-1, 1]) {
          const [rx, ry] = P(0, s * (sy / 2 - 2.4))
          pinHeader(d, `${des}-hdr${s > 0 ? 'a' : 'b'}`, rx, ry, rot, n, pitch, z0, 'y')
        }
        for (const s of [-1, 1]) {
          const [bx, by] = P(-sx * 0.2, s * sy * 0.34)
          box(d, `${des}-btn${s > 0 ? 'a' : 'b'}`, [3.2, 3.2, 1.8], [bx, by, z0 + 1.7], 'rubber')
        }
        break
      }
      case 'ssd1306': {
        rbox(d, `${des}-pcb`, [sx, sy, 1.4], [x, y, z0 + 0.7], 0.5, 'rubber')
        box(d, `${des}-glass`, [sx * 0.86, sy * 0.62, 0.7], [x, y + sy * 0.06, z0 + 1.7], 'glass')
        box(d, `${des}-bezel`, [sx * 0.92, sy * 0.10, 0.9], [x, y - sy * 0.36, z0 + 1.7], 'rubber')
        const [hx, hy] = P(0, -sy / 2 + 1.6)
        pinHeader(d, `${des}-hdr`, hx, hy, rot, 4, 2.54, z0, 'x')
        break
      }
      case 'bme280': {
        rbox(d, `${des}-pcb`, [sx, sy, 1.2], [x, y, z0 + 0.6], 0.4, 'pcb')
        const [hx, hy] = P(-sx / 2 + 1.5, 0)
        pinHeader(d, `${des}-hdr`, hx, hy, rot, 4, 2.54, z0, 'y')
        box(d, `${des}-chip`, [3.2, 3.2, 1.1], [P(sx * 0.1, 0)[0], P(sx * 0.1, 0)[1], z0 + 1.2], 'metal')
        break
      }
      case 'ina219': {
        rbox(d, `${des}-pcb`, [sx, sy, 1.2], [x, y, z0 + 0.6], 0.4, 'pcbblue')
        box(d, `${des}-shunt`, [6.5, 4, 1.4], [P(-sx * 0.1, -sy * 0.12)[0], P(-sx * 0.1, -sy * 0.12)[1], z0 + 1.3], 'rubber')
        box(d, `${des}-ic`, [4, 4, 1.0], [P(sx * 0.22, sy * 0.2)[0], P(sx * 0.22, sy * 0.2)[1], z0 + 1.1], 'rubber')
        const [hx, hy] = P(-sx / 2 + 1.5, 0)
        pinHeader(d, `${des}-hdr`, hx, hy, rot, 4, 2.54, z0, 'y')
        break
      }
      case 'jst_kit': {
        box(d, `${des}-body`, [14, 8.5, 6], [x, y, z0 + 3], 'shell')
        for (let i = 0; i < 4; i += 1) {
          const [px, py] = P((i - 1.5) * 2.5, 0)
          box(d, `${des}-pin${i}`, [0.8, 0.8, 1.2], [px, py, z0 + 6.4], 'brass')
        }
        const col = ['accent', 'rubber', 'brass']
        for (let i = 0; i < 3; i += 1) {
          const yoff = (i - 1) * 2.5
          for (let sgi = 0; sgi < 3; sgi += 1) {
            const len = 9
            const [px, py] = P(sx / 2 + 2 + sgi * len, yoff)
            box(d, `${des}-lead${i}-${sgi}`, [len, 1.7, 1.7], [px, py, z0 + 3 - sgi * 0.6], col[i])
          }
        }
        break
      }
      case 'rocker': {
        box(d, `${des}-shell`, [sx, sy, h * 0.7], [x, y, z0 + h * 0.35], 'rubber')
        box(d, `${des}-lever`, [sx * 0.62, sy * 0.5, 3.2], [x, y, z0 + h * 0.7 + 1.4], 'copper')
        box(d, `${des}-rim`, [sx * 0.9, sy * 0.12, 1.2], [x, y - sy * 0.4, z0 + h * 0.7], 'rubber')
        break
      }
      default: {
        rbox(d, `${des}-body`, [sx, sy, Math.max(2, h)], [x, y, z0 + Math.max(2, h) / 2], 0.4, 'rubber')
      }
    }
  }

  const placed = []
  const FIELD_X = W / 2 - 6, FIELD_Y = H / 2 - 6
  for (const [des, key, fx, fy, rot, pkg] of PCB_PARTS) {
    const x = Math.round(fx * FIELD_X)
    const y = Math.round(fy * FIELD_Y)
    const part = PARTS[key]
    if (!part) continue
    const [l, w, h] = part.dims || [10, 10, 3]
    const sx = Math.max(3, l * 0.86)
    const sy = Math.max(3, w * 0.86)
    component(d, `part-${des}`, key, x, y, rot, sx, sy, Math.max(2, h), T)
    // a pin-1 marker: the one detail that says "this is a real footprint"
    box(d, `pin1-${des}`, [1.2, 1.2, 0.6], [x - sx / 2 + 1.5, y - sy / 2 + 1.5, T / 2 + Math.max(2, h) + 0.3], 'brass')
    placed.push({ des, key, x, y, rot, pkg, layer: 'top', kind: 'module', sz: [sx, sy], h: Math.max(2, h) })
  }
  for (const [des, pkg, fx, fy, rot, why] of PCB_PASSIVES) {
    const x = Math.round(fx * FIELD_X)
    const y = Math.round(fy * FIELD_Y)
    const size = pkg === '0603' ? [1.6, 0.8] : [1.0, 0.5]
    box(d, `pass-${des}`, [size[0], size[1], 0.5], [x, y, T / 2 + 0.25], 'metal', {
      rot: [0, 0, (rot * Math.PI) / 180],
    })
    placed.push({ des, pkg, x, y, rot, layer: 'top', kind: 'passive', why, sz: size })
  }
  // ── the detail that makes it read as a board, not a green slab ──────────
  // Pads (ENIG), a white silkscreen outline around every placement, and copper
  // traces leaving each pad toward the controller. A real board hides its
  // traces under the mask, but a board with none at all reads as plastic.
  const rot2 = (dx, dy, deg) => {
    const r = (deg * Math.PI) / 180
    const c = Math.cos(r)
    const sn = Math.sin(r)
    return [dx * c - dy * sn, dx * sn + dy * c]
  }
  const hub = [0, Math.round(0.08 * (H / 2 - 12))]
  for (const p of placed) {
    const [sx, sy] = p.sz || [4, 3]
    const deg = p.rot || 0
    const zPad = T / 2 + 0.14
    const zSilk = T / 2 + 0.07
    const zTrace = T / 2 + 0.05

    // pads: two ends on a passive, a pin row down each long side on a module
    const pads = []
    if (p.kind === 'passive') {
      // pads sit at the ends of the body, half exposed — an SMD joint is a
      // fillet at the edge, not a decal hidden under the part
      for (const s of [-1, 1]) pads.push([s * (sx / 2 + 0.35), 0])
    } else {
      // a module is soldered by a pin row along each long side, and the pads
      // must stick out past the body or the body simply hides them
      const n = p.pkg && /MODULE/.test(p.pkg) ? 6 : 4
      for (let i = 0; i < n; i += 1) {
        const t = (i / (n - 1) - 0.5) * sx * 0.8
        pads.push([t, -(sy / 2 + 0.55)], [t, sy / 2 + 0.55])
      }
    }
    pads.forEach(([dx, dy], i) => {
      const [rx, ry] = rot2(dx, dy, deg)
      box(d, `pad-${p.des}-${i}`, [1.5, 1.0, 0.22], [p.x + rx, p.y + ry, zPad], 'copper')
    })

    // silkscreen: four thin bars framing the footprint, just outside the part
    const halfW = sx / 2 + 0.6
    const halfH = sy / 2 + 0.6
    const bars = [
      [[halfW * 2 + 0.6, 0.5, 0.14], [0, -halfH]],
      [[halfW * 2 + 0.6, 0.5, 0.14], [0, halfH]],
      [[0.5, halfH * 2, 0.14], [-halfW, 0]],
      [[0.5, halfH * 2, 0.14], [halfW, 0]],
    ]
    bars.forEach(([size, off], i) => {
      const [rx, ry] = rot2(off[0], off[1], deg)
      box(d, `silk-${p.des}-${i}`, size, [p.x + rx, p.y + ry, zSilk], 'silk')
    })

    // traces: one Manhattan run from the first pad toward the controller
    const [px0, py0] = rot2(pads[0][0], pads[0][1], deg)
    const ax = p.x + px0
    const ay = p.y + py0
    const midX = (ax + hub[0]) / 2
    box(d, `trace-${p.des}-a`, [Math.abs(hub[0] - ax) + 0.4, 0.55, 0.12], [midX, ay, zTrace], 'copper')
    box(d, `trace-${p.des}-b`, [0.55, Math.abs(hub[1] - ay) + 0.4, 0.12], [hub[0], (ay + hub[1]) / 2, zTrace], 'copper')
  }

  // copper pour ring inside the outline — a real 2-layer board is mostly copper
  const inset = 2.4
  for (const [w, h, x, y] of [
    [W - inset * 2, 2.2, 0, H / 2 - inset],
    [W - inset * 2, 2.2, 0, -H / 2 + inset],
    [2.2, H - inset * 2, -W / 2 + inset, 0],
    [2.2, H - inset * 2, W / 2 - inset, 0],
  ]) {
    box(d, `pour-${x}-${y}`, [w, h, 0.05], [x, y, T / 2 + 0.02], 'copper')
  }

  // the module itself: a metal shield can on the controller, glass on the display
  const u1 = placed.find((p) => p.des === 'U1')
  if (u1) {
    box(d, 'u1-shield', [u1.sz[0] * 0.62, u1.sz[1] * 0.7, 0.7], [u1.x, u1.y, T / 2 + u1.h + 0.35], 'metal')
    box(d, 'u1-antenna', [u1.sz[0] * 0.5, 1.2, 0.5], [u1.x, u1.y + u1.sz[1] * 0.42, T / 2 + u1.h + 0.25], 'brass')
  }
  const u3 = placed.find((p) => p.des === 'U3')
  if (u3) {
    box(d, 'u3-glass', [u3.sz[0] * 0.78, u3.sz[1] * 0.62, 0.4], [u3.x, u3.y, T / 2 + u3.h + 0.2], 'glass')
  }

  d.pcb = { placed, W, H, T }
  d.pcb.fiducials = placeFiducials(placed, W, H)
  auditBoardFit(d, placed, W, H)
  // bare-copper fiducial pads: the assembler's vision targets, drawn as the
  // 1mm pads they are — audit already proved no courtyard covers them
  for (const f of d.pcb.fiducials) {
    cyl(d, f.id, 0.5, 0.2, [f.x, f.y, T / 2 + 0.1], 'z', 'brass')
  }

  // ── BOM ────────────────────────────────────────────────────────────────
  addPart(d, brief.mcu || 'esp32s3', 1, 'U1 controller')
  addPart(d, 'bme280', 1, 'U2 climate')
  addPart(d, 'ssd1306', 1, 'U3 display')
  addPart(d, 'ina219', 1, 'U4 current sense')
  addPart(d, 'jst_kit', 1, 'J1 sensor bus')
  addPart(d, 'rocker', 1, 'J2 power switch')
  addPart(d, 'cap_0402', 4, 'C1–C4 decoupling')
  addPart(d, 'res_0402', 4, 'R1–R4 pull-ups')
  const power = brief.battery === 'pd5v' ? 'pd5v' : (PARTS[brief.battery] ? brief.battery : 'lipo2s')
  addPart(d, power, 1, 'board power')
  addPart(d, 'm2_screws', 1, 'board mounting')
  d.parts = d.parts.filter((p) => p.qty > 0)

  const handPlaced = placed.filter((p) => p.kind === 'module').length
  const machinePlaced = placed.filter((p) => p.kind === 'passive').length
  // joints on the board itself: two per passive, and a header row per module
  d.pcb.joints = placed.reduce((n, p) => n + (p.kind === 'passive' ? 2 : 8), 0)
  d.notes.push(d.pcb.fiducials.length === 2
    ? 'Two fiducial pads give the assembler vision a diagonal reference — bare copper, no paste.'
    : 'No room for fiducial pads in this layout — hand-place the passives or panelize for machine assembly.')
  d.notes.push(`${placed.length} placements: ${handPlaced} modules you solder or socket, ${machinePlaced} passives a pick-and-place machine does in seconds.`)
  d.notes.push(W > 100
    ? `Board ${W}×${H}mm, 2 layers, 1.6mm FR4 — over the 100mm cheap-tier width, so the next fab price band.`
    : `Board ${W}×${H}mm, 2 layers, 1.6mm FR4 — inside every prototype fab's cheap tier.`)
  // the envelope includes what sticks out past the outline (USB-C, headers)
  const bb = boundsOf(d.nodes)
  const envelope = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]].map((v) => Math.round(v))
  d.subtitle = `ESP32-S3 · 2 layers · ${envelope[0]}×${envelope[1]}mm envelope with connectors`
  d.metrics.envelope = envelope
  d.checks.push({ level: 'ok', msg: 'Single board, no flex, no blind vias — the cheapest class of PCB there is.' })
  if (W * H > 8000) {
    d.checks.push({ level: 'warn', msg: `${W}×${H}mm is a big 2-layer board; above ~100×100mm the fab price climbs and warping starts to matter.` })
  }
  return d
}
