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
