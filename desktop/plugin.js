/**
 * RIGFORGE — the build studio for robots and printed machines.
 *
 * Schematik answers "what circuits do I wire". Rigforge answers the harder
 * question: "what do I BUILD" — a complete machine, spec'd end to end:
 *
 *   brief → archetype + geometry (posed, orbitable, STL-exportable)
 *         → joint/motor sizing (torque, not vibes)
 *         → power budget (peak current → battery → runtime)
 *         → MCU pin map that respects real ESP32 strap/flash/ADC rules
 *         → firmware skeleton that matches the pin map
 *         → BOM with cost, mass and print time
 *         → assembly order
 *
 * WHY A PLUGIN, AND WHY DESKTOP-ONLY
 * Core has no mechanical/electrical design surface, and nothing in core
 * generates geometry, sizes a servo or exports a mesh. The SDK reaches
 * everything this needs (`ctx.storage` for the shelf, `host.composer` to hand a
 * spec to the agent, `TRANSCRIPT_DIRECTIVE_AREA` so the AGENT can hand a build
 * back into the studio by writing `::rigforge{...}`). No backend is shipped, so
 * the reachable doors are the ones used — nothing here depends on an app REST
 * route.
 *
 * The engine is deterministic and offline: the same brief always yields the
 * same machine, and the numbers are computed (torque, current, mass, runtime),
 * never narrated. The agent is the *designer*, not the calculator.
 */
import { PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, TRANSCRIPT_DIRECTIVE_AREA, host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ROUTE = '/rigforge'
const G = 9.80665

// ── the parts engine ────────────────────────────────────────────────────────
// A real, small catalogue. Every entry carries the numbers the sizing maths
// needs — stall torque, peak current, mass, price — so the analysis can pick a
// component instead of the author hardcoding one.
//
//   torque: N·m (stall, at rated voltage)
//   curr:   {idle, typ, peak} in AMPS at the part's own voltage
//   mass:   grams
//   price:  USD, single unit, 2026 maker pricing (order-of-magnitude honest)

const PARTS = {
  // ── MCUs ──────────────────────────────────────────────────────────────────
  esp32s3: {
    name: 'ESP32-S3 DevKitC-1',
    cat: 'mcu', price: 14, mass: 10, volts: 5, logic: 3.3,
    curr: { idle: 0.04, typ: 0.13, peak: 0.55 },
    pinBudget: 44, adcPins: 20, pwmPins: 8,
    features: ['wifi', 'ble', 'usb', 'psram'],
    note: '16MB flash / 8MB PSRAM. 3.3V logic, 5V VIN.',
  },
  esp32c6: {
    name: 'ESP32-C6 DevKit',
    cat: 'mcu', price: 11, mass: 9, volts: 5, logic: 3.3,
    curr: { idle: 0.035, typ: 0.11, peak: 0.45 },
    pinBudget: 30, adcPins: 7, pwmPins: 6,
    features: ['wifi6', 'ble', 'thread', 'zigbee'],
    note: 'Thread/Zigbee for home automation. Fewer GPIO — plan for an expander.',
  },
  pico: {
    name: 'Raspberry Pi Pico 2 (RP2350)',
    cat: 'mcu', price: 6, mass: 3, volts: 5, logic: 3.3,
    curr: { idle: 0.02, typ: 0.06, peak: 0.25 },
    pinBudget: 26, adcPins: 3, pwmPins: 16,
    features: ['pio', 'usb'],
    note: 'No radio. PIO blocks are excellent for encoders and LED timing.',
  },

  // ── actuators ─────────────────────────────────────────────────────────────
  sg90: {
    name: 'SG90 micro servo',
    cat: 'servo', price: 3.5, mass: 9, volts: 5, torque: 0.18,
    curr: { idle: 0.008, typ: 0.15, peak: 0.75 }, angle: 180, speed: 0.1,
    note: 'Plastic gears. Fine for a head pan, not for a load-bearing joint.',
  },
  mg90s: {
    name: 'MG90S metal-gear micro',
    cat: 'servo', price: 5, mass: 13.4, volts: 5, torque: 0.22,
    curr: { idle: 0.008, typ: 0.18, peak: 0.9 }, angle: 180, speed: 0.1,
    note: 'Metal gears, same footprint as SG90 — the default small joint.',
  },
  mg996r: {
    name: 'MG996R standard servo',
    cat: 'servo', price: 12, mass: 55, volts: 6, torque: 1.08,
    curr: { idle: 0.01, typ: 0.4, peak: 2.5 }, angle: 180, speed: 0.17,
    note: '11 kg·cm at 6V. Never power from the MCU 5V pin — brownout city.',
  },
  ds3218: {
    name: 'DS3218 20kg servo',
    cat: 'servo', price: 18, mass: 60, volts: 6.8, torque: 1.96,
    curr: { idle: 0.012, typ: 0.6, peak: 3.0 }, angle: 270, speed: 0.16,
    note: '20 kg·cm, metal case. Wants a dedicated 6–7.4V rail.',
  },
  sts3215: {
    name: 'Feetech STS3215 serial bus servo',
    cat: 'servo', price: 28, mass: 62, volts: 7.4, torque: 2.94,
    curr: { idle: 0.01, typ: 0.45, peak: 2.0 }, angle: 360, speed: 0.22,
    bus: 'ttl-half-duplex',
    note: 'Daisy-chained TTL bus + magnetic encoder: 6 wires for 12 joints.',
  },
  n20_100: {
    name: 'N20 gearmotor 6V 100rpm',
    cat: 'motor', price: 6, mass: 10, volts: 6, torque: 0.05,
    curr: { idle: 0.01, typ: 0.15, peak: 1.2 }, speed: 100, encoder: false,
    note: 'Tiny. Good for a light rover, not for a hill.',
  },
  n20_enc: {
    name: 'N20 gearmotor 6V 150rpm + encoder',
    cat: 'motor', price: 14, mass: 12, volts: 6, torque: 0.06,
    curr: { idle: 0.01, typ: 0.18, peak: 1.3 }, speed: 150, encoder: true,
    note: '7 PPR magnetic encoder — closed-loop odometry on a budget.',
  },
  jgb37: {
    name: 'JGB37-520 12V 178rpm + encoder',
    cat: 'motor', price: 22, mass: 108, volts: 12, torque: 1.18,
    curr: { idle: 0.05, typ: 0.5, peak: 2.6 }, speed: 178, encoder: true,
    note: 'The realistic rover motor: 12 kg·cm and a real 11 PPR encoder.',
  },
  nema17: {
    name: 'NEMA17 42-40 stepper',
    cat: 'motor', price: 14, mass: 280, volts: 12, torque: 0.4,
    curr: { idle: 0.2, typ: 0.8, peak: 1.5 }, speed: 200, encoder: false,
    note: 'Open-loop but repeatable — the right choice for a positioner axis.',
  },

  // ── power & drivers ───────────────────────────────────────────────────────
  pca9685: {
    name: 'PCA9685 16-ch PWM driver',
    cat: 'driver', price: 6, mass: 6, volts: 5,
    curr: { idle: 0.006, typ: 0.01, peak: 0.02 },
    note: 'I2C 0x40. One board drives 16 servos off its own screw terminal.',
  },
  tb6612: {
    name: 'TB6612FNG dual motor driver',
    cat: 'driver', price: 4, mass: 3, volts: 5,
    curr: { idle: 0.002, typ: 0.005, peak: 0.02 }, ampacity: 1.2,
    note: 'Two channels, 1.2A continuous. Silent PWM, unlike the L298N.',
  },
  bts7960: {
    name: 'BTS7960 43A motor driver',
    cat: 'driver', price: 9, mass: 22, volts: 5,
    curr: { idle: 0.01, typ: 0.02, peak: 0.05 }, ampacity: 43,
    note: 'For gearmotors whose stall current would cook a TB6612.',
  },
  drv8825: {
    name: 'DRV8825 stepper driver',
    cat: 'driver', price: 5, mass: 4, volts: 5,
    curr: { idle: 0.01, typ: 0.02, peak: 0.03 }, ampacity: 1.5,
    note: 'Set Vref before you connect the motor. Always.',
  },
  buck5a: {
    name: 'UBEC 5V 5A (buck)',
    cat: 'power', price: 7, mass: 18, volts: 12,
    curr: { idle: 0.005, typ: 0.01, peak: 0.02 },
    note: 'Servo rail from a 2S/3S pack. Gives the MCU a clean 5V too.',
  },
  lm2596: {
    name: 'LM2596 buck module',
    cat: 'power', price: 3, mass: 12, volts: 12,
    curr: { idle: 0.005, typ: 0.01, peak: 0.015 },
    note: '3A max in theory, ~2A before it gets hot. Fine for logic.',
  },

  // ── energy ────────────────────────────────────────────────────────────────
  pack2s: {
    name: '2S 18650 pack 3000mAh (7.4V)',
    cat: 'battery', price: 18, mass: 100, volts: 7.4, mah: 3000, maxA: 6,
    note: 'With a protection board and an XT60. The default small-robot pack.',
  },
  pack3s: {
    name: '3S 18650 pack 2500mAh (11.1V)',
    cat: 'battery', price: 22, mass: 140, volts: 11.1, mah: 2500, maxA: 8,
    note: 'Pair with a 5V UBEC; the 12V motors will thank you.',
  },
  lipo2s: {
    name: 'LiPo 2S 1000mAh 30C',
    cat: 'battery', price: 14, mass: 60, volts: 7.4, mah: 1000, maxA: 30,
    note: 'Light and punchy. Needs a proper balance charger and a LiPo bag.',
  },
  lipo3s: {
    name: 'LiPo 3S 2200mAh 30C',
    cat: 'battery', price: 25, mass: 180, volts: 11.1, mah: 2200, maxA: 40,
    note: 'Enough burst for 12 servos. Do not leave it charged in a drawer.',
  },
  pd5v: {
    name: 'USB-C PD trigger 5V/3A',
    cat: 'battery', price: 8, mass: 20, volts: 5, mah: 0, maxA: 3,
    note: 'Tethered desk builds: infinite runtime, no charging rituals.',
  },

  // ── sensing ───────────────────────────────────────────────────────────────
  mpu6050: {
    name: 'MPU-6050 IMU', cat: 'sensor', price: 4, mass: 2, volts: 3.3,
    curr: { idle: 0.004, typ: 0.005, peak: 0.006 }, bus: 'i2c',
    note: '6-axis accel+gyro. Drifts; fine for tilt, not for yaw headings.',
  },
  bno085: {
    name: 'BNO085 9-DoF IMU', cat: 'sensor', price: 22, mass: 3, volts: 3.3,
    curr: { idle: 0.012, typ: 0.015, peak: 0.02 }, bus: 'i2c',
    note: 'On-chip fusion — gives you a usable heading out of the box.',
  },
  vl53l0x: {
    name: 'VL53L0X ToF rangefinder', cat: 'sensor', price: 6, mass: 2, volts: 3.3,
    curr: { idle: 0.005, typ: 0.02, peak: 0.04 }, bus: 'i2c',
    note: '2m, millimetre-ish, no acoustic ring. Address is re-programmable.',
  },
  hcsr04: {
    name: 'HC-SR04 ultrasonic', cat: 'sensor', price: 2, mass: 9, volts: 5,
    curr: { idle: 0.002, typ: 0.015, peak: 0.03 },
    note: '5V echo — needs a divider into a 3.3V MCU.',
  },
  as5600: {
    name: 'AS5600 magnetic encoder', cat: 'sensor', price: 5, mass: 2, volts: 3.3,
    curr: { idle: 0.006, typ: 0.01, peak: 0.015 }, bus: 'i2c',
    note: 'Absolute joint angle over 12 bits — how you close the loop on an arm.',
  },
  bme280: {
    name: 'BME280 temp/humidity/pressure', cat: 'sensor', price: 6, mass: 2, volts: 3.3,
    curr: { idle: 0.001, typ: 0.002, peak: 0.003 }, bus: 'i2c',
    note: 'Forget the "feels like" number, the pressure trend is the fun part.',
  },
  inmp441: {
    name: 'INMP441 I2S mic', cat: 'sensor', price: 6, mass: 2, volts: 3.3,
    curr: { idle: 0.002, typ: 0.004, peak: 0.006 }, bus: 'i2s',
    note: 'Digital mic — no ADC noise, straight into I2S DMA.',
  },
  ov2640: {
    name: 'OV2640 camera (ESP32-CAM style)', cat: 'sensor', price: 9, mass: 5, volts: 3.3,
    curr: { idle: 0.03, typ: 0.08, peak: 0.2 }, bus: 'dvp',
    note: 'Wants PSRAM and a stable 3.3V rail; JPEG at 1600x1200 is achievable.',
  },
  gps: {
    name: 'u-blox NEO-6M GPS', cat: 'sensor', price: 12, mass: 12, volts: 3.3,
    curr: { idle: 0.03, typ: 0.045, peak: 0.06 }, bus: 'uart',
    note: 'Needs sky view. Cold fix is 30s+; expect a UART and a 1Hz NMEA stream.',
  },
  pir: {
    name: 'HC-SR501 PIR', cat: 'sensor', price: 3, mass: 10, volts: 5,
    curr: { idle: 0.05, typ: 0.06, peak: 0.07 },
    note: '5V output, 3.3V-safe enough in practice. 3.3V rails make it flaky.',
  },
  hx711: {
    name: 'HX711 + 5kg load cell', cat: 'sensor', price: 9, mass: 30, volts: 5,
    curr: { idle: 0.002, typ: 0.003, peak: 0.005 },
    note: '24-bit bridge amp, ~10Hz. The classic scale front-end.',
  },
  soil: {
    name: 'Capacitive soil moisture probe', cat: 'sensor', price: 4, mass: 8, volts: 3.3,
    curr: { idle: 0.005, typ: 0.006, peak: 0.008 },
    note: 'Capacitive, so it does not corrode in a week like the resistive ones.',
  },

  // ── human interface ───────────────────────────────────────────────────────
  ssd1306: {
    name: 'SSD1306 128x64 OLED', cat: 'display', price: 5, mass: 5, volts: 3.3,
    curr: { idle: 0.01, typ: 0.015, peak: 0.03 }, bus: 'i2c',
    note: 'I2C 0x3C. Two wires, instant readable UI.',
  },
  ili9341: {
    name: '2.8" ILI9341 SPI touch TFT', cat: 'display', price: 15, mass: 25, volts: 3.3,
    curr: { idle: 0.02, typ: 0.04, peak: 0.08 }, bus: 'spi',
    note: '320x240 + XPT2046 touch. Backlight is the real power draw.',
  },
  gc9a01: {
    name: 'GC9A01 1.28" round LCD', cat: 'display', price: 9, mass: 8, volts: 3.3,
    curr: { idle: 0.02, typ: 0.035, peak: 0.06 }, bus: 'spi',
    note: 'Round 240x240 — the "robot face" display.',
  },
  max98357: {
    name: 'MAX98357A I2S amp + 3W speaker', cat: 'display', price: 9, mass: 40, volts: 5,
    curr: { idle: 0.004, typ: 0.05, peak: 0.6 }, bus: 'i2s',
    note: '2.5W into 4Ω. Shares the I2S bus with a mic if you tri-state right.',
  },

  // ── structure & consumables ───────────────────────────────────────────────
  wheel130: {
    name: '130mm off-road wheel + 6mm hub', cat: 'mech', price: 9, mass: 120, volts: 0,
    note: 'Buy the wheel, print only the adapter. Printed tyres on a 3kg robot last a week.',
  },
  bearing608: {
    name: '608ZZ bearing', cat: 'mech', price: 1.2, mass: 12, volts: 0,
    note: '8x22x7mm. The bearing every printed hub is secretly designed around.',
  },
  hw_m3: {
    name: 'M3 hardware kit (screws/nuts/inserts)', cat: 'mech', price: 12, mass: 80, volts: 0,
    note: 'Button-head screws + heat-set inserts. Buy the kit, not the bag.',
  },
  gt2_kit: {
    name: 'GT2 belt + 20T pulleys', cat: 'mech', price: 9, mass: 40, volts: 0,
    note: 'Cheap reduction or a linear axis.',
  },
  pla_kg: {
    name: 'PLA+ filament (1kg)', cat: 'mech', price: 18, mass: 1000, volts: 0, print: true,
    note: 'Stiff, easy, brittle. Fine for brackets, poor for hot cars.',
  },
  petg_kg: {
    name: 'PETG filament (1kg)', cat: 'mech', price: 21, mass: 1000, volts: 0, print: true,
    note: 'Tougher and slightly flexible — the right call for load-bearing prints.',
  },
  jst_kit: {
    name: 'JST-XH + Dupont connector kit', cat: 'mech', price: 10, mass: 60, volts: 0,
    note: 'Crimp, do not twist-and-tape. Your future self is the reviewer.',
  },
  wire22: {
    name: '22AWG silicone wire (6 colours)', cat: 'mech', price: 9, mass: 60, volts: 0,
    note: 'Stranded silicone survives joints that move.',
  },
  xt60: {
    name: 'XT60 connector pair', cat: 'mech', price: 3, mass: 8, volts: 0,
    note: 'The pack interface. Solder the battery side first, one lead at a time.',
  },
}

/** Parts the planner is allowed to pick per joint/motor, smallest first. */
const SERVO_LADDER = ['sg90', 'mg90s', 'mg996r', 'ds3218', 'sts3215']
const MOTOR_LADDER = ['n20_100', 'n20_enc', 'jgb37']

const MCU_KEYS = ['esp32s3', 'esp32c6', 'pico']

const MATERIALS = {
  pla: { name: 'PLA+', density: 1.24, priceId: 'pla_kg', strength: 1 },
  petg: { name: 'PETG', density: 1.27, priceId: 'petg_kg', strength: 1.35 },
}

// ESP32-S3 safe GPIOs for a peripheral bus project. Excluded on purpose:
// 0/3/45/46 strapping, 19/20 USB-JTAG, 26-32 SPI flash/PSRAM, 33-37 octal PSRAM.
const SAFE_PINS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48]
const ADC_PINS = [1, 2, 4, 5, 6, 7, 8, 9]
const STRAP_PINS = [0, 3, 45, 46]

/** Deterministic pseudo-random so a brief always produces the same machine. */
function hashSeed(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const round = (n, step) => Math.round(n / step) * step
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)
const fmt = (n, digits = 1) => Number(n).toFixed(digits)
const money = (n) => '$' + (n >= 100 ? Math.round(n) : Number(n).toFixed(2))

// ── design scratchpad ───────────────────────────────────────────────────────
// Every archetype builds the same shape, so analysis, meshing, rendering and
// export never branch on archetype:
//
//   nodes[]  — geometry (boxes / cylinders) in mm, rest pose, tagged by joint
//   joints[] — serial chain: pivot (rest world), axis, limits, label
//   parts[]  — { key, qty, role } against PARTS
//   notes[]  — design decisions worth showing the user

function newDesign(archetype, brief) {
  return {
    archetype,
    brief,
    title: '',
    subtitle: '',
    nodes: [],
    joints: [],
    metrics: {},
    parts: [],
    notes: [],
    checks: [],
  }
}

function addPart(d, key, qty, role) {
  const found = d.parts.find((p) => p.key === key)
  if (found) {
    found.qty += qty
    // One line item, every job it does: "Wrist pitch · Wrist roll · Gripper".
    if (role && !found.roles.includes(role)) {
      found.roles.push(role)
      found.role = found.roles.join(' · ')
    }
    return
  }
  d.parts.push({ key, qty, role: role || '', roles: role ? [role] : [] })
}

/** Box node. `pos` is the CENTRE. */
function box(d, id, size, pos, mat, extra) {
  d.nodes.push({ id, kind: 'box', size, pos, mat, ...extra })
}

/** Cylinder node, axis is 'x' | 'y' | 'z', `pos` is the CENTRE. */
function cyl(d, id, radius, height, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'cyl', radius, height, pos, axis, mat, ...extra })
}

function joint(d, id, label, axis, pivot, min, max) {
  d.joints.push({ id, label, axis, pivot, angle: 0, min, max })
}

/** mm³ of a node, for mass + print estimates. */
function nodeVolume(node) {
  if (node.kind === 'box') return node.size[0] * node.size[1] * node.size[2]
  return Math.PI * node.radius * node.radius * node.height
}

/**
 * Volume of PRINTED material, modelled the way a slicer sees it: a box is a
 * WALL SHELL (2.4mm) with infill, not a solid block. Treating these as solid
 * is how a 400mm rover ends up "weighing" 2.3kg on paper.
 */
const WALL = 2.4

// Lightening holes, cable routes and motor pockets remove roughly a quarter of
// every large plate — modelled as a cap rather than as cutout geometry.
const LIGHTENING = 0.72

function shellVolume(n) {
  const solid = nodeVolume(n)
  if (n.kind === 'box') {
    const [x, y, z] = n.size
    if (Math.min(x, y, z) <= WALL * 2.2) return solid * LIGHTENING
    const surface = 2 * (x * y + y * z + x * z)
    return Math.min(solid * LIGHTENING, surface * WALL)
  }
  const r = n.radius
  if (r <= WALL * 1.6) return solid
  const tube = Math.PI * (r * r - (r - WALL) * (r - WALL)) * n.height
  const caps = 2 * Math.PI * r * r * WALL * LIGHTENING
  return Math.min(solid * LIGHTENING, tube + caps)
}

function printedVolume(nodes) {
  let v = 0
  for (const n of nodes) if (n.print) v += shellVolume(n)
  return v
}

// ── arm: the canonical robot ────────────────────────────────────────────────
// A serial revolute chain with real proportions and a real torque cascade. The
// servo at each joint is PICKED from the ladder by the load it actually
// carries at full extension — the honesty of the whole app lives in this file.

const ARM_SEG = { w: 46, h: 40 }

function buildArm(brief) {
  const d = newDesign('arm', brief)
  const reach = clamp(brief.reachMm || 450, 180, 1200)
  const payload = clamp(brief.payloadKg || 1, 0.1, 8)
  const dof = clamp(brief.dof || 5, 3, 6)
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000 // g/mm³

  const L1 = reach * 0.42
  const L2 = reach * 0.36
  const L3 = reach * 0.13
  const baseH = 74

  d.title = `${dof}-DoF arm · ${Math.round(reach)}mm reach`
  d.subtitle = `${payload}kg payload · ${mat.name} links`

  // ── base ────────────────────────────────────────────────────────────────
  box(d, 'base-plate', [150, 150, 14], [0, 0, 7], 'accent', { print: true, part: 'plate' })
  cyl(d, 'base-tower', 46, 54, [0, 0, 41], 'z', 'shell', { print: true })
  cyl(d, 'base-bearing', 24, 12, [0, 0, 68], 'z', 'metal', { part: 'bearing608' })

  joint(d, 'yaw', 'Base yaw', 'z', [0, 0, baseH], -170, 170)

  // ── shoulder bracket + upper arm ────────────────────────────────────────
  box(d, 'shoulder-block', [58, ARM_SEG.w, 54], [10, 0, baseH + 20], 'shell', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 22, ARM_SEG.w + 10, [0, 0, baseH], 'y', 'metal', { joint: 'yaw', part: 'bearing608' })

  joint(d, 'shoulder', 'Shoulder pitch', 'y', [0, 0, baseH], -85, 85)

  box(d, 'upper-arm', [L1, ARM_SEG.w, ARM_SEG.h], [L1 / 2, 0, baseH], 'shell', { joint: 'shoulder', print: true })
  cyl(d, 'elbow-hub', 18, ARM_SEG.w + 8, [L1, 0, baseH], 'y', 'metal', { joint: 'shoulder' })

  joint(d, 'elbow', 'Elbow pitch', 'y', [L1, 0, baseH], -140, 140)

  box(d, 'forearm', [L2, ARM_SEG.w - 6, ARM_SEG.h - 4], [L1 + L2 / 2, 0, baseH], 'shell', { joint: 'elbow', print: true })

  // ── wrist stack (only the DOF the brief asks for) ───────────────────────
  let tipX = L1 + L2
  let chain = 'elbow'
  const wristX = L1 + L2

  if (dof >= 4) {
    cyl(d, 'wrist-hub', 15, ARM_SEG.w, [wristX, 0, baseH], 'y', 'metal', { joint: chain })
    joint(d, 'wrist-pitch', 'Wrist pitch', 'y', [wristX, 0, baseH], -110, 110)
    chain = 'wrist-pitch'
    box(d, 'wrist-link', [L3, 36, 32], [wristX + L3 / 2, 0, baseH], 'shell', { joint: chain, print: true })
    tipX = wristX + L3
  }
  if (dof >= 5) {
    joint(d, 'wrist-roll', 'Wrist roll', 'x', [tipX, 0, baseH], -180, 180)
    chain = 'wrist-roll'
    cyl(d, 'collar', 17, 26, [tipX + 13, 0, baseH], 'x', 'accent', { joint: chain, print: true })
    tipX += 26
  }
  if (dof >= 6) {
    joint(d, 'wrist-yaw', 'Tool yaw', 'z', [tipX, 0, baseH], -90, 90)
    chain = 'wrist-yaw'
    box(d, 'tool-flange', [22, 38, 38], [tipX + 11, 0, baseH], 'metal', { joint: chain })
    tipX += 22
  }

  // ── tool: parallel gripper ──────────────────────────────────────────────
  const jawOpen = 18 + payload * 6
  box(d, 'gripper-body', [34, 54, 40], [tipX + 17, 0, baseH], 'accent', { joint: chain, print: true })
  box(d, 'jaw-a', [26, 8, 34], [tipX + 44, -(jawOpen / 2 + 4), baseH], 'metal', { joint: chain })
  box(d, 'jaw-b', [26, 8, 34], [tipX + 44, jawOpen / 2 + 4, baseH], 'metal', { joint: chain })
  tipX += 60

  // ── mass + torque cascade ───────────────────────────────────────────────
  const linkMass = (len) => (len * ARM_SEG.w * ARM_SEG.h * 0.34 * density) // shelled, ~34% solid
  const mUpper = linkMass(L1)
  const mFore = linkMass(L2)
  const mWrist = linkMass(dof >= 4 ? L3 : 0) + 60 // hub + servo hardware
  const mTool = 90 + payload * 1000 * 0.12 // gripper + gripped inertia
  const mPayload = payload

  const at = (m, dist) => ({ m, dist })
  // Shoulder sees the whole arm at full extension; elbow sees everything past it.
  const shoulderLoad = [
    at(mUpper, L1 / 2),
    at(mFore, L1 + L2 / 2),
    at(mWrist, L1 + L2 + L3 / 2),
    at(mTool, L1 + L2 + L3),
    at(mPayload, L1 + L2 + L3 + 40),
  ]
  const elbowLoad = [
    at(mFore, L2 / 2),
    at(mWrist, L2 + L3 / 2),
    at(mTool, L2 + L3),
    at(mPayload, L2 + L3 + 40),
  ]

  const torqueOf = (load) => (G * load.reduce((s, x) => s + (x.m / 1000) * (x.dist / 1000), 0))
  const SAFETY = 1.7
  const req = {
    shoulder: torqueOf(shoulderLoad) * SAFETY,
    elbow: torqueOf(elbowLoad) * SAFETY,
    wrist: (G * (mTool / 1000) * (60 / 1000) + torqueOf([at(mPayload, 40)])) * SAFETY,
    yaw: torqueOf(elbowLoad) * SAFETY * 0.7,
  }

  const picks = {}
  const pickServo = (need, key, label, reduction) => {
    const top = SERVO_LADDER[SERVO_LADDER.length - 1]
    let servo = SERVO_LADDER.find((k) => PARTS[k].torque >= need)
    let ratio = 1
    if (!servo) {
      // Real builds answer an over-torqued joint with a belt reduction before
      // they reach for a bigger servo — so do that, up to a 4:1 GT2 stage.
      ratio = Math.ceil((need / PARTS[top].torque) * 1.05)
      servo = top
      if (ratio > 4) {
        picks[key] = servo
        d.checks.push({
          level: 'fail',
          msg: `${label}: needs ${fmt(need, 1)} N·m at full extension — that is ${ratio}:1 beyond ${PARTS[top].name}. This is a stepper/harmonic-drive machine: use NEMA17 + 5:1 or cut reach/payload.`,
        })
        addPart(d, servo, 1, label)
        return { servo, ratio }
      }
      addPart(d, 'gt2_kit', 1, `${label} ${ratio}:1 belt reduction`)
      d.notes.push(`${label} uses a ${ratio}:1 GT2 belt stage — ${PARTS[servo].name} alone gives ${fmt(PARTS[servo].torque, 2)} N·m, ${fmt(PARTS[servo].torque * ratio, 2)} N·m at the joint.`)
    }
    picks[key] = servo
    addPart(d, servo, 1, label)
    return { servo, ratio }
  }

  d.actuators = []
  const sized = (label, need, key) => {
    const pick = pickServo(need, key, label)
    d.actuators.push({ label, need, servo: pick.servo, ratio: pick.ratio, effective: PARTS[pick.servo].torque * pick.ratio })
    return pick.servo
  }
  sized('Base yaw', req.yaw, 'yaw')
  sized('Shoulder pitch', req.shoulder, 'shoulder')
  sized('Elbow pitch', req.elbow, 'elbow')
  if (dof >= 4) sized('Wrist pitch', req.wrist, 'wrist')
  if (dof >= 5) sized('Wrist roll', Math.max(0.35, req.wrist * 0.55), 'roll')
  if (dof >= 6) sized('Tool yaw', Math.max(0.3, req.wrist * 0.4), 'tool')
  sized('Gripper', Math.max(0.15, payload * 0.6), 'grip')

  const servoCount = d.joints.length + 1
  addPart(d, 'pca9685', 1, `${servoCount} servo channels`)
  addPart(d, brief.mcu && brief.mcu !== 'esp32s3' ? brief.mcu : 'esp32s3', 1, 'controller')
  addPart(d, 'buck5a', 1, '6V servo rail')
  addPart(d, brief.battery && brief.battery !== 'pd5v' ? brief.battery : 'pack3s', 1, 'energy')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'bearing608', 4, 'joint bearings')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, MAT_PART(brief.material), 1, 'printed links')

  if (servoCount > 8) addPart(d, 'pca9685', 1, 'second servo bank')

  d.notes.push(`Servo sizing at full extension with a ${SAFETY}× safety factor: ` +
    `shoulder needs ${fmt(req.shoulder, 2)} N·m → ${PARTS[picks.shoulder].name}, ` +
    `elbow ${fmt(req.elbow, 2)} N·m → ${PARTS[picks.elbow].name}.`)
  if (picks.elbow === picks.shoulder && servoCount > 4) {
    d.notes.push('Same servo at shoulder and elbow — buy 6, the spares are the spare parts bin.')
  }
  d.metrics = {
    joints: servoCount,
    reachMm: Math.round(tipX),
    payloadKg: payload,
    massKg: (mUpper + mFore + mWrist + mTool) / 1000,
  }
  return d
}

function MAT_PART(material) {
  return (MATERIALS[material] || MATERIALS.petg).priceId
}

// ── rover: wheels, torque and runtime ───────────────────────────────────────
// The interesting part is not the box. It is: can this motor move this mass,
// and how long does the pack last doing it.

function buildRover(brief) {
  const d = newDesign('rover', brief)
  const payload = clamp(brief.payloadKg || 2, 0.2, 15)
  const wheelD = clamp(Math.round(brief.wheelMm || (brief.reachMm || 400) * 0.22), 60, 130) // wheel Ø, mm
  const track = clamp(Math.round(wheelD * 3.2), 150, 420)
  const wheelbase = clamp(Math.round(track * 1.25), 180, 520)
  const r = wheelD / 2 / 1000 // m

  d.title = `${wheelD}mm 4WD rover`
  d.subtitle = `${track}×${wheelbase}mm wheelbase · ${payload}kg cargo`
  d.metrics = {}

  const chassisH = 34
  const z0 = wheelD / 2

  box(d, 'chassis-deck', [wheelbase, track, 4], [0, 0, z0 + chassisH - 2], 'shell', { print: true })
  for (const sx of [-1, 1]) {
    box(d, `bulkhead-${sx > 0 ? 'f' : 'b'}`, [4, track, chassisH - 8], [sx * (wheelbase / 2 - 3), 0, z0 + chassisH / 2 - 2], 'shell', { print: true })
  }
  for (const sx of [-1, 1]) {
    box(d, `rail-${sx > 0 ? 'l' : 'r'}`, [wheelbase + 10, 6, chassisH + 10], [0, sx * (track / 2 + 3), z0 + 2], 'accent', { print: true })
  }
  // battery well, electronics shelf, payload plate
  box(d, 'battery-well', [wheelbase * 0.42, track * 0.5, 18], [-wheelbase * 0.2, 0, z0 + 12], 'pcb')

  // wheels + motors
  const wheels = [
    [wheelbase / 2 - 6, track / 2],
    [wheelbase / 2 - 6, -track / 2],
    [-wheelbase / 2 + 6, track / 2],
    [-wheelbase / 2 + 6, -track / 2],
  ]
  wheels.forEach(([x, y], i) => {
    const side = y > 0 ? 1 : -1
    cyl(d, `wheel-${i}`, wheelD / 2, 26, [x, y + side * 14, z0], 'y', 'rubber', { print: true })
    cyl(d, `hub-${i}`, wheelD * 0.22, 30, [x, y + side * 16, z0], 'y', 'accent', { print: true })
    cyl(d, `motor-${i}`, 18, 52, [x, y - side * 6, z0], 'y', 'metal')
  })

  // sensor mast + head
  box(d, 'mast', [26, 26, 150], [wheelbase * 0.34, 0, z0 + chassisH + 75], 'shell', { print: true })
  box(d, 'head', [70, 86, 34], [wheelbase * 0.34, 0, z0 + chassisH + 160], 'accent', { print: true })
  cyl(d, 'head-tof', 9, 8, [wheelbase * 0.34 + 34, 0, z0 + chassisH + 160], 'x', 'glass')
  cyl(d, 'head-cam', 7, 8, [wheelbase * 0.34 + 34, 26, z0 + chassisH + 166], 'x', 'glass')

  // ── mass, torque, motor choice ──────────────────────────────────────────
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const printedCm3 = printedVolume(d.nodes) / 1000
  const printMassKg = (printedCm3 * mat.density) / 1000
  const electronicsKg = 0.32 // MCU, driver, DC-DC, wiring, fasteners
  const batteryKg = PARTS[brief.battery] ? PARTS[brief.battery].mass / 1000 : 0.14

  // First guess, then refine once the motor is known.
  let massKg = printMassKg + electronicsKg + batteryKg + payload
  const Crr = 0.06 // printed wheels on carpet — the honest number
  const accel = 0.8 // m/s²
  const needPerWheel = ((massKg * G * Crr + massKg * accel) * r) / 4 * 1.5

  const motorKey = MOTOR_LADDER.find((k) => k !== 'n20_100' || needPerWheel < 0.04) &&
    MOTOR_LADDER.find((k) => PARTS[k].torque >= needPerWheel)
  const motor = motorKey || 'jgb37'
  const motorPart = PARTS[motor]
  addPart(d, motor, 4, 'drive')
  massKg += (motorPart.mass / 1000) * 4

  const v = motorPart.volts
  const battery = brief.battery && PARTS[brief.battery] ? brief.battery : v >= 11 ? 'pack3s' : 'pack2s'
  const bat = PARTS[battery]
  addPart(d, battery === 'pack2s' && v >= 11 ? 'pack3s' : battery === 'pd5v' ? 'pd5v' : battery, 1, `${v}V motor rail`)
  addPart(d, 'buck5a', 1, '5V logic rail')
  addPart(d, motorPart.ampacity > 3 || v >= 11 ? 'bts7960' : 'tb6612', 1, 'motor driver')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bno085', 1, 'heading + tilt')
  addPart(d, 'vl53l0x', 2, 'forward + drop-off')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'xt60', 1, 'pack connector')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed chassis')

  const speed = (motorPart.speed * Math.PI * (wheelD / 1000)) / 60 // m/s
  const driveCurrent = motorPart.curr.typ * 2 // two channels under load
  const idleCurrent = 0.22
  const runtimeMin = bat.mah > 0 ? Math.round(((bat.mah / 1000) * 0.8 * 60) / (driveCurrent + idleCurrent)) : null

  d.notes.push(`${motorPart.name} chosen: ${fmt(needPerWheel, 3)} N·m per wheel needed, ${fmt(motorPart.torque, 2)} N·m available.`)
  d.notes.push(`Top speed ${fmt(speed * 3.6, 1)} km/h at ${motorPart.speed} rpm through ${wheelD}mm wheels.`)
  if (bat.maxA < motorPart.curr.peak * 2) {
    d.checks.push({ level: 'warn', msg: `${bat.name} can supply ${bat.maxA}A; four motors stalling want ${fmt(motorPart.curr.peak * 4, 1)}A. Add a current limit in firmware.` })
  }
  if (d.joints.length === 0) {
    joint(d, 'head-pan', 'Head pan', 'z', [wheelbase * 0.34, 0, z0 + chassisH + 150], -90, 90)
    cyl(d, 'head-servo', 12, 24, [wheelbase * 0.34, 0, z0 + chassisH + 150], 'z', 'metal', { joint: 'head-pan' })
    addPart(d, 'mg90s', 1, 'head pan')
  }

  Object.assign(d.metrics, {
    massKg,
    wheelD,
    speedMps: speed,
    runtimeMin,
    torquePerWheel: needPerWheel,
    motor,
    battery,
  })
  return d
}

// ── quadruped: the machine everyone wants and nobody budgets for ────────────
// 12 servos is not a detail, it is the whole electrical problem: peak current
// at gait contact is what browns out a DevKit.

function buildQuadruped(brief) {
  const d = newDesign('quadruped', brief)
  const payload = clamp(brief.payloadKg || 1, 0.2, 6)
  const legLen = clamp((brief.reachMm || 400) * 0.28, 90, 260)
  const hipW = clamp(Math.round(legLen * 1.35), 120, 340)
  const bodyLen = clamp(Math.round(hipW * 1.5), 160, 460)
  const bodyH = 46

  d.title = `12-servo quadruped · ${Math.round(legLen)}mm leg`
  d.subtitle = `${Math.round(bodyLen)}mm body · ${payload}kg carried`

  const z0 = legLen * 1.35
  box(d, 'body', [bodyLen, hipW, bodyH], [0, 0, z0], 'shell', { print: true })
  box(d, 'spine', [bodyLen * 0.9, 30, 12], [0, 0, z0 + bodyH / 2 + 6], 'accent', { print: true })
  box(d, 'pack', [bodyLen * 0.42, hipW * 0.52, 24], [0, 0, z0 + bodyH / 2 + 18], 'pcb')
  cyl(d, 'head', 30, 40, [bodyLen / 2 + 18, 0, z0 + 6], 'x', 'accent', { print: true })
  cyl(d, 'eye', 10, 6, [bodyLen / 2 + 40, 0, z0 + 12], 'x', 'glass')

  const femur = legLen * 0.62
  const tibia = legLen * 0.78
  const corners = [
    ['fl', 1, 1], ['fr', 1, -1], ['rl', -1, 1], ['rr', -1, -1],
  ]
  const jointIds = []
  corners.forEach(([name, sx, sy]) => {
    const ax = (sx * bodyLen) / 2 - sx * 14
    const ay = (sy * hipW) / 2 + sy * 10
    cyl(d, `coxa-${name}`, 16, 26, [ax, ay, z0], 'z', 'metal')
    box(d, `femur-${name}`, [24, 26, femur], [ax, ay + sy * 10, z0 - femur / 2], 'shell', { print: true })
    box(d, `tibia-${name}`, [20, 22, tibia], [ax, ay + sy * 10, z0 - femur - tibia / 2], 'accent', { print: true })
    cyl(d, `foot-${name}`, 12, 8, [ax, ay + sy * 10, z0 - femur - tibia], 'z', 'rubber')
    jointIds.push(`hip-${name}`)
    joint(d, `hip-${name}`, `Hip ${name.toUpperCase()}`, 'y', [ax, ay, z0], -60, 60)
  })

  // ── servo sizing at the worst leg phase ─────────────────────────────────
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const legMassKg = (printedVolume(d.nodes) / 4 / 1000) * mat.density / 1000
  const reqFoot = G * ((legMassKg * 0.5 + payload / 4) * (legLen / 1000)) * 1.8
  const key = SERVO_LADDER.find((k) => PARTS[k].torque >= reqFoot) || 'ds3218'
  const servo = PARTS[key]
  addPart(d, key, 12, '12 joints (3 per leg)')
  addPart(d, 'pca9685', 2, '24 channels of PWM')
  addPart(d, 'buck5a', 2, 'split servo rails')
  addPart(d, 'pack3s', 1, 'servo pack')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bno085', 1, 'body attitude')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed frame')

  const peakAll = servo.curr.peak * 12
  const peakGait = servo.curr.peak * 4 + servo.curr.typ * 8 // two legs lifting at once
  d.notes.push(`${servo.name} at every joint: ${fmt(reqFoot, 2)} N·m required at the worst gait phase.`)
  d.checks.push({
    level: 'warn',
    msg: `Servo peak ${fmt(peakGait, 1)}A on a 3S pack — split the rails across two UBECs and put a 1000µF cap at each PCA9685 terminal.`,
  })
  if (peakAll > PARTS.pack3s.maxA * 3) {
    d.checks.push({ level: 'warn', msg: `All-stall current is ${fmt(peakAll, 1)}A; the pack cannot do that. Firmware must stagger leg lifts.` })
  }

  Object.assign(d.metrics, {
    joints: 12,
    legMm: Math.round(legLen),
    massKg: (printedVolume(d.nodes) / 1000) * mat.density / 1000 + (servo.mass * 12) / 1000 + 0.3,
    peakAmps: peakGait,
    servo: key,
  })
  return d
}

// ── gripper: a tool, but a machine you can build ────────────────────────────
// Grip force is a real calculation: servo torque over the lever arm, then the
// friction cone decides whether the object actually stays in the jaws.

function buildGripper(brief) {
  const d = newDesign('gripper', brief)
  const span = clamp(brief.reachMm || 80, 30, 240) // jaw opening, mm
  const payload = clamp(brief.payloadKg || 1, 0.1, 6)

  d.title = `${Math.round(span)}mm parallel gripper`
  d.subtitle = `${payload}kg class · servo actuated`

  box(d, 'body', [span * 0.9, 62, 46], [0, 0, 0], 'shell', { print: true })
  box(d, 'servo-mount', [30, 56, 50], [-span * 0.55, 0, 0], 'accent', { print: true })
  cyl(d, 'pinion', 14, 30, [0, 0, 24], 'z', 'metal')
  box(d, 'rack-a', [span * 0.8, 10, 12], [0, -14, 10], 'metal')
  box(d, 'rack-b', [span * 0.8, 10, 12], [0, 14, 10], 'metal')
  box(d, 'jaw-a', [span * 0.7, 8, 40], [span * 0.1, -(span / 2), 0], 'accent', { print: true })
  box(d, 'jaw-b', [span * 0.7, 8, 40], [span * 0.1, span / 2, 0], 'accent', { print: true })
  box(d, 'pad-a', [span * 0.6, 4, 30], [span * 0.14, -(span / 2) + 6, 0], 'rubber')
  box(d, 'pad-b', [span * 0.6, 4, 30], [span * 0.14, span / 2 - 6, 0], 'rubber')

  joint(d, 'jaw-slide', 'Jaw travel', 'y', [0, 0, 0], -span / 2, span / 2)

  // torque → force → what it can hold
  const lever = 0.014 // m, pinion radius
  const key = SERVO_LADDER.find((k) => PARTS[k].torque / lever >= payload * G * 6) || 'ds3218'
  const force = PARTS[key].torque / lever
  const gripMass = (force * 0.4) / G // rubber-on-rubber µ≈0.8, derated
  addPart(d, key, 1, 'jaw actuator')
  addPart(d, 'bearing608', 2, 'jaw guides')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'pca9685', 1, 'PWM channel')
  addPart(d, 'as5600', 1, 'jaw position feedback')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'petg_kg', 1, 'printed jaws')

  d.notes.push(`${PARTS[key].name} → ${fmt(force, 0)}N at the jaw face, ~${fmt(gripMass, 1)}kg held with rubber pads.`)
  if (gripMass < payload) {
    d.checks.push({ level: 'fail', msg: `Grip force supports ${fmt(gripMass, 1)}kg but the brief asks ${payload}kg — add a 2:1 rack reduction or a stronger servo.` })
  }

  d.metrics = { gripForceN: force, gripMassKg: gripMass, spanMm: span, joints: 1 }
  return d
}

// ── gadget: the ESP32 build — small, but the same rigour ────────────────────
// Parts are chosen from the mission text, which is the one place the design is
// allowed to be "smart" rather than parametric.

const GADGET_RULES = [
  { re: /weather|climate|humidity|air|co2|barometer/i, parts: [['bme280', 'environment']], label: 'environmental' },
  { re: /plant|soil|garden|water/i, parts: [['soil', 'soil moisture']], label: 'plant care' },
  { re: /clock|timer|pomodoro|focus|countdown/i, parts: [['ili9341', 'main display']], label: 'timing' },
  { re: /camera|security|doorbell|vision|esp32-cam/i, parts: [['ov2640', 'camera']], label: 'vision' },
  { re: /voice|mic|listen|speech|assistant/i, parts: [['inmp441', 'microphone']], label: 'voice' },
  { re: /speaker|music|sound|beep|alarm|siren/i, parts: [['max98357', 'audio out']], label: 'audio' },
  { re: /distance|parking|radar|presence|tripwire/i, parts: [['vl53l0x', 'ranging']], label: 'ranging' },
  { re: /gps|track|location|hike|bike/i, parts: [['gps', 'positioning']], label: 'tracking' },
  { re: /scale|weight|coffee|dose/i, parts: [['hx711', 'load cell']], label: 'weighing' },
  { re: /motion|intruder|pir|detect/i, parts: [['pir', 'motion']], label: 'motion' },
  { re: /robot face|emotion|eyes|companion|pet/i, parts: [['gc9a01', 'face display']], label: 'character' },
  { re: /tilt|balance|orientation|self-balanc/i, parts: [['mpu6050', 'IMU']], label: 'attitude' },
]

function buildGadget(brief) {
  const d = newDesign('gadget', brief)
  const mission = brief.mission || ''
  const w = 90
  const h = 70
  const thick = 38

  d.title = 'ESP32 desk device'
  d.subtitle = 'pine enclosure · USB-C powered'

  box(d, 'case', [w, h, thick], [0, 0, thick / 2], 'shell', { print: true })
  box(d, 'lid', [w - 4, h - 4, 4], [0, 0, thick + 2], 'accent', { print: true })
  box(d, 'pcb', [w - 16, h - 16, 2], [0, 0, 16], 'pcb')
  cyl(d, 'port-usb', 5, 10, [w / 2 - 2, 0, 8], 'x', 'metal')
  box(d, 'vent', [w * 0.5, 6, 3], [0, h / 2 - 6, 18], 'metal')

  const chosen = []
  for (const rule of GADGET_RULES) {
    if (!rule.re.test(mission)) continue
    for (const [key, role] of rule.parts) {
      if (chosen.some((c) => c[0] === key)) continue
      chosen.push([key, role])
    }
  }
  // Default face: an OLED is never the wrong answer for a desk device.
  if (!chosen.some(([k]) => PARTS[k].cat === 'display')) chosen.push(['ssd1306', 'status display'])
  if (!chosen.some(([k]) => PARTS[k].cat === 'sensor')) chosen.push(['bme280', 'fallback sensor'])

  const isDisplay = (k) => PARTS[k].cat === 'display'
  const big = chosen.find(([k]) => k === 'ili9341' || k === 'gc9a01')
  const face = big ? big[0] : 'ssd1306'
  const faceSize = face === 'ili9341' ? [62, 47] : face === 'gc9a01' ? [36, 36] : [34, 18]

  box(d, 'screen-behind', [faceSize[0] + 6, faceSize[1] + 6, 3], [-6, 2, thick - 2], 'metal')
  box(d, 'screen', [faceSize[0], faceSize[1], 2], [0, 0, thick - 1], 'glass')
  cyl(d, 'knob', 9, 12, [w / 2 - 18, -h / 2 + 16, thick], 'z', 'accent', { print: true })
  cyl(d, 'button', 5, 8, [-w / 2 + 18, -h / 2 + 16, thick], 'z', 'metal')
  box(d, 'sensor-window', [16, 8, 2], [0, -h / 2 + 8, thick - 1], 'glass')

  for (const [key, role] of chosen) addPart(d, key, 1, role)
  addPart(d, 'esp32s3', 1, 'controller')
  addPart(d, 'pd5v', 1, 'USB-C power')
  addPart(d, 'jst_kit', 1, 'internal harness')
  addPart(d, 'hw_m3', 1, 'case screws')
  addPart(d, MATERIALS[brief.material] ? MATERIALS[brief.material].priceId : 'pla_kg', 1, 'printed case')

  d.notes.push(`Mission read as ${chosen.map(([, r]) => r).join(' + ')} — those parts are in the BOM, wired on the pin map.`)
  d.metrics = {
    parts: d.parts.length,
    width: w, height: h, depth: thick,
    joints: 0,
  }
  return d
}

// ── full robot: a mobile manipulator, not a fragment ────────────────────────
// This is the archetype that answers "build me a robot": a drive base that
// carries an arm, a head, its own power and its own controller. It reuses the
// same primitives as the rover and the arm on purpose — the interesting part is
// what changes when they are one machine:
//
//   • the arm's torque cascade now happens on a base that can TIP OVER
//   • 4 motors + 6 servos share one pack, so peak current is a real budget
//   • the firmware has to arbitrate: no reaching while driving fast

function buildFullRobot(brief) {
  const d = newDesign('robot', brief)
  const payload = clamp(brief.payloadKg || 1, 0.2, 5)
  const wheelD = clamp(Math.round(brief.wheelMm || 130), 80, 160)
  const track = clamp(Math.round(wheelD * 2.6), 240, 440)
  const wheelbase = clamp(Math.round(track * 1.15), 300, 520)
  const r = wheelD / 2 / 1000
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000 // g/mm³

  const chassisH = 72
  const z0 = wheelD / 2
  const deckZ = z0 + chassisH
  // Arm over the REAR axle, head at the front: reaching forward then moves the
  // CoM toward the centre instead of off the front edge.
  const armX = -wheelbase * 0.18
  const L1 = clamp((brief.reachMm || 450) * 0.44, 120, 420)
  const L2 = clamp((brief.reachMm || 450) * 0.36, 100, 360)
  const L3 = clamp((brief.reachMm || 450) * 0.13, 40, 130)
  const turretH = 108
  const shoulderZ = deckZ + turretH

  d.title = `Mobile manipulator · ${Math.round(L1 + L2 + L3)}mm reach on a ${wheelD}mm 4WD base`
  d.subtitle = `${payload}kg payload · ${Math.round(track)}×${Math.round(wheelbase)}mm footprint · ${mat.name}`

  // ── drive base ───────────────────────────────────────────────────────────
  box(d, 'deck', [wheelbase, track, 3], [0, 0, deckZ - 2], 'shell', { print: true })
  for (const sx of [-0.28, 0.12]) {
    box(d, `deck-rib-${sx}`, [10, track - 12, 16], [wheelbase * sx, 0, deckZ - 12], 'shell', { print: true })
  }
  for (const sx of [-1, 1]) {
    box(d, `rail-${sx > 0 ? 'l' : 'r'}`, [wheelbase + 8, 4, 40], [0, sx * (track / 2 + 2), z0 + chassisH / 2 - 2], 'accent', { print: true })
  }
  for (const sx of [-1, 1]) {
    box(d, `bulkhead-${sx > 0 ? 'f' : 'b'}`, [4, track, chassisH - 22], [sx * (wheelbase / 2 - 4), 0, z0 + chassisH / 2 - 6], 'shell', { print: true })
  }
  box(d, 'pack-box', [wheelbase * 0.28, track * 0.42, 28], [wheelbase * 0.16, 0, deckZ + 14], 'pcb')
  box(d, 'avionics', [wheelbase * 0.22, track * 0.3, 20], [-wheelbase * 0.06, -track * 0.26, deckZ + 10], 'pcb')
  cyl(d, 'bumper', 14, 34, [wheelbase / 2 + 14, 0, z0 + 18], 'x', 'rubber', { print: true })

  const wheels = [
    [wheelbase / 2 - 8, track / 2], [wheelbase / 2 - 8, -track / 2],
    [-wheelbase / 2 + 8, track / 2], [-wheelbase / 2 + 8, -track / 2],
  ]
  wheels.forEach(([x, y], i) => {
    const side = y > 0 ? 1 : -1
    // wheel is BOUGHT (see BOM); only the adapter is printed
    cyl(d, `wheel-${i}`, wheelD / 2, 30, [x, y + side * 16, z0], 'y', 'rubber')
    cyl(d, `hub-${i}`, wheelD * 0.24, 34, [x, y + side * 18, z0], 'y', 'accent', { print: true })
    // motor block sits inboard of the wheel so it is visible in the model
    cyl(d, `motor-${i}`, 19, 46, [x, y - side * 26, z0], 'y', 'metal')
  })

  // ── arm ─────────────────────────────────────────────────────────────────
  cyl(d, 'turret', 46, turretH, [armX, 0, deckZ + turretH / 2], 'z', 'shell', { print: true })
  cyl(d, 'turret-bearing', 26, 10, [armX, 0, shoulderZ], 'z', 'metal', { part: 'bearing608' })
  joint(d, 'yaw', 'Base yaw', 'z', [armX, 0, shoulderZ], -160, 160)

  box(d, 'shoulder-block', [54, 62, 50], [armX + 8, 0, shoulderZ + 16], 'shell', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 20, 72, [armX, 0, shoulderZ], 'y', 'metal', { joint: 'yaw' })
  joint(d, 'shoulder', 'Shoulder pitch', 'y', [armX, 0, shoulderZ], -80, 80)

  box(d, 'upper-arm', [L1, 48, 42], [armX + L1 / 2, 0, shoulderZ], 'shell', { joint: 'shoulder', print: true })
  box(d, 'upper-rib', [L1 * 0.8, 10, 6], [armX + L1 / 2, 0, shoulderZ + 24], 'accent', { joint: 'shoulder', print: true })
  cyl(d, 'elbow-hub', 17, 56, [armX + L1, 0, shoulderZ], 'y', 'metal', { joint: 'shoulder' })
  joint(d, 'elbow', 'Elbow pitch', 'y', [armX + L1, 0, shoulderZ], -135, 135)

  box(d, 'forearm', [L2, 42, 38], [armX + L1 + L2 / 2, 0, shoulderZ], 'shell', { joint: 'elbow', print: true })
  const wristX = armX + L1 + L2
  cyl(d, 'wrist-hub', 15, 48, [wristX, 0, shoulderZ], 'y', 'metal', { joint: 'elbow' })
  joint(d, 'wrist', 'Wrist pitch', 'y', [wristX, 0, shoulderZ], -100, 100)

  box(d, 'wrist-link', [L3, 34, 30], [wristX + L3 / 2, 0, shoulderZ], 'shell', { joint: 'wrist', print: true })
  joint(d, 'roll', 'Wrist roll', 'x', [wristX + L3, 0, shoulderZ], -180, 180)
  box(d, 'gripper-body', [36, 52, 40], [wristX + L3 + 18, 0, shoulderZ], 'accent', { joint: 'roll', print: true })
  box(d, 'jaw-a', [26, 8, 32], [wristX + L3 + 45, -16, shoulderZ], 'metal', { joint: 'roll' })
  box(d, 'jaw-b', [26, 8, 32], [wristX + L3 + 45, 16, shoulderZ], 'metal', { joint: 'roll' })

  // ── head ────────────────────────────────────────────────────────────────
  // The head sits LOW at the front and the arm sweeps HIGH above it: a 13mm
  // clearance in the rest pose, and no way for the boom to shave the sensors.
  const headX = wheelbase / 2 + 2
  const headY = 0
  box(d, 'head-neck', [26, 26, 44], [headX, headY, deckZ + 22], 'shell', { print: true })
  box(d, 'head', [62, 74, 30], [headX, headY, deckZ + 59], 'accent', { print: true })
  cyl(d, 'tof', 9, 8, [headX + 32, -14, deckZ + 58], 'x', 'glass')
  cyl(d, 'cam', 8, 8, [headX + 32, 16, deckZ + 62], 'x', 'glass')
  joint(d, 'head-pan', 'Head pan', 'z', [headX, headY, deckZ + 44], -90, 90)

  // ── arm sizing (same cascade as the arm archetype) ──────────────────────
  const linkMass = (len) => len * 44 * 40 * 0.34 * density
  const mUpper = linkMass(L1)
  const mFore = linkMass(L2)
  const mWrist = linkMass(L3) + 70
  const mTool = 110 + payload * 120
  const mPayload = payload
  const tor = (load) => G * load.reduce((s, x) => s + (x.m / 1000) * (x.dist / 1000), 0)
  const SAFETY = 1.7
  const need = {
    yaw: tor([
      { m: mUpper, dist: L1 / 2 }, { m: mFore, dist: L1 + L2 / 2 },
      { m: mWrist, dist: L1 + L2 + L3 / 2 }, { m: mTool, dist: L1 + L2 + L3 },
      { m: mPayload, dist: L1 + L2 + L3 + 40 },
    ]) * SAFETY * 0.75,
    shoulder: tor([
      { m: mUpper, dist: L1 / 2 }, { m: mFore, dist: L1 + L2 / 2 },
      { m: mWrist, dist: L1 + L2 + L3 / 2 }, { m: mTool, dist: L1 + L2 + L3 },
      { m: mPayload, dist: L1 + L2 + L3 + 40 },
    ]) * SAFETY,
    elbow: tor([
      { m: mFore, dist: L2 / 2 }, { m: mWrist, dist: L2 + L3 / 2 },
      { m: mTool, dist: L2 + L3 }, { m: mPayload, dist: L2 + L3 + 40 },
    ]) * SAFETY,
    wrist: (G * (mTool / 1000) * 0.07 + tor([{ m: mPayload, dist: 40 }])) * SAFETY,
    roll: Math.max(0.35, payload * 0.5),
    grip: Math.max(0.2, payload * 0.6),
  }

  const top = SERVO_LADDER[SERVO_LADDER.length - 1]
  const stairs = []
  const pick = (label, want) => {
    let servo = SERVO_LADDER.find((k) => PARTS[k].torque >= want)
    let ratio = 1
    if (!servo) {
      ratio = Math.ceil((want / PARTS[top].torque) * 1.05)
      servo = top
      if (ratio > 4) {
        d.checks.push({ level: 'fail', msg: `${label}: ${fmt(want, 1)} N·m needed — ${ratio}:1 past ${PARTS[top].name}. This is a stepper-class joint; cut payload or reach.` })
      } else {
        addPart(d, 'gt2_kit', 1, `${label} ${ratio}:1 belt stage`)
        d.notes.push(`${label} runs a ${ratio}:1 GT2 stage: ${PARTS[servo].name} gives ${fmt(want / ratio, 2)} N·m at the horn, ${fmt(PARTS[servo].torque, 2)} at the joint.`)
      }
    }
    addPart(d, servo, 1, label)
    stairs.push({ label, need: want, servo, ratio, effective: PARTS[servo].torque * ratio })
    return servo
  }

  pick('Base yaw', need.yaw)
  pick('Shoulder pitch', need.shoulder)
  pick('Elbow pitch', need.elbow)
  pick('Wrist pitch', need.wrist)
  pick('Wrist roll', need.roll)
  pick('Gripper', need.grip)
  d.actuators = stairs

  // ── drive sizing ────────────────────────────────────────────────────────
  const printKg = (printedVolume(d.nodes) * mat.density) / 1000 / 1000
  const servoKg = stairs.reduce((s, x) => s + PARTS[x.servo].mass, 0) / 1000
  const electronicsKg = 0.46
  let massKg = printKg + servoKg + electronicsKg + payload
  const Crr = 0.07
  const needPerWheel = ((massKg * G * Crr + massKg * 0.7) * r) / 4 * 1.5
  const motor = MOTOR_LADDER.find((k) => PARTS[k].torque >= needPerWheel) || 'jgb37'
  const mp = PARTS[motor]
  massKg += (mp.mass / 1000) * 4
  addPart(d, motor, 4, 'drive')
  addPart(d, 'pca9685', 1, '6 arm servos')
  addPart(d, 'buck5a', 2, 'servo + logic rails')
  addPart(d, 'pack3s', 1, 'drive + servo pack')
  addPart(d, 'wheel130', 4, 'drive wheels')
  addPart(d, mp.ampacity > 3 || mp.volts >= 11 ? 'bts7960' : 'tb6612', 1, 'motor driver')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'bno085', 1, 'heading + tilt')
  addPart(d, 'vl53l0x', 2, 'forward + drop-off')
  addPart(d, 'mg90s', 1, 'head pan')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'bearing608', 2, 'turret + shoulder')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'xt60', 1, 'pack connector')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, mat.priceId, 1, 'printed frame')

  // ── static stability: the check nobody runs until the robot falls over ──
  const reachOut = (armX + L1 + L2 + L3 + 40) / 1000 // m from the axle centre
  const armMassKg = (mUpper + mFore + mWrist + mTool) / 1000
  const chassisMassKg = massKg - (mp.mass / 1000) * 4
  // CoM offset with the arm at full extension, worst case (arm forward)
  const armOriginX = armX / 1000
  const comOffset = ((armMassKg + payload) * (armOriginX + reachOut * 0.55) + chassisMassKg * 0.0) / massKg
  const supportHalf = Math.min(track, wheelbase) / 2 / 1000
  if (comOffset > supportHalf * 0.92) {
    d.checks.push({
      level: 'fail',
      msg: `Static stability: with the arm out at ${Math.round(reachOut * 1000)}mm the CoM sits ${Math.round(comOffset * 1000)}mm off centre, past the ${Math.round(supportHalf * 1000)}mm support half-width. Widen the track, add ballast over the rear axle, or cap the payload.`,
    })
  } else if (comOffset > supportHalf * 0.7) {
    d.checks.push({ level: 'warn', msg: `CoM ${Math.round(comOffset * 1000)}mm off centre at full reach — stable, but drive gently with the arm extended.` })
  }

  d.notes.push(`Drive: ${mp.name} — ${fmt(needPerWheel, 2)} N·m per wheel needed for ${fmt(massKg, 1)}kg, ${fmt(mp.torque, 2)} N·m available.`)
  d.notes.push(`Arm holds ${payload}kg at ${Math.round((L1 + L2 + L3) / 10)}cm reach with a ${SAFETY}× factor; the base is what limits it, not the servos.`)
  d.notes.push('The arm shadows the head camera at full reach. The pan joint is there for exactly that: yaw the head 60-90° away from the boom, or mount the camera pod off-centre on the next revision.')
  if (wheelbase > 380) {
    d.notes.push('Deck is ' + Math.round(wheelbase) + 'mm: print it in two dovetailed halves, or cut it from 3mm aluminium — same mass, no warp, no 40-hour print.')
  }

  Object.assign(d.metrics, {
    joints: d.joints.length,
    reachMm: Math.round(L1 + L2 + L3),
    payloadKg: payload,
    massKg,
    wheelD,
    motor,
    speedMps: (mp.speed * Math.PI * (wheelD / 1000)) / 60,
    torquePerWheel: needPerWheel,
    comOffsetMm: Math.round(comOffset * 1000),
    supportHalfMm: Math.round(supportHalf * 1000),
  })
  return d
}

/** Combined firmware: one loop that arbitrates drive and arm. */
function fullRobotFirmware(design, a, pin) {
  const m = design.metrics
  const driver = design.parts.find((p) => p.key === 'tb6612' || p.key === 'bts7960')?.key || 'bts6612'
  return `/* ${design.title} — ${a.mcu.name}
 * Generated by Rigforge: mobile manipulator, ${design.joints.length} arm servos on a
 * PCA9685 + 4 driven wheels. One pack, one loop, one arbiter.
 */
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// ── drive ──────────────────────────────────────────────────────────────────
// Pin numbers come from the analysis pass — the PINS tab and this file cannot drift.
const uint8_t PWM_L = ${pin('M1 PWM', 4)}, IN1_L = ${pin('M1 IN1', 5)}, IN2_L = ${pin('M1 IN2', 6)};
const uint8_t PWM_R = ${pin('M2 PWM', 7)}, IN1_R = ${pin('M2 IN1', 15)}, IN2_R = ${pin('M2 IN2', 16)};
const float   TRACK = ${((m.wheelD || 130) * 2.4 / 1000).toFixed(3)};
const float   VMAX  = ${Math.max(0.25, (m.speedMps || 0.6)).toFixed(2)};

// ── arm ────────────────────────────────────────────────────────────────────
const uint8_t JOINTS = ${design.joints.length};
const int16_t LIMITS[][2] = { ${design.joints.map((j) => `{${j.min}, ${j.max}}`).join(', ')} };
int16_t target[${design.joints.length}] = {0};
int16_t current[${design.joints.length}] = {0};

float speedNow = 0.0f;

void writeJoint(uint8_t i, int16_t deg) {
  uint16_t us = 500 + (uint32_t)((deg + 180) * 2000) / 360;
  pwm.setPWM(i, 0, (uint16_t)((us / 20000.0) * 4096));
}

void setMotor(uint8_t ch, uint8_t in1, uint8_t in2, float cmd) {
  cmd = constrain(cmd, -1.0f, 1.0f);
  digitalWrite(in1, cmd > 0.02f);
  digitalWrite(in2, cmd < -0.02f);
  ledcWrite(ch, (uint8_t)(fabsf(cmd) * 255));
  speedNow = fabsf(cmd) * VMAX;
}

void drive(float v, float w) {
  setMotor(0, IN1_L, IN2_L, (v - w * TRACK / 2) / VMAX);
  setMotor(1, IN1_R, IN2_R, (v + w * TRACK / 2) / VMAX);
}

void stop() { setMotor(0, IN1_L, IN2_L, 0); setMotor(1, IN1_R, IN2_R, 0); }

void setup() {
  Serial.begin(115200);
  Wire.begin(${I2C.sda}, ${I2C.scl});
  pwm.begin();
  pwm.setPWMFreq(50);
  ledcAttach(PWM_L, 20000, 8);
  ledcAttach(PWM_R, 20000, 8);
  pinMode(IN1_L, OUTPUT); pinMode(IN2_L, OUTPUT);
  pinMode(IN1_R, OUTPUT); pinMode(IN2_R, OUTPUT);
  stop();
  for (uint8_t i = 0; i < JOINTS; i++) writeJoint(i, 0);
  Serial.println("${design.title} ready — 'D v w' to drive, 'J i deg' to pose, 'S' to stop");
}

void loop() {
  // The arbiter: reaching while moving is what tips this machine over. Below
  // 0.25 VMAX the arm is free, above it the arm is held and targets are refused.
  static uint32_t lastCmd = 0;
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'D' || c == 'd') {
      float v = Serial.parseFloat(), w = Serial.parseFloat();
      drive(v, w);
      lastCmd = millis();
    } else if (c == 'J' || c == 'j') {
      int idx = Serial.parseInt(), deg = Serial.parseInt();
      if (speedNow > 0.25f * VMAX) {
        Serial.println("refused: arm locked while driving");
      } else if (idx >= 0 && idx < JOINTS) {
        target[idx] = constrain(deg, LIMITS[idx][0], LIMITS[idx][1]);
      }
    } else if (c == 'S' || c == 's') {
      stop();
      for (uint8_t i = 0; i < JOINTS; i++) target[i] = current[i];
    }
  }
  if (millis() - lastCmd > 800) stop();   // lost client = stop, never wander

  for (uint8_t i = 0; i < JOINTS; i++) {
    if (current[i] == target[i]) continue;
    current[i] += (target[i] > current[i]) ? 1 : -1;
    writeJoint(i, current[i]);
  }
  delay(8);
}`
}

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

// ── firmware: generated against the pin map, not copied from a tutorial ─────
// The #defines come from the analysis pass, so the code and the wiring table
// cannot drift. These are skeletons a builder can flash — not a complete app.

function firmwareFor(design, a) {
  const pins = a.pins.rows.filter((r) => /^\d+$/.test(r.pin))
  const pin = (name, fallback) => pins.find((r) => r.signal === name)?.pin || String(fallback)
  const servoCount = design.joints.length + 1
  const mcus = a.mcu.name

  if (design.archetype === 'robot') return fullRobotFirmware(design, a, pin)
  if (design.archetype === 'rover') return roverFirmware(design, a, pin, mcus)
  if (design.archetype === 'gadget') return gadgetFirmware(design, a, pin, mcus)
  return armFirmware(design, a, servoCount, mcus)
}

function armFirmware(design, a, servoCount, mcus) {
  const labels = design.joints.map((j) => `"${j.label}"`).join(', ')
  const limits = design.joints.map((j) => `{${j.min}, ${j.max}}`).join(', ')
  const isQuad = design.archetype === 'quadruped'
  const gaitCall = isQuad ? 'quadGait();' : '// sequencing: replace this with a pose/script player'
  return `/* ${design.title} — ${mcus}
 * Generated by Rigforge. ${servoCount} PWM channels over I2C (PCA9685 0x40).
 *
 * Wiring: SDA=GPIO${I2C.sda} SCL=GPIO${I2C.scl}, PCA9685 powered from its own
 * 6V rail (NOT the DevKit 5V pin), grounds tied at the pack negative.
 */
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

const uint8_t  SERVO_COUNT = ${servoCount};
const char*    JOINT_NAME[] = { ${labels} };
const int16_t  LIMITS[][2] = { ${limits} };

// 50Hz: 102..512 ticks is the usual 500–2500us band; calibrate per servo.
const uint16_t US_MIN = 500, US_MAX = 2500;
uint16_t ticksFor(uint16_t us) { return (uint16_t)((us / 20000.0) * 4096); }

int16_t target[SERVO_COUNT];
int16_t current[SERVO_COUNT];

void setJoint(uint8_t i, int16_t deg) {
  deg = constrain(deg, LIMITS[i][0], LIMITS[i][1]);
  target[i] = deg;
}

void writeJoint(uint8_t i, int16_t deg) {
  uint16_t span = US_MAX - US_MIN;
  uint16_t us = US_MIN + (uint32_t)((deg + 180) * span) / 360;
  pwm.setPWM(i, 0, ticksFor(us));
}

void setup() {
  Serial.begin(115200);
  Wire.begin(${I2C.sda}, ${I2C.scl});
  pwm.begin();
  pwm.setPWMFreq(50);
  delay(10);
  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    current[i] = target[i] = 0;
    writeJoint(i, 0);          // park at the mechanical middle first
  }
  Serial.println("${design.title} ready — 'J<idx> <deg>' to move, 'H' to home");
}

void loop() {
  // same-rate interpolation on all joints: smooth, and no current spikes
  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    if (current[i] == target[i]) continue;
    current[i] += (target[i] > current[i]) ? 1 : -1;
    writeJoint(i, current[i]);
  }
  static uint32_t last = 0;
  if (millis() - last < 15) return;
  last = millis();

  if (Serial.available()) {
    char c = Serial.peek();
    if (c == 'J' || c == 'j') {
      Serial.read();
      int idx = Serial.parseInt();
      int deg = Serial.parseInt();
      if (idx >= 0 && idx < SERVO_COUNT) setJoint(idx, deg);
    } else if (c == 'H' || c == 'h') {
      Serial.read();
      for (uint8_t i = 0; i < SERVO_COUNT; i++) setJoint(i, 0);
    } else {
      Serial.read();
    }
  }
  ${gaitCall}
}
${isQuad ? `
// Trot: diagonal pairs, ${design.metrics.legMm || 0}mm legs. Keep two legs on the
// ground at all times and stagger lifts — the pack cannot lift four at once.
void quadGait() {
  static uint32_t phase = 0;
  phase = (phase + 1) % 360;
  for (uint8_t leg = 0; leg < 4; leg++) {
    int offset = (leg == 0 || leg == 3) ? 0 : 180;      // diagonal pairs
    int lift = 22 * sin((phase + offset) * DEG_TO_RAD);
    setJoint(leg * 3 + 1, lift);                         // femur
    setJoint(leg * 3 + 2, -lift + 8);                    // tibia counter-bend
  }
}
` : ''}`
}

function roverFirmware(design, a, pin, mcus) {
  const m = design.metrics
  const driver = design.parts.find((p) => p.key === 'tb6612' || p.key === 'bts7960')?.key || 'tb6612'
  return `/* ${design.title} — ${mcus}
 * Generated by Rigforge. ${driver === 'tb6612' ? 'TB6612FNG' : 'BTS7960'} H-bridge,
 * ${m.motor ? PARTS[m.motor].name : 'gearmotor'} x4, ${a.power.bat ? a.power.bat.name : 'pack'}.
 *
 * ${m.wheelD}mm wheels, ${fmt(m.speedMps * 3.6, 1)} km/h at full PWM,
 * ${m.runtimeMin ? '~' + m.runtimeMin + ' min runtime' : 'tethered'}.
 */
#include <Wire.h>
#include <WiFi.h>

// ── drive ───────────────────────────────────────────────────────────────────
const uint8_t PWM_L = ${pin('M1 PWM', 4)}, IN1_L = ${pin('M1 IN1', 5)}, IN2_L = ${pin('M1 IN2', 6)};
const uint8_t PWM_R = ${pin('M2 PWM', 7)}, IN1_R = ${pin('M2 IN1', 15)}, IN2_R = ${pin('M2 IN2', 16)};
const uint8_t CH_L = 0, CH_R = 1;
const float   TRACK = ${((design.metrics.wheelD || 60) * 3.2 / 1000).toFixed(3)};   // m, wheel centre to wheel centre
const float   WHEEL = ${(((design.metrics.wheelD || 60) / 1000) * Math.PI).toFixed(4)};  // m per motor revolution

// ── sensing ─────────────────────────────────────────────────────────────────
const uint8_t SDA_PIN = ${I2C.sda}, SCL_PIN = ${I2C.scl};

void setMotor(uint8_t ch, uint8_t in1, uint8_t in2, float cmd) {
  cmd = constrain(cmd, -1.0f, 1.0f);
  digitalWrite(in1, cmd > 0.02f);
  digitalWrite(in2, cmd < -0.02f);
  ledcWrite(ch, (uint8_t)(fabsf(cmd) * 255));
}

void drive(float v, float w) {          // m/s, rad/s
  float left  = v - w * TRACK / 2;
  float right = v + w * TRACK / 2;
  setMotor(CH_L, IN1_L, IN2_L, left  / ${Math.max(0.3, design.metrics.speedMps || 0.5).toFixed(2)});
  setMotor(CH_R, IN1_R, IN2_R, right / ${Math.max(0.3, design.metrics.speedMps || 0.5).toFixed(2)});
}

void stop() { setMotor(CH_L, IN1_L, IN2_L, 0); setMotor(CH_R, IN1_R, IN2_R, 0); }

void setup() {
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  ledcAttach(PWM_L, 20000, 8);
  ledcAttach(PWM_R, 20000, 8);
  pinMode(IN1_L, OUTPUT); pinMode(IN2_L, OUTPUT);
  pinMode(IN1_R, OUTPUT); pinMode(IN2_R, OUTPUT);
  stop();
  Serial.println("${design.title} ready — send 'v w' in m/s and rad/s");
}

void loop() {
  // watchdogs matter: a rover that loses its client should stop, not wander
  static uint32_t lastCmd = 0;
  if (Serial.available()) {
    float v = Serial.parseFloat();
    float w = Serial.parseFloat();
    drive(v, w);
    lastCmd = millis();
  }
  if (millis() - lastCmd > 1200) stop();
}`
}

function gadgetFirmware(design, a, pin, mcus) {
  const display = design.parts.find((p) => PARTS[p.key]?.cat === 'display')?.key || 'ssd1306'
  const sensor = design.parts.find((p) => PARTS[p.key]?.cat === 'sensor')?.key || 'bme280'
  const sensorFw = {
    bme280: { inc: '#include <Adafruit_BME280.h>\nAdafruit_BME280 env;', read: 'env.readTemperature(), env.readHumidity()', unit: '"%.1fC  %.0f%%"', init: 'if (!env.begin(0x76)) Serial.println("BME280 not found");' },
    soil: { inc: '// capacitive probe on an ADC1 pin', read: 'analogReadMilliVolts(KNOB_PIN) / 100.0', unit: '"soil %.0f%%"', init: '' },
    hx711: { inc: '#include "HX711.h"\nHX711 scale;', read: 'scale.get_units(3)', unit: '"%.1fg"', init: 'scale.begin(DATA_PIN, CLK_PIN); scale.tare();' },
    vl53l0x: { inc: '#include <Adafruit_VL53L0X.h>\nAdafruit_VL53L0X tof;', read: '(float)tof.readRangeContinuousMillimeters()', unit: '"%dmm"', init: 'tof.begin(); tof.startRangeContinuous(50);' },
    pir: { inc: '', read: '(float)digitalRead(BUTTON_PIN)', unit: '"motion %d"', init: '' },
    mpu6050: { inc: '// MPU-6050 on I2C', read: '0.0f', unit: '"tilt %.1f"', init: '' },
    bno085: { inc: '#include <Adafruit_BNO08x.h>\nAdafruit_BNO08x imu(-1);', read: '0.0f', unit: '"heading %.0f"', init: 'imu.begin_I2C();' },
    gps: { inc: '#include <TinyGPSPlus.h>\nTinyGPSPlus gps;', read: 'gps.satellites.value()', unit: '"sats %d"', init: '' },
    ov2640: { inc: '// esp_camera_init(camera_config_t*) — PSRAM required', read: '0.0f', unit: '"cam ok"', init: '' },
    inmp441: { inc: '// I2S RX on BCLK/LRCLK/DIN', read: '0.0f', unit: '"rms %.0f"', init: '' },
  }[sensor] || { inc: '', read: '0.0f', unit: '"ready"', init: '' }

  return `/* ${design.title} — ${mcus}
 * Generated by Rigforge: ${display} + ${sensor}, USB-C powered.
 */
#include <Wire.h>
${display === 'ssd1306' ? '#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 oled(128, 64, &Wire, -1);' : '#include <TFT_eSPI.h>\nTFT_eSPI tft;'}
${sensorFw.inc}

const uint8_t SDA_PIN = ${I2C.sda}, SCL_PIN = ${I2C.scl};
const uint8_t KNOB_PIN = ${pin('KNOB', 4)}, BUTTON_PIN = ${pin('BUTTON', 16)};
float lastReading = NAN;
uint32_t lastSample = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  ${display === 'ssd1306' ? 'oled.begin(SSD1306_SWITCHCAPVCC, 0x3C); oled.clearDisplay(); oled.setTextSize(2); oled.setTextColor(SSD1306_WHITE);' : 'tft.init(); tft.setRotation(1); tft.fillScreen(TFT_BLACK);'}
  ${sensorFw.init}
  Serial.println("${design.title} ready");
}

void loop() {
  if (millis() - lastSample < 500) return;
  lastSample = millis();

  lastReading = ${sensorFw.read};
  char line[32];
  snprintf(line, sizeof(line), ${sensorFw.unit}, lastReading);
  Serial.println(line);
  ${display === 'ssd1306'
    ? 'oled.clearDisplay(); oled.setCursor(0, 8); oled.print(line); oled.display();'
    : 'tft.fillScreen(TFT_BLACK); tft.setCursor(10, 40); tft.setTextSize(3); tft.print(line);'}

  if (digitalRead(BUTTON_PIN) == LOW) {
    // a press should do the one thing this device is for — wire it here
  }
}`
}

// ── assembly order ──────────────────────────────────────────────────────────

/** Minutes are honest for hand work, unreadable for a 60-hour print. */
function fmtMinutes(min) {
  if (min == null) return ''
  if (min >= 120) return `${(min / 60).toFixed(1)} h`
  return `${min} min`
}

function stepsFor(design, a) {
  const steps = []
  const push = (title, detail, tools, min) => steps.push({ n: steps.length + 1, title, detail, tools: tools || [], min: min || 10 })
  const printed = design.nodes.filter((n) => n.print)
  const grams = Math.round(a.print.grams)

  push('Print the frame', `${printed.length} printed parts, ${grams}g ${a.print.material.name}, ${fmt(a.print.hours, 0)}h on a 0.4mm nozzle at 0.2mm layers. Orient load-bearing links so layer lines run along the load, not across it.`, ['printer', 'slicer'], Math.round(a.print.hours * 60))

  if (design.archetype === 'arm') {
    push('Press in the bearings', 'Heat-set the M3 inserts first (200°C, straight in, let it cool). Then press 608 bearings into the base and shoulder hubs — a vise or a clamp, never a hammer.', ['heat-set insert tip', 'vise'], 25)
    push('Build the base', 'Bolt the base plate to the tower, seat the yaw servo, then the shoulder servo and bracket. Check the arm swings free by hand before powering anything.', ['M3 hex key', 'threadlocker'], 30)
    push('Assemble the links', `Stack upper arm, forearm and wrist. Every joint must move with zero binding — if it binds, the holes are not concentric and no amount of torque will fix it.`, ['M3 hex key'], 30)
    push('Mount the tool', `Fit the gripper body and jaws. Set the jaw gap to the object you actually intend to pick (currently ~${Math.round(18 + (design.brief.payloadKg || 1) * 6)}mm).`, ['M3 hex key'], 15)
  } else if (design.archetype === 'rover') {
    push('Assemble the chassis', 'Print the deck and rails, press the motor mounts, bolt the motors through the rails. Wheels go on last — they make the whole thing roll off the bench.', ['M3 hex key'], 25)
    push('Wire the drive', `Motor channels to the driver, driver to the ${a.mcu.name}. Solder, heat-shrink, then tug every joint. A rover that loses a motor wire mid-turn drives in circles.`, ['soldering iron', 'wire strippers', 'multimeter'], 40)
    push('Mount the pack', `Strap the ${a.power.bat ? a.power.bat.name : 'pack'} into the well, XT60 to the harness, then check polarity twice before the first plug-in.`, ['XT60', 'multimeter'], 10)
  } else if (design.archetype === 'quadruped') {
    push('Build the legs', '12 identical servo pockets. Do them in production-line order: all four femurs, then all four tibias. Consistency beats cleverness here.', ['M3 hex key'], 45)
    push('Route the harness', 'Two servo rails, one per side. Keep the power pair twisted and away from the I2C lines — PWM noise on an I2C bus is the classic quadruped ghost bug.', ['wire', 'cable ties'], 30)
    push('Calibrate the stand', 'With the body propped up, command 0° everywhere and adjust horn splines until all four feet are level. Do this BEFORE the first gait attempt.', ['horn wrench'], 25)
  } else if (design.archetype === 'robot') {
    push('Build the base', `Deck, rails and bulkheads first, then the four motors. Check the deck is flat to within a millimetre — the arm bolts to it, and a twisted deck becomes a leaning robot.`, ['M3 hex key', 'square'], 40)
    push('Assemble the arm on the bench', 'Arm first, base second: build the turret, shoulder, upper arm and forearm as one assembly and test it with a bench supply. Lifting a whole robot to fix a binding joint is how backs and robots both break.', ['M3 hex key', 'bench supply'], 50)
    push('Bolt the arm to the deck', 'Four bolts through the turret flange into heat-set inserts, threadlocker on all four, then check the arm can sweep its full yaw range without the head or the pack in the way.', ['threadlocker'], 20)
    push('Power and harness', `Split the servo rail from the drive rail: two UBECs, one per side of the deck. Route the arm bundle down through the turret centre so yaw never pulls a wire.`, ['soldering iron', 'cable ties'], 45)
    push('Ballast and stability test', `With the arm at full extension, ${a.checks.some((c) => /stabilit/i.test(c.msg)) ? 'this machine is on the stability edge per the SPEC tab — add pack weight over the rear axle before the first drive' : 'lift one wheel at a time and confirm the other three stay planted'}.`, [], 15)
  } else if (design.archetype === 'gadget') {
    push('Fit the electronics', 'Display to the lid window, MCU on standoffs, sensor aligned with the vent. Test-fit before glue — you will need to get back in there.', ['M3 hex key'], 20)
    push('Wire the bus', `I2C: SDA→GPIO${I2C.sda}, SCL→GPIO${I2C.scl}, 3V3 and GND to every device. Check the addresses with an I2C scan before closing the case.`, ['soldering iron', 'multimeter'], 25)
  } else {
    push('Assemble the mechanism', 'Pinion, racks, jaws and guides. The jaws must slide with light finger pressure and zero wobble.', ['M3 hex key'], 25)
  }

  push('Bring up the MCU', `Flash the generated sketch. Open the serial monitor at 115200 and confirm you see the boot line before you send any command.`, ['USB-C cable', 'arduino-cli'], 15)
  push('Load test', `Run the machine unloaded for 5 minutes, then measure current at the pack: typical should be ~${fmt(a.power.typ, 1)}A, and no connector should be more than hand-warm.`, ['multimeter / clamp meter'], 20)
  push('Verify limits', `Walk every joint to its soft limit slowly and confirm the firmware stops it. ${a.checks.some((c) => c.level === 'fail') ? 'Resolve the failing checks in the SPEC tab first — this machine is not ready to run loaded.' : 'All sizing checks passed at build time.'}`, [], 15)
  return steps
}

// ── geometry: joints → world triangles ──────────────────────────────────────
// A forward-kinematics pass over the serial chain. The renderer and the STL
// exporter read the SAME triangle list, so what you orbit is what you print.

const MAT_RGB = {
  shell: [198, 206, 214],
  accent: [255, 107, 26],
  metal: [140, 150, 162],
  pcb: [32, 96, 70],
  rubber: [38, 42, 48],
  glass: [112, 214, 232],
}

function rotAxis(p, pivot, axis, angle) {
  if (!angle) return p
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const x = p[0] - pivot[0]
  const y = p[1] - pivot[1]
  const z = p[2] - pivot[2]
  if (axis === 'z') return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, p[2]]
  if (axis === 'y') return [pivot[0] + x * c + z * s, p[1], pivot[2] - x * s + z * c]
  return [p[0], pivot[1] + y * c - z * s, pivot[2] + y * s + z * c]
}

/** Joint index a node hangs off (-1 = static). */
function jointDepth(design, id) {
  if (!id) return -1
  return design.joints.findIndex((j) => j.id === id)
}

/** Apply the chain rotations (root → leaf) to a rest-pose point. */
function applyChain(design, point, depth) {
  let p = point
  for (let i = 0; i <= depth; i += 1) {
    const j = design.joints[i]
    // Pitch joints read positive = UP: a slider that raises the arm should not
    // drive it into the table. (Servo direction is flipped in the firmware.)
    const sign = j.axis === 'y' ? -1 : 1
    p = rotAxis(p, j.pivot, j.axis, (sign * j.angle * Math.PI) / 180)
  }
  return p
}

const CYL_SEGS = 18

/** One node → triangles in world space. */
function nodeTriangles(design, node, depth) {
  const tris = []
  const push = (a, b, c) => tris.push({ pts: [applyChain(design, a, depth), applyChain(design, b, depth), applyChain(design, c, depth)], mat: node.mat })

  if (node.kind === 'box') {
    const [sx, sy, sz] = node.size.map((v) => v / 2)
    const [cx, cy, cz] = node.pos
    const corner = (i) => [cx + (i & 1 ? sx : -sx), cy + (i & 2 ? sy : -sy), cz + (i & 4 ? sz : -sz)]
    const faces = [
      [0, 2, 3, 1], // bottom
      [4, 5, 7, 6], // top
      [0, 1, 5, 4], // front
      [2, 6, 7, 3], // back
      [0, 4, 6, 2], // left
      [1, 3, 7, 5], // right
    ]
    for (const f of faces) {
      push(corner(f[0]), corner(f[1]), corner(f[2]))
      push(corner(f[0]), corner(f[2]), corner(f[3]))
    }
    return tris
  }

  // cylinder
  const [cx, cy, cz] = node.pos
  const r = node.radius
  const h = node.height / 2
  const axis = node.axis || 'z'
  const ring = (t, side) => {
    const a = (t / CYL_SEGS) * Math.PI * 2
    const u = Math.cos(a) * r
    const v = Math.sin(a) * r
    if (axis === 'z') return [cx + u, cy + v, cz + (side ? h : -h)]
    if (axis === 'y') return [cx + u, cy + (side ? h : -h), cz + v]
    return [cx + (side ? h : -h), cy + u, cz + v]
  }
  for (let i = 0; i < CYL_SEGS; i += 1) {
    const t0 = i
    const t1 = i + 1
    push(ring(t0, 1), ring(t1, 1), ring(t1, 0))
    push(ring(t0, 1), ring(t1, 0), ring(t0, 0))
    push(ring(t0, 0), ring(t1, 0), [cx, cy, cz])
    push(ring(t0, 1), [cx, cy, cz], ring(t1, 1))
  }
  return tris
}

/** Full mesh for the current pose. */
function buildMesh(design) {
  const tris = []
  for (const node of design.nodes) {
    const depth = jointDepth(design, node.joint)
    const add = nodeTriangles(design, node, depth)
    for (const t of add) tris.push(t)
  }
  return tris
}

// ── exporters ───────────────────────────────────────────────────────────────

/** Binary STL — the file a slicer actually opens. */
function toSTL(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const view = new DataView(buf)
  const header = new Uint8Array(buf, 0, 80)
  const text = 'Rigforge export - mm - generated, not modelled'.padEnd(80, ' ')
  for (let i = 0; i < 80; i += 1) header[i] = text.charCodeAt(i) & 0x7f
  view.setUint32(80, tris.length, true)
  let o = 84
  for (const t of tris) {
    const [a, b, c] = t.pts
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    n = n.map((x) => x / len)
    for (const val of n) { view.setFloat32(o, val, true); o += 4 }
    for (const p of [a, b, c]) for (const val of p) { view.setFloat32(o, val, true); o += 4 }
    view.setUint16(o, 0, true)
    o += 2
  }
  return buf
}

/** Parametric source, not a baked mesh: the user can edit dimensions. */
function toOpenSCAD(design) {
  const lines = [
    `// ${design.title} — Rigforge export`,
    `// Rest pose, mm. Edit the numbers, or $fn for smoother cylinders.`,
    '$fn = 48;',
    '',
  ]
  for (const n of design.nodes) {
    if (n.kind === 'box') {
      lines.push(`translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}]) cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true); // ${n.id}`)
    } else {
      const rot = n.axis === 'x' ? 'rotate([0, 90, 0]) ' : n.axis === 'y' ? 'rotate([90, 0, 0]) ' : ''
      lines.push(`${rot}translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}]) cylinder(h=${n.height.toFixed(1)}, r=${n.radius.toFixed(1)}, center=true); // ${n.id}`)
    }
  }
  return lines.join('\n')
}

function toBOMCsv(design) {
  const rows = [['part', 'category', 'qty', 'unit_usd', 'line_usd', 'role']]
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    rows.push([p.name, p.cat, String(qty), p.price.toFixed(2), (p.price * qty).toFixed(2), role])
  }
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
}

/** The build pack: everything a person needs, in one document. */
function toSpecMarkdown(design, a) {
  const L = []
  const m = design.metrics || {}
  L.push(`# ${design.title}`, '', `_${design.subtitle}_`, '')
  L.push(`**Brief:** ${design.brief.mission || '(no mission text)'}`, '')
  L.push(`| | |`, `|---|---|`)
  L.push(`| Material | ${a.print.material.name} |`)
  L.push(`| Mass | ${Math.round(a.mass.totalG)}g (${Math.round(a.mass.printedG)}g printed) |`)
  L.push(`| Footprint | ${a.dims.map((d) => Math.round(d)).join(' × ')} mm |`)
  L.push(`| Cost | ${money(a.cost)} |`)
  L.push(`| Print | ${fmt(a.print.hours, 0)} h |`)
  L.push(`| Controller | ${a.mcu.name} |`)
  if (m.joints) L.push(`| Actuated joints | ${m.joints} |`)
  if (m.runtimeMin) L.push(`| Runtime | ~${Math.round(m.runtimeMin)} min |`)
  L.push('')

  L.push('## Readiness', '')
  for (const c of a.checks) L.push(`- ${c.level === 'ok' ? 'PASS' : c.level.toUpperCase()} — ${c.msg}`)
  L.push('')

  L.push('## Bill of materials', '', '| Part | Qty | Unit | Line | Role |', '|---|---|---|---|---|')
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    L.push(`| ${p.name} | ${qty} | ${money(p.price)} | ${money(p.price * qty)} | ${role} |`)
  }
  L.push('', `**Total: ${money(a.cost)}**`, '')

  L.push('## Pin map', '', '| Pin | Signal | Dir | Note |', '|---|---|---|---|')
  for (const r of a.pins.rows) L.push(`| ${r.pin} | ${r.signal} | ${r.dir} | ${r.note} |`)
  L.push('')

  L.push('## Power budget', '', '| Rail | Typical | Peak |', '|---|---|---|')
  for (const [rail, v] of Object.entries(a.power.rails)) L.push(`| ${rail} | ${fmt(v.typ, 2)} A | ${fmt(v.peak, 2)} A |`)
  L.push('', `Typical ${fmt(a.power.typ, 2)}A, peak ${fmt(a.power.peak, 2)}A${a.power.runtimeMin ? `, ~${Math.round(a.power.runtimeMin)} min on ${a.power.bat.name}` : ''}.`, '')

  L.push('## Firmware', '', '```cpp', design.firmware.trim(), '```', '')
  L.push('## Assembly', '')
  for (const s of design.steps) L.push(`${s.n}. **${s.title}** (${fmtMinutes(s.min)}) — ${s.detail}${s.tools.length ? ` _Tools: ${s.tools.join(', ')}._` : ''}`)
  L.push('')
  if (design.notes.length) {
    L.push('## Design notes', '')
    for (const n of design.notes) L.push(`- ${n}`)
  }
  L.push('', '---', '_Generated by Rigforge — deterministic spec, no model in the loop._')
  return L.join('\n')
}

// ── brief → machine ─────────────────────────────────────────────────────────

const DEFAULT_BRIEF = {
  archetype: 'arm',
  mission: '5-DoF servo arm for pick and place on a workbench',
  payloadKg: 1,
  reachMm: 450,
  dof: 5,
  material: 'petg',
  mcu: 'esp32s3',
  battery: 'pack3s',
  wheelMm: 100,
}

const PRESETS = [
  { id: 'arm', label: 'Pick & place arm', brief: { archetype: 'arm', mission: '5-DoF arm that sorts 3D-printed parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 } },
  { id: 'rover', label: 'Survey rover', brief: { archetype: 'rover', mission: '4WD rover with a camera mast that maps a room', payloadKg: 2, wheelMm: 100 } },
  { id: 'quad', label: 'Quadruped', brief: { archetype: 'quadruped', mission: '12-servo quadruped that trots and holds its attitude', payloadKg: 1, reachMm: 400 } },
  { id: 'grip', label: 'Parallel gripper', brief: { archetype: 'gripper', mission: 'Servo gripper for a 60mm object, 1.5kg hold', reachMm: 80, payloadKg: 1.5 } },
  { id: 'robot', label: 'Full robot', brief: { archetype: 'robot', mission: 'mobile manipulator: 4WD base, 5-DoF arm, camera head, 1kg payload', payloadKg: 1, reachMm: 450, wheelMm: 130 } },
  { id: 'desk', label: 'ESP32 desk device', brief: { archetype: 'gadget', mission: 'ESP32 desk clock with temperature and humidity on an OLED', reachMm: 0, payloadKg: 0 } },
]

function detectArchetype(text) {
  const t = text.toLowerCase()
  if (/full robot|mobile manipulator|robot arm on a (rover|base|chassis)|drive.*(and|&).*(grab|pick)|whole robot/.test(t)) return 'robot'
  if (/quadruped|quad pod|four.?leg|walking|dog\b|trot/.test(t)) return 'quadruped'
  if (/gripper|claw|jaw|end.?effector/.test(t)) return 'gripper'
  if (/\barm\b|manipulator|pick.?(and|&).?place|6.?dof|5.?dof|delta/.test(t)) return 'arm'
  if (/rover|car\b|robot car|tank|wheels?|mecanum|drive|chassis/.test(t)) return 'rover'
  return 'gadget'
}

/** Pull numbers out of prose. "a 1.2kg payload with 500mm reach, 6 dof". */
function parseBrief(text) {
  const out = { ...DEFAULT_BRIEF, mission: text.trim(), archetype: detectArchetype(text) }
  const kg = text.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)/i)
  if (kg) out.payloadKg = parseFloat(kg[1].replace(',', '.'))
  const g = text.match(/(\d{2,4})\s*g(?:ram)?\b/i)
  if (!kg && g) out.payloadKg = Math.max(0.1, parseFloat(g[1]) / 1000)
  // "130mm wheels" is a wheel Ø, not a reach — the units are the same, the
  // noun is what tells them apart.
  const wheel = text.match(/(\d{2,3})\s*mm[^.,;]{0,14}?wheels?/i) || text.match(/wheels?[^.,;]{0,14}?(\d{2,3})\s*mm/i)
  if (wheel) out.wheelMm = clamp(parseInt(wheel[1], 10), 60, 160)
  const mm = text.match(/(\d{2,4})\s*mm(?!\s*[^.,;]{0,10}wheels?)/i)
  if (mm && !(out.wheelMm && parseInt(mm[1], 10) === out.wheelMm)) out.reachMm = parseInt(mm[1], 10)
  const cm = text.match(/(\d{1,3})\s*cm/i)
  if (!mm && cm) out.reachMm = parseInt(cm[1], 10) * 10
  const dof = text.match(/([3-6])\s*(?:dof|degrees? of freedom|axis)/i)
  if (dof) out.dof = parseInt(dof[1], 10)
  if (/petg/i.test(text)) out.material = 'petg'
  if (/pla\b/i.test(text)) out.material = 'pla'
  if (/raspberry|pico|rp2/i.test(text)) out.mcu = 'pico'
  if (/c6|thread|zigbee/i.test(text)) out.mcu = 'esp32c6'
  if (/lipo/i.test(text)) out.battery = /3s/i.test(text) ? 'lipo3s' : 'lipo2s'
  if (/usb|tethered|desk/i.test(text)) out.battery = 'pd5v'
  if (out.archetype === 'gadget' && !/mm/i.test(text)) out.reachMm = 0
  // DEFAULT_BRIEF carries wheelMm:100, so "not set" has to be decided by the
  // regex, not by the inherited value.
  if (out.archetype === 'robot' && !wheel) out.wheelMm = 130
  return out
}

const cache = new Map()

/** The one entry point everything (UI, exports, tests) goes through. */
function composeDesign(brief) {
  const b = { ...DEFAULT_BRIEF, ...brief }
  const key = JSON.stringify(b)
  if (cache.has(key)) return cache.get(key)
  const design = b.archetype === 'robot' ? buildFullRobot(b)
    : b.archetype === 'rover' ? buildRover(b)
    : b.archetype === 'quadruped' ? buildQuadruped(b)
      : b.archetype === 'gripper' ? buildGripper(b)
        : b.archetype === 'gadget' ? buildGadget(b)
          : buildArm(b)
  const analysis = analyze(design)
  design.firmware = firmwareFor(design, analysis)
  design.steps = stepsFor(design, analysis)
  const out = { design, analysis }
  if (cache.size > 24) cache.clear()
  cache.set(key, out)
  return out
}

/** What we hand the agent: the brief, the numbers, and the contract back. */
function agentPrompt(brief, spec, instruction) {
  const { design, analysis } = spec
  const m = design.metrics || {}
  const lines = [
    instruction || 'Redesign this machine and hand it back.',
    '',
    'I am in the Rigforge build studio. Current machine:',
    `- archetype: ${brief.archetype}`,
    `- brief: ${brief.mission}`,
    `- payload ${brief.payloadKg}kg, reach ${brief.reachMm}mm, ${brief.dof || '-'} DoF, ${design.parts.length} line items`,
    `- mass ${Math.round(analysis.mass.totalG)}g, cost ${money(analysis.cost)}, peak ${fmt(analysis.power.peak, 1)}A`,
    m.joints || m.motor ? `- actuators: ${m.joints || 4} joints / motor ${m.motor ? PARTS[m.motor].name : 'n/a'}` : '',
    analysis.checks.filter((c) => c.level !== 'ok').map((c) => `- ${c.level}: ${c.msg}`).join('\n'),
    '',
    'Reply with a short justification AND a directive I can load straight into the studio:',
    '',
    '::rigforge{brief=<json with archetype, mission, payloadKg, reachMm, dof, material, mcu, battery>}',
    '',
    'Keep it inside these archetypes: arm | rover | quadruped | gripper | gadget.',
    'Only numbers the engine can act on — no prose inside the json.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** `::rigforge{...}` on the way back in. Tolerant: agents are not parsers. */
function parseDirective(attrs) {
  const raw = attrs && (attrs.brief || attrs.spec || attrs.json)
  if (!raw) return null
  try {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    const brief = JSON.parse(text.replace(/&quot;/g, '"'))
    if (!brief || typeof brief !== 'object') return null
    return { ...DEFAULT_BRIEF, ...brief }
  } catch {
    return null
  }
}

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

// ── the studio ──────────────────────────────────────────────────────────────
// A dark instrument surface on purpose: this is a CAD viewport, and a machine
// reads better against graphite than against a light chat theme. Everything
// else in the app stays themed; this page is the workbench.

const C = {
  bg: '#0A0D10',
  panel: '#0E1318',
  panel2: '#121920',
  raise: '#172130',
  line: '#1F2A34',
  lineSoft: '#18212A',
  text: '#E8EFF5',
  dim: '#8FA3B3',
  faint: '#5D6F7D',
  accent: '#FF6A1A',
  accentDim: 'rgba(255,106,26,0.14)',
  cyan: '#39D3E8',
  green: '#4ED08A',
  amber: '#FFC24A',
  red: '#FF5F56',
  mono: 'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
}

const S = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    background: C.bg, color: C.text, fontFamily: 'var(--ui-font, system-ui, sans-serif)',
    fontSize: '13px',
  },
  top: {
    display: 'flex', alignItems: 'center', gap: '18px', padding: '0 16px',
    height: '54px', flex: '0 0 54px', borderBottom: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
  },
  mark: { display: 'flex', alignItems: 'baseline', gap: '9px' },
  wordmark: {
    fontFamily: C.mono, fontWeight: 700, letterSpacing: '0.22em', fontSize: '13px',
    color: C.text,
  },
  tagline: { fontSize: '11px', color: C.faint, letterSpacing: '0.04em' },
  topStats: { display: 'flex', gap: '10px', marginLeft: 'auto', alignItems: 'center' },
  statChip: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '4px 10px',
    border: `1px solid ${C.line}`, borderRadius: '6px', background: C.panel,
    minWidth: '62px',
  },
  statKey: { fontSize: '9px', letterSpacing: '0.12em', color: C.faint, fontFamily: C.mono },
  statVal: { fontSize: '12px', fontFamily: C.mono, color: C.text, fontWeight: 600 },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '30px',
    padding: '0 12px', borderRadius: '6px', border: `1px solid ${C.line}`,
    background: C.panel2, color: C.text, fontSize: '12px', cursor: 'pointer',
    fontFamily: C.mono, letterSpacing: '0.03em', whiteSpace: 'nowrap',
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    height: '34px', padding: '0 14px', borderRadius: '6px', border: '1px solid #ff8a4a',
    background: C.accent, color: '#141414', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: C.mono, letterSpacing: '0.08em', width: '100%',
  },
  body: {
    display: 'grid', gridTemplateColumns: '286px minmax(0,1fr) 382px',
    gap: '1px', background: C.line, flex: '1 1 auto', minHeight: 0,
  },
  col: { background: C.bg, minHeight: 0, display: 'flex', flexDirection: 'column' },
  rail: { background: C.panel, minHeight: 0, overflowY: 'auto', padding: '14px' },
  sectionLabel: {
    fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.18em', color: C.faint,
    margin: '0 0 8px 0', textTransform: 'uppercase',
  },
  field: { marginBottom: '12px' },
  label: {
    display: 'flex', justifyContent: 'space-between', fontSize: '11px',
    color: C.dim, marginBottom: '4px', fontFamily: C.mono,
  },
  input: {
    width: '100%', boxSizing: 'border-box', background: C.bg, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: '6px', padding: '8px 10px',
    fontSize: '12px', fontFamily: 'inherit', resize: 'vertical', outline: 'none',
    lineHeight: 1.45,
  },
  range: { width: '100%', accentColor: C.accent, height: '16px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' },
  chip: {
    padding: '4px 9px', borderRadius: '999px', border: `1px solid ${C.line}`,
    background: C.panel2, color: C.dim, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.mono, whiteSpace: 'nowrap',
  },
  chipOn: {
    padding: '4px 9px', borderRadius: '999px', border: `1px solid ${C.accent}`,
    background: C.accentDim, color: C.accent, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.mono, whiteSpace: 'nowrap',
  },
  viewWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', background: '#080b0e' },
  canvas: { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' },
  hudTL: {
    position: 'absolute', top: '12px', left: '14px', display: 'flex', flexDirection: 'column',
    gap: '3px', pointerEvents: 'none',
  },
  hudRow: { display: 'flex', gap: '8px', alignItems: 'baseline' },
  hudKey: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.14em', color: C.faint, width: '34px' },
  hudVal: { fontFamily: C.mono, fontSize: '11px', color: C.dim },
  hudTR: { position: 'absolute', top: '12px', right: '14px', pointerEvents: 'none' },
  hudHint: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.05em' },
  viewTitle: {
    position: 'absolute', bottom: '14px', left: '88px', fontSize: '12px',
    color: C.dim, pointerEvents: 'none', fontFamily: C.mono, letterSpacing: '0.02em',
  },
  viewSub: { color: C.faint },
  viewTools: {
    position: 'absolute', top: '44px', right: '14px', display: 'flex', flexDirection: 'column',
    gap: '4px',
  },
  tool: {
    width: '58px', padding: '4px 0', textAlign: 'center', borderRadius: '5px',
    border: `1px solid ${C.line}`, background: 'rgba(14,19,24,0.86)', color: C.dim,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.08em',
  },
  toolOn: {
    width: '58px', padding: '4px 0', textAlign: 'center', borderRadius: '5px',
    border: `1px solid ${C.accent}`, background: 'rgba(255,106,26,0.14)', color: C.accent,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.08em',
  },
  jointBar: {
    display: 'flex', gap: '16px', padding: '12px 16px 14px', borderTop: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`, overflowX: 'auto',
    alignItems: 'flex-end', flex: '0 0 auto',
  },
  joint: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '120px', flex: '1 1 120px', maxWidth: '190px' },
  jointTop: { display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '9.5px', color: C.faint },
  tabs: { display: 'flex', gap: '2px', padding: '0 8px', borderBottom: `1px solid ${C.line}`, background: C.panel },
  tab: {
    padding: '9px 8px 8px', fontFamily: C.mono, fontSize: '10px', letterSpacing: '0.1em',
    color: C.faint, cursor: 'pointer', borderBottom: '2px solid transparent', background: 'transparent',
    border: 'none',
  },
  tabOn: {
    padding: '9px 8px 8px', fontFamily: C.mono, fontSize: '10px', letterSpacing: '0.1em',
    color: C.accent, cursor: 'pointer', borderBottom: `2px solid ${C.accent}`, background: 'transparent',
    borderTop: 'none', borderLeft: 'none', borderRight: 'none',
  },
  tabBody: { overflowY: 'auto', padding: '12px 14px 24px', flex: '1 1 auto', minHeight: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '10.5px' },
  th: {
    textAlign: 'left', padding: '4px 6px', color: C.faint, fontWeight: 500,
    letterSpacing: '0.08em', borderBottom: `1px solid ${C.line}`,
  },
  td: { padding: '5px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.dim, verticalAlign: 'top' },
  tdNum: { padding: '5px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.text, textAlign: 'right', whiteSpace: 'nowrap' },
  kv: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', alignItems: 'baseline' },
  kvKey: { color: C.faint, fontSize: '11px', fontFamily: C.mono },
  kvVal: { color: C.text, fontSize: '11.5px', fontFamily: C.mono, textAlign: 'right' },
  pre: {
    margin: 0, padding: '10px 12px', background: '#070A0D', border: `1px solid ${C.line}`,
    borderRadius: '6px', color: '#BFD3E0', fontFamily: C.mono, fontSize: '10.5px',
    lineHeight: 1.55, overflow: 'auto', maxHeight: '100%',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', tabSize: 2,
  },
  warn: {
    display: 'flex', gap: '8px', padding: '7px 9px', borderRadius: '5px',
    fontSize: '11px', lineHeight: 1.45, marginBottom: '6px', alignItems: 'flex-start',
  },
  step: { display: 'flex', gap: '10px', marginBottom: '12px' },
  stepNo: {
    flex: '0 0 auto', width: '20px', height: '20px', borderRadius: '50%',
    border: `1px solid ${C.accent}`, color: C.accent, display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontFamily: C.mono, fontSize: '10px',
  },
  footer: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px',
    borderTop: `1px solid ${C.line}`, background: C.panel,
  },
  shelfRow: {
    display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '6px 8px',
    border: `1px solid ${C.line}`, borderRadius: '5px', marginBottom: '5px',
    cursor: 'pointer', background: C.panel2,
  },
  menu: {
    position: 'absolute', top: '40px', right: '0', zIndex: 20, background: C.panel2,
    border: `1px solid ${C.line}`, borderRadius: '7px', padding: '5px', minWidth: '186px',
    boxShadow: '0 18px 40px rgba(0,0,0,0.55)',
  },
  menuItem: {
    display: 'flex', justifyContent: 'space-between', padding: '7px 9px', borderRadius: '5px',
    fontSize: '11.5px', color: C.text, cursor: 'pointer', fontFamily: C.mono,
  },
}

// The element factory: jsx() directly, with children folded into props.
// `key` goes through jsx's THIRD argument (React 19 warns when it is spread),
// and array children get index keys so static sibling lists stay quiet.
function h(tag, props, ...kids) {
  const p = { ...(props || {}) }
  const key = p.key != null ? p.key : undefined
  delete p.key
  if (kids.length === 1) p.children = kids[0]
  else if (kids.length > 1) p.children = kids.map((k, i) => (k && k.$$el && k.key == null ? { ...k, key: 'k' + i } : k))
  return key === undefined ? jsx(tag, p) : jsx(tag, p, key)
}

const levelColor = (lv) => (lv === 'ok' ? C.green : lv === 'warn' ? C.amber : C.red)
const levelBg = (lv) => (lv === 'ok' ? 'rgba(78,208,138,0.09)' : lv === 'warn' ? 'rgba(255,194,74,0.09)' : 'rgba(255,95,86,0.1)')

function download(name, data, type) {
  const blob = data instanceof ArrayBuffer ? new Blob([data], { type }) : new Blob([data], { type: type || 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'build'
}

// ── the spec rail: seven tabs, each answering one build question ────────────

const TABS = [
  ['spec', 'SPEC'], ['parts', 'BOM'], ['pins', 'PINS'],
  ['power', 'POWER'], ['print', 'PRINT'], ['code', 'CODE'], ['steps', 'BUILD'],
]

function KV({ k, v, accent }) {
  return h('div', { style: { display: 'contents' } },
    h('div', { style: S.kvKey }, k),
    h('div', { style: { ...S.kvVal, color: accent || C.text } }, v))
}

function StatBlock({ label, value, sub, color }) {
  return h('div', {
    style: {
      border: `1px solid ${C.line}`, borderRadius: '7px', padding: '8px 10px',
      background: C.panel2, minWidth: 0,
    },
  },
    h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.14em', color: C.faint } }, label),
    h('div', { style: { fontFamily: C.mono, fontSize: '17px', fontWeight: 600, color: color || C.text, marginTop: '3px' } }, value),
    sub ? h('div', { style: { fontSize: '10px', color: C.faint, marginTop: '2px' } }, sub) : null)
}

function CheckRow({ c }) {
  return h('div', { style: { ...S.warn, background: levelBg(c.level), borderLeft: `2px solid ${levelColor(c.level)}` } },
    h('span', { style: { color: levelColor(c.level), fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', paddingTop: '2px' } },
      c.level === 'ok' ? 'PASS' : c.level.toUpperCase()),
    h('span', { style: { color: C.dim, flex: '1' } }, c.msg))
}

function TabSpec({ design, analysis }) {
  const m = design.metrics || {}
  const a = analysis
  // The header already carries cost/mass/peak/print: the spec tab shows the
  // decomposition instead of repeating the same four numbers.
  const blocks = [
    h('div', { style: { ...S.kv, paddingBottom: '10px', borderBottom: `1px solid ${C.line}`, marginBottom: '12px' } },
      h(KV, { k: 'mass', v: `${Math.round(a.mass.partsG)}g hardware + ${Math.round(a.mass.printedG)}g printed` }),
      h(KV, { k: 'envelope', v: `${a.dims.map((d) => Math.round(d)).join(' × ')} mm` }),
      h(KV, { k: 'controller', v: `${a.mcu.name} · ${a.mcu.logic}V` }),
      h(KV, { k: 'print', v: `${fmt(a.print.hours, 1)}h · ${Math.round(a.print.grams)}g ${a.print.material.name}` }),
      h(KV, {
        k: 'energy',
        v: a.power.runtimeMin ? `${fmt(a.power.typ, 2)}A typ → ~${Math.round(a.power.runtimeMin)} min` : `tethered · ${fmt(a.power.typ, 2)}A typ`,
      }),
      h(KV, { k: 'part count', v: `${design.parts.reduce((s, p) => s + p.qty, 0)} units over ${design.parts.length} line items` })),
  ]

  blocks.push(h('div', { style: S.sectionLabel }, 'readiness'))
  for (const c of a.checks) blocks.push(h(CheckRow, { c }))

  if (design.actuators && design.actuators.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'actuator sizing @ full extension'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'JOINT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'NEED'),
        h('th', { style: S.th }, 'PART'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'STALL'))),
      h('tbody', {}, design.actuators.map((x) => h('tr', { key: x.label },
        h('td', { style: S.td }, x.label),
        h('td', { style: S.tdNum }, `${fmt(x.need, 2)} N·m`),
        h('td', { style: S.td }, PARTS[x.servo].name.replace(/ servo| standard| micro/g, '')),
        h('td', { style: { ...S.tdNum, color: (x.effective || PARTS[x.servo].torque) >= x.need ? C.green : C.red } },
          `${fmt(x.effective || PARTS[x.servo].torque, 2)} N·m${x.ratio > 1 ? ` ${x.ratio}:1` : ''}`))))))
  }

  if (m.motor) {
    const mp = PARTS[m.motor]
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'drivetrain'))
    blocks.push(h('div', { style: S.kv },
      h(KV, { k: 'motor', v: mp.name }), h(KV, { k: 'torque / wheel', v: `${fmt(m.torquePerWheel, 3)} N·m need` }),
      h(KV, { k: 'available', v: `${fmt(mp.torque, 2)} N·m stall`, accent: C.green }),
      h(KV, { k: 'top speed', v: `${fmt(m.speedMps * 3.6, 1)} km/h` }),
      h(KV, { k: 'drive mass', v: `${fmt(m.massKg, 1)} kg` })))
  }
  if (m.peakAmps) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'gait power'))
    blocks.push(h('div', { style: S.kv },
      h(KV, { k: 'servo', v: PARTS[m.servo].name }),
      h(KV, { k: 'joints', v: String(m.joints) }),
      h(KV, { k: 'peak gait', v: `${fmt(m.peakAmps, 1)} A`, accent: C.amber }),
      h(KV, { k: 'leg', v: `${m.legMm} mm` })))
  }
  if (m.gripForceN) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'grip'))
    blocks.push(h('div', { style: S.kv },
      h(KV, { k: 'jaw force', v: `${fmt(m.gripForceN, 0)} N` }),
      h(KV, { k: 'holds (rubber)', v: `${fmt(m.gripMassKg, 1)} kg` }),
      h(KV, { k: 'opening', v: `${m.spanMm} mm` })))
  }

  if (design.notes.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'design notes'))
    for (const n of design.notes) {
      blocks.push(h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.5, marginBottom: '6px', paddingLeft: '8px', borderLeft: `1px solid ${C.line}` } }, n))
    }
  }
  return blocks
}

function TabParts({ design, analysis }) {
  const rows = design.parts.map((p) => ({ ...p, part: PARTS[p.key] }))
  rows.sort((x, y) => y.part.price * y.qty - x.part.price * x.qty)
  return [
    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'PART'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'QTY'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'LINE'))),
      h('tbody', {}, rows.map((r) => h('tr', { key: r.key },
        h('td', { style: S.td },
          h('div', { style: { color: C.text } }, r.part.name),
          h('div', { style: { color: C.faint, fontSize: '9.5px', marginTop: '2px', lineHeight: 1.4 } },
            [r.role, r.part.note].filter(Boolean).join(' · '))),
        h('td', { style: { ...S.tdNum, color: C.dim } }, `×${r.qty}`),
        h('td', { style: S.tdNum }, money(r.part.price * r.qty)))))),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${C.line}`, fontFamily: C.mono, fontSize: '11px' } },
      h('span', { style: { color: C.faint } }, `FILAMENT ${Math.round(analysis.print.grams)}g`),
      h('span', { style: { color: C.accent, fontWeight: 600 } }, `TOTAL ${money(analysis.cost)}`)),
  ]
}

function TabPins({ analysis }) {
  const rows = analysis.pins.rows
  const dirColor = (d) => (d === 'pwr' ? C.amber : d === 'in' ? C.green : d === 'bus' || d === 'pwm' ? C.cyan : C.dim)
  // A 380px rail cannot carry four table columns: pin + signal on one line,
  // the annotation underneath. Same data, half the wrapping.
  return [
    h('div', { style: { fontSize: '11px', color: C.dim, marginBottom: '10px', lineHeight: 1.5 } },
      `${analysis.mcu.name} · ${rows.length} assignments · ${analysis.mcu.pinBudget} GPIO available. ` +
      `Strapping pins 0/3/45/46 and the SPI flash bus are never allocated.`),
    ...rows.map((r, i) => {
      const prev = rows[i - 1]
      const groupBreak = r.part && (!prev || prev.part !== r.part)
      return h('div', {
      key: `${r.pin}-${i}`,
      style: {
        display: 'grid', gridTemplateColumns: '46px 1fr auto', columnGap: '8px',
        padding: '6px 0', borderBottom: `1px solid ${C.lineSoft}`, alignItems: 'baseline',
        marginTop: groupBreak ? '10px' : 0,
        borderTop: groupBreak ? `1px solid ${C.line}` : 'none',
      },
    },
      h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.cyan } }, r.pin),
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '11.5px', color: C.text } }, r.signal),
          r.part ? h('span', { style: { fontFamily: C.mono, fontSize: '9px', color: C.faint } }, r.part.replace(/ servo| standard| micro/g, '')) : null),
        r.note ? h('div', { style: { fontFamily: C.mono, fontSize: '9.5px', color: C.faint, marginTop: '1px', whiteSpace: 'nowrap' } }, r.note) : null),
      h('span', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.08em', color: dirColor(r.dir) } }, r.dir))
    }),
  ]
}

function TabPower({ analysis }) {
  const { rails, bat, typ, peak } = analysis.power
  const max = Math.max(peak, 0.001)
  const bars = Object.entries(rails).filter(([, v]) => v.peak > 0).map(([name, v]) =>
    h('div', { key: name, style: { marginBottom: '10px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '10px', marginBottom: '3px' } },
        h('span', { style: { color: C.dim } }, `${name} rail`),
        h('span', { style: { color: C.text } }, `${fmt(v.typ, 2)}A / ${fmt(v.peak, 2)}A`)),
      h('div', { style: { height: '5px', background: C.panel2, borderRadius: '3px', overflow: 'hidden' } },
        h('div', { style: { width: `${(v.typ / max) * 100}%`, height: '100%', background: C.green } })),
      h('div', { style: { height: '5px', background: C.panel2, borderRadius: '3px', overflow: 'hidden', marginTop: '2px' } },
        h('div', { style: { width: `${(v.peak / max) * 100}%`, height: '100%', background: C.accent } })),
      h('div', { style: { fontSize: '10px', color: C.faint, marginTop: '3px' } },
        v.items.map((i) => `${PARTS[i.key].name.split(' ')[0]} ${fmt(i.peak, 2)}A`).join(' · '))))

  return [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } },
      h(StatBlock, { label: 'TYPICAL', value: `${fmt(typ, 2)}A` }),
      h(StatBlock, { label: 'PEAK', value: `${fmt(peak, 2)}A`, color: C.accent })),
    ...bars,
    h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'energy'),
    h('div', { style: S.kv },
      bat ? h(KV, { k: 'pack', v: bat.name }) : h(KV, { k: 'source', v: 'n/a' }),
      bat ? h(KV, { k: 'voltage', v: `${bat.volts} V` }) : null,
      bat ? h(KV, { k: 'capacity', v: bat.mah ? `${bat.mah} mAh` : 'tethered' }) : null,
      bat ? h(KV, { k: 'burst limit', v: `${bat.maxA} A` }) : null,
      analysis.power.runtimeMin
        ? h(KV, { k: 'runtime @ 80% DoD', v: `${Math.round(analysis.power.runtimeMin)} min`, accent: C.cyan })
        : null),
    h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '10px', lineHeight: 1.55 } },
      'Green = typical draw, orange = worst case with every actuator at stall. Design the wiring for the orange bar, and the fuse between them.'),
  ]
}

function TabPrint({ design, analysis }) {
  const nodes = design.nodes.filter((n) => n.print)
  const rows = nodes
    .map((n) => ({ id: n.id, kind: n.kind, mm3: shellVolume(n), dims: n.kind === 'box' ? n.size : [n.radius * 2, n.radius * 2, n.height] }))
    .sort((a, b) => b.mm3 - a.mm3)
  const total = rows.reduce((s, r) => s + r.mm3, 0) || 1
  return [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } },
      h(StatBlock, { label: 'FILAMENT', value: `${Math.round(analysis.print.grams)}g`, sub: `${(analysis.print.grams / 1000).toFixed(2)} of a 1kg spool` }),
      h(StatBlock, { label: 'MACHINE TIME', value: `${fmt(analysis.print.hours, 1)}h`, sub: `${rows.length} parts` })),
    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'PART'), h('th', { style: S.th }, 'SIZE'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'GRAMS'))),
      h('tbody', {}, rows.map((r) => h('tr', { key: r.id },
        h('td', { style: { ...S.td, color: C.text } }, r.id),
        h('td', { style: { ...S.td, color: C.faint } }, r.dims.map((d) => Math.round(d)).join('×')),
        h('td', { style: S.tdNum }, fmt((r.mm3 / total) * analysis.print.grams, 1)))))),
    h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'print advice'),
    h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.6 } },
      `Material: ${analysis.print.material.name}. 3 walls, 25% gyroid, 0.2mm layers. ` +
      `Orient load-bearing links so the layers run ALONG the load — a printed cantilever fails at the layer line, not at the design stress. ` +
      `Anything over 200mm should be split with dovetails or bolted flanges; heat-set inserts beat printed threads every time.`),
    h('div', { style: { marginTop: '10px' } },
      h('button', {
        style: { ...S.btn, height: '28px' },
        onClick: () => download(`${slug(design.title)}.scad`, toOpenSCAD(design), 'text/plain'),
      }, 'Download OpenSCAD')),
  ]
}

function TabCode({ design }) {
  const lines = design.firmware.split('\n').length
  return [
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
      h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, `${lines} lines · arduino-cli · 115200`),
      h('button', {
        style: { ...S.btn, height: '26px' },
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(design.firmware)
            host.notify({ kind: 'success', message: 'Firmware copied' })
          } catch {
            download('firmware.ino', design.firmware, 'text/plain')
          }
        },
      }, 'Copy')),
    h('pre', { style: S.pre }, design.firmware),
  ]
}

function TabSteps({ design, analysis }) {
  return [
    ...design.steps.map((s) => h('div', { key: s.n, style: S.step },
      h('div', { style: S.stepNo }, String(s.n)),
      h('div', { style: { flex: '1', minWidth: 0 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' } },
          h('div', { style: { fontSize: '12px', fontWeight: 600, color: C.text } }, s.title),
          h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, whiteSpace: 'nowrap' } }, fmtMinutes(s.min))),
        h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.55, marginTop: '2px' } }, s.detail),
        s.tools.length
          ? h('div', { style: { fontFamily: C.mono, fontSize: '9.5px', color: C.cyan, marginTop: '4px', letterSpacing: '0.04em' } }, s.tools.join(' · '))
          : null))),
    h('div', { style: { marginTop: '6px', paddingTop: '10px', borderTop: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '10.5px' } },
      h('span', { style: { color: C.faint } }, 'ESTIMATED BUILD'),
      h('span', { style: { color: C.text } }, `${(design.steps.reduce((s, x) => s + x.min, 0) / 60).toFixed(1)} h`)),
    h('div', { style: { height: '20px' } }),
  ]
}

// ── the page ────────────────────────────────────────────────────────────────

let CTX = null // set in register(); the storage/host door for every component

// ── the agent bridge ────────────────────────────────────────────────────────
// ctx.rest is namespace-scoped to /api/plugins/rigforge. A plugin with no
// mounted backend, an OAuth remote or an older host simply fails closed, so
// every call is wrapped and the topbar shows LINKED / OFFLINE rather than lying.
async function bridge(path, opts) {
  if (!CTX || typeof CTX.rest !== 'function') throw new Error('no plugin backend')
  return CTX.rest(path, opts)
}

/** What the agent reads back after a build: bounded, rounded, no geometry. */
function summarise(design, analysis, brief) {
  return {
    title: design.title,
    archetype: brief.archetype,
    brief,
    cost: Number(analysis.cost.toFixed(2)),
    massG: Math.round(analysis.mass.totalG),
    printHours: Number(analysis.print.hours.toFixed(1)),
    peakAmps: Number(analysis.power.peak.toFixed(2)),
    partCount: design.parts.reduce((s, p) => s + p.qty, 0),
    checks: analysis.checks.slice(0, 6).map((c) => ({ level: c.level, msg: c.msg.slice(0, 200) })),
  }
}

// Fit the camera to the machine: the largest dimension should occupy ~70% of
// the viewport, so the thing the user just designed is actually readable.
const CAM_FOR = (dims) => {
  const diag = Math.hypot(dims[0], dims[1], dims[2]) || 300
  return { ...CAM0, dist: clamp(diag * 1.06, 300, 5200) }
}

function StatChip({ k, v, color }) {
  return h('div', { style: S.statChip },
    h('span', { style: S.statKey }, k),
    h('span', { style: { ...S.statVal, color: color || C.text } }, v))
}

function ParamSlider({ label, value, min, max, step, unit, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label },
      h('span', {}, label),
      h('span', { style: { color: C.text } }, `${value}${unit || ''}`)),
    h('input', {
      type: 'range', min, max, step, value, style: S.range,
      onChange: (e) => onChange(Number(e.target.value)),
    }))
}

function Select({ label, value, options, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label }, h('span', {}, label)),
    h('select', {
      value, style: { ...S.input, padding: '6px 8px', cursor: 'pointer' },
      onChange: (e) => onChange(e.target.value),
    }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))))
}

const ARCHETYPES = [
  ['robot', 'FULL ROBOT'], ['arm', 'ARM'], ['rover', 'ROVER'], ['quadruped', 'QUAD'],
  ['gripper', 'GRIPPER'], ['gadget', 'ESP32'],
]

function Studio() {
  const [brief, setBrief] = useState(() => (CTX && CTX.storage.get('lastBrief', null)) || DEFAULT_BRIEF)
  const [mission, setMission] = useState(() => brief.mission)
  const [tab, setTab] = useState('spec')
  const [menu, setMenu] = useState(false)
  const [shelf, setShelf] = useState(() => (CTX && CTX.storage.get('shelf', [])) || [])
  const [link, setLink] = useState('idle') // 'live' | 'offline' | 'idle'

  const spec = useMemo(() => composeDesign(brief), [brief])
  const { design, analysis } = spec

  const [pose, setPose] = useState(() => design.joints.map(() => 0))
  const [cam, setCam] = useState(() => CAM_FOR(analysis.dims))
  const [opts, setOpts] = useState({ grid: true, dims: false, wire: false })

  // A joint set can change with the brief (3-DoF → 6-DoF): keep the pose array
  // the same length as the chain, or the sliders lie about the machine.
  useEffect(() => {
    setPose((p) => design.joints.map((j, i) => (p[i] == null ? 0 : clamp(p[i], j.min, j.max))))
  }, [design])

  useEffect(() => {
    setCam((c) => ({ ...c, dist: CAM_FOR(analysis.dims).dist }))
  }, [analysis.dims[0], analysis.dims[1], analysis.dims[2]])

  useEffect(() => {
    if (CTX) CTX.storage.set('lastBrief', brief)
  }, [brief])

  // A build handed over by the agent (`::rigforge{...}` → shelf) lands here.
  useEffect(() => {
    if (!CTX) return
    const pending = CTX.storage.get('pendingBrief', null)
    if (pending && pending.mission) {
      CTX.storage.remove('pendingBrief')
      setBrief({ ...DEFAULT_BRIEF, ...pending })
      setMission(pending.mission || '')
    }
  }, [])

  // Publish the computed summary so the agent can read back what was built
  // (`rigforge_state`): debounced, because sliders rebuild the design live.
  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        await bridge('/state', { method: 'POST', body: summarise(design, analysis, brief) })
        if (alive) setLink('live')
      } catch {
        if (alive) setLink('offline')
      }
    }, 600)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [design, analysis, brief])

  // Drain what the agent queued. Draining (not peeking) means each request is
  // applied exactly once, even with two windows open.
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const res = await bridge('/queue?limit=5')
        if (stopped) return
        setLink('live')
        const requests = (res && res.requests) || []
        if (!requests.length) return
        const req = requests[requests.length - 1] // oldest of the batch wins
        const next = { ...DEFAULT_BRIEF, ...(req.brief || {}) }
        setBrief(next)
        if (next.mission) setMission(next.mission)
        setTab('spec')
        host.notify({ kind: 'success', message: `Hermes queued a build: ${next.archetype}${req.note ? ' — ' + req.note : ''}` })
      } catch {
        if (!stopped) setLink('offline')
      }
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [])

  const posedDesign = useMemo(() => ({
    ...design,
    joints: design.joints.map((j, i) => ({ ...j, angle: pose[i] || 0 })),
  }), [design, pose])

  const mesh = useMemo(() => buildMesh(posedDesign), [posedDesign])

  const applyBrief = useCallback((next) => {
    setBrief((cur) => ({ ...cur, ...next }))
  }, [])

  const pickArchetype = (id) => {
    const preset = PRESETS.find((p) => p.brief.archetype === id)
    const next = { ...DEFAULT_BRIEF, ...(preset ? preset.brief : { archetype: id }) }
    setBrief(next)
    setMission(next.mission)
  }

  const onBuild = () => {
    const parsed = parseBrief(mission)
    applyBrief({ ...parsed, material: brief.material, mcu: brief.mcu, battery: brief.battery })
  }

  const saveToShelf = () => {
    const entry = {
      id: `${Date.now()}`,
      title: design.title,
      archetype: brief.archetype,
      cost: Math.round(analysis.cost * 100) / 100,
      brief,
      at: Date.now(),
    }
    const next = [entry, ...shelf.filter((s) => s.title !== design.title)].slice(0, 8)
    setShelf(next)
    if (CTX) CTX.storage.set('shelf', next)
    host.notify({ kind: 'success', message: `${design.title} saved` })
  }

  const askHermes = async () => {
    const prompt = agentPrompt(brief, spec, `Redesign this ${brief.archetype} — make it better and hand it back as a directive.`)
    try {
      const staged = await host.composer.setDraft(null, prompt)
      host.composer.focus(null)
      host.notify({
        kind: staged ? 'success' : 'error',
        message: staged ? 'Spec handed to Hermes — press Enter to send' : 'No composer surface answered; spec copied instead',
      })
      if (!staged) await navigator.clipboard.writeText(prompt)
    } catch {
      try { await navigator.clipboard.writeText(prompt) } catch { /* clipboard blocked */ }
      host.notify({ kind: 'info', message: 'Spec copied — paste it into chat' })
    }
  }

  const fileBase = slug(design.title)
  const exports = [
    ['STL mesh (mm)', () => download(`${fileBase}.stl`, toSTL(buildMesh(posedDesign)), 'model/stl')],
    ['OpenSCAD source', () => download(`${fileBase}.scad`, toOpenSCAD(design), 'text/plain')],
    ['Build spec .md', () => download(`${fileBase}.md`, toSpecMarkdown(design, analysis), 'text/markdown')],
    ['Bill of materials .csv', () => download(`${fileBase}-bom.csv`, toBOMCsv(design), 'text/csv')],
    ['Firmware .ino', () => download(`${fileBase}.ino`, design.firmware, 'text/plain')],
    ['Spec JSON (for Hermes)', async () => {
      const json = JSON.stringify({ brief, design: design.title, metrics: design.metrics, checks: analysis.checks, parts: design.parts }, null, 2)
      try {
        await navigator.clipboard.writeText(json)
        host.notify({ kind: 'success', message: 'Spec JSON copied' })
      } catch {
        download(`${fileBase}.json`, json, 'application/json')
      }
    }],
  ]

  const fails = analysis.checks.filter((c) => c.level === 'fail').length
  const warns = analysis.checks.filter((c) => c.level === 'warn').length

  const panel = tab === 'spec' ? h(TabSpec, { design, analysis })
    : tab === 'parts' ? h(TabParts, { design, analysis })
      : tab === 'pins' ? h(TabPins, { analysis })
        : tab === 'power' ? h(TabPower, { analysis })
          : tab === 'print' ? h(TabPrint, { design, analysis })
            : tab === 'code' ? h(TabCode, { design })
              : h(TabSteps, { design, analysis })

  return h('div', { style: S.root },
    // ── top bar ────────────────────────────────────────────────────────────
    h('div', { style: S.top },
      h('div', { style: S.mark },
        h('span', { style: { fontFamily: C.mono, fontSize: '16px', color: C.accent, lineHeight: 1 } }, '⌬'),
        h('span', { style: S.wordmark }, 'RIGFORGE'),
        h('span', { style: S.tagline }, 'robots · printed machines · spec out')),
      h('div', { style: S.topStats },
        h(StatChip, { k: 'COST', v: money(analysis.cost) }),
        h(StatChip, { k: 'MASS', v: `${Math.round(analysis.mass.totalG)}g` }),
        h(StatChip, { k: 'PEAK', v: `${fmt(analysis.power.peak, 1)}A`, color: analysis.power.peak > (analysis.power.bat?.maxA || 99) ? C.amber : C.text }),
        h(StatChip, { k: 'PRINT', v: `${fmt(analysis.print.hours, 0)}h` }),
        h(StatChip, { k: 'CHECKS', v: fails ? `${fails} FAIL` : warns ? `${warns} WARN` : 'PASS', color: fails ? C.red : warns ? C.amber : C.green }),
        h(StatChip, { k: 'AGENT', v: link === 'live' ? 'LINKED' : link === 'offline' ? 'OFFLINE' : '…', color: link === 'live' ? C.green : link === 'offline' ? C.faint : C.dim }),
        h('button', { style: { ...S.btn, borderColor: C.accent, color: C.accent }, onClick: askHermes }, '⌁ ASK HERMES'),
        h('div', { style: { position: 'relative' } },
          h('button', { style: S.btn, onClick: () => setMenu((m) => !m) }, 'EXPORT ▾'),
          menu
            ? h('div', { style: S.menu },
              exports.map(([label, fn]) => h('div', {
                key: label, style: S.menuItem,
                onClick: () => { setMenu(false); fn() },
                onMouseEnter: (e) => { e.currentTarget.style.background = C.raise },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
              }, h('span', {}, label))))
            : null),
        h('button', { style: S.btn, onClick: saveToShelf }, 'SAVE')),
    ),

    // ── body ───────────────────────────────────────────────────────────────
    h('div', { style: S.body },
      // left rail: the brief
      h('div', { style: S.rail },
        h('div', { style: S.sectionLabel }, 'brief'),
        h('textarea', {
          rows: 3, value: mission, style: { ...S.input, marginBottom: '8px' },
          placeholder: 'Describe the machine — "4WD rover that maps a room, 3kg of gear"',
          onChange: (e) => setMission(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onBuild() },
        }),
        h('div', { style: S.chips },
          ARCHETYPES.map(([id, label]) => h('button', {
            key: id, style: brief.archetype === id ? S.chipOn : S.chip,
            onClick: () => pickArchetype(id),
          }, label))),
        h('div', { style: S.chips, marginBottom: '14px' },
          PRESETS.map((p) => h('button', {
            key: p.id, style: S.chip,
            onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission) },
          }, p.label))),

        h('button', { style: S.btnPrimary, onClick: onBuild }, 'BUILD FROM BRIEF'),

        h('div', { style: { ...S.sectionLabel, marginTop: '16px' } }, 'parameters'),
        brief.archetype === 'gadget'
          ? h(Select, {
            label: 'MATERIAL', value: brief.material,
            options: [{ value: 'pla', label: 'PLA+ · stiff' }, { value: 'petg', label: 'PETG · tough' }],
            onChange: (v) => applyBrief({ material: v }),
          })
          : h('div', {},
            h(ParamSlider, {
              label: 'PAYLOAD', value: brief.payloadKg, min: 0.1, max: brief.archetype === 'rover' ? 15 : 6, step: 0.1, unit: ' kg',
              onChange: (v) => applyBrief({ payloadKg: v }),
            }),
            brief.archetype === 'rover' || brief.archetype === 'robot'
              ? h(ParamSlider, {
                label: 'WHEEL Ø', value: brief.wheelMm || (brief.archetype === 'robot' ? 130 : 100),
                min: brief.archetype === 'robot' ? 80 : 60, max: brief.archetype === 'robot' ? 160 : 130,
                step: 5, unit: ' mm',
                onChange: (v) => applyBrief({ wheelMm: v }),
              })
              : h(ParamSlider, {
                label: brief.archetype === 'gripper' ? 'JAW OPENING' : brief.archetype === 'quadruped' ? 'LEG SPAN' : 'REACH',
                value: brief.reachMm, min: 120, max: 1200, step: 10, unit: ' mm',
                onChange: (v) => applyBrief({ reachMm: v }),
              }),
            brief.archetype === 'arm'
              ? h(ParamSlider, { label: 'AXES', value: brief.dof, min: 3, max: 6, step: 1, onChange: (v) => applyBrief({ dof: v }) })
              : null,
            h(Select, {
              label: 'MATERIAL', value: brief.material,
              options: [{ value: 'petg', label: 'PETG · tough' }, { value: 'pla', label: 'PLA+ · stiff' }],
              onChange: (v) => applyBrief({ material: v }),
            })),

        h(Select, {
          label: 'CONTROLLER', value: brief.mcu,
          options: MCU_KEYS.map((k) => ({ value: k, label: PARTS[k].name })),
          onChange: (v) => applyBrief({ mcu: v }),
        }),
        brief.archetype !== 'gadget'
          ? h(Select, {
            label: 'ENERGY', value: brief.battery,
            options: [
              { value: 'pack2s', label: '2S 18650 · 7.4V' },
              { value: 'pack3s', label: '3S 18650 · 11.1V' },
              { value: 'lipo2s', label: 'LiPo 2S 1000mAh' },
              { value: 'lipo3s', label: 'LiPo 3S 2200mAh' },
              { value: 'pd5v', label: 'USB-C tethered' },
            ],
            onChange: (v) => applyBrief({ battery: v }),
          })
          : null,

        shelf.length
          ? h('div', {},
            h('div', { style: { ...S.sectionLabel, marginTop: '10px' } }, 'shelf'),
            shelf.map((s) => h('div', {
              key: s.id, style: S.shelfRow,
              onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...s.brief }); setMission(s.brief.mission) },
            },
              h('span', { style: { fontSize: '11px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title),
              h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, money(s.cost)))))
          : null,

        h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: `1px solid ${C.line}`, fontSize: '10px', color: C.faint, lineHeight: 1.5 } },
          'Deterministic engine: torque, current, mass and print time are computed, not narrated. The agent redesigns; the maths here is yours.')),

      // centre: viewport
      h('div', { style: { ...S.col, minWidth: 0, position: 'relative' } },
        h(Viewport, { mesh, cam, setCam, opts, design, analysis }),
        h('div', { style: S.viewTools },
          ['ISO', 'FRONT', 'SIDE', 'TOP'].map((v, i) => {
            const views = [
              { yaw: -0.62, pitch: 0.42 }, { yaw: -Math.PI / 2, pitch: 0.02 },
              { yaw: 0, pitch: 0.02 }, { yaw: -Math.PI / 2, pitch: 1.44 },
            ]
            return h('button', {
              key: v, style: S.tool, onClick: () => setCam((c) => ({ ...c, ...views[i] })),
            }, v)
          }),
          h('button', {
            style: opts.grid ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, grid: !o.grid })),
          }, 'GRID'),
          h('button', {
            style: opts.dims ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, dims: !o.dims })),
          }, 'DIMS'),
          h('button', {
            style: opts.wire ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, wire: !o.wire })),
          }, 'WIRE'),
          h('button', {
            style: cam.ortho ? S.toolOn : S.tool,
            onClick: () => setCam((c) => ({ ...c, ortho: !c.ortho })),
          }, 'ORTHO')),
        h('div', { style: S.jointBar },
          design.joints.length
            ? design.joints.map((j, i) => h('div', { key: j.id, style: S.joint },
              h('div', { style: S.jointTop },
                h('span', {}, j.label.toUpperCase().slice(0, 14)),
                h('span', { style: { color: C.accent } }, `${Math.round(pose[i] || 0)}°`)),
              h('input', {
                type: 'range', min: j.min, max: j.max, step: 1, value: pose[i] || 0,
                style: { ...S.range, height: '14px' },
                onChange: (e) => {
                  const v = Number(e.target.value)
                  setPose((p) => p.map((x, k) => (k === i ? v : x)))
                },
              })))
            : h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, padding: '8px 0' } },
              'no articulated joints — static assembly'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            h('button', { style: S.tool, onClick: () => setPose(design.joints.map(() => 0)) }, 'HOME'),
            h('button', {
              style: S.tool,
              onClick: () => setPose(design.joints.map((j, i) => (i === 0 ? 0 : Math.round(i % 2 ? j.max * 0.6 : j.min * 0.55)))),
            }, 'POSE')))),

      // right rail: the spec
      h('div', { style: S.col },
        h('div', { style: S.tabs },
          TABS.map(([id, label]) => h('button', {
            key: id, style: tab === id ? S.tabOn : S.tab,
            onClick: () => setTab(id),
          }, label))),
        h('div', { style: S.tabBody }, panel),
        h('div', { style: S.footer },
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.1em' } },
            `${design.parts.length} LINE ITEMS`),
          h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: '14px', fontWeight: 600, color: C.accent } }, money(analysis.cost)))),
    ),
  )
}

// ── registration: page, nav, palette, and the agent's way back in ───────────

/**
 * The transcript directive. An agent that wants to hand a machine to the user
 * writes ONE line in chat:
 *
 *   ::rigforge{brief={"archetype":"rover","mission":"moon rover","payloadKg":4}}
 *
 * and this renders as a load-into-studio card. This is the agent→plugin door:
 * the studio page is the plugin's state, storage carries the brief across the
 * navigation, and nothing here trusts the attrs beyond the JSON parse.
 */
function DirectiveCard({ attrs }) {
  const brief = parseDirective(attrs)
  if (!brief) {
    return h('div', { style: { fontFamily: C.mono, fontSize: '11px', color: C.red, padding: '8px 10px', border: `1px solid ${C.line}`, borderRadius: '6px' } },
      'rigforge: could not parse the brief JSON in this directive')
  }
  const { design, analysis } = composeDesign(brief)
  const open = () => {
    if (CTX) CTX.storage.set('pendingBrief', brief)
    host.navigate(ROUTE)
  }
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 14px',
      border: `1px solid ${C.line}`, borderRadius: '8px', background: C.panel,
      color: C.text, maxWidth: '640px',
    },
  },
    h('div', { style: { flex: '1', minWidth: 0 } },
      h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.16em', color: C.accent } }, 'RIGFORGE · BUILD'),
      h('div', { style: { fontSize: '13px', fontWeight: 600, marginTop: '3px' } }, design.title),
      h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.dim, marginTop: '3px' } },
        `${design.parts.length} parts · ${money(analysis.cost)} · ${Math.round(analysis.mass.totalG)}g · ${fmt(analysis.print.hours, 0)}h print`)),
    h('button', {
      style: { ...S.btn, borderColor: C.accent, color: C.accent, flex: '0 0 auto' },
      onClick: open,
    }, 'OPEN IN STUDIO'))
}

const plugin = {
  id: 'rigforge',
  name: 'Rigforge',
  description: 'Build studio for robots and printed machines: posed 3D geometry, joint/physics sizing, ESP32 pin map, firmware, BOM and STL export.',
  version: '1.0.0',
  defaultEnabled: true,

  register(ctx) {
    CTX = ctx

    ctx.contribution(ROUTES_AREA, {
      id: 'rigforge.page',
      data: { path: ROUTE },
      title: 'Rigforge',
      render: () => h(Studio),
    })

    ctx.contribution(SIDEBAR_NAV_AREA, {
      id: 'rigforge.nav',
      data: { path: ROUTE, label: 'Rigforge', codicon: 'circuit-board' },
    })

    const quick = (id, label, keywords, brief, detail) => ctx.contribution(PALETTE_AREA, {
      id,
      data: {
        label,
        keywords,
        icon: 'circuit-board',
        detail: () => detail,
        run: () => {
          if (brief) {
            CTX.storage.set('pendingBrief', { ...DEFAULT_BRIEF, ...brief })
            host.navigate(ROUTE)
          } else {
            host.navigate(ROUTE)
          }
        },
      },
    })

    quick('rigforge.open', 'Rigforge: build studio', ['robot', 'hardware', 'cad', '3d', 'esp32'], null, 'Robots and printed machines, spec’d end to end')
    quick('rigforge.robot', 'Rigforge: new full robot', ['full robot', 'mobile manipulator', 'arm on a base'], PRESETS.find((p) => p.brief.archetype === 'robot').brief, '4WD base + 5-DoF arm + head, sized as one machine')
    quick('rigforge.arm', 'Rigforge: new robot arm', ['servo', 'arm', 'manipulator'], PRESETS[0].brief, '5-DoF arm with sized servos')
    quick('rigforge.rover', 'Rigforge: new rover', ['rover', 'wheels', 'drive'], PRESETS[1].brief, '4WD rover with torque + runtime maths')
    quick('rigforge.quad', 'Rigforge: new quadruped', ['quadruped', 'walking', 'servos'], PRESETS[2].brief, '12-servo gait machine')
    quick('rigforge.gadget', 'Rigforge: new ESP32 device', ['esp32', 'sensor', 'enclosure'], PRESETS[4].brief, 'Desk device with a printed case')

    ctx.contribution(TRANSCRIPT_DIRECTIVE_AREA, {
      id: 'rigforge.directive',
      data: {
        name: 'rigforge',
        render: (props) => h(DirectiveCard, { attrs: props.attrs || {} }),
      },
    })

    // Settings ▸ Plugins ▸ Rigforge — plain themed text, no studio palette here:
    // this page lives inside the app's own chrome.
    ctx.registerSettingsPage?.({
      id: 'about',
      title: 'Rigforge',
      icon: 'circuit-board',
      render: () => h('div', { style: { padding: '4px 2px', display: 'grid', gap: '10px', maxWidth: '620px' } },
        h('div', { style: { fontSize: '13px', lineHeight: 1.6, color: 'var(--ui-text-secondary, inherit)' } },
          'A build studio for robots and printed machines. Describe a machine and it returns geometry, joint sizing, a power budget, a pin map, firmware, a BOM and assembly order — all computed, not generated prose.'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 12px', fontFamily: C.mono, fontSize: '11px' } },
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'archetypes'),
          h('span', {}, 'arm · rover · quadruped · gripper · gadget'),
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'engine'),
          h('span', {}, 'deterministic, offline'),
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'exports'),
          h('span', {}, 'STL · OpenSCAD · spec.md · BOM.csv · firmware.ino'),
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'agent door'),
          h('span', {}, '::rigforge{brief={"archetype":"rover","payloadKg":4}}'))),
    })
  },
}

export default plugin

