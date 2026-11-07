// ── analysis: the numbers that make it a spec, not a mood board ─────────────

const I2C = { sda: 8, scl: 9 }
const SPI = { sck: 12, mosi: 11, miso: 13 }
const I2S = { bclk: 5, lrclk: 6, din: 7, dout: 4 }

/**
 * Allocate real pins for the parts in the design. Returns rows the UI shows as
 * a wiring table and the firmware turns into #defines — one source, so the
 * code and the table can never disagree.
 */
function pinMap(design) {
  const rows = []
  const used = new Set([...Object.values(I2C), ...Object.values(SPI), ...Object.values(I2S), 43, 44]) // 43/44 = UART0 console
  // UART hard pairs must be reserved up front or take() hands them to a servo.
  const busCount = design.parts.filter((p) => p.key === 'bus_adapter').reduce((s, p) => s + p.qty, 0)
  const hasGpsUart = design.parts.some((p) => PARTS[p.key]?.bus === 'uart')
  if (busCount > 0 || hasGpsUart) for (const p of [17, 18, 47, 48]) used.add(p)
  let taken = 0 // pins actually allocated — the pin-budget number, not the reservation
  const take = () => {
    const free = SAFE_PINS.find((p) => !used.has(p))
    if (free == null) return null
    used.add(free)
    taken += 1
    return free
  }
  const takePin = () => String(take() ?? '—')
  const mcuKey = design.parts.find((p) => PARTS[p.key]?.cat === 'mcu')?.key || 'esp32s3'
  const mcu = PARTS[mcuKey]
  const buses = new Set()

  for (const { key, qty } of design.parts) {
    const part = PARTS[key]
    if (!part) continue
    switch (part.cat) {
      case 'mcu':
        rows.push({ pin: 'VIN', signal: '5V in', dir: 'pwr', note: 'From the 5V rail, 500mA headroom' })
        rows.push({ pin: 'GND', signal: 'common', dir: 'pwr', note: 'Star ground at the battery neg' })
        break
      case 'display':
      case 'sensor':
        if (part.bus === 'i2c') buses.add('i2c')
        if (part.bus === 'spi') buses.add('spi-display')
        if (part.bus === 'uart') buses.add('uart1')
        if (part.bus === 'i2s') buses.add(part.name.includes('amp') ? 'i2s-out' : 'i2s-in')
        if (part.bus === 'switch') {
          for (let i = 0; i < qty; i += 1) {
            rows.push({ pin: takePin(), signal: `LIMIT ${i + 1}`, dir: 'in', note: 'INPUT_PULLUP, wire NC — open wire reads as a hit' })
          }
        }
        break
      case 'driver':
        if (key === 'pca9685') buses.add('i2c')
        break
      case 'motor':
        for (let i = 0; i < qty; i += 1) {
          const pwm = takePin()
          const in1 = takePin()
          const in2 = takePin()
          rows.push({ pin: String(pwm), signal: `M${i + 1} PWM`, dir: 'out', note: 'LEDC 20kHz' })
          rows.push({ pin: String(in1), signal: `M${i + 1} IN1`, dir: 'out', note: 'direction' })
          rows.push({ pin: String(in2), signal: `M${i + 1} IN2`, dir: 'out', note: 'direction' })
          if (part.encoder) {
            rows.push({ pin: takePin(), signal: `M${i + 1} ENC A`, dir: 'in', note: 'interrupt, pull-up' })
          }
        }
        break
      case 'servo':
        // Servos on a PCA9685 are addressed by CHANNEL, and on a serial bus by
        // ADDRESS — either way one block for the whole design, never per part.
        if (!design.parts.some((p) => p.key === 'pca9685') && !design.parts.some((p) => p.key === 'bus_adapter')) {
          for (let i = 0; i < qty; i += 1) rows.push({ pin: takePin(), signal: `SERVO ${i + 1}`, dir: 'out', note: '50Hz, 500–2500µs' })
        }
        break
      default:
        break
    }
  }

  if (busCount > 0) {
    // ESP32-S3 has three UARTs; UART0 is the console, so buses land on 1 and 2.
    const pairs = [[17, 18], [47, 48]]
    for (let b = 0; b < Math.min(busCount, pairs.length); b += 1) {
      rows.push({ pin: `${pairs[b][0]}`, signal: `BUS${b} TX`, dir: 'out', part: 'uart', note: '1Mbps half-duplex, 330Ω series' })
      rows.push({ pin: `${pairs[b][1]}`, signal: `BUS${b} RX`, dir: 'in', part: '', note: '3.3V logic, no divider needed' })
    }
    if (busCount > pairs.length) rows.push({ pin: '—', signal: `${busCount - pairs.length} more bus(es)`, dir: 'err', part: '', note: 'ESP32-S3 has only two free UARTs' })
    rows.push({ pin: 'PWR', signal: 'servo rails', dir: 'pwr', part: '', note: '2 rails, 1000µF each at the first servo' })
  }

  if (design.parts.some((p) => p.key === 'pca9685')) {
    const actuators = design.actuators || []
    design.joints.forEach((j, i) => {
      const act = actuators.find((a) => a.label === j.label)
      rows.push({
        pin: `CH${i}`, signal: j.label, dir: 'pwm',
        part: act ? PARTS[act.servo].name : 'servo',
        note: `${j.min}° … ${j.max}°${act && act.ratio > 1 ? ` · ${act.ratio}:1` : ''}`,
      })
    })
    rows.push({ pin: `CH${design.joints.length}`, signal: 'Tool / end effector', dir: 'pwm', part: 'servo', note: '50Hz' })
  }

  if (buses.has('i2c')) {
    rows.push({ pin: String(I2C.sda), signal: 'I2C SDA', dir: 'io', note: '4.7k pull-up to 3V3' })
    rows.push({ pin: String(I2C.scl), signal: 'I2C SCL', dir: 'out', note: '400kHz' })
    if (design.parts.some((p) => p.key === 'pca9685')) rows.push({ pin: '0x40', signal: 'PCA9685', dir: 'bus', note: `${design.joints.length + 1} channels used` })
  }
  if (buses.has('spi-display')) {
    rows.push({ pin: String(SPI.sck), signal: 'TFT SCK', dir: 'out', note: 'SPI2 40MHz' })
    rows.push({ pin: String(SPI.mosi), signal: 'TFT MOSI', dir: 'out', note: '' })
    rows.push({ pin: takePin(), signal: 'TFT CS', dir: 'out', note: '' })
    rows.push({ pin: takePin(), signal: 'TFT DC', dir: 'out', note: '' })
  }
  if (buses.has('uart1')) {
    // GPS takes the UART pair the servo buses did not claim.
    const gpsPair = busCount > 0 ? [47, 48] : [17, 18]
    if (busCount > 1) rows.push({ pin: '—', signal: 'GPS UART', dir: 'err', note: 'no free UART — both are servo buses' })
    else {
      rows.push({ pin: String(gpsPair[0]), signal: 'GPS TX→RX', dir: 'in', note: '9600 baud NMEA' })
      rows.push({ pin: String(gpsPair[1]), signal: 'GPS RX→TX', dir: 'out', note: '' })
    }
  }
  if (buses.has('i2s-in') || buses.has('i2s-out')) {
    rows.push({ pin: String(I2S.bclk), signal: 'I2S BCLK', dir: 'out', note: '' })
    rows.push({ pin: String(I2S.lrclk), signal: 'I2S LRCLK', dir: 'out', note: '' })
    rows.push({ pin: String(I2S.din), signal: 'I2S DIN', dir: 'in', note: 'mic data' })
    if (buses.has('i2s-out')) rows.push({ pin: String(I2S.dout), signal: 'I2S DOUT', dir: 'out', note: 'amp data' })
  }
  if (design.archetype === 'gadget') {
    rows.push({ pin: takePin(), signal: 'KNOB', dir: 'in', note: 'ADC1, 12-bit' })
    rows.push({ pin: takePin(), signal: 'BUTTON', dir: 'in', note: 'INPUT_PULLUP' })
  }

  // Budget count = allocated pins + bus pins actually in use — the seeded
  // reservation is a floor, not a draw.
  let usedCount = taken
  if (buses.has('i2c')) usedCount += 2
  if (buses.has('spi-display')) usedCount += 3
  if (buses.has('uart1')) usedCount += 2
  if (buses.has('i2s-in') || buses.has('i2s-out')) usedCount += 3
  usedCount += Math.min(busCount, 2) * 2
  return { rows, mcu, mcuKey, safePins: SAFE_PINS.length, used: usedCount }
}

/** Power budget: rails, peak, typical, and what the pack can actually do. */
function powerBudget(design) {
  const rails = { '3V3': { typ: 0, peak: 0, items: [] }, '5V': { typ: 0, peak: 0, items: [] }, motor: { typ: 0, peak: 0, items: [] } }
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    if (!p || !p.curr) {
      // an agent can hand us a key we do not stock — flag it, don't crash
      if (!p) design.checks?.push({ level: 'warn', msg: `Unknown part key '${key}' in the parts list — check the brief or directive spelling.` })
      continue
    }
    const rail = p.cat === 'motor' || p.cat === 'servo' ? (p.volts >= 7 ? 'motor' : '5V') : '3V3'
    rails[rail].typ += p.curr.typ * qty
    rails[rail].peak += p.curr.peak * qty
    rails[rail].items.push({ key, qty, role, typ: p.curr.typ * qty, peak: p.curr.peak * qty })
  }
  const battery = design.parts.find((p) => PARTS[p.key]?.cat === 'battery')
  const bat = battery ? PARTS[battery.key] : null
  const typ = rails['3V3'].typ + rails['5V'].typ + rails.motor.typ
  const peak = rails['3V3'].peak + rails['5V'].peak + rails.motor.peak
  const runtime = bat && bat.mah > 0 && typ > 0.01 ? ((bat.mah / 1000) * 0.8 * 60) / typ : null

  // Wiring: the power rails are sized for the stall case, the logic rail for
  // what it actually draws. Fuse between them — it protects the WIRE.
  const railLabel = { '3V3': '3V3 logic', '5V': '6V servo', motor: 'motor' }
  // Wire is sized for what the rail can PEAK at, not for its average: the stall
  // case is the one that melts insulation. A rail beyond a single 14AWG lead is
  // split into parallel feeds, the way a real power-distribution board does it.
  // The fuse is then capped by its wire — a fuse bigger than its wire protects
  // nothing.
  const wiring = []
  for (const [name, v] of Object.entries(rails)) {
    if (v.peak <= 0.01) continue
    const peak = v.peak
    const typ = Math.max(v.typ, 0.05)
    const feeds = Math.max(1, Math.ceil(peak / 18))
    const perPeak = peak / feeds
    const perTyp = typ / feeds
    const awg = wireFor(perPeak)
    const ampacity = awg == null ? 0 : ampacityOf(awg)
    let fuse = null
    if (name !== '3V3' && ampacity > 0) {
      const want = fuseFor(Math.max(perTyp, 0.1))
      const capped = FUSE_STEPS.filter((f) => f <= ampacity).pop()
      fuse = Math.min(want, capped ?? want)
    }
    const conn = name === '3V3' ? 'JST-PH / Dupont' : perPeak > 12 ? 'XT60 + ring or barrier' : 'XT30 / JST-XH'
    for (let i = 0; i < feeds; i += 1) {
      wiring.push({
        rail: feeds > 1 ? `${railLabel[name] || name} · feed ${i + 1}/${feeds}` : (railLabel[name] || name),
        amps: perTyp,
        peak: perPeak,
        awg: awg == null ? '>14' : awg,
        ampacity,
        fuse,
        conn,
        feeds,
        over: awg == null,
        split: feeds > 1,
      })
    }
  }
  const overWire = wiring.filter((w) => w.over)
  if (overWire.length) {
    design.checks = design.checks || []
    design.checks.push({
      level: 'fail',
      msg: `${overWire.map((w) => w.rail).join(' + ')} peak above 18A even per feed — split further, use 10AWG with lugs, or fit a bus bar.`,
    })
  } else if (wiring.some((w) => w.split)) {
    design.checks = design.checks || []
    const n = Math.max(...wiring.map((w) => w.feeds))
    design.checks.push({
      level: 'ok',
      msg: `Power is distributed over parallel feeds (up to ${n} per rail) with a fuse sized to each wire — one lead cannot carry the stall case.`,
    })
  }

  return { rails, wiring, typ, peak, battery: battery?.key || null, bat, runtimeMin: runtime }
}

/**
 * Screws and inserts nobody wants to count by hand. Called from analyze so the
 * BOM, cost and CSV all agree — run once, guarded, because analyze() can run
 * again on a rebuilt design that already carries the lines.
 */
function autoFasteners(design) {
  if (design._fastened) return
  design._fastened = true
  let m3 = 0
  let m2 = 0
  let boards = 0
  for (const { key, qty } of design.parts) {
    const cat = PARTS[key]?.cat
    if (cat === 'servo') m3 += qty * 4 // ear bolts per servo
    else if (cat === 'motor') m3 += qty * 4 // face-mount pattern
    else if (cat === 'mcu' || cat === 'driver' || cat === 'display') boards += qty
    else if (cat === 'sensor' && PARTS[key].bus === 'switch') m2 += qty * 2
  }
  const screws10 = Math.ceil((m3 + boards * 4) / 10)
  const inserts10 = Math.ceil(m3 / 10)
  // A design that already carries the assortment kit does not also need the
  // counted lines — one or the other, never both.
  const hasKit = design.parts.some((p) => p.key === 'hw_m3' || p.key === 'm3_screws')
  if (screws10 > 0 && !hasKit) {
    addPart(design, 'm3_screws', screws10, `${m3 + boards * 4} counted M3 (servos, motors, boards)`)
    addPart(design, 'insert_m3', Math.max(1, inserts10), `${m3} heat-set threads at loaded joints`)
  }
  if (m2 > 0 && !design.parts.some((p) => p.key === 'm2_screws')) {
    addPart(design, 'm2_screws', 1, `${m2} micro screws`)
  }
  if (boards > 0 && !design.parts.some((p) => p.key === 'standoff_m3')) {
    addPart(design, 'standoff_m3', 1, `${boards} boards off the deck`)
  }
}

/** Everything the UI and every export reads. Pure: design in, numbers out. */
/**
 * Will each printed part fit the printer? The old check compared the whole
 * machine's bounding box to 256mm, which is wrong for anything built from
 * pieces: a 400mm rover prints fine, and a 300mm single part does not.
 */
/** "rail-r-1x1of2x1" is a machine's name for a part; people need another. */
function prettyPart(id) {
  const tokens = String(id).split('-').filter((t) => t && !/^\d+x\d+of\d+x\d+$/.test(t) && !/^joiner$/.test(t) && !/^\d+$/.test(t))
  const words = { f: 'front', b: 'rear', l: 'left', r: 'right', x: 'x', y: 'y' }
  return tokens.map((t) => words[t] || t.replace(/_/g, ' ')).join(' ')
}

function printFit(design, bedMm) {
  const bed = Math.max(100, Math.min(600, Math.round(bedMm || 256)))
  const margin = 8 // you cannot print edge to edge
  const usable = bed - margin
  const printed = design.nodes.filter((n) => n.print || n.mat === 'shell')
  const rows = printed.map((n) => {
    const b = boundsOf([n])
    const dims = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v) => Math.round(v * 10) / 10)
    const largest = Math.max(...dims)
    return { id: n.id, name: prettyPart(n.id), dims, largest, fits: largest <= usable, over: Math.round(largest - usable) }
  }).sort((a, b) => b.largest - a.largest)
  const worst = rows[0] || null
  return { bed, usable, rows, worst, fitsAll: rows.every((r) => r.fits), count: rows.length }
}

/**
 * Servo-lead harness check. Every driven joint's pivot is a world position at
 * rest pose, so the wire run back to the electrical home (centroid of the root
 * joints — where the driver/bus lives) is measurable, not guessed. Stock servo
 * leads are 180–300mm; a wrist 380mm from the base genuinely cannot reach.
 * 1.35× slack covers the route along the structure, not through air.
 */
function harnessAnalysis(design) {
  const joints = (design.joints || []).filter((j) => j.pivot)
  const servoParts = (design.parts || []).map(({ key }) => PARTS[key]).filter((p) => p && p.cat === 'servo')
  if (!joints.length || !servoParts.length) return null
  const leads = servoParts
    .map((p) => { const m = /(\d+)\s*mm\s*lead/i.exec(p.conn || ''); return m ? +m[1] : null })
    .filter((v) => v != null)
  const busOnly = servoParts.every((p) => /daisy|bus/i.test(p.conn || ''))
  const minLead = leads.length ? Math.min(...leads) : null
  const maxLead = leads.length ? Math.max(...leads) : null
  const roots = joints.filter((j) => j.parent == null)
  // A lone joint's pivot is the joint itself, not the bay — for single-axis
  // machines the driver lives in the body, so home is the footprint centre.
  let home
  if (joints.length === 1) {
    const bb = boundsOf(design.nodes)
    home = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, bb.min[2] + 10]
  } else {
    home = roots.length
      ? [0, 1, 2].map((i) => roots.reduce((s, j) => s + j.pivot[i], 0) / roots.length)
      : joints[0].pivot
  }
  // Voltage drop on a stock 26AWG servo lead (~0.13Ω/m, out and back), at the
  // largest servo stall current in the BOM — the sag a far joint actually sees.
  const peakA = Math.max(0.5, ...servoParts.map((p) => (p.curr && p.curr.peak) || 0))
  const R_PER_M = 0.26 // 26AWG out-and-back
  const rows = joints.map((j) => {
    const d = Math.hypot(j.pivot[0] - home[0], j.pivot[1] - home[1], j.pivot[2] - home[2])
    const run = Math.round(d * 1.35)
    const lead = busOnly ? 'daisy-chain'
      : minLead == null ? 'unknown'
      : run <= minLead ? 'stock'
      : run <= maxLead ? 'check'
      : 'extend'
    const vdrop = +(peakA * R_PER_M * (run / 1000)).toFixed(3)
    return { id: j.id, label: j.label, run, lead, vdrop }
  })
  const worst = rows.reduce((a, b) => (b.run > (a ? a.run : -1) ? b : a), null)
  const needExt = rows.filter((r) => r.lead === 'extend').length
  const dropBad = rows.filter((r) => r.vdrop > 0.5)
  return {
    home, rows, worst, needExt, dropBad,
    minLead, maxLead, busOnly,
    note: busOnly
      ? 'Servos are on a daisy-chained TTL bus — signal runs joint to joint; only the power taps need to reach home.'
      : `Stock leads are ${minLead}–${maxLead}mm. Runs include 35% routing slack.`,
  }
}

/**
 * Desk-prop reach proof. The reach bound is an outer sphere — a prop inside
 * it can still be unreachable at EVERY joint angle (a waist-yaw root inflates
 * the sphere without adding vertical reach, for instance). Probe each prop's
 * top face with the same multi-seed CCD the workspace map uses; a prop counts
 * unreachable only when every sample misses by ≥12mm — the solver's own
 * convergence threshold, so "reachable" here means the same thing it means
 * on the bench overlay.
 */
function deskUnreachableProps(design, tip, bound) {
  const { tipChain, tipNode } = tip
  const scratch = { ...design, joints: (design.joints || []).map((j) => ({ ...j })) }
  const byId = new Map(scratch.joints.map((j) => [j.id, j]))
  const ikChain = tipChain.map((j) => byId.get(j.id)).filter(Boolean)
  if (ikChain.length < 3) return []
  const chains = chainsFor(scratch)
  const tipW = () => benchNodeWorld(scratch, chains, tipNode)
  const frac = (f) => scratch.joints.map((j) => j.min + (j.max - j.min) * f)
  const seeds = [frac(0.5), frac(0.15), frac(0.85), scratch.joints.map(() => 0)]
  const out = []
  for (const p of DESK_PROPS) {
    // a prop the sphere already proves unreachable is the sphere path's
    // problem — probing it here would be wasted solves
    const dx = Math.max(Math.abs(p.pos[0] - bound.c[0]) - p.size[0] / 2, 0)
    const dy = Math.max(Math.abs(p.pos[1] - bound.c[1]) - p.size[1] / 2, 0)
    const dz = Math.max(Math.abs(p.pos[2] - bound.c[2]) - p.size[2] / 2, 0)
    if (Math.hypot(dx, dy, dz) - bound.r > 0) continue
    // centre first, then the top-face ring: one reachable point clears the prop
    const pts = [[0, 0], [-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8], [-0.8, 0], [0.8, 0], [0, -0.8], [0, 0.8]]
    let bestErr = Infinity, reached = false
    for (const [fx, fy] of pts) {
      if (reached) break
      const t = [p.pos[0] + fx * p.size[0] / 2, p.pos[1] + fy * p.size[1] / 2, p.pos[2] + p.size[2] / 2]
      for (const seed of seeds) {
        seed.forEach((a, k) => { scratch.joints[k].angle = a })
        const r = solveChainIK(scratch, ikChain, t, tipW, 14)
        if (r.err < bestErr) bestErr = r.err
        if (r.err < 12) { reached = true; break }
      }
    }
    if (!reached) out.push({ id: p.id, name: p.name, miss: Math.round(bestErr) })
  }
  return out
}

function analyze(design) {
  autoFasteners(design) // before pinMap so fasteners land in the BOM/CSV once
  const pins = pinMap(design)
  const power = powerBudget(design)
  // A scene is several independent machines, not one bus: each member already
  // passed its own power/pin/harness checks inside composeDesign, so the merged
  // totals must not be judged against a single pack or a single MCU.
  const isScene = design.archetype === 'scene'
  if (isScene) {
    power.bat = null
    power.runtimeMin = null
    power.wiring = []
    power.systems = (design.parts || []).filter((p) => PARTS[p.key]?.cat === 'battery').length
    design.checks = design.checks || []
    design.checks.push({ level: 'ok', msg: `Scene power: ${power.systems} independent pack(s) — each machine's runtime and wiring are certified in its own report, not summed onto one bus.` })
  }
  const harness = isScene ? (design._sceneHarness || null) : harnessAnalysis(design)
  // A joint the stock lead cannot reach is not a note — it is a part you must
  // buy. Put the extension in the BOM so cost and shopping list stay honest.
  if (!isScene && harness && harness.needExt && !design._harnessed) {
    design._harnessed = true
    addPart(design, 'extlead_300', harness.needExt, `${harness.needExt} joint run(s) exceed stock servo lead`)
  }
  const mat = MATERIALS[design.brief.material] || MATERIALS.petg

  let cost = 0
  let costBuy = 0
  let partMassG = 0
  for (const { key, qty } of design.parts) {
    const p = PARTS[key]
    if (!p) continue
    cost += p.price * qty
    // Shop stock (wire, screw kits, standoffs) is bought once and used across
    // builds. Counting it in every project makes a $30 sensor node read as $100.
    if (!p.shop) costBuy += p.price * qty
    // A spool is not consumed by one build — charge the grams used, not $20.
    if (p.print || p.shop) continue
    partMassG += p.mass * qty
  }

  const printMm3 = printedVolume(design.nodes) // already shelled (~34% solid)
  const printGrams = (printMm3 / 1000) * mat.density
  const printHours = printMm3 / 1000 / 18 // ~18cm³/h: 0.4 nozzle, 0.2 layers, real parts
  const spoolCost = (printGrams / 1000) * (PARTS[mat.priceId]?.price || 20)
  cost += spoolCost
  costBuy += spoolCost

  const totalMassG = partMassG + printGrams
  const bbox = boundsOf(design.nodes)
  const dims = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]]

  const checks = [...(design.checks || [])]
  // A brief that named no machine gets a plain sentence, not a silent build.
  if (design.brief && design.brief.archetypeMatched === false) {
    const said = String(design.brief.mission || '').trim()
    checks.push({
      level: 'warn',
      msg: `Your words did not name a machine I build${said ? ` ("${said.slice(0, 40)}")` : ''} — so this is a small enclosure, the simplest thing that fits. Name the kind: rover, arm, quadruped, humanoid, gripper, board, gantry.`,
    })
  }
  // Anything the agent layer had to change on the way in is visible here, not
  // buried in its logs: the studio judges the design it was actually given.
  const adjusted = design.brief && Array.isArray(design.brief._adjusted) ? design.brief._adjusted : []
  if (adjusted.length) {
    checks.push({ level: 'warn', msg: `Handed in with adjustments: ${adjusted.join('; ')}.` })
  }
  if (!isScene && power.bat && power.typ > power.bat.maxA) {
    checks.push({ level: 'fail', msg: `Continuous draw ${fmt(power.typ, 1)}A is over what ${power.bat.name} can deliver (${power.bat.maxA}A) — this pack will sag or trip.` })
  } else if (!isScene && power.bat && power.peak > power.bat.maxA * 2) {
    // Far beyond the pack's burst is not a caution, it is the wrong pack: the
    // protection circuit trips or the cells sag before the machine moves.
    checks.push({
      level: 'fail',
      msg: `Peak ${fmt(power.peak, 1)}A is ${fmt(power.peak / power.bat.maxA, 1)}× the ${power.bat.name}'s ${power.bat.maxA}A burst. This pack cannot run this machine — pick a high-C LiPo (30C+) or put two packs in parallel.`,
    })
  } else if (!isScene && power.bat && power.peak > power.bat.maxA * 1.6) {
    const limitA = Number(design.brief && design.brief.limitA) || 0
    if (limitA > 0 && limitA <= power.bat.maxA) {
      checks.push({
        level: 'ok',
        msg: `Stall/peak is ${fmt(power.peak, 1)}A, but the driver is limited to ${fmt(limitA, 1)}A in firmware — a jam is clamped below the pack's ${power.bat.maxA}A burst instead of browning out the MCU. Stalls now arrive as a stall warning, not a reboot.`,
      })
    } else {
      checks.push({
        level: 'warn',
        fix: { id: 'current-limit', label: `Limit to ${fmt(power.bat.maxA * 0.8, 0)}A`, patch: { limitA: Math.round(power.bat.maxA * 0.8 * 10) / 10 } },
        msg: `Stall/peak ${fmt(power.peak, 1)}A exceeds the pack's ${power.bat.maxA}A burst — add a current limit so a jam does not brown out the MCU.`,
      })
    }
  }
  if (!isScene && power.bat && power.runtimeMin != null && power.runtimeMin < 10 && design.archetype !== 'gadget') {
    checks.push({ level: 'warn', msg: `Runtime is ${Math.round(power.runtimeMin)} min at typical load — use a bigger pack or a tethered supply.` })
  }
  if (!isScene && pins.used > pins.mcu.pinBudget) {
    checks.push({ level: 'fail', msg: `Pin map wants ${pins.used} GPIO, ${pins.mcu.name} exposes ${pins.mcu.pinBudget}. Move the motors to an I2C driver or drop a sensor.` })
  }
  if (printGrams > 900) {
    checks.push({ level: 'warn', msg: `${Math.round(printGrams)}g of filament — that is most of a spool and ${fmt(printHours, 0)}h of printing.` })
  }
  const fit = printFit(design, design.brief && design.brief.bedMm)
  if (fit.count && fit.worst && !fit.worst.fits) {
    // A part that does not fit cannot be printed, so this is a failure, not a
    // note. Load-bearing links are deliberately not auto-split: gluing a
    // cantilever is worse engineering than telling the user to use a bigger bed.
    checks.push({
      level: 'fail',
      msg: `The ${fit.worst.name} is ${fit.worst.largest}mm on its longest side — ${fit.worst.over}mm too big for a ${fit.bed}mm bed. Print this machine on a ${Math.ceil((fit.worst.largest + 16) / 10) * 10}mm bed or larger, or redesign that part as a two-piece bolted joint.`,
    })
  } else if (fit.count) {
    checks.push({ level: 'ok', msg: `Every printed part fits a ${fit.bed}mm bed — the largest is the ${fit.worst.name} at ${fit.worst.largest}mm.` })
  }
  // the pack as a whole: per-part fit is not plate fit. Two honest cases —
  // parts that can't sit on ANY plate (split or bigger bed), and packs that
  // simply need more than one print job (per-plate 3MFs ship in the ZIP).
  const pack = packBedLayout(design, design.brief && design.brief.bedMm)
  if (pack.items.length && pack.offBed) {
    checks.push({
      level: 'warn',
      msg: `${pack.offBed} of ${pack.items.length} printed parts are bigger than the ${pack.bed}mm bed's usable square — they can't print on any plate. Split them in CAD or pick a bigger bed.`,
    })
  } else if (pack.items.length && pack.plates > 1) {
    checks.push({
      level: 'warn',
      msg: `The print pack needs ~${pack.plates} plates on a ${pack.bed}mm bed — ${pack.items.length} parts in batches. The print-pack ZIP ships one ready-to-slice 3MF per plate.`,
    })
  } else if (pack.items.length) {
    checks.push({ level: 'ok', msg: `All ${pack.items.length} printed parts fit a single ${pack.bed}mm plate.` })
  }
  const overhang = overhangReport(design)
  if (overhang.unsupportedMm2 > 150) {
    const w = overhang.worst
    checks.push({
      level: 'warn',
      msg: `${overhang.unsupportedMm2}mm² of printed surface hangs in mid-air with nothing under it — the slicer will need support material (${prettyPart(w.id)} is the worst at ${w.unsupported}mm²). Reorient the part, add a rib, or accept the support scars.`,
    })
  } else if (overhang.unsupportedMm2 > 0) {
    checks.push({ level: 'ok', msg: `Overhang check: only ${overhang.unsupportedMm2}mm² needs support — mostly self-supporting geometry.` })
  } else {
    checks.push({ level: 'ok', msg: 'Overhang check: every printed face has material or the bed underneath — no support needed.' })
  }
  if (overhang.brim && overhang.brim.length) {
    const names = overhang.brim.slice(0, 3).map((p) => `${prettyPart(p.id)} (${Math.round(p.contact * 100)}%)`).join(', ')
    // A warning you cannot act on is a fact, not advice. Applying the fix sets
    // brief.brim, which travels into the print pack and the spec — so the ack
    // here is a claim about a real artefact, not a dismissed banner.
    if (design.brief && design.brief.brim) {
      checks.push({
        level: 'ok',
        msg: `Brim enabled in the print pack for ${overhang.brim.length} part(s) — ${names}. The 3MF and the spec sheet both carry the setting.`,
      })
    } else {
      checks.push({
        level: 'warn',
        fix: { id: 'brim', label: 'Add a brim', patch: { brim: true } },
        msg: `${overhang.brim.length} part(s) touch the bed on under 30% of their footprint — ${names}. Give the slicer a brim or raft, or the first layer can lift mid-print.`,
      })
    }
  }
  const wall = wallReport(design)
  if (wall.thin.length) {
    const names = wall.thin.slice(0, 3).map((p) => `${prettyPart(p.id)} (~${p.p10}mm)`).join(', ')
    checks.push({
      level: 'warn',
      msg: `${wall.thin.length} printed part(s) measure under ${wall.minWall}mm walls — ${names}. Three 0.4mm nozzle lines need ~1.2mm; thinner walls print as a skin that strings or splits. Thicken the wall or switch to a finer nozzle.`,
    })
  } else if (wall.parts.length) {
    checks.push({ level: 'ok', msg: `Wall check: every printed part holds ≥${wall.minWall}mm walls — thinnest reads ~${wall.thinnest}mm.` })
  }
  const interference = interferenceReport(design)
  if (interference.count) {
    const names = interference.pairs.slice(0, 3).map((p) => `${prettyPart(p.a)} × ${prettyPart(p.b)}`).join(', ')
    checks.push({
      level: 'warn',
      msg: `${interference.count} printed part pair(s) occupy the same space at rest pose — deepest ~${interference.pairs[0].depth}mm (${names}${interference.count > 3 ? '…' : ''}). Each STL prints fine alone, but they can't be assembled as modeled — trim the overlap, pocket one part, or offset the joint.`,
    })
  }
  if (harness && harness.needExt) {
    checks.push({
      level: 'warn',
      msg: `${harness.needExt} joint(s) sit beyond the longest stock servo lead (${harness.maxLead}mm) — ${harness.worst.label} runs ~${harness.worst.run}mm home. ${harness.needExt}× 300mm extension lead${harness.needExt > 1 ? 's are' : ' is'} in the BOM; a lead that does not reach is a robot that does not ship.`,
    })
  } else if (harness && harness.dropBad.length) {
    checks.push({
      level: 'warn',
      msg: `${harness.dropBad.length} joint run(s) drop over 0.5V on a stock 26AWG lead at stall current — use a thicker extension or a remote 6V buck at that joint.`,
    })
  } else if (harness) {
    checks.push({ level: 'ok', msg: `Servo harness: all ${harness.rows.length} joints are inside stock lead reach — worst run ${harness.worst.label} ~${harness.worst.run}mm.` })
  }
  // ── drones: thrust margin and hover time ─────────────────────────────────
  // A quad has two numbers that decide whether it flies at all: how much lift
  // four discs make against its own weight, and how many minutes that buys.
  // Both come from momentum theory in droneReport(), not from a lookup table.
  let drone = null
  if (design.drone) {
    drone = droneReport(design.drone, totalMassG)
    const twr = drone.twr
    if (twr < 1.0) {
      checks.push({ level: 'fail', msg: `Lift-to-weight is ${twr.toFixed(2)}:1 — four ${drone.propMm}mm props make ${Math.round(drone.thrustG)}g of thrust for a ${Math.round(totalMassG)}g machine. It cannot leave the ground. Bigger props, more voltage, or less mass.` })
    } else if (twr < 1.5) {
      checks.push({ level: 'warn', msg: `Lift-to-weight is ${twr.toFixed(2)}:1. It will hover, but with almost no control authority — a quad wants 2:1 minimum and 3:1 to handle wind.` })
    } else {
      checks.push({ level: 'ok', msg: `Lift-to-weight ${twr.toFixed(1)}:1 — four ${drone.propMm}mm props make ${Math.round(drone.thrustG)}g for a ${Math.round(totalMassG)}g machine, hovering at ${Math.round(drone.hoverThrottle * 100)}% throttle.` })
    }
    // Momentum theory assumes the disc reaches its geometric pitch speed. A real
    // motor is loaded down by the prop and never gets there, so the model is
    // optimistic by a margin that grows with disc size. Past 8:1 the honest
    // reading is "this is a ceiling, not a spec" — say so where it is claimed.
    if (twr > 8) {
      checks.push({ level: 'warn', msg: `Lift-to-weight reads ${twr.toFixed(1)}:1, which is above what hobby hardware reaches (${drone.propMm}mm props on this pack). The figure is momentum theory at geometric pitch speed — motor loading is not modelled, so treat ${Math.round(drone.thrustG)}g as an upper bound, not a measured thrust.` })
    }
    if (drone.hoverThrottle > 0.75) {
      checks.push({ level: 'warn', msg: `Hover sits at ${Math.round(drone.hoverThrottle * 100)}% throttle — almost no headroom left for gusts or climb. Either the props are too small for this mass or the pack is sagging.` })
    }
    if (drone.minutes < 3) {
      checks.push({ level: 'warn', msg: `Hover endurance is ${drone.minutes.toFixed(1)} min on ${design.drone.mah}mAh — short even for FPV. A bigger pack costs mass, which costs hover power: check the trade before buying.` })
    } else {
      checks.push({ level: 'ok', msg: `Hover endurance ${drone.minutes.toFixed(1)} min at ${drone.hoverAmps.toFixed(1)}A on ${design.drone.mah}mAh (80% usable), drawing ${Math.round(drone.hoverWatts)}W.` })
    }
  }

  if (!checks.some((c) => c.level === 'fail')) {
    checks.unshift({ level: 'ok', msg: 'Sizing checks pass: torque, peak current, pin budget and print volume are all inside limits.' })
  }

  // hand the reviewed total back to the design object, so the bench and any
  // later CoM pass can agree with the BOM instead of summing geometry
  design.massTotalG = totalMassG
  return {
    printFit: fit,
    pins,
    power,
    harness,
    reach: (() => {
      const whole = armTipChain(design)
      const tip = whole || armChainFor(design, 'r')
      const b = armReachBound(tip)
      // multi-limb fallback: the bound describes ONE arm, say which
      const out = b && !whole ? { ...b, side: 'r' } : b
      // the sphere is an outer bound, not a reachability proof — IK-probe the
      // desk props so fix suggestions can tell "inside but unreachable" apart
      if (out && tip) out.unreachable = deskUnreachableProps(design, tip, out)
      return out
    })(),
    cost,
    costBuy,
    costShop: cost - costBuy,
    spoolCost,
    print: { grams: printGrams, hours: printHours, mm3: printMm3, material: mat, overhang, pack, wall, interference },
    mass: { totalG: totalMassG, printedG: printGrams, partsG: partMassG },
    drone,
    dims,
    checks,
    mcu: pins.mcu,
  }
}

/** Axis-aligned half extents for every node kind the engine emits. */
function nodeHalf(n) {
  if (n.size) return [n.size[0] / 2, n.size[1] / 2, n.size[2] / 2] // box/rbox/wedge/rack
  if (n.kind === 'sphere') return [n.radius, n.radius, n.radius]
  if (n.kind === 'ring') {
    return n.axis === 'x' ? [n.height / 2, n.outer, n.outer]
      : n.axis === 'y' ? [n.outer, n.height / 2, n.outer] : [n.outer, n.outer, n.height / 2]
  }
  if (n.kind === 'torus') {
    const R = n.R + n.r
    return n.axis === 'x' ? [n.r, R, R] : n.axis === 'y' ? [R, n.r, R] : [R, R, n.r]
  }
  if (n.kind === 'bend') {
    const e = n.R + n.r // conservative: the arc sweeps a square footprint
    return [e, e, Math.max(n.r, e * 0.6)]
  }
  if (n.kind === 'gear') {
    const tip = (n.module * n.teeth) / 2 + n.module
    const half = n.width / 2
    return n.axis === 'x' ? [half, tip, tip] : n.axis === 'y' ? [tip, half, tip] : [tip, tip, half]
  }
  const r = n.radius || 0
  const h = n.height || r * 2
  return n.axis === 'x' ? [h / 2, r, r] : n.axis === 'y' ? [r, h / 2, r] : [r, r, h / 2]
}

// boundsOf() lives in 40-geometry.js — the one that knows rot'd parts need
// radial bounds. nodeHalf() above is for the print table's per-part dims.
