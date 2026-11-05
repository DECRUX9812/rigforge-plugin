// Time drawScene directly: build a mesh, render it N times at 1600x980@2x.
import { chromium } from 'playwright'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(join(here, '../src')).filter((f) => f.endsWith('.js')).sort()
let code = files.map((f) => readFileSync(join(here, '../src', f), 'utf8')).join('\n')
code = code.replace(/^import[^\n]*\n/gm, '')
writeFileSync(join(here, 'tmp/bench-src.mjs'), `const jsx = () => null, jsxs = () => null, useRef = () => null, useMemo = (f) => f(), useEffect = () => null, useState = (v) => [v, () => {}], useCallback = (f) => f\n${code}\nexport { drawScene, composeDesign, buildMesh, parseBrief, meshData }\n`)
writeFileSync(join(here, 'tmp/bench-entry.mjs'), `
import { drawScene, composeDesign, buildMesh, parseBrief, meshData } from './bench-src.mjs'
const { design } = composeDesign(parseBrief('5-DoF arm, 450mm reach, 1kg payload'))
let mesh = buildMesh(design)
const only = new URLSearchParams(location.search).get('mat')
if (only) mesh = mesh.filter((t) => t.mat === only)
const cv = document.createElement('canvas')
cv.style.width = '1200px'; cv.style.height = '900px'
document.body.appendChild(cv)
const cam = { yaw: -0.62, pitch: 0.42, dist: 900, ortho: false }
const target = [0, 0, 120]
const q = new URLSearchParams(location.search)
const opts = { grid: q.get('grid') !== '0' }
for (const k of ['reflect', 'outline', 'flat', 'wire']) if (q.get(k) === '0') opts[k] = false
if (q.get('wire') === '1') opts.wire = true
if (q.get('flat') === '1') opts.flat = true
window.shellStats = () => {
  const all = meshData(mesh)
  const shellMesh = mesh.filter((t) => t.mat === 'shell')
  const sm = meshData(shellMesh)
  const boundary = sm.edgeList.filter((e) => e.j < 0).length
  const shared = sm.edgeList.filter((e) => e.j >= 0 && !e.multi).length
  return { tris: mesh.length, shellTris: shellMesh.length, shellEdges: sm.edgeList.length, boundary, shared, boundaryPct: Math.round(100 * boundary / sm.edgeList.length) }
}
window.aoStats = () => { const d = meshData(mesh); const a = Array.from(d.cornerAO); const b = a.map((x) => Math.round(x * 20) / 20); const h = {}; for (const v of b) h[v] = (h[v] || 0) + 1; return { min: Math.min(...a).toFixed(2), max: Math.max(...a).toFixed(2), mean: (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), hist: h, edges: d.edgeList.length } }
window.bench = (n) => {
  drawScene(cv, mesh, cam, target, opts)
  const t0 = performance.now()
  let prof = null
  for (let i = 0; i < n; i += 1) {
    cam.yaw += 0.002
    window.__rfProf = i === n - 1 ? [] : null
    drawScene(cv, mesh, cam, target, opts)
    if (i === n - 1) prof = window.__rfProf
  }
  window.__rfProf = null
  return { tris: mesh.length, msPerFrame: (performance.now() - t0) / n, prof }
}
`)
await build({ entryPoints: [join(here, 'tmp/bench-entry.mjs')], bundle: true, format: 'esm', outfile: join(here, 'tmp/bench.js'), jsx: 'automatic', logLevel: 'warning' })
writeFileSync(join(here, 'tmp/bench.html'), '<!doctype html><meta charset=utf-8><body style="margin:0;background:#0A0D10"><script type=module src="./bench.js"></script>')

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto('http://127.0.0.1:18734/bench.html')
await page.waitForTimeout(1500)
console.log(JSON.stringify(await page.evaluate(() => window.bench(12))))
await page.screenshot({ path: join(here, 'tmp/bench.png') })
await browser.close()
