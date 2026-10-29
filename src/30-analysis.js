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
  const take = (n) => {
    const free = SAFE_PINS.find((p) => !used.has(p))
    if (free == null) return null
    used.add(free)
    return free
  }
  const mcuKey = design.parts.find((p) => PARTS[p.key].cat === 'mcu')?.key || 'esp32s3'
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
        break
      case 'driver':
        if (key === 'pca9685') buses.add('i2c')
        break
      case 'motor':
        for (let i = 0; i < qty; i += 1) {
          const pwm = take()
          const in1 = take()
          const in2 = take()
          rows.push({ pin: String(pwm), signal: `M${i + 1} PWM`, dir: 'out', note: 'LEDC 20kHz' })
          rows.push({ pin: String(in1), signal: `M${i + 1} IN1`, dir: 'out', note: 'direction' })
          rows.push({ pin: String(in2), signal: `M${i + 1} IN2`, dir: 'out', note: 'direction' })
          if (part.encoder) {
            rows.push({ pin: String(take()), signal: `M${i + 1} ENC A`, dir: 'in', note: 'interrupt, pull-up' })
          }
        }
        break
      case 'servo':
        // Servos on a PCA9685 are addressed by CHANNEL, one block for the whole
        // design — per-part emission printed the same channels once per servo type.
        if (!design.parts.some((p) => p.key === 'pca9685')) {
          for (let i = 0; i < qty; i += 1) rows.push({ pin: String(take()), signal: `SERVO ${i + 1}`, dir: 'out', note: '50Hz, 500–2500µs' })
        }
        break
      default:
        break
    }
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
    rows.push({ pin: String(take()), signal: 'TFT CS', dir: 'out', note: '' })
    rows.push({ pin: String(take()), signal: 'TFT DC', dir: 'out', note: '' })
  }
  if (buses.has('uart1')) {
    rows.push({ pin: '17', signal: 'GPS TX→RX', dir: 'in', note: '9600 baud NMEA' })
    rows.push({ pin: '18', signal: 'GPS RX→TX', dir: 'out', note: '' })
  }
  if (buses.has('i2s-in') || buses.has('i2s-out')) {
    rows.push({ pin: String(I2S.bclk), signal: 'I2S BCLK', dir: 'out', note: '' })
    rows.push({ pin: String(I2S.lrclk), signal: 'I2S LRCLK', dir: 'out', note: '' })
    rows.push({ pin: String(I2S.din), signal: 'I2S DIN', dir: 'in', note: 'mic data' })
    if (buses.has('i2s-out')) rows.push({ pin: String(I2S.dout), signal: 'I2S DOUT', dir: 'out', note: 'amp data' })
  }
  if (design.archetype === 'gadget') {
    rows.push({ pin: String(take()), signal: 'KNOB', dir: 'in', note: 'ADC1, 12-bit' })
    rows.push({ pin: String(take()), signal: 'BUTTON', dir: 'in', note: 'INPUT_PULLUP' })
  }

  return { rows, mcu, mcuKey, safePins: SAFE_PINS.length, used: used.size }
}

/** Power budget: rails, peak, typical, and what the pack can actually do. */
function powerBudget(design) {
  const rails = { '3V3': { typ: 0, peak: 0, items: [] }, '5V': { typ: 0, peak: 0, items: [] }, motor: { typ: 0, peak: 0, items: [] } }
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    if (!p || !p.curr) continue
    const rail = p.cat === 'motor' || p.cat === 'servo' ? (p.volts >= 7 ? 'motor' : '5V') : '3V3'
    rails[rail].typ += p.curr.typ * qty
    rails[rail].peak += p.curr.peak * qty
    rails[rail].items.push({ key, qty, role, typ: p.curr.typ * qty, peak: p.curr.peak * qty })
  }
  const battery = design.parts.find((p) => PARTS[p.key].cat === 'battery')
  const bat = battery ? PARTS[battery.key] : null
  const typ = rails['3V3'].typ + rails['5V'].typ + rails.motor.typ
  const peak = rails['3V3'].peak + rails['5V'].peak + rails.motor.peak
  const runtime = bat && bat.mah > 0 ? ((bat.mah / 1000) * 0.8 * 60) / typ : null
  return { rails, typ, peak, battery: battery?.key || null, bat, runtimeMin: runtime }
}

/** Everything the UI and every export reads. Pure: design in, numbers out. */
function analyze(design) {
  const pins = pinMap(design)
  const power = powerBudget(design)
  const mat = MATERIALS[design.brief.material] || MATERIALS.petg

  let cost = 0
  let partMassG = 0
  for (const { key, qty } of design.parts) {
    const p = PARTS[key]
    if (!p) continue
    cost += p.price * qty
    // A spool is not consumed by one build — charge the grams used, not $20.
    if (p.print) continue
    partMassG += p.mass * qty
  }

  const printMm3 = printedVolume(design.nodes) // already shelled (~34% solid)
  const printGrams = (printMm3 / 1000) * mat.density
  const printHours = printMm3 / 1000 / 18 // ~18cm³/h: 0.4 nozzle, 0.2 layers, real parts
  const spoolCost = (printGrams / 1000) * (PARTS[mat.priceId]?.price || 20)
  cost += spoolCost

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
  if (dims.some((x) => x > 256)) {
    checks.push({ level: 'warn', msg: `Longest dimension ${Math.round(Math.max(...dims))}mm: split the print or check your bed (256mm is typical).` })
  }
  if (!checks.some((c) => c.level === 'fail')) {
    checks.unshift({ level: 'ok', msg: 'Sizing checks pass: torque, peak current, pin budget and print volume are all inside limits.' })
  }

  return {
    pins,
    power,
    cost,
    spoolCost,
    print: { grams: printGrams, hours: printHours, mm3: printMm3, material: mat },
    mass: { totalG: totalMassG, printedG: printGrams, partsG: partMassG },
    dims,
    checks,
    mcu: pins.mcu,
  }
}

function boundsOf(nodes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const n of nodes) {
    const half = n.kind === 'box'
      ? [n.size[0] / 2, n.size[1] / 2, n.size[2] / 2]
      : n.axis === 'x' ? [n.height / 2, n.radius, n.radius]
        : n.axis === 'y' ? [n.radius, n.height / 2, n.radius]
          : [n.radius, n.radius, n.height / 2]
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], n.pos[i] - half[i])
      max[i] = Math.max(max[i], n.pos[i] + half[i])
    }
  }
  return { min, max }
}
