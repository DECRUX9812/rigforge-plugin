// Render the OpenSCAD export through a real OpenSCAD engine.
//   npm i --no-save openscad-wasm && node tests/scad-render.mjs
// Structural checks in truth.mjs once said an export was fine while OpenSCAD
// refused to parse it — a // note inside a module body had commented out the
// closing brace and the braces still balanced. This is the check that catches
// that class of bug: parse the file, render it, count triangles.
import { loadEngine } from './lib-engine.mjs'

let createOpenSCAD = null
try {
  ;({ createOpenSCAD } = await import('openscad-wasm'))
} catch {
  console.log(JSON.stringify({ ok: null, skipped: 'openscad-wasm not installed (npm i --no-save openscad-wasm)' }))
  process.exit(0)
}

const A = loadEngine()
// Default to the two fastest machines: a full sweep of all ten takes minutes
// because the big assemblies are boolean-heavy. Pass ids to widen it.
const want = process.argv.slice(2)
const presets = want.length ? A.PRESETS.filter((p) => want.includes(p.id)) : A.PRESETS.filter((p) => ['iot', 'arm'].includes(p.id))
const problems = []
const rows = []

// One engine instance per file: emscripten latches its exit status after a
// failed parse, so a shared instance silently returns nothing for every file
// after the first error.
for (const p of presets) {
  const { design } = A.composeDesign({ ...p.brief })
  const scad = A.toOpenSCAD(design)
  let inst
  try {
    inst = await createOpenSCAD()
    const stl = await inst.renderToStl(scad)
    const tris = (stl.match(/facet normal/g) || []).length
    rows.push({ id: p.id, nodes: design.nodes.length, tris })
    if (tris === 0) problems.push(`${p.id}: rendered no triangles`)
  } catch (e) {
    const msg = e && e.message ? e.message : JSON.stringify(e)
    problems.push(`${p.id}: OpenSCAD rejected the export — ${String(msg).slice(0, 120)}`)
    rows.push({ id: p.id, nodes: design.nodes.length, error: true })
  } finally {
    inst = null
  }
}

console.log(JSON.stringify({ ok: problems.length === 0, machines: rows.length, rows, problems }, null, 1))
process.exit(problems.length ? 1 : 0)
