import { loadEngine } from '/tmp/rf-tm/tests/lib-engine.mjs'
const A = loadEngine()
const P = A.PRESETS.find(p => p.id === 'rover')
const runs = 30
let meshMs = 0, verts = 0
for (let i = 0; i < runs; i++) {
  const { design } = A.composeDesign({ ...P.brief })
  const t0 = process.hrtime.bigint()
  const mesh = A.buildMesh(design)
  meshMs += Number(process.hrtime.bigint() - t0) / 1e6
  verts = mesh.length
}
console.log(JSON.stringify({ avgMeshMs: +(meshMs / runs).toFixed(2), tris: verts }))
