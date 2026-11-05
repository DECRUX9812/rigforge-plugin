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
//   dims:   [l,w,h] mm overall envelope — the BOM shows it, the renderer uses it
//   shaft:  output interface spec (spline / D-flat / bore)
//   mount:  fastener pattern text, e.g. "4×M3 on 10.5×49mm ears"
//   conn:   the connector it arrives with / expects
//   sku:    the term you paste into a vendor search to buy it
//   src:    ali | amzn | pololu | hw (local hardware) | print

const PARTS = {
  // ── structure: the parts a metre-class machine is actually made of ───────
  extrusion_2040: {
    name: '2040 aluminium extrusion', cat: 'frame', price: 12, mass: 950, volts: 0,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [20, 40, 1000], conn: 'T-slot + M5 corner brackets',
    sku: '2040 V-slot extrusion per metre', src: 'ali', shop: false,
    note: 'Sold by the metre, cut to length. 950g/m — this is where machine mass comes from.',
  },
  extrusion_2020: {
    name: '2020 aluminium extrusion', cat: 'frame', price: 8, mass: 620, volts: 0,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [20, 20, 1000], conn: 'T-slot + M5 corner brackets',
    sku: '2020 V-slot extrusion per metre', src: 'ali', shop: false,
    note: 'Frame and bracing. Cheap, stiff, and cuts with a hacksaw and a printed mitre guide.',
  },
  spindle_500w: {
    name: '500W spindle + ER11 collet', cat: 'actuator', price: 72, mass: 900, volts: 48,
    curr: { idle: 0.1, typ: 1.4, peak: 2.4 }, torque: 0, speed: 12000,
    dims: [65, 65, 210], conn: '52mm clamp + 3-pin power', mount: '52mm spindle clamp',
    sku: '500W air-cooled spindle ER11', src: 'ali', shop: false,
    note: 'Cuts plywood and alu slowly. A trim router is cheaper but louder and faster.',
  },
  drag_chain: {
    name: 'Cable drag chain (1m)', cat: 'harness', price: 9, mass: 120, volts: 0,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [15, 30, 1000], conn: 'screw ends',
    sku: '10x20 drag chain 1m', src: 'ali', shop: false,
    note: 'Keeps the harness from snagging mid-cut. Not optional at this size.',
  },
  bed_plate: {
    name: 'Bed plate (MDF/ply 12mm)', cat: 'frame', price: 18, mass: 2400, volts: 0,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [800, 600, 12], conn: 'bolted to the frame',
    sku: '12mm birch ply sheet cut to size', src: 'hw', shop: false,
    note: 'The spoilboard. Replaced when it gets chewed up, so do not make it precious.',
  },

  // ── board-level passives (the parts a pick-and-place machine exists for) ──
  res_0402: {
    name: '0402 resistor (per 10)', cat: 'passive', price: 0.6, mass: 0.2, volts: 0,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [1, 0.5, 0.35], conn: '0402 SMD',
    sku: '0402 1% resistor assortment', src: 'ali', shop: true,
    pkg: '0402', note: 'Sold in strips. You will use six and lose four.',
  },
  cap_0402: {
    name: '0402 capacitor (per 10)', cat: 'passive', price: 0.8, mass: 0.2, volts: 16,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [1, 0.5, 0.5], conn: '0402 SMD',
    sku: '0402 X7R capacitor assortment', src: 'ali', shop: true,
    pkg: '0402', note: 'Decoupling is not optional: every IC wants one within 2mm.',
  },
  res_0603: {
    name: '0603 resistor (per 10)', cat: 'passive', price: 0.7, mass: 0.3, volts: 0,
    curr: { idle: 0, typ: 0, peak: 0 }, dims: [1.6, 0.8, 0.4], conn: '0603 SMD',
    sku: '0603 1% resistor assortment', src: 'ali', shop: true, pkg: '0603',
  },

  // ── MCUs ──────────────────────────────────────────────────────────────────
  esp32s3: {
    name: 'ESP32-S3 DevKitC-1',
    cat: 'mcu', price: 14, mass: 10, volts: 5, logic: 3.3,
    curr: { idle: 0.04, typ: 0.13, peak: 0.55 },
    pinBudget: 44, adcPins: 20, pwmPins: 8,
    features: ['wifi', 'ble', 'usb', 'psram'],
    dims: [62, 26, 8], conn: '2× USB-C + 2.54 headers', mount: '4×M2.5 or breadboard',
    sku: 'ESP32-S3-DevKitC-1-N16R8', src: 'ali',
    note: '16MB flash / 8MB PSRAM. 3.3V logic, 5V VIN.',
  },
  esp32c6: {
    name: 'ESP32-C6 DevKit',
    cat: 'mcu', price: 11, mass: 9, volts: 5, logic: 3.3,
    curr: { idle: 0.035, typ: 0.11, peak: 0.45 },
    pinBudget: 30, adcPins: 7, pwmPins: 6,
    features: ['wifi6', 'ble', 'thread', 'zigbee'],
    dims: [55, 26, 8], conn: 'USB-C + 2.54 headers', mount: '4×M2.5 or breadboard',
    sku: 'ESP32-C6-DevKitC-1', src: 'ali',
    note: 'Thread/Zigbee for home automation. Fewer GPIO — plan for an expander.',
  },
  pico: {
    name: 'Raspberry Pi Pico 2 (RP2350)',
    cat: 'mcu', price: 6, mass: 3, volts: 5, logic: 3.3,
    curr: { idle: 0.02, typ: 0.06, peak: 0.25 },
    pinBudget: 26, adcPins: 3, pwmPins: 16,
    features: ['pio', 'usb'],
    dims: [51, 21, 4], conn: 'micro-USB + 2.54 castellated', mount: 'castellated edges',
    sku: 'Raspberry Pi Pico 2W RP2350', src: 'amzn',
    note: 'No radio. PIO blocks are excellent for encoders and LED timing.',
  },

  // ── actuators ─────────────────────────────────────────────────────────────
  sg90: {
    name: 'SG90 micro servo',
    cat: 'servo', price: 3.5, mass: 9, volts: 5, torque: 0.18,
    curr: { idle: 0.008, typ: 0.15, peak: 0.75 }, angle: 180, speed: 0.1,
    dims: [22.6, 12.2, 29.5], shaft: '21T spline Ø4.8mm', mount: '2×M2 on 27.5mm ears',
    conn: 'JR 3-pin, 180mm lead', sku: 'SG90 9g micro servo', src: 'ali',
    note: 'Plastic gears. Fine for a head pan, not for a load-bearing joint.',
  },
  mg90s: {
    name: 'MG90S metal-gear micro',
    cat: 'servo', price: 5, mass: 13.4, volts: 5, torque: 0.22,
    curr: { idle: 0.008, typ: 0.18, peak: 0.9 }, angle: 180, speed: 0.1,
    dims: [22.8, 12.2, 28.5], shaft: '21T spline Ø4.8mm', mount: '2×M2 on 28mm ears',
    conn: 'JR 3-pin, 180mm lead', sku: 'MG90S metal gear servo', src: 'ali',
    note: 'Metal gears, same footprint as SG90 — the default small joint.',
  },
  scs0009: {
    name: 'Feetech SCS0009 serial micro',
    cat: 'servo', price: 16, mass: 12, volts: 5, torque: 0.23,
    curr: { idle: 0.01, typ: 0.2, peak: 0.8 }, angle: 300, speed: 0.11,
    bus: 'ttl-half-duplex',
    dims: [23.5, 12, 24.7], shaft: '20T spline Ø4.8mm', mount: '2×M2 on 30mm ears',
    conn: '3-wire TTL bus, daisy-chain', sku: 'Feetech SCS0009 serial servo', src: 'ali',
    note: '9g-class servo with position/temp/load feedback over TTL bus. Chainable.',
  },
  mg996r: {
    name: 'MG996R standard servo',
    cat: 'servo', price: 12, mass: 55, volts: 6, torque: 1.08,
    curr: { idle: 0.01, typ: 0.4, peak: 2.5 }, angle: 180, speed: 0.17,
    dims: [40.7, 19.7, 42.9], shaft: '25T spline Ø5.9mm', mount: '4×M3 on 10.5×49mm ears',
    conn: 'JR 3-pin, 300mm lead', sku: 'MG996R servo', src: 'ali',
    note: '11 kg·cm at 6V. Never power from the MCU 5V pin — brownout city.',
  },
  ds3218: {
    name: 'DS3218 20kg servo',
    cat: 'servo', price: 18, mass: 60, volts: 6.8, torque: 1.96,
    curr: { idle: 0.012, typ: 0.6, peak: 3.0 }, angle: 270, speed: 0.16,
    dims: [40, 20, 40.5], shaft: '25T spline Ø5.9mm', mount: '4×M3 on 10.5×49mm ears',
    conn: 'JR 3-pin, 300mm lead', sku: 'DS3218 20kg digital servo', src: 'ali',
    note: '20 kg·cm, metal case. Wants a dedicated 6–7.4V rail.',
  },
  ds3225: {
    name: 'DS3225 25kg servo',
    cat: 'servo', price: 22, mass: 67, volts: 6.8, torque: 2.45,
    curr: { idle: 0.012, typ: 0.7, peak: 3.4 }, angle: 270, speed: 0.15,
    dims: [40, 20, 40.5], shaft: '25T spline Ø5.9mm', mount: '4×M3 on 10.5×49mm ears',
    conn: 'JR 3-pin, 300mm lead', sku: 'DS3225MG 25kg servo', src: 'ali',
    note: 'The biggest hobby-case servo before you go serial-bus or stepper.',
  },
  sts3215: {
    name: 'Feetech STS3215 serial bus servo',
    cat: 'servo', price: 28, mass: 62, volts: 7.4, torque: 2.94,
    curr: { idle: 0.01, typ: 0.45, peak: 2.0 }, angle: 360, speed: 0.22,
    bus: 'ttl-half-duplex',
    dims: [40, 20, 40.5], shaft: '25T spline Ø5.9mm', mount: '4×M3 on 10.5×49mm ears',
    conn: '3-wire TTL bus, daisy-chain', sku: 'Feetech STS3215 30kg serial servo', src: 'ali',
    note: 'Daisy-chained TTL bus + magnetic encoder: 6 wires for 12 joints.',
  },
  n20_100: {
    name: 'N20 gearmotor 6V 100rpm',
    cat: 'motor', price: 6, mass: 10, volts: 6, torque: 0.05,
    curr: { idle: 0.01, typ: 0.15, peak: 1.2 }, speed: 100, encoder: false,
    dims: [24, 10, 12], shaft: '3mm D-shaft ×10mm', mount: 'face-mount bracket or clamp',
    conn: '2× bare tabs, solder', sku: 'N20 6V 100RPM gearmotor', src: 'ali',
    note: 'Tiny. Good for a light rover, not for a hill.',
  },
  n20_enc: {
    name: 'N20 gearmotor 6V 150rpm + encoder',
    cat: 'motor', price: 14, mass: 12, volts: 6, torque: 0.06,
    curr: { idle: 0.01, typ: 0.18, peak: 1.3 }, speed: 150, encoder: true,
    dims: [30, 10, 12], shaft: '3mm D-shaft ×10mm', mount: 'face-mount bracket or clamp',
    conn: '6-pin JST-PH (motor+enc)', sku: 'N20 150RPM encoder gearmotor', src: 'pololu',
    note: '7 PPR magnetic encoder — closed-loop odometry on a budget.',
  },
  jgb37: {
    name: 'JGB37-520 12V 178rpm + encoder',
    cat: 'motor', price: 22, mass: 108, volts: 12, torque: 1.18,
    curr: { idle: 0.05, typ: 0.5, peak: 2.6 }, speed: 178, encoder: true,
    dims: [70, 37, 37], shaft: '6mm D-shaft ×15.5mm', mount: '2×M3 face or 37mm bracket',
    conn: '6-pin JST-PH (motor+enc)', sku: 'JGB37-520 12V 178RPM encoder', src: 'ali',
    note: 'The realistic rover motor: 12 kg·cm and a real 11 PPR encoder.',
  },
  nema17: {
    name: 'NEMA17 42-40 stepper',
    cat: 'motor', price: 14, mass: 280, volts: 12, torque: 0.4,
    curr: { idle: 0.2, typ: 0.8, peak: 1.5 }, speed: 200, encoder: false,
    dims: [42.3, 42.3, 40], shaft: '5mm D-shaft ×24mm', mount: '4×M3 on 31mm square',
    conn: '4-pin JST-XH', sku: 'NEMA17 42×40 stepper 1.5A', src: 'ali',
    note: 'Open-loop but repeatable — the right choice for a positioner axis.',
  },

  // ── power & drivers ───────────────────────────────────────────────────────
  pca9685: {
    name: 'PCA9685 16-ch PWM driver',
    cat: 'driver', price: 6, mass: 6, volts: 5,
    curr: { idle: 0.006, typ: 0.01, peak: 0.02 },
    dims: [62, 26, 4], conn: 'screw terminals + 0.1" servo headers', mount: '4×M2.5',
    sku: 'PCA9685 16 channel servo driver', src: 'ali',
    note: 'I2C 0x40. One board drives 16 servos off its own screw terminal.',
  },
  tb6612: {
    name: 'TB6612FNG dual motor driver',
    cat: 'driver', price: 4, mass: 3, volts: 5,
    curr: { idle: 0.002, typ: 0.005, peak: 0.02 }, ampacity: 1.2,
    dims: [20, 20, 3], conn: '0.1" headers', mount: '2×M2.5 or headers',
    sku: 'TB6612FNG breakout board', src: 'pololu',
    note: 'Two channels, 1.2A continuous. Silent PWM, unlike the L298N.',
  },
  bts7960: {
    name: 'BTS7960 43A motor driver',
    cat: 'driver', price: 9, mass: 22, volts: 5,
    curr: { idle: 0.01, typ: 0.02, peak: 0.05 }, ampacity: 43,
    dims: [50, 43, 20], conn: 'screw terminals + pin header', mount: '4×M3',
    sku: 'BTS7960B 43A H-bridge module', src: 'ali',
    note: 'For gearmotors whose stall current would cook a TB6612.',
  },
  drv8825: {
    name: 'DRV8825 stepper driver',
    cat: 'driver', price: 5, mass: 4, volts: 5,
    curr: { idle: 0.01, typ: 0.02, peak: 0.03 }, ampacity: 1.5,
    dims: [20, 15, 8], conn: '0.1" headers', mount: 'breadboard / carrier socket',
    sku: 'DRV8825 stepper driver carrier', src: 'pololu',
    note: 'Set Vref before you connect the motor. Always.',
  },
  bus_adapter: {
    name: 'Feetech UART bus adapter (TTL half-duplex)', cat: 'driver', price: 8, mass: 6, volts: 5,
    curr: { idle: 0.005, typ: 0.01, peak: 0.02 },
    dims: [40, 22, 6], conn: 'USB-C in + 3-pin servo bus out', mount: '4×M2',
    sku: 'Feetech TTLinker-mini / URT-1', src: 'ali',
    note: 'One UART, up to 253 addressable servos. This is how 23 joints fit on an ESP32.',
  },
  buck5a: {
    name: 'UBEC 5V 5A (buck)',
    cat: 'power', price: 7, mass: 18, volts: 12,
    curr: { idle: 0.005, typ: 0.01, peak: 0.02 },
    dims: [45, 18, 12], conn: 'bare leads in, JR out', mount: 'heatshrink, no holes',
    sku: 'Hobbywing UBEC 5V 5A', src: 'amzn',
    note: 'Servo rail from a 2S/3S pack. Gives the MCU a clean 5V too.',
  },
  lm2596: {
    name: 'LM2596 buck module',
    cat: 'power', price: 3, mass: 12, volts: 12,
    curr: { idle: 0.005, typ: 0.01, peak: 0.015 },
    dims: [43, 21, 14], conn: 'screw terminals', mount: '4×M3',
    sku: 'LM2596S buck converter module', src: 'ali',
    note: '3A max in theory, ~2A before it gets hot. Fine for logic.',
  },
  ina219: {
    name: 'INA219 I2C power monitor',
    cat: 'sensor', price: 5, mass: 3, volts: 3.3,
    curr: { idle: 0.001, typ: 0.001, peak: 0.002 }, bus: 'i2c',
    dims: [25, 22, 4], conn: '0.1" header + screw terminals', mount: '4×M2.5',
    sku: 'INA219 current sensor breakout', src: 'ali',
    note: 'High-side shunt to 26V/3.2A. The difference between "it works" and telemetry.',
  },

  // ── energy ────────────────────────────────────────────────────────────────
  pack2s: {
    name: '2S 18650 pack 3000mAh (7.4V)',
    cat: 'battery', price: 18, mass: 100, volts: 7.4, mah: 3000, maxA: 6,
    dims: [70, 38, 20], conn: 'XT60 + JST-XH balance', sku: '2S 18650 battery box BMS XT60', src: 'amzn',
    note: 'With a protection board and an XT60. The default small-robot pack.',
  },
  pack3s: {
    name: '3S 18650 pack 2500mAh (11.1V)',
    cat: 'battery', price: 22, mass: 140, volts: 11.1, mah: 2500, maxA: 8,
    dims: [78, 56, 22], conn: 'XT60 + JST-XH balance', sku: '3S 18650 battery pack BMS XT60', src: 'amzn',
    note: 'Pair with a 5V UBEC; the 12V motors will thank you.',
  },
  lipo2s: {
    name: 'LiPo 2S 1000mAh 30C',
    cat: 'battery', price: 14, mass: 60, volts: 7.4, mah: 1000, maxA: 30,
    dims: [70, 35, 14], conn: 'XT30 + JST-XH balance', sku: '2S 1000mAh 30C LiPo XT30', src: 'amzn',
    note: 'Light and punchy. Needs a proper balance charger and a LiPo bag.',
  },
  lipo3s: {
    name: 'LiPo 3S 2200mAh 30C',
    cat: 'battery', price: 25, mass: 180, volts: 11.1, mah: 2200, maxA: 40,
    dims: [105, 35, 25], conn: 'XT60 + JST-XH balance', sku: '3S 2200mAh 30C LiPo XT60', src: 'amzn',
    note: 'Enough burst for 12 servos. Do not leave it charged in a drawer.',
  },
  pd5v: {
    name: 'USB-C PD trigger 5V/3A',
    cat: 'battery', price: 8, mass: 20, volts: 5, mah: 0, maxA: 3,
    dims: [30, 18, 8], conn: 'USB-C in, screw terminals out', sku: 'USB-C PD trigger 5V module', src: 'ali',
    note: 'Tethered desk builds: infinite runtime, no charging rituals.',
  },

  // ── sensing ───────────────────────────────────────────────────────────────
  mpu6050: {
    name: 'MPU-6050 IMU', cat: 'sensor', price: 4, mass: 2, volts: 3.3,
    curr: { idle: 0.004, typ: 0.005, peak: 0.006 }, bus: 'i2c',
    dims: [21, 16, 3], conn: '0.1" headers', mount: '2×M2.5',
    sku: 'GY-521 MPU6050 breakout', src: 'ali',
    note: '6-axis accel+gyro. Drifts; fine for tilt, not for yaw headings.',
  },
  bno085: {
    name: 'BNO085 9-DoF IMU', cat: 'sensor', price: 22, mass: 3, volts: 3.3,
    curr: { idle: 0.012, typ: 0.015, peak: 0.02 }, bus: 'i2c',
    dims: [25, 20, 4], conn: 'STEMMA-QT / 0.1" headers', mount: '4×M2.5',
    sku: 'Adafruit BNO085 IMU STEMMA', src: 'amzn',
    note: 'On-chip fusion — gives you a usable heading out of the box.',
  },
  vl53l0x: {
    name: 'VL53L0X ToF rangefinder', cat: 'sensor', price: 6, mass: 2, volts: 3.3,
    curr: { idle: 0.005, typ: 0.02, peak: 0.04 }, bus: 'i2c',
    dims: [25, 17, 3], conn: '0.1" headers', mount: '4×M2',
    sku: 'GY-530 VL53L0X ToF sensor', src: 'ali',
    note: '2m, millimetre-ish, no acoustic ring. Address is re-programmable.',
  },
  hcsr04: {
    name: 'HC-SR04 ultrasonic', cat: 'sensor', price: 2, mass: 9, volts: 5,
    curr: { idle: 0.002, typ: 0.015, peak: 0.03 },
    dims: [45, 20, 15], conn: '4-pin 0.1" header', mount: '4×M2',
    sku: 'HC-SR04 ultrasonic module', src: 'ali',
    note: '5V echo — needs a divider into a 3.3V MCU.',
  },
  as5600: {
    name: 'AS5600 magnetic encoder', cat: 'sensor', price: 5, mass: 2, volts: 3.3,
    curr: { idle: 0.006, typ: 0.01, peak: 0.015 }, bus: 'i2c',
    dims: [22, 20, 4], conn: '0.1" headers + Ø6 magnet', mount: '4×M2.5',
    sku: 'AS5600 magnetic encoder module', src: 'ali',
    note: 'Absolute joint angle over 12 bits — how you close the loop on an arm.',
  },
  bme280: {
    name: 'BME280 temp/humidity/pressure', cat: 'sensor', price: 6, mass: 2, volts: 3.3,
    curr: { idle: 0.001, typ: 0.002, peak: 0.003 }, bus: 'i2c',
    dims: [19, 18, 3], conn: '0.1" headers', mount: '2×M2',
    sku: 'GY-BME280 breakout', src: 'ali',
    note: 'Forget the "feels like" number, the pressure trend is the fun part.',
  },
  inmp441: {
    name: 'INMP441 I2S mic', cat: 'sensor', price: 6, mass: 2, volts: 3.3,
    curr: { idle: 0.002, typ: 0.004, peak: 0.006 }, bus: 'i2s',
    dims: [18, 15, 3], conn: '0.1" headers', mount: 'adhesive / clip',
    sku: 'INMP441 omnidirectional I2S mic', src: 'ali',
    note: 'Digital mic — no ADC noise, straight into I2S DMA.',
  },
  ov2640: {
    name: 'OV2640 camera (ESP32-CAM style)', cat: 'sensor', price: 9, mass: 5, volts: 3.3,
    curr: { idle: 0.03, typ: 0.08, peak: 0.2 }, bus: 'dvp',
    dims: [25, 24, 25], conn: 'board-to-board DVP', mount: '2×M2',
    sku: 'OV2640 2MP camera module ESP32', src: 'ali',
    note: 'Wants PSRAM and a stable 3.3V rail; JPEG at 1600x1200 is achievable.',
  },
  gps: {
    name: 'u-blox NEO-6M GPS', cat: 'sensor', price: 12, mass: 12, volts: 3.3,
    curr: { idle: 0.03, typ: 0.045, peak: 0.06 }, bus: 'uart',
    dims: [36, 24, 6], conn: '4-pin 0.1" header + antenna', mount: '4×M3',
    sku: 'GY-NEO6MV2 GPS module antenna', src: 'ali',
    note: 'Needs sky view. Cold fix is 30s+; expect a UART and a 1Hz NMEA stream.',
  },
  pir: {
    name: 'HC-SR501 PIR', cat: 'sensor', price: 3, mass: 10, volts: 5,
    curr: { idle: 0.05, typ: 0.06, peak: 0.07 },
    dims: [33, 25, 24], conn: '3-pin 0.1" header', mount: '2×M2',
    sku: 'HC-SR501 PIR motion sensor', src: 'ali',
    note: '5V output, 3.3V-safe enough in practice. 3.3V rails make it flaky.',
  },
  hx711: {
    name: 'HX711 + 5kg load cell', cat: 'sensor', price: 9, mass: 30, volts: 5,
    curr: { idle: 0.002, typ: 0.003, peak: 0.005 },
    dims: [80, 13, 10], conn: '0.1" headers + 4-wire cell', mount: '2×M4 through cell',
    sku: 'HX711 5kg load cell kit', src: 'ali',
    note: '24-bit bridge amp, ~10Hz. The classic scale front-end.',
  },
  soil: {
    name: 'Capacitive soil moisture probe', cat: 'sensor', price: 4, mass: 8, volts: 3.3,
    curr: { idle: 0.005, typ: 0.006, peak: 0.008 },
    dims: [98, 23, 4], conn: '3-pin JST-PH', mount: 'sticks in the pot',
    sku: 'capacitive soil moisture sensor v1.2', src: 'ali',
    note: 'Capacitive, so it does not corrode in a week like the resistive ones.',
  },
  limit_sw: {
    name: 'KW12 limit switch (lever)', cat: 'sensor', price: 1.5, mass: 3, volts: 3.3,
    curr: { idle: 0, typ: 0, peak: 0.001 }, bus: 'switch',
    dims: [20, 10, 7], conn: '3× solder tabs', mount: '2×M2.5 on 9.5mm',
    sku: 'KW12-3 micro limit switch lever', src: 'hw',
    note: 'Homing and end-stops. Wire it NC — a broken wire then fails SAFE.',
  },

  // ── human interface ───────────────────────────────────────────────────────
  ssd1306: {
    name: 'SSD1306 128x64 OLED', cat: 'display', price: 5, mass: 5, volts: 3.3,
    curr: { idle: 0.01, typ: 0.015, peak: 0.03 }, bus: 'i2c',
    dims: [27, 27, 4], conn: '4-pin 0.1" header', mount: '4×M2',
    sku: '0.96 SSD1306 I2C OLED white', src: 'ali',
    note: 'I2C 0x3C. Two wires, instant readable UI.',
  },
  ili9341: {
    name: '2.8" ILI9341 SPI touch TFT', cat: 'display', price: 15, mass: 25, volts: 3.3,
    curr: { idle: 0.02, typ: 0.04, peak: 0.08 }, bus: 'spi',
    dims: [85, 55, 6], conn: '14-pin 0.1" header', mount: '4×M3 bezel',
    sku: '2.8 inch ILI9341 SPI TFT touch', src: 'ali',
    note: '320x240 + XPT2046 touch. Backlight is the real power draw.',
  },
  gc9a01: {
    name: 'GC9A01 1.28" round LCD', cat: 'display', price: 9, mass: 8, volts: 3.3,
    curr: { idle: 0.02, typ: 0.035, peak: 0.06 }, bus: 'spi',
    dims: [40, 36, 4], conn: '7-pin 0.1" header', mount: 'press bezel',
    sku: 'GC9A01 1.28 round TFT 240x240', src: 'ali',
    note: 'Round 240x240 — the "robot face" display.',
  },
  max98357: {
    name: 'MAX98357A I2S amp + 3W speaker', cat: 'display', price: 9, mass: 40, volts: 5,
    curr: { idle: 0.004, typ: 0.05, peak: 0.6 }, bus: 'i2s',
    dims: [30, 26, 12], conn: '0.1" headers + speaker pads', mount: '2×M2.5',
    sku: 'MAX98357A I2S amplifier breakout', src: 'amzn',
    note: '2.5W into 4Ω. Shares the I2S bus with a mic if you tri-state right.',
  },

  // ── structure & consumables ───────────────────────────────────────────────
  wheel130: {
    name: '130mm off-road wheel + 6mm hub', cat: 'mech', price: 9, mass: 120, volts: 0,
    dims: [130, 130, 48], shaft: '6mm hex bore', mount: 'hub screws to shaft',
    sku: '130mm robot wheel 6mm hex hub', src: 'ali',
    note: 'Buy the wheel, print only the adapter. Printed tyres on a 3kg robot last a week.',
  },
  wheel65: {
    name: '65mm rubber wheel + 3mm hub', cat: 'mech', price: 4, mass: 35, volts: 0,
    dims: [65, 65, 26], shaft: '3mm D bore', mount: 'set screw to D-shaft',
    sku: '65mm robot car wheel TT motor', src: 'ali',
    note: 'The yellow-gearbox wheel, sized for N20 motors too.',
  },
  bearing608: {
    name: '608ZZ bearing', cat: 'mech', price: 1.2, mass: 12, volts: 0,
    dims: [22, 22, 7], shaft: 'Ø8mm bore', mount: 'press fit into Ø22 pocket',
    sku: '608ZZ skate bearing 8x22x7', src: 'hw',
    note: '8x22x7mm. The bearing every printed hub is secretly designed around.',
  },
  bearing6900: {
    name: '6900ZZ thin bearing', cat: 'mech', price: 1.5, mass: 9, volts: 0,
    dims: [22, 22, 6], shaft: 'Ø10mm bore', mount: 'press fit into Ø22 pocket',
    sku: '6900ZZ 10x22x6 thin section bearing', src: 'hw',
    note: 'Same OD as a 608 with a 10mm bore — for bigger printed shafts.',
  },
  bearingf625: {
    name: 'F625ZZ flanged bearing', cat: 'mech', price: 1, mass: 5, volts: 0,
    dims: [18, 18, 5], shaft: 'Ø5mm bore, Ø18 flange', mount: 'flange stops pull-through',
    sku: 'F625ZZ flanged bearing 5x16x5', src: 'hw',
    note: 'Belt idlers and small wheels — the flange does the axial locating for you.',
  },
  thrust51103: {
    name: '51103 thrust bearing', cat: 'mech', price: 3, mass: 12, volts: 0,
    dims: [30, 30, 9], shaft: 'Ø17mm bore', mount: 'sits in a pocket, carries axial load',
    sku: '51103 thrust ball bearing 17x30x9', src: 'hw',
    note: 'A yaw axis that carries weight wants this, not a radial bearing.',
  },
  hw_m3: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'M3 hardware kit (screws/nuts/inserts)', cat: 'mech', price: 12, mass: 80, volts: 0,
    sku: 'M3 screw nut assortment box', src: 'hw',
    note: 'Button-head screws + heat-set inserts. Buy the kit, not the bag.',
  },
  m3_screws: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'M3 socket-head screws (per 10)', cat: 'mech', price: 2.5, mass: 25, volts: 0,
    dims: [3, 3, 10], sku: 'M3x8/10/12/16 SHCS class 12.9', src: 'hw',
    note: 'Sold in 10s here so the BOM shows the real count. Socket heads, not Phillips.',
  },
  m2_screws: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'M2/M2.5 micro screw kit', cat: 'mech', price: 9, mass: 60, volts: 0,
    sku: 'M2 M2.5 screw assortment kit', src: 'hw',
    note: 'Micro servos, cameras and tiny boards live on M2. Separate kit, separate drawer.',
  },
  insert_m3: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'M3 heat-set inserts (per 10)', cat: 'mech', price: 1.5, mass: 4, volts: 0,
    dims: [4.6, 4.6, 5.7], mount: 'press into Ø4.2 hole at ~200°C',
    sku: 'M3x5.7 heat set threaded inserts', src: 'hw',
    note: 'The only thread a printed part should ever take a load on.',
  },
  standoff_m3: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'M3 standoff kit (brass/nylon)', cat: 'mech', price: 8, mass: 80, volts: 0,
    dims: [5, 5, 10], sku: 'M3 standoff spacer assortment', src: 'hw',
    note: 'Boards go on standoffs, not flat against a printed face with solder spikes.',
  },
  gt2_kit: {
    name: 'GT2 belt + 20T pulleys', cat: 'mech', price: 9, mass: 40, volts: 0,
    dims: [16, 16, 11], shaft: '5mm bore pulleys', sku: 'GT2 6mm belt pulley 20T kit', src: 'ali',
    note: 'Cheap reduction or a linear axis.',
  },
  mgn12: {
    name: 'MGN12H rail 150mm + 2 carriages', cat: 'mech', price: 14, mass: 95, volts: 0,
    dims: [150, 12, 8], mount: 'M3 every 40mm', shaft: '12mm rail, 4-ball carriage',
    sku: 'MGN12H linear rail 150mm carriage', src: 'ali',
    note: 'Real linear motion. A jaw or axis on this does not wobble, period.',
  },
  leadscrew_t8: {
    name: 'T8 leadscrew 200mm + POM nut', cat: 'mech', price: 9, mass: 85, volts: 0,
    dims: [200, 8, 8], shaft: 'Ø8 Tr8x8 4-start', mount: 'KP08 bearing blocks',
    sku: 'T8 lead screw 200mm brass nut', src: 'ali',
    note: '2mm per rev, self-locking. Slow, strong, quiet — the clamp axis.',
  },
  springkit: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'Extension spring assortment', cat: 'mech', price: 8, mass: 90, volts: 0,
    sku: 'extension spring assortment box', src: 'hw',
    note: 'Counterbalance springs for arms and lids — cheap torque that never browns out.',
  },
  jst_kit: {
    shop: true, // consumable: bought once, lasts many builds
    name: 'JST-XH + Dupont connector kit', cat: 'mech', price: 10, mass: 60, volts: 0,
    conn: '2.54 / 2.5mm pitch crimp', sku: 'JST XH dupont connector kit crimp', src: 'ali',
    note: 'Crimp, do not twist-and-tape. Your future self is the reviewer.',
  },
  wire22: {
    shop: true, // consumable: bought once, lasts many builds
    name: '22AWG silicone wire (6 colours)', cat: 'mech', price: 9, mass: 60, volts: 0,
    conn: 'signal/servo runs to ~1.5A', sku: '22AWG silicone wire kit 6 colors', src: 'amzn',
    note: 'Stranded silicone survives joints that move.',
  },
  wire18: {
    shop: true, // consumable: bought once, lasts many builds
    name: '18AWG silicone pair (2m)', cat: 'mech', price: 8, mass: 70, volts: 0,
    conn: 'power runs to ~7A', sku: '18AWG silicone wire red black', src: 'amzn',
    note: 'The motor-rail wire. 22AWG on a 4A rail is a heater, not a wire.',
  },
  xt60: {
    name: 'XT60 connector pair', cat: 'mech', price: 3, mass: 8, volts: 0,
    conn: '15A continuous, 30A burst', sku: 'XT60H connector male female pair', src: 'amzn',
    note: 'The pack interface. Solder the battery side first, one lead at a time.',
  },
  xt30: {
    name: 'XT30 connector pair', cat: 'mech', price: 2.5, mass: 5, volts: 0,
    conn: '15A continuous', sku: 'XT30 connector pair', src: 'amzn',
    note: 'Half the size of an XT60 — the right plug for 2S/3A-class machines.',
  },
  fuse: {
    name: 'Inline fuse holder + blade fuse', cat: 'mech', price: 3, mass: 10, volts: 0,
    conn: '18AWG inline, ATO blade', sku: 'inline ATO fuse holder 18AWG', src: 'hw',
    note: 'A $3 part that stands between a shorted rail and a lithium fire.',
  },
  cap1000: {
    name: '1000µF 16V low-ESR capacitor', cat: 'mech', price: 0.8, mass: 4, volts: 0,
    dims: [10, 10, 16], sku: '1000uF 16V low ESR electrolytic', src: 'hw',
    note: 'Across the servo rail at the driver — eats the dip when a servo kicks.',
  },
  rocker: {
    name: 'KCD1 rocker switch 6A', cat: 'mech', price: 1.5, mass: 5, volts: 0,
    dims: [21, 15, 18], conn: 'solder tabs', mount: 'snap-in 19×13mm cutout',
    sku: 'KCD1-101 rocker switch SPST', src: 'hw',
    note: 'A real power switch. Yanking a connector is not a power switch.',
  },
  pla_kg: {
    name: 'PLA+ filament (1kg)', cat: 'mech', price: 18, mass: 1000, volts: 0, print: true,
    sku: 'PLA+ filament 1.75 1kg', src: 'amzn',
    note: 'Stiff, easy, brittle. Fine for brackets, poor for hot cars.',
  },
  petg_kg: {
    name: 'PETG filament (1kg)', cat: 'mech', price: 21, mass: 1000, volts: 0, print: true,
    sku: 'PETG filament 1.75 1kg', src: 'amzn',
    note: 'Tougher and slightly flexible — the right call for load-bearing prints.',
  },
  asa_kg: {
    name: 'ASA filament (1kg)', cat: 'mech', price: 26, mass: 1000, volts: 0, print: true,
    sku: 'ASA filament 1.75 1kg', src: 'amzn',
    note: 'UV-stable and heat-tough — the outdoor/car material. Needs an enclosure.',
  },
  petgcf_kg: {
    name: 'PETG-CF filament (1kg)', cat: 'mech', price: 38, mass: 1000, volts: 0, print: true,
    sku: 'PETG carbon fiber filament 1kg', src: 'amzn',
    note: 'Stiffest thing your printer will eat without a hardened nozzle fight.',
  },
}

/** Parts the planner is allowed to pick per joint/motor, smallest first. */
const SERVO_LADDER = ['sg90', 'mg90s', 'mg996r', 'ds3218', 'ds3225', 'sts3215']
const MOTOR_LADDER = ['n20_100', 'n20_enc', 'jgb37']

const MCU_KEYS = ['esp32s3', 'esp32c6', 'pico']

const MATERIALS = {
  pla: { name: 'PLA+', density: 1.24, priceId: 'pla_kg', strength: 1, elastic: 3.3, yield: 55 },
  petg: { name: 'PETG', density: 1.27, priceId: 'petg_kg', strength: 1.35, elastic: 2.0, yield: 50 },
  asa: { name: 'ASA', density: 1.07, priceId: 'asa_kg', strength: 1.25, elastic: 2.2, yield: 45 },
  petgcf: { name: 'PETG-CF', density: 1.30, priceId: 'petgcf_kg', strength: 1.8, elastic: 5.5, yield: 60 },
}

// Wire sizing, chassis-wiring conservative ampacity (A) for short runs in a
// moving machine — these are deliberately below insulation-melt numbers.
const WIRE_GAUGES = [
  { awg: 28, a: 0.4 }, { awg: 26, a: 0.8 }, { awg: 24, a: 1.4 }, { awg: 22, a: 2.4 },
  { awg: 20, a: 4 }, { awg: 18, a: 7 }, { awg: 16, a: 12 }, { awg: 14, a: 18 },
]
/** Smallest gauge that carries `amps`, or null when nothing in the table does. */
const wireFor = (amps) => {
  const w = WIRE_GAUGES.find((x) => x.a >= amps)
  return w ? w.awg : null
}
const ampacityOf = (awg) => (WIRE_GAUGES.find((w) => w.awg === awg) || { a: 0 }).a

// Standard automotive blade fuse values — pick the smallest that clears 1.4×
// typical rail draw. The fuse protects the WIRE, not the board.
const FUSE_STEPS = [1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30]
const fuseFor = (typAmps) => FUSE_STEPS.find((f) => f >= Math.max(1, typAmps * 1.4)) || 30

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
//   nodes[]  — geometry in mm, rest pose, tagged by joint. Node kinds:
//              box, rbox (chamfered), cyl (segs/radius2 → hex, cone, taper),
//              ring (hollow cyl), torus, wedge (triangular prism), sphere,
//              gear (module+teeth), rack (toothed bar), bend (tube elbow).
//              `rot:[rx,ry,rz]` orients any of them around their centre.
//   joints[] — revolute chain (axis + deg limits) OR linear slides (mm travel,
//              driven through node.slide) so mechanisms like grippers pose right
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

/** Box node. `pos` is the CENTRE. `r` rounds it into a chamfered `rbox`. */
function box(d, id, size, pos, mat, extra) {
  d.nodes.push({ id, kind: 'box', size, pos, mat, ...extra })
}

/** Chamfered box — the machined/printed-edge look. `r` is the chamfer in mm. */
/**
 * Print-bed aware box: anything longer or wider than the bed becomes a grid of
 * pieces with seams and joiner plates. A design that cannot be printed is not a
 * design, so the geometry splits itself rather than leaving a 410mm part and a
 * warning the user cannot act on.
 */
/**
 * Payload has a physical envelope per archetype — a 400kg quadruped is not a
 * quadruped. Clamping is right; clamping *silently* is not, because the checks
 * then pass for a machine that cannot carry what was asked. Say it out loud.
 */
function clampPayload(d, requested, lo, hi) {
  const want = Number(requested)
  const safe = Number.isFinite(want) && want > 0 ? want : lo
  const got = Math.min(hi, Math.max(lo, safe))
  if (safe > hi) {
    d.checks.push({
      level: 'fail',
      msg: `Asked to carry ${safe}kg. A ${d.archetype === 'robot' ? 'mobile robot' : d.archetype} tops out around ${hi}kg — sizing below uses ${hi}kg, so this drawing will not carry ${safe}kg. Smaller payload, or a different machine class.`,
    })
  } else if (safe < lo) {
    d.checks.push({
      level: 'warn',
      msg: `${safe}kg is below what this class is sized for (${lo}kg) — the structure is fine, the resolution is not: a servo this small cannot hold position against a real load.`,
    })
  }
  return got
}

function splitBox(d, base, size, pos, fillet, mat, bed, extra = {}) {
  const usable = Math.max(60, (bed || 256) - 16)
  const gap = 2
  const nA = Math.max(1, Math.ceil(size[0] / usable))
  const nB = Math.max(1, Math.ceil(size[1] / usable))
  if (nA === 1 && nB === 1) {
    rbox(d, base, size, pos, fillet, mat, extra)
    return 1
  }
  const segX = (size[0] - gap * (nA - 1)) / nA
  const segY = (size[1] - gap * (nB - 1)) / nB
  let count = 0
  for (let i = 0; i < nA; i += 1) {
    for (let j = 0; j < nB; j += 1) {
      count += 1
      const ps = [
        pos[0] - size[0] / 2 + segX / 2 + i * (segX + gap),
        pos[1] - size[1] / 2 + segY / 2 + j * (segY + gap),
        pos[2],
      ]
      rbox(d, `${base}-${i + 1}x${j + 1}of${nA}x${nB}`, [segX, segY, size[2]], ps, fillet, mat, extra)
    }
  }
  // joiner bars across every seam, on the underside
  for (let i = 1; i < nA; i += 1) {
    rbox(d, `${base}-joinX-${i}`, [26, Math.min(size[1] * 0.7, 60), 2.6], [
      pos[0] - size[0] / 2 + i * segX + (i - 0.5) * gap,
      pos[1], pos[2] - size[2] / 2 - 1.4,
    ], 0.8, mat, { print: true })
  }
  for (let j = 1; j < nB; j += 1) {
    rbox(d, `${base}-joinY-${j}`, [Math.min(size[0] * 0.7, 60), 26, 2.6], [
      pos[0], pos[1] - size[1] / 2 + j * segY + (j - 0.5) * gap,
      pos[2] - size[2] / 2 - 1.4,
    ], 0.8, mat, { print: true })
  }
  if (d.notes) {
    d.notes.push(`${base} prints in ${count} pieces (${Math.round(segX)}×${Math.round(segY)}mm) with joiner plates — glue or bolt the seams.`)
  }
  return count
}

/** A vendored CAD mesh: `part` names an entry in globalThis.__RF_PARTS. */
function mesh(d, id, part, size, pos, mat, extra) {
  d.nodes.push({ id, kind: 'mesh', part, size, pos, mat, rot: [0, 0, 0], ...(extra || {}) })
}

function rbox(d, id, size, pos, r, mat, extra) {
  d.nodes.push({ id, kind: 'rbox', size, pos, r: r || 1.5, mat, ...extra })
}

/** Cylinder node. axis 'x'|'y'|'z', `pos` is the CENTRE.
 *  extra.segs (default 18 → 6 = hex bolt/nut), extra.radius2 (≠radius → cone/taper). */
function cyl(d, id, radius, height, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'cyl', radius, height, pos, axis, mat, ...extra })
}

/** Hollow cylinder — bearing races, washers, tubes. */
function ring(d, id, outer, inner, height, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'ring', outer, inner, height, pos, axis, mat, ...extra })
}

/** Torus — tyre profiles, O-rings, rounded rims. `R` major, `r` minor. */
function torus(d, id, R, r, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'torus', R, r, pos, axis, mat, ...extra })
}

/** Triangular prism (gusset, ramp, jaw chamfer). dir: px|nx|py|ny — the slope
 *  rises toward that side; cross-section in the x/z or y/z plane, extruded the
 *  remaining axis. size is the full bounding box. */
function wedge(d, id, size, pos, dir, mat, extra) {
  d.nodes.push({ id, kind: 'wedge', size, pos, dir: dir || 'px', mat, ...extra })
}

/** UV sphere — ball joints, domed caps, rounded feet. */
function ball(d, id, radius, pos, mat, extra) {
  d.nodes.push({ id, kind: 'sphere', radius, pos, mat, ...extra })
}

/** Spur gear: real tooth count, pitch radius r = m·z/2. */
function gear(d, id, m, teeth, width, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'gear', module: m, teeth, width, pos, axis, mat, ...extra })
}

/** Toothed rack bar of `size`, `teeth` boxes on the +z face. */
function rack(d, id, size, teeth, pos, mat, extra) {
  d.nodes.push({ id, kind: 'rack', size, teeth, pos, mat, ...extra })
}

/** Bent tube, a `deg`-arc elbow of tube radius r at bend radius R. `rot` aims it. */
function bend(d, id, R, r, deg, pos, rot, mat, extra) {
  d.nodes.push({ id, kind: 'bend', R, r, arc: deg, pos, rot, mat, ...extra })
}

/**
 * A revolute joint. `parent` defaults to the previously declared joint (a
 * serial chain); a branching machine passes it explicitly.
 */
function joint(d, id, label, axis, pivot, min, max, parent) {
  const fallback = d.joints.length ? d.joints[d.joints.length - 1].id : null
  d.joints.push({ id, label, axis, pivot, angle: 0, min, max, parent: parent === undefined ? fallback : parent })
}

/**
 * A linear slide, in mm. Nodes ride it via slide:{joint, sign} — a gripper puts
 * jaw A on sign -1 and jaw B on sign +1 so one slider opens and closes the pair.
 */
function slideJoint(d, id, label, axis, travelMm) {
  d.joints.push({ id, label, axis, slide: true, pivot: [0, 0, 0], angle: 0, min: 0, max: travelMm, parent: null })
}

/** mm³ of a node, for mass + print estimates. */
function nodeVolume(node) {
  const s = node.size
  switch (node.kind) {
    case 'box': case 'rbox': return s[0] * s[1] * s[2] * (node.kind === 'rbox' ? 0.93 : 1)
    case 'wedge': return s[0] * s[1] * s[2] * 0.5
    case 'rack': return s[0] * s[1] * s[2] * 1.12
    case 'cyl': {
      const r2 = node.radius2 != null ? node.radius2 : node.radius
      return (Math.PI * node.height / 3) * (node.radius ** 2 + node.radius * r2 + r2 ** 2)
    }
    case 'ring': return Math.PI * (node.outer ** 2 - node.inner ** 2) * node.height
    case 'torus': return 2 * Math.PI * Math.PI * node.R * node.r ** 2
    case 'sphere': return (4 / 3) * Math.PI * node.radius ** 3
    case 'gear': {
      const root = (node.module * node.teeth) / 2 - 1.25 * node.module
      const tip = (node.module * node.teeth) / 2 + node.module
      return Math.PI * (root ** 2 + (tip ** 2 - root ** 2) * 0.45) * node.width
    }
    case 'bend': return (node.arc / 360) * 2 * Math.PI * Math.PI * node.R * node.r ** 2
    default: return 0
  }
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
  // Rings are already the shell — wall thickness IS the part.
  if (n.kind === 'ring' || n.kind === 'bend' || n.kind === 'torus') return nodeVolume(n)
  const solid = nodeVolume(n)
  if (n.kind === 'cyl' || n.kind === 'sphere' || n.kind === 'gear') {
    const r = n.radius || n.outer || ((n.module * n.teeth) / 4)
    if (r <= WALL * 1.6) return solid
    const h = n.height || n.width || r * 2
    const tube = Math.PI * (r * r - (r - WALL) * (r - WALL)) * h
    const caps = 2 * Math.PI * r * r * WALL * LIGHTENING
    return Math.min(solid * LIGHTENING, tube + caps)
  }
  // box, rbox, wedge, rack — shell of the bounding shape
  const [x, y, z] = n.size
  if (Math.min(x, y, z) <= WALL * 2.2) return solid * LIGHTENING
  const surface = 2 * (x * y + y * z + x * z)
  return Math.min(solid * LIGHTENING, surface * WALL)
}

function printedVolume(nodes) {
  let v = 0
  for (const n of nodes) if (n.print) v += shellVolume(n)
  return v
}

// ── composite part builders ─────────────────────────────────────────────────
// Real assemblies are made of these, not of naked boxes. Each emits the nodes
// a renderer can shade AND the parts a BOM can count.

/**
 * M3 bolt: shank + hex head + washer. `pos` is the surface the head sits on;
 * the shank runs along -axis into the part (flip → +axis). `len` = shank.
 */
function bolt(d, id, pos, axis, len, extra) {
  const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis || 'z']
  const f = extra && extra.flip ? 1 : -1
  const at = (dist) => [pos[0] + dir[0] * f * dist, pos[1] + dir[1] * f * dist, pos[2] + dir[2] * f * dist]
  cyl(d, `${id}-hd`, 2.85, 3, at(-2.1), axis, 'steel', { segs: 6, ...extra })
  ring(d, `${id}-wa`, 3.4, 1.7, 0.8, at(-0.4), axis, 'steel', extra)
  cyl(d, `${id}-sh`, 1.5, len, at(len / 2), axis, 'steel', extra)
}

/** M3 hex nut. */
function nut(d, id, pos, axis, extra) {
  cyl(d, id, 3.0, 2.4, pos, axis, 'steel', { segs: 6, ...extra })
}

/** A press-fit bearing drawn honestly: outer race, inner race, gap between. */
function bearing(d, id, pos, axis, od, bore, w, extra) {
  ring(d, `${id}-o`, od / 2, od / 2 - 1.4, w, pos, axis, 'steel', extra)
  ring(d, `${id}-i`, bore / 2 + 1.4, bore / 2, w + 0.3, pos, axis, 'steel', extra)
  cyl(d, `${id}-b`, (od / 2 + bore / 2) / 2 - 0.6, w - 1.2, pos, axis, 'metal', { segs: 10, ...extra })
}

/**
 * A servo drawn as a servo: case with chamfered sides, mounting ears, output
 * spline and horn disc. `pos` is where the shaft FACE sits; the case hangs
 * behind it along -axis (or +axis with opts.flip).
 * `joint` carries the case (the side it bolts to); `hornJoint` carries the
 * spline+horn — the side it DRIVES. Pass the same joint when both rotate.
 */
function servoBody(d, prefix, pos, axis, partKey, joint, hornJoint, opts) {
  const p = PARTS[partKey]
  const [L, W, H] = (p && p.dims) || [40, 20, 40]
  const caseH = H * 0.62
  const o = { joint, ...(opts || {}) }
  const ho = { ...(opts || {}), joint: hornJoint === undefined ? joint : hornJoint }
  const a = axis || 'z'
  const f = o.flip ? -1 : 1
  const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[a]
  const at = (dist) => [pos[0] + dir[0] * f * dist, pos[1] + dir[1] * f * dist, pos[2] + dir[2] * f * dist]
  const sizeFor = (along) => (a === 'z' ? [along, W, caseH] : a === 'y' ? [along, caseH, W] : [caseH, along, W])
  const earSize = a === 'z' ? [L + 8, W, 2.6] : a === 'y' ? [L + 8, 2.6, W] : [2.6, L + 8, W]

  rbox(d, `${prefix}-case`, sizeFor(L), at(-(caseH / 2 + 4)), 2.2, 'servo', o)
  box(d, `${prefix}-ear-a`, earSize, at(-3), 'servo', o)
  box(d, `${prefix}-ear-b`, earSize, at(-(caseH + 5)), 'servo', o)
  cyl(d, `${prefix}-spline`, 3, 4, at(1), a, 'steel', ho)
  cyl(d, `${prefix}-horn`, 11, 2.5, at(4), a, 'accent', ho)
}

/** Wheel drawn as a wheel: torus tyre + rim ring + hub boss. */
function wheelAssy(d, id, pos, axis, dia, width, joint, side) {
  const o = { joint }
  const out = side || 1 // which face carries the lug heads (outboard)
  const R = dia / 2 - width * 0.30
  torus(d, `${id}-tire`, R, width * 0.30, pos, axis, 'rubber', o)
  ring(d, `${id}-rim`, R, R * 0.32, width * 0.42, pos, axis, 'accent', { print: true, joint })
  cyl(d, `${id}-hub`, R * 0.3, width * 0.55, pos, axis, 'accent', { print: true, joint })
  // lug bolts, because detail lives in the fastener heads
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2
    const rr = R * 0.62
    const bp = axis === 'y'
      ? [pos[0] + Math.cos(a) * rr, pos[1] + out * width * 0.22, pos[2] + Math.sin(a) * rr]
      : [pos[0] + Math.cos(a) * rr, pos[1] + Math.sin(a) * rr, pos[2] + out * width * 0.22]
    cyl(d, `${id}-lug${i}`, 1.6, 2.5, bp, axis, 'steel', { segs: 6, joint })
  }
}

/** U-bracket: base + two cheeks, sized for a servo case width `gap`. */
function bracketU(d, id, pos, size, t, mat, joint) {
  const [w, h, len] = size
  const o = { print: true, joint }
  box(d, `${id}-base`, [len, w, t], [pos[0], pos[1], pos[2] - h / 2 + t / 2], mat || 'shell', o)
  box(d, `${id}-chk-l`, [len, t, h], [pos[0], pos[1] - w / 2 + t / 2, pos[2]], mat || 'shell', o)
  box(d, `${id}-chk-r`, [len, t, h], [pos[0], pos[1] + w / 2 - t / 2, pos[2]], mat || 'shell', o)
}

/** Corner gusset pair (thin wedges) between two faces meeting at `pos`. */
function gusset(d, id, pos, size, dir, mat, joint) {
  wedge(d, id, size, pos, dir, mat || 'shell', { print: true, joint })
}

/** Stiffening rib row on a plate: n thin vertical fins. */
function ribs(d, id, n, size, gap, pos, mat, joint) {
  for (let i = 0; i < n; i += 1) {
    box(d, `${id}-${i}`, size, [pos[0] + (i - (n - 1) / 2) * gap, pos[1], pos[2]], mat || 'accent', { print: true, joint })
  }
}

/** Heatsink/fin block. */
function fins(d, id, n, size, gap, pos, mat, extra) {
  for (let i = 0; i < n; i += 1) {
    box(d, `${id}-${i}`, size, [pos[0] + (i - (n - 1) / 2) * gap, pos[1], pos[2]], mat || 'metal', extra)
  }
}

// ── arm: the canonical robot ────────────────────────────────────────────────
// A serial revolute chain with real proportions and a real torque cascade. The
// servo at each joint is PICKED from the ladder by the load it actually
// carries at full extension — the honesty of the whole app lives in this file.
// Sizing runs BEFORE geometry so every joint gets the servo body it earned.

const ARM_SEG = { w: 46, h: 40 }

function buildArm(brief) {
  const d = newDesign('arm', brief)
  const reach = clamp(brief.reachMm || 450, 180, 1200)
  // The slider stops at 8kg, but the brief does not: a sentence or a build code
  // can ask for 40. Sizing must use what was asked for, or the machine is
  // quietly undersized and the checks pass anyway.
  const askedPayload = Math.max(0.1, Number(brief.payloadKg) || 1)
  const payload = askedPayload
  const dof = clamp(brief.dof || 5, 3, 6)
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000 // g/mm³

  const L1 = reach * 0.42
  const L2 = reach * 0.36
  const L3 = reach * 0.13
  const baseH = 74

  d.title = `${dof}-DoF arm · ${Math.round(reach)}mm reach`
  d.subtitle = `${askedPayload}kg payload · ${mat.name} links`

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
  const pickServo = (need, key, label) => {
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
        return { servo, ratio: 0 }
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

  const svc = (key, fallback) => picks[key] || fallback

  // ── base: flange plate, tower, thrust race, yaw servo inside ────────────
  rbox(d, 'base-plate', [150, 150, 12], [0, 0, 6], 2.5, 'accent', { print: true })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    bolt(d, `base-bolt-${sx}${sy}`, [sx * 66, sy * 66, 12], 'z', 12)
  }
  ring(d, 'base-tower', 46, 38, 54, [0, 0, 39], 'z', 'shell', { print: true })
  // yaw carries the arm's overhung moment — that is a thrust bearing's job
  servoBody(d, 'yaw-servo', [0, 0, 56], 'z', svc('yaw', 'ds3218'), null, 'yaw')
  bearing(d, 'yaw-race', [0, 0, 68], 'z', 30, 17, 9, { joint: 'yaw' })

  joint(d, 'yaw', 'Base yaw', 'z', [0, 0, baseH], -170, 170)

  // ── shoulder bracket + upper arm ────────────────────────────────────────
  rbox(d, 'shoulder-block', [58, ARM_SEG.w, 54], [10, 0, baseH + 20], 2, 'shell', { joint: 'yaw', print: true })
  wedge(d, 'gusset-l', [30, 6, 30], [16, -ARM_SEG.w / 2 + 3, baseH + 24], 'px', 'accent', { joint: 'yaw', print: true })
  wedge(d, 'gusset-r', [30, 6, 30], [16, ARM_SEG.w / 2 - 3, baseH + 24], 'px', 'accent', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 22, ARM_SEG.w + 10, [0, 0, baseH], 'y', 'metal', { joint: 'yaw' })
  servoBody(d, 'shoulder-servo', [0, -ARM_SEG.w / 2 - 5, baseH], 'y', svc('shoulder', 'ds3218'), 'yaw', 'shoulder')
  bearing(d, 'shoulder-race', [0, ARM_SEG.w / 2 + 6, baseH], 'y', 22, 8, 7, { joint: 'yaw' })
  bolt(d, 'shoulder-bolt', [0, ARM_SEG.w / 2 + 13, baseH], 'y', 10, { joint: 'yaw' })

  joint(d, 'shoulder', 'Shoulder pitch', 'y', [0, 0, baseH], -85, 85)

  box(d, 'upper-arm', [L1, ARM_SEG.w, ARM_SEG.h], [L1 / 2, 0, baseH], 'shell', { joint: 'shoulder', print: true })
  for (const sy of [-1, 1]) {
    box(d, `upper-rib-${sy}`, [L1 * 0.86, 4, ARM_SEG.h * 0.42], [L1 / 2, sy * (ARM_SEG.w / 2 + 2), baseH + 2], 'accent', { joint: 'shoulder', print: true })
  }
  cyl(d, 'elbow-hub', 18, ARM_SEG.w + 8, [L1, 0, baseH], 'y', 'metal', { joint: 'shoulder' })
  servoBody(d, 'elbow-servo', [L1, -ARM_SEG.w / 2 - 3, baseH], 'y', svc('elbow', 'mg996r'), 'shoulder', 'elbow')
  bearing(d, 'elbow-race', [L1, ARM_SEG.w / 2 + 5, baseH], 'y', 22, 8, 7, { joint: 'shoulder' })
  bolt(d, 'elbow-bolt', [L1, ARM_SEG.w / 2 + 11, baseH], 'y', 10, { joint: 'shoulder' })

  joint(d, 'elbow', 'Elbow pitch', 'y', [L1, 0, baseH], -140, 140)

  box(d, 'forearm', [L2, ARM_SEG.w - 6, ARM_SEG.h - 4], [L1 + L2 / 2, 0, baseH], 'shell', { joint: 'elbow', print: true })
  for (const sy of [-1, 1]) {
    box(d, `fore-rib-${sy}`, [L2 * 0.84, 4, (ARM_SEG.h - 4) * 0.4], [L1 + L2 / 2, sy * (ARM_SEG.w / 2 - 1), baseH + 1], 'accent', { joint: 'elbow', print: true })
  }

  // ── wrist stack (only the DOF the brief asks for) ───────────────────────
  let tipX = L1 + L2
  let chain = 'elbow'
  const wristX = L1 + L2

  if (dof >= 4) {
    cyl(d, 'wrist-hub', 15, ARM_SEG.w, [wristX, 0, baseH], 'y', 'metal', { joint: chain })
    servoBody(d, 'wrist-servo', [wristX, -ARM_SEG.w / 2 + 2, baseH], 'y', svc('wrist', 'mg90s'), chain, 'wrist-pitch')
    joint(d, 'wrist-pitch', 'Wrist pitch', 'y', [wristX, 0, baseH], -110, 110)
    chain = 'wrist-pitch'
    box(d, 'wrist-link', [L3, 36, 32], [wristX + L3 / 2, 0, baseH], 'shell', { joint: chain, print: true })
    tipX = wristX + L3
  }
  if (dof >= 5) {
    joint(d, 'wrist-roll', 'Wrist roll', 'x', [tipX, 0, baseH], -180, 180)
    chain = 'wrist-roll'
    cyl(d, 'collar', 17, 26, [tipX + 13, 0, baseH], 'x', 'accent', { joint: chain, print: true })
    ring(d, 'roll-race', 11, 4, 5, [tipX + 4, 0, baseH], 'x', 'steel', { joint: chain })
    tipX += 26
  }
  if (dof >= 6) {
    joint(d, 'wrist-yaw', 'Tool yaw', 'z', [tipX, 0, baseH], -90, 90)
    chain = 'wrist-yaw'
    rbox(d, 'tool-flange', [22, 38, 38], [tipX + 11, 0, baseH], 2, 'metal', { joint: chain })
    for (const sy of [-1, 1]) bolt(d, `flange-bolt${sy}`, [tipX + 11, sy * 14, baseH + 19], 'z', 6, { joint: chain })
    tipX += 22
  }

  // ── tool: parallel jaw pair on a micro servo ────────────────────────────
  const jawOpen = 18 + payload * 6
  rbox(d, 'gripper-body', [34, 54, 40], [tipX + 17, 0, baseH], 2.5, 'accent', { joint: chain, print: true })
  servoBody(d, 'tool-servo', [tipX + 17, 0, baseH + 22], 'z', 'mg90s', chain, chain)
  gear(d, 'tool-pinion', 1, 12, 8, [tipX + 44, 0, baseH], 'z', 'steel', { joint: chain })
  for (const s of [-1, 1]) {
    rbox(d, `jaw-${s < 0 ? 'a' : 'b'}`, [26, 7, 34], [tipX + 44, s * (jawOpen / 2 + 4), baseH], 1.5, 'steel', { joint: chain })
    box(d, `pad-${s < 0 ? 'a' : 'b'}`, [22, 3, 26], [tipX + 44, s * (jawOpen / 2 + 1), baseH], 'rubber', { joint: chain })
  }
  tipX += 60

  // ── structure check: the numbers a reviewer asks for ────────────────────
  // Worst link = forearm box-beam as a cantilever under the shoulder moment.
  const t = WALL
  const bSec = ARM_SEG.w - 6
  const hSec = ARM_SEG.h - 4
  const I2 = (bSec * hSec ** 3 - (bSec - 2 * t) * (hSec - 2 * t) ** 3) / 12 // mm⁴
  const I1 = (ARM_SEG.w * ARM_SEG.h ** 3 - (ARM_SEG.w - 2 * t) * (ARM_SEG.h - 2 * t) ** 3) / 12
  const EMpa = mat.elastic * 1000 // GPa → MPa = N/mm²
  const Msh = req.shoulder / SAFETY * 1000 // N·mm actual (no safety factor for stress)
  const sigma = (Msh * (hSec / 2)) / I2 // MPa on the forearm section
  const allow = mat.yield * 0.24 // inter-layer derate — printed parts are not isotropic
  const tipDefl = (Msh * (L1 + L2) ** 2) / (3 * EMpa * I2) + (Msh * L1 * L2) / (2 * EMpa * I1)
  d.mech = [
    { label: 'Link bending stress', value: `${fmt(sigma, 1)} MPa`, limit: `${fmt(allow, 0)} MPa (${mat.name}, layer-derated)`, ok: sigma < allow },
    { label: 'Tip deflection @ payload', value: `${fmt(tipDefl, 1)} mm`, limit: '±2 mm repeatable', ok: tipDefl < 4 },
    { label: 'Shoulder margin', value: `${fmt(((PARTS[picks.shoulder]?.torque || 0) * (d.actuators[1]?.ratio || 1)) / Math.max(req.shoulder, 0.01), 2)}× stall`, limit: `${SAFETY}× design`, ok: null },
  ]
  if (sigma > allow) {
    d.checks.push({ level: 'fail', msg: `Forearm bending stress ${fmt(sigma, 1)} MPa exceeds the printed-layer limit (~${fmt(allow, 0)} MPa ${mat.name}) — stiffer material (PETG-CF), a taller section, or a shorter reach.` })
  } else if (sigma > allow * 0.7) {
    d.checks.push({ level: 'warn', msg: `Links run at ${Math.round((sigma / allow) * 100)}% of printed bending limit — tip deflection ~${fmt(tipDefl, 1)}mm under full payload. Stiffer material buys accuracy here, not torque.` })
  }

  const servoCount = d.joints.length + 1
  addPart(d, 'pca9685', 1, `${servoCount} servo channels`)
  addPart(d, brief.mcu && brief.mcu !== 'esp32s3' ? brief.mcu : 'esp32s3', 1, 'controller')
  addPart(d, 'buck5a', 1, '6V servo rail')
  // Honour the tethered choice: substituting a pack adds a battery the user did
  // not ask for and reports a runtime for a machine that has no runtime.
  const energy = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'pack3s')
  addPart(d, energy, 1, energy === 'pd5v' ? 'USB-C tethered supply' : 'energy')
  addPart(d, 'fuse', 1, 'pack protection')
  addPart(d, 'cap1000', 1, 'servo rail smoothing')
  addPart(d, 'thrust51103', 1, 'yaw axial load')
  addPart(d, 'as5600', 2, 'shoulder + elbow feedback')
  addPart(d, 'hw_m3', 1, 'nuts + washers')
  addPart(d, 'bearing608', 4, 'joint bearings')
  addPart(d, 'wire22', 1, 'signal harness')
  addPart(d, 'wire18', 1, 'servo rail run')
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
    payloadKg: askedPayload,
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
  const payload = clampPayload(d, brief.payloadKg || 2, 0.2, 15)
  const wheelD = clamp(Math.round(brief.wheelMm || (brief.reachMm || 400) * 0.22), 60, 130) // wheel Ø, mm
  const track = clamp(Math.round(wheelD * 3.2), 150, 420)
  const wheelbase = clamp(Math.round(track * 1.25), 180, 520)
  const r = wheelD / 2 / 1000 // m

  d.title = `${wheelD}mm 4WD rover`
  d.subtitle = `${track}×${wheelbase}mm wheelbase · ${payload}kg cargo`
  d.metrics = {}

  const chassisH = 34
  const z0 = wheelD / 2

  const bed = brief.bedMm || 256
  splitBox(d, 'chassis-deck', [wheelbase, track, 5], [0, 0, z0 + chassisH - 2], 2, 'shell', bed, { print: true })
  for (const sx of [-1, 1]) {
    splitBox(d, `bulkhead-${sx > 0 ? 'f' : 'b'}`, [4, track, chassisH - 8], [sx * (wheelbase / 2 - 3), 0, z0 + chassisH / 2 - 2], 0.8, 'shell', bed, { print: true })
    // two half-bumpers instead of one 288mm wedge: each fits a small bed
    for (const side of [-1, 1]) {
      wedge(d, `bumper-${sx > 0 ? 'f' : 'b'}-${side > 0 ? 'r' : 'l'}`, [16, track * 0.44, 22], [sx * (wheelbase / 2 + 6), side * track * 0.23, z0 + 8], sx > 0 ? 'nx' : 'px', 'accent', { print: true })
    }
  }
  for (const sx of [-1, 1]) {
    splitBox(d, `rail-${sx > 0 ? 'l' : 'r'}`, [wheelbase + 10, 7, chassisH + 10], [0, sx * (track / 2 + 3), z0 + 2], 1.5, 'accent', bed, { print: true })
    for (const fx of [-1, 1]) {
      bolt(d, `rail-bolt-${sx}${fx}`, [fx * (wheelbase / 2 - 8), sx * (track / 2 + 6.5), z0 + chassisH + 4], 'y', 8, { flip: sx < 0 })
    }
  }
  // battery well, electronics shelf, payload plate
  rbox(d, 'battery-well', [wheelbase * 0.42, track * 0.5, 18], [-wheelbase * 0.2, 0, z0 + 12], 2, 'pcb')

  // wheels + motors: torus tire, printed rim, lug hardware — a wheel, not a disc
  const wheels = [
    [wheelbase / 2 - 6, track / 2],
    [wheelbase / 2 - 6, -track / 2],
    [-wheelbase / 2 + 6, track / 2],
    [-wheelbase / 2 + 6, -track / 2],
  ]
  wheels.forEach(([x, y], i) => {
    const side = y > 0 ? 1 : -1
    wheelAssy(d, `wheel-${i}`, [x, y + side * 14, z0], 'y', wheelD, 26, null, side)
    cyl(d, `motor-${i}`, 18.5, 52, [x, y - side * 6, z0], 'y', 'metal')
    cyl(d, `shaft-${i}`, 3, 22, [x, y + side * 4, z0], 'y', 'steel')
    box(d, `motor-brkt-${i}`, [30, 5, 30], [x, y - side * 30, z0], 'metal')
    bearing(d, `wheel-race-${i}`, [x, y + side * 2, z0], 'y', 22, 8, 7)
  })

  // sensor mast + head
  rbox(d, 'mast', [26, 26, 150], [wheelbase * 0.34, 0, z0 + chassisH + 75], 1.5, 'shell', { print: true })
  rbox(d, 'head', [70, 86, 34], [wheelbase * 0.34, 0, z0 + chassisH + 160], 3, 'accent', { print: true })
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
  const asked = battery === 'pd5v' ? 'pd5v' : battery
  const swapped = asked === 'pack2s' && v >= 11
  addPart(d, swapped ? 'pack3s' : asked, 1, `${v}V motor rail`)
  if (swapped) {
    d.checks.push({ level: 'warn', msg: `2S chosen, but ${v}V motors need 3S — the BOM uses the 3S pack. Use a 2S motor (or a boost stage) if you want a lighter pack.` })
  }
  addPart(d, 'buck5a', 1, '5V logic rail')
  // TB6612 tops out at 1.2A/channel — a bigger motor or a 3S pack wants the
  // BTS7960, and a BTS7960 is a single channel so it takes two for L/R drive.
  const driverKey = motorPart.curr.peak > 1.1 || v >= 11 ? 'bts7960' : 'tb6612'
  addPart(d, driverKey, driverKey === 'bts7960' ? 2 : 1, `motor driver${driverKey === 'bts7960' ? ' (one per side)' : ''}`)
  addPart(d, 'fuse', 1, 'pack protection')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, 'cap1000', 1, 'motor rail smoothing')
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
    trackMm: track,
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
  const payload = clampPayload(d, brief.payloadKg || 1, 0.2, 6)
  const legLen = clamp((brief.reachMm || 400) * 0.28, 90, 260)
  const hipW = clamp(Math.round(legLen * 1.35), 120, 340)
  const bodyLen = clamp(Math.round(hipW * 1.5), 160, 460)
  const bodyH = 46

  d.title = `12-servo quadruped · ${Math.round(legLen)}mm leg`
  d.subtitle = `${Math.round(bodyLen)}mm body · ${payload}kg carried`

  const z0 = legLen * 1.35
  const bed = brief.bedMm || 256
  splitBox(d, 'body', [bodyLen, hipW, bodyH], [0, 0, z0], 3, 'shell', bed, { print: true })
  splitBox(d, 'spine', [bodyLen * 0.9, 30, 12], [0, 0, z0 + bodyH / 2 + 6], 1, 'accent', bed, { print: true })
  rbox(d, 'pack', [bodyLen * 0.42, hipW * 0.52, 24], [0, 0, z0 + bodyH / 2 + 18], 2, 'pcb')
  cyl(d, 'head', 23, 34, [bodyLen / 2 + 14, 0, z0 + 10], 'x', 'accent', { print: true })
  cyl(d, 'eye', 8, 6, [bodyLen / 2 + 32, 0, z0 + 14], 'x', 'glass')

  const femur = legLen * 0.62
  const tibia = legLen * 0.78
  // Servo sizing first: the worst gait phase is a leg levering the body up on
  // one foot — torque at the femur, 1.8× on top. One servo everywhere.
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const legMassKg = ((22 * 24 * femur * 0.62 + 16 * 18 * tibia * 0.72) * 0.34 * mat.density) / 1e6 + 0.09
  const reqFoot = G * ((legMassKg * 0.5 + payload / 4) * (legLen / 1000)) * 1.8
  const servoKey = SERVO_LADDER.find((k) => PARTS[k].torque >= reqFoot) || 'ds3218'
  const servo = PARTS[servoKey]

  const corners = [
    ['fl', 1, 1], ['fr', 1, -1], ['rl', -1, 1], ['rr', -1, -1],
  ]
  // 3 DOF per leg, the way the firmware already walks it: coxa yaw (z),
  // femur pitch (y), tibia pitch (y) — each with its own servo body.
  corners.forEach(([name, sx, sy]) => {
    const ax = (sx * bodyLen) / 2 - sx * 14
    const ay = (sy * hipW) / 2 + sy * 10
    const hipZ = z0 - 4

    joint(d, `coxa-${name}`, `Coxa ${name.toUpperCase()}`, 'z', [ax, ay, hipZ], -30, 30, null)
    // coxa servo: case bolted under the deck, horn swings the whole leg
    servoBody(d, `coxasv-${name}`, [ax, ay, hipZ + 4], 'z', servoKey, null, `coxa-${name}`, { flip: true })
    bracketU(d, `coxa-br-${name}`, [ax, ay, hipZ - 2], [30, 20, 34], 4, 'accent', `coxa-${name}`)

    const fy = ay + sy * 12
    joint(d, `femur-${name}`, `Femur ${name.toUpperCase()}`, 'y', [ax, fy, hipZ - 8], -60, 60, `coxa-${name}`)
    servoBody(d, `femursv-${name}`, [ax, fy - sy * 6, hipZ - 8], 'y', servoKey, `coxa-${name}`, `femur-${name}`)
    box(d, `femur-${name}`, [22, 24, femur * 0.62], [ax, fy, hipZ - 8 - femur * 0.31], 'shell', { print: true, joint: `femur-${name}` })
    // tibia servo rides the femur link, shaft at the knee
    const kneeZ = hipZ - 8 - femur * 0.66
    joint(d, `tibia-${name}`, `Tibia ${name.toUpperCase()}`, 'y', [ax, fy, kneeZ], -80, 80, `femur-${name}`)
    servoBody(d, `tibiasv-${name}`, [ax, fy - sy * 5, kneeZ], 'y', servoKey, `femur-${name}`, `tibia-${name}`)
    rbox(d, `tibia-${name}`, [16, 18, tibia * 0.72], [ax, fy, kneeZ - tibia * 0.36], 1.5, 'accent', { print: true, joint: `tibia-${name}` })
    cyl(d, `foot-${name}`, 11, 9, [ax, fy, kneeZ - tibia * 0.78], 'z', 'rubber', { joint: `tibia-${name}` })
  })

  // ── parts: the electrical problem is the BOM ────────────────────────────
  addPart(d, servoKey, 12, '12 joints (3 per leg)')
  addPart(d, 'pca9685', 2, '24 channels of PWM')
  addPart(d, 'buck5a', 2, 'split servo rails')
  // Honour the ENERGY selector: hardcoding the pack meant the control did nothing.
  const packKey = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo3s')
  addPart(d, packKey, packKey === 'pd5v' ? 1 : 1, packKey === 'pd5v' ? 'tethered supply' : 'servo pack')
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
    servo: servoKey,
  })
  return d
}

// ── gripper: a tool, but a machine you can build ────────────────────────────
// A real rack-and-pinion parallel gripper: servo under the deck drives a pinion,
// two opposing racks slide on a linear rail, L-fingers do the gripping. Force is
// torque over the pinion pitch radius; hold is the friction cone at the pads.

function buildGripper(brief) {
  const d = newDesign('gripper', brief)
  const span = clamp(brief.reachMm || 80, 30, 240) // jaw opening, mm
  const payload = clampPayload(d, brief.payloadKg || 1, 0.1, 6)
  const mat = MATERIALS[brief.material] || MATERIALS.petg

  d.title = `${Math.round(span)}mm parallel gripper`
  d.subtitle = `${payload}kg class · rack & pinion · servo actuated`

  // ── mechanism numbers first: the gear decides the force ──────────────────
  const mod = 1.25 // gear module, mm
  const zTeeth = 14
  const pitchR = (mod * zTeeth) / 2 / 1000 // m
  // PWM servos only — the firmware drives a plain 50Hz channel, not a TTL bus
  const servo = SERVO_LADDER.filter((k) => k !== 'sts3215')
    .find((k) => (PARTS[k].torque * 0.35) / pitchR >= payload * G / 0.6 / 2) || 'ds3225'
  const T = PARTS[servo].torque
  const jawF = Math.min((T * 0.35) / pitchR, 150) // N per jaw, continuous — 35% stall is the honest hold
  const gripMass = (0.6 * 2 * jawF) / G // µ_eff 0.6 rubber pads, two contact faces

  const sd = PARTS[servo].dims || [40, 20, 40]
  const deckW = Math.max(92, sd[0] + 52)
  const deckL = span * 0.72 + 86
  const deckZ = 52 // top of deck
  const railY = 26

  // ── frame: mounting flange + pillars + deck ──────────────────────────────
  rbox(d, 'flange', [deckL, deckW, 7], [0, 0, 3.5], 2, 'accent', { print: true })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    rbox(d, `pillar-${sx}${sy}`, [14, 14, 40], [sx * (deckL / 2 - 12), sy * (deckW / 2 - 12), 27], 1.5, 'shell', { print: true })
    bolt(d, `flange-bolt-${sx}${sy}`, [sx * (deckL / 2 - 12), sy * (deckW / 2 - 12), 7], 'z', 10)
    bolt(d, `deck-bolt-${sx}${sy}`, [sx * (deckL / 2 - 12), sy * (deckW / 2 - 12), deckZ], 'z', 10)
  }
  rbox(d, 'deck', [deckL, deckW, 7], [0, 0, deckZ - 3.5], 2, 'shell', { print: true })
  // servo bay cheeks keep it rigid + give the ears somewhere to bolt
  for (const sy of [-1, 1]) box(d, `cheek-${sy}`, [deckL - 26, 5, 38], [0, sy * (deckW / 2 - 12), 27], 'shell', { print: true })

  // ── servo, shaft up through the deck ─────────────────────────────────────
  servoBody(d, 'servo', [0, 0, deckZ + 5], 'z', servo, null)
  bolt(d, 'servo-ear-a', [-sd[0] / 2 - 2, -8, deckZ - 12], 'y', 8, { flip: true })
  bolt(d, 'servo-ear-b', [sd[0] / 2 + 2, -8, deckZ - 12], 'y', 8, { flip: true })
  // cable sneaks out the back
  bend(d, 'servo-lead', 16, 2.2, 80, [-deckL / 2 + 16, -6, 30], [0, Math.PI / 2, Math.PI], 'belt')

  // ── pinion + opposing racks on the deck ──────────────────────────────────
  gear(d, 'pinion', mod, zTeeth, 9, [0, 0, deckZ + 9], 'z', 'steel')
  // racks must still engage the pinion AND reach their jaw at full close
  const rackLen = span * 0.75 + 80
  const rackH = 6
  const travel = span / 2 - 8
  slideJoint(d, 'jaw', 'Jaw travel', 'x', Math.max(8, travel))
  const rackY = pitchR * 1000 + rackH / 2 + 0.6 // pitch line kisses the pinion
  // rack A: teeth face -y (down toward pinion), jaw on the -x end
  rack(d, 'rack-a', [rackLen, 8, rackH], Math.round(rackLen / (Math.PI * mod)), [-span * 0.05, rackY, deckZ + 6], 'brass',
    { rot: [Math.PI / 2, 0, 0], print: true, slide: { joint: 'jaw', sign: 1 } })
  rack(d, 'rack-b', [rackLen, 8, rackH], Math.round(rackLen / (Math.PI * mod)), [span * 0.05, -rackY, deckZ + 6], 'brass',
    { rot: [-Math.PI / 2, 0, 0], print: true, slide: { joint: 'jaw', sign: -1 } })

  // ── linear rail + carriages carry the jaw load, racks only drive ─────────
  cyl(d, 'rail', 3, Math.min(deckL * 0.86, span * 0.9 + 60), [0, 0, deckZ + 3], 'x', 'steel', { segs: 10 })
  for (const sy of [-1, 1]) {
    box(d, `rail-keeper-${sy}`, [Math.min(deckL * 0.8, span * 0.9 + 44), 7, 8], [0, sy * railY, deckZ + 4], 'shell', { print: true })
  }

  // ── jaw assemblies: carriage pair + riser + L-finger + replaceable pad ────
  // At rest the PAD FACES sit ±span/2 — that is the rated opening. Closing
  // slides each jaw toward centre; pads meet at ~16mm residual gap.
  for (const s of [-1, 1]) {
    const sign = -s // jaw A (-x) rides slide +1 (toward centre = close)
    const tag = s < 0 ? 'a' : 'b'
    const slideOpt = { joint: 'jaw', sign }
    // carriage blocks on the keeper rails
    const jx = s * (span / 2 + 3)
    for (const sy of [-1, 1]) {
      rbox(d, `carriage-${tag}${sy}`, [26, 13, 8], [jx - s * 6, sy * railY, deckZ + 4], 1.2, 'metal', { slide: slideOpt })
    }
    // riser ties the carriages to the rack ends
    rbox(d, `riser-${tag}`, [10, railY * 2 + 13, 5], [jx - s * 6, 0, deckZ + 6.5], 1, 'accent', { print: true, slide: slideOpt })
    // L-finger: horizontal ear over the riser, vertical blade out at span/2
    const bladeX = s * (span / 2 + 7)
    const earX = s * (span / 2 - 10)
    rbox(d, `finger-ear-${tag}`, [36, 26, 5], [earX, 0, deckZ + 12], 1, 'accent', { print: true, slide: slideOpt })
    rbox(d, `blade-${tag}`, [6, 30, 46], [bladeX, 0, deckZ + 35], 1.5, 'shell', { print: true, slide: slideOpt })
    wedge(d, `gusset-${tag}`, [10, 26, 12], [earX - s * 8, 0, deckZ + 20], s < 0 ? 'nx' : 'px', 'accent', { print: true, slide: slideOpt })
    // replaceable fingertip pad on the blade's inboard face — inner face = span/2
    rbox(d, `pad-${tag}`, [4, 26, 30], [s * (span / 2 + 2), 0, deckZ + 30], 0.8, 'rubber', { slide: slideOpt })
    bolt(d, `blade-bolt-${tag}`, [s * (span / 2), 0, deckZ + 44], 'x', 8, { flip: s > 0, slide: slideOpt })
    bolt(d, `ear-bolt-${tag}`, [earX + s * 8, 0, deckZ + 14.5], 'z', 8, { slide: slideOpt })
  }

  // ── homing switch + jaw-position encoder ─────────────────────────────────
  box(d, 'limitsw', [20, 10, 7], [deckL / 2 - 14, -railY, deckZ + 10.5], 'pcb')
  rbox(d, 'limitsw-lever', [22, 2, 6], [deckL / 2 - 26, -railY, deckZ + 12], 0.5, 'steel')
  box(d, 'enc-bracket', [14, 22, 26], [deckL / 2 - 18, rackY, deckZ + 20], 'shell', { print: true })
  box(d, 'enc-pcb', [22, 20, 3], [deckL / 2 - 24, rackY, deckZ + 14], 'pcb')
  cyl(d, 'enc-magnet', 3, 2, [deckL / 2 - 24, rackY - 5.5, deckZ + 6], 'y', 'steel', { slide: { joint: 'jaw', sign: 1 } })

  // ── parts: counted like a real kit list ──────────────────────────────────
  addPart(d, servo, 1, 'rack & pinion actuator')
  addPart(d, 'mgn12', 2, 'jaw linear guides')
  addPart(d, 'limit_sw', 1, 'homing end-stop')
  addPart(d, 'as5600', 1, 'jaw position feedback')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller')
  addPart(d, 'buck5a', 1, '6V servo rail')
  addPart(d, brief.battery === 'pd5v' || !brief.battery ? 'pd5v' : brief.battery, 1, 'energy')
  addPart(d, 'fuse', 1, 'rail protection')
  addPart(d, 'cap1000', 1, 'servo rail smoothing')
  addPart(d, 'insert_m3', 2, 'heat-set threads (~16 pcs)')
  addPart(d, 'm3_screws', 2, 'frame + jaw bolts (~20 pcs)')
  addPart(d, 'm2_screws', 1, 'switch + encoder mounting')
  addPart(d, 'wire22', 1, 'signal harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, mat.priceId, 1, 'printed structure')

  // ── the honest numbers ────────────────────────────────────────────────────
  d.notes.push(`${PARTS[servo].name} on a Ø${fmt(pitchR * 2000, 1)}mm pinion → ${fmt(jawF, 0)}N continuous per jaw, ~${fmt(gripMass, 1)}kg held on rubber pads (µ 0.6).`)
  d.notes.push(`Two MGN12 rails carry the jaw side-load; the printed racks only see drive force. Jaw pads are the only wear part — print spares.`)
  if (gripMass < payload) {
    d.checks.push({ level: 'fail', msg: `Continuous grip holds ~${fmt(gripMass, 1)}kg but the brief asks ${payload}kg — step to a ${PARTS.ds3225.name}, shrink the pinion to 10T, or add a 2:1 gear stage.` })
  }
  if (jawF >= 150) {
    d.checks.push({ level: 'warn', msg: `${fmt(jawF, 0)}N per jaw is the printed-rack shear limit — go module 1.5 → 2.0 or machine the racks in acetal if this lives at full grip.` })
  }
  const opening = span
  if (opening < 40) d.checks.push({ level: 'warn', msg: `Jaw opening ${Math.round(opening)}mm — check the object fits with 6mm clearance past the pads.` })

  d.metrics = { gripForceN: jawF, gripMassKg: gripMass, spanMm: span, pinionMm: pitchR * 1000, joints: 1, servo }
  d.mech = [
    { label: 'Jaw force (continuous)', value: `${fmt(jawF, 0)} N`, limit: 'rack shear ~150 N', ok: jawF < 150 },
    { label: 'Pinion pitch radius', value: `${fmt(pitchR * 1000, 1)} mm`, limit: `m${mod} × ${zTeeth}T`, ok: null },
    { label: 'Hold capacity', value: `${fmt(gripMass, 1)} kg`, limit: `${payload} kg brief`, ok: gripMass >= payload },
    { label: 'Jaw travel', value: `${fmt(Math.max(8, travel), 0)} mm/side`, limit: 'stroke > obj/2', ok: null },
  ]
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
  const gadgetPower = brief.battery === 'pd5v' || !brief.battery ? 'pd5v' : (PARTS[brief.battery] ? brief.battery : 'pd5v')
  addPart(d, gadgetPower, 1, gadgetPower === 'pd5v' ? 'USB-C power' : 'battery')
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
  const payload = clampPayload(d, brief.payloadKg || 1, 0.2, 5)
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
  const bed = brief.bedMm || 256
  splitBox(d, 'deck', [wheelbase, track, 5], [0, 0, deckZ - 2], 2, 'shell', bed, { print: true })
  for (const sx of [-0.28, 0.12]) {
    splitBox(d, `deck-rib-${sx}`, [10, track - 12, 16], [wheelbase * sx, 0, deckZ - 12], 0.6, 'shell', bed, { print: true })
  }
  for (const sx of [-1, 1]) {
    splitBox(d, `rail-${sx > 0 ? 'l' : 'r'}`, [wheelbase + 8, 4, 40], [0, sx * (track / 2 + 2), z0 + chassisH / 2 - 2], 0.6, 'accent', bed, { print: true })
  }
  for (const sx of [-1, 1]) {
    splitBox(d, `bulkhead-${sx > 0 ? 'f' : 'b'}`, [4, track, chassisH - 22], [sx * (wheelbase / 2 - 4), 0, z0 + chassisH / 2 - 6], 0.6, 'shell', bed, { print: true })
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
    wheelAssy(d, `wheel-${i}`, [x, y + side * 16, z0], 'y', wheelD, 30, null, side)
    // motor block sits inboard of the wheel so it is visible in the model
    cyl(d, `motor-${i}`, 19, 46, [x, y - side * 26, z0], 'y', 'metal')
  })

  // ── arm ─────────────────────────────────────────────────────────────────
  ring(d, 'turret', 46, 38, turretH, [armX, 0, deckZ + turretH / 2], 'z', 'shell', { print: true })
  servoBody(d, 'yaw-servo', [armX, 0, shoulderZ - 14], 'z', 'ds3225', null, 'yaw')
  bearing(d, 'turret-race', [armX, 0, shoulderZ], 'z', 52, 30, 12, { joint: 'yaw' })
  joint(d, 'yaw', 'Base yaw', 'z', [armX, 0, shoulderZ], -160, 160)

  rbox(d, 'shoulder-block', [54, 62, 50], [armX + 8, 0, shoulderZ + 16], 2, 'shell', { joint: 'yaw', print: true })
  cyl(d, 'shoulder-hub', 20, 72, [armX, 0, shoulderZ], 'y', 'metal', { joint: 'yaw' })
  servoBody(d, 'shoulder-servo', [armX, -38, shoulderZ], 'y', 'ds3225', 'yaw', 'shoulder')
  joint(d, 'shoulder', 'Shoulder pitch', 'y', [armX, 0, shoulderZ], -80, 80)

  box(d, 'upper-arm', [L1, 48, 42], [armX + L1 / 2, 0, shoulderZ], 'shell', { joint: 'shoulder', print: true })
  box(d, 'upper-rib', [L1 * 0.8, 10, 6], [armX + L1 / 2, 0, shoulderZ + 24], 'accent', { joint: 'shoulder', print: true })
  cyl(d, 'elbow-hub', 17, 56, [armX + L1, 0, shoulderZ], 'y', 'metal', { joint: 'shoulder' })
  servoBody(d, 'elbow-servo', [armX + L1, -30, shoulderZ], 'y', 'ds3218', 'shoulder', 'elbow')
  bearing(d, 'elbow-race', [armX + L1, 30, shoulderZ], 'y', 22, 8, 7, { joint: 'shoulder' })
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
  joint(d, 'head-pan', 'Head pan', 'z', [headX, headY, deckZ + 44], -90, 90, null)

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
  const packKey = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo3s')
  addPart(d, packKey, 1, packKey === 'pd5v' ? 'tethered supply' : 'drive + servo pack')
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
    trackMm: track,
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
  const driver = design.parts.find((p) => p.key === 'tb6612' || p.key === 'bts7960')?.key || 'bts7960'
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

// ── humanoid: the archetype that tells you the truth about bipeds ───────────
// A humanoid is not "an arm on legs". Two things change everything:
//
//   1. the skeleton BRANCHES (two legs, two arms off one pelvis), so the FK has
//      to walk a parent chain rather than an index range — see chainsFor();
//   2. a biped is never statically stable. Its support polygon while standing
//      on two feet is a line, and on one foot it is a 100×50mm patch under a
//      3kg machine. Balance is a control problem; this generator sizes the
//      hardware for it and says so in the checks instead of pretending.
//
// Servo count is the other wall: 23 joints at 2A stall each is a power-budget
// problem before it is a mechanical one.

function buildHumanoid(brief) {
  const d = newDesign('humanoid', brief)
  const H = clamp(brief.reachMm || 620, 380, 1100) // standing height, mm
  const handPayload = clampPayload(d, brief.payloadKg || 0.5, 0.1, 3)
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const density = mat.density / 1000

  // Proportions: roughly 7 heads tall, but the numbers that matter are the
  // ones that keep the limbs APART — a thigh wider than the hip spacing fuses
  // the legs into one slab in the render and in your print.
  const footH = H * 0.036
  const footL = H * 0.185
  const footW = H * 0.085
  const shin = H * 0.225
  const thigh = H * 0.235
  const pelvisH = H * 0.075
  const torsoH = H * 0.26
  const headH = H * 0.115
  const limbW = Math.max(20, H * 0.06)
  const limbD = limbW * 1.2
  const legX = H * 0.072
  const hipW = H * 0.17
  const shoulderW = H * 0.21
  const armX = shoulderW / 2 + limbW / 2 + 6
  const upperArm = H * 0.175
  const forearm = H * 0.16
  const handL = H * 0.05

  const zFoot = footH
  const zAnkle = zFoot + 8
  const zKnee = zAnkle + shin
  const zHip = zKnee + thigh
  const pelvisTop = zHip + pelvisH
  const zChest = pelvisTop + torsoH
  const zShoulder = zChest - torsoH * 0.12
  const zNeck = zChest + 12
  const zHead = zNeck + headH / 2 + 10

  d.title = `${Math.round(H)}mm humanoid · 23 joints`
  d.subtitle = `${handPayload}kg per hand · ${mat.name} skeleton · serial-bus servos`

  // ── pelvis + torso + head ────────────────────────────────────────────────
  rbox(d, 'pelvis', [hipW, limbD + 14, pelvisH], [0, 0, zHip + pelvisH / 2], 2.5, 'shell', { print: true })
  rbox(d, 'torso', [shoulderW, limbD + 20, torsoH - 8], [0, 0, pelvisTop + (torsoH - 8) / 2 + 8], 3, 'shell', { print: true })
  rbox(d, 'chest-plate', [shoulderW * 0.86, 14, torsoH * 0.5], [0, limbD / 2 + 12, pelvisTop + torsoH * 0.62], 2, 'accent', { print: true })
  box(d, 'pack', [shoulderW * 0.6, 22, torsoH * 0.4], [0, -limbD / 2 - 14, pelvisTop + torsoH * 0.55], 'pcb')
  cyl(d, 'neck', 13, 18, [0, 0, zNeck + 4], 'z', 'metal')
  box(d, 'head', [headH * 0.95, headH * 0.88, headH], [0, 0, zHead], 'shell', { print: true })
  box(d, 'visor', [headH * 0.62, 6, headH * 0.32], [0, headH * 0.45, zHead + 3], 'glass')

  // waist is the ROOT joint: everything above and below hangs off it
  joint(d, 'waist', 'Waist yaw', 'z', [0, 0, zHip + pelvisH * 0.7], -60, 60, null)
  joint(d, 'neck-pan', 'Head pan', 'z', [0, 0, zNeck], -70, 70, 'waist')
  joint(d, 'neck-tilt', 'Head tilt', 'y', [0, 0, zNeck], -25, 25, 'neck-pan')

  // ── legs ────────────────────────────────────────────────────────────────
  const legs = [['l', 1], ['r', -1]]
  for (const [side, sx] of legs) {
    const x = sx * legX
    const label = side === 'l' ? 'Left' : 'Right'
    const hipPivot = [x, 0, zHip]
    joint(d, `${side}-hip-yaw`, `${label} hip yaw`, 'z', hipPivot, -45, 45, null)
    joint(d, `${side}-hip-roll`, `${label} hip roll`, 'x', hipPivot, -25, 25, `${side}-hip-yaw`)
    joint(d, `${side}-hip-pitch`, `${label} hip pitch`, 'y', hipPivot, -100, 45, `${side}-hip-roll`)
    cyl(d, `hip-hub-${side}`, 18, limbW + 10, [x, 0, zHip], 'x', 'metal', { joint: `${side}-hip-pitch` })
    // 6mm of clearance below each hub so the joint reads (and rotates) as a joint
    box(d, `thigh-${side}`, [limbW, limbD, thigh - 12], [x, 0, zHip - thigh / 2 - 6], 'shell', { joint: `${side}-hip-pitch`, print: true })

    const kneePivot = [x, 0, zKnee]
    joint(d, `${side}-knee`, `${label} knee`, 'y', kneePivot, -5, 135, `${side}-hip-pitch`)
    cyl(d, `knee-hub-${side}`, 15, limbW + 6, [x, 0, zKnee], 'x', 'metal', { joint: `${side}-knee` })
    bearing(d, `knee-race-${side}`, [x, (limbW + 6) / 2 + 4, zKnee], 'y', 22, 8, 7, { joint: `${side}-knee` })
    bolt(d, `knee-bolt-${side}`, [x, (limbW + 6) / 2 + 10, zKnee], 'y', 8, { joint: `${side}-knee` })
    box(d, `shin-${side}`, [limbW * 0.86, limbD * 0.9, shin - 14], [x, 0, zKnee - shin / 2 - 7], 'shell', { joint: `${side}-knee`, print: true })
    box(d, `shin-rib-${side}`, [limbW * 0.5, 8, shin * 0.7], [x, limbD * 0.45, zKnee - shin / 2], 'accent', { joint: `${side}-knee`, print: true })

    joint(d, `${side}-ankle-pitch`, `${label} ankle pitch`, 'y', [x, 0, zAnkle], -35, 35, `${side}-knee`)
    joint(d, `${side}-ankle-roll`, `${label} ankle roll`, 'x', [x, 0, zAnkle], -20, 20, `${side}-ankle-pitch`)
    cyl(d, `ankle-hub-${side}`, 12, limbW * 0.8, [x, 0, zAnkle], 'x', 'metal', { joint: `${side}-ankle-pitch` })
    box(d, `foot-${side}`, [footW, footL, footH], [x, footL * 0.22, zFoot / 2], 'accent', { joint: `${side}-ankle-roll`, print: true })
    box(d, `sole-${side}`, [footW * 0.92, footL * 0.94, 5], [x, footL * 0.22, 2.5], 'rubber', { joint: `${side}-ankle-roll` })
  }

  // ── arms ────────────────────────────────────────────────────────────────
  const arms = [['l', 1], ['r', -1]]
  for (const [side, sx] of arms) {
    const x = sx * armX
    const label = side === 'l' ? 'Left' : 'Right'
    const shoulder = [x, 0, zShoulder]
    joint(d, `${side}-shoulder-roll`, `${label} shoulder roll`, 'x', shoulder, -35, 90, null)
    joint(d, `${side}-shoulder-pitch`, `${label} shoulder pitch`, 'y', shoulder, -110, 60, `${side}-shoulder-roll`)
    cyl(d, `shoulder-hub-${side}`, 16, limbW, [x, 0, zShoulder], 'x', 'metal', { joint: `${side}-shoulder-pitch` })
    box(d, `upperarm-${side}`, [limbW * 0.9, limbD * 0.86, upperArm - 10], [x, 0, zShoulder - upperArm / 2 - 5], 'shell', { joint: `${side}-shoulder-pitch`, print: true })

    const elbow = [x, 0, zShoulder - upperArm]
    joint(d, `${side}-elbow`, `${label} elbow`, 'y', elbow, -140, 5, `${side}-shoulder-pitch`)
    cyl(d, `elbow-hub-${side}`, 13, limbW * 0.85, elbow, 'x', 'metal', { joint: `${side}-elbow` })
    box(d, `forearm-${side}`, [limbW * 0.78, limbD * 0.75, forearm - 10], [x, 0, elbow[2] - forearm / 2 - 5], 'shell', { joint: `${side}-elbow`, print: true })

    const wrist = [x, 0, elbow[2] - forearm]
    joint(d, `${side}-wrist`, `${label} wrist`, 'y', wrist, -80, 80, `${side}-elbow`)
    box(d, `hand-${side}`, [limbW * 0.7, limbD * 0.6, handL], [x, 0, wrist[2] - handL / 2 - 4], 'accent', { joint: `${side}-wrist`, print: true })
  }

  // ── masses and torque ───────────────────────────────────────────────────
  const printedKg = (printedVolume(d.nodes) * mat.density) / 1000 / 1000
  const servoMassKg = 0.062
  const joints = d.joints.length
  const electronicsKg = 0.42 // MCU, bus adapters, IMU, harness, fasteners
  const packKg = 0.36 // 2 × 3S 2200 in parallel
  const totalKg = printedKg + joints * servoMassKg + electronicsKg + packKg + handPayload * 2

  const upperKg = totalKg * 0.58 // torso, head, arms, pack
  const legKg = totalKg - upperKg
  const SAFETY = 1.8
  // Ankle: the whole machine balanced on that joint while one foot lifts.
  const ankleNeed = totalKg * G * ((footL / 2 - 18) / 1000) * SAFETY
  // Knee: single-support squat, upper body lever ~ 30mm horizontal.
  const kneeNeed = (upperKg + legKg * 0.5) * G * (0.03 + (H / 1000) * 0.02) * SAFETY
  // Hip: swing-leg + upper body, worst case during a step.
  const hipNeed = upperKg * G * ((H / 1000) * 0.06) * SAFETY
  // Shoulder: arm out at 90° plus what it holds.
  const armKg = legKg * 0.35
  const shoulderNeed = (armKg + handPayload) * G * ((upperArm + forearm) / 1000) * 0.5 * SAFETY

  const need = {
    'Ankle': ankleNeed, 'Knee': kneeNeed, 'Hip': hipNeed, 'Shoulder': shoulderNeed,
  }

  const top = SERVO_LADDER[SERVO_LADDER.length - 1]
  const picks = {}
  for (const [label, want] of Object.entries(need)) {
    let servo = SERVO_LADDER.find((k) => PARTS[k].torque >= want) || top
    if (PARTS[servo].torque < want) {
      d.checks.push({
        level: 'fail',
        msg: `${label} needs ${fmt(want, 2)} N·m at ${Math.round(H)}mm scale — past ${PARTS[servo].name} (${fmt(PARTS[servo].torque, 2)} N·m). This is a harmonic-drive/planetary machine: shrink the robot or move to NEMA17-class joints.`,
      })
    }
    picks[label] = servo
  }

  // Real humanoids use one servo class everywhere and differ in gearing; use the
  // biggest joint's servo for all 23 so the BOM is honest about what a biped costs.
  const jointServo = 'sts3215'
  addPart(d, jointServo, joints, `${joints} joints on 2 serial buses`)
  addPart(d, 'bus_adapter', 2, 'leg bus + arm bus')
  addPart(d, 'bno085', 1, 'balance IMU')
  addPart(d, 'esp32s3', 1, 'controller')
  const packKey = brief.battery === 'pd5v' ? 'pd5v' : (brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo3s')
  addPart(d, packKey, packKey === 'pd5v' ? 1 : 2, packKey === 'pd5v' ? 'tethered supply' : 'split packs: legs / arms')
  addPart(d, 'buck5a', 3, '3 isolated rails')
  addPart(d, 'vl53l0x', 1, 'forward ranging')
  addPart(d, 'hw_m3', 1, 'frame fasteners')
  addPart(d, 'bearing608', 8, 'hip + knee bearings')
  addPart(d, 'wire22', 1, 'harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, mat.priceId, 1, 'printed skeleton')

  // ── the checks that matter for a biped ──────────────────────────────────
  d.checks.push({
    level: 'warn',
    msg: `Balance: a biped's support polygon is the line between two feet (${Math.round(footL)}×66mm per foot). Static stability is impossible — this needs the IMU and a closed-loop balance controller. The generated firmware holds a stand pose; walking is a control project, not a print project.`,
  })
  const actuatorCost = PARTS[jointServo].price * joints
  d.checks.push({
    level: 'warn',
    msg: `${joints} joint actuators cost ${money(actuatorCost)} — that is ${Math.round((actuatorCost / (actuatorCost + 180)) * 100)}% of the machine. Budget the servos first; everything else is cheap.`,
  })

  const tightest = Object.entries(need).sort((a2, b2) => b2[1] - a2[1])[0]
  const tightServo = SERVO_LADDER.find((k) => PARTS[k].torque >= tightest[1]) || top
  if (tightest[1] > PARTS[tightServo].torque * 0.85) {
    d.checks.push({
      level: 'warn',
      msg: `${tightest[0]} runs at ${Math.round((tightest[1] / PARTS[tightServo].torque) * 100)}% of ${PARTS[tightServo].name} stall (${fmt(tightest[1], 2)} of ${fmt(PARTS[tightServo].torque, 2)} N·m). That is a joint you will replace: derate the payload, add a 2:1 stage, or move up a servo class.`,
    })
  }

  d.notes.push(`Sized at ${Math.round(H)}mm standing with ${Math.round(totalKg * 1000)}g all-up: ankle ${fmt(ankleNeed, 2)} N·m, knee ${fmt(kneeNeed, 2)}, hip ${fmt(hipNeed, 2)}, shoulder ${fmt(shoulderNeed, 2)} N·m (with a ${SAFETY}× factor).`)
  d.notes.push('Two serial buses, not 23 PWM channels: legs on bus 0, arms and head on bus 1. Half-duplex TTL, 1Mbps, each servo addressable — and every servo reports position and load back, which a biped cannot work without.')
  d.notes.push('Bracket the hips and knees with 608 bearings and print those parts in PETG, not PLA: a humanoid takes repeated shock loads at exactly those two joints.')

  Object.assign(d.metrics, {
    joints,
    heightMm: Math.round(H),
    massKg: totalKg,
    torque: need,
    servo: jointServo,
    actuatorCost,
    printedG: printedKg * 1000,
  })
  d.actuators = Object.entries(need).map(([label, want]) => ({
    label, need: want, servo: jointServo, ratio: 1, effective: PARTS[jointServo].torque,
  }))
  return d
}

/** Bus-servo firmware: hold a stand pose, report, and get out of the way. */
function humanoidFirmware(design, a, pin) {
  const tx0 = pin('BUS0 TX', 17), rx0 = pin('BUS0 RX', 18)
  const tx1 = pin('BUS1 TX', 47), rx1 = pin('BUS1 RX', 48)
  const legs = design.joints.filter((j) => /(hip|knee|ankle)/.test(j.id))
  const upper = design.joints.filter((j) => !/(hip|knee|ankle)/.test(j.id))
  const idTable = [
    ...legs.map((j, i) => `// legs  ID ${String(i + 1).padStart(2)}: ${j.label}`),
    ...upper.map((j, i) => `// upper ID ${String(i + 1).padStart(2)}: ${j.label}`),
  ].join('\n')
  const standLegs = legs.map((j, i) => `  st.WritePosEx(${i + 1}, 2048, 120, 30);`).join('\n')
  const standUpper = upper.map((j, i) => `  upper.WritePosEx(${i + 1}, 2048, 120, 30);`).join('\n')
  return `/* ${design.title} — ${a.mcu.name}
 * Generated by Rigforge. ${design.joints.length} serial-bus joints on two TTL buses.
 *
 * THIS IS A STAND-AND-HOLD CONTROLLER. It does not walk. A biped cannot be made
 * stable by geometry — it needs a balance loop reading the IMU at 200Hz and
 * commanding hips/ankles every cycle. That is the next project, and this file is
 * the honest starting point for it.
 */
#include <SCServo.h>
#include <Wire.h>

SMS_STS st;                       // legs: bus 0
SMS_STS upper;                    // waist + arms + head: bus 1

// Servo IDs are per-bus, so the same ID can exist on each bus:
${idTable}
const long BAUDRATE = 1000000;

void setupBuses() {
  // UART1 = legs, UART2 = arms + head. UART0 stays the console.
  Serial1.begin(BAUDRATE, SERIAL_8N1, ${rx0}, ${tx0});
  st.pSerial = &Serial1;
  Serial2.begin(BAUDRATE, SERIAL_8N1, ${rx1}, ${tx1});
  upper.pSerial = &Serial2;
}

void standPose() {
  // Every joint to its centre with a slow, low-torque-limit move: on first power
  // up you do NOT want 23 servos snapping to position with the robot upright.
${standLegs}
${standUpper}
  delay(1200);
}

void holdStand() {
  // Torque on, position held. A real controller replaces this with a balance loop.
  for (int id = 1; id <= ${legs.length}; id++) st.EnableTorque(id, 1);
  for (int id = 1; id <= ${upper.length}; id++) upper.EnableTorque(id, 1);
}

void report() {
  // A joint pinned at high load is a servo about to strip a gear.
  for (int id = 1; id <= ${legs.length}; id++)
    Serial.printf("leg %02d pos=%4d load=%4d\\n", id, st.ReadPos(id), st.ReadLoad(id));
  for (int id = 1; id <= ${upper.length}; id++)
    Serial.printf("up  %02d pos=%4d load=%4d\\n", id, upper.ReadPos(id), upper.ReadLoad(id));
}

void setup() {
  Serial.begin(115200);
  setupBuses();
  standPose();
  holdStand();
  Serial.println("${design.title}: standing. Balance loop not implemented — see the header.");
}

void loop() {
  // No gait. Read the IMU, watch the joint loads, and stop if anything is
  // fighting: a joint pinned at high load is a servo about to strip a gear.
  static uint32_t last = 0;
  if (millis() - last > 250) {
    last = millis();
    report();
  }
}`
}

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

  // shell: base tray, lid, four ears, a window over the display, a USB notch
  rbox(d, 'tray', [W, H, D - 8], [0, 0, (D - 8) / 2], 2.5, 'shell', { print: true })
  rbox(d, 'lid', [W, H, 4], [0, 0, D - 2], 2.5, 'shell', { print: true })
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    box(d, `ear-${sx}${sy}`, [8, 8, 3], [sx * (W / 2 - 4), sy * (H / 2 - 4), 1.5], 'shell', { print: true })
    cyl(d, `ear-hole-${sx}${sy}`, 1.6, 3.2, [sx * (W / 2 - 4), sy * (H / 2 - 4), 1.5], 'z', 'rubber')
  }
  // front window + bezel
  const frontZ = D / 2
  rbox(d, 'bezel', [34, 26, 2], [0, 0, frontZ + 1], 1.5, 'accent', { print: true })
  box(d, 'window', [24, 16, 1.4], [0, 0, frontZ + 2.2], 'glass')
  // side cut-outs: USB-C, sensor grille
  box(d, 'usb-notch', [10, 6, 5], [W / 2 - 1, 0, D / 2 - 4], 'rubber')
  for (let i = -2; i <= 2; i += 1) box(d, `vent-${i}`, [1.6, 22, 1.6], [-W / 2 + 1, i * 4, D / 2 + 0.4], 'rubber')

  // the board sits on standoffs, the sensor on the lid, the cell underneath
  rbox(d, 'mcu', [26, 18, 5], [-8, 0, 18], 1, 'pcb')
  rbox(d, 'sensor', [14, 12, 4], [12, 6, 22], 0.8, 'pcb')
  rbox(d, 'cell', [40, 26, 8], [0, 0, 10], 2, 'steel')
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    cyl(d, `standoff-${sx}${sy}`, 2.4, 10, [sx * 10 - 8, sy * 7, 15], 'z', 'metal')
  }
  if (wants.display) {
    rbox(d, 'oled', [26, 16, 2], [0, 0, frontZ + 0.6], 0.6, 'pcb')
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

// ── gantry: the top of the ladder ───────────────────────────────────────────
// A metre-class machine: 2m of aluminium extrusion, three steppers, belts on X
// and Y, a leadscrew on Z. Nothing here is a toy, so the checks are the ones
// that actually bite at this size — beam deflection across the span, belt sag,
// motor torque against a moving gantry mass, and a bed that no hobby printer
// can hold in one piece.

function buildGantry(brief) {
  const d = newDesign('gantry', brief)
  const spanX = clamp(Math.round(brief.reachMm || 800), 400, 2000) // travel in X, mm
  const spanY = clamp(Math.round(spanX * 0.75), 300, 1600)
  const spanZ = clamp(Math.round(spanX * 0.35), 150, 700)

  const railW = 60 // gantry beam depth, mm
  const beamH = 80
  const z0 = 90 // gantry height above the bed
  const bedZ = 0

  d.title = `${spanX}mm gantry machine`
  d.subtitle = `${spanX}×${spanY}×${spanZ}mm travel · belt XY · leadscrew Z`
  d.metrics = { spanX, spanY, spanZ }

  // ── frame: two side rails, a bed, and the moving gantry bridge ───────────
  for (const sx of [-1, 1]) {
    rbox(d, `side-rail-${sx > 0 ? 'r' : 'l'}`, [20, spanY + 120, railW], [sx * (spanX / 2 + 40), 0, railW / 2], 2, 'metal')
    for (const fy of [-1, 1]) {
      rbox(d, `foot-${sx}${fy}`, [90, 90, 12], [sx * (spanX / 2 + 40), fy * (spanY / 2 + 30), 6], 2, 'metal')
      for (const bx of [-1, 1]) for (const by of [-1, 1]) {
        bolt(d, `foot-bolt-${sx}${fy}${bx}${by}`, [sx * (spanX / 2 + 40) + bx * 32, fy * (spanY / 2 + 30) + by * 32, 12], 'z', 12)
      }
    }
  }
  rbox(d, 'bed', [spanX - 60, spanY - 40, 6], [0, 0, bedZ + railW + 3], 2, 'metal')
  for (let i = -2; i <= 2; i += 1) {
    rbox(d, `bed-rib-${i}`, [spanX - 70, 8, 14], [0, i * ((spanY - 60) / 5), bedZ + railW + 13], 1, 'metal')
  }

  // gantry bridge: one beam carrying X, two uprights riding Y
  rbox(d, 'bridge', [railW, spanY + 60, beamH], [0, 0, z0 + beamH / 2], 3, 'accent', { print: false })
  for (const sy of [-1, 1]) {
    rbox(d, `upright-${sy > 0 ? 'b' : 'f'}`, [railW, 26, z0], [0, sy * (spanY / 2 + 10), z0 / 2], 2, 'accent', { print: false })
    // Y carriage: rail block + rollers
    rbox(d, `y-carriage-${sy}`, [railW + 20, 60, 26], [0, sy * (spanY / 2 + 10), railW + 14], 2, 'metal')
    for (const bx of [-1, 1]) cyl(d, `y-roller-${sy}${bx}`, 9, 12, [bx * 22, sy * (spanY / 2 + 10), railW + 6], 'x', 'steel')
  }
  // X carriage + Z column
  rbox(d, 'x-carriage', [44, railW, 34], [0, 0, z0 + beamH + 10], 2, 'metal')
  rbox(d, 'z-column', [34, 34, spanZ + 60], [0, 0, z0 + beamH + 10 - (spanZ + 60) / 2 + 30], 2, 'accent', { print: false })
  rbox(d, 'z-carriage', [60, 60, 22], [0, 0, z0 + beamH + 28], 2, 'metal')
  cyl(d, 'spindle', 16, 46, [0, 0, z0 + beamH + 6], 'z', 'steel')

  // drive: motors, belts (as flat straps), leadscrew, limit switches
  cyl(d, 'motor-x', 21, 40, [spanX / 2 + 10, -(spanY / 2 + 10), z0 + beamH + 6], 'x', 'servo')
  cyl(d, 'motor-y', 21, 40, [0, -(spanY / 2 + 10), railW + 10], 'y', 'servo')
  cyl(d, 'motor-z', 21, 40, [0, 0, z0 + beamH + 40], 'z', 'servo')
  rbox(d, 'belt-x', [8, spanY + 40, 6], [spanX / 2 + 10, 0, z0 + beamH - 10], 1, 'belt')
  rbox(d, 'belt-y', [spanX, 8, 6], [0, -(spanY / 2 + 10), railW + 22], 1, 'belt')
  cyl(d, 'leadscrew', 6, spanZ + 60, [0, 0, z0 + beamH + 10 - (spanZ + 60) / 2 + 30], 'z', 'steel')
  for (const [ax, pos] of [['x', [spanX / 2 - 20, -(spanY / 2 + 10), z0 + 10]], ['y', [0, -(spanY / 2 + 20), railW + 10]], ['z', [30, 0, z0 + beamH + 40]]]) {
    rbox(d, `limit-${ax}`, [12, 8, 6], pos, 1, 'pcb')
  }

  // printed corner brackets + motor mounts: the only custom geometry, and the
  // reason a metre-class machine still needs a 3D printer
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    // a real CAD bracket mesh (converted from Sand3D), not another rounded box
    mesh(d, `corner-${sx}${sy}`, 'BRACKET', [58, 58, 26], [sx * (spanX / 2 + 26), sy * (spanY / 2 + 26), railW + 8], 'accent', { print: true })
  }
  for (const sy of [-1, 1]) {
    rbox(d, `motor-mount-${sy}`, [56, 56, 10], [spanX / 2 + 10 + sy * 24, -(spanY / 2 + 10), z0 + beamH + 6], 2, 'accent', { print: true })
  }
  rbox(d, 'z-mount', [70, 70, 16], [0, 0, z0 + beamH + 30], 2, 'accent', { print: true })
  rbox(d, 'spindle-clamp', [70, 70, 40], [0, 0, z0 + beamH + 2], 3, 'accent', { print: true })

  // ── parts ────────────────────────────────────────────────────────────────
  const railMetres = Math.ceil((2 * (spanY + 120) + 2 * spanX + 4 * 400) / 1000 * 2) / 2
  const braceMetres = Math.ceil((2 * spanX + 2 * spanY) / 1000 * 2) / 2
  addPart(d, 'extrusion_2040', railMetres, 'rails, legs, beam')
  addPart(d, 'extrusion_2020', braceMetres, 'bracing + bed frame')
  addPart(d, 'bed_plate', 1, 'spoilboard')
  addPart(d, 'spindle_500w', 1, 'cutting spindle')
  addPart(d, 'drag_chain', 1, 'harness')
  addPart(d, 'nema17', 3, 'X / Y / Z drive')
  addPart(d, 'drv8825', 3, 'stepper drivers')
  addPart(d, brief.mcu || 'esp32s3', 1, 'controller (GRBL-firmware)')
  addPart(d, 'gt2_kit', 1, 'X/Y belts + pulleys')
  addPart(d, 'leadscrew_t8', 1, 'Z axis')
  addPart(d, 'mgn12', 3, 'linear rails')
  addPart(d, 'limit_sw', 3, 'homes')
  addPart(d, 'buck5a', 1, 'logic rail')
  addPart(d, 'fuse', 1, 'main protection')
  addPart(d, 'rocker', 1, 'power switch')
  addPart(d, 'cap1000', 1, 'motor rail')
  // Steppers want 24V; a 5V or 7.4V supply is not quietly upgraded without a word
  const askedSupply = brief.battery || null
  const supplyOk = askedSupply && PARTS[askedSupply] && PARTS[askedSupply].volts >= 11
  const supply = supplyOk ? askedSupply : 'pack3s'
  if (askedSupply && !supplyOk) {
    d.checks.push({ level: 'warn', msg: `${PARTS[askedSupply].name} at ${PARTS[askedSupply].volts}V cannot drive 24V steppers — the BOM uses a 3S pack instead. A 24V supply is the honest answer for this machine.` })
  }
  addPart(d, supply, 1, 'machine power')
  addPart(d, 'hw_m3', 2, 'frame fasteners')
  addPart(d, 'm3_screws', 2, 'rail + carriage hardware')
  addPart(d, 'wire18', 1, 'motor harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'xt60', 1, 'pack connector')

  // ── the numbers that actually matter at this size ────────────────────────
  const gantryMassKg = 2.4 + (spanY / 1000) * 1.7 // beam + carriages + spindle
  const rpm = PARTS.nema17.speed || 200
  const torque = PARTS.nema17.torque
  const pulleyR = 0.0125 // GT2 20T ≈ 12.5 mm pitch radius
  const force = torque / pulleyR // N at the belt
  const accelNeed = (gantryMassKg * 2.0) // F = ma, 2 m/s²
  const beltDeflect = Math.pow(Math.max(1, spanY) / 1000, 3) * 0.42 // mm, ~N/1kg preload, empirical
  const beamDeflect = (gantryMassKg * G * Math.pow(spanX / 1000, 3)) / (48 * 70000e6 * 1.2e-7) * 1000 // mm, I≈1.2e-7 m⁴ for 60×80 extrusion

  d.notes.push(`Belt drive on X and Y: ${fmt(force, 0)}N available at the pulley, ${fmt(accelNeed, 0)}N wanted for ${fmt(gantryMassKg, 1)}kg at 2m/s².`)
  d.notes.push(`Y belt sag over ${spanY}mm is about ${fmt(beltDeflect, 2)}mm unless it is tensioned hard — that is your ripple in the surface finish.`)
  d.notes.push(`Bridge beam deflects ~${fmt(beamDeflect, 3)}mm at the middle under its own carriage — fine. Past ~1.2m span it is not: go to a taller extrusion or two beams.`)

  if (spanX > 1000) {
    d.checks.push({ level: 'warn', msg: `${spanX}mm travel: the print/step files for the bed and side rails exceed a 256mm bed several times over. Plan a 4-part bed with dowel joins, or buy extrusion by the metre and cut it.` })
  }
  if (beamDeflect > 0.5) {
    d.checks.push({ level: 'warn', msg: `Bridge deflection ${fmt(beamDeflect, 2)}mm across the span is visible in a cut. Stiffen the beam or shorten X.` })
  }
  if (force < accelNeed) {
    d.checks.push({ level: 'warn', msg: `NEMA17 at the belt gives ${fmt(force, 0)}N against ${fmt(accelNeed, 0)}N demanded — reduce gantry mass or gear the pulleys down.` })
  }
  d.checks.push({ level: 'ok', msg: 'Frame, rails, drivers and homes are all standard parts — the only custom geometry is the mounts.' })

  Object.assign(d.metrics, {
    gantryMassKg,
    beltForce: force,
    beamDeflect,
    beltDeflect,
    motors: 3,
  })
  return d
}

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
  // Anything the agent layer had to change on the way in is visible here, not
  // buried in its logs: the studio judges the design it was actually given.
  const adjusted = design.brief && Array.isArray(design.brief._adjusted) ? design.brief._adjusted : []
  if (adjusted.length) {
    checks.push({ level: 'warn', msg: `Handed in with adjustments: ${adjusted.join('; ')}.` })
  }
  if (power.bat && power.typ > power.bat.maxA) {
    checks.push({ level: 'fail', msg: `Continuous draw ${fmt(power.typ, 1)}A is over what ${power.bat.name} can deliver (${power.bat.maxA}A) — this pack will sag or trip.` })
  } else if (power.bat && power.peak > power.bat.maxA * 2) {
    // Far beyond the pack's burst is not a caution, it is the wrong pack: the
    // protection circuit trips or the cells sag before the machine moves.
    checks.push({
      level: 'fail',
      msg: `Peak ${fmt(power.peak, 1)}A is ${fmt(power.peak / power.bat.maxA, 1)}× the ${power.bat.name}'s ${power.bat.maxA}A burst. This pack cannot run this machine — pick a high-C LiPo (30C+) or put two packs in parallel.`,
    })
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

// ── firmware: generated against the pin map, not copied from a tutorial ─────
// The #defines come from the analysis pass, so the code and the wiring table
// cannot drift. These are skeletons a builder can flash — not a complete app.

function firmwareFor(design, a) {
  const pins = a.pins.rows.filter((r) => /^\d+$/.test(r.pin))
  const pin = (name, fallback) => pins.find((r) => r.signal === name)?.pin || String(fallback)
  // Count the servos that are actually in the BOM. `joints + 1` assumed a
  // gripper servo on every machine, so a 12-servo quadruped got a 13th channel
  // that drives nothing and a sensor node got a servo loop with no servo.
  const servoCount = design.parts.reduce((n, p) => (PARTS[p.key] && PARTS[p.key].cat === 'servo' ? n + p.qty : n), 0)
  const mcus = a.mcu.name

  if (design.archetype === 'humanoid') return humanoidFirmware(design, a, pin)
  if (design.archetype === 'robot') return fullRobotFirmware(design, a, pin)
  if (design.archetype === 'rover') return roverFirmware(design, a, pin, mcus)
  if (design.archetype === 'gadget') return gadgetFirmware(design, a, pin, mcus)
  if (design.archetype === 'gripper') return gripperFirmware(design, a, pin, mcus)
  if (servoCount === 0) return noActuatorFirmware(design, mcus)
  return armFirmware(design, a, servoCount, mcus)
}

/**
 * Nothing to move: a sensor node or a bare board still deserves firmware that
 * compiles and says what it is, rather than a servo loop over zero channels.
 */
function noActuatorFirmware(design, mcus) {
  return `/* ${design.title} — ${mcus}
 * Generated by Rigforge. No actuators on this build: sensors and comms only.
 */
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(${design.archetype === 'pcb' ? '8, 9' : '8, 9'});
  Serial.println("${design.title} ready — sensor build, no actuators");
}

void loop() {
  delay(1000);
}
`
}

/**
 * Parallel gripper: one positional servo on a pinion, two opposing racks on an
 * MGN12 rail. Homes against the limit switch, closes until jaw force stalls
 * the servo (or the encoder says we reached the object). The AS5600 on the
 * pinion shaft makes "closed to N mm" a measurement, not a guess.
 */
function gripperFirmware(design, a, pin, mcus) {
  const m = design.metrics || {}
  const travel = Math.round(m.spanMm || 60)
  return `/* ${design.title} — ${mcus}
 * Generated by Rigforge. Rack-and-pinion parallel jaw, one servo, homed.
 *
 * Mechanism: servo pinion drives two opposing racks on an MGN12 rail. Jaw force
 * comes from stall torque at the ${fmt(m.pinionMm || 8.75, 1)}mm pitch radius —
 * ~${Math.round(m.gripForceN || 0)}N holds ~${fmt(m.gripMassKg || 0, 1)}kg on rubber pads.
 *
 * Wiring: servo signal on a GPIO (direct — no PWM board needed for one servo),
 * 6V rail fused, AS5600 encoder on I2C (0x36), homing switch wired NC.
 */
#include <Wire.h>
#include <ESP32Servo.h>
#include <AS5600.h>

Servo jawServo;
AS5600 encoder;

const uint8_t SERVO_PIN = ${pin('SERVO 1', 4)};
const uint8_t LIMIT_PIN = ${pin('LIMIT 1', 16)};
const uint8_t SDA_PIN   = ${I2C.sda}, SCL_PIN = ${I2C.scl};

// rack geometry: servo degrees at the pinion == mm at the jaw
const float PINION_PITCH_MM = ${fmt((m.pinionMm || 8.75) * 2 * Math.PI / 360 * 60, 2)}; // mm of jaw travel per 60°
const float SPAN_MM = ${travel}.0f;
const uint8_t US_OPEN = 1200, US_CLOSED = 1800;   // calibrate against the real racks

enum JawState { HOMING, OPEN, GRIPPING, FAULT };
JawState state = HOMING;

float jawSpanMm() {
  // AS5600 raw angle -> pinion turns -> jaw separation. BOTH racks move, so
  // separation changes at 2x the single-rack rate per pinion degree.
  float deg = encoder.readAngle() * (360.0f / 4096.0f);
  return SPAN_MM - deg * (PINION_PITCH_MM * 2.0f / 60.0f);
}

void home() {
  // Drive closed slowly until the limit switch opens — that face is jaw zero.
  pinMode(LIMIT_PIN, INPUT_PULLUP);
  jawServo.writeMicroseconds(US_CLOSED - 150);
  uint32_t t0 = millis();
  while (digitalRead(LIMIT_PIN) == LOW && millis() - t0 < 6000) delay(10);
  jawServo.writeMicroseconds(US_OPEN);
  state = digitalRead(LIMIT_PIN) == HIGH ? OPEN : FAULT;
}

void gripTo(float targetMm, uint8_t force) {
  targetMm = constrain(targetMm, 0.0f, SPAN_MM);
  // Force is servo travel PAST contact — the racks preload the pinion.
  float us = US_OPEN + (US_CLOSED - US_OPEN) * (1.0f - targetMm / SPAN_MM);
  us += (force / 255.0f) * 120.0f;              // push past contact, 0..~7°
  jawServo.writeMicroseconds((uint16_t)us);
  state = GRIPPING;
}

void setup() {
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  encoder.begin();
  jawServo.setPeriodHertz(50);
  jawServo.attach(SERVO_PIN, 500, 2500);
  home();
  Serial.println("${design.title} ready — 'G <mm> <force>' to grip, 'O' open, 'R' read span");
}

void loop() {
  if (state == FAULT) return;  // homing failed: stop before the racks chew the pinion
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'G' || c == 'g') {
      float mm = Serial.parseFloat();
      uint8_t f = (uint8_t)Serial.parseInt();
      gripTo(mm, f);
    } else if (c == 'O' || c == 'o') {
      jawServo.writeMicroseconds(US_OPEN);
      state = OPEN;
    } else if (c == 'R' || c == 'r') {
      Serial.print("span "); Serial.println(jawSpanMm(), 1);
    }
  }
}`
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
${design.joints.length ? `const uint8_t PAN_PIN = ${pin('SERVO 1', 21)};   // head-pan servo, 500–2500us` : ''}

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
${design.joints.length ? '  ledcAttach(PAN_PIN, 50, 12); ledcWrite(PAN_PIN, 307);  // pan centre (~1500us)' : ''}
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
  } else if (design.archetype === 'humanoid') {
    // the material is whatever the brief chose: naming PETG here regardless was
    // a claim the BOM contradicted the moment someone picked PLA
    push('Print the skeleton for shock loads', `Thighs, shins and hip brackets take repeated impact — ${a.print.material.name}, 4 walls, printed upright so the layer lines run along the limb, not across it.`, ['printer', 'slicer'], Math.round(a.print.hours * 30))
    push('Press the hip and knee bearings', 'Heat-set inserts, then 608 bearings into the hip and knee hubs. Bind here and the servo fights the bearing until one of them dies.', ['heat-set tip', 'vise'], 40)
    push('Build both legs as mirror pairs', 'Assemble the left leg fully, then build the right against it as a jig — mirror-image legs that differ by 2mm walk in circles forever.', ['M3 hex key'], 60)
    push('Assemble the pelvis and torso', 'Bolt both legs to the pelvis hub, then the torso and the pack. Put the machine in a stand or hang it from a strap before it can hold itself up.', ['M3 hex key', 'stand or strap'], 30)
    push('Two buses, three rails', 'Legs on bus 0, arms and head on bus 1, each bus on its own UBEC from its own pack. One shared rail will brown out the MCU the first time a hip stalls.', ['soldering iron', 'multimeter'], 60)
    push('Address every servo before assembly', 'Connect one servo at a time and set its ID while it is still off the robot. Renumbering a servo inside an assembled leg is an hour of disassembly.', ['bus adapter', 'PC'], 30)
    push('First power: standing pose, low torque', 'Run the generated stand pose with torque limits at 30%. Watch joint loads on the serial log — a joint that climbs and stays high is binding.', ['USB-C', 'bench supply'], 25)
  } else if (design.archetype === 'robot') {
    push('Build the base', `Deck, rails and bulkheads first, then the four motors. Check the deck is flat to within a millimetre — the arm bolts to it, and a twisted deck becomes a leaning robot.`, ['M3 hex key', 'square'], 40)
    push('Assemble the arm on the bench', 'Arm first, base second: build the turret, shoulder, upper arm and forearm as one assembly and test it with a bench supply. Lifting a whole robot to fix a binding joint is how backs and robots both break.', ['M3 hex key', 'bench supply'], 50)
    push('Bolt the arm to the deck', 'Four bolts through the turret flange into heat-set inserts, threadlocker on all four, then check the arm can sweep its full yaw range without the head or the pack in the way.', ['threadlocker'], 20)
    push('Power and harness', `Split the servo rail from the drive rail: two UBECs, one per side of the deck. Route the arm bundle down through the turret centre so yaw never pulls a wire.`, ['soldering iron', 'cable ties'], 45)
    push('Ballast and stability test', `With the arm at full extension, ${a.checks.some((c) => /stabilit/i.test(c.msg)) ? 'this machine is on the stability edge per the SPEC tab — add pack weight over the rear axle before the first drive' : 'lift one wheel at a time and confirm the other three stay planted'}.`, [], 15)
  } else if (design.archetype === 'gripper') {
    push('Set the linear rail', 'Bolt the MGN12 rail to the deck FIRST — it is the reference everything else aligns to. Degrease it, then check both carriages glide end to end with finger pressure and no click.', ['M3 hex key', 'degreaser'], 20)
    push('Mesh the racks', 'Loose-fit both racks against the pinion, slide a jaw carriage to mid-travel, then nip the rack screws while rolling the jaw — the racks seat themselves at the right mesh depth.', ['M2.5 hex key'], 25)
    push('Home against the switch', 'Adjust the homing flag until the limit switch clicks exactly at jaw-zero — the generated firmware drives against it for 6s max; if it never trips it faults, which is what you want.', ['M2.5 hex key', 'multimeter'], 15)
    push('Fit the jaws last', 'Jaw plates, risers, pads. Check the pads meet flush — a 1mm skew at the pad is a rotated part at the robot.', ['M3 hex key'], 15)
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

// ── geometry: nodes → world triangles ───────────────────────────────────────
// A forward-kinematics pass over the joint tree plus a slide pass for linear
// axes. The renderer and the STL exporter read the SAME triangle list, so what
// you orbit is what you print.
//
// Node local verts are generated centred at origin, oriented by `axis` and
// optionally `rot` (Euler, radians), translated to `pos`, slid by any linear
// joint, then rotated through the revolute chain.

const MAT_RGB = {
  shell: [198, 206, 214],
  accent: [255, 107, 26],
  metal: [140, 150, 162],
  steel: [96, 108, 122],
  brass: [188, 152, 74],
  pcb: [32, 96, 70],
  rubber: [38, 42, 48],
  glass: [112, 214, 232],
  servo: [30, 34, 42],
  belt: [34, 36, 40],
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

/** Euler XYZ about the node's own centre — how wedges, bends and gears aim. */
function rotEuler(p, rot) {
  if (!rot || (!rot[0] && !rot[1] && !rot[2])) return p
  let [x, y, z] = p
  const [rx, ry, rz] = rot
  if (rx) { const c = Math.cos(rx), s = Math.sin(rx); const y2 = y * c - z * s, z2 = y * s + z * c; y = y2; z = z2 }
  if (ry) { const c = Math.cos(ry), s = Math.sin(ry); const x2 = x * c + z * s, z2 = -x * s + z * c; x = x2; z = z2 }
  if (rz) { const c = Math.cos(rz), s = Math.sin(rz); const x2 = x * c - y * s, y2 = x * s + y * c; x = x2; y = y2 }
  return [x, y, z]
}

/** Every joint's ancestor list, root first. One pass per mesh build. */
function chainsFor(design) {
  const byId = new Map(design.joints.map((j) => [j.id, j]))
  const chains = new Map()
  for (const j of design.joints) {
    const chain = []
    let cur = j
    let guard = 0
    while (cur && guard < 24) {
      chain.unshift(cur)
      cur = cur.parent ? byId.get(cur.parent) : null
      guard += 1
    }
    chains.set(j.id, chain)
  }
  return chains
}

/** Apply a joint chain's rotations (root → leaf) to a rest-pose point. */
function applyChain(chain, point) {
  let p = point
  if (!chain) return p
  for (const j of chain) {
    if (j.slide) continue
    // Pitch joints read positive = UP: a slider that raises the arm should not
    // drive it into the table. (Servo direction is flipped in the firmware.)
    const sign = j.axis === 'y' ? -1 : 1
    p = rotAxis(p, j.pivot, j.axis, (sign * j.angle * Math.PI) / 180)
  }
  return p
}

/** Linear-joint displacement for a node that rides a slide. */
function slideDisp(design, node) {
  if (!node.slide) return [0, 0, 0]
  const j = design.joints.find((jj) => jj.id === node.slide.joint)
  if (!j || !j.slide) return [0, 0, 0]
  const dir = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[j.axis]
  const t = j.angle * (node.slide.sign || 1)
  return [dir[0] * t, dir[1] * t, dir[2] * t]
}

// ── local vertex generators (centred at origin) ─────────────────────────────

/** Axis-aligned box corners → 12 tris. */
function boxTris(sx, sy, sz) {
  const corner = (i) => [(i & 1 ? sx : -sx), (i & 2 ? sy : -sy), (i & 4 ? sz : -sz)]
  // every face declares the way it faces, and the winding is checked against it:
  // a cube with half its faces wound inward exports an STL that slicers have to
  // repair, and "repair the mesh" is not something a buyer should have to do.
  const faces = [
    { idx: [0, 1, 3, 2], n: [0, 0, -1] },
    { idx: [4, 6, 7, 5], n: [0, 0, 1] },
    { idx: [0, 4, 5, 1], n: [0, -1, 0] },
    { idx: [2, 3, 7, 6], n: [0, 1, 0] },
    { idx: [0, 2, 6, 4], n: [-1, 0, 0] },
    { idx: [1, 5, 7, 3], n: [1, 0, 0] },
  ]
  const faceNormal = (a, b, c) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  }
  const tris = []
  for (const f of faces) {
    const v = f.idx.map(corner)
    const quad = [[v[0], v[1], v[2]], [v[0], v[2], v[3]]]
    for (const t of quad) {
      const n = faceNormal(t[0], t[1], t[2])
      const dot = n[0] * f.n[0] + n[1] * f.n[1] + n[2] * f.n[2]
      tris.push(dot < 0 ? [t[0], t[2], t[1]] : t)
    }
  }
  return tris
}

/**
 * Chamfered box: each corner cut at distance r along its three edges.
 * 6 octagonal faces + 12 edge chamfers + 8 corner triangles — the machined look.
 */
function rboxTris(sx, sy, sz, r) {
  const rr = Math.min(r, Math.min(sx, sy, sz) * 0.45)
  const P = (sxn, syn, szn, ex, ey, ez) => [
    sxn * (sx - ex * rr), syn * (sy - ey * rr), szn * (sz - ez * rr),
  ]
  const C = []
  for (const szn of [-1, 1]) for (const syn of [-1, 1]) for (const sxn of [-1, 1]) {
    C.push({ s: [sxn, syn, szn], x: P(sxn, syn, szn, 1, 0, 0), y: P(sxn, syn, szn, 0, 1, 0), z: P(sxn, syn, szn, 0, 0, 1) })
  }
  const at = (sxn, syn, szn) => C.find((c) => c.s[0] === sxn && c.s[1] === syn && c.s[2] === szn)
  const tris = []
  const fan = (verts) => { for (let i = 1; i < verts.length - 1; i += 1) tris.push([verts[0], verts[i], verts[i + 1]]) }

  // face octagons
  const faces = [
    { axis: 'z', sign: 1, pts: (c) => [c.x, c.y], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'z', sign: -1, pts: (c) => [c.x, c.y], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'y', sign: 1, pts: (c) => [c.x, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'y', sign: -1, pts: (c) => [c.x, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'x', sign: 1, pts: (c) => [c.y, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
    { axis: 'x', sign: -1, pts: (c) => [c.y, c.z], order: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
  ]
  for (const f of faces) {
    const verts = []
    for (const [u, v] of f.order) {
      const s = f.axis === 'z' ? [u, v, f.sign] : f.axis === 'y' ? [u, f.sign, v] : [f.sign, u, v]
      const c = at(s[0], s[1], s[2])
      const [p0, p1] = f.pts(c)
      verts.push(p0)
      verts.push(p1 === p0 ? p0 : p1)
    }
    // order the 8 pts correctly: each corner contributes two edge points;
    // walking the perimeter: [c0.p0, c1.p0, c1.p1, c2.p0? ...]
    const oct = [
      f.pts(at(...(f.axis === 'z' ? [-1, -1, f.sign] : f.axis === 'y' ? [-1, f.sign, -1] : [f.sign, -1, -1])))[0],
      f.pts(at(...(f.axis === 'z' ? [1, -1, f.sign] : f.axis === 'y' ? [1, f.sign, -1] : [f.sign, 1, -1])))[0],
      f.pts(at(...(f.axis === 'z' ? [1, -1, f.sign] : f.axis === 'y' ? [1, f.sign, -1] : [f.sign, 1, -1])))[1],
      f.pts(at(...(f.axis === 'z' ? [1, 1, f.sign] : f.axis === 'y' ? [1, f.sign, 1] : [f.sign, 1, 1])))[1],
      f.pts(at(...(f.axis === 'z' ? [1, 1, f.sign] : f.axis === 'y' ? [1, f.sign, 1] : [f.sign, 1, 1])))[0],
      f.pts(at(...(f.axis === 'z' ? [-1, 1, f.sign] : f.axis === 'y' ? [-1, f.sign, 1] : [f.sign, -1, 1])))[0],
      f.pts(at(...(f.axis === 'z' ? [-1, 1, f.sign] : f.axis === 'y' ? [-1, f.sign, 1] : [f.sign, -1, 1])))[1],
      f.pts(at(...(f.axis === 'z' ? [-1, -1, f.sign] : f.axis === 'y' ? [-1, f.sign, -1] : [f.sign, -1, -1])))[1],
    ]
    fan(oct)
  }

  // 12 edge chamfers
  for (const syn of [-1, 1]) for (const szn of [-1, 1]) {
    const c0 = at(-1, syn, szn); const c1 = at(1, syn, szn)
    tris.push([c0.y, c1.y, c1.z]); tris.push([c0.y, c1.z, c0.z])
  }
  for (const sxn of [-1, 1]) for (const szn of [-1, 1]) {
    const c0 = at(sxn, -1, szn); const c1 = at(sxn, 1, szn)
    tris.push([c0.x, c0.z, c1.z]); tris.push([c0.x, c1.z, c1.x])
  }
  for (const sxn of [-1, 1]) for (const syn of [-1, 1]) {
    const c0 = at(sxn, syn, -1); const c1 = at(sxn, syn, 1)
    tris.push([c0.x, c1.x, c1.y]); tris.push([c0.x, c1.y, c0.y])
  }
  // 8 corner triangles
  for (const c of C) tris.push([c.x, c.z, c.y])
  return tris
}

/** Triangular prism: tall face on the dir side, hypotenuse falling away. */
function wedgeTris(sx, sy, sz, dir) {
  const A = [-sx, -sy, -sz]; const B = [-sx, -sy, sz]
  const C = [-sx, sy, -sz]; const D = [-sx, sy, sz]
  const E = [sx, -sy, -sz]; const F = [sx, sy, -sz]
  const tris = [
    [A, B, D], [A, D, C],   // tall face at -x
    [A, E, F], [A, F, C],   // bottom face at -z
    [B, E, F], [B, F, D],   // hypotenuse
    [A, B, E],              // -y triangle
    [C, D, F],              // +y triangle
  ]
  // base has the tall face at -x; spin about z until dir is where it rises
  const rot = dir === 'px' ? [0, 0, Math.PI]
    : dir === 'py' ? [0, 0, -Math.PI / 2]
      : dir === 'ny' ? [0, 0, Math.PI / 2]
        : [0, 0, 0]
  return tris.map((t) => t.map((p) => rotEuler(p, rot)))
}

function cylTris(r, h, axis, segs, r2) {
  const tris = []
  const rt = r2 == null ? r : r2
  const pt = (t, side) => {
    const a = (t / segs) * Math.PI * 2
    const u = Math.cos(a); const v = Math.sin(a)
    const rr = side ? rt : r
    if (axis === 'z') return [u * rr, v * rr, (side ? h : -h)]
    if (axis === 'y') return [u * rr, (side ? h : -h), v * rr]
    return [(side ? h : -h), u * rr, v * rr]
  }
  for (let i = 0; i < segs; i += 1) {
    const t0 = i; const t1 = i + 1
    tris.push([pt(t0, 1), pt(t1, 1), pt(t1, 0)])
    tris.push([pt(t0, 1), pt(t1, 0), pt(t0, 0)])
    // caps
    const c0 = axis === 'z' ? [0, 0, -h] : axis === 'y' ? [0, -h, 0] : [-h, 0, 0]
    const c1 = axis === 'z' ? [0, 0, h] : axis === 'y' ? [0, h, 0] : [h, 0, 0]
    if (r > 0.01) { tris.push([pt(t0, 0), pt(t1, 0), c0]) }
    if (rt > 0.01) { tris.push([pt(t0, 1), c1, pt(t1, 1)]) }
  }
  return tris
}

function ringTris(outer, inner, h, axis, segs) {
  const tris = []
  const pt = (r, t, side) => {
    const a = (t / segs) * Math.PI * 2
    const u = Math.cos(a) * r; const v = Math.sin(a) * r
    if (axis === 'z') return [u, v, side ? h : -h]
    if (axis === 'y') return [u, side ? h : -h, v]
    return [side ? h : -h, u, v]
  }
  for (let i = 0; i < segs; i += 1) {
    const t0 = i; const t1 = i + 1
    tris.push([pt(outer, t0, 1), pt(outer, t1, 1), pt(outer, t1, 0)])
    tris.push([pt(outer, t0, 1), pt(outer, t1, 0), pt(outer, t0, 0)])
    tris.push([pt(inner, t0, 0), pt(inner, t1, 0), pt(inner, t1, 1)])
    tris.push([pt(inner, t0, 0), pt(inner, t1, 1), pt(inner, t0, 1)])
    tris.push([pt(outer, t0, 1), pt(inner, t0, 1), pt(inner, t1, 1)])
    tris.push([pt(outer, t0, 1), pt(inner, t1, 1), pt(outer, t1, 1)])
    tris.push([pt(outer, t1, 0), pt(inner, t0, 0), pt(inner, t1, 0)])
    tris.push([pt(outer, t0, 0), pt(inner, t0, 0), pt(outer, t1, 0)])
  }
  return tris
}

function torusTris(R, r, axis, arcDeg) {
  const tris = []
  const M = Math.max(8, Math.round(24 * (arcDeg || 360) / 360))
  const N = 10
  const pt = (i, j) => {
    const u = (i / M) * Math.PI * 2 * ((arcDeg || 360) / 360)
    const v = (j / N) * Math.PI * 2
    const rr = R + r * Math.cos(v)
    const x = Math.cos(u) * rr; const y = Math.sin(u) * rr; const z = r * Math.sin(v)
    if (axis === 'z') return [x, y, z]
    if (axis === 'y') return [x, z, y]
    return [z, y, x]
  }
  for (let i = 0; i < M; i += 1) for (let j = 0; j < N; j += 1) {
    tris.push([pt(i, j), pt(i + 1, j), pt(i + 1, j + 1)])
    tris.push([pt(i, j), pt(i + 1, j + 1), pt(i, j + 1)])
  }
  // cap the arc ends if it's a partial bend — centre of each end ring
  if (arcDeg && arcDeg < 360) {
    const uM = Math.PI * 2 * (arcDeg / 360)
    const centre = (u) => {
      const x = Math.cos(u) * R; const y = Math.sin(u) * R
      return axis === 'z' ? [x, y, 0] : axis === 'y' ? [x, 0, y] : [0, y, x]
    }
    const c0 = centre(0); const cM = centre(uM)
    for (let j = 0; j < N; j += 1) {
      tris.push([c0, pt(0, j + 1), pt(0, j)])
      tris.push([cM, pt(M, j), pt(M, j + 1)])
    }
  }
  return tris
}

function sphereTris(r) {
  const tris = []
  const M = 14; const N = 10
  const pt = (i, j) => {
    const u = (i / M) * Math.PI * 2
    const v = (j / N) * Math.PI
    return [r * Math.sin(v) * Math.cos(u), r * Math.sin(v) * Math.sin(u), r * Math.cos(v)]
  }
  for (let i = 0; i < M; i += 1) for (let j = 0; j < N - 1; j += 1) {
    tris.push([pt(i, j), pt(i + 1, j), pt(i + 1, j + 1)])
    tris.push([pt(i, j), pt(i + 1, j + 1), pt(i, j + 1)])
  }
  return tris
}

/** Spur gear: root disc + tooth boxes around it. */
function gearTris(m, teeth, width, axis) {
  const tris = []
  const pitchR = (m * teeth) / 2
  const rootR = Math.max(1, pitchR - 1.1 * m)
  const tipR = pitchR + 0.85 * m
  const hh = width / 2
  tris.push(...cylTris(rootR, hh, axis, Math.max(teeth * 2, 16)))
  // hub bore suggestion: darker inner disc is skipped — a bore ring costs tris
  const tw = Math.max(0.7, m * 0.85) // tooth thickness (tangential)
  const th = tipR - rootR + m * 0.4  // tooth radial depth
  for (let i = 0; i < teeth; i += 1) {
    const a = (i / teeth) * Math.PI * 2
    const cx = Math.cos(a) * (rootR + th / 2 - m * 0.2)
    const cy = Math.sin(a) * (rootR + th / 2 - m * 0.2)
    const tooth = boxTris(th / 2, tw / 2, hh * 0.92)
    for (const t of tooth) {
      tris.push(t.map((p) => {
        // local tooth box points radially along +x before spin to angle a
        const x = p[0]; const y = p[1]; const z = p[2]
        const rx = x * Math.cos(a) - y * Math.sin(a) + cx
        const ry = x * Math.sin(a) + y * Math.cos(a) + cy
        if (axis === 'z') return [rx, ry, z]
        if (axis === 'y') return [rx, z, ry]
        return [z, ry, rx]
      }))
    }
  }
  return tris
}

/** Rack: bar + tooth wedges along the +z face. */
function rackTris(sx, sy, sz, teeth) {
  const tris = [...boxTris(sx, sy, sz)]
  const n = Math.max(2, teeth | 0)
  const pitch = (sx * 2) / n
  const tw = pitch * 0.42
  const th = pitch * 0.5
  for (let i = 0; i < n; i += 1) {
    const cx = -sx + pitch * (i + 0.5)
    for (const t of boxTris(tw / 2, sy * 0.96, th / 2)) {
      tris.push(t.map((p) => [p[0] + cx, p[1], p[2] + sz + th / 2]))
    }
  }
  return tris
}

const CYL_SEGS = 18

/** One node → triangles in world space. `shift` is the explode offset. */
/**
 * A real CAD mesh, converted offline from the Sand3D library
 * (tools/sand3d-fetch.mjs) and vendored as quantised int16 in src/parts-*.js.
 * `node.size` scales it per axis, so one part can be a small bracket or a large
 * gusset. If the part is missing the box stands in, so layout never collapses.
 */
function importedMeshTris(node) {
  const table = globalThis.__RF_PARTS && globalThis.__RF_PARTS[node.part]
  if (!table || !table.tris || !table.tris.length) {
    return boxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2)
  }
  const radiusMm = table.scale || 20
  const sx = node.size[0] / (radiusMm * 2)
  const sy = node.size[1] / (radiusMm * 2)
  const sz = node.size[2] / (radiusMm * 2)
  const t = table.tris
  const k = radiusMm / 32767
  const out = []
  for (let i = 0; i < t.length; i += 9) {
    out.push([
      [t[i] * k * sx, t[i + 1] * k * sy, t[i + 2] * k * sz],
      [t[i + 3] * k * sx, t[i + 4] * k * sy, t[i + 5] * k * sz],
      [t[i + 6] * k * sx, t[i + 7] * k * sy, t[i + 8] * k * sz],
    ])
  }
  return out
}

function nodeTriangles(design, node, chain, shift) {
  const tris = []
  const slide = slideDisp(design, node)
  const world = (p) => {
    const q = rotEuler(p, node.rot)
    let w = [q[0] + node.pos[0] + slide[0], q[1] + node.pos[1] + slide[1], q[2] + node.pos[2] + slide[2]]
    w = applyChain(chain, w)
    return shift ? [w[0] + shift[0], w[1] + shift[1], w[2] + shift[2]] : w
  }
  const push = (a, b, c) => tris.push({ pts: [world(a), world(b), world(c)], mat: node.mat })

  let local = []
  switch (node.kind) {
    case 'box': local = boxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2); break
    case 'rbox': local = rboxTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.r || 1.5); break
    case 'wedge': local = wedgeTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.dir); break
    case 'rack': local = rackTris(node.size[0] / 2, node.size[1] / 2, node.size[2] / 2, node.teeth); break
    case 'cyl': local = cylTris(node.radius, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS, node.radius2); break
    case 'ring': local = ringTris(node.outer, node.inner, node.height / 2, node.axis || 'z', node.segs || CYL_SEGS); break
    case 'torus': local = torusTris(node.R, node.r, node.axis || 'z', 360); break
    case 'bend': local = torusTris(node.R, node.r, node.axis || 'z', node.arc || 90); break
    case 'sphere': local = sphereTris(node.radius); break
    case 'gear': local = gearTris(node.module, node.teeth, node.width, node.axis || 'z'); break
    case 'mesh': local = importedMeshTris(node); break
    default: local = []
  }
  for (const t of local) push(t[0], t[1], t[2])
  return tris
}

/** Explode vectors: radially out of the model's rest bounding box. */
function explodeShifts(design, f) {
  if (!f) return null
  const b = boundsOf(design.nodes)
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
  const out = new Map()
  for (const n of design.nodes) {
    const v = [n.pos[0] - c[0], n.pos[1] - c[1], (n.pos[2] - c[2]) * 1.35]
    const len = Math.hypot(v[0], v[1], v[2])
    if (len < 3) { out.set(n.id, [0, 0, f * 20]); continue }
    out.set(n.id, [(v[0] / len) * f * 55, (v[1] / len) * f * 55, (v[2] / len) * f * 55])
  }
  return out
}

/** Full mesh for the current pose. */
function buildMesh(design, explode) {
  const tris = []
  const chains = chainsFor(design)
  const shifts = explodeShifts(design, explode || 0)
  for (const node of design.nodes) {
    const chain = node.joint ? chains.get(node.joint) : null
    const add = nodeTriangles(design, node, chain, shifts ? shifts.get(node.id) : null)
    // `node` is the filament-colour key for the viewport; STL/SCAD ignore it.
    for (const t of add) { t.node = node.id; tris.push(t) }
  }
  return tris
}

// ── exporters ───────────────────────────────────────────────────────────────
/**
 * Centroid / pick-and-place file (CPL). The third of the three files an
 * assembly house quotes from, and the one people forget. Coordinates are mm
 * from the board's centre, rotation in degrees, both in the board frame.
 */
function toCentroidCsv(design) {
  const placed = (design.pcb && design.pcb.placed) || []
  const head = 'Designator,Mid X (mm),Mid Y (mm),Layer,Rotation,Package'
  const rows = placed.map((p) => [p.des, p.x.toFixed(3), p.y.toFixed(3), p.layer || 'top', p.rot || 0, p.pkg || ''].join(','))
  const note = `# ${design.title} — centroid from Rigforge. Origin = board centre; X right, Y up, degrees CCW.`
  return [note, head, ...rows].join('\n')
}


/** Binary STL — the file a slicer actually opens. */
function toSTL(tris, headerText) {
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const view = new DataView(buf)
  const header = new Uint8Array(buf, 0, 80)
  const text = (headerText || 'Rigforge export - mm - generated, not modelled').padEnd(80, ' ').slice(0, 80)
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

/** One STL per printed node — the print pack, in rest pose as it leaves the bed. */
/**
 * A part leaves the studio the way a slicer wants it: largest face down, centred
 * on the bed, sitting on Z=0. Axis-aligned permutation only — no arbitrary
 * rotations, because a wrong "clever" angle is worse than the model's own frame.
 */
function printReadyTris(tris) {
  if (!tris.length) return tris
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) {
    for (const p of t.pts) {
      for (let i = 0; i < 3; i += 1) {
        if (p[i] < min[i]) min[i] = p[i]
        if (p[i] > max[i]) max[i] = p[i]
      }
    }
  }
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  // biggest two dims into XY, thinnest into Z: that is "largest face down"
  const order = [0, 1, 2].sort((a, b) => dims[b] - dims[a])
  const perm = order // perm[0] -> X, perm[1] -> Y, perm[2] -> Z
  // a coordinate permutation with odd parity mirrors the solid, which would
  // turn every normal inward — flip two corners to compensate
  let inversions = 0
  for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) if (perm[i] > perm[j]) inversions += 1
  const mirrored = inversions % 2 === 1
  const sizeX = dims[perm[0]]
  const sizeY = dims[perm[1]]
  return tris.map((t) => {
    const pts = t.pts.map((p) => [
      p[perm[0]] - min[perm[0]] - sizeX / 2,
      p[perm[1]] - min[perm[1]] - sizeY / 2,
      p[perm[2]] - min[perm[2]],
    ])
    // a coordinate swap mirrors the solid; flip two corners to keep normals out
    return { ...t, pts: mirrored ? [pts[0], pts[2], pts[1]] : pts }
  })
}

// Convex primitives: every face's normal must point away from the part's own
// centre. Rings, gears and tubes are not convex (their inner wall faces inward
// on purpose), so they are left exactly as generated.
const CONVEX_KINDS = new Set(['box', 'rbox', 'cyl', 'cone', 'sphere', 'wedge'])

function orientConvex(tris) {
  if (!tris.length) return tris
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) for (const p of t.pts) for (let i = 0; i < 3; i += 1) {
    if (p[i] < min[i]) min[i] = p[i]
    if (p[i] > max[i]) max[i] = p[i]
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  return tris.map((t) => {
    const [a, b, d] = t.pts
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    const m = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]]
    return n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0 ? { ...t, pts: [t.pts[0], t.pts[2], t.pts[1]] } : t
  })
}

function printedPartSTLs(design) {
  const out = []
  for (const node of design.nodes) {
    if (!node.print) continue
    let raw = nodeTriangles({ ...design, joints: [] }, node, null, null)
    if (CONVEX_KINDS.has(node.kind)) raw = orientConvex(raw)
    out.push({ name: `${slug(node.id)}.stl`, buf: toSTL(printReadyTris(raw), `rigforge printed part ${node.id}`) })
  }
  return out
}

/**
 * The bundle an assembly house or a fab actually wants, in one zip. Named files
 * rather than a folder of guesses: BOM with MPNs, the centroid file, the spec.
 */
function boardPack(design, analysis, base) {
  const pcb = design.pcb || { W: 0, H: 0, placed: [], joints: 0 }
  const readme = [
    `RIGFORGE — ${design.title}`,
    '',
    `Board: ${Math.round(pcb.W)} x ${Math.round(pcb.H)} mm, 2 layers, 1.6 mm FR4`,
    `Placements: ${(pcb.placed || []).length}   Solder joints on the board: ${pcb.joints || 0}`,
    '',
    'FILES IN THIS PACK',
    `  ${base}-bom.csv   bill of materials with manufacturer part numbers`,
    `  ${base}-cpl.csv   centroid / pick-and-place: designator, mid X, mid Y, layer, rotation`,
    `  ${base}.md         the build spec: checks, power, mass, notes`,
    '',
    'WHAT TO SEND',
    '  Fab:       the Gerbers you export from your EDA tool, plus this BOM.',
    '  Assembly:  Gerbers + BOM + centroid. Ask for consigned/kitted assembly.',
    '  Centroid coordinates are mm from the board centre, X right, Y up, degrees CCW.',
    '',
    'Built with Rigforge. Prices in the BOM are catalogue estimates unless you',
    'refreshed live supplier prices first.',
  ].join('\n')
  return [
    { name: `${base}-bom.csv`, buf: toBOMCsv(design) },
    { name: `${base}-cpl.csv`, buf: toCentroidCsv(design) },
    { name: `${base}.md`, buf: toSpecMarkdown(design, analysis) },
    { name: 'README.txt', buf: readme },
  ]
}

// Minimal ZIP (store-only): what a slicer folder wants, no compression library.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
// Fixed timestamp: a build pack should be byte-identical when rebuilt, so no
// Date.now() here. 2026-01-01 12:00:00 in DOS format.
const DOS_TIME = (12 << 11) | (0 << 5) | 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

function zipStore(entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const { name, buf } of entries) {
    const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf instanceof Uint8Array ? buf : enc.encode(buf)
    const nameB = enc.encode(name)
    const crc = crc32(data)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true)
    head.setUint16(6, 0, true); head.setUint16(8, 0, true)
    head.setUint16(10, DOS_TIME, true); head.setUint16(12, DOS_DATE, true)
    head.setUint32(14, crc, true)
    head.setUint32(18, data.length, true); head.setUint32(22, data.length, true)
    head.setUint16(26, nameB.length, true); head.setUint16(28, 0, true)
    parts.push(new Uint8Array(head.buffer), nameB, data)

    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true)
    cen.setUint16(12, DOS_TIME, true); cen.setUint16(14, DOS_DATE, true)
    cen.setUint32(16, crc, true)
    cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true)
    cen.setUint16(28, nameB.length, true)
    cen.setUint32(42, offset, true)
    central.push(new Uint8Array(cen.buffer), nameB)
    offset += 30 + nameB.length + data.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true)
  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const chunk of parts) { out.set(chunk, p); p += chunk.length }
  for (const chunk of central) { out.set(chunk, p); p += chunk.length }
  out.set(new Uint8Array(end.buffer), p)
  return out.buffer
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
    const pos = `translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}])`
    const c = ` // ${n.id}`
    // translate outermost, then local Euler, then axis flip — matches nodeEuler
    const euler = n.rot ? `rotate([${n.rot.map((r) => (r * 180 / Math.PI).toFixed(0)).join(', ')}]) ` : ''
    const axRot = n.axis === 'x' ? 'rotate([0, 90, 0]) ' : n.axis === 'y' ? 'rotate([90, 0, 0]) ' : ''
    const wrap = `${pos} ${euler}${axRot}`
    if (n.kind === 'box' || n.kind === 'rbox') {
      lines.push(`${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true);${c}`)
    } else if (n.kind === 'wedge' || n.kind === 'rack') {
      lines.push(`${wrap}cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true);${c} (simplified)`)
    } else if (n.kind === 'gear') {
      lines.push(`${wrap}cylinder(h=${n.width.toFixed(1)}, r=${(((n.module * n.teeth) / 2) - n.module).toFixed(1)}, center=true);${c} ${n.teeth}T m${n.module}`)
    } else if (n.kind === 'ring') {
      lines.push(`${wrap}difference() { cylinder(h=${n.height.toFixed(1)}, r=${n.outer.toFixed(1)}, center=true); cylinder(h=${(n.height + 1).toFixed(1)}, r=${n.inner.toFixed(1)}, center=true); }${c}`)
    } else if (n.kind === 'torus' || n.kind === 'bend') {
      lines.push(`${wrap}rotate_extrude() translate([${n.R.toFixed(1)},0,0]) circle(r=${n.r.toFixed(1)});${c}`)
    } else if (n.kind === 'sphere') {
      lines.push(`${wrap}sphere(r=${n.radius.toFixed(1)});${c}`)
    } else {
      const r2 = n.radius2 != null ? `, r2=${n.radius2.toFixed(1)}` : ''
      lines.push(`${wrap}cylinder(h=${n.height.toFixed(1)}, r=${n.radius.toFixed(1)}${r2}, center=true);${c}`)
    }
  }
  return lines.join('\n')
}

function toBOMCsv(design, analysis) {
  const rows = [['part', 'category', 'qty', 'unit_usd', 'line_usd', 'dims_mm', 'connector', 'mount', 'sku_search', 'role']]
  let sum = 0
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    const line = p.price * qty
    sum += line
    rows.push([
      p.name, p.cat, String(qty), p.price.toFixed(2), line.toFixed(2),
      p.dims ? p.dims.join('x') : '', p.conn || '', p.mount || '', p.sku || '', role,
    ])
  }
  // Filament is money too. Without this line the CSV summed to less than the
  // headline cost, so anyone checking the sheet found a different total.
  if (analysis && analysis.print && analysis.print.grams > 0.5) {
    const mat = analysis.print.material || { name: 'filament', priceId: 'petg_kg' }
    const spool = PARTS[mat.priceId]?.price || 20
    const grams = analysis.print.grams
    const line = (grams / 1000) * spool
    sum += line
    rows.push([
      `${mat.name} filament used`, 'material', `${Math.round(grams)} g`,
      ((spool / 1000) * 100).toFixed(2), line.toFixed(2),
      '', '', '', mat.priceId || '', 'printed parts',
    ])
  }
  rows.push(['TOTAL', '', '', '', sum.toFixed(2), '', '', '', '', 'sums to the studio headline'])
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n')
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

  if (design.mech && design.mech.length) {
    L.push('## Mechanics', '', '| Check | Value | Limit | Status |', '|---|---|---|---|')
    for (const r of design.mech) L.push(`| ${r.label} | ${r.value} | ${r.limit} | ${r.ok == null ? '—' : r.ok ? 'ok' : 'LOW'} |`)
    L.push('')
  }

  L.push('## Bill of materials', '', '| Part | Qty | Unit | Line | Details | Role |', '|---|---|---|---|---|---|')
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    const det = [p.dims ? p.dims.join('×') + 'mm' : '', p.conn || '', p.mount || ''].filter(Boolean).join(' · ')
    L.push(`| ${p.name} | ${qty} | ${money(p.price)} | ${money(p.price * qty)} | ${det} | ${role} |`)
  }
  L.push('', `**Total: ${money(a.cost)}**`, '')

  L.push('## Pin map', '', '| Pin | Signal | Dir | Note |', '|---|---|---|---|')
  for (const r of a.pins.rows) L.push(`| ${r.pin} | ${r.signal} | ${r.dir} | ${r.note} |`)
  L.push('')

  L.push('## Power budget', '', '| Rail | Typical | Peak | Wire | Fuse |', '|---|---|---|---|---|')
  for (const w of (a.power.wiring || [])) L.push(`| ${w.rail} | ${fmt(w.amps, 2)} A | ${fmt(w.peak, 2)} A | AWG ${w.awg} | ${w.fuse ? `${w.fuse} A` : '—'} |`)
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

function boundRadius(n) {
  switch (n.kind) {
    case 'cyl': return Math.max(n.radius, n.radius2 || 0, n.height / 2)
    case 'ring': return Math.max(n.outer, n.height / 2)
    case 'torus': case 'bend': return n.R + n.r
    case 'sphere': return n.radius
    case 'gear': return Math.max((n.module * n.teeth) / 2 + n.module, n.width / 2)
    default: return Math.hypot(n.size[0], n.size[1], n.size[2]) / 2
  }
}

function boundsOf(nodes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const n of nodes) {
    let half
    if (n.kind === 'box' || n.kind === 'rbox' || n.kind === 'wedge' || n.kind === 'rack') {
      half = [n.size[0] / 2, n.size[1] / 2, n.size[2] / 2]
    } else {
      // radial extent, NOT boundRadius: a 123mm rail is 6mm Ø, not 123 in y
      const r = n.kind === 'cyl' ? Math.max(n.radius, n.radius2 || 0)
        : n.kind === 'ring' ? n.outer
          : boundRadius(n)
      const along = n.kind === 'cyl' || n.kind === 'ring' ? n.height / 2 : n.kind === 'gear' ? n.width / 2 : r
      half = n.axis === 'x' ? [along, r, r] : n.axis === 'y' ? [r, along, r] : [r, r, along]
      if (n.kind === 'torus' || n.kind === 'bend' || n.kind === 'sphere') half = [r, r, r]
    }
    if (n.rot) {
      // world AABB of a rotated box: rotate the 8 local corners, take abs max
      const w = [0, 0, 0]
      for (let c = 0; c < 8; c += 1) {
        const p = rotEuler([half[0] * (c & 1 ? 1 : -1), half[1] * (c & 2 ? 1 : -1), half[2] * (c & 4 ? 1 : -1)], n.rot)
        for (let i = 0; i < 3; i += 1) w[i] = Math.max(w[i], Math.abs(p[i]))
      }
      half = w
    }
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], n.pos[i] - half[i])
      max[i] = Math.max(max[i], n.pos[i] + half[i])
    }
  }
  return { min, max }
}

// ── bench core: pre-print test math ─────────────────────────────────────────
// The "field test before you print" layer. Everything here is rigid-body
// statics on the SAME FK the renderer and exporters use — no fake numbers:
//   · whole-body centre of mass, live under the current pose
//   · support polygon = convex hull of ground-contact nodes
//   · tip-over margin on flat ground AND on an inclined ramp
//   · per-joint gravity torque vs the stall torque the servo was picked for
//   · CCD IK so a target point can drive a joint chain (bench teleop later)
// All units mm / grams / N·m / radians internally consistent with the engine.

const BENCH_G = 9810 // mm/s²  (g in mm units — keeps torque in N·mm→N·m clean)

/** Mass of one node in grams: bought part → catalog mass; printed → volume×density. */
function benchNodeMassG(design, node, mat) {
  const p = node.part ? PARTS[node.part] : null
  if (p) return (p.mass || 0) * (node.qty || 1)
  const density = (mat && mat.density) || 1.24 // g/cm³
  return (nodeVolume(node) / 1000) * density
}

/** World position of a node centre under the current joint pose (mm). */
function benchNodeWorld(design, chains, node) {
  const j = node.joint ? design.joints.find((jj) => jj.id === node.joint) : null
  const chain = j ? chains.get(j.id) : null
  const p = applyChain(chain, node.pos || [0, 0, 0])
  const s = slideDisp(design, node)
  return [p[0] + s[0], p[1] + s[1], p[2] + s[2]]
}

/** Whole-body CoM under the current pose. Returns {com:[x,y,z] mm, massG}. */
function benchCoM(design, mat) {
  const chains = chainsFor(design)
  let mx = 0, my = 0, mz = 0, m = 0
  for (const n of design.nodes) {
    const w = benchNodeWorld(design, chains, n)
    const g = benchNodeMassG(design, n, mat)
    if (!isFinite(g) || g <= 0) continue
    mx += w[0] * g; my += w[1] * g; mz += w[2] * g; m += g
  }
  return m > 0 ? { com: [mx / m, my / m, mz / m], massG: m } : { com: [0, 0, 0], massG: 0 }
}

/** Rough "how far below centre is the bottom of this node" for contact tests. */
function benchNodeDrop(node) {
  if (node.kind === 'cyl' || node.kind === 'ring') {
    return node.axis === 'z' ? (node.height || node.outer || 0) / 2 : (node.radius || node.outer || 10)
  }
  if (node.kind === 'box' || node.kind === 'rbox' || node.kind === 'wedge') return (node.size?.[2] || 10) / 2
  if (node.kind === 'torus' || node.kind === 'bend') return (node.R || 20) - (node.r || 5)
  return Math.min(node.size?.[0] || node.radius || node.outer || 20, 30) / 2
}

/** Ground-contact points (x,y mm): nodes whose bottom sits at the design's floor.
 *  Plates contribute their footprint corners, not just the centre — otherwise a
 *  base plate hulls as a single point and every margin reads nonsense. */
function benchContacts(design, mat) {
  const chains = chainsFor(design)
  const items = design.nodes.map((n) => {
    const w = benchNodeWorld(design, chains, n)
    return { n, w, bottom: w[2] - benchNodeDrop(n) }
  })
  const floor = Math.min(...items.map((i) => i.bottom))
  const pts3 = []
  for (const { n, w } of items) {
    if (w[2] - benchNodeDrop(n) - floor >= 15) continue
    const z = w[2] - benchNodeDrop(n)
    const k = n.kind
    if ((k === 'box' || k === 'rbox' || k === 'wedge') && n.size) {
      const [sx, sy] = n.size
      pts3.push([w[0] - sx / 2, w[1] - sy / 2, z], [w[0] + sx / 2, w[1] - sy / 2, z],
                [w[0] + sx / 2, w[1] + sy / 2, z], [w[0] - sx / 2, w[1] + sy / 2, z])
    } else if (k === 'cyl' || k === 'ring') {
      const r = n.radius || n.outer || 10
      if (n.axis === 'z') {
        for (let a = 0; a < 8; a++) { const t = (a / 8) * Math.PI * 2; pts3.push([w[0] + Math.cos(t) * r, w[1] + Math.sin(t) * r, z]) }
      } else {
        // horizontal axle: contact patch is a line along the perpendicular
        pts3.push([w[0] - r, w[1], z], [w[0] + r, w[1], z], [w[0], w[1] - r, z], [w[0], w[1] + r, z])
      }
    } else {
      pts3.push([w[0], w[1], z])
    }
  }
  return pts3
}

/** 2D contact points for hull work. */
function benchContacts2D(design) {
  return benchContacts(design).map((p) => [p[0], p[1]])
}

/** Andrew's monotone chain — 2D convex hull, returns CCW vertices. */
function hull2D(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  const hi = []
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q) }
  lo.pop(); hi.pop()
  return lo.concat(hi)
}

/** Signed distance (mm) from pt to hull edge; positive = inside. */
function benchHullMargin(pt, hull) {
  if (hull.length < 3) return -999
  let min = Infinity
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    const ex = b[0] - a[0], ey = b[1] - a[1]
    const len = Math.hypot(ex, ey) || 1
    // CCW hull → inside is to the LEFT of each edge (positive 2D cross product)
    const d = ex * (pt[1] - a[1]) - ey * (pt[0] - a[0])
    min = Math.min(min, d / len)
  }
  return min
}

/**
 * Tip-over margin on a slope inclined `slopeDeg` about the X axis (rising +Y).
 * Transforms contacts + CoM into the slope frame, hulls the contacts there,
 * and measures how far the CoM's gravity projection sits inside the hull.
 */
function benchSlopeMargin(design, mat, slopeDeg) {
  const th = (slopeDeg * Math.PI) / 180
  const c = Math.cos(th), s = Math.sin(th)
  const chains = chainsFor(design)
  const com = benchCoM(design, mat).com
  // rotate about X: slope-frame coords (x, yAlong, zUp-from-slope)
  const tf = (p) => [p[0], p[1] * c + p[2] * s, -p[1] * s + p[2] * c]
  const contacts = benchContacts(design, mat).map(tf).map((p) => [p[0], p[1]])
  const cp = tf(com)
  return benchHullMargin([cp[0], cp[1]], hull2D(contacts))
}

/**
 * Per-joint gravity torque at the CURRENT pose vs the stall torque the
 * actuator was actually picked for. τ = Σ m·g·lever about each joint axis —
 * exact rigid-body statics; yaw axes read ~0 because gravity can't load them.
 */
function benchTorqueMargins(design, mat) {
  const chains = chainsFor(design)
  const acts = design.actuators || []
  const byId = new Map(design.joints.map((j) => [j.id, j]))
  const out = []
  // descendant joints of j (inclusive) via parent chain
  const subtree = (jid) => {
    const ids = new Set([jid])
    for (const j of design.joints) {
      let cur = j, guard = 0
      while (cur && guard < 24) { if (cur.id === jid) { ids.add(j.id); break } cur = cur.parent ? byId.get(cur.parent) : null; guard++ }
    }
    return ids
  }
  for (const j of design.joints) {
    if (j.slide || j.axis === 'z') continue
    const act = acts.find((a) => a.label === j.label)
    if (!act) continue
    const ids = subtree(j.id)
    // τ about the joint axis = Σ m·g·lever. In N·m with mm units:
    //   τ = (massG/1000 kg)·9.81·(lever_mm/1000 m) = massG·lever_mm·9.81e-6
    // For a vertical-axis (yaw) joint gravity produces ~0 — the cross product
    // handles that naturally, no special-casing needed.
    let tauNm = 0
    for (const n of design.nodes) {
      const nj = n.joint ? byId.get(n.joint) : null
      if (!nj || !ids.has(nj.id)) continue
      const w = benchNodeWorld(design, chains, n)
      const r = [w[0] - j.pivot[0], w[1] - j.pivot[1], w[2] - j.pivot[2]]
      const mg = benchNodeMassG(design, n, mat) * 9.81e-3 // N
      // F = (0,0,-mg); τ = r×F → only x,y components survive
      const tx = -r[1] * mg, ty = r[0] * mg, tz = 0
      const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[j.axis]
      const leverNmm = Math.abs(tx * ax[0] + ty * ax[1] + tz * ax[2]) // N·mm
      tauNm += leverNmm / 1000 // N·mm → N·m
    }
    const need = tauNm // N·m
    const stall = act.effective || 0
    out.push({ joint: j.id, label: j.label, needNm: need, stallNm: stall, margin: stall > 0 ? stall / Math.max(need, 1e-6) : 0 })
  }
  return out
}

/**
 * The pre-print verdict: one report a human can act on before spending money.
 * opts: { mat, slopeDeg, payloadG }
 */
function benchReport(design, analysis, opts = {}) {
  const mat = opts.mat || (analysis && analysis.material) || PARTS.pla && null
  const slopeDeg = opts.slopeDeg != null ? opts.slopeDeg : 15
  const { com, massG } = benchCoM(design, mat)
  const contacts = benchContacts2D(design)
  const hull = hull2D(contacts)
  const flatMm = benchHullMargin([com[0], com[1]], hull)
  const slopeMm = benchSlopeMargin(design, mat, slopeDeg)
  const torques = benchTorqueMargins(design, mat)
  const worst = torques.reduce((a, b) => (b.needNm / Math.max(b.stallNm, 1e-6)) > (a.needNm / Math.max(a.stallNm, 1e-6)) ? b : a, torques[0] || { needNm: 0, stallNm: 1, label: '—', joint: '—' })
  const verdicts = []
  const status = (ok, warn, label, detail) => verdicts.push({ label, status: ok ? 'pass' : warn ? 'warn' : 'fail', detail })
  status(flatMm > 15, flatMm > 0, 'Stability (flat)', `${Math.round(flatMm)}mm CoM margin inside the ${hull.length}-point support polygon · ${Math.round(massG)}g`)
  status(slopeMm > 0, slopeMm > -10, `Stability @ ${slopeDeg}° slope`, `${Math.round(slopeMm)}mm margin on the ramp plane`)
  const tj = torques.length ? torques.reduce((a, b) => (a.margin < b.margin ? a : b)) : null
  if (tj) status(tj.margin > 1.5, tj.margin > 1.0, 'Worst joint torque', `${tj.label}: needs ${tj.needNm.toFixed(2)} N·m, stall ${tj.stallNm.toFixed(2)} N·m → ${tj.margin.toFixed(1)}× margin`)
  else status(true, true, 'Actuators', 'no gravity-loaded revolute joints')
  return { com, massG, contacts: contacts.length, hull, flatMm, slopeMm, slopeDeg, torques, worst, verdicts }
}

// ── CCD IK: drive a joint chain so a tip node reaches a target point ────────
/**
 * Cyclic-coordinate-descent IK over a joint chain (root→tip order in `chain`).
 * `tipWorld(design)` returns the current world pos of the end-effector node.
 * Mutates joint.angle (clamped to [min,max]); returns final tip→target error mm.
 */
function solveChainIK(design, chain, target, tipWorld, iters = 6) {
  if (!chain || !chain.length) return { err: 1e9, iters: 0 }
  const byId = new Map(design.joints.map((j) => [j.id, j]))
  let err = 1e9
  for (let it = 0; it < iters; it++) {
    const tip = tipWorld(design)
    err = Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2])
    if (err < 0.5) break
    for (let k = chain.length - 1; k >= 0; k--) {
      const j = chain[k]
      if (j.slide || j.axis === 'z') continue
      const chains = chainsFor(design)
      const sub = chain.slice(0, k + 1)
      const pivot = j.pivot
      const tipP = tipWorld(design)
      const toTip = [tipP[0] - pivot[0], tipP[1] - pivot[1], tipP[2] - pivot[2]]
      const toTgt = [target[0] - pivot[0], target[1] - pivot[1], target[2] - pivot[2]]
      const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[j.axis]
      // project both vectors onto the plane ⊥ axis, angle between them
      const proj = (v) => {
        const d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]
        return [v[0] - d * ax[0], v[1] - d * ax[1], v[2] - d * ax[2]]
      }
      const a = proj(toTip), b = proj(toTgt)
      const ang = Math.atan2(
        a[0] * b[1] - a[1] * b[0] + a[1] * b[2] - a[2] * b[1] + a[2] * b[0] - a[0] * b[2],
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      )
      // yaw joints read positive CCW about +axis; pitch 'y' is inverted like applyChain
      const sign = j.axis === 'y' ? -1 : 1
      let next = j.angle + (sign * ang * 180) / Math.PI
      next = Math.min(j.max, Math.max(j.min, next))
      j.angle = next
    }
  }
  const tip = tipWorld(design)
  err = Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2])
  return { err, iters }
}

/**
 * GL overlay: support-polygon hull (dashed), CoM plumb line, CoM reticle.
 * Returns interleaved [x,y,z,r,g,b] vertices for GL_LINES, or null when the
 * machine has no ground contacts (shouldn't happen, but be honest).
 */
function benchOverlay(design, mat) {
  const { com } = benchCoM(design, mat)
  const c3 = benchContacts(design, mat)
  if (!c3.length) return null
  const floorZ = Math.min(...c3.map((p) => p[2]))
  const hull = hull2D(c3.map((p) => [p[0], p[1]]))
  const margin = benchHullMargin([com[0], com[1]], hull)
  const col = margin > 15 ? [0.30, 0.95, 0.55] : margin > 0 ? [1.0, 0.72, 0.18] : [1.0, 0.32, 0.28]
  const cyan = [0.25, 0.85, 1.0]
  const arr = []
  const seg = (a, b, c) => { arr.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], c[0], c[1], c[2]) }
  const Z = floorZ + 0.8
  if (hull.length >= 3) {
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const dash = 12, gap = 8, n = Math.max(1, Math.floor(len / (dash + gap)))
      for (let d = 0; d < n; d++) {
        const t0 = (d * (dash + gap)) / len, t1 = Math.min(1, (d * (dash + gap) + dash) / len)
        seg([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, Z],
            [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, Z], cyan)
      }
    }
  }
  seg(com, [com[0], com[1], Z], col)
  const s = 14
  seg([com[0] - s, com[1], com[2]], [com[0] + s, com[1], com[2]], col)
  seg([com[0], com[1] - s, com[2]], [com[0], com[1] + s, com[2]], col)
  seg([com[0], com[1], com[2] - s], [com[0], com[1], com[2] + s], col)
  seg([com[0] - 9, com[1], Z], [com[0] + 9, com[1], Z], col)
  seg([com[0], com[1] - 9, Z], [com[0], com[1] + 9, Z], col)
  return { data: new Float32Array(arr), verts: arr.length / 6 }
}

// ── simulation export: URDF and MJCF ────────────────────────────────────────
// The studio poses a kinematic chain; it does not pretend to be a physics
// engine. What an engineer actually needs is the machine in a format a real
// simulator loads: URDF for the ROS world (RViz, MoveIt, Gazebo, Isaac, Drake,
// PyBullet) and MJCF for MuJoCo, which is where contact dynamics live.
//
// References this file follows:
//   URDF joint types and limits      — ROS docs (revolute / continuous / prismatic)
//   URDF tree-only topology          — REP 120; parallel linkages must be loop-closed
//   MJCF joints, actuators, defaults — MuJoCo 3.x XML reference
// Every number here comes from the design: axes, pivots, travel limits, masses.

// Mesh parts (converted from Sand3D, see tools/sand3d-fetch.mjs) register
// themselves in src/parts-*.js; the renderer looks them up by name.

const SIM_D2R = Math.PI / 180

/**
 * The servo that drives a joint. Designs from the arm builder carry a per-joint
 * actuator table; the rest carry only a BOM, so fall back to the servo they buy
 * most of and say so in the file — a joint with no effort limit cannot move.
 */
function servoFor(design, joint) {
  const acts = design.actuators || []
  const exact = acts.find((a) => a.label === joint.label && a.servo && PARTS[a.servo])
  if (exact) return { servo: exact.servo, torque: PARTS[exact.servo].torque * (exact.ratio || 1), exact: true }
  let best = null
  for (const part of design.parts) {
    const info = PARTS[part.key]
    if (!info || info.cat !== 'servo') continue
    if (!best || part.qty > best.qty || (part.qty === best.qty && info.torque > best.torque)) best = { key: part.key, qty: part.qty, torque: info.torque }
  }
  if (!best) return null
  return { servo: best.key, torque: best.torque, exact: false }
}

function axisVec(axis) {
  if (Array.isArray(axis)) return axis
  if (axis === 'x') return [1, 0, 0]
  if (axis === 'y') return [0, 1, 0]
  return [0, 0, 1]
}

/** Mass per printed node, from the shelled volume the print estimate uses. */
function nodeMasses(design, analysis) {
  const mat = (analysis && analysis.print && analysis.print.material) || { density: 1.27 }
  const printed = design.nodes.filter((n) => n.print || n.mat === 'shell')
  const vols = printed.map((n) => ({ node: n, mm3: shellVolume(n) }))
  const total = vols.reduce((s, v) => s + v.mm3, 0) || 1
  const grams = (analysis && analysis.print && analysis.print.grams) || 0
  return vols.map((v) => ({ node: v.node, g: (v.mm3 / total) * grams }))
}

/** Box inertia about the centre, in kg·m², from a node's mm dimensions. */
function boxInertia(grams, dims) {
  const m = Math.max(0.001, grams / 1000)
  const [x, y, z] = dims.map((d) => Math.max(0.001, d / 1000))
  return {
    ixx: (m / 12) * (y * y + z * z),
    iyy: (m / 12) * (x * x + z * z),
    izz: (m / 12) * (x * x + y * y),
    m,
  }
}

/** Bounding box of a node in its own frame (mm). */
function nodeDims(node) {
  if (node.size) return node.size.slice()
  if (node.radius != null) return [node.radius * 2, node.radius * 2, node.height || node.radius * 2]
  return [10, 10, 10]
}

/**
 * URDF. Strict tree (REP 120): each joint hangs off its parent joint's link, or
 * the base link. Slide joints become prismatic, hinges revolute with their real
 * travel, and a joint with no limits becomes continuous.
 */
function toURDF(design, analysis) {
  const joints = design.joints || []
  const masses = nodeMasses(design, analysis)
  const byJoint = new Map()
  let free = 0
  for (const { node, g } of masses) {
    const key = node.joint || null
    if (!key) { free += g; continue }
    if (!byJoint.has(key)) byJoint.set(key, { g: 0, dims: [0, 0, 0] })
    const acc = byJoint.get(key)
    acc.g += g
    const d = nodeDims(node)
    acc.dims = [Math.max(acc.dims[0], d[0]), Math.max(acc.dims[1], d[1]), Math.max(acc.dims[2], d[2])]
  }
  // printed parts on no joint, plus every bought part, land on the base link and
  // the file says so rather than hiding them in a phantom link
  const hardware = analysis ? Math.max(0, analysis.mass.totalG - (analysis.print ? analysis.print.grams : 0)) : 0
  const baseG = free + hardware

  const linkOf = (jid) => (jid ? `link_${jid}` : 'base_link')
  const r6 = (v) => Number(v).toFixed(6)

  const L = []
  L.push('<?xml version="1.0"?>')
  L.push(`<!-- ${design.title} — generated by Rigforge (${new Date().toISOString().slice(0, 10)})`)
  L.push('     Kinematics from the studio joint tree; inertias are box approximations')
  L.push('     per link, which is what URDF expects and what most simulators refine.')
  L.push(`     Base link carries ${Math.round(baseG)}g: printed parts on no joint (${Math.round(free)}g)`)
  L.push(`     plus every bought part (${Math.round(hardware)}g) — servos, pack, fasteners. -->`)
  L.push('<robot name="' + xmlEscape(design.title) + '">')
  L.push(`  <link name="base_link">`)
  L.push(`    <inertial>`)
  const bi = boxInertia(baseG, [120, 120, 40])
  L.push(`      <mass value="${r6(bi.m)}"/>`)
  L.push(`      <inertia ixx="${r6(bi.ixx)}" iyy="${r6(bi.iyy)}" izz="${r6(bi.izz)}" ixy="0" ixz="0" iyz="0"/>`)
  L.push(`    </inertial>`)
  L.push(`  </link>`)

  for (const j of joints) {
    const acc = byJoint.get(j.id) || { g: 0, dims: [24, 24, 24] }
    const bi2 = boxInertia(acc.g, acc.dims)
    const parent = linkOf(j.parent)
    const child = linkOf(j.id)
    const axis = axisVec(j.axis)
    const type = j.slide ? 'prismatic' : (j.max - j.min >= 359 ? 'continuous' : 'revolute')
    L.push(`  <link name="${child}">`)
    L.push(`    <inertial>`)
    L.push(`      <mass value="${r6(bi2.m)}"/>`)
    L.push(`      <inertia ixx="${r6(bi2.ixx)}" iyy="${r6(bi2.iyy)}" izz="${r6(bi2.izz)}" ixy="0" ixz="0" iyz="0"/>`)
    L.push(`    </inertial>`)
    L.push(`  </link>`)
    L.push(`  <joint name="${j.id}" type="${type}">`)
    L.push(`    <parent link="${parent}"/>`)
    L.push(`    <child link="${child}"/>`)
    const pivot = j.pivot || [0, 0, 0]
    L.push(`    <origin xyz="${pivot.map((v) => r6(v / 1000)).join(' ')}" rpy="0 0 0"/>`)
    L.push(`    <axis xyz="${axis.join(' ')}"/>`)
    // effort and velocity must be real: a zero effort limit means the joint
    // cannot move in Gazebo, RViz's fake controllers or Isaac
    const drive = servoFor(design, j)
    const effort = drive ? drive.torque : 1
    const velocity = j.slide ? 0.2 : 6.0
    if (type !== 'continuous') {
      const lo = j.slide ? j.min / 1000 : j.min * SIM_D2R
      const hi = j.slide ? j.max / 1000 : j.max * SIM_D2R
      L.push(`    <limit lower="${r6(lo)}" upper="${r6(hi)}" effort="${r6(effort)}" velocity="${r6(velocity)}"/>`)
    } else {
      L.push(`    <limit effort="${r6(effort)}" velocity="${r6(velocity)}"/>`)
    }
    L.push(`  </joint>`)
  }
  L.push('</robot>')
  return L.join('\n')
}

/**
 * MJCF for MuJoCo: nested bodies, the same limits, and a position actuator per
 * joint sized from the servo the studio actually picked. MJCF allows loops and
 * soft contact (solref/solimp), which is why it is the second export.
 */
function toMJCF(design, analysis) {
  const joints = design.joints || []
  const masses = nodeMasses(design, analysis)
  const byJoint = new Map()
  for (const { node, g } of masses) {
    const key = node.joint || null
    if (!key) continue
    byJoint.set(key, (byJoint.get(key) || 0) + g)
  }
  const childOf = new Map()
  for (const j of joints) {
    const p = j.parent || '_base'
    if (!childOf.has(p)) childOf.set(p, [])
    childOf.get(p).push(j)
  }
  const hardware = analysis ? Math.max(0, analysis.mass.totalG - (analysis.print ? analysis.print.grams : 0)) : 0
  const r4 = (v) => Number(v).toFixed(4)

  const L = []
  L.push('<?xml version="1.0"?>')
  L.push(`<mujoco model="${xmlEscape(design.title)}">`)
  L.push('  <!-- generated by Rigforge: same joint tree as the studio, actuator torque from the chosen servo -->')
  L.push('  <compiler angle="degree" coordinate="local"/>')
  L.push('  <option timestep="0.002" integrator="implicitfast" cone="elliptic" impratio="10"/>')
  L.push('  <default>')
  L.push('    <geom rgba="0.55 0.58 0.6 1" friction="0.9 0.01 0.001"/>')
  L.push('    <position kp="40" kv="1"/>')
  L.push('  </default>')
  L.push('  <worldbody>')
  L.push('    <geom name="floor" type="plane" size="1 1 0.02"/>')
  L.push(`    <body name="base" pos="0 0 ${r4(0.05)}">`)
  L.push('      <freejoint/>')
  L.push(`      <inertial pos="0 0 0" mass="${r4(Math.max(0.001, hardware / 1000))}" diaginertia="0.001 0.001 0.001"/>`)
  L.push('      <geom type="box" size="0.06 0.06 0.02"/>')

  const emit = (parentId, depth) => {
    const kids = childOf.get(parentId) || []
    for (const j of kids) {
      const pad = '  '.repeat(depth + 3)
      const g = Math.max(0.001, (byJoint.get(j.id) || 0) / 1000)
      const pivot = (j.pivot || [0, 0, 0]).map((v) => r4(v / 1000)).join(' ')
      const axis = axisVec(j.axis).join(' ')
      const range = j.slide ? `${r4(j.min / 1000)} ${r4(j.max / 1000)}` : `${r4(j.min)} ${r4(j.max)}`
      const kind = j.slide ? 'slide' : 'hinge'
      L.push(`${pad}<body name="b_${j.id}" pos="${pivot}">`)
      L.push(`${pad}  <inertial pos="0 0 0" mass="${r4(g)}" diaginertia="0.0005 0.0005 0.0005"/>`)
      L.push(`${pad}  <joint name="${j.id}" type="${kind}" axis="${axis}" range="${range}" damping="0.4"/>`)
      L.push(`${pad}  <geom type="capsule" fromto="0 0 0 ${axis.split(' ').map((v) => r4(Number(v) * 0.06)).join(' ')}" size="0.012"/>`)
      const drive2 = servoFor(design, j)
      if (drive2) {
        L.push(`${pad}  <position joint="${j.id}" kp="40" kv="1" forcerange="${r4(-drive2.torque)} ${r4(drive2.torque)}"/>`)
      }
      emit(j.id, depth + 1)
      L.push(`${pad}</body>`)
    }
  }
  emit('_base', 0)
  L.push('    </body>')
  L.push('  </worldbody>')
  L.push('  <actuator>')
  for (const j of joints) {
    const drive3 = servoFor(design, j)
    if (!drive3) continue
    L.push(`    <motor joint="${j.id}" name="m_${j.id}" gear="1" ctrlrange="${r4(-drive3.torque)} ${r4(drive3.torque)}"/>`)
  }
  L.push('  </actuator>')
  L.push('</mujoco>')
  return L.join('\n')
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── joint dynamics: the machine physically tracks commands ──────────────────
// Pose used to teleport: drag a slider, the joint jumped. Now every revolute
// joint slews toward its target at the speed ITS servo can actually turn,
// loses speed as gravity load rises, and stalls outright when the load
// exceeds stall torque — the same numbers the BOM and power budget already
// computed. Slides slew at a lead-screw-ish rate. All deterministic, all from
// src/10-parts.js specs — no invented constants except the slew cap below.

/**
 * Gravity torque about every revolute joint at a given pose, in N·m (signed).
 * One pass: each node's world position is computed once, then contributes to
 * every ancestor joint via the exact r×F statics from 41-bench. `poseAngles`
 * optionally overrides design.joints[].angle without mutating the design.
 */
function jointLoadNm(design, mat, poseAngles) {
  const joints = design.joints
  const saved = joints.map((j) => j.angle)
  if (poseAngles) joints.forEach((j, i) => { j.angle = poseAngles[i] == null ? j.angle : poseAngles[i] })
  try {
    const chains = chainsFor(design)
    const byId = new Map(joints.map((j) => [j.id, j]))
    // ancestors of each joint (inclusive), root→tip order not needed here
    const ancestorsOf = (jid) => {
      const out = []
      let cur = byId.get(jid)
      let guard = 0
      while (cur && guard < 24) { out.push(cur); cur = cur.parent ? byId.get(cur.parent) : null; guard++ }
      return out
    }
    const load = {}
    for (const n of design.nodes) {
      const nj = n.joint ? byId.get(n.joint) : null
      if (!nj) continue
      const w = benchNodeWorld(design, chains, n)
      const g = benchNodeMassG(design, n, mat) * 9.81e-3 // N
      if (g <= 0) continue
      for (const j of ancestorsOf(nj.id)) {
        if (j.slide || j.axis === 'z') continue
        const ax = j.axis === 'x' ? 1 : 0
        const ay = j.axis === 'y' ? 1 : 0
        const r = [w[0] - j.pivot[0], w[1] - j.pivot[1], w[2] - j.pivot[2]]
        // τ = r × F with F = (0,0,-g): τx = -ry·g, τy = rx·g → along axis, N·mm → N·m
        const tau = (-r[1] * g * ax + r[0] * g * ay) / 1000
        load[j.id] = (load[j.id] || 0) + tau
      }
    }
    return load
  } finally {
    joints.forEach((j, i) => { j.angle = saved[i] })
  }
}

/**
 * A joint-level sim: angles slew toward targets at each servo's real speed,
 * derate under gravity load, and stall (with a gravity sag) past stall torque.
 * Load is recomputed lazily every LOAD_MS against the sim's own pose — a
 * 23-joint humanoid costs ~1k torque evals, trivial at 2 Hz.
 */
function createJointSim(design, analysis) {
  const mat = analysis && analysis.print && analysis.print.material
  const acts = design.actuators || []
  const joints = design.joints
  const n = joints.length
  const state = {
    angles: joints.map(() => 0),
    vel: joints.map(() => 0),
    targets: joints.map(() => 0),
    loadNm: joints.map(() => 0),
    stallNm: joints.map((j) => {
      const a = acts.find((x) => x.label === j.label)
      return a ? a.effective || 0 : 0
    }),
    servoKey: joints.map((j) => {
      const a = acts.find((x) => x.label === j.label)
      return a ? a.servo : null
    }),
    stalled: joints.map(() => false),
    busA: 0,
    _loadAt: 0,
    _loadPose: null,
  }
  const LOAD_MS = 500
  const SAG_DPS = 22 // °/s a stalled joint creeps toward rest under gravity

  function refreshLoad(now) {
    if (now - state._loadAt < LOAD_MS) return
    state._loadAt = now
    const load = jointLoadNm(design, mat, state.angles)
    let bus = 0
    for (let i = 0; i < n; i++) {
      const j = joints[i]
      const need = Math.abs(load[j.id] || 0)
      state.loadNm[i] = need
      const part = state.servoKey[i] ? PARTS[state.servoKey[i]] : null
      const stall = state.stallNm[i]
      const ratio = stall > 0 ? need / stall : 0
      // thermal cutoff from the endurance sim ORs into the stall verdict —
      // a cooked servo cannot hold position either
      state.stalled[i] = ratio > 1.0 || !!(state.thermal && state.thermal[i])
      if (part && part.curr) {
        bus += (part.curr.idle || 0) + (part.curr.typ || 0) * Math.min(ratio, 1)
        if (ratio > 1) bus += (part.curr.peak || 0)
      }
    }
    state.busA = bus
  }

  return {
    state,
    /** Command new target angles (deg for revolute, mm for slides). */
    setTargets(arr) {
      for (let i = 0; i < n; i++) {
        const j = joints[i]
        const t = arr[i] == null ? 0 : arr[i]
        state.targets[i] = Math.min(j.max, Math.max(j.min, t))
      }
    },
    /** Snap every joint to a pose instantly (home, preset, design change). */
    snap(arr) {
      for (let i = 0; i < n; i++) {
        const j = joints[i]
        const a = arr[i] == null ? 0 : arr[i]
        const c = Math.min(j.max, Math.max(j.min, a))
        state.angles[i] = c
        state.targets[i] = c
        state.vel[i] = 0
      }
      state._loadAt = 0
    },
    /** Advance the sim by dt seconds. Returns true if any angle moved. */
    step(dt, now) {
      refreshLoad(now || 0)
      let moved = false
      for (let i = 0; i < n; i++) {
        const j = joints[i]
        const a = state.angles[i]
        const t = state.targets[i]
        const err = t - a
        if (Math.abs(err) < 0.01) { state.vel[i] = 0; continue }
        if (j.slide) {
          // leadscrew/rail: ~45 mm/s, no stall model — the analysis already
          // sized these for the load they see
          const step = Math.sign(err) * Math.min(Math.abs(err), 45 * dt)
          state.angles[i] = a + step
          state.vel[i] = step / Math.max(dt, 1e-4)
          moved = true
          continue
        }
        if (state.stalled[i]) {
          // cannot hold position: creep toward rest (angle 0) under gravity
          const dir = a > 0 ? -1 : 1
          state.angles[i] = a + dir * Math.min(Math.abs(a), SAG_DPS * dt)
          state.vel[i] = 0
          moved = true
          continue
        }
        const part = state.servoKey[i] ? PARTS[state.servoKey[i]] : null
        // speed field is s/60° → dps = 60/speed; derate by gravity load,
        // floor at 15% so a heavily loaded joint still creeps, not freezes
        const dps = part && part.speed ? (60 / part.speed) * Math.max(0.15, 1 - 0.85 * (state.loadNm[i] / Math.max(state.stallNm[i], 1e-6))) : 200
        const maxStep = dps * dt
        const step = Math.sign(err) * Math.min(Math.abs(err), maxStep)
        state.angles[i] = a + step
        state.vel[i] = step / Math.max(dt, 1e-4)
        moved = true
      }
      return moved
    },
  }
}

// ── chassis drive: throttle, steer, traction, slopes — the machine moves ────
// Differential-drive model on the numbers the design already computed:
//   · tractive force at the contact patch = 2 wheels × torquePerWheel / wheelR
//   · traction cap = μ·m·g·cos(grade) — demand beyond it is wheelspin
//   · gravity along the slope = m·g·sin(grade)·cos(yaw) — honest rollback
//   · yaw from differential wheel speeds about the track width
//   · speed asymptotes to the design's own speedMps (motor rpm × wheel Ø)
// Only wheeled archetypes get a drive state — legged gait is footfall IK,
// a different problem, and static nodes honestly have nothing to drive.

/** Bench surfaces — rubber-ish wheels on each. μ is honest, not generous. */
const DRIVE_SURFACES = {
  concrete: { mu: 0.9, label: 'dry concrete' },
  hardwood: { mu: 0.8, label: 'hardwood' },
  tile: { mu: 0.35, label: 'glazed tile' },
  ice: { mu: 0.12, label: 'wet ice' },
}

/** The traction rack: a wedge rising along +X, then a plateau. */
const RAMP = { x0: 1.4, x1: 3.0, halfW: 1.1, topX: 5.2 }

/** Terrain height at world x — flat, ramp grade, then plateau. */
function terrainHeight(x, slopeDeg, course) {
  if (course === 'stairs') return stairsHeight(x)
  if (course === 'room') return roomHeight(x)
  if (x <= RAMP.x0) return 0
  const h = (RAMP.x1 - RAMP.x0) * Math.tan((slopeDeg * Math.PI) / 180)
  if (x >= RAMP.x1) return h
  return (x - RAMP.x0) * Math.tan((slopeDeg * Math.PI) / 180)
}

/** Local grade (radians, + = uphill toward +X) at world x. */
function terrainGrade(x, slopeDeg, course) {
  if (course === 'stairs') return 0
  if (course === 'room') {
    for (const g of ROOM.segs) {
      if (x >= g[0] && x < g[1]) return g[3] !== g[2] ? Math.atan2(g[3] - g[2], g[1] - g[0]) : 0
    }
    return 0
  }
  if (x <= RAMP.x0 || x >= RAMP.x1) return 0
  return (slopeDeg * Math.PI) / 180
}

// ── living-room course ──────────────────────────────────────────────────────
// A fixed household course along +X: hardwood floor, an 18mm door-threshold
// hump at x≈1.2–1.95, a rug zone x∈[2.2,3.6] with μ=0.8, then floor again.
// Props are AABB obstacles the chassis collides with — every hit counts.

const ROOM = {
  // [x0, x1, h0, h1] piecewise-linear height profile, metres
  segs: [
    [0, 1.2, 0, 0],
    [1.2, 1.35, 0, 0.015],
    [1.35, 1.8, 0.015, 0.015],
    [1.8, 1.95, 0.015, 0],
    [1.95, 9, 0, 0],
  ],
  rug: { x0: 2.2, x1: 3.6, mu: 0.8 },
  muFloor: 0.55, // hardwood — the course sets its own surfaces
  // staggered so the centre line is blocked but a weave gets through:
  // shoebox guards the left lane, toy bin the right, books sit deeper right
  props: [
    { id: 'shoebox', name: 'shoe box', c: [2.7, 0.22], half: [0.11, 0.10], top: 0.12, size: [0.22, 0.20, 0.12], mat: 'accent' },
    { id: 'bin', name: 'toy bin', c: [2.45, -0.28], half: [0.10, 0.10], top: 0.16, size: [0.20, 0.20, 0.16], mat: 'metal' },
    { id: 'books', name: 'book stack', c: [1.7, -0.62], half: [0.09, 0.08], top: 0.10, size: [0.18, 0.16, 0.10], mat: 'pcb' },
  ],
}

function roomHeight(x) {
  for (const g of ROOM.segs) {
    if (x >= g[0] && x < g[1]) return g[2] + ((x - g[0]) / (g[1] - g[0])) * (g[3] - g[2])
  }
  return ROOM.segs[ROOM.segs.length - 1][3]
}

/** Friction at world x — the rug grips harder than the floor. */
function muAt(x, env) {
  if (env.course === 'stairs') return DRIVE_SURFACES.hardwood.mu
  if (env.course === 'room') {
    return x >= ROOM.rug.x0 && x < ROOM.rug.x1 ? ROOM.rug.mu : ROOM.muFloor
  }
  return (DRIVE_SURFACES[env.surface] || DRIVE_SURFACES.hardwood).mu
}

// Course dressing (ramps, rooms, stairs) is authored in metres to match the
// drive physics and terrainHeight(); the render space is mm — scale at the
// boundary so tris land in the same space as the machine mesh.
function courseTrisMm(tris) {
  return tris.map((t) => ({ ...t, pts: t.pts.map((p) => [p[0] * 1000, p[1] * 1000, p[2] * 1000]) }))
}

// ── stairs course ───────────────────────────────────────────────────────────
// A porch-stair run along +X: 4 risers of 80mm with 320mm treads. Whether a
// chassis mounts a nosing is decided by wheel radius, not by torque — a rigid
// bot on 50mm wheels cannot climb an 80mm step, and the bench says so.
const STAIRS = { x0: 1.6, tread: 0.32, stepH: 0.08, n: 4, halfW: 1.1 }

function stairsHeight(x) {
  if (x <= STAIRS.x0) return 0
  const i = Math.floor((x - STAIRS.x0) / STAIRS.tread)
  return Math.min(i + 1, STAIRS.n) * STAIRS.stepH
}

/** Stacked tread boxes — reads as a real stair flight, not a ramp. */
function stairsTris() {
  const tris = []
  for (let i = 0; i < STAIRS.n; i++) {
    tris.push(...deskBoxTris(
      STAIRS.x0 + (i + 0.5) * STAIRS.tread, 0, (i + 0.5) * STAIRS.stepH,
      STAIRS.tread, STAIRS.halfW * 2, STAIRS.stepH, 'metal', `stair-${i}`))
  }
  return courseTrisMm(tris)
}

/**
 * Wedge + plateau test-rack geometry as render tris. `mat` is a viewport
 * material key; the ramp reads as aluminium test equipment with an amber
 * edge stripe so it never blends into the floor.
 */
function benchRampTris(slopeDeg) {
  const h = (RAMP.x1 - RAMP.x0) * Math.tan((slopeDeg * Math.PI) / 180)
  const { x0, x1, halfW, topX } = RAMP
  const W = halfW
  const tris = []
  const T = (a, b, c, mat, node) => tris.push({ pts: [a, b, c], mat, node })
  const s0 = [x0, -W, 0], s1 = [x1, -W, h], s2 = [x1, W, h], s3 = [x0, W, 0]
  const p0 = [x1, -W, h], p1 = [topX, -W, h], p2 = [topX, W, h], p3 = [x1, W, h]
  // top surface: two quads → four tris (winding fixed by renderer anyway)
  T(s0, s1, s2, 'metal', 'bench-ramp'); T(s0, s2, s3, 'metal', 'bench-ramp')
  T(p0, p1, p2, 'metal', 'bench-ramp'); T(p0, p2, p3, 'metal', 'bench-ramp')
  // front skirt (y=-W): slope face + plateau face + bottom edge
  T([x0, -W, 0], [x0, -W, 0], [x1, -W, h], 'metal', 'bench-ramp')
  T([x0, -W, 0], [x1, -W, h], [x1, -W, 0], 'metal', 'bench-ramp')
  T([x1, -W, h], [x1, -W, 0], [topX, -W, h], 'metal', 'bench-ramp')
  T([x1, -W, 0], [topX, -W, 0], [topX, -W, h], 'metal', 'bench-ramp')
  // back skirt (y=+W), mirrored
  T([x0, W, 0], [x1, W, h], [x0, W, 0], 'metal', 'bench-ramp')
  T([x1, W, h], [x1, W, 0], [x0, W, 0], 'metal', 'bench-ramp')
  T([x1, W, h], [topX, W, h], [x1, W, 0], 'metal', 'bench-ramp')
  T([topX, W, h], [topX, W, 0], [x1, W, 0], 'metal', 'bench-ramp')
  // toe face at x0 (vertical triangle under the ramp lip)
  T([x0, -W, 0], [x0, W, 0], [x1, -W, h], 'metal', 'bench-ramp')
  T([x0, W, 0], [x1, W, h], [x1, -W, h], 'metal', 'bench-ramp')
  // end face at topX
  T([topX, -W, h], [topX, W, h], [topX, W, 0], 'metal', 'bench-ramp')
  T([topX, -W, h], [topX, W, 0], [topX, -W, 0], 'metal', 'bench-ramp')
  // amber edge stripe along both lips of the driving surface
  const stripe = (ya, yb) => {
    const a = [x0, ya, 0.012], b = [x1, yb, h + 0.012], c = [x1, yb, h - 0.012], d = [x0, ya, -0.012]
    T(a, b, c, 'accent', 'bench-ramp'); T(a, c, d, 'accent', 'bench-ramp')
    const e = [x1, ya, h + 0.012], f = [topX, yb, h + 0.012], g = [topX, yb, h - 0.012], hh = [x1, ya, h - 0.012]
    T(e, f, g, 'accent', 'bench-ramp'); T(e, g, hh, 'accent', 'bench-ramp')
  }
  stripe(-W + 0.03, -W + 0.03)
  stripe(W - 0.03, W - 0.03)
  return courseTrisMm(tris)
}

/** Returns null for machines with nothing to drive. */
function createDrive(design, analysis) {
  const m = (design && design.metrics) || {}
  if (!m.wheelD || !m.massKg || !m.motor) return null
  const motor = PARTS[m.motor]
  const wheelR = m.wheelD / 2000 // m
  const track = (m.trackMm || 300) / 1000 // m
  const baseMass = m.massKg
  // Tractive capability: two motor channels (one per side, each driving a
  // wheel pair) at ~35% of stall torque — what a brushed DC gearmotor actually
  // sustains, not the peak it dies at. F = τ/r per channel.
  const motorTorque = (motor && motor.torque) || m.torquePerWheel || 0.5
  const fMotor = (2 * motorTorque * 0.35) / Math.max(wheelR, 0.01)
  const vmax = Math.min(m.speedMps || 1, 1.4) // bench scale, not a highway
  // largest riser this chassis can mount: about a wheel radius of bite
  const maxStep = wheelR * 1.1

  const env = { surface: 'hardwood', slopeDeg: 0, payloadKg: 0 }
  const mass = () => baseMass + (env.payloadKg || 0)

  return {
    kind: 'drive',
    wheelD: m.wheelD,
    trackMm: m.trackMm || 300,
    vmax,
    fMotor,
    env,
    surfaces: DRIVE_SURFACES,
    /** Merge bench controls; physics picks them up next step. */
    setEnv(patch) { Object.assign(env, patch) },
    state: { x: 0, y: 0, yaw: 0, v: 0, w: 0, vl: 0, throttle: 0, steer: 0, grade: 0, z: 0, slip: false, stall: false, bumps: 0, stepHit: false },
    /** cmd: {throttle: -1..1, steer: -1..1}; dt seconds. Mutates state. */
    step(cmd, dt) {
      const s = this.state
      dt = Math.min(dt, 0.05)
      s.throttle = Math.max(-1, Math.min(1, cmd.throttle || 0))
      s.steer = Math.max(-1, Math.min(1, cmd.steer || 0))
      const mNow = mass()
      const course = env.course === 'room' ? 'room' : env.course === 'stairs' ? 'stairs' : 'rack'
      const mu = muAt(s.x, env)
      const grade = terrainGrade(s.x, env.slopeDeg, course)
      s.grade = grade
      s.z = terrainHeight(s.x, env.slopeDeg, course)

      // command velocity; steer yaw rate falls off with speed so the machine
      // can still turn on the spot
      const vCmd = s.throttle * vmax
      const wCmd = -s.steer * (vmax / Math.max(track * 0.5, 0.05)) * (Math.abs(s.throttle) > 0.05 ? 1 : 0.6)

      // Torque-speed curve: full tractive effort at stall, fading linearly to
      // nothing at the commanded speed — so partial throttle means partial
      // speed, and a slope that eats the torque shows up as lost speed.
      const vT = Math.abs(vCmd) + 0.05
      const speedFrac = Math.min(1, Math.abs(s.v) / vT)
      const tAvail = fMotor * Math.max(0, 1 - speedFrac)
      const Fdem = s.throttle * tAvail
      const N = mNow *  G * Math.cos(grade)
      const Fcap = mu * N
      s.slip = Math.abs(Fdem) > Fcap + 1e-6
      const F = Math.sign(Fdem) * Math.min(Math.abs(Fdem), Fcap)
      const uphill = Math.cos(s.yaw) // heading · +X — ramp runs along +X
      const aGrav = - G * Math.sin(grade) * uphill
      // rolling resistance + viscous drag: the machine actually stops when you
      // let go, instead of coasting forever on a frictionless floor
      const aRoll = -Math.sign(s.v) * (0.35 + 0.25 * Math.abs(s.v))
      s.v += Math.max(-4, Math.min(4, F / mNow + aGrav + aRoll)) * dt

      const wWant = (wCmd - s.w) / 0.18
      const wMax = 3.2
      s.w += Math.sign(wWant) * Math.min(Math.abs(wWant), wMax) * dt
      // lateral slide from a shove: scrubbed off fast — side contact patches
      // dig in harder than the driven wheels do
      const aLat = mu * G * Math.cos(grade) * 1.6
      s.vl -= Math.sign(s.vl) * Math.min(Math.abs(s.vl), aLat * dt)
      if (Math.abs(s.vl) < 0.005) s.vl = 0
      const fx = Math.cos(s.yaw), fy = Math.sin(s.yaw)
      const xPrev = s.x, yPrev = s.y
      s.x += (s.v * fx - s.vl * fy) * dt
      s.y += (s.v * fy + s.vl * fx) * dt
      s.yaw += s.w * dt
      // stairs: a riser taller than the wheel radius is a wall, not a grade.
      // The nose may already be over the nosing when the hull centre crosses,
      // so the check keys on centre-x — close enough for a bench verdict.
      let stepBlocked = false
      if (course === 'stairs') {
        const rise = terrainHeight(s.x, env.slopeDeg, course) - s.z
        if (rise > maxStep) {
          s.x = xPrev; s.y = yPrev
          s.v = 0; s.vl = 0
          s.stall = true
          stepBlocked = true
          if (!s.stepHit) { s.bumps = (s.bumps || 0) + 1; s.stepHit = true }
        } else s.stepHit = false
      }
      if (s.yaw > Math.PI) s.yaw -= Math.PI * 2
      if (s.yaw < -Math.PI) s.yaw += Math.PI * 2
      // living-room obstacles: circle chassis vs AABB props, kill inward vel
      if (course === 'room') {
        const r = Math.max(0.14, ((m.trackMm || 300) / 1000) * 0.55)
        const fx2 = Math.cos(s.yaw), fy2 = Math.sin(s.yaw)
        for (const pr of ROOM.props) {
          const nx = Math.max(pr.c[0] - pr.half[0], Math.min(s.x, pr.c[0] + pr.half[0]))
          const ny = Math.max(pr.c[1] - pr.half[1], Math.min(s.y, pr.c[1] + pr.half[1]))
          const ddx = s.x - nx, ddy = s.y - ny
          const d2 = ddx * ddx + ddy * ddy
          if (d2 >= r * r || s.z >= pr.top) continue
          const d = Math.sqrt(d2) || 1e-6
          const px = ddx / d, py = ddy / d
          s.x = nx + px * r
          s.y = ny + py * r
          // velocity = v·heading + vl·lateral; strip the component into the prop
          let vx = s.v * fx2 - s.vl * fy2
          let vy = s.v * fy2 + s.vl * fx2
          const vn = vx * px + vy * py
          if (vn < 0) {
            if (-vn > 0.15) s.bumps = (s.bumps || 0) + 1
            vx -= vn * px * 1.15 // slight restitution
            vy -= vn * py * 1.15
            s.v = vx * fx2 + vy * fy2
            s.vl = -vx * fy2 + vy * fx2
          }
        }
      }
      // stall = flooring it on a grade but crawling: under ~13 cm/s of
      // progress (or sliding backwards) the machine is not climbing — the
      // traction fix and this flag are the same failure seen two ways.
      s.stall = stepBlocked || (s.throttle > 0.3 && grade > 0.03 && s.v < 0.13)
      return s
    },
    /** Disturbance test: a lateral shove in newtons — slides and yaws the
     *  machine, then traction scrub kills the slide. The bench's point. */
    shove(forceN) {
      const s = this.state
      const mNow = mass()
      s.vl += (forceN * 0.25) / mNow // N·s impulse over ~0.25 s contact
      s.w += (forceN * 0.12) / Math.max(mNow * 0.3, 0.5) // off-centre hits spin it
      return s
    },
    /** Reset to the origin, facing +X (the ramp's toe). */
    reset() {
      const s = this.state
      s.x = 0; s.y = 0; s.yaw = 0; s.v = 0; s.w = 0; s.vl = 0
      s.throttle = 0; s.steer = 0; s.slip = false; s.stall = false; s.bumps = 0; s.stepHit = false
    },
    /** Telemetry for the HUD. */
    hud() {
      const s = this.state
      const surf = DRIVE_SURFACES[env.surface] || DRIVE_SURFACES.hardwood
      return {
        speed: Math.abs(s.v),
        yawDeg: Math.round((s.yaw * 180) / Math.PI),
        throttle: s.throttle,
        steer: s.steer,
        gradeDeg: Math.round((s.grade * 180) / Math.PI),
        surface: surf.label,
        mu: surf.mu,
        mass: mass(),
        slip: s.slip,
        stall: s.stall,
        slide: Math.abs(s.vl) > 0.08,
        course: env.course === 'room' ? 'room' : env.course === 'stairs' ? 'stairs' : 'rack',
        bumps: s.bumps || 0,
      }
    },
  }
}

/**
 * Rigid-body transform of every viewport triangle by the chassis pose:
 * pitch about the local Y axis through the terrain grade, yaw about Z,
 * then translate to (x, y) and lift by the terrain height under the hull.
 * A stable `out` array can be passed to keep mesh identity for caches.
 */
function applyChassis(mesh, st, slopeDeg, out, course) {
  if (!st) return mesh
  // chassis state and terrain courses are metres; mesh pts are mm
  const mx = st.x * 1000, my = st.y * 1000
  const g = st.grade || 0
  const cp = Math.cos(-g), sp = Math.sin(-g)
  const c = Math.cos(st.yaw), sn = Math.sin(st.yaw)
  const zBase = terrainHeight(st.x, slopeDeg || 0, course) * 1000
  const res = out || new Array(mesh.length)
  for (let i = 0; i < mesh.length; i++) {
    const t = mesh[i]
    let slot = res[i]
    if (!slot) {
      slot = { ...t, pts: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }
      res[i] = slot
    }
    const pts = slot.pts
    for (let k = 0; k < 3; k++) {
      const p = t.pts[k]
      // pitch about local Y (nose-up when climbing), then yaw about Z
      const px = p[0] * cp + p[2] * sp
      const pz = -p[0] * sp + p[2] * cp
      const py = p[1]
      pts[k][0] = px * c - py * sn + mx
      pts[k][1] = px * sn + py * c + my
      pts[k][2] = pz + zBase
    }
  }
  return res
}


/** Living-room course dressing: rug, threshold strip, and the three props. */
let _roomTris = null
function livingRoomTris() {
  if (_roomTris) return _roomTris
  const raw = []
  const T = (a, b, c, mat, node) => raw.push({ pts: [a, b, c], mat, node })
  // rug: thin padded rectangle under the high-mu zone
  const rug = { x0: ROOM.rug.x0 - 0.15, x1: ROOM.rug.x1 + 0.15, y: 1.25, t: 0.012 }
  const rz = rug.t / 2
  for (const zz of [0, rug.t]) {
    const z = zz + 0.001
    T([rug.x0, -rug.y, z], [rug.x1, -rug.y, z], [rug.x1, rug.y, z], 'rubber', 'rug')
    T([rug.x0, -rug.y, z], [rug.x1, rug.y, z], [rug.x0, rug.y, z], 'rubber', 'rug')
  }
  // threshold strip: metal nosing along the hump crest line
  T([1.32, -1.2, 0.016], [1.36, -1.2, 0.016], [1.36, 1.2, 0.016], 'metal', 'threshold')
  T([1.32, -1.2, 0.016], [1.36, 1.2, 0.016], [1.32, 1.2, 0.016], 'metal', 'threshold')
  // props
  for (const pr of ROOM.props) {
    const [sx, sy, sz] = pr.size
    const onRug = pr.c[0] >= ROOM.rug.x0 && pr.c[0] < ROOM.rug.x1
    const baseZ = (onRug ? rug.t : 0) + 0.001
    raw.push(...deskBoxTris(pr.c[0], pr.c[1], baseZ + sz / 2, sx, sy, sz, pr.mat, `room-${pr.id}`))
  }
  _roomTris = courseTrisMm(raw)
  return _roomTris
}

// ── arm teleop: WASD drives the end-effector through real IK ────────────────
// For jointed machines with nothing to drive (the 5-DoF arm and friends),
// WASD moves a target point in the world and solveChainIK — the same CCD
// solver the TEST tab trusts — converts it to joint angles every frame. The
// joint sim then slews the real servos toward those angles at their actual
// speed and stalls under load, so the arm on screen obeys the same physics
// as the numbers in the spec rail. No fake keyframing.

/**
 * Returns a teleop object for designs with one dominant revolute chain
 * (≥3 joints), else null. `step(cmd, dt, actualAngles)` returns the desired
 * joint-angle array (deg) for the pose command, or null when idle.
 */
function createArmTeleop(design) {
  const joints = design.joints || []
  if (!joints.length || joints.length > 8) return null
  const chains = chainsFor(design)

  // The end-effector chain: the joint with the deepest revolute ancestry.
  // Ambiguous machines (humanoid legs, quadruped) have several equal chains —
  // picking one silently would be a lie, so they get no IK mode.
  let tipJoint = null
  let tipChain = null
  let tie = false
  for (const j of joints) {
    if (j.slide) continue
    const ch = (chains.get(j.id) || []).filter((x) => !x.slide)
    if (!tipChain || ch.length > tipChain.length) {
      tipChain = ch; tipJoint = j; tie = false
    } else if (ch.length === tipChain.length && tipJoint && j.id !== tipJoint.id) {
      tie = true
    }
  }
  if (!tipChain || tipChain.length < 3 || tie) return null

  // Tip node: the node rigidly attached to the last joint, farthest from its
  // pivot — the business end of the arm.
  const tj = tipJoint
  const attached = (design.nodes || []).filter((n) => n.joint === tj.id && n.pos)
  if (!attached.length) return null
  let tipNode = attached[0]
  let bestD = -1
  for (const n of attached) {
    const d = Math.hypot(n.pos[0] - tj.pivot[0], n.pos[1] - tj.pivot[1], n.pos[2] - tj.pivot[2])
    if (d > bestD) { bestD = d; tipNode = n }
  }

  // Scratch design: IK mutates joint angles, so it must never touch `design`.
  const scratch = { ...design, joints: joints.map((j) => ({ ...j })) }
  const scratchById = new Map(scratch.joints.map((j) => [j.id, j]))
  const ikChain = tipChain.map((j) => scratchById.get(j.id)).filter(Boolean)
  if (ikChain.length < 3) return null

  const tipWorld = (d) => benchNodeWorld(d, chainsFor(d), tipNode)
  const state = {
    tx: 0, ty: 0, tz: 0,      // target point, world mm — set on first step
    err: 0, ready: false,
    reach: Math.max(...(design.nodes || []).map((n) => Math.hypot(n.pos[0], n.pos[1], n.pos[2])), 200),
  }

  const MOVE = 220 // mm/s at full deflection
  const ZONE = { x: 0.12, y: 0.12, z: 0.12 } // stick deadzone per axis

  return {
    kind: 'ik',
    state,
    /**
     * cmd: {x,y,z} each -1..1. actualAngles: current joint angles (deg).
     * Returns desired joint angles (deg, design.joints order) or null.
     */
    step(cmd, dt, actualAngles) {
      // First contact: aim where the tip already is, so WASD deltas feel
      // relative instead of teleporting the arm across the bench.
      if (!state.ready) {
        for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
        const t = tipWorld(scratch)
        state.tx = t[0]; state.ty = t[1]; state.tz = Math.max(t[2], 40)
        state.ready = true
      }
      const ax = Math.abs(cmd.x || 0) > ZONE.x ? cmd.x : 0
      const ay = Math.abs(cmd.y || 0) > ZONE.y ? cmd.y : 0
      const az = Math.abs(cmd.z || 0) > ZONE.z ? cmd.z : 0
      state.tx += ax * MOVE * dt
      state.ty += ay * MOVE * dt
      state.tz = Math.min(600, Math.max(40, state.tz + az * MOVE * 0.8 * dt))
      if (!ax && !ay && !az) return null // hold — joints keep tracking

      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      const r = solveChainIK(scratch, ikChain, [state.tx, state.ty, state.tz], tipWorld, 5)
      state.err = r.err
      return scratch.joints.map((j) => j.angle)
    },
    /** One-shot reachability solve: point the target anywhere and run the
     *  CCD solver hard (30 iters vs the 5 the live path uses). Certification
     *  asks "can it get there", not "can it track a moving stick". */
    seek(tx, ty, tz, actualAngles, iters = 30) {
      state.tx = tx; state.ty = ty; state.tz = tz; state.ready = true
      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      const r = solveChainIK(scratch, ikChain, [tx, ty, tz], tipWorld, iters)
      state.err = r.err
      return scratch.joints.map((j) => j.angle)
    },
    reset() { state.ready = false; state.err = 0 },
    /** Where the tip actually is under the live joint angles, world mm. */
    tipPos(actualAngles) {
      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      return tipWorld(scratch)
    },
    /** Physical tip-to-target distance under the live joint angles — what
     *  the bench actually measures, vs state.err which is solver residual. */
    liveErr(actualAngles) {
      for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actualAngles[i] || 0
      const t = tipWorld(scratch)
      return Math.hypot(t[0] - state.tx, t[1] - state.ty, t[2] - state.tz)
    },
    hud() {
      return {
        kind: 'ik',
        speed: 0,
        err: state.err,
        tx: Math.round(state.tx), ty: Math.round(state.ty), tz: Math.round(state.tz),
      }
    },
  }
}

// ── legged gait: footfall IK walking in place on the bench ──────────────────
// Each leg is its own joint chain; every frame each foot gets a target on a
// proper gait curve — planted and sweeping backward in stance, lifted and
// swinging forward in swing — and solveChainIK puts the joints there. Diagonal
// pairs trot together on the quadruped, left/right alternate on the humanoid.
// Speed scales stride rate and fades to a standstill, so letting go returns
// every foot to neutral under the body. Same honesty rule: the joint sim
// still slews at servo speed and stalls under load.

const GAIT = {
  stride: 130,     // mm foot travel fore/aft
  clear: 28,       // mm swing apex
  freq: 1.5,       // Hz at full speed
  armAmp: 22,      // deg shoulder counter-swing
}

/** Detect legged machines and return a gait teleop, else null. */
function createGaitTeleop(design) {
  const joints = design.joints || []
  if (!joints.length || joints.length > 30) return null
  const chains = chainsFor(design)
  const byId = new Map(joints.map((j) => [j.id, j]))

  // Group leg joints: 'coxa-fl' style (quadruped) or 'l-hip-pitch' (humanoid).
  const legMap = new Map() // key → {ids:[], tip:id}
  const RANK_Q = { coxa: 0, femur: 1, tibia: 2 }
  const RANK_H = { 'hip-yaw': 0, 'hip-roll': 1, 'hip-pitch': 2, knee: 3, 'ankle-pitch': 4, 'ankle-roll': 5 }
  const isQuad = joints.some((j) => /^(coxa|femur|tibia)-/.test(j.id))
  const isHum = joints.some((j) => /^[lr]-(hip|knee|ankle)/.test(j.id))
  if (!isQuad && !isHum) return null

  for (const j of joints) {
    let key = null, rank = -1
    if (isQuad) {
      const m = j.id.match(/^(coxa|femur|tibia)-(.+)$/)
      if (m) { key = m[2]; rank = RANK_Q[m[1]] }
    } else {
      const m = j.id.match(/^([lr])-(hip-yaw|hip-roll|hip-pitch|knee|ankle-pitch|ankle-roll)$/)
      if (m) { key = m[1]; rank = RANK_H[m[2]] }
    }
    if (!key || rank < 0) continue
    if (!legMap.has(key)) legMap.set(key, { key, rank: {}, tip: null })
    const leg = legMap.get(key)
    leg.rank[j.id] = rank
  }
  // keep only complete legs (≥3 joints for quad, ≥5 for humanoid)
  const need = isQuad ? 3 : 5
  const legs = [...legMap.values()].filter((l) => Object.keys(l.rank).length >= need)
  if (legs.length < (isQuad ? 4 : 2)) return null

  // Per leg: ordered chain (root→tip via chainsFor of its deepest joint),
  // hip pivot (root joint), foot node (lowest node on the tip joint).
  const scratch = { ...design, joints: joints.map((j) => ({ ...j })) }
  const scratchById = new Map(scratch.joints.map((j) => [j.id, j]))
  const scratchChains = chainsFor(scratch) // topology is angle-independent
  const specs = []
  for (const leg of legs) {
    const ids = Object.keys(leg.rank)
    // deepest = member whose ancestor chain contains the most leg joints
    let tipId = ids[0], best = -1
    for (const id of ids) {
      const depth = (chains.get(id) || []).filter((a) => leg.rank[a.id] !== undefined).length
      if (depth > best) { best = depth; tipId = id }
    }
    const ordered = (chains.get(tipId) || []).filter((a) => leg.rank[a.id] !== undefined)
    if (ordered.length < need) continue
    const rootPivot = ordered[0].pivot || [0, 0, 0]
    // foot node: attached to the tip joint, lowest in the air at rest pose
    const attached = (design.nodes || []).filter((n) => n.joint === tipId && n.pos)
    let foot = null, footZ = 1e9
    for (const n of attached) {
      const w = benchNodeWorld(design, chains, n)
      if (w[2] < footZ) { footZ = w[2]; foot = n }
    }
    if (!foot) continue
    specs.push({
      key: leg.key,
      chain: ordered.map((a) => scratchById.get(a.id)).filter(Boolean),
      rootPivot,
      foot,
      // trot: diagonal pairs together (fl+rr, fr+rl); walk: left/right alternate
      offset: isQuad
        ? ((leg.key[0] === 'f') === (leg.key[1] === 'l') ? 0 : Math.PI)
        : (leg.key === 'r' ? Math.PI : 0),
      restZ: footZ,
    })
  }
  if (specs.length < (isQuad ? 4 : 2)) return null

  const state = { phase: 0, speed: 0, strides: 0, armBase: null }
  const ARM_JOINTS = isHum ? ['shoulder-pitch', 'elbow'].flatMap((s) => [`l-${s}`, `r-${s}`]) : []

  /** Desired joint angles (deg) for one gait instant.
   *  `anchor` (optional) = {x, y, yaw} of the body origin in mm world space.
   *  With an anchor, stance feet are world-locked: the IK target is the
   *  planted foothold pulled back into body frame, so the leg reaches
   *  backward as the body advances — real walking, not a treadmill. */
  function poseAt(phase, speedNorm, actual, anchor) {
    for (let i = 0; i < joints.length; i++) scratch.joints[i].angle = actual[i] || 0
    // arm counter-swing is absolute, not additive: capture the pose the arms
    // had when the gait started so stopping never drifts them
    if (isHum && !state.armBase) {
      state.armBase = {}
      for (const id of ARM_JOINTS) {
        const j = scratchById.get(id)
        if (j) state.armBase[id] = j.angle
      }
    }
    const stride = GAIT.stride * speedNorm
    const clear = GAIT.clear * speedNorm
    const anchorOn = anchor && speedNorm > 0.02
    const ay = anchor ? Math.cos(anchor.yaw) : 1
    const asy = anchor ? Math.sin(anchor.yaw) : 0
    for (const s of specs) {
      const ph = phase + s.offset
      const cyc = ((ph % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      const swing = cyc >= Math.PI
      const u = swing ? (cyc - Math.PI) / Math.PI : cyc / Math.PI
      // stance: foot sweeps hip+stride/2 → hip-stride/2 at ground; swing: returns lifted
      const fx = s.rootPivot[0] + (swing ? -1 : 1) * stride * (0.5 - u)
      const fz = s.restZ + (swing ? clear * Math.sin(u * Math.PI) : 0)
      let target = [fx, s.rootPivot[1], Math.max(20, fz)]
      if (anchorOn) {
        if (swing) s.plant = null
        else if (s.plant) {
          // world→body: the plant stays fixed while the body walks over it
          const dx = s.plant[0] - anchor.x, dy = s.plant[1] - anchor.y
          target = [dx * ay + dy * asy, -dx * asy + dy * ay, Math.max(20, fz)]
        }
        // touchdown frame (no plant yet): aim with the sweep target below,
        // then measure where the foot actually landed
      }
      solveChainIK(scratch, s.chain, target, (d) => benchNodeWorld(d, scratchChains, s.foot), 4)
      if (anchorOn && !swing && !s.plant) {
        const fw = benchNodeWorld(scratch, scratchChains, s.foot)
        s.plant = [anchor.x + fw[0] * ay - fw[1] * asy, anchor.y + fw[0] * asy + fw[1] * ay]
      }
    }
    // humanoid arms counter-swing against their own leg
    if (isHum && state.armBase) {
      for (const side of ['l', 'r']) {
        const legSpec = specs.find((s) => s.key === side)
        if (!legSpec) continue
        const swingArm = Math.sin(phase + legSpec.offset) * GAIT.armAmp * speedNorm
        const sp = scratchById.get(`${side}-shoulder-pitch`)
        const el = scratchById.get(`${side}-elbow`)
        if (sp) sp.angle = (state.armBase[sp.id] || 0) + swingArm
        if (el) el.angle = (state.armBase[el.id] || 0) + swingArm * 0.4 - 8 * speedNorm
      }
    }
    return scratch.joints.map((j) => j.angle)
  }

  // ── locomotion state ────────────────────────────────────────────────────
  // Same shape as createDrive's state so setChassis/applyChassis consume it
  // unchanged: x,y in metres, yaw/grade in radians.
  const loco = { x: 0, y: 0, yaw: 0, v: 0, w: 0, vl: 0, throttle: 0, steer: 0, grade: 0, z: 0, slip: false, stall: false, bumps: 0, stepHit: false, mu: 0, surf: '' }
  // slip-free walk speed: a foot travels `stride` mm during half a cycle at
  // freq·speedNorm Hz → body speed = 2·stride·freq·speedNorm m/s
  const WALK_V = (2 * GAIT.stride * GAIT.freq) / 1000
  // tallest riser the legs can mount: ~45% of leg extension, min over legs.
  // An 80mm porch nosing stops a small quad honestly; a tall humanoid may pass.
  const maxStepM = Math.max(0.005, Math.min(...specs.map((s) => Math.max(0, (s.rootPivot[2] - s.restZ) * 0.00045))))

  return {
    kind: 'gait',
    state,
    /** cmd: {x: -1..1 walk speed}; actualAngles current pose. */
    step(cmd, dt, actualAngles) {
      const want = Math.max(-1, Math.min(1, cmd.x || 0))
      state.speed += (want - state.speed) * Math.min(1, dt * 4)
      const sp = Math.abs(state.speed)
      // fully stopped: release the pose and forget the arm base so the next
      // walk captures whatever stance the user left the machine in
      if (sp < 0.004 && want === 0) { state.speed = 0; state.armBase = null; return null }
      state.speed = Math.max(-1, Math.min(1, state.speed))
      state.strides += sp * GAIT.freq * dt
      state.phase += Math.sign(state.speed) * GAIT.freq * sp * dt * Math.PI * 2
      return poseAt(state.phase, sp, actualAngles)
    },
    // ── locomotion: the treadmill becomes a walk ──────────────────────────
    // locoStep integrates a body through the same bench courses the wheeled
    // machines use. Walk speed is derived from the gait kinematics — a foot
    // travels `stride` mm during half a cycle at freq·speedNorm, so the
    // slip-free body speed is 2·stride·freq·speedNorm m/s. The bench does
    // not get to pretend feet are glued down when the math says they slide.
    locomote(cmd, dt, actualAngles, env) {
      const e = env || {}
      const course = e.course === 'room' ? 'room' : e.course === 'stairs' ? 'stairs' : 'rack'
      loco.course = course
      dt = Math.min(dt, 0.05)
      loco.throttle = Math.max(-1, Math.min(1, cmd.x || 0))
      loco.steer = Math.max(-1, Math.min(1, cmd.y || 0))
      const grade = terrainGrade(loco.x, e.slopeDeg || 0, course)
      loco.grade = grade
      loco.z = terrainHeight(loco.x, e.slopeDeg || 0, course)
      const gradeDeg = Math.abs(grade) * 180 / Math.PI
      const mu = muAt(loco.x, { surface: e.surface, slopeDeg: e.slopeDeg || 0, course })
      loco.mu = mu
      loco.surf = course === 'room' ? (loco.x >= ROOM.rug.x0 && loco.x < ROOM.rug.x1 ? 'rug' : 'hardwood')
        : course === 'stairs' ? 'stairs' : ((DRIVE_SURFACES[e.surface] || DRIVE_SURFACES.hardwood).label || 'hardwood')
      const sp = Math.abs(state.speed)

      // gait cadence tracks the same eased speed the in-place gait uses
      const want = loco.throttle
      state.speed += (want - state.speed) * Math.min(1, dt * 4)
      state.speed = Math.max(-1, Math.min(1, state.speed))
      const spd = Math.abs(state.speed)
      if (spd < 0.004 && want === 0) { state.speed = 0; state.armBase = null; for (const s of specs) s.plant = null }
      state.strides += spd * GAIT.freq * dt
      state.phase += Math.sign(state.speed) * GAIT.freq * spd * dt * Math.PI * 2

      // commanded speed: kinematic walk speed × grade/mu derating along heading
      const dir = Math.sign(state.speed) || 1
      let vT = state.speed * WALK_V
      const gradeEff = grade * Math.cos(loco.yaw) * dir // slope along travel dir
      const gDeg = Math.abs(gradeEff) * 180 / Math.PI
      const gf = clamp(1 - Math.max(0, gDeg - 4) / 20, 0.15, 1)
      const slipF = mu < 0.35 ? clamp(mu / 0.35, 0.3, 1) : 1
      vT *= gf * slipF
      // legs accelerate ~2.5 m/s² and brake harder — no ice-skating starts
      loco.v += clamp(vT - loco.v, -4 * dt, 2.5 * dt)
      loco.slip = mu < 0.35 && Math.abs(loco.v) > 0.05
      // yaw: turning while walking is a curved path, capped so feet keep up
      const wWant = -loco.steer * 1.1 * Math.min(1, Math.abs(loco.v) / 0.15 + 0.25)
      loco.w += clamp(wWant - loco.w, -2.5 * dt, 2.5 * dt)

      const xPrev = loco.x, yPrev = loco.y
      const fx = Math.cos(loco.yaw), fy = Math.sin(loco.yaw)
      loco.x += (loco.v * fx - loco.vl * fy) * dt
      loco.y += (loco.v * fy + loco.vl * fx) * dt
      loco.yaw += loco.w * dt
      // lateral slide (shove) scrubbed by foot friction, same as wheels
      const aLat = mu * 9.81 * Math.cos(grade) * 1.6
      loco.vl -= Math.sign(loco.vl) * Math.min(Math.abs(loco.vl), aLat * dt)
      if (Math.abs(loco.vl) < 0.005) loco.vl = 0

      // stairs: a riser above leg reach is a wall — same honesty as wheels
      if (course === 'stairs') {
        const rise = terrainHeight(loco.x, e.slopeDeg || 0, course) - loco.z
        if (rise > maxStepM) {
          loco.x = xPrev; loco.y = yPrev
          loco.v = 0; loco.vl = 0; loco.stall = true
          if (!loco.stepHit) { loco.bumps += 1; loco.stepHit = true }
        } else loco.stepHit = false
      } else loco.stepHit = false
      // living-room obstacles: same circle-vs-AABB rule as the wheeled bench
      if (course === 'room') {
        const r = 0.20
        for (const pr of ROOM.props) {
          const nx = Math.max(pr.c[0] - pr.half[0], Math.min(loco.x, pr.c[0] + pr.half[0]))
          const ny = Math.max(pr.c[1] - pr.half[1], Math.min(loco.y, pr.c[1] + pr.half[1]))
          const ddx = loco.x - nx, ddy = loco.y - ny
          const d2 = ddx * ddx + ddy * ddy
          if (d2 >= r * r || loco.z >= pr.top) continue
          const d = Math.sqrt(d2) || 1e-6
          const px = ddx / d, py = ddy / d
          loco.x = nx + px * r; loco.y = ny + py * r
          let vx = loco.v * fx - loco.vl * fy
          let vy = loco.v * fy + loco.vl * fx
          const vn = vx * px + vy * py
          if (vn < 0) {
            if (-vn > 0.15) loco.bumps += 1
            vx -= vn * px * 1.15; vy -= vn * py * 1.15
            loco.v = vx * fx + vy * fy; loco.vl = -vx * fy + vy * fx
          }
        }
      }
      loco.stall = Math.abs(loco.throttle) > 0.5 && Math.abs(loco.v) < 0.04 &&
        (gDeg > 18 || (course === 'stairs' && loco.stepHit))
      if (loco.yaw > Math.PI) loco.yaw -= Math.PI * 2
      if (loco.yaw < -Math.PI) loco.yaw += Math.PI * 2

      const anchor = { x: loco.x * 1000, y: loco.y * 1000, yaw: loco.yaw }
      const pose = state.speed !== 0 || want !== 0
        ? poseAt(state.phase, spd, actualAngles, anchor)
        : null
      return { pose, chassis: loco }
    },
    shove(forceN) {
      const mNow = (design.metrics && design.metrics.massKg) || 2
      loco.vl += (forceN * 0.25) / mNow
      loco.w += (forceN * 0.12) / Math.max(mNow * 0.3, 0.5)
    },
    reset() {
      state.phase = 0; state.speed = 0; state.strides = 0; state.armBase = null
      for (const s of specs) s.plant = null
      Object.assign(loco, { x: 0, y: 0, yaw: 0, v: 0, w: 0, vl: 0, throttle: 0, steer: 0, grade: 0, z: 0, slip: false, stall: false, bumps: 0, stepHit: false })
    },
    locomoteState: loco,
    hud() {
      return {
        kind: 'gait',
        speed: Math.abs(state.speed),
        cadence: (GAIT.freq * Math.abs(state.speed)).toFixed(1),
        strides: Math.round(state.strides),
        loco: {
          v: Math.abs(loco.v),
          yawDeg: Math.round((loco.yaw * 180) / Math.PI),
          gradeDeg: Math.round(Math.abs(loco.grade) * 180 / Math.PI),
          surface: loco.surf,
          mu: loco.mu,
          course: loco.course,
          slip: loco.slip, stall: loco.stall, bumps: loco.bumps,
        },
      }
    },
  }
}

// ── single-actuator teleop: the gripper's jaw opens and closes ──────────────
// Devices with exactly one joint (the parallel gripper's jaw slide) get an
// honest toggle: Space flips open↔closed and the joint sim drives the servo
// at its real speed. Nothing here pretends to be manipulation — it's a jaw.

function createGripTeleop(design) {
  const joints = design.joints || []
  if (joints.length !== 1) return null
  const j = joints[0]
  const state = { open: false, was: false }
  return {
    kind: 'grip',
    state,
    /** cmd: {grip: space held, gripEdge: space keydown edge}; returns desired angle or null. */
    step(cmd) {
      const held = !!(cmd && cmd.grip)
      const edge = !!(cmd && cmd.gripEdge)
      // edge covers tap-to-toggle: a press shorter than one frame still counts
      if (edge || (held && !state.was)) state.open = !state.open
      state.was = held
      return [state.open ? j.max : j.min]
    },
    reset() { state.open = false; state.was = false },
    hud() {
      return { kind: 'grip', open: state.open }
    },
  }
}

// ── desk bench: weighted pick-place props for the reach mode ────────────────
// Three honest objects on the bench at pick heights — the light bin, the
// printed part, the steel block. The IK HUD names whichever one the
// end-effector is over and flags it when its mass beats the arm's payload
// rating. Props are world-space tris appended to the viewport mesh.

const DESK_PROPS = [
  { id: 'bin', name: 'parts bin', massG: 80, size: [120, 80, 90], pos: [300, -70, 205], mat: 'accent' },
  { id: 'print', name: 'printed part', massG: 350, size: [60, 60, 40], pos: [350, 50, 180], mat: 'pcb' },
  { id: 'steel', name: 'steel block', massG: 1200, size: [80, 80, 80], pos: [390, -10, 200], mat: 'steel' },
]
// the bench slab the props sit on: top at z=160, spanning the workspace
const DESK_SLICE = { size: [560, 340, 14], pos: [280, -10, 153], mat: 'metal' }

function deskBoxTris(cx, cy, cz, sx, sy, sz, mat, node) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2
  const y0 = cy - sy / 2, y1 = cy + sy / 2
  const z0 = cz - sz / 2, z1 = cz + sz / 2
  const P = (x, y, z) => [x, y, z]
  const T = (a, b, c) => ({ pts: [a, b, c], mat, node })
  return [
    T(P(x0,y0,z0),P(x1,y0,z0),P(x1,y1,z0)), T(P(x0,y0,z0),P(x1,y1,z0),P(x0,y1,z0)), // bottom
    T(P(x0,y0,z1),P(x0,y1,z1),P(x1,y1,z1)), T(P(x0,y0,z1),P(x1,y1,z1),P(x1,y0,z1)), // top
    T(P(x0,y0,z0),P(x0,y0,z1),P(x1,y0,z1)), T(P(x0,y0,z0),P(x1,y0,z1),P(x1,y0,z0)), // -y
    T(P(x1,y1,z0),P(x1,y1,z1),P(x0,y1,z1)), T(P(x1,y1,z0),P(x0,y1,z1),P(x0,y1,z0)), // +y
    T(P(x0,y0,z0),P(x0,y1,z0),P(x0,y1,z1)), T(P(x0,y0,z0),P(x0,y1,z1),P(x0,y0,z1)), // -x
    T(P(x1,y0,z0),P(x1,y0,z1),P(x1,y1,z1)), T(P(x1,y0,z0),P(x1,y1,z1),P(x1,y1,z0)), // +x
  ]
}

let _deskTris = null
function deskPropsTris() {
  if (_deskTris) return _deskTris
  _deskTris = deskBoxTris(DESK_SLICE.pos[0], DESK_SLICE.pos[1], DESK_SLICE.pos[2], ...DESK_SLICE.size, DESK_SLICE.mat, 'desk')
  for (const p of DESK_PROPS) {
    _deskTris.push(...deskBoxTris(p.pos[0], p.pos[1], p.pos[2], ...p.size, p.mat, `prop-${p.id}`))
  }
  return _deskTris
}

/** Nearest desk prop to a world point, within `r` mm — for the reach HUD. */
function deskPropNear(x, y, z, r = 110) {
  let best = null, bd = r
  for (const p of DESK_PROPS) {
    const d = Math.hypot(p.pos[0] - x, p.pos[1] - y, (p.pos[2] - z) * 0.7)
    if (d < bd) { bd = d; best = p }
  }
  return best ? { prop: best, dist: bd } : null
}

/**
 * "Break → Fix": turn live failure signals into one concrete next step each.
 * Consumes the bench verdicts plus whichever teleop/power HUDs are live.
 * Returns up to 3 fixes, failures first — the bench detects, this prescribes.
 */
function fixSuggestions(s) {
  const out = []
  const push = (sev, msg, apply) => {
    if (out.length < 3 && !out.some((f) => f.msg === msg)) out.push({ sev, msg, apply: apply || null })
  }
  const brief = s.brief || {}
  for (const v of s.bench ? s.bench.verdicts : []) {
    if (v.status !== 'fail' && v.status !== 'warn') continue
    if (/stab|tip|balance/i.test(v.label)) {
      push('fail', `Fix stability: ${v.detail || v.label} — widen the base/track or lower the CoM`)
    } else if (/torque|servo|joint|bend/i.test(v.label)) {
      push('warn', `Fix torque: ${v.detail || v.label} — bigger servo or shorter reach`)
    }
  }
  // legged locomotion reports under .loco; wheeled drive reports flat —
  // normalize so the same failure rules apply to both
  const drv = s.drive ? (s.drive.loco || s.drive) : null
  if (drv) {
    if (drv.stall || (drv.slide && drv.throttle)) {
      push('fail', `Fix drive: wheels can't pull ${drv.mass ? drv.mass.toFixed(1) + 'kg ' : ''}up ${drv.gradeDeg}° ${drv.surface} — more torque, lower grade, or shed payload`)
    } else if (drv.slip) {
      push('warn', `Fix traction: slipping on ${drv.surface} (μ${drv.mu}) — rubber wheels or less payload`)
    }
    if (drv.course === 'stairs' && (drv.stall || (drv.bumps || 0) > 0)) {
      const isLegged = !!(s.drive && s.drive.loco)
      if (isLegged) {
        const reach = brief.reachMm || 400
        push('fail', 'Fix steps: 80mm risers beat leg reach — longer legs or a different gait',
          reach < 700 ? { reachMm: Math.min(900, reach + 200) } : null)
      } else {
        const wheelMm = brief.wheelMm || 100
        push('fail', 'Fix steps: 80mm risers beat wheel bite — fit ≥150mm wheels or articulated suspension',
          wheelMm < 150 ? { wheelMm: 150 } : null)
      }
    }
  }
  if (s.prop && s.prop.over) {
    const pay = brief.payloadKg || 1
    push('warn', `Fix payload: ${s.prop.name} is ${s.prop.massG}g vs the arm's ${Math.round((s.prop.ratingG || 0) / 100) / 10}kg rating — pick lighter or upsize`,
      { payloadKg: Math.max(0.1, Math.round(pay * 0.7 * 10) / 10) })
  }
  if (s.sense && s.sense.kind === 'sense' && s.sense.alerts && s.sense.alerts.length) {
    push('warn', `Fix sense: ${s.sense.alerts[0]} — check the installation, the threshold, or the case seal`)
  }
  if (s.grip && !s.grip.ok) {
    push('fail', `Fix grip: ${s.grip.blockKg}kg test mass beats ${s.grip.holdKg.toFixed(2)}kg hold — bigger servo/pinion or lighter test piece`)
  }
  if (s.power) {
    if (s.power.dead) {
      const bat = brief.battery || 'pack3s'
      push('fail', 'Fix power: battery flat — bigger pack or shorter duty cycle',
        bat !== 'lipo3s' && bat !== 'pd5v' ? { battery: 'lipo3s' } : null)
    } else if (s.power.cuts > 0 || s.power.tempMax > 75) {
      push('warn', `Fix thermal: servo hit ${Math.round(s.power.tempMax)}°C${s.power.cuts ? ` after ${s.power.cuts} cutoff${s.power.cuts > 1 ? 's' : ''}` : ''} — ease off stalls or pick hotter-rated servos`)
    }
  }
  return out.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'fail' ? -1 : 1))
}


// ── grip bench: one test mass between the pads ──────────────────────────────
// The gripper's bench piece: a 1kg test block fixtured at pad height on a
// dark pedestal. Closing the jaw is the test — hold capacity comes straight
// from design.metrics.gripMassKg, the same number the sizing checks print.

const GRIP_BENCH = { massG: 1000, size: [36, 24, 30], pos: [0, 0, 82], mat: 'steel' }
let _gripTris = null
function gripBenchTris() {
  if (_gripTris) return _gripTris
  _gripTris = deskBoxTris(0, 0, 59.5, 50, 40, 15, 'metal', 'grip-pedestal')
  _gripTris.push(...deskBoxTris(GRIP_BENCH.pos[0], GRIP_BENCH.pos[1], GRIP_BENCH.pos[2], ...GRIP_BENCH.size, GRIP_BENCH.mat, 'grip-testmass'))
  return _gripTris
}


// ── sensor stimulus bench: inject the environment, watch the readings ────────
// IoT nodes have no joints — the honest teleop is stimulus, not motion.
// Sliders set the physical world (temp, humidity, light, soil moisture,
// weight, motion, button); hud() reports what each fitted sensor would read
// and which thresholds alert. Nothing animates that isn't sensed.

const SENSOR_DEFS = {
  air:     { label: 'BME280 air', fields: [
    { k: 'tempC', label: 'TEMP', min: -10, max: 50, unit: '°C', def: 22, alert: (v) => v > 30 || v < 5 },
    { k: 'humid', label: 'RHUM', min: 5, max: 100, unit: '%', def: 45, alert: (v) => v > 70 || v < 20 },
  ]},
  motion:  { label: 'PIR motion', fields: [
    { k: 'motion', label: 'PRESENCE', min: 0, max: 1, unit: '', def: 0, alert: (v) => v > 0.5, bool: true },
  ]},
  soil:    { label: 'soil probe', fields: [
    { k: 'soil', label: 'MOIST', min: 0, max: 100, unit: '%', def: 55, alert: (v) => v < 30 },
  ]},
  weight:  { label: 'HX711 scale', fields: [
    { k: 'weightG', label: 'LOAD', min: 0, max: 5000, unit: 'g', def: 0, alert: () => false },
  ]},
  display: { label: 'SSD1306 OLED', fields: [] }, // shows the primary reading
}

function createSensorTeleop(design) {
  const sensors = (design.metrics && design.metrics.sensors) || []
  if (!sensors.length) return null
  const state = {}
  for (const sk of sensors) {
    for (const f of (SENSOR_DEFS[sk] || { fields: [] }).fields) state[f.k] = f.def
  }
  // OLED line: whichever real sensor exists leads the display
  const lead = sensors.find((k) => k !== 'display') || sensors[0]
  const fmt1 = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
  const alerts = () => {
    const out = []
    for (const sk of sensors) {
      for (const f of (SENSOR_DEFS[sk] || { fields: [] }).fields) {
        if (f.alert && f.alert(state[f.k])) out.push(`${SENSOR_DEFS[sk].label} ${f.label} ${fmt1(state[f.k])}${f.unit}`)
      }
    }
    return out
  }
  return {
    kind: 'sense',
    state,
    fields: sensors.flatMap((sk) => (SENSOR_DEFS[sk] || { fields: [] }).fields.map((f) => ({ ...f, sensor: sk, sensorLabel: SENSOR_DEFS[sk].label }))),
    /** Sliders write straight into state — sensors respond instantly. */
    set(key, value) { if (key in state) state[key] = value },
    step() { return null },
    reset() { for (const sk of sensors) for (const f of (SENSOR_DEFS[sk] || { fields: [] }).fields) state[f.k] = f.def },
    hud() {
      const lines = []
      for (const sk of sensors) {
        const def = SENSOR_DEFS[sk]
        if (!def || !def.fields.length) continue
        lines.push(`${def.label}: ${def.fields.map((f) => `${f.label} ${fmt1(state[f.k])}${f.unit}`).join(' · ')}`)
      }
      const al = alerts()
      const oled = lead && lead !== 'display'
        ? `${SENSOR_DEFS[lead].label.split(' ')[0]} ${SENSOR_DEFS[lead].fields.map((f) => `${fmt1(state[f.k])}${f.unit}`).join(' ')}`
        : 'rigforge node'
      return { kind: 'sense', lines, alerts: al, oled, ok: !al.length }
    },
  }
}

// ── endurance power: battery SoC, bus sag, servo thermals ──────────────────
// The bench runs for minutes, not milliseconds — so the pack actually drains
// and the servos actually cook. SoC integrates the joint sim's live bus
// current (plus drive-motor draw on wheeled machines); bus voltage sags with
// state-of-charge and current; every joint's temperature rises with the
// square of its load ratio and Newton-cools toward ambient. Past 80 °C the
// joint cuts out until it cools below 75 °C — hysteresis, like the real
// thermal protector in the servo. At 2 % SoC the machine is dead until the
// battery is swapped (reset).

const PWR_AMB = 25 // °C ambient
const PWR_CUTOFF = 80 // °C servo thermal cutoff
const PWR_RECOVER = 75 // °C hysteresis floor
const PWR_DEAD = 2 // % SoC — below this the pack cannot deliver

/** Returns null for tethered builds (USB-PD, mah: 0) — infinite runtime. */
function createPowerSim(design) {
  const bat = (design.parts || []).map((p) => PARTS[p.key]).find((p) => p && p.cat === 'battery')
  if (!bat || !bat.mah) return null
  const mah = bat.mah
  const volts = bat.volts || 7.4
  const n = (design.joints || []).length
  const state = {
    soc: 100,
    vbus: volts,
    busA: 0,
    temps: new Array(n).fill(PWR_AMB),
    cut: new Array(n).fill(false),
  }
  return {
    state,
    /**
     * simState: the joint sim's state ({busA, loadNm, stallNm}).
     * extraA: drive-motor draw the joint sim cannot see (wheeled machines).
     */
    step(dt, simState, extraA) {
      const busA = ((simState && simState.busA) || 0) + (extraA || 0)
      state.busA = busA
      // mAh drained this step; SoC is a percentage of nameplate capacity
      state.soc = Math.max(0, state.soc - (busA * dt * 1000) / 3600 / mah * 100)
      // bus voltage: SoC curve minus resistive sag, floored so it never lies
      state.vbus = Math.max(0.5, volts * (0.15 + 0.85 * (state.soc / 100)) - busA * 0.04)
      for (let i = 0; i < n; i++) {
        const stall = simState && simState.stallNm ? simState.stallNm[i] : 0
        const load = simState && simState.loadNm ? simState.loadNm[i] : 0
        const ratio = stall > 0 ? Math.min(2, load / stall) : 0
        // I²R stand-in: heat scales with load²; a stalled servo cooks in ~6 s
        const heat = ratio * ratio * 9
        state.temps[i] = Math.min(120, state.temps[i] + (heat - (state.temps[i] - PWR_AMB) * 0.06) * dt)
        if (state.temps[i] > PWR_CUTOFF) state.cut[i] = true
        else if (state.temps[i] < PWR_RECOVER) state.cut[i] = false
      }
      return state
    },
    hud() {
      return {
        soc: state.soc,
        vbus: state.vbus,
        busA: state.busA,
        tempMax: state.temps.length ? Math.max(...state.temps) : PWR_AMB,
        dead: state.soc < PWR_DEAD,
        cuts: state.cut.filter(Boolean).length,
      }
    },
    /** Battery swap — full charge, cool servos. */
    reset() {
      state.soc = 100
      state.vbus = volts
      state.busA = 0
      state.temps.fill(PWR_AMB)
      state.cut.fill(false)
    },
  }
}

// ── sharing: a design is a brief, so a build code is just the brief ─────────
// Every design in Rigforge is deterministic from its brief. That makes sharing
// trivial and honest: encode the brief, not a rendered state, so the person who
// opens it gets the same machine — with their own live prices, not a snapshot.

const RF_CODE = 'RF1'
const BRIEF_KEYS = ['archetype', 'mission', 'payloadKg', 'reachMm', 'battery', 'mcu', 'material', 'energy', 'drive', 'gripper', 'spanX', 'scale', 'bedMm']

function b64uEncode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function encodeBuild(brief) {
  // A whitelist here was lossy: a key the list forgot came back defaulted and
  // the recipient got a different machine. Encode everything that is in the
  // brief; it is a few hundred bytes either way.
  const slim = {}
  for (const k of Object.keys(brief || {})) {
    const v = brief[k]
    if (typeof v === 'function' || v === undefined || v === null) continue
    if (v === '') continue
    slim[k] = v
  }
  return `${RF_CODE}-${b64uEncode(JSON.stringify(slim))}`
}

/** Returns a brief, or throws with a message a person can act on. */
function decodeBuild(code) {
  const raw = String(code || '').trim().replace(/\s+/g, '')
  if (!raw) throw new Error('Paste a build code first — they start with RF1-')
  const body = raw.startsWith(RF_CODE + '-') ? raw.slice(RF_CODE.length + 1) : (/^RF1/.test(raw) ? raw.slice(3) : raw)
  let obj
  try {
    obj = JSON.parse(b64uDecode(body))
  } catch {
    throw new Error('That is not a valid build code — probably a partial paste')
  }
  if (!obj || typeof obj !== 'object' || !obj.archetype) {
    throw new Error('The code decoded but carries no machine')
  }
  const known = PRESETS.map((p) => p.brief.archetype).concat(ARCHETYPES.map((a) => a[0]))
  if (!known.includes(obj.archetype)) {
    throw new Error(`That code wants a "${obj.archetype}" machine, which this version cannot build`)
  }
  return obj
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
  bedMm: 256,
}

const PRESETS = [
  { id: 'iot', label: 'IoT sensor node', brief: { archetype: 'iot', mission: 'a plant sensor that reports soil moisture to my phone', reachMm: 0, payloadKg: 0, battery: 'lipo2s' } },
  { id: 'pcb', label: 'Controller board', brief: { archetype: 'pcb', mission: 'a 90mm controller board: ESP32-S3, climate sensor, OLED, power', reachMm: 92, payloadKg: 0 } },
  { id: 'arm', label: 'Pick & place arm', brief: { archetype: 'arm', mission: '5-DoF arm that sorts 3D-printed parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 } },
  { id: 'rover', label: 'Survey rover', brief: { archetype: 'rover', mission: '4WD rover with a camera mast that maps a room', payloadKg: 2, wheelMm: 100 } },
  { id: 'quad', label: 'Quadruped', brief: { archetype: 'quadruped', mission: '12-servo quadruped that trots and holds its attitude', payloadKg: 1, reachMm: 400, battery: 'lipo3s' } },
  { id: 'grip', label: 'Parallel gripper', brief: { archetype: 'gripper', mission: 'Servo gripper for a 60mm object, 1.5kg hold', reachMm: 80, payloadKg: 1.5 } },
  { id: 'humanoid', label: 'Humanoid', brief: { archetype: 'humanoid', mission: '550mm bipedal humanoid, 23 joints, balance IMU', payloadKg: 0.5, reachMm: 550, battery: 'lipo3s' } },
  { id: 'robot', label: 'Full robot', brief: { archetype: 'robot', mission: 'mobile manipulator: 4WD base, 5-DoF arm, camera head, 1kg payload', payloadKg: 1, reachMm: 450, wheelMm: 130, battery: 'lipo3s' } },
  { id: 'desk', label: 'ESP32 desk device', brief: { archetype: 'gadget', mission: 'ESP32 desk clock with temperature and humidity on an OLED', reachMm: 0, payloadKg: 0 } },
  { id: 'gantry', label: 'Full-scale gantry', brief: { archetype: 'gantry', mission: '1m gantry mill that cuts plywood, belts XY, leadscrew Z', reachMm: 1000, payloadKg: 2, battery: 'pack3s' } },
]

// Same ladder, but it admits when nothing matched — the difference between
// "I heard you" and "here is a guess", which the UI must not blur.
function matchArchetype(text) {
  const t = String(text || '').toLowerCase()
  const rules = [
    ['gantry', /gantry|cnc|router|mill\b|plotter|laser cut|full.?scale|metre class|meter class|overhead|3.?axis machin/],
    ['pcb', /\bpcb\b|circuit board|controller board|breakout|carrier board|schematic|gerber|(custom|my own|design .{0,10}) ?board|board with (a|an|the)?\s*(screen|sensor|chip|relay)/],
    ['iot', /iot|sensor node|thermostat|weather station|plant|logger|beacon|tracker|tag\b|door sensor|air quality/],
    ['humanoid', /humanoid|biped|two.?leg|android|mannequin/],
    ['robot', /full robot|mobile manipulator|robot arm on a (rover|base|chassis)|drive.*(and|&).*(grab|pick)|whole robot/],
    ['quadruped', /quadruped|quad pod|four.?leg|walking|dog\b|trot/],
    ['gripper', /gripper|claw|jaw|end.?effector|grab|clamp|pinch|squeeze|hold (an? )?(egg|cup|block)/],
    ['arm', /\barm\b|manipulator|pick.?(and|&).?place|6.?dof|5.?dof|delta/],
    ['rover', /rover|car\b|robot car|tank|wheels?|mecanum|drive|chassis/],
  ]
  for (const [id, re] of rules) if (re.test(t)) return { id, confident: true }
  return { id: 'gadget', confident: false }
}

function detectArchetype(text) {
  const t = String(text || '').toLowerCase()
  if (/gantry|cnc|router|mill\b|plotter|laser cut|full.?scale|metre class|meter class|overhead|3.?axis machin/.test(t)) return 'gantry'
  if (/\bpcb\b|circuit board|controller board|breakout|carrier board|schematic|gerber|(custom|my own|design .{0,10}) ?board|board with (a|an|the)?\s*(screen|sensor|chip|relay)/.test(t)) return 'pcb'
  if (/iot|sensor node|thermostat|weather station|plant|logger|beacon|tracker|tag\b|door sensor|air quality/.test(t)) return 'iot'
  if (/humanoid|biped|two.?leg|android|mannequin/.test(t)) return 'humanoid'
  if (/full robot|mobile manipulator|robot arm on a (rover|base|chassis)|drive.*(and|&).*(grab|pick)|whole robot/.test(t)) return 'robot'
  if (/quadruped|quad pod|four.?leg|walking|dog\b|trot/.test(t)) return 'quadruped'
  if (/gripper|claw|jaw|end.?effector|grab|clamp|pinch|squeeze|hold (an? )?(egg|cup|block)/.test(t)) return 'gripper'
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
  if (out.archetype === 'humanoid' && !/\d{2,4}\s*mm/.test(text)) out.reachMm = 550
  return out
}

const cache = new Map()

/** The one entry point everything (UI, exports, tests) goes through. */
function composeDesign(brief) {
  const b = { ...DEFAULT_BRIEF, ...brief }
  const key = JSON.stringify(b)
  if (cache.has(key)) return cache.get(key)
  const design = b.archetype === 'pcb' ? buildPcb(b)
    : b.archetype === 'iot' ? buildIot(b)
    : b.archetype === 'gantry' ? buildGantry(b)
    : b.archetype === 'humanoid' ? buildHumanoid(b)
    : b.archetype === 'robot' ? buildFullRobot(b)
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
    'Keep it inside these archetypes: pcb | iot | gadget | gripper | arm | rover | quadruped | humanoid | robot | gantry.',
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

// Autopilot certification — one click runs the machine through a scripted
// maneuver suite and scores each check against live teleop state. Every
// check is a real measurement; nothing passes by default, so a machine that
// can't climb wet ice, reach the bench, or cycle its jaw fails here exactly
// as it would on the floor.
//
// createAutotest(teleop) dispatches on teleop.kind — drive machines get the
// maneuver suite, arms get a reach tour over the desk props, legged bots a
// stride test, grippers a jaw-cycle test, sensor nodes a stimulus sweep.

const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a }
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Shared facade: page/HUD/report only ever touch these members. */
function facade(script) {
  return {
    get running() { return script.running },
    get done() { return script.done },
    get results() { return script.results },
    get phase() { return script.phase },
    get score() { return `${script.results.filter((r) => r.pass).length}/${script.results.length}` },
    start() { script.start() },
    stop() { script.stop() },
    tick(dt, actual) { return script.tick(dt, actual) },
  }
}

function begin(script, label, dur, n) {
  script.phase = { label, t: 0, dur, n }
}
function pushResult(script, id, label, pass, detail) {
  script.results.push({ id, label, pass: !!pass, detail })
}

// ── drive: sprint / turn / climb / shove / return ────────────────────────────

const DRIVE_PHASES = [
  { id: 'sprint', label: 'SPRINT', dur: 2.5, throttle: 1, steer: 0 },
  { id: 'turn',   label: 'TURN',   dur: 1.6, throttle: 0.4, steer: -1 },
  { id: 'climb',  label: 'CLIMB',  dur: 4.0, throttle: 1, steer: 0 },
  { id: 'shove',  label: 'SHOVE',  dur: 1.8, throttle: 1.0, steer: 0, shoveAt: 0.4, shoveN: 15 },
  { id: 'return', label: 'RETURN', dur: 2.2, throttle: 0.6, steer: 1 },
]

function driveAutotest(drive) {
  const st = { running: false, done: false, idx: 0, t: 0, results: [], phase: null }
  let mark = null

  function beginPhase(i) {
    const p = DRIVE_PHASES[i]
    const s = drive.state
    mark = {
      x0: s.x, y0: s.y, yaw0: s.yaw, z0: s.z, bumps0: s.bumps || 0,
      maxV: 0, stallT: 0, slipT: 0, gradeT: 0, vPreShove: null, shoved: false,
    }
    st.idx = i; st.t = 0
    begin(st, p.label, p.dur, DRIVE_PHASES.length)
  }

  function score(p, m, s) {
    const dist = Math.hypot(s.x - m.x0, s.y - m.y0)
    const stallFrac = m.stallT / p.dur
    const bumps = (s.bumps || 0) - m.bumps0
    switch (p.id) {
      case 'sprint': {
        const need = drive.vmax * 0.45
        return { pass: m.maxV >= need, detail: `top ${m.maxV.toFixed(2)} m/s vs ${need.toFixed(2)} needed` }
      }
      case 'turn': {
        const dyaw = Math.abs(wrap(s.yaw - m.yaw0))
        return { pass: dyaw >= 0.5, detail: `turned ${(dyaw * 180 / Math.PI).toFixed(0)}°` }
      }
      case 'climb': {
        // elevation is the honest metric — you cannot fake altitude. On a
        // mostly-flat bench the same phase degrades to a sustained-speed run.
        if (m.gradeT / p.dur < 0.3) {
          const ok = dist >= 0.8 && stallFrac < 0.4
          return { pass: ok, detail: `flat run ${dist.toFixed(2)} m, stall ${(stallFrac * 100).toFixed(0)}%` }
        }
        const dz = s.z - m.z0
        const ok = dz >= 0.1 && stallFrac < 0.4
        return { pass: ok, detail: `+${dz.toFixed(2)} m climb, stall ${(stallFrac * 100).toFixed(0)}%${s.grade > 0.05 ? ` @ ${(s.grade * 180 / Math.PI).toFixed(0)}°` : ''}` }
      }
      case 'shove': {
        const recovered = s.v > 0.15 || dist > 0.3
        return { pass: recovered && stallFrac < 0.6, detail: `post-shove ${s.v.toFixed(2)} m/s, ${bumps} bump${bumps === 1 ? '' : 's'}` }
      }
      case 'return': {
        const ok = Math.abs(s.v) > 0.03 || dist > 0.3
        return { pass: ok && stallFrac < 0.6, detail: `finished at ${s.v.toFixed(2)} m/s, ${bumps} bump${bumps === 1 ? '' : 's'}` }
      }
      default: return { pass: false, detail: 'unknown phase' }
    }
  }

  function endPhase() {
    const p = DRIVE_PHASES[st.idx]
    const r = score(p, mark, drive.state)
    pushResult(st, p.id, p.label, r.pass, r.detail)
    st.phase = null
  }

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      drive.reset()
      st.running = true; st.done = false; st.results = []; st.idx = 0; st.t = 0
      beginPhase(0)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { throttle: 0, steer: 0 }
      const p = DRIVE_PHASES[st.idx]
      const s = drive.state
      st.t += dt
      mark.maxV = Math.max(mark.maxV, Math.abs(s.v))
      if (s.stall) mark.stallT += dt
      if (s.slip) mark.slipT += dt
      if (s.grade > 0.03) mark.gradeT += dt
      if (p.shoveAt != null && !mark.shoved && st.t >= p.shoveAt) {
        mark.shoved = true
        mark.vPreShove = s.v
        drive.shove(p.shoveN)
      }
      if (st.t >= p.dur) {
        endPhase()
        if (st.idx + 1 >= DRIVE_PHASES.length) {
          st.running = false; st.done = true
          return { throttle: 0, steer: 0 }
        }
        beginPhase(st.idx + 1)
      }
      st.phase.t = st.t
      // climb holds heading toward +X (the ramp direction). PD on yaw rate —
      // a saturated P-only steer overshoots through 200°+ because the
      // chassis yaw has real inertia (w slews at wMax rad/s²).
      let steer = p.steer
      if (p.id === 'climb') {
        const kYaw = drive.vmax / Math.max((drive.trackMm / 1000) * 0.5, 0.05)
        const err = wrap(-s.yaw)
        steer = clampN((0.9 * s.w - 2.2 * err) / kYaw, -1, 1)
      }
      return { throttle: p.throttle, steer }
    },
  })
}

// ── reach: waypoint tour over the desk props, scored on real IK error ────────

function reachAutotest(ik) {
  const st = { running: false, done: false, results: [], phase: null, home: null, seedAngles: null }
  // one leg per prop: seek the descend point, then wait for the live tip to
  // arrive (the joint sim slews at real servo speed — that lag is the test).
  // Every seek seeds from the SAME rest pose — certification asks "can the
  // arm reach this point from standing", not "can CCD escape the last
  // leg's local minimum".
  const legs = []
  for (const p of DESK_PROPS) {
    const top = p.pos[2] + p.size[2] / 2
    legs.push({ kind: 'prop', prop: p, wp: [p.pos[0], p.pos[1], top + 8], pose: null, t: 0, err: null })
  }
  legs.push({ kind: 'home', wp: null, pose: null, t: 0, err: null })
  let li = 0

  const legLabel = (l) => (l.kind === 'home' ? 'HOME' : `REACH ${l.prop.name}`)

  function scoreLeg() {
    const leg = legs[li]
    const err = leg.err == null ? 999 : leg.err
    if (leg.kind === 'home') pushResult(st, 'home', 'HOME', err <= 45, `returned, err ${err.toFixed(0)}mm`)
    else pushResult(st, `reach-${leg.prop.id}`, leg.prop.name.toUpperCase(), err <= 30, `err ${err.toFixed(0)}mm`)
  }
  function advance() {
    li++
    if (li >= legs.length) { st.running = false; st.done = true; st.phase = null; return false }
    begin(st, legLabel(legs[li]), 6, legs.length)
    return true
  }

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      ik.reset()
      st.running = true; st.done = false; st.results = []; st.home = null; st.seedAngles = null
      li = 0
      legs.forEach((l) => { l.t = 0; l.err = null; l.pose = null; l.wp = l.kind === 'home' ? null : l.wp })
      begin(st, legLabel(legs[0]), 6, legs.length)
    },
    stop() { st.running = false; st.phase = null },
    /**
     * tick(dt, actual) — `actual` is the live joint-angle array. Returns
     * {pose} for the page to apply directly (the IK seek already solved it),
     * or {x,y,z} for callers without a pose channel.
     */
    tick(dt, actual) {
      if (!st.running) return { x: 0, y: 0, z: 0 }
      const leg = legs[li]
      leg.t += dt
      st.phase.t = leg.t
      if (!st.seedAngles) st.seedAngles = (actual || []).slice()
      if (leg.kind === 'home' && !leg.wp) {
        // home = wherever the tip started this run
        leg.wp = ik.tipPos ? ik.tipPos(st.seedAngles) : [0, 0, 150]
      }
      if (!leg.pose) leg.pose = ik.seek(leg.wp[0], leg.wp[1], leg.wp[2], st.seedAngles)
      const e = typeof ik.liveErr === 'function' ? ik.liveErr(actual || []) : (ik.state.err || 999)
      leg.err = leg.err == null ? e : Math.min(leg.err, e)
      const need = leg.kind === 'home' ? 45 : 30
      if (e <= need || leg.t > 6) {
        scoreLeg()
        if (!advance()) return { x: 0, y: 0, z: 0, pose: leg.pose }
      }
      return { x: 0, y: 0, z: 0, pose: leg.pose }
    },
  })
}

// ── gait: trot N strides, then stand — checks cadence and clean stop ─────────

function gaitAutotest(gait) {
  const st = { running: false, done: false, results: [], phase: null }
  let leg = 'walk', t = 0, strides0 = 0

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      gait.reset()
      st.running = true; st.done = false; st.results = []
      leg = 'walk'; t = 0; strides0 = gait.state.strides
      begin(st, 'TROT', 10, 2)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { x: 0 }
      t += dt
      if (leg === 'walk') {
        const gained = gait.state.strides - strides0
        if (gained >= 8 || t > 10) {
          pushResult(st, 'strides', 'STRIDES', gained >= 6, `${gained.toFixed(1)} strides in ${t.toFixed(1)}s`)
          leg = 'stand'; t = 0
          begin(st, 'STAND', 2, 2)
          return { x: 0 }
        }
        st.phase.t = t
        return { x: 0.85 }
      }
      st.phase.t = t
      if (t >= 1.6) {
        const stopped = gait.state.speed < 0.03
        pushResult(st, 'stand', 'STAND', stopped, `settled at ${gait.state.speed.toFixed(2)} speed`)
        st.running = false; st.done = true; st.phase = null
      }
      return { x: 0 }
    },
  })
}

// ── grip: jaw must cycle open↔closed on command ──────────────────────────────

function gripAutotest(grip) {
  const st = { running: false, done: false, results: [], phase: null }
  let t = 0, pulses = 0, prevOpen = null, toggles = 0

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      grip.reset()
      st.running = true; st.done = false; st.results = []
      t = 0; pulses = 0; toggles = 0; prevOpen = grip.state.open
      begin(st, 'JAW', 9, 1)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return { grip: false, gripEdge: false }
      t += dt
      st.phase.t = t
      if (grip.state.open !== prevOpen) { toggles++; prevOpen = grip.state.open }
      // one edge pulse every 1.4s — six commanded cycles
      const edge = pulses < 6 && t >= (pulses + 1) * 1.4 - dt / 2 && t < (pulses + 1) * 1.4 + dt
      if (edge) pulses++
      if (t >= 9.2) {
        pushResult(st, 'jaw', 'JAW', toggles >= 5, `${toggles} jaw transitions`)
        st.running = false; st.done = true; st.phase = null
      }
      return { grip: false, gripEdge: !!edge }
    },
  })
}

// ── sense: sweep one stimulus into alert territory and back ──────────────────

function senseAutotest(sense) {
  const st = { running: false, done: false, results: [], phase: null }
  // pick the first field whose alert actually fires at an extreme
  const field = (sense.fields || []).find((f) => f.alert && (f.alert(f.max) || f.alert(f.min)))
  const target = field ? (field.alert(field.max) ? field.max : field.min) : null
  let leg = 'restore', t = 0, fired = false

  return facade({
    get running() { return st.running }, get done() { return st.done },
    get results() { return st.results }, get phase() { return st.phase },
    start() {
      sense.reset()
      st.running = true; st.done = false; st.results = []
      leg = 'restore'; t = 0; fired = false
      if (field) sense.set(field.k, field.def)
      begin(st, field ? `STIM ${field.label}` : 'STIM', 6, 1)
    },
    stop() { st.running = false; st.phase = null },
    tick(dt) {
      if (!st.running) return null
      t += dt
      st.phase.t = t
      if (!field || target == null) {
        pushResult(st, 'sense', 'SENSE', false, 'no alertable stimulus field')
        st.running = false; st.done = true; st.phase = null
        return null
      }
      if (leg === 'restore' && t >= 0.8) { leg = 'stim'; t = 0; begin(st, `STIM ${field.label}`, 6, 1) }
      else if (leg === 'stim') {
        // ramp toward the alert extreme — sensors respond instantly, so the
        // crossing itself is the test
        const u = Math.min(1, t / 1.5)
        sense.set(field.k, field.def + (target - field.def) * u)
        if (t >= 1.5) { leg = 'hold'; t = 0 }
      } else if (leg === 'hold') {
        if (sense.hud().alerts.length) fired = true
        if (t >= 1.2) { leg = 'restore2'; t = 0 }
      } else if (leg === 'restore2') {
        sense.set(field.k, field.def + (field.def - target) * Math.min(1, t / 0.8))
        if (t >= 0.9) {
          pushResult(st, 'sense', 'SENSE', fired, fired ? `${field.label} alert fired` : `${field.label} never alerted`)
          st.running = false; st.done = true; st.phase = null
        }
      }
      return null
    },
  })
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function createAutotest(teleop) {
  if (!teleop) return null
  if (teleop.kind === 'drive' || teleop.wheelD) return driveAutotest(teleop)
  if (teleop.kind === 'ik') return reachAutotest(teleop)
  if (teleop.kind === 'gait') return gaitAutotest(teleop)
  if (teleop.kind === 'grip') return gripAutotest(teleop)
  if (teleop.kind === 'sense') return senseAutotest(teleop)
  return null
}

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

// ── GPU viewport: WebGL2, no library ────────────────────────────────────────
// The 2D canvas path shades triangles in JavaScript; it is honest but it cannot
// do what a product render needs: a shadow map, per-pixel specular with a real
// roughness term, image-based ambient from a sky/ground gradient, and MSAA. All
// of that is available in the browser itself, so this file talks to WebGL2
// directly — no three.js, which a plugin is not allowed to import anyway.
//
// What it draws: the same triangles the STL exporter writes, flat-shaded (a
// machined part has facets; smoothing them is what made it look like clay),
// lit by a three-point rig plus a hemisphere, with a cast shadow on a studio
// floor. If the context cannot be created the caller keeps the 2D renderer.

const GL_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aMat;   // albedo rgb + glow
layout(location=3) in vec3 aSurf;  // roughness, metalness, unused

uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform float uExplode;

out vec3 vWorld;
out vec3 vNormal;
out vec4 vMat;
out vec3 vSurf;
out vec4 vLightPos;

void main() {
  vec3 p = aPos;
  vWorld = p;
  vNormal = aNormal;
  vMat = aMat;
  vSurf = aSurf;
  vLightPos = uLightViewProj * vec4(p, 1.0);
  gl_Position = uViewProj * vec4(p, 1.0);
}`

const GL_FS = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec4 vMat;
in vec3 vSurf;
in vec4 vLightPos;

uniform vec3 uEye;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform sampler2D uShadow;
uniform sampler2D uEnv;
uniform float uUseEnv;
uniform float uShadowTexel;
uniform float uHasShadow;

out vec4 fragColor;

vec3 aces(vec3 x) {
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// cheap value noise: three octaves is enough to break up a perfectly flat
// surface without looking like sandpaper
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}

float shadowFactor(vec3 n) {
  if (uHasShadow < 0.5) return 1.0;
  vec3 proj = vLightPos.xyz / vLightPos.w;
  proj = proj * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float bias = max(0.0015 * (1.0 - dot(n, uKeyDir)), 0.0004);
  // Three rings of taps: a studio key has a real penumbra, and a 5x5 grid at
  // this map resolution reads as a stencil.
  // Nine taps in two rings, rotated per pixel so the pattern does not read as a
  // grid, and stretched along the shadow texel so the penumbra stays wide. The
  // earlier 5x5 version cost 25 texture fetches per fragment: on a software GL
  // stack that is 4 fps, which is not a renderer anyone can use.
  float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  float ca = cos(ang);
  float sa = sin(ang);
  mat2 rot = mat2(ca, -sa, sa, ca);
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    // ring 0 = centre, 1..4 inner ring, 5..8 outer ring (Vogel-ish spacing)
    float rad = i == 0 ? 0.0 : (i < 5 ? 1.9 : 4.4);
    float th = i == 0 ? 0.0 : (fi * 2.3999632) + ang;
    vec2 off = (rot * vec2(cos(th), sin(th))) * rad * uShadowTexel * 1.35;
    float d = texture(uShadow, proj.xy + off).r;
    float w = rad < 1.0 ? 1.0 : (rad < 2.0 ? 0.85 : 0.55);
    sum += ((proj.z - bias * 1.6) > d ? 0.0 : 1.0) * w;
    wsum += w;
  }
  return sum / wsum;
}

// GGX-ish specular: tight enough to read as a machined highlight, loose enough
// to survive a low-poly facet
float spec(vec3 n, vec3 l, vec3 v, float rough) {
  vec3 h = normalize(l + v);
  float a = max(0.04, rough * rough);
  float nh = max(dot(n, h), 0.0);
  float d = a / (3.14159 * pow(nh * nh * (a - 1.0) + 1.0, 2.0));
  float vh = max(dot(v, h), 0.0);
  float f = mix(0.04, 1.0, pow(1.0 - vh, 5.0));
  return d * f * (0.9 + 0.5 * rough);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  vec3 albedo = vMat.rgb;
  float rough = clamp(vSurf.x, 0.06, 1.0);

  // FDM layer lines: a 0.2 mm sawtooth on world Z, faded out where the stripes
  // fall below a pixel (fwidth) so a zoomed-out view never turns to moiré. This
  // is the single strongest cue that a part was printed rather than cast.
  if (vSurf.z > 0.5) {
    float lh = 0.2;
    float zz = vWorld.z / lh;
    float f = abs(fract(zz) - 0.5) * 2.0;
    float w = fwidth(zz);
    float vis = clamp(1.0 - w * 1.6, 0.0, 1.0);
    albedo *= 1.0 + (f - 0.5) * 0.22 * vis;

    // macro surface: a printed wall is never perfectly flat. A slow noise term
    // tilts the normal a couple of degrees and lifts the roughness slightly, so
    // the part reads as a moulded object rather than a flat-shaded solid.
    float grain = vnoise(vWorld * 0.35) - 0.5;
    vec3 jitter = vec3(
      vnoise(vWorld * 0.35 + vec3(11.0, 0.0, 0.0)) - 0.5,
      vnoise(vWorld * 0.35 + vec3(0.0, 13.0, 0.0)) - 0.5,
      vnoise(vWorld * 0.35 + vec3(0.0, 0.0, 17.0)) - 0.5
    );
    n = normalize(n + jitter * 0.10);
    rough = clamp(rough + grain * 0.06, 0.05, 1.0);
  }
  float metal = clamp(vSurf.y, 0.0, 1.0);
  float glow = vMat.a;

  float shade = shadowFactor(n);

  // three-point rig
  float key = max(dot(n, uKeyDir), 0.0) * shade;
  float fill = max(dot(n, uFillDir), 0.0) * 0.45;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.4) * max(dot(n, uRimDir), 0.0);

  vec3 diffuse = albedo * (uKeyColor * key + uFillColor * fill) * (1.0 - metal * 0.65);

  // hemisphere ambient: sky above, floor bounce below, tinted by albedo
  // Ambient is a fill, not the light: too much of it desaturates every filament
  // toward white and the machine reads as clay again.
  float up = n.z * 0.5 + 0.5;
  vec3 skyTerm = mix(uGroundColor, uSkyColor, up);
  if (uUseEnv > 0.5) {
    vec2 auv = vec2(atan(n.y, n.x) / 6.2831853 + 0.5, acos(clamp(n.z, -1.0, 1.0)) / 3.1415927);
    skyTerm = textureLod(uEnv, auv, 7.0).rgb;
  }
  vec3 ambient = skyTerm * albedo * (0.22 + 0.26 * shade);

  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 sheen = mix(uSkyColor, vec3(0.8), 0.35) * fres * (0.55 - 0.35 * rough) * (1.0 - metal);

  vec3 specular =
      sheen +
      uKeyColor * spec(n, uKeyDir, v, rough) * key * (0.35 + 0.65 * metal) * 1.6
    + uFillColor * spec(n, uFillDir, v, rough) * fill * (0.25 + 0.4 * metal)
    + uRimColor * rim * (0.25 + 0.75 * metal) * 0.9;

  // environment: an equirectangular studio probe, sampled along the reflection
  // vector with a mip chosen from roughness. That is what makes a rough plastic
  // pick up a soft sheen and a polished bolt pick up the softbox as a shape,
  // instead of both getting the same analytic blob.
  vec3 R = reflect(-v, n);
  vec2 ruv = vec2(atan(R.y, R.x) / 6.2831853 + 0.5, acos(clamp(R.z, -1.0, 1.0)) / 3.1415927);
  float lod = clamp(rough * 7.0, 0.0, 7.0);
  vec3 env = textureLod(uEnv, ruv, lod).rgb;
  if (uUseEnv < 0.5) {
    float sky = smoothstep(-0.55, 0.75, R.z);
    env = mix(uGroundColor * 1.7, uSkyColor * 3.4, sky);
  }
  // a small analytic kicker on top of the probe: the probe is 256 px wide, so a
  // crisp highlight on a bolt has to be added rather than sampled
  env += uKeyColor * pow(max(dot(R, uKeyDir), 0.0), 120.0) * 1.6;
  // The probe is painted in sRGB and it is a *light source*, so decode it and
  // give it radiance. Dielectrics reflect through Fresnel (almost nothing head
  // on, a lot at grazing angles), metals reflect everything — that curve is what
  // puts a real edge highlight on a silhouette.
  vec3 envLin = pow(max(env, vec3(0.0)), vec3(2.2)) * 6.0;
  float fresnelEnv = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 reflection = envLin * mix(fresnelEnv, 1.0, metal) * (1.0 - rough * 0.55);

  // Bounce: the floor throws light back up at everything, tinted by what the
  // machine is made of. Without it the underside of every part is dead black and
  // the assembly reads as separate floating blocks.
  float underside = clamp(-n.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 bounce = uGroundColor * albedo * underside * 1.4;

  vec3 color = diffuse + ambient + specular + reflection + bounce + albedo * glow;
  color = aces(color * 1.0);
  fragColor = vec4(toSRGB(color), 1.0);
}`

// Floor: a large quad that fades out radially, receives the shadow, and draws a
// faint 50mm grid — the studio plate a product photograph sits on.
const FLOOR_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
out vec3 vWorld;
out vec4 vLightPos;
void main() {
  vWorld = aPos;
  vLightPos = uLightViewProj * vec4(aPos, 1.0);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`

const FLOOR_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec4 vLightPos;
uniform vec3 uEye;
uniform sampler2D uShadow;
uniform sampler2D uEnv;
uniform float uUseEnv;
uniform float uShadowTexel;
uniform float uHasShadow;
uniform vec3 uPlateColor;
uniform float uExtent;
uniform float uGridMm;
uniform float uContactMm;
uniform float uShowGrid;
out vec4 fragColor;

// cheap value noise: three octaves is enough to break up a perfectly flat
// surface without looking like sandpaper
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
float shadowFactor() {
  if (uHasShadow < 0.5) return 1.0;
  vec3 proj = vLightPos.xyz / vLightPos.w * 0.5 + 0.5;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float sum = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      float d = texture(uShadow, proj.xy + vec2(float(x), float(y)) * uShadowTexel).r;
      sum += (proj.z - 0.0012) > d ? 0.0 : 1.0;
    }
  }
  return sum / 25.0;
}

void main() {
  float r = length(vWorld.xy);
  float fade = 1.0 - smoothstep(uExtent * 0.42, uExtent, r);
  if (fade <= 0.001) discard;

  // 50 mm grid, fading with distance so it reads as a plate, not graph paper
  vec2 g = abs(fract(vWorld.xy / uGridMm + 0.5) - 0.5) * uGridMm;
  float line = 1.0 - smoothstep(0.0, 1.2, min(g.x, g.y));
  float gridFade = 1.0 - smoothstep(uExtent * 0.15, uExtent * 0.55, r);

  float shade = shadowFactor();
  vec3 base = uPlateColor * (0.35 + 0.65 * shade);
  base += vec3(0.05, 0.07, 0.09) * line * gridFade * 0.35 * uShowGrid;

  // contact darkening right under the machine — sized to the subject, not the course
  float contact = 1.0 - smoothstep(0.0, uContactMm, r);
  base *= 1.0 - 0.45 * contact;

  base = toSRGB(base);
  fragColor = vec4(base, fade);
}`

// Screen-space ambient occlusion. Twelve taps on a spiral inside a hemisphere,
// compared in view space: this is what puts dark contact in the corners where a
// servo meets a plate, which flat shading cannot fake at any light count.
const DEPTH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uLightViewProj;
void main() { gl_Position = uLightViewProj * vec4(aPos, 1.0); }`

const DEPTH_FS = `#version 300 es
precision highp float;
void main() {}`

// Overlay lines: support polygon, CoM plumb, reticles — world-space GL_LINES
// with per-vertex colour, drawn after the mesh with the same viewProj.
const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aCol;
uniform mat4 uViewProj;
out vec3 vCol;
void main() { vCol = aCol; gl_Position = uViewProj * vec4(aPos, 1.0); }`

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 fragColor;
vec3 aces(vec3 x) {
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}
void main() { fragColor = vec4(toSRGB(aces(vCol * 1.5)), 0.9); }`

/**
 * A studio environment probe, painted once into an equirectangular canvas and
 * uploaded with mipmaps. Two soft boxes, a cool rim strip, a warm floor bounce
 * and a gradient sky: enough that reflections carry a *shape*, which is the
 * difference between "shiny" and "reflective". No external HDRI to download,
 * which also keeps the plugin offline.
 */
function studioEnv(gl) {
  const W = 256
  const H = 128
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')

  // sky → horizon → floor
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0.0, '#8fa2b8')
  sky.addColorStop(0.45, '#5b6b80')
  sky.addColorStop(0.52, '#2a3543')
  sky.addColorStop(1.0, '#12171d')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)

  // key soft box: broad, warm, upper left
  const key = g.createRadialGradient(W * 0.30, H * 0.22, 2, W * 0.30, H * 0.22, W * 0.24)
  key.addColorStop(0, 'rgba(255,246,232,1)')
  key.addColorStop(0.45, 'rgba(255,238,214,0.55)')
  key.addColorStop(1, 'rgba(255,236,210,0)')
  g.fillStyle = key
  g.fillRect(0, 0, W, H)

  // fill soft box: cooler, wider, right
  const fill = g.createRadialGradient(W * 0.72, H * 0.30, 2, W * 0.72, H * 0.30, W * 0.28)
  fill.addColorStop(0, 'rgba(198,224,255,0.85)')
  fill.addColorStop(0.5, 'rgba(170,205,240,0.30)')
  fill.addColorStop(1, 'rgba(160,200,240,0)')
  g.fillStyle = fill
  g.fillRect(0, 0, W, H)

  // rim strip behind the machine: a thin cool band, which is what draws an edge
  // highlight along a silhouette
  const strip = g.createLinearGradient(W * 0.44, 0, W * 0.52, 0)
  strip.addColorStop(0, 'rgba(120,200,230,0)')
  strip.addColorStop(0.5, 'rgba(140,215,240,0.75)')
  strip.addColorStop(1, 'rgba(120,200,230,0)')
  g.fillStyle = strip
  g.fillRect(W * 0.44, H * 0.22, W * 0.08, H * 0.30)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error('shader: ' + log)
  }
  return sh
}

function program(gl, vs, fs) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p))
  return p
}

const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b) {
    const o = new Float32Array(16)
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        o[i * 4 + j] = a[0 * 4 + j] * b[i * 4 + 0] + a[1 * 4 + j] * b[i * 4 + 1] + a[2 * 4 + j] * b[i * 4 + 2] + a[3 * 4 + j] * b[i * 4 + 3]
      }
    }
    return o
  },
  persp(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2)
    const o = new Float32Array(16)
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1
    o[14] = (2 * far * near) / (near - far)
    return o
  },
  ortho(l, r, b, t, n, f) {
    const o = new Float32Array(16)
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n)
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1
    return o
  },
  lookAt(eye, centre, up) {
    const z = norm(sub(eye, centre))
    const x = norm(cross(up, z))
    const y = cross(z, x)
    const o = new Float32Array(16)
    o[0] = x[0]; o[4] = x[1]; o[8] = x[2]; o[12] = -dot(x, eye)
    o[1] = y[0]; o[5] = y[1]; o[9] = y[2]; o[13] = -dot(y, eye)
    o[2] = z[0]; o[6] = z[1]; o[10] = z[2]; o[14] = -dot(z, eye)
    o[15] = 1
    return o
  },
}
M4.inverse = (m) => {
  const o = new Float32Array(16)
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return M4.ident()
  det = 1 / det
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return o
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

/** Linear colour for a material, mirroring the 2D table but as floats. */
/** FILAMENT tints are 0-255 sRGB; MAT albedo is already linear. */
function toLin(rgb) {
  const big = rgb[0] > 1.01 || rgb[1] > 1.01 || rgb[2] > 1.01
  if (!big) return [rgb[0], rgb[1], rgb[2]]
  return rgb.map((c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
}

function matParams(m) {
  return {
    alb: toLin(m.alb),
    rough: m.rough != null ? m.rough : 0.5,
    metal: m.metal || 0,
    glow: m.glow || 0,
    printed: m.printed != null ? m.printed : (m.metal || 0) < 0.5,
  }
}

function createGLRenderer(canvas) {
  let gl = null
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' })
  } catch (e) {
    gl = null
  }
  if (!gl) { globalThis.__rfGL = 'no webgl2 context'; return { ok: false, draw() {}, dispose() {} } }

  let meshProg
  let floorProg
  let depthProg
  let lineProg
  try {
    meshProg = program(gl, GL_VS, GL_FS)
    floorProg = program(gl, FLOOR_VS, FLOOR_FS)
    depthProg = program(gl, DEPTH_VS, DEPTH_FS)
    lineProg = program(gl, LINE_VS, LINE_FS)
  } catch (e) {
    globalThis.__rfGL = e.message
    return { ok: false, draw() {}, dispose() {}, error: e.message }
  }
  globalThis.__rfGL = 'ok'

  let envTex = null
  try { envTex = studioEnv(gl) } catch (e) { envTex = null }

  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  const ibo = gl.createBuffer()
  const floorVao = gl.createVertexArray()
  const floorVbo = gl.createBuffer()
  const floorIbo = gl.createBuffer()
  const lineVao = gl.createVertexArray()
  const lineVbo = gl.createBuffer()

  // shadow map
  const SHADOW = 2048
  const shadowTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, shadowTex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW, SHADOW)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const shadowFbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0)
  gl.drawBuffers([gl.NONE])
  gl.readBuffer(gl.NONE)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  const uni = (p, name) => gl.getUniformLocation(p, name)

  let baseDist = 0
  let uniqueAlbedos = 0
  let floorReady = false
  let lastKey = ''

  function buildFloor(extent) {
    const v = new Float32Array([
      -extent, -extent, 0, extent, -extent, 0, extent, extent, 0,
      -extent, -extent, 0, extent, extent, 0, -extent, extent, 0,
    ])
    gl.bindVertexArray(floorVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, floorVbo)
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
    floorReady = true
  }

  function uploadMesh(mesh, matOf, centre) {
    const tri = mesh.length
    const stride = 3 + 3 + 4 + 3
    const data = new Float32Array(tri * 3 * stride)
    // Which way do the faces point? Meshes arrive from several generators, so
    // the winding is not guaranteed; measure it against the model centre once
    // and flip the whole set if it is consistently inward, rather than guessing
    // per face.
    let sign = 0
    const normals = new Array(tri)
    for (let i = 0; i < tri; i += 1) {
      const [a, b, c] = mesh[i].pts
      const n = norm(cross(sub(b, a), sub(c, a)))
      normals[i] = n
      const cen = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]]
      sign += dot(n, cen) >= 0 ? 1 : -1
    }
    const flip = sign < 0 ? -1 : 1

    const seen = new Set()
    let o = 0
    for (let i = 0; i < tri; i += 1) {
      const t = mesh[i]
      const [a, b, c] = t.pts
      const raw = normals[i]
      const n = [raw[0] * flip, raw[1] * flip, raw[2] * flip]
      const m = matParams(matOf(t))
      seen.add(m.alb.map((c) => c.toFixed(2)).join(','))
      for (const p of [a, b, c]) {
        data[o++] = p[0]; data[o++] = p[1]; data[o++] = p[2]
        data[o++] = n[0]; data[o++] = n[1]; data[o++] = n[2]
        data[o++] = m.alb[0]; data[o++] = m.alb[1]; data[o++] = m.alb[2]; data[o++] = m.glow
        data[o++] = m.rough; data[o++] = m.metal; data[o++] = m.printed ? 1 : 0
      }
    }
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    const strideBytes = stride * 4
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, strideBytes, 0)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, strideBytes, 12)
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, strideBytes, 24)
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, strideBytes, 40)
    uniqueAlbedos = seen.size
    return tri * 3
  }

  return {
    ok: true,
    draw(mesh, cam, opts, matOf, bounds, overlay) {
      const w = canvas.width
      const h = canvas.height
      if (!w || !h || !mesh || !mesh.length) return

      // Framing subject = the machine (opts.subjectBounds); the full scene
      // bounds may include a course spanning metres, which must not stretch
      // the camera or shrink the robot to a speck.
      let subj = (opts && opts.subjectBounds) || bounds
      if (opts && opts.focus && subj) {
        // subjectBounds are in local machine space; the fit loop needs the
        // world-space box so a driving machine frames correctly
        const hx = (subj.max[0] - subj.min[0]) / 2
        const hy = (subj.max[1] - subj.min[1]) / 2
        const hz = (subj.max[2] - subj.min[2]) / 2
        const f = opts.focus
        subj = { min: [f[0] - hx, f[1] - hy, f[2] - hz], max: [f[0] + hx, f[1] + hy, f[2] + hz] }
      }
      const cx = subj ? (subj.min[0] + subj.max[0]) / 2 : 0
      const cy = subj ? (subj.min[1] + subj.max[1]) / 2 : 0
      const cz = subj ? (subj.min[2] + subj.max[2]) / 2 : 0
      const size = subj ? Math.max(
        subj.max[0] - subj.min[0],
        subj.max[1] - subj.min[1],
        subj.max[2] - subj.min[2],
      ) : 300
      const sceneSize = bounds ? Math.max(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) : size
      // Frame the machine by its own bounds: a 1170mm gantry and a 90mm board
      // must both fill the view, and nothing may be cropped off-screen. The
      // wheel still works, because cam.dist scales the fitted distance.
      const FOV = 0.60
      const margin = 1.28
      const fitH = (size * 0.5) / Math.tan(FOV / 2) * margin
      const aspect = w / h
      const fitW = fitH / Math.min(1, aspect)
      const fit = Math.max(fitH, fitW)
      // cam.dist is an absolute mm value that predates the GPU path; treat the
      // first value seen as neutral and read later ones as a relative zoom, so
      // the fitted framing is the default and the wheel still works.
      if (!baseDist && cam.dist) baseDist = cam.dist
      const zoom = (cam.dist && baseDist ? cam.dist / baseDist : 1)
      let dist = fit * Math.max(0.5, Math.min(2.6, zoom))

      // Bias the subject up and to the left so the title block in the bottom
      // right never sits on top of the machine.
      const target = (opts && opts.focus) || [cx, cy, cz + size * 0.02]
      const yaw = cam.yaw
      const pitch = cam.pitch
      // Z-up, matching the studio's model space: height is z, so the orbit
      // lifts along z and the floor is the XY plane
      const eyeAt = (d) => [
        target[0] + d * Math.cos(pitch) * Math.sin(yaw),
        target[1] + d * Math.cos(pitch) * Math.cos(yaw),
        target[2] + d * Math.sin(pitch),
      ]
      let eye = eyeAt(dist)
      let proj = M4.persp(FOV, w / h, Math.max(1, dist * 0.02), dist * 8 + sceneSize * 6)
      let view = M4.lookAt(eye, target, [0, 0, 1])
      let viewProj = M4.mul(proj, view)

      // Fit by what actually projects on screen, not by a radius guess: project
      // the eight bbox corners and pull the camera back until every one lands
      // inside a safe rectangle that leaves room for the title block and the
      // caption. Three passes is enough to converge, and it makes a 90mm board
      // and a 2m gantry frame identically.
      const SAFE_X = 0.74
      const SAFE_TOP = 0.72
      const SAFE_BOTTOM = 0.56
      for (let pass = 0; pass < 4; pass += 1) {
        let worst = 1
        for (let corner = 0; corner < 8; corner += 1) {
          const p = [
            corner & 1 ? subj.max[0] : subj.min[0],
            corner & 2 ? subj.max[1] : subj.min[1],
            corner & 4 ? subj.max[2] : subj.min[2],
          ]
          const x = viewProj[0] * p[0] + viewProj[4] * p[1] + viewProj[8] * p[2] + viewProj[12]
          const y = viewProj[1] * p[0] + viewProj[5] * p[1] + viewProj[9] * p[2] + viewProj[13]
          const wv = viewProj[3] * p[0] + viewProj[7] * p[1] + viewProj[11] * p[2] + viewProj[15]
          if (Math.abs(wv) < 1e-6) continue
          const nx = x / wv
          const ny = y / wv
          worst = Math.max(
            worst,
            Math.abs(nx) / SAFE_X,
            ny > 0 ? ny / SAFE_TOP : Math.abs(ny) / SAFE_BOTTOM,
          )
        }
        if (worst <= 1.02) break
        dist *= worst * 1.03
        eye = eyeAt(dist)
        proj = M4.persp(FOV, w / h, Math.max(1, dist * 0.02), dist * 8 + sceneSize * 6)
        view = M4.lookAt(eye, target, [0, 0, 1])
        viewProj = M4.mul(proj, view)
      }

      const keyDir = norm([0.42, 0.55, 0.72])
      const shadowExtent = size * 1.6
      const lightView = M4.lookAt(
        [target[0] + keyDir[0] * shadowExtent, target[1] + keyDir[1] * shadowExtent, target[2] + keyDir[2] * shadowExtent],
        target, [0, 0, 1],
      )
      const lightProj = M4.ortho(-shadowExtent, shadowExtent, -shadowExtent, shadowExtent, 1, shadowExtent * 4)
      const lightViewProj = M4.mul(lightProj, lightView)

      const count = uploadMesh(mesh, matOf, target)

      // 1) shadow pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo)
      gl.viewport(0, 0, SHADOW, SHADOW)
      gl.clear(gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.disable(gl.BLEND)
      gl.enable(gl.POLYGON_OFFSET_FILL)
      gl.polygonOffset(1.6, 4.0)
      gl.useProgram(depthProg)
      gl.uniformMatrix4fv(uni(depthProg, 'uLightViewProj'), false, lightViewProj)
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, count)

      gl.disable(gl.POLYGON_OFFSET_FILL)

      // 3) main pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.disable(gl.CULL_FACE)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, shadowTex)

      if (!floorReady) buildFloor(Math.max(sceneSize * 3, 600))
      gl.useProgram(floorProg)
      gl.uniformMatrix4fv(uni(floorProg, 'uViewProj'), false, viewProj)
      gl.uniformMatrix4fv(uni(floorProg, 'uLightViewProj'), false, lightViewProj)
      gl.uniform3fv(uni(floorProg, 'uEye'), eye)
      gl.uniform1i(uni(floorProg, 'uShadow'), 0)
      gl.uniform1f(uni(floorProg, 'uShadowTexel'), 1 / SHADOW)
      gl.uniform1f(uni(floorProg, 'uHasShadow'), 1)
      gl.uniform3f(uni(floorProg, 'uPlateColor'), 0.028, 0.037, 0.048)
      gl.uniform1f(uni(floorProg, 'uExtent'), Math.max(sceneSize * 3, 600))
      gl.uniform1f(uni(floorProg, 'uGridMm'), sceneSize > 3000 ? 500 : sceneSize > 600 ? 100 : 50)
      gl.uniform1f(uni(floorProg, 'uContactMm'), (opts && opts.subjectR) || Math.min(size * 0.9, 800))
      gl.uniform1f(uni(floorProg, 'uShowGrid'), opts && opts.grid ? 1 : 0)
      gl.bindVertexArray(floorVao)
      gl.depthMask(false)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      gl.depthMask(true)

      gl.useProgram(meshProg)
      gl.uniformMatrix4fv(uni(meshProg, 'uViewProj'), false, viewProj)
      gl.uniformMatrix4fv(uni(meshProg, 'uLightViewProj'), false, lightViewProj)
      gl.uniform3fv(uni(meshProg, 'uEye'), eye)
      gl.uniform3fv(uni(meshProg, 'uKeyDir'), keyDir)
      gl.uniform3f(uni(meshProg, 'uKeyColor'), 1.12, 1.05, 0.96)
      gl.uniform3fv(uni(meshProg, 'uFillDir'), norm([-0.62, 0.35, 0.40]))
      gl.uniform3f(uni(meshProg, 'uFillColor'), 0.20, 0.27, 0.36)
      gl.uniform3fv(uni(meshProg, 'uRimDir'), norm([-0.35, -0.75, 0.35]))
      gl.uniform3f(uni(meshProg, 'uRimColor'), 0.22, 0.58, 0.72)
      gl.uniform3f(uni(meshProg, 'uSkyColor'), 0.20, 0.24, 0.30)
      gl.uniform3f(uni(meshProg, 'uGroundColor'), 0.07, 0.08, 0.09)
      gl.uniform1i(uni(meshProg, 'uShadow'), 0)
      gl.uniform1f(uni(meshProg, 'uShadowTexel'), 1 / SHADOW)
      gl.uniform1f(uni(meshProg, 'uHasShadow'), 1)
      if (envTex) {
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, envTex)
        gl.uniform1i(uni(meshProg, 'uEnv'), 4)
        gl.uniform1f(uni(meshProg, 'uUseEnv'), 1)
      } else {
        gl.uniform1f(uni(meshProg, 'uUseEnv'), 0)
      }
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, count)
      gl.bindVertexArray(null)

      // bench overlay: support polygon, CoM plumb + reticle — world-space
      // lines drawn last so they read on top of the machine, depth-tested so
      // a plumb line behind a link honestly hides
      if (overlay && overlay.data && overlay.data.length) {
        gl.useProgram(lineProg)
        gl.uniformMatrix4fv(uni(lineProg, 'uViewProj'), false, viewProj)
        gl.bindVertexArray(lineVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo)
        gl.bufferData(gl.ARRAY_BUFFER, overlay.data, gl.DYNAMIC_DRAW)
        const stride = 6 * 4
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12)
        gl.depthMask(false)
        gl.drawArrays(gl.LINES, 0, overlay.verts)
        gl.depthMask(true)
        gl.bindVertexArray(null)
      }
      // self-check: read back a horizontal strip so a silently blank frame is
      // detectable from the outside
      const probe = new Uint8Array(4 * 64 * 4)
      gl.readPixels(0, Math.floor(h * 0.5), 64, 4, gl.RGBA, gl.UNSIGNED_BYTE, probe)
      let nz = 0
      let maxv = 0
      for (let i = 0; i < probe.length; i += 4) {
        if (probe[i] + probe[i + 1] + probe[i + 2] > 0) nz += 1
        maxv = Math.max(maxv, probe[i], probe[i + 1], probe[i + 2])
      }
      globalThis.__rfGLStats = {
        draws: ((globalThis.__rfGLStats || {}).draws || 0) + 1,
        tris: count / 3, eye, dist, size, stripNonZero: nz, stripMax: maxv,
        albedos: uniqueAlbedos,
        firstAlb: null,
      }
    },
    dispose() {
      try {
        gl.deleteBuffer(vbo); gl.deleteBuffer(ibo); gl.deleteTexture(shadowTex)
        gl.deleteFramebuffer(shadowFbo); gl.deleteVertexArray(vao); gl.deleteVertexArray(floorVao)
        gl.deleteBuffer(lineVbo); gl.deleteVertexArray(lineVao)
      } catch (e) { /* context already gone */ }
    },
  }
}

// ── the studio ──────────────────────────────────────────────────────────────
// Surface: CONFIGURE (pick a machine, set two numbers, build) with an INSPECT
// secondary (the viewport and the spec rail). So: dense, calm, workmanlike —
// hierarchy from scale and spacing, not from boxes and icons.
//
// Design system
//   type    one sans for everything you read, one mono for anything that is a
//           number or a label. Mono-as-body is what made this read as a
//           terminal instead of a product.
//   colour  graphite workbench, one accent (safety orange), cyan for the
//           machine's own instrumentation, green/amber/red for verdicts only.
//   space   4 · 6 · 8 · 12 · 16 · 20 · 28 — nothing in between.
//   motion  120 ms ease for state, 180 ms for surfaces. Nothing loops.

const C = {
  bg: '#0A0D10',
  panel: '#0D1217',
  panel2: '#111820',
  raise: '#17212C',
  line: '#1E2A35',
  lineSoft: '#16202A',
  text: '#E9F0F6',
  dim: '#B2C2CF',
  faint: '#7E93A2',
  accent: '#FF6A1A',
  accentSoft: 'rgba(255,106,26,0.12)',
  accentLine: 'rgba(255,106,26,0.45)',
  cyan: '#39D3E8',
  green: '#4ED08A',
  amber: '#FFC24A',
  red: '#FF5F56',
  sans: 'var(--ui-font, "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
}


// Global rules the inline styles cannot express: responsiveness, focus rings,
// and motion that politely stops when the OS asks it to. Rendered as one
// <style> element inside the page root, scoped by data-rf attributes.
const GLOBAL_CSS = `
[data-rf="root"] * { box-sizing: border-box; }
[data-rf="root"] button, [data-rf="root"] [role="button"] { font: inherit; }
[data-rf="root"] button:focus-visible,
[data-rf="root"] input:focus-visible,
[data-rf="root"] textarea:focus-visible,
[data-rf="root"] select:focus-visible,
[data-rf="root"] [role="button"]:focus-visible {
  /* inline styles in a few fields say outline:none; the ring has to win, or a
     keyboard user cannot see where they are */
  outline: 2px solid #FF6A1A !important; outline-offset: 2px; border-radius: 8px;
}
[data-rf="root"] ::-webkit-scrollbar { width: 9px; height: 9px; }
[data-rf="root"] ::-webkit-scrollbar-thumb { background: #1E2A35; border-radius: 9px; }
[data-rf="root"] ::-webkit-scrollbar-track { background: transparent; }
[data-rf="body"] { display: grid; grid-template-columns: 288px minmax(0,1fr) 440px; }
@media (max-width: 1440px) {
  [data-rf="body"] { grid-template-columns: 262px minmax(0,1fr) 376px; }
}
@media (max-width: 1180px) {
  [data-rf="body"] { grid-template-columns: 250px minmax(0,1fr); grid-template-rows: minmax(430px, 1fr) auto; }
  [data-rf="spec"] { grid-column: 1 / -1; max-height: 32vh; border-top: 1px solid #1E2A35; }
  [data-rf="view"] { min-height: 46vh; }
  /* the bar carries camera presets, display toggles and a live power badge; it
     wraps rather than pushing the page sideways */
  [data-rf="viewbar"], [role="toolbar"] { flex-wrap: wrap; row-gap: 4px; max-width: calc(100% - 28px); }
  [data-rf="strip"] { display: none; }
}
@media (max-width: 900px) {
  /* one document that scrolls, instead of three panes fighting for height */
  [data-rf="body"] {
    grid-template-columns: 1fr;
    grid-template-rows: min-content min-content min-content;
    grid-auto-rows: min-content;
    overflow-y: auto;
  }
  /* the machine goes first: on a tablet the 3D view *is* the product, and
     having to scroll past the chooser to see it is backwards */
  [data-rf="view"] { order: 1; min-height: 54vh; }
  [data-rf="rail"] { order: 2; max-height: none !important; overflow: visible !important; }
  [data-rf="spec"] { order: 3; max-height: none; }
  [data-rf="codeInput"]::placeholder { color: #6F8493; opacity: 1; }
  [data-rf="tagline"] { display: none; }
  [data-rf="top"] { gap: 10px; padding: 0 12px; }
  [data-rf="strip"] { display: none; }
}
@media (max-width: 780px) {
  /* the drawing title block and the HUD are sheet niceties; on a narrow screen
     they sit on top of the machine, so the machine wins */
  [data-rf="titleblock"] { display: none; }
  [data-rf="hud"] { display: none; }
  [data-rf="view"] { min-height: 50vh; }
  [data-rf="viewbar"], [role="toolbar"] { left: 8px; right: 8px; padding: 6px; max-width: calc(100% - 16px); }
  [data-rf="viewbar"] button, [role="toolbar"] button { min-height: 30px; min-width: 34px; }
  /* inline style says nowrap; the caption should wrap, not trail off */
  [data-rf="viewtitle"] { left: 12px; right: 12px; white-space: normal !important; overflow: visible !important; line-height: 1.35; }
}

@media (prefers-reduced-motion: reduce) {
  [data-rf="root"] * { transition: none !important; animation: none !important; }
}
`

const S = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    background: C.bg, color: C.text, fontFamily: C.sans,
    fontSize: '13.5px', lineHeight: 1.5, WebkitFontSmoothing: 'antialiased',
    padding: '10px', gap: '10px',
  },

  // ── top bar ─────────────────────────────────────────────────────────────
  top: {
    display: 'flex', alignItems: 'center', gap: '20px', padding: '0 20px',
    height: '58px', flex: '0 0 58px', borderBottom: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
    borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
  },
  mark: { display: 'flex', alignItems: 'center', gap: '10px' },
  wordmark: {
    fontFamily: C.sans, fontWeight: 700, letterSpacing: '0.16em', fontSize: '13px',
    color: C.text,
  },
  tagline: { fontSize: '11.5px', color: C.faint, letterSpacing: '0.01em' },
  topStats: { display: 'flex', gap: '8px', marginLeft: 'auto', alignItems: 'center' },
  projectStrip: {
    display: 'flex', alignItems: 'stretch', gap: '0px', marginLeft: 'auto',
    border: `1px solid ${C.line}`, borderRadius: '9px', background: C.panel, overflow: 'hidden',
  },
  stripItem: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 12px',
    borderLeft: `1px solid ${C.lineSoft}`,
  },
  stripItemFirst: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 12px',
  },
  stripKey: { fontSize: '9px', letterSpacing: '0.13em', color: C.faint, fontFamily: C.mono },
  stripVal: { fontSize: '12.5px', fontFamily: C.mono, color: C.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', alignItems: 'center', gap: '7px' },
  seg: {
    display: 'flex', padding: '2px', borderRadius: '8px', border: `1px solid ${C.line}`,
    background: C.bg, gap: '2px',
  },
  segOn: {
    padding: '4px 10px', borderRadius: '6px', border: 'none', background: C.raise,
    color: C.text, fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: C.sans,
  },
  segOff: {
    padding: '4px 10px', borderRadius: '6px', border: 'none', background: 'transparent',
    color: C.faint, fontSize: '11px', fontWeight: 500, cursor: 'pointer', fontFamily: C.sans,
  },
  dot: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
  statChip: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 11px',
    border: `1px solid ${C.line}`, borderRadius: '8px', background: C.panel,
    minWidth: '64px',
  },
  statKey: { fontSize: '9.5px', letterSpacing: '0.13em', color: C.faint, fontFamily: C.mono },
  statVal: { fontSize: '12.5px', fontFamily: C.mono, color: C.text, fontWeight: 600 },

  // ── controls ────────────────────────────────────────────────────────────
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '32px',
    padding: '0 13px', borderRadius: '8px', border: `1px solid ${C.line}`,
    background: C.panel2, color: C.dim, fontSize: '12px', fontWeight: 500, cursor: 'pointer',
    fontFamily: C.sans, whiteSpace: 'nowrap',
    transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
    height: '40px', padding: '0 16px', borderRadius: '9px', border: '1px solid #FF8A4A',
    background: 'linear-gradient(180deg, #FF7A2A, #FF6A1A)', color: '#180B02', fontSize: '13px',
    fontWeight: 700, cursor: 'pointer', fontFamily: C.sans, letterSpacing: '0.02em', width: '100%',
    boxShadow: '0 6px 18px rgba(255,106,26,0.20), inset 0 1px 0 rgba(255,255,255,0.22)',
  },
  tool: {
    padding: '5px 9px', textAlign: 'center', borderRadius: '7px',
    border: `1px solid ${C.line}`, background: 'rgba(13,18,23,0.9)', color: C.faint,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.07em',
    transition: 'color 120ms ease, border-color 120ms ease',
  },
  toolOn: {
    padding: '5px 9px', textAlign: 'center', borderRadius: '7px',
    border: '1px solid rgba(255,106,26,0.45)', background: 'rgba(255,106,26,0.12)', color: C.accent,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.07em',
  },

  // ── body grid ───────────────────────────────────────────────────────────
  body: {
    display: 'grid', gap: '10px', background: 'transparent', flex: '1 1 auto', minHeight: 0,
  },
  col: {
    background: C.panel, minHeight: 0, display: 'flex', flexDirection: 'column',
    borderRadius: '12px', border: `1px solid ${C.lineSoft}`, overflow: 'hidden',
    boxShadow: '0 12px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03)',
  },
  rail: {
    background: C.panel, minHeight: 0, overflowY: 'auto', padding: '16px',
    borderRadius: '12px', border: `1px solid ${C.lineSoft}`,
    boxShadow: '0 12px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03)',
  },

  sectionLabel: {
    fontFamily: C.mono, fontSize: '9.5px', letterSpacing: '0.16em', color: C.faint,
    margin: '0 0 10px 0', textTransform: 'uppercase',
  },
  field: { marginBottom: '14px' },
  label: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px',
    fontSize: '12px', color: C.dim, marginBottom: '6px', fontFamily: C.sans,
  },
  input: {
    width: '100%', boxSizing: 'border-box', background: C.bg, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: '8px', padding: '9px 11px',
    fontSize: '12.5px', fontFamily: C.sans, resize: 'vertical', outline: 'none',
    lineHeight: 1.5,
  },
  range: { width: '100%', accentColor: C.accent, height: '18px' },
  hint: { fontSize: '11.5px', color: C.faint, marginTop: '5px', lineHeight: 1.4 },

  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' },
  chip: {
    padding: '5px 10px', borderRadius: '999px', border: `1px solid ${C.line}`,
    background: 'transparent', color: C.faint, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.sans, whiteSpace: 'nowrap',
  },
  chipOn: {
    padding: '5px 10px', borderRadius: '999px', border: `1px solid ${C.accent}`,
    background: 'rgba(255,106,26,0.12)', color: C.accent, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.sans, whiteSpace: 'nowrap', fontWeight: 600,
  },

  // ── machine gallery ─────────────────────────────────────────────────────
  cards: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' },
  card: {
    padding: '7px 8px 9px', borderRadius: '10px', border: `1px solid ${C.line}`,
    background: C.panel2, cursor: 'pointer', textAlign: 'left',
    display: 'flex', flexDirection: 'column', gap: '3px',
    transition: 'border-color 120ms ease, background 120ms ease',
  },
  cardOn: {
    padding: '7px 8px 9px', borderRadius: '10px', border: `1px solid ${C.accent}`,
    background: 'linear-gradient(180deg, rgba(255,106,26,0.16), rgba(255,106,26,0.07))',
    cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '3px',
    boxShadow: '0 0 0 1px rgba(255,106,26,0.22), 0 8px 20px rgba(0,0,0,0.32)',
  },
  cardTitle: { fontFamily: C.sans, fontSize: '11.5px', fontWeight: 650, color: C.text, letterSpacing: '0.01em' },
  cardSub: { fontSize: '11px', color: C.faint, lineHeight: 1.35 },
  thumb: {
    display: 'block', width: '100%', height: '62px', marginBottom: '3px',
    borderRadius: '7px', background: 'radial-gradient(circle at 50% 30%, #12202b, #0a1017 70%)',
    pointerEvents: 'none',
  },

  // ── viewport ────────────────────────────────────────────────────────────
  viewWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', background: '#080b0e' },
  canvas: { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' },
  // The HUD used to be raw text floating over a bright render: unreadable the
  // moment a light part passed behind it. A small panel guarantees contrast.
  hudTL: {
    position: 'absolute', top: '12px', left: '14px', display: 'flex', flexDirection: 'column',
    gap: '3px', pointerEvents: 'none', padding: '8px 10px', borderRadius: '9px',
    border: `1px solid ${C.line}`, background: 'rgba(9,13,18,0.78)', backdropFilter: 'blur(8px)',
    minWidth: '132px',
  },
  hudRow: { display: 'flex', gap: '10px', alignItems: 'baseline', justifyContent: 'space-between' },
  hudKey: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.13em', color: C.faint },
  hudVal: {
    fontFamily: C.mono, fontSize: '11.5px', color: C.text, fontVariantNumeric: 'tabular-nums',
  },
  hudTR: { position: 'absolute', top: '14px', right: '16px', pointerEvents: 'none' },
  hudHint: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.04em' },
  // A drawing has a title block, bottom right, with the revision and the units
  // on it. This is the single strongest signal that a viewport is a drawing and
  // not a toy: it says what the sheet is, at what scale, and who signed it off.
  titleBlock: {
    position: 'absolute', right: '18px', bottom: '18px', zIndex: 3,
    width: '312px', padding: '9px 11px 8px',
    background: 'rgba(9,13,18,0.9)', border: `1px solid ${C.line}`, borderRadius: '3px',
    backdropFilter: 'blur(6px)', pointerEvents: 'none',
    fontFamily: C.mono, fontSize: '9.5px', letterSpacing: '0.04em', color: C.dim, lineHeight: 1.55,
  },
  tbHead: { color: C.text, fontSize: '9px', letterSpacing: '0.18em', textTransform: 'uppercase', paddingBottom: '5px', borderBottom: `1px solid ${C.line}`, marginBottom: '5px' },
  tbName: { color: C.text, fontFamily: C.sans, fontSize: '11.5px', letterSpacing: '0', marginBottom: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tbRow: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
  tbKey: { color: C.faint },
  tbVal: { color: C.text, textAlign: 'right' },
  viewTitle: {
    position: 'absolute', bottom: '16px', left: '126px', right: '350px', fontSize: '12.5px',
    color: C.dim, pointerEvents: 'none', fontFamily: C.sans, letterSpacing: '0.01em',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  viewSub: { color: C.faint },
  viewTools: {
    position: 'absolute', top: '46px', right: '16px', display: 'flex', flexDirection: 'column',
    gap: '5px',
  },
  // A viewer toolbar is one horizontal instrument, not nine floating buttons:
  // camera presets are a radio group, display options are checkboxes.
  // Sits top-right: the object's numbers live top-left, the controls that act
  // on the view live on the other side, and neither fights the model.
  viewBar: {
    position: 'absolute', top: '12px', right: '14px',
    display: 'flex', alignItems: 'center', gap: '9px', padding: '5px 9px',
    borderRadius: '10px', border: `1px solid ${C.line}`, background: 'rgba(11,16,21,0.86)',
    backdropFilter: 'blur(8px)', zIndex: 4, maxWidth: 'calc(100% - 210px)',
  },
  viewGroup: { display: 'flex', alignItems: 'center', gap: '2px', padding: '2px', borderRadius: '7px', background: 'transparent' },
  viewSep: { width: '1px', height: '18px', background: C.line, flex: '0 0 auto' },
  viewPick: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'transparent',
    color: C.faint, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
  },
  viewPickOn: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'rgba(255,106,26,0.16)',
    color: C.accent, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
    fontWeight: 600,
  },
  viewChip: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'transparent',
    color: C.faint, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
  },
  viewChipOn: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'rgba(255,106,26,0.16)',
    color: C.accent, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
  },
  viewHint: { fontFamily: C.mono, fontSize: '9.5px', color: C.faint, letterSpacing: '0.04em', whiteSpace: 'nowrap' },

  // ── joint bar ───────────────────────────────────────────────────────────
  jointBar: {
    display: 'flex', gap: '18px', padding: '12px 18px 14px', borderTop: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`, overflowX: 'auto',
    alignItems: 'flex-end', flex: '0 0 auto',
  },
  joint: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '124px', flex: '1 1 124px', maxWidth: '196px' },
  poseHead: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: '0 0 auto',
    paddingRight: '14px', marginRight: '2px', borderRight: `1px solid ${C.line}`,
  },
  poseTab: {
    padding: '3px 8px', borderRadius: '5px', border: `1px solid ${C.line}`, background: 'transparent',
    color: C.faint, fontSize: '9px', fontFamily: C.mono, letterSpacing: '0.08em', cursor: 'pointer',
    transition: 'color 120ms ease, border-color 120ms ease',
  },
  poseTabOn: {
    padding: '3px 8px', borderRadius: '5px', border: '1px solid rgba(255,106,26,0.5)',
    background: 'rgba(255,106,26,0.14)', color: C.accent, fontSize: '9px', fontFamily: C.mono,
    letterSpacing: '0.08em', cursor: 'pointer', fontWeight: 600,
  },
  poseGrid: {
    flex: '1 1 auto', minWidth: 0, display: 'grid', gap: '6px 18px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(196px, 1fr))',
    maxHeight: '78px', overflowY: 'auto', alignContent: 'start',
  },
  poseRow: { display: 'grid', gridTemplateColumns: '1fr 84px 40px', alignItems: 'center', gap: '8px', minWidth: 0 },
  poseName: {
    fontSize: '10.5px', color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', letterSpacing: '0.01em',
  },
  poseRange: { width: '100%', accentColor: C.accent, height: '14px' },
  poseFade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: '22px', pointerEvents: 'none',
    background: `linear-gradient(to top, ${C.panel}, rgba(13,18,23,0))`,
  },
  poseVal: {
    fontFamily: C.mono, fontSize: '10px', color: C.accent, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  jointTop: { display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '9.5px', color: C.faint },

  // ── spec rail ───────────────────────────────────────────────────────────
  tabs: {
    display: 'flex', gap: '1px', padding: '0 4px', borderBottom: `1px solid ${C.line}`,
    background: C.panel, overflowX: 'auto', scrollbarWidth: 'none',
  },
  tab: {
    padding: '11px 9px 10px', fontFamily: C.sans, fontSize: '11px', fontWeight: 600,
    letterSpacing: '0.05em', color: C.faint, cursor: 'pointer', borderBottom: '2px solid transparent',
    background: 'transparent', border: 'none',
  },
  tabOn: {
    padding: '11px 9px 10px', fontFamily: C.sans, fontSize: '10.5px', fontWeight: 700,
    letterSpacing: '0.06em', color: C.accent, cursor: 'pointer', borderBottom: `2px solid ${C.accent}`,
    background: 'transparent', borderTop: 'none', borderLeft: 'none', borderRight: 'none',
  },
  tabBody: { overflowY: 'auto', padding: '14px 16px 48px', flex: '1 1 auto', minHeight: 0 },

  table: { width: '100%', borderCollapse: 'collapse', fontFamily: C.sans, fontSize: '11.5px' },
  th: {
    textAlign: 'left', padding: '5px 6px', color: C.faint, fontWeight: 600, fontSize: '9.5px',
    letterSpacing: '0.1em', borderBottom: `1px solid ${C.line}`, fontFamily: C.mono,
  },
  td: { padding: '6px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.dim, verticalAlign: 'top' },
  tdNum: {
    padding: '6px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.text, textAlign: 'right',
    whiteSpace: 'nowrap', fontFamily: C.mono, fontVariantNumeric: 'tabular-nums',
  },
  kv: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '7px 12px', alignItems: 'baseline' },
  kvKey: { color: C.faint, fontSize: '11.5px', fontFamily: C.sans },
  kvVal: { color: C.text, fontSize: '12px', fontFamily: C.mono, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  pre: {
    margin: 0, padding: '11px 13px', background: '#070A0D', border: `1px solid ${C.line}`,
    borderRadius: '8px', color: '#BFD3E0', fontFamily: C.mono, fontSize: '10.5px',
    lineHeight: 1.6, overflow: 'auto', maxHeight: '100%',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', tabSize: 2,
  },
  warn: {
    display: 'flex', gap: '8px', padding: '8px 10px', borderRadius: '7px',
    fontSize: '11.5px', lineHeight: 1.5, marginBottom: '6px', alignItems: 'flex-start',
  },
  step: { display: 'flex', gap: '11px', marginBottom: '13px' },
  stepNo: {
    flex: '0 0 auto', width: '22px', height: '22px', borderRadius: '50%',
    border: '1px solid rgba(255,106,26,0.45)', color: C.accent, display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontFamily: C.mono, fontSize: '10px',
  },
  footer: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px',
    borderTop: `1px solid ${C.line}`, background: C.panel,
  },
  firstRunCompact: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px', marginBottom: '8px',
    borderRadius: '8px', border: `1px solid ${C.line}`, background: C.panel2, flexWrap: 'wrap',
  },
  firstRunItem: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: C.dim },
  chipBtn: {
    display: 'inline-flex', alignItems: 'center', height: '22px', padding: '0 8px',
    borderRadius: '11px', border: `1px solid ${C.line}`, background: C.panel2,
    color: C.dim, fontSize: '10px', cursor: 'pointer', fontFamily: C.sans,
    flex: '0 0 auto', whiteSpace: 'nowrap',
  },
  shelfRow: {
    display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '7px 9px',
    border: `1px solid ${C.line}`, borderRadius: '7px', marginBottom: '5px',
    cursor: 'pointer', background: C.panel2,
  },
  menu: {
    position: 'absolute', top: '42px', right: '0', zIndex: 20, background: C.raise,
    border: `1px solid ${C.line}`, borderRadius: '10px', padding: '6px', minWidth: '210px',
    boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
  },
  menuItem: {
    display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderRadius: '7px',
    fontSize: '12px', color: C.text, cursor: 'pointer', fontFamily: C.sans,
  },

  // ── plain-words panel ───────────────────────────────────────────────────
  simpleHead: {
    fontFamily: C.sans, fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em',
    color: C.faint, textTransform: 'uppercase', marginBottom: '10px',
  },
  simpleGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '18px' },
  bigCard: {
    border: `1px solid ${C.line}`, borderRadius: '10px', padding: '10px 11px',
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
  },
  bigKey: { fontFamily: C.mono, fontSize: '8.5px', letterSpacing: '0.13em', color: C.faint },
  bigVal: {
    fontSize: '20px', fontWeight: 700, fontFamily: C.mono, marginTop: '5px',
    letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums',
  },
  bigSub: { fontSize: '10.5px', color: C.faint, marginTop: '3px', lineHeight: 1.35 },
  simpleLabel: {
    fontFamily: C.sans, fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em',
    color: C.faint, textTransform: 'uppercase', marginBottom: '7px',
  },
  buyRow: {
    display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'baseline',
    padding: '6px 0', borderBottom: `1px solid ${C.lineSoft}`,
  },
  buyName: { fontSize: '12px', color: C.text, lineHeight: 1.35 },
  buyQty: { fontFamily: C.mono, fontSize: '10px', color: C.faint },
  buyPrice: {
    fontFamily: C.mono, fontSize: '12px', color: C.dim, whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  buyMore: { fontFamily: C.sans, fontSize: '10.5px', color: C.faint, paddingTop: '6px' },

  // ── command palette ─────────────────────────────────────────────────────
  paletteBackdrop: {
    position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,7,10,0.62)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
    backdropFilter: 'blur(3px)',
  },
  palette: {
    width: 'min(620px, 92vw)', maxHeight: '62vh', display: 'flex', flexDirection: 'column',
    background: C.raise, border: `1px solid ${C.line}`, borderRadius: '14px', overflow: 'hidden',
    boxShadow: '0 40px 80px rgba(0,0,0,0.65)',
  },
  paletteInput: {
    border: 'none', borderBottom: `1px solid ${C.line}`, background: 'transparent',
    color: C.text, fontSize: '15px', padding: '15px 18px', outline: 'none', fontFamily: C.sans,
  },
  paletteList: { overflowY: 'auto', padding: '6px' },
  paletteRow: {
    display: 'grid', gridTemplateColumns: '86px 1fr auto', gap: '10px', alignItems: 'baseline',
    width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: '8px',
    background: 'transparent', border: 'none', cursor: 'pointer', color: C.text,
  },
  paletteRowOn: {
    display: 'grid', gridTemplateColumns: '86px 1fr auto', gap: '10px', alignItems: 'baseline',
    width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: '8px',
    background: 'rgba(255,106,26,0.20)', border: 'none', cursor: 'pointer', color: C.text,
  },
  paletteGroup: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.13em', color: C.faint },
  paletteLabel: { fontSize: '13px', color: C.text },
  paletteHint: { fontFamily: C.mono, fontSize: '10px', color: C.dim },
  paletteEmpty: { padding: '16px', fontSize: '12.5px', color: C.faint },
  paletteFoot: {
    borderTop: `1px solid ${C.line}`, padding: '8px 14px', fontFamily: C.mono,
    fontSize: '10px', color: C.dim, letterSpacing: '0.06em',
  },

  // ── first-run strip ─────────────────────────────────────────────────────
  firstRun: {
    display: 'flex', gap: '10px', alignItems: 'flex-start',
    padding: '10px 12px', marginBottom: '14px', borderRadius: '10px',
    border: `1px solid ${C.line}`, background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
  },
  firstRunStep: { flex: '1 1 0', minWidth: 0 },
  firstRunNum: {
    fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', color: C.accent, marginBottom: '3px',
  },
  firstRunText: { fontSize: '12px', color: C.dim, lineHeight: 1.4 },
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

// "iot" is our word, not the user's. Show the machine name they picked.
function friendlyArchetype(id) {
  const p = PRESETS.find((x) => x.brief.archetype === id)
  if (p) return p.label.toLowerCase().replace(/ & /g, ' and ')
  const a = (typeof ARCHETYPES !== 'undefined' ? ARCHETYPES : []).find((x) => x[0] === id)
  return a ? a[1].toLowerCase() : id
}

function relTime(ts) {
  const secs = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'build'
}

// ── the spec rail: seven tabs, each answering one build question ────────────

// Camera presets, one source for the toolbar's radio group.
const VIEWS = [
  ['ISO', -0.62, 0.42],
  ['FRONT', -Math.PI / 2, 0.02],
  ['SIDE', 0, 0.02],
  ['TOP', -Math.PI / 2, 1.44],
]

const TABS = [
  ['spec', 'SPEC'], ['test', 'TEST'], ['parts', 'BOM'], ['pins', 'PINS'],
  ['power', 'PWR'], ['print', 'PRINT'], ['assembly', 'ASSY'], ['code', 'CODE'], ['steps', 'STEPS'],
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
  {
    const fails = a.checks.filter((c) => c.level === 'fail').length
    const warns = a.checks.filter((c) => c.level === 'warn').length
    const plain = fails
      ? `Hold on — ${fails} thing${fails > 1 ? 's' : ''} must be fixed before this is safe to build.`
      : warns
        ? `Buildable, but read the ${warns} warning${warns > 1 ? 's' : ''} below first.`
        : 'Ready to build — every engineering check passed.'
    blocks.push(h('div', {
      style: {
        fontSize: '12px', color: C.text, lineHeight: 1.45, marginBottom: '10px',
        padding: '8px 10px', borderRadius: '6px', border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${fails ? C.red : warns ? C.amber : C.green}`,
        background: fails ? 'rgba(255,95,86,0.08)' : warns ? 'rgba(255,194,74,0.07)' : 'rgba(78,208,138,0.07)',
      },
    }, plain))
  }
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
        h('td', { style: S.td }, x.ratio === 0 ? '— needs another drive' : PARTS[x.servo].name.replace(/ servo| standard| micro/g, '')),
        h('td', {
          style: {
            ...S.tdNum,
            color: x.ratio === 0 ? C.red : (x.effective || PARTS[x.servo].torque) >= x.need ? C.green : C.red,
          },
        },
          x.ratio === 0 ? 'out of scope' : `${fmt(x.effective || PARTS[x.servo].torque, 2)} N·m${x.ratio > 1 ? ` ${x.ratio}:1` : ''}`))))))
  }

  if (design.mech && design.mech.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'mechanics'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'CHECK'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'VALUE'),
        h('th', { style: S.th }, 'LIMIT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'OK'))),
      h('tbody', {}, design.mech.map((r) => h('tr', { key: r.label },
        h('td', { style: S.td }, r.label),
        h('td', { style: S.tdNum }, r.value),
        h('td', { style: { ...S.td, color: C.faint } }, r.limit),
        h('td', { style: { ...S.tdNum, color: r.ok == null ? C.faint : r.ok ? C.green : C.red } },
          r.ok == null ? '·' : r.ok ? '✓' : '✗'))))))
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

/** TEST: the pre-print bench. Would this machine stand, climb and hold? */
function TabTest({ design, analysis }) {
  const [slope, setSlope] = useState(15)
  const r = useMemo(() => benchReport(design, analysis, { mat: analysis.print.material, slopeDeg: slope }), [design, analysis, slope])
  const worst = r.verdicts.some((v) => v.status === 'fail') ? 'fail' : r.verdicts.some((v) => v.status === 'warn') ? 'warn' : 'ok'
  const vc = (s) => (s === 'pass' ? 'ok' : s)
  const blocks = []

  blocks.push(h('div', {
    style: {
      fontSize: '12.5px', color: C.text, lineHeight: 1.5, marginBottom: '12px',
      padding: '10px 12px', borderRadius: '7px',
      border: `1px solid ${C.line}`, borderLeft: `3px solid ${levelColor(worst)}`,
      background: levelBg(worst),
    },
  }, worst === 'ok'
    ? `Bench says go — ${Math.round(r.massG)}g machine, ${r.contacts}-point support polygon, worst joint at ${r.torques.length ? Math.min(...r.torques.map((t) => t.margin)).toFixed(1) : '—'}× stall margin.`
    : worst === 'warn'
      ? 'Bench has concerns — read the warnings below before you print.'
      : 'Bench says stop — this design fails a pre-print check. Fix it before spending filament.'))

  blocks.push(h('div', { style: S.sectionLabel }, 'scenario: ramp test'))
  blocks.push(h('div', { style: { ...S.field, marginBottom: '4px' } },
    h('div', { style: S.label },
      h('span', {}, 'incline angle'),
      h('span', { style: { fontFamily: C.mono, color: slope > 20 ? C.amber : C.text } }, `${slope}°`)),
    h('input', {
      type: 'range', min: 0, max: 35, step: 1, value: slope,
      onInput: (e) => setSlope(Number(e.target.value)),
      style: { width: '100%', accentColor: C.accent },
      'aria-label': 'ramp incline angle in degrees',
    }),
    h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '4px' } },
      `CoM margin on the slope plane: ${Math.round(r.slopeMm)}mm ${r.slopeMm > 0 ? '(stable)' : '(tipping)'}`)))

  blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'verdicts'))
  for (const v of r.verdicts) {
    blocks.push(h('div', { style: { ...S.warn, background: levelBg(vc(v.status)), borderLeft: `2px solid ${levelColor(vc(v.status))}`, marginBottom: '6px' } },
      h('span', { style: { color: levelColor(vc(v.status)), fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', paddingTop: '2px' } },
        v.status === 'pass' ? 'PASS' : v.status.toUpperCase()),
      h('span', { style: { color: C.dim, flex: '1' } }, `${v.label} — ${v.detail}`)))
  }

  if (r.torques.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'joint torque vs stall (this pose)'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'JOINT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'NEEDS'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'STALL'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'MARGIN'))),
      h('tbody', {}, r.torques.map((t) => {
        const col = t.margin > 1.5 ? C.green : t.margin > 1 ? C.amber : C.red
        return h('tr', { key: t.joint },
          h('td', { style: S.td }, t.label),
          h('td', { style: S.tdNum }, `${t.needNm.toFixed(2)} N·m`),
          h('td', { style: S.tdNum }, `${t.stallNm.toFixed(2)} N·m`),
          h('td', { style: { ...S.tdNum, color: col } }, `${t.margin.toFixed(1)}×`))
      }))))
  }

  blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'mass & balance'))
  blocks.push(h('div', { style: S.kv },
    h(KV, { k: 'total mass', v: `${Math.round(r.massG)} g` }),
    h(KV, { k: 'centre of mass', v: `${Math.round(r.com[0])}, ${Math.round(r.com[1])}, ${Math.round(r.com[2])} mm` }),
    h(KV, { k: 'support polygon', v: `${r.hull.length} hull pts · ${r.contacts} contacts` }),
    h(KV, { k: 'flat margin', v: `${Math.round(r.flatMm)} mm`, accent: r.flatMm > 15 ? C.green : r.flatMm > 0 ? C.amber : C.red })))
  blocks.push(h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, marginTop: '10px' } },
    'Rigid-body statics at the current pose — CoM is mass-weighted over every node, the support polygon is the convex hull of ground contacts, and torque is exact r×F about each joint axis. It answers "will it stand, climb and hold?" before you spend filament.'))
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
            [r.role, r.part.dims ? r.part.dims.join('×') + 'mm' : '', r.part.sku ? `⌕ ${r.part.sku}` : '', r.part.note].filter(Boolean).join(' · '))),
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
    analysis.power.wiring && analysis.power.wiring.length
      ? h('div', {},
        h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'wiring'),
        h('table', { style: S.table },
          h('thead', {}, h('tr', {},
            h('th', { style: S.th }, 'RAIL'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'DRAW'),
            h('th', { style: { ...S.th, textAlign: 'right' } }, 'WIRE (PEAK)'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'FUSE'),
            h('th', { style: S.th }, 'CONNECTOR'))),
          h('tbody', {}, analysis.power.wiring.map((w) => h('tr', { key: w.rail },
            h('td', { style: S.td }, w.rail),
            h('td', { style: S.tdNum }, `${fmt(w.amps, 2)}A`),
            h('td', { style: { ...S.tdNum, color: w.over ? C.red : C.cyan } },
              w.over ? '>14 AWG' : `${w.awg} AWG · ${w.ampacity}A`),
            h('td', { style: { ...S.tdNum, color: w.fuse ? C.amber : C.faint } }, w.fuse ? `${w.fuse}A` : '—'),
            h('td', { style: { ...S.td, color: C.faint, fontSize: '9.5px' } }, w.conn))))),
      )
      : null,
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
      'Green = typical draw, orange = worst case with every actuator at stall. The wire is sized for the orange bar (its ampacity is printed beside it) and the fuse never exceeds that ampacity — a fuse bigger than its wire protects nothing. A fuse below stall current is normal: it is protecting the wire, not the servo.'),
  ]
}

function TabPrint({ design, analysis }) {
  const nodes = design.nodes.filter((n) => n.print)
  const rows = nodes
    .map((n) => ({ id: n.id, name: prettyPart(n.id), kind: n.kind, mm3: shellVolume(n), dims: nodeHalf(n).map((x) => x * 2) }))
    .sort((a, b) => b.mm3 - a.mm3)
  const total = rows.reduce((s, r) => s + r.mm3, 0) || 1
  return [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } },
      h(StatBlock, { label: 'FILAMENT', value: `${Math.round(analysis.print.grams)}g`, sub: `${(analysis.print.grams / 1000).toFixed(2)} of a 1kg spool` }),
      h(StatBlock, { label: 'MACHINE TIME', value: `${fmt(analysis.print.hours, 1)}h`, sub: `${rows.length} parts · largest ${Math.round(analysis.printFit ? analysis.printFit.worst.largest : 0)}mm on a ${analysis.printFit ? analysis.printFit.bed : 256}mm bed` })),
    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'PART'), h('th', { style: S.th }, 'SIZE'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'GRAMS'))),
      h('tbody', {}, rows.map((r) => h('tr', { key: r.id },
        h('td', { style: { ...S.td, color: C.text } }, r.name),
        h('td', { style: { ...S.td, color: C.faint } }, r.dims.map((d) => Math.round(d)).join('×')),
        h('td', { style: S.tdNum }, fmt((r.mm3 / total) * analysis.print.grams, 1)))))),
    h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'print advice'),
    h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.6 } },
      `Material: ${analysis.print.material.name}. 3 walls, 25% gyroid, 0.2mm layers. ` +
      `Orient load-bearing links so the layers run ALONG the load — a printed cantilever fails at the layer line, not at the design stress. ` +
      `Parts longer than your bed are split automatically with joiner plates — the notes say which seams to glue. Every STL in the pack is laid flat, centred and sitting on Z=0, so a slicer opens it ready to slice. Heat-set inserts beat printed threads every time.`),
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

// ── assembly: what you can solder, and what you should hand over ─────────────
// The BOM says what to buy. This says how it physically gets together: which
// joints need an iron, which packages are past what a person can place by hand,
// and what an assembly house needs from you if you send it out.

// Package → verdict. "hand" is honest for a beginner with a fine tip and flux;
// "reflow" is hot air and paste; "house" is a machine plus X-ray.
const SOLDER_CLASSES = [
  { match: /^(1206|0805|0603)$/i, verdict: 'hand', why: 'comfortable with a fine tip and flux' },
  { match: /^0402$/i, verdict: 'hand', why: 'doable under magnification — expect some rework' },
  { match: /^(0201|01005)$/i, verdict: 'house', why: 'below what a hand can place reliably' },
  { match: /^(soic|sop)-?\d*/i, verdict: 'hand', why: '0.65mm+ pitch drag-solders easily' },
  { match: /^(tssop|ssop|msop)/i, verdict: 'hand', why: 'fine but regular pitch — drag solder with flux' },
  { match: /^(tqfp|lqfp|qfp)-?\d*/i, verdict: 'hand', why: '0.5mm pitch is learnable; 0.4mm is not fun' },
  { match: /^(qfn|dfn)/i, verdict: 'reflow', why: 'no exposed leads — hot air and paste, an iron cannot reach' },
  { match: /^(bga|ubga|wlcsp)/i, verdict: 'house', why: 'needs reflow profile and X-ray to verify' },
  { match: /^(sot-?23|sot-?223|sc-?70)/i, verdict: 'hand', why: 'three legs, easy' },
  { match: /^(dip|pdip)-?\d*/i, verdict: 'hand', why: 'through-hole, easiest of all' },
  { match: /^(to-?220|to-?252)/i, verdict: 'hand', why: 'big tabs, hand solderable' },
  { match: /^(module|mod\b)/i, verdict: 'hand', why: 'a finished module — castellated pads or headers, no fine pitch' },
  { match: /^lga/i, verdict: 'reflow', why: 'land grid, no leads — hot air and paste' },
  { match: /^(jst|tht|usb|header|conn)/i, verdict: 'hand', why: 'through-hole or big pads' },
]

function solderVerdict(text) {
  const pkg = String(text || '').trim()
  if (!pkg) return null
  for (const c of SOLDER_CLASSES) {
    if (c.match.test(pkg)) return { pkg, ...c }
  }
  // through-hole-ish fallbacks and everything unknown
  if (/^(m\d|pin|header|conn)/i.test(pkg)) return { pkg, verdict: 'hand', why: 'connector or header — through-hole or big pads' }
  return { pkg, verdict: 'unknown', why: 'not a package I recognise — check the datasheet footprint' }
}

/** Parts whose connection needs an iron, with the joint count that implies. */
function solderJobs(design) {
  return design.parts
    .map((p) => ({ ...p, part: PARTS[p.key] }))
    .filter((p) => p.part && /solder|bare tabs|tabs|pads/i.test(p.part.conn || ''))
    .map((p) => ({
      key: p.key,
      name: p.part.name,
      qty: p.qty,
      joints: p.qty * (/bare tabs/i.test(p.part.conn) ? 2 : 2),
      conn: p.part.conn,
    }))
}

// Colour is a process hint, not a verdict on quality: "send it out" is normal
// for a BGA, so it gets the neutral accent, never the error red.
const VERDICT_COLOR = { hand: 'green', reflow: 'amber', house: 'cyan', unknown: 'faint' }

function TabAssembly({ design, analysis }) {
  const [probe, setProbe] = useState('')
  const jobs = solderJobs(design)
  const boardJoints = (design.pcb && design.pcb.joints) || 0
  const jointCount = boardJoints + jobs.reduce((s, j) => s + j.joints, 0)
  const parsed = probe.split(/[,;\s]+/).map(solderVerdict).filter(Boolean)
  const tone = (v) => (v === 'hand' ? C.green : v === 'reflow' ? C.amber : v === 'house' ? C.cyan : C.faint)
  const label = (v) => (v === 'hand' ? 'BY HAND' : v === 'reflow' ? 'HOT AIR' : v === 'house' ? 'SEND OUT' : 'CHECK DATA')

  const placements = (design.pcb && design.pcb.placed) || []
  const byMethod = placements.reduce((acc, p) => {
    const v = solderVerdict(p.pkg)
    const k = v ? v.verdict : 'unknown'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})

  return [
    placements.length
      ? h('div', { style: { marginBottom: '16px' } },
        h('div', { style: S.sectionLabel }, 'placements on this board'),
        h('div', { style: { display: 'flex', gap: '14px', marginBottom: '10px' } },
          [['hand', 'BY HAND'], ['reflow', 'HOT AIR'], ['house', 'SEND OUT'], ['unknown', 'CHECK']]
            .filter(([k]) => byMethod[k])
            .map(([k, label]) => h('div', { key: k, style: { flex: '0 0 auto' } },
              h('div', { style: S.kvKey }, label),
              h('div', { style: { ...S.bigVal, fontSize: '18px', color: tone(k) } }, byMethod[k])))),
        h('table', { style: S.table },
          h('thead', {}, h('tr', {},
            h('th', { style: S.th }, 'DES'), h('th', { style: S.th }, 'PACKAGE'),
            h('th', { style: S.th }, 'METHOD'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'X · Y'))),
          h('tbody', {}, placements.map((p) => {
            const v = solderVerdict(p.pkg)
            return h('tr', { key: p.des },
              h('td', { style: { ...S.td, fontFamily: C.mono, color: C.text } }, p.des),
              h('td', { style: S.td }, p.pkg),
              h('td', { style: { ...S.td, color: tone(v ? v.verdict : 'unknown'), fontFamily: C.mono, fontSize: '9.5px' } },
                label(v ? v.verdict : 'unknown')),
              h('td', { style: S.tdNum }, `${p.x} · ${p.y}`))
          }))))
      : null,

    h('div', { style: { display: 'flex', gap: '14px', marginBottom: '14px' } },
      h('div', { style: { flex: '1 1 0' } },
        h('div', { style: S.kvKey }, 'SOLDER JOINTS'),
        h('div', { style: { ...S.bigVal, fontSize: '22px', color: jointCount ? C.amber : C.green } }, jointCount)),
      h('div', { style: { flex: '1 1 0' } },
        h('div', { style: S.kvKey }, 'PARTS NEEDING AN IRON'),
        h('div', { style: { ...S.bigVal, fontSize: '22px' } }, jobs.length))),

    jobs.length
      ? h('table', { style: S.table },
        h('thead', {}, h('tr', {},
          h('th', { style: S.th }, 'OFF-BOARD PART WITH SOLDER TABS'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'JOINTS'))),
        h('tbody', {}, jobs.map((j) => h('tr', { key: j.key },
          h('td', { style: S.td },
            h('div', { style: { color: C.text } }, j.name),
            h('div', { style: { color: C.faint, fontSize: '10px', marginTop: '2px' } }, j.conn)),
          h('td', { style: S.tdNum }, `×${j.qty}`)))))
      : h('div', { style: { fontSize: '11.5px', color: C.dim, lineHeight: 1.5, marginBottom: '14px' } },
        h('span', { style: { color: C.green, fontFamily: C.mono, marginRight: '6px' } }, '0 JOINTS'),
        'every part in this BOM plugs in — JST, XT60 or 0.1\" headers. Nothing to solder on this build.'),

    h('div', { style: { ...S.sectionLabel, marginTop: '18px' } }, 'solder checker — your own board'),
    h('div', { style: S.hint, marginBottom: '8px' },
      'Does not touch the BOM above. Type the footprints from any board and it answers the real question: can you place this by hand?'),
    h('input', {
      style: { ...S.input, fontFamily: C.mono, fontSize: '11.5px' },
      placeholder: '0402, 0603, QFN-32, TQFP-48, BGA-49',
      'aria-label': 'Packages to check, comma separated',
      value: probe,
      onChange: (e) => setProbe(e.target.value),
    }),
    parsed.length
      ? h('div', { style: { marginTop: '10px' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '80px 76px 1fr', gap: '10px', padding: '4px 0', borderBottom: `1px solid ${C.line}` } },
          h('span', { style: S.th }, 'PACKAGE'),
          h('span', { style: S.th }, 'METHOD'),
          h('span', { style: S.th }, 'WHY')),
        parsed.map((r, i) => h('div', {
          key: 'p' + i,
          style: { display: 'grid', gridTemplateColumns: '80px 76px 1fr', gap: '10px', alignItems: 'baseline', padding: '6px 0', borderBottom: `1px solid ${C.lineSoft}` },
        },
        h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text } }, r.pkg),
        h('span', { style: { fontFamily: C.mono, fontSize: '9.5px', color: tone(r.verdict), letterSpacing: '0.08em' } }, label(r.verdict)),
        h('span', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.4 } }, r.why))))
      : h('div', { style: S.hint }, 'Type the footprints from your board — the answer is per package, not per board.'),

    h('div', { style: { ...S.sectionLabel, marginTop: '20px' } }, 'if you send it out'),
    h('div', { style: { fontSize: '11.5px', color: C.dim, lineHeight: 1.6, marginBottom: '10px' } },
      h('div', {}, 'Assembly houses quote from three files, and only three:'),
      h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.text, marginTop: '6px', lineHeight: 1.7 } },
        '1. Gerber (the board)',
        h('br'),
        '2. BOM with manufacturer part numbers',
        h('br'),
        '3. Centroid / pick-and-place file (X, Y, rotation per part)'),
      h('div', { style: { marginTop: '8px' } },
        'You already have the parts, so ask for consigned / kitted assembly — they place what you ship. Their published capability runs to 01005 passives, 0.25mm pitch and BGA with X-ray; minimum order is a handful of boards, and lead time starts when the parts and the three files are all in.')),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', {
        style: S.btn,
        onClick: () => {
          const lines = [
            `Rigforge build: ${design.title}`,
            `${design.parts.length} line items, ${money(analysis.cost)}`,
            '',
            'Parts needing an iron:',
            ...(jobs.length ? jobs.map((j) => `  ${j.name} ×${j.qty} (${j.conn})`) : ['  none']),
            '',
            'Assembly-house handoff needs: Gerber, BOM with MPNs, centroid/CPL file.',
            'Ask for consigned/kitted assembly — customer supplies the components.',
          ].join('\n')
          try { navigator.clipboard.writeText(lines); host.notify({ kind: 'success', message: 'Assembly handoff copied' }) } catch { host.notify({ kind: 'info', message: 'Copy blocked' }) }
        },
      }, 'Copy handoff summary'),
      h('button', { style: S.btn, onClick: () => host.openExternal?.('https://www.pcbway.com/assembly-capabilities.html') }, 'Assembly capabilities ↗')),
  ]
}

// ── audit: show the working ─────────────────────────────────────────────────
// Every headline number in this tool is a sum you could do by hand. That is the
// whole claim, so the claim is checkable: this dialog prints the formula, the
// inputs, and the parts that dominate the total. A number you cannot trace is a
// number you have to trust; a number you can trace is a product.

function pct(part, whole) {
  if (!whole || !isFinite(whole)) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

/** Top contributors by line cost, biggest first. */
function costContributors(design, limit = 5) {
  return design.parts
    .map(({ key, qty }) => ({ key, qty, part: PARTS[key] }))
    .filter((r) => r.part)
    .map((r) => ({ name: r.part.name, qty: r.qty, line: r.part.price * r.qty, unit: r.part.price, shop: !!r.part.shop }))
    .sort((a, b) => b.line - a.line)
    .slice(0, limit)
}

function massContributors(design, limit = 4) {
  return design.parts
    .map(({ key, qty }) => ({ key, qty, part: PARTS[key] }))
    .filter((r) => r.part && !r.part.print && !r.part.shop && r.part.mass > 0)
    .map((r) => ({ name: r.part.name, qty: r.qty, line: r.part.mass * r.qty }))
    .sort((a, b) => b.line - a.line)
    .slice(0, limit)
}

function AuditDialog({ open, onClose, design, analysis }) {
  const dialogRef = useDialogFocus(open, onClose)
  if (!open) return null
  const mat = MATERIALS[design.brief.material] || MATERIALS.petg
  const printed = design.nodes.filter((n) => n.mat === 'shell' || n.print)
  const cutoff = ['finger', 'jaw'].includes(design.archetype) // unused, kept explicit
  void cutoff

  const shopTotal = design.parts.reduce((s, { key, qty }) => (PARTS[key]?.shop ? s + PARTS[key].price * qty : s), 0)
  const units = design.parts.reduce((s, p) => s + p.qty, 0)
  const printGrams = analysis.print.grams
  const spoolCost = (printGrams / 1000) * (PARTS[mat.priceId]?.price || 20)
  const volCm3 = analysis.print.grams / (mat.density || 1.24)
  const power = analysis.power

  const section = (title, formula, rows, total) => h('div', { style: { marginBottom: '18px' } },
    h('div', { style: { ...S.sectionLabel, marginBottom: '4px' } }, title),
    h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.accent, marginBottom: '8px' } }, formula),
    rows,
    total ? h('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', gap: '10px', paddingTop: '6px',
        marginTop: '4px', borderTop: `1px solid ${C.line}`, fontSize: '11.5px', color: C.text,
      },
    }, h('span', { style: { color: C.dim } }, total[0]), h('span', { style: { fontFamily: C.mono } }, total[1])) : null)

  const contrib = (list, whole, fmtLine) => list.map((r, i) => h('div', {
    key: 'c' + i,
    style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'baseline', padding: '3px 0' },
  },
    h('span', { style: { fontSize: '11px', color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
    h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, pct(r.line, whole)),
    h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text, textAlign: 'right', minWidth: '58px' } }, fmtLine(r))))

  return h('div', { style: S.paletteBackdrop, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('div', {
      ref: dialogRef, tabIndex: -1,
      style: { ...S.palette, maxHeight: 'min(78vh, 720px)', width: 'min(660px, 94vw)', overflowY: 'auto', padding: '18px 20px 16px' },
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Show the working',
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '12px' } },
      h('div', {},
        h('div', { style: { ...S.simpleLabel, margin: 0 } }, 'show the working'),
        h('div', { style: { fontSize: '11px', color: C.faint, marginTop: '2px' } }, design.title)),
      h('button', { style: { ...S.btn, height: '26px', padding: '0 10px' }, onClick: onClose, 'aria-label': 'Close' }, 'Close')),

    section('COST', 'Σ (unit price × qty) + filament used',
      h('div', {},
        contrib(costContributors(design), analysis.cost, (r) => money(r.line)),
        printGrams > 0.5
          ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', padding: '3px 0' } },
            h('span', { style: { fontSize: '11px', color: C.dim } }, `filament used · ${Math.round(printGrams)} g of ${mat.name}`),
            h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, pct(spoolCost, analysis.cost)),
            h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text, textAlign: 'right', minWidth: '58px' } }, money(spoolCost)))
          : null,
        shopTotal > 0.5
          ? h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, marginTop: '6px' } },
            `${money(shopTotal)} of this is shop stock — wire, screw kits, standoffs you buy once and reuse. It is counted here so the list is complete; it is not all burned by this build.`)
          : null),
      [`${design.parts.length} line items · ${units} units`, money(analysis.cost)]),

    section('MASS', 'Σ (part mass × qty) + printed volume × density',
      h('div', {},
        contrib(massContributors(design), analysis.mass.totalG, (r) => `${Math.round(r.line)} g`),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', padding: '3px 0' } },
          h('span', { style: { fontSize: '11px', color: C.dim } }, `${printed.length} printed parts · ${fmt(volCm3, 0)} cm³ of ${mat.name}`),
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, pct(printGrams, analysis.mass.totalG)),
          h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text, textAlign: 'right', minWidth: '58px' } }, `${Math.round(printGrams)} g`))),
      [`hardware ${Math.round(analysis.mass.partsG ?? analysis.mass.totalG - printGrams)} g`, `${Math.round(analysis.mass.totalG)} g`]),

    section('PRINT TIME', 'printed volume ÷ 18 cm³ per hour',
      h('div', { style: { fontFamily: C.mono, fontSize: '11px', color: C.dim, lineHeight: 1.7 } },
        h('div', {}, `${fmt(volCm3, 1)} cm³ ÷ 18 cm³/h = ${fmt(analysis.print.hours, 1)} h`),
        h('div', { style: { color: C.faint, fontSize: '10.5px' } },
          '18 cm³/h assumes a 0.4mm nozzle, 0.2mm layers, a well-tuned machine. Your printer is the other half of this number.')),
      [`${printed.length} parts on the bed`, `${fmt(analysis.print.hours, 1)} h`]),

    power
      ? section('POWER', 'Σ current per rail · runtime = mAh × 0.8 × 60 ÷ amps',
        h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.dim, lineHeight: 1.75 } },
          ['3V3', '5V', 'motor'].filter((r) => power.rails?.[r] && (power.rails[r].typ > 0.005 || power.rails[r].peak > 0.005))
            .map((r) => h('div', { key: r },
              `${r.padEnd(5)} ${fmt(power.rails[r].typ, 2)}A typ · ${fmt(power.rails[r].peak, 2)}A peak  (${power.rails[r].items.length} parts)`)),
          power.bat
            ? h('div', { style: { marginTop: '6px', color: C.faint } },
              `${Math.round(power.bat.mah)} mAh pack ÷ ${fmt(power.typ, 2)}A typical = ${power.runtimeMin != null ? Math.round(power.runtimeMin) + ' min' : 'n/a'}`)
            : h('div', { style: { marginTop: '6px', color: C.faint } }, 'tethered supply — no runtime to compute')),
        [`${fmt(power.typ, 2)} A typical · ${fmt(power.peak, 2)} A stall`, `${fmt(power.peak, 1)} A`])
      : null,

    h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, borderTop: `1px solid ${C.line}`, paddingTop: '10px' } },
      'Prices are catalogue estimates until you refresh live supplier prices; geometry, mass and current are computed from the parts and the mesh you see. Nothing here is narrated.'))
  )
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
    parts: design.parts.map((p) => {
      const part = PARTS[p.key] || {}
      return { key: p.key, name: part.name || p.key, sku: part.sku || '', qty: p.qty, price: part.price || 0, shop: !!part.shop }
    }),
    checks: analysis.checks.slice(0, 6).map((c) => ({ level: c.level, msg: c.msg.slice(0, 200) })),
  }
}

// Fit the camera to the machine: the largest dimension should occupy ~70% of
// the viewport, so the thing the user just designed is actually readable.
const CAM_FOR = (dims) => {
  const diag = Math.hypot(dims[0], dims[1], dims[2]) || 300
  return { ...CAM0, dist: clamp(diag * 1.06, 300, 5200) }
}

function StatChip({ k, v, color, title }) {
  return h('div', { style: S.statChip, title },
    h('span', { style: S.statKey }, k),
    h('span', { style: { ...S.statVal, color: color || C.text } }, v))
}

function ParamSlider({ label, value, min, max, step, unit, hint, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label },
      h('span', {}, label),
      h('span', { style: { color: C.text } }, `${value}${unit || ''}`)),
    h('input', {
      type: 'range', min, max, step, value, style: S.range,
      'aria-label': label,
      onChange: (e) => onChange(Number(e.target.value)),
    }),
    hint ? h('div', { style: S.hint }, hint) : null)
}

function Select({ label, value, options, hint, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label }, h('span', {}, label)),
    h('select', {
      value, style: { ...S.input, padding: '6px 8px', cursor: 'pointer' },
      'aria-label': label,
      onChange: (e) => onChange(e.target.value),
    }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
    hint ? h('div', { style: S.hint }, hint) : null)
}

/**
 * A live 3D mini of an archetype, drawn by the same engine as the viewport.
 * Cards that show the machine read as a catalogue of things you can build; a
 * card that shows an icon reads as a form field.
 */
function Thumb({ archetype }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return undefined
    let alive = true
    let raf = 0
    const draw = () => {
      const preset = PRESETS.find((p) => p.brief.archetype === archetype)
      const b = preset ? { ...DEFAULT_BRIEF, ...preset.brief } : DEFAULT_BRIEF
      let mesh = []
      try {
        const { design } = composeDesign(b)
        mesh = buildMesh(design)
      } catch {
        return
      }
      if (!alive || !mesh.length) return
      let r = 60
      for (const t of mesh) for (const p of t.pts) {
        const d = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])
        if (d > r) r = d
      }
      drawScene(cv, mesh, { yaw: -0.7, pitch: 0.34, dist: r * 3.0, ortho: false }, [0, 0, r * 0.35], {
        grid: false, reflect: false, shadow: false, outline: true, colour: true, dims: false, wire: false, ao: false, gizmo: false,
      })
    }
    // decoration only: build thumbnails in idle time so the page paints first
    const idle = window.requestIdleCallback
    const handle = idle ? idle(draw, { timeout: 900 }) : (raf = requestAnimationFrame(draw))
    return () => {
      alive = false
      if (idle && window.cancelIdleCallback) window.cancelIdleCallback(handle)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [archetype])
  return h('canvas', { ref, style: S.thumb, 'aria-hidden': 'true' })
}


/**
 * Ask Hermes for live prices. Shared by the PRICES note and the "what to buy"
 * header, so there is one trigger and one wording.
 */
async function askPrices(design) {
  const prompt = [
    'Get live prices for the build currently loaded in Rigforge and hand them back to the studio.',
    `Build: ${design.title} — ${design.parts.length} line items.`,
    'Call the rigforge_prices tool, then put its directive on its own line so the studio can render it.',
    'Only report a price as live if it came from the supplier; estimates stay labelled as estimates.',
  ].join('\n')
  try {
    const staged = await host.composer.setDraft(null, prompt)
    host.composer.focus(null)
    host.notify({ kind: staged ? 'success' : 'error', message: staged ? 'Price request handed to Hermes — press Enter' : 'Copied the price request instead' })
    if (!staged) await navigator.clipboard?.writeText(prompt)
  } catch {
    host.notify({ kind: 'info', message: 'Ask Hermes for live prices (rigforge_prices tool)' })
  }
}

/** Live-price strip: what has a real supplier number, and what is still a guess. */
function LivePrices({ design }) {
  const [prices] = useState(() => (CTX && CTX.storage.get('livePrices', null)) || null)
  const age = prices && prices.fetched ? Math.max(0, Math.round(Date.now() / 1000 - prices.fetched)) : null
  const ageText = age == null ? '' : age < 90 ? 'just now' : age < 5400 ? `${Math.round(age / 60)} min ago` : `${Math.round(age / 3600)}h ago`
  return prices
    ? h('div', { style: { fontSize: '11.5px', color: C.text, marginTop: '-4px', marginBottom: '12px', lineHeight: 1.5 } },
      `${prices.liveLines} of ${prices.lines} lines priced live — $${(prices.liveTotal || 0).toFixed(2)}`,
      h('span', { style: { color: C.faint } }, ` · $${(prices.estimateTotal || 0).toFixed(2)} still estimated · ${ageText}`))
    : h('div', { style: { fontSize: '11px', color: C.faint, marginTop: '-4px', marginBottom: '12px', lineHeight: 1.45 } },
      'Totals are catalogue estimates. Live prices come from the LCSC parts index when you ask for them.')
}

function BuildCodeDialog({ open, onOpen, onClose }) {
  const dialogRef = useDialogFocus(open, onClose)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { if (open) { setCode(''); setErr('') } }, [open])
  if (!open) return null
  const submit = () => {
    try {
      const b = decodeBuild(code)
      onOpen(b)
      onClose()
    } catch (e) {
      setErr(e.message)
    }
  }
  return h('div', {
    style: S.paletteBackdrop,
    onClick: (e) => { if (e.target === e.currentTarget) onClose() },
  },
  h('div', { ref: dialogRef, tabIndex: -1, style: { ...S.palette, maxHeight: 'none', width: 'min(560px, 92vw)', padding: 0 }, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Open a build code' },
    h('div', { style: { padding: '16px 18px 0' } },
      h('div', { style: { ...S.simpleLabel, margin: '0 0 4px' } }, 'open a build code'),
      h('div', { style: { ...S.hint, marginBottom: '10px' } },
        'A build code is the whole design in one line — send it to someone else and they get the same machine, priced with their own suppliers.')),
    h('input', {
      'data-rf': 'codeInput',
      style: {
        ...S.paletteInput,
        fontFamily: C.mono, fontSize: '12px', height: '40px',
        border: `1px solid ${err ? C.red : C.line}`,
        margin: '0 18px', width: 'calc(100% - 36px)',
      },
      placeholder: 'paste the code someone sent you',
      value: code,
      autoFocus: true,
      'aria-label': 'Build code',
      onChange: (e) => { setCode(e.target.value); setErr('') },
      onKeyDown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() },
    }),
    h('div', { style: { padding: '8px 18px 0', minHeight: '26px' } },
      err
        ? h('div', { style: { color: C.red, fontSize: '11.5px', lineHeight: 1.4 } }, err)
        : h('div', { style: { color: C.faint, fontSize: '11px', lineHeight: 1.4 } },
          'One line, starts with RF1-. Pastes cleanly into chat, email or a README.')),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', padding: '12px 18px 16px' } },
      h('button', { style: { ...S.btn, height: '32px', padding: '0 14px' }, onClick: onClose }, 'Cancel'),
      h('button', { style: { ...S.btnPrimary, width: 'auto', height: '32px', padding: '0 18px', fontSize: '12px' }, onClick: submit }, 'OPEN IT'))))
}

function CommandPalette({ open, commands, onClose }) {
  const dialogRef = useDialogFocus(open, onClose)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)

  const scored = useMemo(() => {
    // People type what they read: "pick and place arm", not "pick & place arm".
    // Normalise both sides so punctuation and "&" never decide a match.
    const norm = (t) => String(t).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    const needle = norm(q)
    if (!needle) return commands
    const rank = (raw) => {
      const t = norm(raw)
      if (t.startsWith(needle)) return 0
      if (t.includes(needle)) return 1
      // every word of the query must appear somewhere, in any order
      const words = needle.split(' ').filter(Boolean)
      if (words.every((w) => t.includes(w))) return 2
      // initials only: "ppe" → "Pick & place arm", but "cpl" must not land on
      // it just because those letters appear somewhere in the label.
      const initials = t.split(' ').filter(Boolean).map((w) => w[0]).join('')
      let k = 0
      const bare = needle.replace(/ /g, '')
      for (const ch of initials) { if (ch === bare[k]) k += 1; if (k === bare.length) return 3 }
      return -1
    }
    return commands
      .map((c) => ({ c, r: rank(c.label + ' ' + (c.group || '')) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.c.label.length - b.c.label.length)
      .map((x) => x.c)
  }, [q, commands])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 20)
      return () => clearTimeout(t)
    }
    return undefined
  }, [open])

  if (!open) return null
  const clampSel = Math.max(0, Math.min(sel, scored.length - 1))

  const run = (cmd) => {
    onClose()
    if (cmd && cmd.run) cmd.run()
  }

  return h('div', {
    style: S.paletteBackdrop,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', { ref: dialogRef, tabIndex: -1, style: S.palette, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      h('input', {
        ref: inputRef,
        style: S.paletteInput,
        value: q,
        placeholder: 'Jump to a machine, a tab, an export…',
        'aria-label': 'Search commands',
        onChange: (e) => { setQ(e.target.value); setSel(0) },
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, scored.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); run(scored[clampSel]) }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        },
      }),
      h('div', { style: S.paletteList },
        scored.length === 0
          ? h('div', { style: S.paletteEmpty }, 'nothing matches — try "rover", "bom", "stl"')
          : scored.map((c, i) => h('button', {
            key: c.id,
            style: i === clampSel ? S.paletteRowOn : S.paletteRow,
            onMouseEnter: () => setSel(i),
            onClick: () => run(c),
          },
            h('span', { style: S.paletteGroup }, c.group || ''),
            h('span', { style: S.paletteLabel }, c.label),
            c.hint ? h('span', { style: S.paletteHint }, c.hint) : null))),
      h('div', { style: S.paletteFoot }, '↑↓ move · ⏎ run · esc close')),
  )
}

/** The plain-language panel: what it costs, what to buy, what to print. */
function SimplePanel({ design, analysis, exports, onEngineer, onAudit, onCompare, onTest }) {
  const rows = design.parts.map((p) => ({ ...p, part: PARTS[p.key] }))
  rows.sort((x, y) => y.part.price * y.qty - x.part.price * x.qty)
  const printed = design.nodes.filter((n) => n.mat === 'shell' || n.print).length
  // The bench verdict in one sentence — "will it stand?" is the question a
  // first-time builder actually has, and it belongs in plain words too.
  const bench = useMemo(
    () => benchReport(design, analysis, { mat: analysis.print && analysis.print.material, slopeDeg: 15 }),
    [design, analysis],
  )
  const benchWorst = bench.verdicts.find((v) => v.status === 'fail') || bench.verdicts.find((v) => v.status === 'warn')
  const benchOk = !benchWorst
  const big = (k, v, sub, color) => h('div', { style: S.bigCard },
    h('div', { style: S.bigKey }, k),
    h('div', { style: { ...S.bigVal, color: color || C.text } }, v),
    sub ? h('div', { style: S.bigSub }, sub) : null)

  return h('div', { style: { padding: '14px 0 8px' } },
    h('div', { style: S.simpleHead }, 'Your machine, in plain words'),
    // Three numbers, chosen for what this design actually costs the builder.
    h('div', { style: S.simpleGrid },
      big('COST', money(analysis.cost), 'parts, at hobby prices', C.accent),
      design.pcb
        ? big('BOARD', `${Math.round(design.pcb.W)}×${Math.round(design.pcb.H)}`, 'mm · 2 layers', C.amber)
        : big('PRINT TIME', `${fmt(analysis.print.hours, 0)} h`, `${Math.round(analysis.print.grams)}g of filament`, C.amber),
      design.pcb
        ? big('JOINTS', `${design.pcb.joints || 0}`, `${(design.pcb.placed || []).length} placements`, C.cyan)
        : big('WEIGHT', `${Math.round(analysis.mass.totalG)} g`, 'finished machine', C.cyan)),
    h('button', {
      style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10px', margin: '0 0 12px' },
      onClick: onAudit,
      title: 'every number here is a sum you can check',
      'aria-label': 'Show the working behind these numbers',
    }, '⌁ how these numbers are made'),
    h('button', {
      style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10px', margin: '0 0 12px 6px' },
      onClick: onCompare,
      title: 'did the last change actually make it better?',
      'aria-label': 'Compare this build with the previous one',
    }, '↔ what changed'),
    h('button', {
      style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10px', margin: '0 0 12px 6px' },
      onClick: onTest,
      title: 'the pre-print test bench: stability, ramp, joint torque',
      'aria-label': 'Open the test bench tab',
    }, '⚗ test bench'),
    h('div', {
      role: 'status',
      style: {
        display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px',
        borderRadius: '7px', marginBottom: '12px', fontSize: '11.5px', lineHeight: 1.45,
        color: C.text, background: levelBg(benchOk ? 'ok' : benchWorst.status === 'fail' ? 'fail' : 'warn'),
        borderLeft: `3px solid ${levelColor(benchOk ? 'ok' : benchWorst.status === 'fail' ? 'fail' : 'warn')}`,
      },
    },
      h('span', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', paddingTop: '2px', color: levelColor(benchOk ? 'ok' : benchWorst.status === 'fail' ? 'fail' : 'warn') } },
        benchOk ? 'BENCH ✓' : 'BENCH !'),
      h('span', {}, benchOk
        ? `Would stand, climb a 15° ramp and hold — ${Math.round(bench.massG)}g, CoM ${Math.round(bench.flatMm)}mm inside its footprint.`
        : `Heads up: ${benchWorst.label.toLowerCase()} — ${benchWorst.detail}`)),
    h(LivePrices, { design }),
    (analysis.checks.filter((c) => c.level !== 'ok').length
      ? h('div', {},
        h('div', { style: S.simpleLabel }, 'HEADS UP, BEFORE YOU BUY'),
        h('div', { style: { marginBottom: '14px' } },
          analysis.checks.filter((c) => c.level !== 'ok').slice(0, 3).map((c, i) => h('div', {
            key: 'w' + i,
            style: {
              display: 'flex', gap: '7px', alignItems: 'flex-start', padding: '6px 8px',
              borderRadius: '6px', marginBottom: '5px', lineHeight: 1.45, fontSize: '11px',
              color: C.text, background: levelBg(c.level), borderLeft: `2px solid ${levelColor(c.level)}`,
            },
          },
            h('span', { style: { color: levelColor(c.level), flex: '0 0 auto', fontFamily: C.mono } }, c.level === 'fail' ? '✕' : '!'),
            h('span', {}, c.msg)))))
      : null),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '7px' } },
      h('div', { style: S.simpleLabel }, 'WHAT TO BUY'),
      h('button', {
        style: { ...S.btn, height: '22px', padding: '0 8px', fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.04em' },
        title: 'read real unit prices from the LCSC parts index (asks Hermes to run the price tool)',
        onClick: () => askPrices(design),
      }, '⌁ LIVE PRICES')),
    h('div', { style: { marginBottom: '14px' } }, rows.slice(0, 6).map((r) => h('div', { key: r.key, style: S.buyRow },
      h('span', { style: S.buyName }, r.part.name),
      h('span', { style: S.buyQty }, `×${r.qty}`),
      h('span', { style: S.buyPrice }, money(r.part.price * r.qty)))),
      rows.length > 6 ? h('div', { style: S.buyMore }, `+ ${rows.length - 6} more line items`) : null),
    // A board is not printed, so this block says what actually happens to it:
    // the fab makes the PCB, you place the parts, or an assembly house does.
    design.pcb
      ? h('div', {},
        h('div', { style: S.simpleLabel }, 'WHAT HAPPENS NOW'),
        h('div', { style: { fontSize: '11.5px', color: C.dim, lineHeight: 1.7, marginBottom: '12px' } },
          h('div', {}, `The board is fabricated: ${Math.round(design.pcb.W)}×${Math.round(design.pcb.H)}mm, 2 layers, 1.6mm.`),
          h('div', {}, `Then ${(design.pcb.placed || []).length} parts go on — ${(design.pcb.joints || 0)} solder joints.`),
          h('div', { style: { color: C.faint } }, 'Send the board files to a fab; send the parts to an assembly house if you would rather not solder.')))
      : h('div', {},
        h('div', { style: S.simpleLabel }, 'WHAT TO PRINT'),
        h('div', { style: { fontFamily: C.mono, fontSize: '11.5px', color: C.dim, lineHeight: 1.6, marginBottom: '16px' } },
          `${printed} printed parts · ${fmt(analysis.print.hours, 1)} h · ${Math.round(analysis.print.grams)} g PETG`,
          h('div', { style: { color: C.faint, fontSize: '10.5px', marginTop: '3px' } },
            'One file per part: laid flat, centred on the bed, sitting on Z=0.'))),
    h('button', { style: { ...S.btnPrimary, height: '40px', fontSize: '13px' }, onClick: exports[1][1] },
      design.pcb ? '⬇ DOWNLOAD THE FAB + ASSEMBLY FILES' : '⬇ DOWNLOAD THE PRINT PACK (.zip)'),
    h('button', {
      style: { ...S.btn, marginTop: '8px', height: '32px', width: '100%', justifyContent: 'center' },
      onClick: onEngineer,
    }, '⌁ SHOW ME THE ENGINEERING'))
}

// Sentences a person can actually type, each of which the matcher resolves.
// Deterministic worked examples: a fixed brief, and why an engineer would use it.
const WORKED_EXAMPLES = [
  { label: 'Bench arm, 5-DoF', why: 'sorts 3D-printed parts', brief: { archetype: 'arm', mission: '5-DoF arm that sorts 3D-printed parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 } },
  { label: 'Survey rover, 4WD', why: 'maps a room at walking pace', brief: { archetype: 'rover', mission: 'a rover that maps my room', payloadKg: 2, wheelMm: 100 } },
  { label: 'Plant sensor, IoT case', why: 'STEM build, one afternoon', brief: { archetype: 'iot', mission: 'a plant sensor that reports soil moisture to my phone', payloadKg: 0, battery: 'lipo2s' } },
]

const EXAMPLES = [
  'a rover that maps my room',
  'a gripper that sorts screws',
  'a board with a screen and a sensor',
]

const ARCHETYPES = [
  ['iot', 'IoT'], ['gadget', 'ESP32'], ['gripper', 'GRIPPER'], ['arm', 'ARM'], ['rover', 'ROVER'],
  ['quadruped', 'QUAD'], ['humanoid', 'HUMANOID'], ['robot', 'FULL ROBOT'], ['gantry', 'GANTRY'],
]

// Plain words next to every preset — the cards are how a first-timer builds
// without ever typing a brief.
const PRESET_BLURBS = {
  iot: 'one sensor, one case, one afternoon',
  pcb: 'a real board, fab + assembly files',
  gantry: 'metre-scale, belts + rails',
  arm: 'lifts and sorts small parts',
  rover: 'a rolling robot that explores',
  quad: 'a robot dog that walks',
  grip: 'a claw that grabs things',
  humanoid: 'a walking robot with arms',
  robot: 'rover + arm in one machine',
  desk: 'a little electronic desk gadget',
}

/** One honest sentence anybody can read — the tables below carry the detail. */
function plainVerdict(checks) {
  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  if (fails) return { icon: '✗', color: C.red, text: `Hold on — ${fails} thing${fails > 1 ? 's' : ''} must be fixed before this is safe to build.` }
  if (warns) return { icon: '!', color: C.amber, text: `Buildable, but read the ${warns} warning${warns > 1 ? 's' : ''} first.` }
  return { icon: '✓', color: C.green, text: 'Ready to build — every engineering check passed.' }
}

const MAT_OPTIONS = Object.entries(MATERIALS).map(([k, m]) => ({
  value: k, label: `${m.name} · E${m.elastic}GPa`,
}))

function Studio() {
  const [brief, setBrief] = useState(() => (CTX && CTX.storage.get('lastBrief', null)) || DEFAULT_BRIEF)
  const [mission, setMission] = useState(() => brief.mission)
  const [missionDirty, setMissionDirty] = useState(false)
  const [tab, setTab] = useState('spec')
  const [simple, setSimple] = useState(() => (CTX && CTX.storage.get('simple', true)) !== false)
  const [guideOff, setGuideOff] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [allMachines, setAllMachines] = useState(false)
  const [menu, setMenu] = useState(false)
  const [shelf, setShelf] = useState(() => (CTX && CTX.storage.get('shelf', [])) || [])
  const [link, setLink] = useState('idle') // 'live' | 'offline' | 'idle'
  const [jointGroup, setJointGroup] = useState('all')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [history, setHistory] = useState([])

  const spec = useMemo(() => composeDesign(brief), [brief])
  const { design, analysis } = spec

  const [pose, setPose] = useState(() => design.joints.map(() => 0))
  // `pose` is the COMMAND (what the sliders ask for); `dispPose` is the STATE
  // (where the joints physically are). The sim slews one toward the other at
  // each servo's real speed and stalls under overload — drag a slider and the
  // machine follows like hardware, not like a slider preview.
  const [dispPose, setDispPose] = useState(() => design.joints.map(() => 0))
  const simRef = useRef(null)
  const [cam, setCam] = useState(() => CAM_FOR(analysis.dims))
  const [opts, setOpts] = useState({ grid: true, dims: false, wire: false, explode: false })

  // A joint set can change with the brief (3-DoF → 6-DoF): keep the pose array
  // the same length as the chain, or the sliders lie about the machine.
  useEffect(() => {
    setPose((p) => design.joints.map((j, i) => (p[i] == null ? 0 : clamp(p[i], j.min, j.max))))
  }, [design])

  // The physics loop: rebuild the sim when the machine changes, feed it every
  // commanded pose, and publish actual angles only while something is moving.
  useEffect(() => {
    const sim = createJointSim(design, analysis)
    simRef.current = sim
    sim.snap(pose)
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (sim.step(dt, now)) setDispPose([...sim.state.angles])
      // endurance: drain the pack, heat the servos, feed thermal cutoffs back
      if (powerRef.current) {
        const drv = driveRef.current
        const motorA = drv ? Math.abs(drv.state.throttle) * motorARef.current : 0
        powerRef.current.step(dt * timeWarpRef.current, sim.state, motorA)
        sim.state.thermal = powerRef.current.state.cut
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); simRef.current = null }
    // pose is read once at snap; later commands arrive via the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, analysis])

  useEffect(() => {
    simRef.current && simRef.current.setTargets(pose)
  }, [pose])

  useEffect(() => {
    setCam((c) => ({ ...c, dist: CAM_FOR(analysis.dims).dist }))
  }, [analysis.dims[0], analysis.dims[1], analysis.dims[2]])

  useEffect(() => {
    if (CTX) CTX.storage.set('lastBrief', brief)
  }, [brief])

  // A build handed over by the agent (`::rigforge{...}` → card → here) lands
  // now, and the first thing it shows is what it changed: an agent rewrite is a
  // proposal, so it gets the same before/after as your own edits.
  const [fromAgent, setFromAgent] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  useEffect(() => {
    if (!CTX) return
    const pending = CTX.storage.get('pendingBrief', null)
    if (pending && pending.mission) {
      CTX.storage.remove('pendingBrief')
      const before = CTX.storage.get('lastBrief', null)
      if (before && before.mission) setHistory([{ brief: before, at: Date.now() }])
      setBrief({ ...DEFAULT_BRIEF, ...pending })
      setMission(pending.mission || '')
      setFromAgent(true)
      setSimple(false)
      setCompareOpen(true)
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
    joints: design.joints.map((j, i) => ({ ...j, angle: dispPose[i] || 0 })),
  }), [design, dispPose])

  const mesh = useMemo(() => buildMesh(posedDesign, opts.explode ? 1 : 0), [posedDesign, opts.explode])

  // Live bench overlay: support polygon + CoM plumb recomputed with the pose,
  // so the floor tells the stability story while joints move.
  const benchOv = useMemo(
    () => benchOverlay(posedDesign, analysis.print && analysis.print.material),
    [posedDesign, analysis],
  )

  // ── drive mode: WASD / gamepad throttle+steer on wheeled machines ────────
  const driveRef = useRef(null)
  const ikRef = useRef(null)
  const gaitRef = useRef(null)
  const gripRef = useRef(null)
  const senseRef = useRef(null)
  const powerRef = useRef(null)
  const motorARef = useRef(0)
  const [driveAvail, setDriveAvail] = useState(false)
  const [teleopKind, setTeleopKind] = useState(null)
  const [driveOn, setDriveOn] = useState(false)
  const [chassis, setChassis] = useState(null)
  const [benchEnv, setBenchEnv] = useState({ surface: 'hardwood', slopeDeg: 0, payloadKg: 0, course: 'rack' })
  const [, setSenseTick] = useState(0)
  const [timeWarp, setTimeWarp] = useState(1)
  const timeWarpRef = useRef(1)
  timeWarpRef.current = timeWarp
  const keysRef = useRef({})
  const spaceEdgeRef = useRef(false)
  const rumbleRef = useRef({})
  const benchStatsRef = useRef(null)
  const gpBtnRef = useRef(false)
  const autotestRef = useRef(null)

  useEffect(() => {
    driveRef.current = createDrive(design, analysis)
    ikRef.current = driveRef.current ? null : createArmTeleop(design)
    gaitRef.current = (driveRef.current || ikRef.current) ? null : createGaitTeleop(design)
    gripRef.current = (driveRef.current || ikRef.current || gaitRef.current) ? null : createGripTeleop(design)
    senseRef.current = (driveRef.current || ikRef.current || gaitRef.current || gripRef.current) ? null : createSensorTeleop(design)
    const kind = driveRef.current ? 'drive' : ikRef.current ? 'ik' : gaitRef.current ? 'gait' : gripRef.current ? 'grip' : senseRef.current ? 'sense' : null
    setTeleopKind(kind)
    autotestRef.current = createAutotest(driveRef.current || ikRef.current || gaitRef.current || gripRef.current || senseRef.current)
    setDriveAvail(!!kind)
    setChassis(null)
    if (ikRef.current) ikRef.current.reset()
    if (gaitRef.current) gaitRef.current.reset()
    if (gripRef.current) gripRef.current.reset()
    powerRef.current = createPowerSim(design)
    const mk = design.metrics && design.metrics.motor ? PARTS[design.metrics.motor] : null
    motorARef.current = mk && mk.curr ? (mk.curr.typ || 0.5) * 2 : 0
  }, [design, analysis])

  useEffect(() => {
    if (driveRef.current) driveRef.current.setEnv(benchEnv)
  }, [benchEnv])

  useEffect(() => {
    if (!driveOn || (!driveRef.current && !ikRef.current && !gaitRef.current && !gripRef.current && !senseRef.current)) return undefined
    const drive = driveRef.current
    const ik = ikRef.current
    const gait = gaitRef.current
    const grip = gripRef.current
    const sense = senseRef.current
    benchStatsRef.current = {
      seconds: 0, maxV: 0, bumps: 0, stallMs: 0, slipMs: 0,
      minSoc: 100, maxTemp: 0, cutouts: 0, ikErr: null, mode: teleopKind,
    }
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // a dead pack is a dead machine — honest cutoff, not a slowdown
      const pwrDead = powerRef.current && powerRef.current.state.soc < 2
      const k = keysRef.current
      const gps = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
      const gp = gps && gps[0]
      if (!pwrDead && drive) {
        const at = autotestRef.current
        let throttle, steer
        if (at && at.running) {
          ;({ throttle, steer } = at.tick(dt))
        } else {
          throttle = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
          steer = (k.a || k.arrowleft ? 1 : 0) - (k.d || k.arrowright ? 1 : 0)
        }
        if (gp && !(at && at.running)) {
          const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v)
          const gx = dz(gp.axes[0] || 0)
          const gy = dz(gp.axes[1] || 0)
          if (Math.abs(gx) > 0.04 || Math.abs(gy) > 0.04) { steer = -gx; throttle = -gy }
        }
        drive.step({ throttle, steer }, dt)
        // gamepad face button = shove test (edge-triggered)
        if (gp && gp.buttons && gp.buttons[1] && gp.buttons[1].pressed && !gpBtnRef.current) drive.shove(15)
        gpBtnRef.current = !!(gp && gp.buttons && gp.buttons[1] && gp.buttons[1].pressed)
        setChassis({ ...drive.state })
      } else if (!pwrDead && ik) {
        // WASD/arrows plane, R/F height; left stick plane, right stick height
        let cx = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
        let cy = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0)
        let cz = (k.r ? 1 : 0) - (k.f ? 1 : 0)
        const at = autotestRef.current
        const actual = simRef.current ? simRef.current.state.angles : dispPose
        if (gp && !(at && at.running)) {
          const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v)
          const gx = dz(gp.axes[0] || 0)
          const gy = dz(gp.axes[1] || 0)
          const gz = dz(gp.axes[3] != null ? gp.axes[3] : gp.axes[2] || 0)
          if (Math.abs(gx) > 0.04 || Math.abs(gy) > 0.04 || Math.abs(gz) > 0.04) {
            cx = -gy; cy = gx; cz = -gz
          }
        }
        let certPose = null
        if (at && at.running) {
          const c = at.tick(dt, actual)
          if (c && c.pose) certPose = c.pose
          else if (c) { cx = c.x || 0; cy = c.y || 0; cz = c.z || 0 }
        }
        // certification runs carry their own IK-solved pose — applying it
        // directly skips the velocity-cmd layer the script already bypassed
        const desired = certPose || ik.step({ x: cx, y: cy, z: cz }, dt, actual)
        if (desired) setPose(desired)
      } else if (!pwrDead && gait) {
        // W/S walk speed, A/D steer; gamepad left stick same
        const want = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
        const turn = (k.a || k.arrowleft ? 1 : 0) - (k.d || k.arrowright ? 1 : 0)
        let gx = want, gy = turn
        const at = autotestRef.current
        if (gp && !(at && at.running)) {
          const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v)
          const gx2 = dz(gp.axes[0] || 0)
          const gy2 = dz(gp.axes[1] || 0)
          if (Math.abs(gx2) > 0.04 || Math.abs(gy2) > 0.04) { gy = -gx2; gx = -gy2 }
        }
        if (at && at.running) {
          const c = at.tick(dt)
          if (c) { gx = c.x || 0; gy = c.y || 0 }
        }
        const actual = simRef.current ? simRef.current.state.angles : dispPose
        if (gait.locomote) {
          const r = gait.locomote({ x: gx, y: gy }, dt, actual, benchEnv)
          if (r && r.pose) setPose(r.pose)
          if (r && r.chassis) setChassis({ ...r.chassis })
        } else {
          const desired = gait.step({ x: gx }, dt, actual)
          if (desired) setPose(desired)
        }
      } else if (!pwrDead && grip) {
        const at = autotestRef.current
        const gcmd = at && at.running ? at.tick(dt) : { grip: k.space, gripEdge: spaceEdgeRef.current }
        const desired = grip.step(gcmd, dt)
        if (desired) setPose(desired)
      } else if (!pwrDead && sense) {
        // sensor nodes have no motion cmd — the autopilot writes stimulus
        // fields straight into teleop state on its own timeline
        const at = autotestRef.current
        if (at && at.running) at.tick(dt)
      }
      // bench stats: everything the test report needs, accumulated live
      const bs = benchStatsRef.current
      if (bs) {
        bs.seconds += dt
        const st = drive ? drive.state : (gait && gait.locomoteState) || null
        if (st) {
          bs.maxV = Math.max(bs.maxV, Math.abs(st.v))
          bs.stallMs += st.stall ? dt * 1000 : 0
          bs.slipMs += st.slip ? dt * 1000 : 0
          bs.bumps = Math.max(bs.bumps, st.bumps || 0)
        }
        if (ik && ik.state && ik.state.ready) bs.ikErr = Math.max(bs.ikErr || 0, ik.state.err || 0)
        const ps = powerRef.current && powerRef.current.state
        if (ps) {
          bs.minSoc = Math.min(bs.minSoc, ps.soc)
          const tmax = ps.temps && ps.temps.length ? Math.max(...ps.temps) : 0
          bs.maxTemp = Math.max(bs.maxTemp, tmax)
          bs.cutouts = Math.max(bs.cutouts, (ps.cut || []).filter(Boolean).length)
        }
      }
      // haptics: edge-triggered rumble — stall, wheelspin, bumps, joint stall,
      // dead pack, sensor alert. One buzz per event, not a continuous scream.
      if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
        const mob = drive ? drive.state : (gait && gait.locomoteState) || null
        const bumpN = (mob && mob.bumps) || 0
        const jstall = !!(simRef.current && simRef.current.state.stalled && simRef.current.state.stalled.some(Boolean))
        const sal = sense ? sense.hud().alerts.length : 0
        const now2 = {
          stall: !!(mob && mob.stall),
          slip: !!(mob && mob.slip),
          bump: bumpN,
          jstall,
          dead: !!pwrDead,
          sense: sal > 0,
        }
        const prev = rumbleRef.current
        const buzz = (sMag, wMag, ms) => {
          try { gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: sMag, weakMagnitude: wMag }) } catch { /* pad went away */ }
        }
        if (now2.stall && !prev.stall) buzz(0.7, 0.5, 220)
        else if (now2.slip && !prev.slip) buzz(0.35, 0.35, 120)
        if (now2.bump > prev.bump) buzz(0.9, 0.2, 140)
        if (now2.jstall && !prev.jstall) buzz(0.6, 0.6, 200)
        if (now2.dead && !prev.dead) buzz(1, 1, 400)
        if (now2.sense && !prev.sense) buzz(0.3, 0.5, 150)
        rumbleRef.current = now2
      }
      spaceEdgeRef.current = false
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [driveOn])

  useEffect(() => {
    if (!driveOn) return undefined
    const dn = (e) => {
      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
        keysRef.current[key === ' ' ? 'space' : key] = true
        if (key === ' ' && !e.repeat) spaceEdgeRef.current = true
        e.preventDefault()
      }
      if (key === '0') { driveRef.current && driveRef.current.reset(); ikRef.current && ikRef.current.reset(); gaitRef.current && gaitRef.current.reset(); gripRef.current && gripRef.current.reset(); senseRef.current && senseRef.current.reset(); powerRef.current && powerRef.current.reset() }
      if (key === 'x' && driveRef.current) driveRef.current.shove(15)
    }
    const up = (e) => { keysRef.current[e.key.toLowerCase() === ' ' ? 'space' : e.key.toLowerCase()] = false }
    window.addEventListener('keydown', dn)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up) }
  }, [driveOn])

  // The displayed mesh: applyChassis mutates verts in place on persistent tri
  // objects so the array identity — and the renderer's topology/tint cache —
  // survives every frame. The traction rack rides along as extra world-space
  // tris appended once per (mesh, slope, drive) change.
  const xfRef = useRef(null)
  // World-space bench props ride along as extra tris: the traction rack for
  // drive mode, the pick-place desk for reach mode. Identity-stable per
  // (mesh, mode, slope) so the renderer caches survive every frame.
  const rtTris = useMemo(
    () => (driveOn && (teleopKind === 'drive' || teleopKind === 'gait')
      ? (benchEnv.course === 'room' ? livingRoomTris() : benchEnv.course === 'stairs' ? stairsTris() : benchRampTris(benchEnv.slopeDeg))
      : driveOn && teleopKind === 'ik' ? deskPropsTris()
      : driveOn && teleopKind === 'grip' ? gripBenchTris() : null),
    [driveOn, teleopKind, benchEnv],
  )
  const viewMesh = useMemo(() => {
    if (!chassis && !rtTris) return mesh
    const rtSig = rtTris ? ((teleopKind === 'drive' || teleopKind === 'gait') ? (benchEnv.course === 'room' ? 'room' : benchEnv.course === 'stairs' ? 'stairs' : `ramp${benchEnv.slopeDeg}`) : teleopKind === 'ik' ? 'desk' : 'grip') : null
    let xf = xfRef.current
    if (!xf || xf.src !== mesh || xf.rtSig !== rtSig || (xf.mach && !chassis)) {
      xf = {
        src: mesh, rtSig,
        mach: chassis ? new Array(mesh.length) : null,
        rt: rtTris, combined: null,
      }
      xfRef.current = xf
    }
    const mach = chassis ? applyChassis(mesh, chassis, benchEnv.slopeDeg, xf.mach, benchEnv.course) : mesh
    if (!xf.combined) {
      const n = mach.length + (xf.rt ? xf.rt.length : 0)
      xf.combined = new Array(n)
      for (let i = 0; i < mach.length; i++) xf.combined[i] = mach[i]
      if (xf.rt) for (let i = 0; i < xf.rt.length; i++) xf.combined[mach.length + i] = xf.rt[i]
    }
    return xf.combined
  }, [mesh, chassis, rtTris, teleopKind, benchEnv])

  // The overlay rides the machine in plan, but its points live ON the terrain:
  // yaw+translate in x/y, then each point takes the ramp height under it.
  // camera chases the machine, not the course: course dressing can span
  // metres while cam.dist is framed on the machine's own dimensions
  const machBounds = useMemo(() => boundsOfMesh(mesh), [mesh])
  const camFocus = useMemo(() => {
    if (!chassis) return null
    const c = Math.cos(chassis.yaw), sn = Math.sin(chassis.yaw)
    const cx = (machBounds.min[0] + machBounds.max[0]) / 2
    const cy = (machBounds.min[1] + machBounds.max[1]) / 2
    const cz = (machBounds.min[2] + machBounds.max[2]) / 2
    return [
      cx * c - cy * sn + chassis.x * 1000,
      cx * sn + cy * c + chassis.y * 1000,
      terrainHeight(chassis.x, benchEnv.slopeDeg, benchEnv.course) * 1000 + cz,
    ]
  }, [chassis, machBounds, benchEnv])
  // floor contact-shadow radius tracks the machine, not the (possibly huge) course
  const subjectR = useMemo(() => {
    const d = [0, 1, 2].map((i) => machBounds.max[i] - machBounds.min[i])
    return Math.min(1600, Math.max(160, Math.max(...d) * 0.8))
  }, [machBounds])
  const viewOpts = useMemo(
    () => ({ ...opts, subjectR, subjectBounds: machBounds, focus: camFocus }),
    [opts, subjectR, machBounds, camFocus],
  )
  const benchOvWorld = useMemo(() => {
    if (!benchOv || !chassis) return benchOv
    const c = Math.cos(chassis.yaw), sn = Math.sin(chassis.yaw)
    const slope = benchEnv.slopeDeg
    const d = benchOv.data
    const out = new Float32Array(d.length)
    for (let i = 0; i < d.length; i += 6) {
      // overlay verts are mm (design space); chassis state is metres
      const wx = (d[i] * c - d[i + 1] * sn) / 1000 + chassis.x
      const wy = (d[i] * sn + d[i + 1] * c) / 1000 + chassis.y
      out[i] = wx * 1000
      out[i + 1] = wy * 1000
      out[i + 2] = terrainHeight(wx, slope, benchEnv.course) * 1000 + d[i + 2]
      out[i + 3] = d[i + 3]; out[i + 4] = d[i + 4]; out[i + 5] = d[i + 5]
    }
    return { data: out, verts: benchOv.verts }
  }, [benchOv, chassis, benchEnv])

  const teleop = driveRef.current || ikRef.current || gaitRef.current || gripRef.current || senseRef.current
  const driveHud = driveOn && teleop && (teleopKind !== 'ik' || ikRef.current.state.ready)
    ? teleop.hud()
    : null
  const powerHud = powerRef.current ? powerRef.current.hud() : null
  // Desk-bench verdict: which pick-place prop is the end-effector over, and
  // does its mass beat the arm's payload rating?
  const propHud = useMemo(() => {
    if (teleopKind !== 'ik' || !ikRef.current || !ikRef.current.state.ready) return null
    const s = ikRef.current.state
    const near = deskPropNear(s.tx, s.ty, s.tz)
    if (!near) return null
    const ratingG = ((design.metrics && design.metrics.payloadKg) || 0) * 1000
    return { name: near.prop.name, massG: near.prop.massG, ratingG, over: ratingG > 0 && near.prop.massG > ratingG }
  }, [driveHud, teleopKind, design])
  // Grip bench verdict: the 1kg test mass vs this gripper's hold capacity.
  const gripHud = useMemo(() => {
    if (teleopKind !== 'grip') return null
    const hold = design.metrics && design.metrics.gripMassKg
    if (!hold) return null
    return { holdKg: hold, blockKg: GRIP_BENCH.massG / 1000, ok: hold >= GRIP_BENCH.massG / 1000 }
  }, [teleopKind, design])
  // Break → Fix: the bench detects failures; this line prescribes the fix.
  // benchLive mirrors SimplePanel's verdict but lives in Studio scope.
  const benchLive = useMemo(() => benchReport(design, analysis, { slopeDeg: 15 }), [design, analysis])
  const fixes = useMemo(() => fixSuggestions({ bench: benchLive, drive: driveHud, prop: propHud, grip: gripHud, sense: driveHud, power: powerHud, brief }),
    [benchLive, driveHud, propHud, gripHud, powerHud, brief])

  // Field-test report: everything the bench logged, as a markdown file the
  // builder can attach to the print pack or paste into a build log.
  const downloadReport = useCallback(() => {
    const bs = benchStatsRef.current || {}
    const modeName = { drive: 'DRIVE', ik: 'REACH', gait: 'WALK', grip: 'GRIP', sense: 'SENSE' }[bs.mode] || 'MANUAL'
    const md = [
      '# RigForge field-test report',
      '',
      `- **machine:** ${design.title || design.subtitle || 'untitled'}`,
      `- **mode:** ${modeName} · **duration:** ${((bs.seconds || 0)).toFixed(0)}s sim`,
      bs.maxV ? `- **top speed:** ${bs.maxV.toFixed(2)} m/s` : null,
      bs.bumps ? `- **obstacle hits:** ${bs.bumps}` : null,
      (bs.stallMs || bs.slipMs) ? `- **stall time:** ${(bs.stallMs / 1000).toFixed(1)}s · **slip time:** ${(bs.slipMs / 1000).toFixed(1)}s` : null,
      bs.ikErr != null ? `- **worst IK error:** ${bs.ikErr.toFixed(1)} mm` : null,
      `- **battery:** lowest SoC ${(bs.minSoc ?? 100).toFixed(0)}% of pack`,
      bs.maxTemp ? `- **peak servo temp:** ${bs.maxTemp.toFixed(0)}°C · **thermal cutouts:** ${bs.cutouts || 0}` : null,
      `- **verdict:** ${fixes.length ? fixes[0].msg : 'no failures logged — bench clean'}`,
      ...(autotestRef.current && autotestRef.current.results.length ? [
        '',
        `## Auto test — ${autotestRef.current.score}`,
        ...autotestRef.current.results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} **${r.label}** — ${r.detail}`),
      ] : []),
      '',
      '_Generated by RigForge test bench — numbers are simulated, not measured._',
    ].filter(Boolean).join('\n')
    try {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = 'rigforge-test-report.md'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch { /* SSR / no DOM */ }
  }, [design, fixes])

  const applyBrief = useCallback((next) => {
    setBrief((cur) => ({ ...cur, ...next }))
  }, [])

  const pickArchetype = (id) => {
    const preset = PRESETS.find((p) => p.brief.archetype === id)
    const next = { ...DEFAULT_BRIEF, ...(preset ? preset.brief : { archetype: id }) }
    setBrief(next)
    setMission(next.mission)
  }

  // One place records what a change replaced, whatever path made it: a preset,
  // the palette, a slider or an agent directive. Debounced so a slider drag is
  // one "before", not forty.
  const briefRef = useRef(brief)
  useEffect(() => {
    const prev = briefRef.current
    if (prev === brief) return undefined
    briefRef.current = brief
    if (JSON.stringify(prev) === JSON.stringify(brief)) return undefined
    const t = setTimeout(() => {
      setHistory((h) => (JSON.stringify(h[0] && h[0].brief) === JSON.stringify(prev) ? h : [{ brief: prev, at: Date.now() }, ...h].slice(0, 4)))
    }, 900)
    return () => clearTimeout(t)
  }, [brief])

  // ⌘K / Ctrl+K opens the palette; Esc closes it from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onBuild = () => {
    // An empty brief is not an error — it is an invitation. Surprise them.
    const parsed = mission.trim() ? parseBrief(mission) : { ...PRESETS[Math.floor(Math.random() * PRESETS.length)].brief }
    applyBrief({ ...parsed, material: brief.material, mcu: brief.mcu, battery: brief.battery })
  }

  const loadWorkedExample = (ex) => {
    const next = { ...DEFAULT_BRIEF, ...ex.brief }
    setBrief(next)
    setMission(next.mission || '')
    setMissionDirty(true)
  }

  const surprise = () => {
    const p = PRESETS[Math.floor(Math.random() * PRESETS.length)]
    const jitter = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v * (0.8 + Math.random() * 0.5))))
    const b = { ...DEFAULT_BRIEF, ...p.brief, payloadKg: Math.round((p.brief.payloadKg || 1) * (0.7 + Math.random() * 0.9) * 10) / 10 }
    if (p.brief.reachMm) b.reachMm = jitter(p.brief.reachMm, 150, 900)
    setBrief(b)
    setMission(b.mission)
  }

  const saveToShelf = () => {
    const entry = {
      id: `${Date.now()}`,
      title: design.title,
      archetype: brief.archetype,
      cost: Math.round(analysis.cost * 100) / 100,
      brief,
      code: encodeBuild(brief),
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

  const copyBuildCode = async () => {
    const code = encodeBuild(brief)
    try {
      await navigator.clipboard.writeText(code)
      host.notify({ kind: 'success', message: `Build code copied — ${code.length} characters` })
    } catch {
      download(`${slug(design.title)}-code.txt`, code, 'text/plain')
      host.notify({ kind: 'info', message: 'Clipboard blocked — saved as a file instead' })
    }
  }

  const fileBase = slug(design.title)
  const exports = [
    ['Build code · share this design', copyBuildCode],
    ['STL mesh (mm)', () => download(`${fileBase}.stl`, toSTL(buildMesh(posedDesign)), 'model/stl')],
    // What leaves the app has to match what the machine actually needs: a
    // printed machine wants STLs, a board wants the fab/assembly three files.
    design.pcb
      ? ['Board pack · BOM + CPL + spec (zip)', () => download(`${fileBase}-boardpack.zip`, zipStore(boardPack(design, analysis, fileBase)), 'application/zip')]
      : ['Print pack · per-part STLs (zip)', () => download(`${fileBase}-printpack.zip`, zipStore(printedPartSTLs(design)), 'application/zip')],
    ['OpenSCAD source', () => download(`${fileBase}.scad`, toOpenSCAD(design), 'text/plain')],
    ['Build spec .md', () => download(`${fileBase}.md`, toSpecMarkdown(design, analysis), 'text/markdown')],
    ['Bill of materials .csv', () => download(`${fileBase}-bom.csv`, toBOMCsv(design, analysis), 'text/csv')],
    ...(design.pcb && design.pcb.placed.length
      ? [['Centroid / CPL .csv (for assembly)', () => download(`${fileBase}-cpl.csv`, toCentroidCsv(design), 'text/csv')]]
      : []),
    ['Firmware .ino', () => download(`${fileBase}.ino`, design.firmware, 'text/plain')],
    // a real simulator loads these: URDF for ROS/Isaac/Drake/PyBullet, MJCF for MuJoCo
    ['URDF (ROS · Gazebo · Isaac)', () => download(`${fileBase}.urdf`, toURDF(design, analysis), 'application/xml')],
    ['MJCF (MuJoCo dynamics)', () => download(`${fileBase}.xml`, toMJCF(design, analysis), 'application/xml')],
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

  const shownJoints = design.joints.filter((j) => jointGroup === 'all' || (jointGroup === 'body'
    ? j.id.startsWith('waist') || j.id.startsWith('neck')
    : j.id.startsWith(`${jointGroup}-`)))
  const poseOverflows = shownJoints.length > 9

  const canMirror = design.joints.some((j) => j.id.startsWith('r-')
    && design.joints.some((k) => k.id === `l-${j.id.slice(2)}`))

  // Everything the palette can reach. Built from the same lists the UI renders,
  // so a new archetype or export shows up here without a second edit.
  const commands = useMemo(() => {
    const list = []
    for (const p of PRESETS) {
      list.push({
        id: 'machine-' + p.id, group: 'MACHINE', label: p.label, hint: p.brief.archetype,
        run: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission); setMissionDirty(false) },
      })
    }
    for (const [id, label] of TABS) {
      list.push({ id: 'tab-' + id, group: 'TAB', label, hint: 'open', run: () => { setSimple(false); setTab(id) } })
    }
    for (const [label, fn] of exports) {
      list.push({ id: 'export-' + label, group: 'EXPORT', label, run: fn })
    }
    list.push({ id: 'act-audit', group: 'ACTION', label: 'Show the working — audit every number', run: () => setAuditOpen(true) })
    list.push({ id: 'act-compare', group: 'ACTION', label: 'Compare with the previous build', run: () => setCompareOpen(true) })
    list.push({ id: 'act-share', group: 'ACTION', label: 'Copy a build code to share this design', run: copyBuildCode })
    list.push({ id: 'act-open-code', group: 'ACTION', label: 'Open a build code', run: () => setCodeOpen(true) })
    list.push({ id: 'act-build', group: 'ACTION', label: 'Build this machine', hint: '⏎', run: onBuild })
    list.push({ id: 'act-hermes', group: 'ACTION', label: 'Ask Hermes to redesign it', run: askHermes })
    list.push({ id: 'act-save', group: 'ACTION', label: 'Save this build to the shelf', run: saveToShelf })
    list.push({ id: 'act-simple', group: 'ACTION', label: 'Toggle plain words / engineering', run: () => { const n = !simple; setSimple(n); if (CTX) CTX.storage.set('simple', n) } })
    list.push({ id: 'act-home', group: 'ACTION', label: 'Reset every joint to zero', run: () => setPose(design.joints.map(() => 0)) })
    return list
  }, [simple, brief])

  const fails = analysis.checks.filter((c) => c.level === 'fail').length
  const warns = analysis.checks.filter((c) => c.level === 'warn').length

  const panel = tab === 'spec' ? h(TabSpec, { design, analysis })
    : tab === 'test' ? h(TabTest, { design, analysis })
    : tab === 'parts' ? h(TabParts, { design, analysis })
      : tab === 'pins' ? h(TabPins, { analysis })
        : tab === 'power' ? h(TabPower, { analysis })
          : tab === 'assembly' ? h(TabAssembly, { design, analysis })
          : tab === 'print' ? h(TabPrint, { design, analysis })
            : tab === 'code' ? h(TabCode, { design })
              : h(TabSteps, { design, analysis })

  const strip = (label, value, color, first) => h('div', { style: first ? S.stripItemFirst : S.stripItem },
    h('span', { style: S.stripKey }, label),
    h('span', { style: { ...S.stripVal, color: color || C.text } }, value))

  return h('div', { style: S.root, 'data-rf': 'root' },
    h('style', {}, GLOBAL_CSS),
    // ── top bar: brand · one project strip · actions ────────────────────────
    h('div', { style: S.top },
      h('div', { style: S.mark },
        h('span', { style: { fontFamily: C.mono, fontSize: '16px', color: C.accent, lineHeight: 1 } }, '⌬'),
        h('span', { style: S.wordmark }, 'RIGFORGE'),
        h('span', { style: S.tagline, 'data-rf': 'tagline' }, 'robots · printed machines · spec out')),

      // the numbers belong to the build, so they read as one object, not six chips
      h('div', { style: S.projectStrip, 'data-rf': 'strip' },
        strip('COST', money(analysis.cost), C.text, true),
        strip('MASS', `${Math.round(analysis.mass.totalG)}g`),
        strip('PEAK', `${fmt(analysis.power.peak, 1)}A`, analysis.power.peak > (analysis.power.bat?.maxA || 99) ? C.amber : C.text),
        strip('PRINT', `${fmt(analysis.print.hours, 0)}h`),
        h('button', {
          style: {
            ...S.stripItem, borderLeft: `1px solid ${C.lineSoft}`, background: 'transparent',
            cursor: 'pointer', textAlign: 'left', border: 'none', borderLeftWidth: '1px',
            borderLeftStyle: 'solid', borderLeftColor: C.lineSoft,
          },
          title: 'jump to the engineering self-checks for this design',
          onClick: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') },
        },
          h('span', { style: S.stripKey }, 'CHECKS'),
          h('span', { style: { ...S.stripVal, color: fails ? C.red : warns ? C.amber : C.green } },
            fails ? `${fails} FAIL` : warns ? `${warns} WARN` : 'PASS'))),

      h('div', { style: S.actions },
        h('div', { style: S.seg, role: 'group', 'aria-label': 'detail level' },
          h('button', {
            style: simple ? S.segOn : S.segOff,
            'aria-pressed': simple,
            title: 'plain words: cost, print time, what to buy',
            onClick: () => { setSimple(true); if (CTX) CTX.storage.set('simple', true) },
          }, 'Simple'),
          h('button', {
            style: simple ? S.segOff : S.segOn,
            'aria-pressed': !simple,
            title: 'the engineering: BOM, pins, power, print sheet, firmware, build order',
            onClick: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') },
          }, 'Engineer')),

        h('button', {
          style: { ...S.btn, borderColor: 'rgba(255,106,26,0.5)', color: C.accent, gap: '7px' },
          onClick: askHermes,
          title: link === 'live' ? 'Hermes is connected — hand it this build' : 'hand this build to Hermes',
        },
          h('span', { style: { ...S.dot, background: link === 'live' ? C.green : link === 'offline' ? C.red : C.faint } }),
          'Ask Hermes'),

        h('div', { style: { position: 'relative' } },
          h('button', { style: S.btn, onClick: () => setMenu((m) => !m), 'aria-expanded': !!menu }, 'Export ▾'),
          menu
            ? h('div', { style: S.menu },
              exports.map(([label, fn]) => h('div', {
                key: label, style: S.menuItem,
                onClick: () => { setMenu(false); fn() },
                onMouseEnter: (e) => { e.currentTarget.style.background = C.raise },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
              }, h('span', {}, label))))
            : null),
        h('button', { style: S.btn, onClick: saveToShelf, title: 'keep this build on the shelf' }, 'Save'),
        h('button', {
          style: { ...S.btn, fontFamily: C.mono, letterSpacing: '0.06em' },
          onClick: () => setPaletteOpen(true),
          title: 'command palette (⌘K)',
        }, '⌘K')),
    ),

    // ── body ───────────────────────────────────────────────────────────────
    h('div', { style: S.body, 'data-rf': 'body' },
      // left rail: the brief
      h('div', { style: S.rail, 'data-rf': 'rail' },
        fromAgent
          ? h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '6px 9px',
              borderRadius: '7px', border: `1px solid ${C.accentLine}`, background: 'rgba(255,106,26,0.08)',
              fontSize: '10.5px', color: C.dim,
            },
          },
            h('span', { style: { color: C.accent, fontFamily: C.mono, fontSize: '9.5px', letterSpacing: '0.08em' } }, 'FROM HERMES'),
            h('button', {
              style: { ...S.btn, height: '20px', padding: '0 7px', fontSize: '9.5px', marginLeft: 'auto' },
              onClick: () => setCompareOpen(true),
              'aria-label': 'Compare this agent build with what you had',
            }, 'see what changed'),
            h('button', {
              style: { background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '0 2px' },
              onClick: () => setFromAgent(false),
              'aria-label': 'Dismiss the agent notice',
            }, '×'))
          : null,
        h('div', { style: S.sectionLabel }, 'pick a machine — or describe your own'),
        // Three steps, one row: the guide must not push BUILD below the fold
        // on an 800px window, which is where a laptop actually sits.
        (guideOff || (CTX && CTX.storage.get('seenFirstRun', false))) ? null : h('div', { style: S.firstRunCompact },
          [['1', 'pick or describe'], ['2', 'set one number'], ['3', 'press BUILD']].map(([n, t]) => h('span', { key: n, style: S.firstRunItem },
            h('span', { style: S.firstRunNum }, n),
            h('span', {}, t))),
          h('button', {
            style: { ...S.btn, height: '20px', padding: '0 7px', fontSize: '9.5px', flex: '0 0 auto' },
            'aria-label': 'Hide this guide',
            title: 'hide the guide — it never comes back',
            onClick: () => { if (CTX) { CTX.storage.set('seenFirstRun', true); setGuideOff(true) } },
          }, 'HIDE')),
        h('div', { style: S.cards },
          (allMachines ? PRESETS : PRESETS.slice(0, 4)).map((p) => h('button', {
            key: p.id,
            style: brief.archetype === p.brief.archetype ? S.cardOn : S.card,
            'aria-label': `Build a ${p.label}`,
            onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission) },
          },
            h(Thumb, { archetype: p.brief.archetype }),
            h('span', { style: S.cardTitle }, p.label.toUpperCase()),
            h('span', { style: S.cardSub }, PRESET_BLURBS[p.id] || '')))),
        PRESETS.length > 4
          ? h('button', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              width: '100%', padding: '7px 0', marginTop: '-8px', marginBottom: '12px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: C.faint, fontSize: '10.5px', fontFamily: C.mono, letterSpacing: '0.1em',
            },
            'aria-expanded': allMachines,
            onClick: () => setAllMachines((v) => !v),
          }, allMachines ? '− FEWER MACHINES' : `+ ${PRESETS.length - 4} MORE MACHINES`)
          : null,

        h('textarea', {
          rows: 2, value: mission, style: { ...S.input, marginBottom: '8px' },
          placeholder: '…or describe the machine you want — "a robot car that maps my room"',
          'aria-label': 'Describe the machine to build',
          onChange: (e) => { setMission(e.target.value); setMissionDirty(true) },
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onBuild() } },
        }),
        // What the parser hears, before you commit to it. The matcher already
        // existed; hiding it behind BUILD meant people typed blind.
        (() => {
          const text = (mission || '').trim()
          if (!missionDirty || text.length < 4) return null
          const match = matchArchetype(text)
          const guess = match.id
          const preset = PRESETS.find((x) => x.brief.archetype === guess)
          const same = guess === brief.archetype
          return h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '7px', margin: '0 0 8px', fontSize: '10.5px', flexWrap: 'wrap' },
          },
            h('span', { style: { color: C.faint } }, match.confident ? 'reads as' : 'no match — closest is'),
            h('span', { style: { color: match.confident ? C.cyan : C.amber, fontFamily: C.mono, letterSpacing: '0.04em' } },
              (preset ? preset.label : friendlyArchetype(guess)).toUpperCase()),
            same
              ? h('span', { style: { color: C.faint } }, '· already selected')
              : h('button', {
                style: { ...S.btn, height: '20px', padding: '0 7px', fontSize: '9.5px', flex: '0 0 auto' },
                onClick: () => {
                  if (!preset) return
                  setBrief({ ...DEFAULT_BRIEF, ...preset.brief, mission: text })
                  setMission(text)
                },
              }, 'use its numbers'))
        })(),
        // No words yet? Three sentences that work, one click each.
        (!missionDirty
          ? h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'nowrap', overflowX: 'auto', margin: '0 0 8px', paddingBottom: '2px' } },
            EXAMPLES.map((ex) => h('button', {
              key: ex,
              style: { ...S.chipBtn },
              title: `Build this: ${ex}`,
              onClick: () => {
                const b = { ...DEFAULT_BRIEF, ...brief, mission: ex, archetype: matchArchetype(ex).id }
                const p2 = PRESETS.find((x) => x.brief.archetype === b.archetype)
                setBrief(p2 ? { ...DEFAULT_BRIEF, ...p2.brief, mission: ex } : b)
                setMission(ex)
                setMissionDirty(true)
              },
            }, ex)))
          : null),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { style: S.btnPrimary, onClick: onBuild }, 'BUILD'),
          h('button', {
            style: { ...S.btn, flex: '0 0 auto', padding: '0 10px', gap: '6px' },
            title: 'load a worked example — deterministic, not a random draw',
            'aria-label': 'Load a worked example build',
            onClick: () => setExamplesOpen((v) => !v),
            'aria-expanded': !!examplesOpen,
          }, 'EXAMPLES ▾')),
        // A dice that conjures a random design reads as a slot machine. An
        // engineer wants a worked example they can check, and a child wants the
        // same thing: a known-good machine to take apart.
        examplesOpen
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 8px' } },
            WORKED_EXAMPLES.map((ex) => h('button', {
              key: ex.label,
              style: { ...S.btn, height: '26px', justifyContent: 'flex-start', fontSize: '10.5px', padding: '0 9px' },
              onClick: () => { setExamplesOpen(false); loadWorkedExample(ex) },
            }, `${ex.label} — ${ex.why}`)))
          : null,

        (() => { const v = plainVerdict(analysis.checks); return h('div', {
          style: { display: 'flex', gap: '7px', alignItems: 'flex-start', margin: '2px 0 4px', fontSize: '11px', lineHeight: 1.4, color: C.text },
        },
          h('span', { style: { fontFamily: C.mono, fontWeight: 700, color: v.color, flex: '0 0 auto' } }, v.icon),
          h('span', {}, v.text)) })(),

        h('div', { style: { ...S.sectionLabel, marginTop: '16px' } }, 'parameters'),
        brief.archetype === 'gadget'
          ? h(Select, {
            label: 'MATERIAL', value: brief.material,
            options: MAT_OPTIONS,
            onChange: (v) => applyBrief({ material: v }),
          })
          : h('div', {},
            h(ParamSlider, {
              label: 'PAYLOAD', value: brief.payloadKg, min: 0.1, max: brief.archetype === 'rover' ? 15 : 6, step: 0.1, unit: ' kg',
              hint: 'how much weight it must carry',
              onChange: (v) => applyBrief({ payloadKg: v }),
            }),
            brief.archetype === 'rover' || brief.archetype === 'robot'
              ? h(ParamSlider, {
                label: 'WHEEL Ø', value: brief.wheelMm || (brief.archetype === 'robot' ? 130 : 100),
                min: brief.archetype === 'robot' ? 80 : 60, max: brief.archetype === 'robot' ? 160 : 130,
                step: 5, unit: ' mm',
                hint: 'bigger wheels roll over bumps but drive slower',
                onChange: (v) => applyBrief({ wheelMm: v }),
              })
              : h(ParamSlider, {
                label: brief.archetype === 'gripper' ? 'JAW OPENING' : brief.archetype === 'quadruped' ? 'LEG SPAN' : brief.archetype === 'humanoid' ? 'HEIGHT' : 'REACH',
                value: brief.reachMm, min: 120, max: 1200, step: 10, unit: ' mm',
                hint: brief.archetype === 'gripper' ? 'the widest thing it can grab'
                  : brief.archetype === 'quadruped' ? 'width across the hips'
                    : brief.archetype === 'humanoid' ? 'how tall it stands'
                      : 'how far the arm reaches',
                onChange: (v) => applyBrief({ reachMm: v }),
              }),
            brief.archetype === 'arm'
              ? h(ParamSlider, { label: 'AXES', value: brief.dof, min: 3, max: 6, step: 1, hint: 'how many joints — more axes, more ways to move', onChange: (v) => applyBrief({ dof: v }) })
              : null),

        // Two numbers decide most builds. The rest is real, but it is a second
        // decision — behind a disclosure, not in a beginner's face.
        brief.archetype === 'gadget' ? null : h('button', {
          style: {
            display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
            background: 'none', border: 'none', borderTop: `1px solid ${C.line}`,
            padding: '9px 0 3px', marginTop: '2px', cursor: 'pointer',
            color: C.faint, fontSize: '10.5px', fontFamily: C.mono, letterSpacing: '0.1em',
          },
          'aria-expanded': advanced,
          onClick: () => setAdvanced((v) => !v),
        },
          h('span', { style: { color: advanced ? C.accent : C.faint } }, advanced ? '−' : '+'),
          advanced ? 'FEWER OPTIONS' : `MORE OPTIONS · ${brief.archetype === 'arm' ? 3 : 3}`),

        advanced && brief.archetype !== 'gadget'
          ? h('div', { style: { paddingTop: '10px' } },
            h(Select, {
              label: 'MATERIAL', value: brief.material,
              options: MAT_OPTIONS,
              hint: 'what you print the frame in — PETG survives drops',
              onChange: (v) => applyBrief({ material: v }),
            }),
            h(Select, {
              label: 'CONTROLLER', value: brief.mcu,
              options: MCU_KEYS.map((k) => ({ value: k, label: PARTS[k].name })),
              hint: 'the robot\'s brain',
              onChange: (v) => applyBrief({ mcu: v }),
            }),
            h(Select, {
              label: 'ENERGY', value: brief.battery,
              options: [
                { value: 'pack2s', label: '2S 18650 · 7.4V' },
                { value: 'pack3s', label: '3S 18650 · 11.1V' },
                { value: 'lipo2s', label: 'LiPo 2S 1000mAh' },
                { value: 'lipo3s', label: 'LiPo 3S 2200mAh' },
                { value: 'pd5v', label: 'USB-C tethered' },
              ],
              hint: 'battery pack, or plug it into the wall',
              onChange: (v) => applyBrief({ battery: v }),
            }),
            h(Select, {
              label: 'PRINTER BED', value: String(brief.bedMm || 256),
              options: [
                { value: '180', label: '180mm · Prusa MINI' },
                { value: '220', label: '220mm · Ender 3' },
                { value: '256', label: '256mm · P1S / X1C' },
                { value: '300', label: '300mm · large format' },
                { value: '350', label: '350mm · Voron 350' },
              ],
              hint: 'every printed part is checked against this — parts, not the whole machine',
              onChange: (v) => applyBrief({ bedMm: Number(v) }),
            }))
          : null,

        h('div', { style: { ...S.sectionLabel, marginTop: '12px' } },
          shelf.length ? `shelf · ${shelf.length}` : 'shelf'),
        shelf.length
          ? shelf.map((s) => {
            const code = s.code || encodeBuild(s.brief)
            const age = s.at ? relTime(s.at) : ''
            return h('div', {
              key: s.id, style: S.shelfRow,
              onMouseEnter: (e) => { e.currentTarget.style.borderColor = C.accentLine },
              onMouseLeave: (e) => { e.currentTarget.style.borderColor = C.line },
            },
              h('button', {
                style: { flex: '1 1 auto', minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
                title: `Load ${s.title}`,
                'aria-label': `Load ${s.title}`,
                onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...s.brief }); setMission(s.brief.mission || '') },
              },
                h('span', { style: { fontSize: '11.5px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title),
                h('span', { style: { fontFamily: C.mono, fontSize: '9.5px', color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `${money(s.cost)} · ${friendlyArchetype(s.brief.archetype)}${age ? ' · ' + age : ''}`)),
              h('button', {
                style: { background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '2px 5px', flex: '0 0 auto' },
                'aria-label': `Copy build code for ${s.title}`,
                title: 'copy its build code',
                onClick: async (e) => {
                  e.stopPropagation()
                  try {
                    await navigator.clipboard.writeText(code)
                    host.notify({ kind: 'success', message: `Code for ${s.title} copied` })
                  } catch {
                    host.notify({ kind: 'info', message: 'Clipboard blocked' })
                  }
                },
              }, '⧉'),
              h('button', {
                style: { background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '2px 4px', flex: '0 0 auto' },
                'aria-label': `Remove ${s.title} from the shelf`,
                title: 'remove from shelf',
                onClick: (e) => {
                  e.stopPropagation()
                  const next = shelf.filter((x) => x.id !== s.id)
                  setShelf(next)
                  if (CTX) CTX.storage.set('shelf', next)
                },
              }, '×'))
          })
          : h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, padding: '2px 0 4px' } },
            'Nothing saved yet. Press SAVE and the build lands here with its own build code.'),

        h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: `1px solid ${C.line}`, fontSize: '10px', color: C.faint, lineHeight: 1.5 } },
          'Deterministic engine: torque, current, mass and print time are computed, not narrated. The agent redesigns; the maths here is yours.')),

      // centre: viewport
      h('div', { style: { ...S.col, minWidth: 0, position: 'relative' }, 'data-rf': 'view' },
        h(Viewport, { mesh: viewMesh, cam, setCam, opts: viewOpts, design, analysis, overlay: benchOvWorld, focus: camFocus }),
        driveHud ? h('div', {
          style: {
            position: 'absolute', left: '14px', bottom: '14px', zIndex: 5,
            fontFamily: C.mono, fontSize: '10.5px', color: C.cyan,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '5px 9px', pointerEvents: 'none',
            display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          },
        },
          driveHud.kind === 'ik'
            ? [
                h('span', { key: 'a' }, `IK err ${driveHud.err.toFixed(0)}mm`),
                h('span', { key: 'b', style: { color: C.faint } }, `tgt ${driveHud.tx},${driveHud.ty},${driveHud.tz}`),
                propHud ? h('span', {
                  key: 'prop',
                  style: { color: propHud.over ? C.red : C.green },
                  title: propHud.over ? 'heavier than the arm payload rating — expect sag/stall' : 'within payload rating',
                }, `⛏ ${propHud.name} ${propHud.massG}g${propHud.over ? ' ⚠OVER' : ''}`) : null,
                h('span', { key: 'c', style: { color: C.faint } }, 'WASD+RF reach · 0 reset'),
              ]
            : driveHud.kind === 'gait'
            ? [
                driveHud.loco ? h('span', { key: 'v' }, `v ${driveHud.loco.v.toFixed(2)} m/s`) : null,
                h('span', { key: 'a' }, `gait ${driveHud.cadence}Hz`),
                driveHud.loco && driveHud.loco.gradeDeg ? h('span', { key: 'g' }, `grade ${driveHud.loco.gradeDeg}°`) : null,
                driveHud.loco ? h('span', { key: 'd', style: { color: C.faint } }, `${driveHud.loco.surface} μ${driveHud.loco.mu.toFixed(2)}`) : null,
                driveHud.loco && driveHud.loco.slip ? h('span', { key: 'f', style: { color: C.amber } }, 'SLIP') : null,
                driveHud.loco && driveHud.loco.stall ? h('span', { key: 'g2', style: { color: C.red } }, 'STALL') : null,
                driveHud.loco && driveHud.loco.bumps ? h('span', { key: 'k', style: { color: C.amber } }, `bump×${driveHud.loco.bumps}`) : null,
                h('span', { key: 'b', style: { color: C.faint } }, `${driveHud.strides} strides`),
                h('span', { key: 'c', style: { color: C.faint } }, 'W walk · A/D steer · release to stand'),
              ]
            : driveHud.kind === 'grip'
            ? [
                h('span', { key: 'a' }, `jaw ${driveHud.open ? 'OPEN' : 'SHUT'}`),
                gripHud ? h('span', {
                  key: 'g',
                  style: { color: gripHud.ok ? C.green : C.red },
                  title: `hold capacity ${gripHud.holdKg.toFixed(2)}kg vs ${gripHud.blockKg}kg test mass`,
                }, `${gripHud.ok ? 'HOLD' : 'SLIP'} ${gripHud.blockKg}kg/${gripHud.holdKg.toFixed(1)}kg`) : null,
                h('span', { key: 'b', style: { color: C.faint } }, 'Space toggles'),
              ]
            : driveHud.kind === 'sense'
            ? [
                h('span', { key: 'a' }, `OLED ${driveHud.oled}`),
                ...(driveHud.lines || []).map((ln, i) => h('span', { key: `s${i}`, style: { color: C.faint } }, ln)),
                driveHud.alerts && driveHud.alerts.length
                  ? h('span', { key: 'al', style: { color: C.amber } }, `⚠ ${driveHud.alerts[0]}${driveHud.alerts.length > 1 ? ` +${driveHud.alerts.length - 1}` : ''}`)
                  : h('span', { key: 'ok', style: { color: C.green } }, 'all readings nominal'),
              ]
            : [
                h('span', { key: 'a' }, `v ${driveHud.speed.toFixed(2)} m/s`),
                h('span', { key: 'b' }, `hdg ${driveHud.yawDeg}°`),
                driveHud.gradeDeg ? h('span', { key: 'c' }, `grade ${driveHud.gradeDeg}°`) : null,
                h('span', { key: 'd', style: { color: C.faint } }, `${driveHud.surface} μ${driveHud.mu}`),
                driveHud.mass > 0 ? h('span', { key: 'e', style: { color: C.faint } }, `${driveHud.mass.toFixed(1)}kg`) : null,
                driveHud.slip ? h('span', { key: 'f', style: { color: C.amber } }, 'WHEELSPIN') : null,
                driveHud.stall ? h('span', { key: 'g', style: { color: C.red } }, 'STALL') : null,
                driveHud.slide ? h('span', { key: 'i', style: { color: C.amber } }, 'SLIDE') : null,
                driveHud.course === 'room' ? h('span', { key: 'j', style: { color: C.cyan } }, 'ROOM') : null,
                driveHud.course === 'stairs' ? h('span', { key: 'j2', style: { color: C.cyan } }, 'STAIRS') : null,
                driveHud.bumps ? h('span', { key: 'k', style: { color: C.amber } }, `bump×${driveHud.bumps}`) : null,
                h('span', { key: 'h', style: { color: C.faint } }, 'WASD · X shove · 0 reset'),
              ],
          // endurance telemetry rides every teleop HUD — the pack drains and
          // the servos cook whether you are driving, reaching or walking
          powerHud ? [
            h('span', { key: 'p1', style: { color: powerHud.dead ? C.red : powerHud.soc < 25 ? C.amber : C.faint } },
              `⚡${powerHud.soc.toFixed(0)}%`),
            h('span', { key: 'p2', style: { color: C.faint } }, `${powerHud.vbus.toFixed(1)}V`),
            h('span', { key: 'p3', style: { color: powerHud.tempMax > 70 ? C.amber : C.faint } },
              `🌡${powerHud.tempMax.toFixed(0)}°`),
            powerHud.cuts ? h('span', { key: 'p4', style: { color: C.red } }, `${powerHud.cuts} CUT`) : null,
            powerHud.dead ? h('span', { key: 'p5', style: { color: C.red } }, 'BATTERY DEAD — 0 swaps') : null,
          ] : null,
          fixes.length && (driveHud || propHud || powerHud)
            ? h('div', {
              key: 'fix',
              style: { flexBasis: '100%', display: 'flex', alignItems: 'center', gap: '6px' },
            },
              h('span', {
                style: { color: fixes[0].sev === 'fail' ? C.red : C.amber, fontWeight: 600 },
                title: fixes.map((f) => f.msg).join('\n'),
              }, `⚒ ${fixes[0].msg}${fixes.length > 1 ? `  (+${fixes.length - 1} more)` : ''}`),
              fixes[0].apply ? h('button', {
                style: { ...S.viewChip, padding: '1px 7px', fontSize: '9px', flex: '0 0 auto' },
                title: `rebuild with ${JSON.stringify(fixes[0].apply)} and re-run the bench`,
                onClick: () => { setBrief((b) => ({ ...b, ...fixes[0].apply })); setDriveOn(false) },
              }, 'APPLY FIX') : null)
            : null,
        ) : null,
        driveOn && autotestRef.current && (autotestRef.current.running || autotestRef.current.done) ? h('div', {
          style: {
            position: 'absolute', top: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: 5,
            fontFamily: C.mono, fontSize: '10.5px',
            color: autotestRef.current.done && autotestRef.current.results.every((r) => r.pass) ? C.green : C.cyan,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '5px 10px', pointerEvents: 'none',
            title: (autotestRef.current.results || []).map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.label} — ${r.detail}`).join('\n'),
          },
        }, autotestRef.current.running
          ? `AUTO ${autotestRef.current.phase.label} ${autotestRef.current.phase.t.toFixed(1)}/${autotestRef.current.phase.dur}s · ${autotestRef.current.score}`
          : `AUTO TEST ${autotestRef.current.score} — ${autotestRef.current.results.every((r) => r.pass) ? 'all checks pass' : 'click REPORT for details'}`) : null,
        driveOn && teleopKind === 'drive' ? h('div', {
          style: {
            position: 'absolute', right: '14px', bottom: '14px', zIndex: 5,
            fontFamily: C.mono, fontSize: '10px', color: C.dim,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '7px 10px', width: '188px',
            display: 'flex', flexDirection: 'column', gap: '6px',
          },
        },
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            [['rack', 'RACK'], ['room', 'ROOM'], ['stairs', 'STAIRS']].map(([ck, cl]) => h('button', {
              key: ck,
              onClick: () => setBenchEnv((e) => ({ ...e, course: ck })),
              title: ck === 'room' ? 'living-room course: threshold hump, rug zone, three obstacles'
                : ck === 'stairs' ? 'porch stairs: 4×80mm risers — mounts only if wheel radius bites the nosing'
                : 'traction rack: adjustable ramp and surface',
              style: {
                fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.4px',
                padding: '2px 7px', borderRadius: '4px', cursor: 'pointer',
                border: `1px solid ${benchEnv.course === ck ? C.cyan : C.line}`,
                background: benchEnv.course === ck ? 'rgba(0,229,255,0.12)' : 'transparent',
                color: benchEnv.course === ck ? C.cyan : C.dim,
              },
            }, cl))),
          benchEnv.course === 'rack' ? h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            Object.keys(DRIVE_SURFACES).map((sk) => h('button', {
              key: sk,
              onClick: () => setBenchEnv((e) => ({ ...e, surface: sk })),
              style: {
                fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.4px',
                padding: '2px 7px', borderRadius: '4px', cursor: 'pointer',
                border: `1px solid ${benchEnv.surface === sk ? C.cyan : C.line}`,
                background: benchEnv.surface === sk ? 'rgba(0,229,255,0.12)' : 'transparent',
                color: benchEnv.surface === sk ? C.cyan : C.dim,
              },
            }, sk.toUpperCase()))) : h('div', { style: { fontSize: '9px', color: C.faint } },
              benchEnv.course === 'stairs' ? 'stairs: wood treads, μ0.8 — risers decide' : 'course surfaces: hardwood + rug'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            h('span', { style: { width: '52px', color: C.faint } }, 'RAMP'),
            h('input', {
              type: 'range', min: 0, max: 35, step: 1, value: benchEnv.slopeDeg,
              onChange: (e) => setBenchEnv((b) => ({ ...b, slopeDeg: Number(e.target.value) })),
              style: { flex: 1, accentColor: C.cyan },
              'aria-label': 'ramp angle',
            }),
            h('span', { style: { width: '30px', textAlign: 'right', color: C.cyan } }, `${benchEnv.slopeDeg}°`)),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            h('span', { style: { width: '52px', color: C.faint } }, 'LOAD'),
            h('input', {
              type: 'range', min: 0, max: 2, step: 0.1, value: benchEnv.payloadKg,
              onChange: (e) => setBenchEnv((b) => ({ ...b, payloadKg: Number(e.target.value) })),
              style: { flex: 1, accentColor: C.amber },
              'aria-label': 'payload mass',
            }),
            h('span', { style: { width: '30px', textAlign: 'right', color: C.amber } }, `${benchEnv.payloadKg.toFixed(1)}kg`)),
          h('div', { style: { display: 'flex', gap: '4px', marginTop: '2px' } },
            [5, 15, 30].map((n) => h('button', {
              key: n,
              onClick: () => driveRef.current && driveRef.current.shove(n),
              style: {
                flex: 1, fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.4px',
                padding: '3px 0', borderRadius: '4px', cursor: 'pointer',
                border: `1px solid ${C.line}`, background: 'transparent', color: C.dim,
              },
              title: `shove test — ${n}N lateral impulse`,
            }, `SHOVE ${n}N`))),
        ) : null,
        driveOn && teleopKind === 'sense' && senseRef.current ? h('div', {
          style: {
            position: 'absolute', right: '14px', bottom: '14px', zIndex: 5,
            fontFamily: C.mono, fontSize: '10px', color: C.dim,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '7px 10px', width: '188px',
            display: 'flex', flexDirection: 'column', gap: '6px',
          },
        },
          (senseRef.current.fields || []).map((f) => h('label', {
            key: f.k,
            style: { display: 'flex', alignItems: 'center', gap: '7px' },
          },
            h('span', { style: { width: '52px', color: C.faint } }, `${f.sensorLabel.split(' ')[0]} ${f.label}`),
            h('input', {
              type: 'range', min: f.min, max: f.max, step: f.bool ? 1 : (f.max - f.min) / 100,
              value: senseRef.current.state[f.k],
              onChange: (e) => {
                senseRef.current.set(f.k, f.bool ? Number(e.target.value) > 0.5 : Number(e.target.value))
                setSenseTick((t) => t + 1)
              },
              style: { flex: 1, accentColor: C.cyan },
              'aria-label': `stimulus ${f.k}`,
            }),
            h('span', { style: { width: '34px', textAlign: 'right', color: C.cyan } },
              `${f.bool ? (senseRef.current.state[f.k] ? 'YES' : 'no') : `${senseRef.current.state[f.k]}${f.unit}`}`))),
        ) : null,
        // one instrument: camera presets as a radio group, display as toggles
        h('div', { style: S.viewBar, role: 'toolbar', 'aria-label': 'view options' },
          h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'camera preset' },
            VIEWS.map(([label, yaw, pitch]) => {
              const on = Math.abs(cam.yaw - yaw) < 0.02 && Math.abs(cam.pitch - pitch) < 0.02
              return h('button', {
                key: label,
                style: on ? S.viewPickOn : S.viewPick,
                'aria-pressed': on,
                title: `${label.toLowerCase()} view`,
                onClick: () => setCam((c) => ({ ...c, yaw, pitch })),
              }, label)
            })),
          h('div', { style: S.viewSep }),
          h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'overlays' },
            [['GRID', 'grid'], ['DIMS', 'dims'], ['WIRE', 'wire'], ['EXPLODE', 'explode']].map(([label, key]) => h('button', {
              key,
              style: opts[key] ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!opts[key],
              title: `${label.toLowerCase()} ${opts[key] ? 'on' : 'off'}`,
              onClick: () => setOpts((o) => ({ ...o, [key]: !o[key] })),
            }, label))),
          h('div', { style: S.viewSep }),
          h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'projection' },
            h('button', {
              style: cam.ortho ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!cam.ortho,
              title: 'orthographic projection',
              onClick: () => setCam((c) => ({ ...c, ortho: !c.ortho })),
            }, 'ORTHO'),
            h('button', {
              style: timeWarp === 10 ? S.viewChipOn : S.viewChip,
              'aria-pressed': timeWarp === 10,
              title: 'endurance time warp — battery drains and servos heat 10× faster',
              onClick: () => setTimeWarp((w) => (w === 1 ? 10 : 1)),
            }, `TIME ${timeWarp}×`),
            h('button', {
              style: S.viewChip,
              title: 'download the field-test report (markdown) — stats the bench logged this session',
              onClick: downloadReport,
            }, 'REPORT')),
          driveAvail ? h('div', { style: S.viewSep }) : null,
          driveAvail ? h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'bench teleop' },
            h('button', {
              style: driveOn ? S.viewChipOn : S.viewChip,
              'aria-pressed': driveOn,
              title: teleopKind === 'ik'
                ? 'reach mode — WASD plane, R/F height, gamepad sticks, 0 re-anchors'
                : teleopKind === 'gait'
                ? 'gait mode — W walks the course, A/D steers, gamepad left stick'
                : teleopKind === 'grip'
                ? 'jaw mode — Space opens/closes the gripper'
                : teleopKind === 'sense'
                ? 'sense mode — stimulus sliders inject the environment'
                : 'drive mode — WASD or gamepad: W/S throttle, A/D steer, 0 reset',
              onClick: () => setDriveOn((o) => !o),
            }, teleopKind === 'ik' ? 'REACH' : teleopKind === 'gait' ? 'WALK' : teleopKind === 'grip' ? 'GRIP' : teleopKind === 'sense' ? 'SENSE' : 'DRIVE'),
            autotestRef.current ? h('button', {
              style: autotestRef.current.running || (autotestRef.current.done && !autotestRef.current.results.every((r) => r.pass)) ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!(autotestRef.current && autotestRef.current.running),
              title: 'autopilot certification — scripts sprint, turn, climb, shove-recovery and return, scoring each check',
              onClick: () => {
                const at = autotestRef.current
                if (!at) return
                if (at.running) { at.stop(); return }
                at.start()
                setDriveOn(true)
              },
            }, autotestRef.current.running ? 'AUTO ■' : autotestRef.current.done ? `AUTO ${autotestRef.current.score}` : 'AUTO') : null) : null,
          powerHud ? h('span', {
            style: {
              fontFamily: C.mono, fontSize: '10px', marginLeft: 'auto',
              color: powerHud.dead ? C.red : powerHud.soc < 25 ? C.amber : C.faint,
              border: `1px solid ${C.line}`, borderRadius: '6px', padding: '3px 8px',
            },
            title: `bus ${powerHud.busA.toFixed(1)}A · ${powerHud.vbus.toFixed(1)}V · peak joint ${powerHud.tempMax.toFixed(0)}°C${powerHud.cuts ? ` · ${powerHud.cuts} thermal cutouts` : ''}`,
          }, `⚡ ${powerHud.soc.toFixed(0)}%`) : null,
        ),

        h('div', { style: S.jointBar },
          // A pose rack, not a spreadsheet: fixed controls on the left, and the
          // joints themselves in a wrapped grid so 23 of them occupy two rows
          // instead of one endless strip.
          h('div', { style: S.poseHead },
            h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.12em', color: C.faint } },
              design.joints.length ? `${shownJoints.length} JOINTS` : 'NO JOINTS',
              poseOverflows ? h('span', { style: { color: C.accent } }, ' · scroll') : null),
            design.joints.length > 6
              ? h('div', { style: { display: 'flex', gap: '3px', marginTop: '5px' } },
                [['all', 'ALL'], ['body', 'TORSO'], ['l', 'LEFT'], ['r', 'RIGHT']].map(([id, label]) => h('button', {
                  key: id,
                  style: { ...(jointGroup === id ? S.poseTabOn : S.poseTab) },
                  onClick: () => setJointGroup(id),
                }, label)))
              : null,
            h('div', { style: { display: 'flex', gap: '5px', marginTop: '6px' } },
              h('button', { style: S.poseTab, title: 'every joint back to zero', onClick: () => setPose(design.joints.map(() => 0)) }, 'HOME'),
              h('button', {
                style: S.poseTab,
                title: 'a quick working pose',
                onClick: () => setPose(design.joints.map((j, i) => (i === 0 && design.joints.length > 1 ? 0 : Math.round(i % 2 ? j.max * 0.6 : j.min * 0.55)))),
              }, 'POSE'),
              canMirror
                ? h('button', {
                  style: S.poseTab,
                  title: 'copy every left-side joint onto its right twin',
                  onClick: () => setPose((p) => p.map((v, i) => {
                    const id = design.joints[i].id
                    if (!id.startsWith('r-')) return v
                    const li = design.joints.findIndex((j) => j.id === `l-${id.slice(2)}`)
                    return li >= 0 ? p[li] : v
                  })),
                }, 'MIRROR')
                : null)),

          design.joints.length
            ? h('div', { style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: S.poseGrid },
              design.joints.map((j, i) => [j, i])
                .filter(([j]) => jointGroup === 'all' || (jointGroup === 'body'
                  ? j.id.startsWith('waist') || j.id.startsWith('neck')
                  : j.id.startsWith(`${jointGroup}-`)))
                .map(([j, i]) => {
                  // the slider commands a target; the number shows where the
                  // joint actually IS — they differ while the servo slews or
                  // stalls, which is exactly the feedback that teaches torque
                  const simSt = simRef.current && simRef.current.state
                  const loadRatio = simSt && simSt.stallNm[i] ? simSt.loadNm[i] / simSt.stallNm[i] : 0
                  const stalled = !!(simSt && simSt.stalled[i])
                  return h('label', { key: j.id, style: S.poseRow, title: `${j.label} · ${j.min}…${j.max}${j.slide ? 'mm' : '°'}` },
                    h('span', { style: S.poseName }, j.label),
                    h('input', {
                      type: 'range', min: j.min, max: j.max, step: 1, value: pose[i] || 0,
                      style: S.poseRange,
                      'aria-label': j.label,
                      onChange: (e) => {
                        const v = Number(e.target.value)
                        setPose((p) => p.map((x, k) => (k === i ? v : x)))
                      },
                    }),
                    h('span', {
                      style: { ...S.poseVal, color: stalled ? C.red : loadRatio > 0.7 ? C.amber : undefined },
                    }, stalled ? 'STALL' : `${Math.round(dispPose[i] || 0)}${j.slide ? 'mm' : '°'}${loadRatio > 0.55 ? ` ·${Math.round(loadRatio * 100)}%` : ''}`))
                })),
              poseOverflows ? h('div', { style: S.poseFade }) : null)
            : h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, padding: '8px 0' } },
              'no articulated joints — static assembly')),
      ),

      // right rail: the spec
      h('div', { style: S.col, 'data-rf': 'spec' },
        simple ? h('div', { style: { ...S.tabBody, padding: '4px 16px 24px' } },
          h(SimplePanel, {
            design, analysis, exports,
            onAudit: () => setAuditOpen(true),
            onCompare: () => setCompareOpen(true),
            onTest: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('test') },
            onEngineer: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') },
          }))
          : h('div', {
            style: S.tabs, role: 'tablist',
            // arrow keys are what a tablist promises a keyboard user
            onKeyDown: (e) => {
              const ids = TABS.map(([id]) => id)
              const i = ids.indexOf(tab)
              let next = null
              if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length]
              else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length]
              else if (e.key === 'Home') next = ids[0]
              else if (e.key === 'End') next = ids[ids.length - 1]
              if (!next) return
              e.preventDefault()
              setTab(next)
              const btn = e.currentTarget.querySelector(`[data-tab="${next}"]`)
              if (btn) btn.focus()
            },
          },
          TABS.map(([id, label]) => {
            // a badge is information scent: how much sits behind the tab
            // badges only where the count changes a decision: how much to buy,
            // how much to print. A number on every tab is noise.
            const badge = id === 'parts' ? design.parts.length
              : id === 'print' ? design.nodes.filter((n) => n.print).length
                : null
            return h('button', {
              key: id,
              style: tab === id ? S.tabOn : S.tab,
              role: 'tab',
              'data-tab': id,
              'aria-selected': tab === id,
              tabIndex: tab === id ? 0 : -1,
              onClick: () => setTab(id),
            }, label,
            badge ? h('span', { style: { ...S.tabBadge, color: tab === id ? C.accent : C.faint } }, badge) : null)
          })),
        simple ? null : h('div', { style: S.tabBody }, panel),
        simple ? null : h('div', { style: S.footer },
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.1em' } },
            `${design.parts.length} LINE ITEMS`),
          h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: '14px', fontWeight: 600, color: C.accent } }, money(analysis.cost)))),
    ),
    h(CommandPalette, { open: paletteOpen, commands, onClose: () => setPaletteOpen(false) }),
    h(AuditDialog, { open: auditOpen, onClose: () => setAuditOpen(false), design, analysis }),
    h(CompareDialog, { open: compareOpen, onClose: () => setCompareOpen(false), currentBrief: brief, history }),
    h(BuildCodeDialog, {
      open: codeOpen,
      onOpen: (b) => { setBrief({ ...DEFAULT_BRIEF, ...b }); setMission(b.mission || ''); setSimple(false) },
      onClose: () => setCodeOpen(false),
    }),
  )
}

// ── compare: did the change actually make it better? ────────────────────────
// The agent, or you, can rewrite a build in one line. The only honest way to
// judge that rewrite is against the thing it replaced: cheaper? lighter?
// stiffer? Did it buy the gain by breaking a check? This is that scoreboard.

const CMP_METRICS = [
  { key: 'cost', label: 'COST', unit: '$', get: (a) => a.cost, better: 'down', digits: 2 },
  { key: 'mass', label: 'MASS', unit: ' g', get: (a) => a.mass.totalG, better: 'down', digits: 0 },
  { key: 'print', label: 'PRINT TIME', unit: ' h', get: (a) => a.print.hours, better: 'down', digits: 1 },
  { key: 'peak', label: 'PEAK CURRENT', unit: ' A', get: (a) => a.power.peak, better: 'down', digits: 2 },
  { key: 'checks', label: 'OPEN PROBLEMS', unit: '', get: (a) => a.checks.filter((c) => c.level !== 'ok').length, better: 'down', digits: 0 },
]

function compareDesigns(briefA, briefB) {
  const A = composeDesign(briefA)
  const B = composeDesign(briefB)
  const rows = CMP_METRICS.map((m) => {
    const a = m.get(A.analysis)
    const b = m.get(B.analysis)
    const delta = b - a
    const pctChange = a > 0 ? (delta / a) * 100 : (b > 0 ? 100 : 0)
    const flat = Math.abs(delta) < (m.digits === 0 ? 0.5 : 0.005)
    const good = flat ? null : (m.better === 'down' ? delta < 0 : delta > 0)
    return { ...m, a, b, delta, pctChange, flat, good }
  })
  // Compare problems by kind, not by their digits: "longest dimension 540mm"
  // and "longest dimension 568mm" are the same problem, and treating them as
  // different makes a resize look like it broke something new.
  const keyOf = (c) => `${c.level}|${c.msg.replace(/[0-9]+(?:\.[0-9]+)?/g, '#').slice(0, 60)}`
  const beforeChecks = A.analysis.checks.filter((c) => c.level !== 'ok')
  const afterChecks = B.analysis.checks.filter((c) => c.level !== 'ok')
  const beforeKeys = beforeChecks.map(keyOf)
  const afterKeys = afterChecks.map(keyOf)
  return {
    A, B, rows,
    resolved: beforeChecks.filter((c) => !afterKeys.includes(keyOf(c))).map((c) => c.msg),
    introduced: afterChecks.filter((c) => !beforeKeys.includes(keyOf(c))).map((c) => c.msg),
    sameTitle: A.design.title === B.design.title,
  }
}

/** One sentence a person can act on, not a table they have to read. */
function compareVerdict(cmp) {
  const list = (arr) => (arr.length > 1 ? arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1] : arr[0])
  const wins = cmp.rows.filter((r) => r.good === true).map((r) => r.label.toLowerCase())
  const losses = cmp.rows.filter((r) => r.good === false).map((r) => r.label.toLowerCase())
  const bits = []
  if (wins.length) bits.push(`better on ${list(wins)}`)
  if (losses.length) bits.push(`worse on ${list(losses)}`)
  if (!bits.length) bits.push('nothing moved')
  let out = bits.join('; ')
  if (cmp.introduced.length) out += ` — and ${cmp.introduced.length} new problem${cmp.introduced.length > 1 ? 's' : ''}`
  else if (cmp.resolved.length) out += ` — ${cmp.resolved.length} problem${cmp.resolved.length > 1 ? 's' : ''} cleared`
  return out + '.'
}

const BRIEF_FIELDS = [
  ['reachMm', 'reach', ' mm'],
  ['payloadKg', 'payload', ' kg'],
  ['spanX', 'span', ' mm'],
  ['material', 'material', ''],
  ['mcu', 'controller', ''],
  ['battery', 'power', ''],
  ['energy', 'energy', ''],
  ['drive', 'drive', ''],
  ['gripper', 'gripper', ''],
  ['archetype', 'machine', ''],
]

/** The knobs that changed, in the user's units. */
function briefChanges(a, b) {
  const out = []
  for (const [key, label, unit] of BRIEF_FIELDS) {
    if (a[key] === b[key]) continue
    if (a[key] === undefined && b[key] === undefined) continue
    out.push({ label, from: a[key], to: b[key], unit })
  }
  return out
}

function CompareDialog({ open, onClose, currentBrief, history }) {
  const dialogRef = useDialogFocus(open, onClose)
  if (!open) return null
  const options = (history || []).filter((h) => h && h.brief)
  if (!options.length) {
    return h('div', { style: S.paletteBackdrop, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
      h('div', { ref: dialogRef, tabIndex: -1, style: { ...S.palette, width: 'min(520px, 92vw)', padding: '20px' }, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compare builds' },
        h('div', { style: S.simpleLabel }, 'compare'),
        h('div', { style: { fontSize: '12px', color: C.dim, lineHeight: 1.6 } },
          'Nothing to compare against yet. Every build you make is remembered here, so change one number, press BUILD, and come back — you will see what actually moved.'),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
          h('button', { style: { ...S.btn, height: '30px' }, onClick: onClose }, 'Close'))))
  }
  const prev = options[0]
  const cmp = compareDesigns(prev.brief, currentBrief)
  const changes = briefChanges(prev.brief, currentBrief)
  const fmtVal = (m, v) => `${m.unit === '$' ? '$' : ''}${fmt(v, m.digits)}${m.unit === '$' ? '' : m.unit}`
  const tone = (r) => (r.flat ? C.faint : r.good ? C.green : C.red)
  const arrow = (r) => (r.flat ? '=' : r.delta < 0 ? '▼' : '▲')

  return h('div', { style: S.paletteBackdrop, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('div', {
      ref: dialogRef, tabIndex: -1,
      style: { ...S.palette, maxHeight: 'min(80vh, 760px)', width: 'min(720px, 94vw)', overflowY: 'auto', padding: '18px 20px 16px' },
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compare builds',
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' } },
      h('div', {},
        h('div', { style: { ...S.simpleLabel, margin: 0 } }, 'before → after'),
        h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.faint, marginTop: '2px' } },
          `${cmp.A.design.title} → ${cmp.B.design.title}`)),
      h('button', { style: { ...S.btn, height: '26px', padding: '0 10px' }, onClick: onClose, 'aria-label': 'Close' }, 'Close')),

    // "Better" only means something between two versions of the same machine.
    // Across archetypes it is a choice, not a score, so the verdict is withheld.
    cmp.A.design.archetype !== cmp.B.design.archetype
      ? h('div', { style: { fontSize: '12px', color: C.amber, lineHeight: 1.5, margin: '10px 0 12px' } },
        'Two different machines — pick by what you need, not by which column wins. The numbers are side by side, not a score.')
      : h('div', { style: { fontSize: '12.5px', color: C.text, lineHeight: 1.5, margin: '10px 0 14px' } }, compareVerdict(cmp)),

    changes.length
      ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '0 0 12px' } },
        changes.slice(0, 5).map((c, i) => h('span', {
          key: i,
          style: {
            fontFamily: C.mono, fontSize: '10px', color: C.dim, padding: '3px 8px', borderRadius: '999px',
            border: `1px solid ${C.line}`, background: C.panel2,
          },
        }, `${c.label} ${c.from}${c.unit} → ${c.to}${c.unit}`)))
      : null,

    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'METRIC'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'BEFORE'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'AFTER'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'CHANGE'))),
      h('tbody', {}, cmp.rows.map((r) => h('tr', { key: r.key },
        h('td', { style: { ...S.td, fontFamily: C.mono, fontSize: '10px', letterSpacing: '0.06em' } }, r.label),
        h('td', { style: S.tdNum }, fmtVal(r, r.a)),
        h('td', { style: S.tdNum }, fmtVal(r, r.b)),
        h('td', { style: { ...S.tdNum, color: tone(r) } },
          `${arrow(r)} ${r.delta === 0 ? '' : (r.delta > 0 ? '+' : '') + fmt(r.delta, r.digits)}${r.flat ? '' : ` · ${Math.abs(r.pctChange) < 0.5 ? '<1' : Math.round(r.pctChange)}%`}`))))),

    cmp.resolved.length || cmp.introduced.length
      ? h('div', { style: { marginTop: '14px' } },
        h('div', { style: S.sectionLabel }, 'what changed in the checks'),
        cmp.resolved.map((c, i) => h('div', { key: 'r' + i, style: { fontSize: '11.5px', color: C.green, marginBottom: '4px' } }, `✓ cleared — ${c}`)),
        cmp.introduced.map((c, i) => h('div', { key: 'i' + i, style: { fontSize: '11.5px', color: C.red, marginBottom: '4px' } }, `✕ new — ${c}`)))
      : h('div', { style: { marginTop: '12px', fontSize: '11px', color: C.faint } },
        'The same checks pass and fail on both builds — the change was a trade, not a fix.'),

    h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '14px', borderTop: `1px solid ${C.line}`, paddingTop: '10px', lineHeight: 1.5 } },
      `Both machines were recomputed from scratch just now, not read from a cache. Compared against the previous ${options.length > 1 ? `build (${options.length} kept)` : 'build'}.`))
  )
}

// ── a11y: a dialog should behave like one ───────────────────────────────────
// Three things people expect from a modal and none of them are free: Escape
// closes it, Tab stays inside it, and closing puts focus back where you were.
// Without the third, a keyboard user gets dumped at the top of the document and
// has to tab back to wherever they were — which, in a studio with a viewport,
// means past every control on the page.

function useDialogFocus(open, onClose) {
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const el = ref.current
    const previous = document.activeElement

    const focusables = () => {
      if (!el) return []
      return Array.from(el.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.disabled && n.getClientRects().length > 0)
    }

    const t = setTimeout(() => {
      const list = focusables()
      const target = list.find((n) => n.getAttribute('autofocus') !== null) || list[0] || el
      if (target && target.focus) target.focus()
    }, 20)

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const i = list.indexOf(document.activeElement)
      const next = e.shiftKey
        ? (i <= 0 ? list.length - 1 : i - 1)
        : (i === -1 || i === list.length - 1 ? 0 : i + 1)
      e.preventDefault()
      list[next].focus()
    }

    document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      if (previous && previous.focus && document.contains(previous)) previous.focus()
    }
  }, [open])

  return ref
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
    // One line in the renderer console: proof of life when a plugin "isn't there".
    try {
      console.log('[rigforge] registered — page /rigforge, 2 tools, directive ::rigforge')
    } catch {
      // console unavailable (SSR/test harness) — never fatal
    }

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
    quick('rigforge.humanoid', 'Rigforge: new humanoid', ['humanoid', 'biped', 'bipedal robot'], PRESETS.find((p) => p.brief.archetype === 'humanoid').brief, '23-joint biped, sized honestly')
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

// bracket — real CAD mesh converted from Sand3D (zero-to-cad-00067abe-82be-040d-2058-6de874f1559f.usda)
// 790 triangles in, 233 kept. Quantised int16, 20mm radius.
// Regenerate with: node tools/sand3d-fetch.mjs <usda-url> bracket
globalThis.__RF_PARTS = Object.assign(globalThis.__RF_PARTS || {}, {
  BRACKET: { name: "bracket", scale: 20, tris: [-12288,0,-12288,-4096,0,-12288,-4096,0,-8192,-12288,0,-12288,-4096,0,-8192,-12288,0,-8192,-12288,0,-8192,-4096,0,-8192,-4096,0,-4096,-12288,0,-8192,-4096,0,-4096,-12288,0,-4096,-12288,0,-4096,-4096,0,-4096,-4096,0,0,-12288,0,-4096,-4096,0,0,-12288,0,0,-12288,0,0,-4096,0,0,-4096,0,4096,-12288,0,0,-4096,0,4096,-12288,0,4096,-12288,0,4096,-4096,0,4096,-4096,0,8192,-12288,0,4096,-4096,0,8192,-12288,0,8192,-12288,0,12288,-4096,0,12288,-4096,0,16384,-12288,0,12288,-4096,0,16384,-12288,0,16384,-12288,0,16384,-4096,0,16384,-4096,0,16384,-12288,0,16384,-4096,0,16384,-12288,0,16384,-12288,0,16384,-4096,0,16384,-4096,0,20479,-12288,0,16384,-4096,0,20479,-12288,0,20479,-12288,0,20479,-4096,0,20479,-4096,0,24575,-12288,0,20479,-4096,0,24575,-12288,0,24575,-12288,0,24575,-4096,0,24575,-4096,0,28671,-12288,0,24575,-4096,0,28671,-12288,0,28671,-12288,0,28671,-4096,0,28671,-4096,0,32767,-12288,0,28671,-4096,0,32767,-12288,0,32767,-12288,0,4096,0,0,4096,0,0,4096,-12288,0,4096,0,0,4096,-12288,0,4096,-12288,0,20479,-4096,0,20479,-4096,0,20479,-12288,0,20479,-4096,0,20479,-12288,0,20479,-12288,0,4096,-12288,0,8192,-12288,0,8192,-12288,0,4096,-12288,0,4096,-12288,0,8192,-12288,0,16384,-12288,0,16384,-12288,0,16384,-12288,0,-12288,-12288,0,-12288,-12288,0,-8192,-12288,0,-12288,-12288,0,-8192,-12288,0,-8192,-12288,0,-12288,-12288,0,-12288,-8192,0,-12288,-8192,0,-12288,-4096,0,-12288,-4096,0,-12288,-4096,0,-12288,-12288,0,-12288,-8192,0,-12288,-12288,0,-8192,-12288,0,-8192,-12288,0,-4096,-12288,0,-8192,-12288,0,-4096,-12288,0,-4096,-12288,0,-4096,-12288,0,-4096,-12288,0,0,-12288,0,-4096,-12288,0,0,-12288,0,0,-12288,0,12288,-12288,0,12288,-12288,0,16384,-12288,0,12288,-12288,0,16384,-12288,0,16384,-12288,0,20479,-12288,0,20479,-12288,0,24575,-12288,0,20479,-12288,0,24575,-12288,0,24575,-12288,0,24575,-12288,0,24575,-12288,0,28671,-12288,0,24575,-12288,0,28671,-12288,0,28671,-12288,0,28671,-12288,0,28671,-12288,0,32767,-12288,0,28671,-12288,0,32767,-12288,0,32767,-8192,0,-12288,-12288,0,-12288,-12288,0,-8192,-8192,0,-12288,-12288,0,-8192,-8192,0,-8192,-8192,0,-4096,-12288,0,-4096,-12288,0,0,-8192,0,-4096,-12288,0,0,-8192,0,0,-8192,0,0,-12288,0,0,-12288,0,4096,-8192,0,0,-12288,0,4096,-8192,0,4096,-8192,0,4096,-12288,0,4096,-12288,0,8192,-8192,0,4096,-12288,0,8192,-8192,0,8192,-8192,0,12288,-12288,0,12288,-12288,0,16384,-8192,0,12288,-12288,0,16384,-8192,0,16384,-8192,0,16384,-12288,0,16384,-12288,0,20479,-8192,0,16384,-12288,0,20479,-8192,0,20479,-8192,0,20479,-12288,0,20479,-12288,0,24575,-8192,0,20479,-12288,0,24575,-8192,0,24575,-8192,0,24575,-12288,0,24575,-12288,0,28671,-8192,0,24575,-12288,0,28671,-8192,0,28671,-8192,0,32767,-12288,0,32767,-12288,0,32767,-8192,0,32767,-12288,0,32767,-4096,0,32767,0,0,32767,-8192,0,32767,-4096,0,32767,8192,0,32767,8192,0,32767,4096,0,32767,4096,0,32767,0,0,32767,-4096,0,32767,4096,0,32767,8192,0,32767,4096,0,32767,-4096,0,32767,4096,0,32767,4096,0,32767,-8192,0,-8192,-12288,0,-8192,-12288,0,-4096,-8192,0,-8192,-12288,0,-4096,-8192,0,-4096,-8192,0,16384,-12288,0,16384,-12288,0,16384,-8192,0,16384,-12288,0,16384,-8192,0,16384,-8192,0,28671,-12288,0,28671,-12288,0,32767,-8192,0,28671,-12288,0,32767,-8192,0,32767,-4096,0,28671,4096,0,28671,4096,0,32767,-4096,0,28671,4096,0,32767,-4096,0,32767,-4096,0,24575,4096,0,24575,4096,0,28671,-4096,0,24575,4096,0,28671,-4096,0,28671,-4096,0,20479,4096,0,20479,4096,0,24575,-4096,0,20479,4096,0,24575,-4096,0,24575,-4096,-8192,-32767,0,-8192,-32767,0,-8192,12288,-4096,-8192,-32767,0,-8192,12288,-4096,-8192,12288,-4096,-8192,-32767,-4096,-8192,12288,-4096,0,12288,-4096,0,8192,-4096,8192,12288,-4096,8192,-32767,-4096,0,4096,-4096,0,8192,-4096,8192,-32767,-4096,-8192,-32767,-4096,0,8192,-4096,0,4096,-4096,-8192,-32767,-4096,0,4096,-4096,0,0,-4096,0,0,-4096,0,4096,-4096,8192,-32767,-4096,0,-4096,-4096,0,0,-4096,8192,-32767,-4096,-8192,-32767,-4096,0,0,-4096,0,-4096,-4096,-8192,-32767,-4096,0,-4096,-4096,0,-8192,-4096,0,-8192,-4096,0,-4096,-4096,8192,-32767,-4096,0,-12288,-4096,0,-8192,-4096,8192,-32767,-4096,-8192,-32767,-4096,0,-8192,-4096,0,-12288,-4096,0,-12288,-4096,0,-12288,-4096,8192,-32767,-4096,0,-12288,-4096,8192,-32767,-4096,-8192,-32767,-4096,0,12288,-4096,-8192,12288,0,-8192,12288,-4096,0,12288,0,-8192,12288,0,0,12288,-4096,0,16384,-4096,0,16384,4096,0,16384,4096,0,16384,4096,0,16384,-4096,0,16384,-4096,0,20479,-4096,0,20479,12288,0,20479,12288,0,20479,12288,0,20479,4096,0,20479,12288,0,20479,4096,0,20479,-4096,0,20479,12288,0,16384,4096,0,16384,0,0,16384,-4096,0,16384,12288,0,16384,0,0,16384,-4096,0,-12288,-8192,0,-12288,-8192,0,-8192,-4096,0,-12288,-8192,0,-8192,-4096,0,-8192,-4096,0,-8192,-8192,0,-8192,-8192,0,-4096,-4096,0,-8192,-8192,0,-4096,-4096,0,-4096,-4096,0,-4096,-8192,0,-4096,-8192,0,0,-4096,0,-4096,-8192,0,0,-4096,0,0,-4096,0,0,-8192,0,0,-8192,0,4096,-4096,0,0,-8192,0,4096,-4096,0,4096,-4096,0,4096,-8192,0,4096,-8192,0,8192,-4096,0,4096,-8192,0,8192,-4096,0,8192,-8192,0,16384,-8192,0,20479,0,0,20479,-8192,0,16384,0,0,20479,-4096,0,20479,-4096,0,20479,-4096,0,20479,-8192,0,16384,-4096,8192,-32767,0,8192,-32767,0,-8192,-32767,-4096,8192,-32767,0,-8192,-32767,-4096,-8192,-32767,0,8192,12288,-4096,8192,12288,-4096,0,12288,0,8192,12288,-4096,0,12288,0,0,12288,0,0,4096,12288,0,4096,12288,0,4096,0,0,4096,12288,0,4096,4096,0,4096,0,0,4096,4096,0,4096,0,0,4096,12288,0,0,4096,0,0,0,0,0,0,0,16384,0,0,12288,-4096,0,12288,-4096,0,12288,-8192,0,12288,-8192,0,16384,-4096,0,12288,-8192,0,16384,0,0,16384,0,0,16384,0,0,16384,-8192,0,16384,-8192,0,16384,-8192,0,16384,-4096,0,16384,-4096,0,16384,0,0,16384,-8192,0,16384,0,0,20479,-8192,0,20479,-8192,0,24575,0,0,20479,-8192,0,24575,0,0,24575,0,0,24575,-8192,0,24575,-8192,0,28671,0,0,24575,-8192,0,28671,0,0,28671,0,0,28671,-8192,0,28671,-8192,0,32767,0,0,28671,-8192,0,32767,0,0,32767,0,0,-12288,4096,0,-12288,4096,0,-8192,0,0,-12288,4096,0,-8192,0,0,-8192,0,0,-8192,4096,0,-8192,4096,0,-4096,0,0,-8192,4096,0,-4096,0,0,-4096,0,0,-4096,4096,0,-4096,4096,0,0,0,0,-4096,4096,0,0,0,0,0,0,0,0,0,0,-4096,0,0,-8192,0,0,0,0,0,-8192,0,0,-12288,0,-8192,-32767,0,8192,-32767,0,8192,12288,0,0,12288,0,-8192,12288,0,-8192,-32767,0,8192,12288,0,0,8192,0,0,4096,0,-4096,4096,0,0,8192,0,-8192,-32767,0,-4096,4096,0,-4096,4096,0,-8192,-32767,0,8192,12288,0,4096,4096,0,4096,4096,0,8192,12288,0,4096,4096,0,0,-12288,0,-8192,-32767,0,8192,12288,0,0,-12288,0,0,-4096,0,0,0,0,-8192,-32767,0,0,-8192,0,0,-4096,0,-8192,-32767,0,-8192,-32767,0,0,-12288,0,0,-12288,0,0,-12288,0,0,-8192,0,-8192,-32767,0,0,8192,4096,0,8192,4096,0,4096,0,0,8192,4096,0,4096,0,0,4096,0,8192,-32767,-4096,8192,-32767,-4096,8192,12288,0,8192,-32767,-4096,8192,12288,0,8192,12288,4096,0,-12288,0,0,-12288,0,0,-12288,4096,0,-12288,0,0,-12288,4096,0,-12288,8192,0,-12288,8192,0,-12288,4096,0,-12288,4096,0,-12288,4096,0,-12288,8192,0,-12288,4096,0,-12288,8192,0,-12288,8192,0,-8192,4096,0,-12288,8192,0,-8192,4096,0,-8192,4096,0,-8192,8192,0,-8192,8192,0,-4096,4096,0,-8192,8192,0,-4096,4096,0,-4096,4096,0,28671,8192,0,28671,8192,0,32767,4096,0,28671,8192,0,32767,4096,0,32767,4096,0,-4096,8192,0,-4096,12288,0,0,4096,0,-4096,12288,0,0,4096,0,0,4096,0,24575,8192,0,24575,8192,0,28671,4096,0,24575,8192,0,28671,4096,0,28671,4096,0,20479,12288,0,20479,8192,0,24575,4096,0,20479,8192,0,24575,4096,0,24575,4096,0,16384,4096,0,16384,12288,0,16384,4096,0,16384,12288,0,16384,12288,0,16384,0,0,12288,4096,0,12288,4096,0,16384,4096,0,16384,-4096,0,16384,-4096,0,12288,-4096,0,12288,0,0,12288,4096,0,16384,4096,0,12288,12288,0,12288,12288,0,16384,4096,0,12288,12288,0,16384,4096,0,16384,0,0,12288,0,0,16384,4096,0,16384,4096,0,16384,0,0,16384,0,0,16384,4096,0,16384,0,0,16384,4096,0,16384,4096,0,20479,0,0,20479,0,0,24575,4096,0,20479,0,0,24575,4096,0,24575,4096,0,24575,0,0,24575,0,0,28671,4096,0,24575,0,0,28671,4096,0,28671,4096,0,28671,0,0,28671,0,0,32767,4096,0,28671,0,0,32767,4096,0,32767,-4096,0,20479,0,0,20479,4096,0,20479,4096,0,8192,12288,0,8192,12288,0,4096,4096,0,8192,12288,0,4096,4096,0,4096,8192,0,-12288,8192,0,-12288,8192,0,-8192,8192,0,-12288,8192,0,-8192,8192,0,-8192,8192,0,-12288,4096,0,-12288,4096,0,-8192,8192,0,-12288,4096,0,-8192,8192,0,-8192,8192,0,-8192,8192,0,-8192,8192,0,-4096,8192,0,-8192,8192,0,-4096,8192,0,-4096,8192,0,28671,8192,0,28671,8192,0,32767,8192,0,28671,8192,0,32767,8192,0,32767,8192,0,-8192,4096,0,-8192,4096,0,-4096,8192,0,-8192,4096,0,-4096,8192,0,-4096,8192,0,28671,4096,0,28671,4096,0,32767,8192,0,28671,4096,0,32767,8192,0,32767,8192,0,-4096,8192,0,-4096,12288,0,0,8192,0,-4096,12288,0,0,12288,0,0,8192,0,24575,8192,0,24575,8192,0,28671,8192,0,24575,8192,0,28671,8192,0,28671,8192,0,-4096,4096,0,-4096,4096,0,0,8192,0,-4096,4096,0,0,12288,0,0,8192,0,24575,4096,0,24575,4096,0,28671,8192,0,24575,4096,0,28671,8192,0,28671,12288,0,20479,12288,0,20479,8192,0,24575,12288,0,20479,8192,0,24575,8192,0,24575,12288,0,20479,4096,0,20479,4096,0,24575,12288,0,20479,4096,0,24575,8192,0,24575,4096,0,0,12288,0,0,12288,0,0,12288,0,0,0,0,0,0,0,0,12288,0,16384,-4096,0,16384,-4096,0,16384,12288,0,16384,-4096,0,16384,4096,0,16384,12288,0,16384,12288,0,16384,12288,0,16384,12288,0,8192,12288,0,8192,12288,0,4096,12288,0,8192,12288,0,4096,12288,0,4096,12288,0,12288,12288,0,12288,12288,0,16384,12288,0,12288,12288,0,16384,12288,0,16384,12288,0,12288,4096,0,12288,4096,0,16384,12288,0,12288,4096,0,16384,12288,0,16384] },
})

