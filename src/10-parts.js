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
    dims: [16, 10, 8], // JST-XH 4-pin housing + pin header footprint
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
  extlead_300: {
    name: 'Servo extension lead 300mm (JR)', cat: 'mech', price: 2, mass: 12, volts: 0,
    conn: 'JR 3-pin extension', sku: 'servo extension cable 300mm JR', src: 'ali',
    note: 'For joints whose stock lead cannot reach the driver — the harness check flags them.',
  },
  xt60: {
    name: 'XT60 connector pair', cat: 'mech', price: 3, mass: 8, volts: 0,
    dims: [20, 15, 12], conn: '15A continuous, 30A burst', sku: 'XT60H connector male female pair', src: 'amzn',
    note: 'The pack interface. Solder the battery side first, one lead at a time.',
  },
  xt30: {
    name: 'XT30 connector pair', cat: 'mech', price: 2.5, mass: 5, volts: 0,
    conn: '15A continuous', sku: 'XT30 connector pair', src: 'amzn',
    note: 'Half the size of an XT60 — the right plug for 2S/3A-class machines.',
  },
  fuse: {
    name: 'Inline fuse holder + blade fuse', cat: 'mech', price: 3, mass: 10, volts: 0,
    dims: [32, 12, 18], conn: '18AWG inline, ATO blade', sku: 'inline ATO fuse holder 18AWG', src: 'hw',
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
