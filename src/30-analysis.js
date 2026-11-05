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
  const wiring = Object.entries(rails)
    .filter(([, v]) => v.peak > 0.01)
    .map(([name, v]) => ({
      rail: railLabel[name] || name,
      amps: Math.max(v.typ, 0.05),
      peak: v.peak,
      awg: wireFor(name === '3V3' ? Math.max(v.typ, 0.1) : v.peak * 0.8),
      fuse: name === '3V3' ? null : fuseFor(Math.max(v.typ, 0.1)),
      conn: name === '3V3' ? 'JST-PH / Dupont' : v.peak > 12 ? 'XT60 + ring or barrier' : 'XT30 / JST-XH',
    }))

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

function analyze(design) {
  autoFasteners(design) // before pinMap so fasteners land in the BOM/CSV once
  const pins = pinMap(design)
  const power = powerBudget(design)
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
  if (power.bat && power.typ > power.bat.maxA) {
    checks.push({ level: 'fail', msg: `Continuous draw ${fmt(power.typ, 1)}A is over what ${power.bat.name} can deliver (${power.bat.maxA}A) — this pack will sag or trip.` })
  } else if (power.bat && power.peak > power.bat.maxA * 1.6) {
    checks.push({ level: 'warn', msg: `Stall/peak ${fmt(power.peak, 1)}A exceeds the pack's ${power.bat.maxA}A burst — add a current limit so a jam does not brown out the MCU.` })
  }
  if (power.bat && power.runtimeMin != null && power.runtimeMin < 10 && design.archetype !== 'gadget') {
    checks.push({ level: 'warn', msg: `Runtime is ${Math.round(power.runtimeMin)} min at typical load — use a bigger pack or a tethered supply.` })
  }
  if (pins.used > pins.mcu.pinBudget) {
    checks.push({ level: 'fail', msg: `Pin map wants ${pins.used} GPIO, ${pins.mcu.name} exposes ${pins.mcu.pinBudget}. Move the motors to an I2C driver or drop a sensor.` })
  }
  if (printGrams > 900) {
    checks.push({ level: 'warn', msg: `${Math.round(printGrams)}g of filament — that is most of a spool and ${fmt(printHours, 0)}h of printing.` })
  }
  const fit = printFit(design, design.brief && design.brief.bedMm)
  if (fit.count && fit.worst && !fit.worst.fits) {
    checks.push({
      level: 'warn',
      msg: `The ${fit.worst.name} is ${fit.worst.largest}mm on its longest side — ${fit.worst.over}mm too big for a ${fit.bed}mm bed. Split it, or set your bed size under MORE OPTIONS.`,
    })
  } else if (fit.count) {
    checks.push({ level: 'ok', msg: `Every printed part fits a ${fit.bed}mm bed — the largest is the ${fit.worst.name} at ${fit.worst.largest}mm.` })
  }
  if (!checks.some((c) => c.level === 'fail')) {
    checks.unshift({ level: 'ok', msg: 'Sizing checks pass: torque, peak current, pin budget and print volume are all inside limits.' })
  }

  return {
    printFit: fit,
    pins,
    power,
    cost,
    costBuy,
    costShop: cost - costBuy,
    spoolCost,
    print: { grams: printGrams, hours: printHours, mm3: printMm3, material: mat },
    mass: { totalG: totalMassG, printedG: printGrams, partsG: partMassG },
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
