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
    cyl(d, `hole-pad-${sx}${sy}`, 3, 0.2, [sx * (W / 2 - 3.5), sy * (H / 2 - 3.5), T / 2 + 0.1], 'z', 'brass')
  }
  // USB-C and the antenna keep-out as silkscreen blocks the eye can read
  box(d, 'usb', [9, 7.5, 3], [-W / 2 + 1, 0, T / 2 + 1.5], 'metal')
  box(d, 'usb-mask', [6.5, 4, 2.4], [-W / 2 - 2.2, 0, T / 2 + 1.5], 'rubber')
  rbox(d, 'keepout', [14, 9, 0.25], [W / 2 - 9, H / 2 - 7, T / 2 + 0.2], 1, 'steel')

  // ── placed parts: modules, then the passives ───────────────────────────
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
    rbox(d, `part-${des}`, [sx, sy, Math.max(2, h)], [x, y, T / 2 + Math.max(2, h) / 2], 0.4, 'pcb', {
      rot: [0, 0, (rot * Math.PI) / 180],
    })
    // a pin-1 marker: the one detail that says "this is a real footprint"
    box(d, `pin1-${des}`, [1.2, 1.2, 0.6], [x - sx / 2 + 1.5, y - sy / 2 + 1.5, T / 2 + Math.max(2, h) + 0.3], 'brass')
    placed.push({ des, key, x, y, rot, pkg, layer: 'top', kind: 'module' })
  }
  for (const [des, pkg, fx, fy, rot, why] of PCB_PASSIVES) {
    const x = Math.round(fx * FIELD_X)
    const y = Math.round(fy * FIELD_Y)
    const size = pkg === '0603' ? [1.6, 0.8] : [1.0, 0.5]
    box(d, `pass-${des}`, [size[0], size[1], 0.5], [x, y, T / 2 + 0.25], 'metal', {
      rot: [0, 0, (rot * Math.PI) / 180],
    })
    placed.push({ des, pkg, x, y, rot, layer: 'top', kind: 'passive', why })
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
