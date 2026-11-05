import { loadEngine } from '/tmp/rf-sc/tests/lib-engine.mjs'
import { writeFileSync } from 'node:fs'
const A = loadEngine()
const out = []
for (const p of A.PRESETS) {
  const { design } = A.composeDesign({ ...p.brief })
  const scad = A.toOpenSCAD(design)
  const id = (p.id || 'design').replace(/[^a-z0-9-]/gi, '')
  writeFileSync(`/tmp/scadcheck/${id}.scad`, scad)
  out.push([id, design.nodes.length, scad.length])
}
console.log(JSON.stringify(out.slice(0, 4)), 'presets:', out.length)
