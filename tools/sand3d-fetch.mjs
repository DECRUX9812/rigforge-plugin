// Sand3D → Rigforge part meshes.
//
// The Sand3D library is Python on Blender's bpy, so it cannot run inside a
// plugin (which may only import the plugin SDK and react). What it *publishes*
// is what we need: USDA files, one per object, with points and face indices in
// plain text. This script pulls a part, triangulates it, decimates to a budget,
// and writes a compact quantised module the viewport can draw.
//
//   node tools/sand3d-fetch.mjs <usda-url> <out-name> [--tris 600]
//
// Output format (src/parts/<name>.js):
//   export const PART = { name, unit, scale, tris: [...] }  // tris = Int16 triples
//   coordinates are quantised to 1/1000 of `scale` millimetres, so a part is a
//   few kilobytes instead of a few hundred.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const url = args[0]
const outName = args[1] || 'part'
const budget = Number((args.includes('--tris') ? args[args.indexOf('--tris') + 1] : 600))

if (!url) {
  console.error('usage: node tools/sand3d-fetch.mjs <usda-url> <out-name> [--tris 600]')
  process.exit(1)
}

const res = await fetch(url)
if (!res.ok) throw new Error(`fetch ${res.status}`)
const text = await res.text()

/** Pull every numeric array we need out of a USDA file (USDA uses [ ... ] tuples). */
function parseUSD(text) {
  const between = (key, open = '[', close = ']') => {
    const i = text.indexOf(key)
    if (i < 0) return null
    // the key itself ends in "[]", so start scanning after the '=' that follows it
    const eq = text.indexOf('=', i)
    const a = text.indexOf(open, eq < 0 ? i : eq)
    if (a < 0) return null
    let depth = 0
    for (let j = a; j < text.length; j += 1) {
      if (text[j] === open) depth += 1
      else if (text[j] === close) {
        depth -= 1
        if (depth === 0) return text.slice(a + 1, j)
      }
    }
    return null
  }
  const ptsRaw = between('point3f[] points')
  const idxRaw = between('int[] faceVertexIndices')
  const cntRaw = between('int[] faceVertexCounts')
  if (!ptsRaw || !idxRaw || !cntRaw) throw new Error('no mesh arrays found — is this a USDA with a Mesh prim?')
  const points = (ptsRaw.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number)
  const indices = (idxRaw.match(/-?\d+/g) || []).map(Number)
  const counts = (cntRaw.match(/-?\d+/g) || []).map(Number)
  return { points, indices, counts }
}

function triangulate({ points, indices, counts }) {
  const tris = []
  let cursor = 0
  for (const n of counts) {
    const ring = indices.slice(cursor, cursor + n)
    cursor += n
    for (let i = 1; i < ring.length - 1; i += 1) tris.push([ring[0], ring[i], ring[i + 1]])
  }
  const vert = (i) => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]
  return tris.map((t) => t.map(vert))
}

/** Vertex clustering: snap to a grid, drop degenerate triangles. Cheap, stable. */
function decimate(tris, target) {
  if (tris.length <= target) return tris
  const all = tris.flat()
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of all) for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]) }
  const span = Math.max(...[0, 1, 2].map((i) => max[i] - min[i])) || 1
  for (let cells = 16; cells >= 2; cells -= 2) {
    const q = span / cells
    const key = (p) => p.map((v) => Math.round((v - min[0]) / (q || 1))).join(',')
    const map = new Map()
    const out = []
    for (const t of tris) {
      const k = t.map(key)
      if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue // collapsed
      const snapped = t.map((p) => p.map((v, i) => Math.round((v - min[i]) / (q || 1))))
      const sig = snapped.map((s) => s.join(',')).sort().join('|')
      if (map.has(sig)) continue
      map.set(sig, true)
      out.push(snapped)
    }
    if (out.length <= target) return out.map((t) => t.map((s) => [s[0] * q + min[0], s[1] * q + min[1], s[2] * q + min[2]]))
  }
  return tris.slice(0, target)
}

/** Centre on the origin, scale to `sizeMm` on the longest axis, quantise. */
function normalise(tris, sizeMm = 40) {
  const all = tris.flat()
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of all) for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]) }
  const span = Math.max(...[0, 1, 2].map((i) => max[i] - min[i])) || 1
  const s = sizeMm / span
  const mid = [0, 1, 2].map((i) => (min[i] + max[i]) / 2)
  const q = []
  let maxAbs = 0
  for (const t of tris) {
    for (const p of t) {
      const v = [0, 1, 2].map((i) => (p[i] - mid[i]) * s)
      maxAbs = Math.max(maxAbs, ...v.map(Math.abs))
      q.push(v)
    }
  }
  const scale = Math.ceil(maxAbs) || 1 // mm radius after normalisation
  const k = 32767 / scale
  const flat = []
  for (const v of q) flat.push(Math.round(v[0] * k), Math.round(v[1] * k), Math.round(v[2] * k))
  return { scale, flat }
}

const mesh = parseUSD(text)
const raw = triangulate(mesh)
const cut = decimate(raw, budget)
const { scale, flat } = normalise(cut, 40)

// src/*.js is concatenated in filename order by build.mjs, so parts live at the
// top level with a low prefix and register themselves on a global table.
const out = join(here, '..', 'src', `parts-${outName}.js`)
const KEY = outName.toUpperCase().replace(/[^A-Z0-9]/g, '_')
const body = `// ${outName} — real CAD mesh converted from Sand3D (${url.split('/').pop()})
// ${raw.length} triangles in, ${cut.length} kept. Quantised int16, ${scale}mm radius.
// Regenerate with: node tools/sand3d-fetch.mjs <usda-url> ${outName}
globalThis.__RF_PARTS = Object.assign(globalThis.__RF_PARTS || {}, {
  ${KEY}: { name: ${JSON.stringify(outName)}, scale: ${scale}, tris: [${flat.join(',')}] },
})
`
writeFileSync(out, body)
console.log(`${outName}: ${raw.length} → ${cut.length} tris, ${(body.length / 1024).toFixed(1)} KB → ${out}`)
