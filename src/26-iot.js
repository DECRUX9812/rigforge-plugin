// ── iot node: the smallest thing worth building ─────────────────────────────
// One board, one sensor, one battery, one printed shell. This is the bottom of
// the ladder: it has to cost a coffee, print in an hour, and be wired by
// someone who has never held an iron.

function buildIot(brief) {
  const d = newDesign('iot', brief)
  const mission = (brief.mission || '').toLowerCase()
  const wants = {
    display: /display|oled|screen|clock|readout|gauge/.test(mission) || brief.reachMm === 0,
    motion: /motion|pir|presence|occupancy|intruder/.test(mission),
    air: /temp|humid|air|co2|climate|weather|bme/.test(mission) || !/pir|soil|weight/.test(mission),
    soil: /soil|plant|garden|moisture/.test(mission),
    weight: /scale|weight|load|hx711/.test(mission),
  }
  const W = 62
  const H = 44
  const D = 30

  d.title = wants.display ? 'Desk sensor node' : 'Pocket sensor node'
  d.subtitle = `${W}×${H}×${D}mm printed case · one sensor · one board`
  d.metrics = {}

  // shell: clamshell — base slab, four walls, lid. The old solid tray
  // buried every internal part (display included); a real cavity lets the
  // board, sensor and cell sit where a builder would put them.
  const WT = 2.4 // wall thickness
  rbox(d, 'base', [W, H, 3], [0, 0, 1.5], 2, 'shell', { print: true })
  for (const sx of [-1, 1]) box(d, `wall-x${sx}`, [WT, H, 23], [sx * (W / 2 - WT / 2), 0, 14.5], 'shell', { print: true })
  for (const sy of [-1, 1]) box(d, `wall-y${sy}`, [W - WT * 2, WT, 23], [0, sy * (H / 2 - WT / 2), 14.5], 'shell', { print: true })
  rbox(d, 'lid', [W, H, 4], [0, 0, 28], 2.5, 'shell', { print: true })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    // four feet under the base — a hole in each takes a screw or a
    // stick-on bumper; modelled flush with the bottom face, not buried
    box(d, `ear-${sx}${sy}`, [8, 8, 3], [sx * (W / 2 - 4), sy * (H / 2 - 4), -1.5], 'shell', { print: true })
    cyl(d, `ear-hole-${sx}${sy}`, 1.6, 3.2, [sx * (W / 2 - 4), sy * (H / 2 - 4), -1.5], 'z', 'rubber')
  }
  // display faces UP on the lid: bezel frame, glass window, OLED beneath
  const lidTop = 30
  rbox(d, 'bezel', [34, 26, 2], [0, 0, lidTop + 1], 1.5, 'accent', { print: true })
  box(d, 'window', [24, 16, 1.4], [0, 0, lidTop + 2.2], 'glass')
  // side cut-outs: USB-C tab on the right wall, sensor grille on the left
  box(d, 'usb-notch', [3, 6, 5], [W / 2 - WT / 2, 0, 12], 'rubber')
  for (let i = -2; i <= 2; i += 1) box(d, `vent-${i}`, [2, 22, 1.6], [-W / 2 - 0.2, i * 4, 14], 'rubber')
  // jog dial on the lid's front-right corner — a lathe'd thumb-wheel like
  // the selector on a real node; axis-vertical so it beds flat and
  // self-supports in the print pack
  lathe(d, 'dial', [[0, -2], [5.5, -2], [6, -1], [6, 1], [4.5, 2], [0, 2]], [24, -6, 32], 'z', 'accent', { print: true })

  // the board sits on standoffs inside the cavity, the sensor by the
  // grille, the cell flat on the base
  rbox(d, 'mcu', [26, 18, 5], [-8, 0, 16], 1, 'pcb')
  // the internal sensor block covers the board-level sensors (BME280, PIR,
  // HX711); a soil probe is a different object entirely — its 98mm blade
  // cannot fit a 62mm case, so it gets its own node out front on the ground
  if (!wants.soil || wants.air || wants.motion || wants.weight) {
    rbox(d, 'sensor', [14, 12, 4], [-20, 6, 16], 0.8, 'pcb')
  }
  if (wants.soil) elec(d, 'probe', 'soil', [0, -D / 2 - 14, 2])
  rbox(d, 'cell', [40, 26, 8], [0, 0, 7], 2, 'steel')
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    cyl(d, `standoff-${sx}${sy}`, 2.4, 11, [sx * 10 - 8, sy * 7, 8.5], 'z', 'metal')
  }
  if (wants.display) {
    rbox(d, 'oled', [26, 16, 2], [0, 0, lidTop + 0.6], 0.6, 'pcb')
  }

  // ── parts ────────────────────────────────────────────────────────────────
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  if (wants.air) addPart(d, 'bme280', 1, 'temperature / humidity / pressure')
  if (wants.motion) addPart(d, 'pir', 1, 'motion')
  if (wants.soil) addPart(d, 'soil', 1, 'soil moisture probe')
  if (wants.weight) addPart(d, 'hx711', 1, 'load cell amplifier')
  if (wants.display) addPart(d, 'ssd1306', 1, 'status display')
  const power = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo2s')
  addPart(d, power, 1, power === 'pd5v' ? 'USB power' : 'battery')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, 'jst_kit', 1, 'sensor leads')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, 'm2_screws', 1, 'case + board fasteners')
  addPart(d, 'insert_m3', 0, '')
  d.parts = d.parts.filter((p) => p.qty > 0)
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed case')

  const bat = PARTS[power]
  const load = 0.05 + (wants.display ? 0.02 : 0) + (wants.motion ? 0.001 : 0)
  const runtimeH = bat.mah > 0 ? (bat.mah * 0.8) / (load * 1000) : null
  if (runtimeH && runtimeH < 8) {
    d.checks.push({ level: 'warn', msg: `${bat.name} lasts about ${fmt(runtimeH, 1)}h at ${fmt(load * 1000, 0)}mA. A bigger cell or a sleep cycle in firmware would cover a day.` })
  }
  d.notes.push('Deep sleep between readings is where the runtime comes from — the sketch sleeps, wakes on a timer, publishes and sleeps again.')
  Object.assign(d.metrics, {
    loadA: load,
    runtimeH,
    battery: power,
    printedG: Math.round(printedVolume(d.nodes) / 1000 * (MATERIALS[brief.material] || MATERIALS.petg).density),
  })
  d.checks.push({ level: 'ok', msg: 'One board, one sensor, one printed shell — this is a first build, not a project.' })
  // which stimuli this node can actually sense — the bench drives these
  d.metrics.sensors = ['air', 'motion', 'soil', 'weight', 'display'].filter((k) => wants[k])
  return d
}
