// Every preset must leave as every format. The export sweep proved one machine
// could export; the preset list is the width of the product, so a drone that
// cannot emit a URDF or a board that emits an empty STL is a hole nobody sees.
import { loadEngine } from './lib-engine.mjs'

const A = loadEngine()
// toSTL/toGLB return ArrayBuffers, not typed arrays or strings: .length is
// undefined on them and a check written against .length silently reads 0.
const bytes = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)
const HEAD = {
  stl: (buf) => {
    const b = bytes(buf)
    return b.byteLength > 84 && (b.byteLength - 84) % 50 === 0
  },
  glb: (buf) => Buffer.from(bytes(buf).slice(0, 4)).toString('ascii') === 'glTF',
  step: (s) => s.startsWith('ISO-10303-21'),
  urdf: (s) => s.includes('<robot') && s.includes('</robot>'),
  mjcf: (s) => s.includes('<mujoco') && s.includes('</mujoco>'),
  scad: (s) => s.includes('module ') && s.length > 300,
}

// Negative controls first: a header check that passes a corrupt buffer is not a
// check, it is decoration. Each validator must reject garbage before it is
// trusted to pass a real file.
const CONTROLS = [
  ['stl', () => HEAD.stl(new ArrayBuffer(100)), false],
  ['stl', () => HEAD.stl(new ArrayBuffer(0)), false],
  ['glb', () => HEAD.glb(Buffer.from('GLBX')), false],
  ['step', () => HEAD.step('<xml>'), false],
  ['urdf', () => HEAD.urdf('<robot name="x">'), false],
  ['mjcf', () => HEAD.mjcf('<mujoco>'), false],
  ['scad', () => HEAD.scad('module'), false],
  ['stl', () => HEAD.stl(Buffer.alloc(84 + 50)), true],
  ['glb', () => HEAD.glb(Buffer.from('glTFxxxx')), true],
  ['step', () => HEAD.step('ISO-10303-21;'), true],
]
let controlsFailed = 0
for (const [name, fn, want] of CONTROLS) {
  let got
  try { got = fn() } catch (e) { got = 'THREW' }
  if (got !== want) { controlsFailed += 1; console.log(`  CONTROL FAIL ${name}: expected ${want}, got ${got}`) }
}
console.log(`  negative controls: ${CONTROLS.length - controlsFailed}/${CONTROLS.length} behave`)

let failures = 0
const lines = []
for (const preset of A.PRESETS) {
  const { design } = A.composeDesign({ ...preset.brief })
  const tris = A.buildMesh(design)
  const got = {}
  const check = (k, fn) => {
    try { const v = fn(); got[k] = HEAD[k](v) } catch (e) { got[k] = 'ERR:' + String(e.message).slice(0, 28) }
  }
  check('stl', () => A.toSTL(tris))
  check('glb', () => A.toGLB(tris))
  check('step', () => A.toSTEP(design))
  check('urdf', () => A.toURDF(design))
  check('mjcf', () => A.toMJCF(design))
  check('scad', () => A.toOpenSCAD(design))
  const bad = Object.entries(got).filter(([, v]) => v !== true)
  if (bad.length) failures += 1
  lines.push(`${preset.id.padEnd(9)} ${bad.length ? 'FAIL ' + bad.map(([k, v]) => `${k}:${v}`).join(' ') : 'stl glb step urdf mjcf scad'}`)
}
lines.forEach((l) => console.log(' ', l))
console.log(`\n${A.PRESETS.length - failures}/${A.PRESETS.length} presets export every format`)
if (failures || controlsFailed) process.exitCode = 1
