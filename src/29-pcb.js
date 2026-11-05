// ── pcb: the board itself, not just the machine around it ───────────────────
// A small custom board: the MCU module, its sensors, power and connectors, laid
// out on a real outline with mounting holes, silkscreen and the passive parts
// that actually need a pick-and-place machine. Everything placed here carries a
// designator, a package and a rotation, because that is what a centroid file is.

// designator, part key, x fraction, y fraction, rotation°, package
const PCB_PARTS = [
  ['U1', 'esp32s3', 0, 0.08, 0, 'MODULE 62×26'],
  ['U2', 'bme280', -0.34, 0.3, 0, 'LGA-8'],
  ['U3', 'ssd1306', 0.32, 0.3, 0, 'MODULE 27×27'],
  ['U4', 'ina219', 0.34, -0.12, 0, 'SOT-23-8'],
  ['J1', 'jst_kit', -0.38, -0.34, 0, 'JST-XH 4'],
  ['J2', 'rocker', 0.36, -0.36, 0, 'THT 3'],
]

// the passives a board like this actually needs, and the reason each exists
// x and y are fractions of the half-board, same as the modules: a board that
// grows must not fling its passives off the edge.
const PCB_PASSIVES = [
  ['C1', '0402', -0.22, -0.3, 0, 'input bulk'],
  ['C2', '0402', -0.14, -0.3, 0, 'decoupling · 3V3'],
  ['C3', '0402', -0.06, -0.3, 90, 'decoupling · 1V1'],
  ['C4', '0402', 0.02, -0.3, 0, 'decoupling · ADC ref'],
  ['R1', '0402', 0.12, -0.16, 0, 'I²C pull-up · SDA'],
  ['R2', '0402', 0.2, -0.16, 0, 'I²C pull-up · SCL'],
  ['R3', '0603', 0.1, 0.34, 90, 'LED series'],
  ['R4', '0603', 0.18, 0.34, 0, 'boot pull-up'],
]

function buildPcb(brief) {
  const d = newDesign('pcb', brief)
  const W = clamp(Math.round(brief.reachMm || 92), 40, 160)
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
  for (const [des, key, fx, fy, rot, pkg] of PCB_PARTS) {
    const x = Math.round(fx * (W / 2 - 12))
    const y = Math.round(fy * (H / 2 - 10))
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
    const x = Math.round(fx * (W / 2 - 10))
    const y = Math.round(fy * (H / 2 - 8))
    const size = pkg === '0603' ? [1.6, 0.8] : [1.0, 0.5]
    box(d, `pass-${des}`, [size[0], size[1], 0.5], [x, y, T / 2 + 0.25], 'metal', {
      rot: [0, 0, (rot * Math.PI) / 180],
    })
    placed.push({ des, pkg, x, y, rot, layer: 'top', kind: 'passive', why })
  }
  d.pcb = { placed, W, H, T }

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
  d.notes.push(`${placed.length} placements: ${handPlaced} modules you solder or socket, ${machinePlaced} passives a pick-and-place machine does in seconds.`)
  d.notes.push(`Board ${W}×${H}mm, 2 layers, 1.6mm FR4 — inside every prototype fab's cheap tier.`)
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
