// SSR-render the real plugin through the real React runtime.
// This is the test the vm harness cannot do: it executes every component,
// every hook and every default prop exactly as the app would.
//
//   node tests/render-ssr.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../src')
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()

const stub = `
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
export const calls = []
export const host = {
  notify: (n) => calls.push(['notify', n]),
  navigate: (p) => calls.push(['navigate', p]),
  request: async () => ({}),
  composer: {
    setDraft: async (sid, text) => { calls.push(['setDraft', text]); return true },
    focus: () => calls.push(['focus']),
  },
  rest: async (path) => (String(path).indexOf('/queue') === 0 ? { requests: [] } : { ok: true }),
}
`
mkdirSync(join(here, 'tmp'), { recursive: true })
writeFileSync(join(here, 'tmp/sdk-stub.mjs'), stub)

let code = ''
for (const f of files) code += readFileSync(join(srcDir, f), 'utf8') + '\n\n'
code = code
  .replace(/from '@hermes\/plugin-sdk'/g, `from './sdk-stub.mjs'`)
  .replace(/^export default plugin$/m, 'export default plugin')
  .concat(`\nexport { Studio, Viewport, DirectiveCard, composeDesign, parseBrief, parseDirective, buildMesh, toSTL, toOpenSCAD, toSpecMarkdown, toBOMCsv, agentPrompt, PRESETS, DEFAULT_BRIEF, PARTS, analyze, TabSpec, TabTest, TabParts, TabPins, TabPower, TabPrint, TabAssembly, TabCode, TabSteps }\n`)
const bundlePath = join(here, 'tmp/bundle.mjs')
writeFileSync(bundlePath, code)

const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const mod = await import(pathToFileURL(bundlePath).href + `?t=${Date.now()}`)

// First run defaults to plain-words mode; the tab strip only exists in
// engineer mode, so register once with storage that says the user opted in.
mod.default.register({
  contribution: () => {},
  registerSettingsPage: () => {},
  storage: { get: (k, d) => (k === 'simple' ? false : d), set: () => {}, remove: () => {} },
})

let failures = 0
const check = (name, cond, extra) => {
  if (!cond) { failures += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
  else console.log(`  ok   ${name}`)
}

// ── 1. engine numbers ───────────────────────────────────────────────────────
console.log('\nengine')
const arm = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype: 'arm', payloadKg: 1, reachMm: 500, dof: 5 })
check('arm has joints', arm.design.joints.length === 5, `got ${arm.design.joints.length}`)
check('arm sizes servos', arm.design.actuators.length >= 4)
check('every arm joint resolves (servo or belt stage)', arm.design.actuators.every((a) =>
  a.effective >= a.need - 1e-9 || arm.analysis.checks.some((c) => c.msg.startsWith(a.label))))
check('arm cost > 0', arm.analysis.cost > 50)
check('arm has firmware', arm.design.firmware.includes('PCA9685'))
check('arm pins include I2C', arm.analysis.pins.rows.some((r) => r.signal === 'I2C SDA'))

const rover = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype: 'rover', payloadKg: 3, reachMm: 400 })
check('rover picks a motor', !!rover.design.metrics.motor)
check('rover torque checks out', mod.PARTS[rover.design.metrics.motor].torque >= rover.design.metrics.torquePerWheel)
check('rover runtime computed', rover.analysis.power.runtimeMin > 0)
check('rover firmware has drive()', rover.design.firmware.includes('void drive(float v, float w)'))

const quad = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype: 'quadruped', payloadKg: 1, reachMm: 380 })
check('quad has 12 servos', quad.design.parts.find((p) => p.key === quad.design.metrics.servo && p.qty === 12))
check('quad firmware has gait', quad.design.firmware.includes('quadGait'))

const full = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype: 'robot', payloadKg: 1, reachMm: 450, wheelMm: 130 })
check('full robot has drive + arm', full.design.parts.some((p) => p.key === 'jgb37') && full.design.actuators.length === 6)
check('full robot stability computed', typeof full.design.metrics.comOffsetMm === 'number' && full.design.metrics.supportHalfMm > 0)
check('full robot firmware arbitrates', full.design.firmware.includes('arm locked while driving'))
check('full robot pin map feeds firmware', full.design.firmware.includes(`PWM_L = ${full.analysis.pins.rows.find((r) => r.signal === 'M1 PWM').pin}`))

const gadget = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype: 'gadget', mission: 'desk clock with bme280 temperature', reachMm: 0 })
check('gadget BOM has chosen sensor', gadget.design.parts.some((p) => p.key === 'bme280'))
check('gadget has a display', gadget.design.parts.some((p) => mod.PARTS[p.key].cat === 'display'))

// ── 2. exports ──────────────────────────────────────────────────────────────
console.log('\nexports')
const tris = mod.buildMesh(rover.design)
const stl = mod.toSTL(tris)
check('stl size = 84 + 50 * tris', stl.byteLength === 84 + 50 * tris.length, `${stl.byteLength} vs ${84 + 50 * tris.length}`)
check('stl triangle count in header', new DataView(stl).getUint32(80, true) === tris.length)
check('openscad has a cube', mod.toOpenSCAD(arm.design).includes('cube('))
check('bom csv has header', mod.toBOMCsv(arm.design).startsWith('part,category,qty'))
const md = mod.toSpecMarkdown(arm.design, arm.analysis)
check('spec.md has BOM + firmware', md.includes('## Bill of materials') && md.includes('## Firmware'))

// ── 3. brief parsing ────────────────────────────────────────────────────────
console.log('\nparse')
const p = mod.parseBrief('6 dof arm, 450mm reach, 2kg payload in PETG')
check('parse dof', p.dof === 6, String(p.dof))
check('parse reach', p.reachMm === 450)
check('parse payload', p.payloadKg === 2)
check('parse material', p.material === 'petg')
check('parse archetype', mod.parseBrief('12-servo quadruped that trots').archetype === 'quadruped')

// ── 4. the page renders ─────────────────────────────────────────────────────
console.log('\nrender')
let html = ''
try {
  html = renderToStaticMarkup(React.createElement(mod.Studio))
  check('Studio rendered', html.length > 3000, `${html.length} bytes`)
  check('wordmark present', html.includes('RIGFORGE'))
  check('spec tabs present', html.includes('SPEC') && html.includes('TEST') && html.includes('STEPS'))
  check('cost rendered', /\$[0-9]/.test(html))
  check('canvas mounted', html.includes('<canvas'))
} catch (err) {
  failures += 1
  console.log('  FAIL Studio threw:', err && err.message)
  console.log(err && err.stack && err.stack.split('\n').slice(0, 6).join('\n'))
}

// every tab renders — panels are pure components, mount each directly
const TAB_COMPONENTS = [
  ['spec', 'TabSpec'], ['test', 'TabTest'], ['parts', 'TabParts'], ['pins', 'TabPins'],
  ['power', 'TabPower'], ['print', 'TabPrint'], ['assembly', 'TabAssembly'], ['code', 'TabCode'], ['steps', 'TabSteps'],
]
{
  const spec = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype: 'arm', mission: 'tab render', reachMm: 400, payloadKg: 0.8 })
  for (const [id, name] of TAB_COMPONENTS) {
    try {
      const html = renderToStaticMarkup(React.createElement(mod[name], { design: spec.design, analysis: spec.analysis }))
      check(`tab ${id} renders`, html.length > 40, `${html.length}b`)
    } catch (err) {
      failures += 1
      console.log(`  FAIL tab ${id}: ${err && err.message}`)
    }
  }
}

// each archetype renders through the page (component-level, not full page)
for (const archetype of ['robot', 'arm', 'rover', 'quadruped', 'gripper', 'gadget']) {
  const spec = mod.composeDesign({ ...mod.DEFAULT_BRIEF, archetype, mission: 'render test', reachMm: 400, payloadKg: 1 })
  // panels are pure: render each tab component directly
  const panels = [
    () => React.createElement(mod.TabPanels ? mod.TabPanels.Spec : 'div'),
  ]
  try {
    // render the composed spec through a tiny wrapper that reuses page styles
    const probe = renderToStaticMarkup(React.createElement(mod.DirectiveCard, {
      attrs: { brief: JSON.stringify({ archetype, mission: 'x', payloadKg: 1, reachMm: 400 }) },
    }))
    check(`directive renders for ${archetype}`, probe.includes('OPEN IN STUDIO'))
  } catch (err) {
    failures += 1
    console.log(`  FAIL directive ${archetype}: ${err.message}`)
  }
}

// ── 5. registration ─────────────────────────────────────────────────────────
console.log('\nregister')
const registered = []
const ctx = {
  source: 'plugin:rigforge',
  contribution: (area, c) => { registered.push({ area, c }); return () => {} },
  registerMany: () => () => {},
  registerSettingsPage: () => () => {},
  onDispose: () => {},
  onEvent: () => () => {},
  setTimeout: () => () => {},
  setInterval: () => () => {},
  addEventListener: () => () => {},
  storage: { get: (k, d) => d, set: () => {}, remove: () => {} },
  os: {},
  rest: async () => ({}),
  socket: () => () => {},
  i18n: {},
}
mod.default.register(ctx)
check('registers page route', registered.some((r) => r.area === 'routes' && r.c.data.path === '/rigforge'))
check('registers sidebar nav', registered.some((r) => r.area === 'sidebar.nav' && r.c.data.label === 'Rigforge'))
check('registers palette rows', registered.filter((r) => r.area === 'palette').length >= 4)
check('registers directive', registered.some((r) => r.area === 'transcript.directives' && r.c.data.name === 'rigforge'))
check('page render() returns an element', !!registered.find((r) => r.area === 'routes').c.render())
const navRow = registered.find((r) => r.area === 'sidebar.nav').c
check('nav has codicon + path', navRow.data.codicon && navRow.data.path === '/rigforge')

// palette row runs
const row = registered.find((r) => r.area === 'palette')
row.c.data.run()
const { calls } = await import(pathToFileURL(join(here, 'tmp/sdk-stub.mjs')).href)
check('palette navigates', calls.some((c) => c[0] === 'navigate'))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`)
process.exit(failures ? 1 : 0)
