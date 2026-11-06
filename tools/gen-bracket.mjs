// Regenerates src/parts-bracket.js — the gantry corner brace mesh.
//
// The previous BRACKET data was a Sand3D USD conversion that failed at the
// source: 86/233 degenerate tris and edges shared by up to 8 triangles. This
// replaces it with a watertight L-profile extrusion (bottom bar + left bar
// meeting at the corner, extruded through the full ±20mm table space).
//
// Run: node tools/gen-bracket.mjs   → rewrites src/parts-bracket.js
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// L polygon, CCW seen from +z, in the part table's ±20mm native space.
// Star-shaped from v0, so the cap fan below is valid.
const P = [[-20, -20], [20, -20], [20, -8], [-8, -8], [-8, 20], [-20, 20]]
const Z0 = -20; const Z1 = 20
const tris = []
for (let i = 0; i < P.length; i += 1) {
  const j = (i + 1) % P.length
  tris.push(
    [[P[i][0], P[i][1], Z0], [P[j][0], P[j][1], Z0], [P[j][0], P[j][1], Z1]],
    [[P[i][0], P[i][1], Z0], [P[j][0], P[j][1], Z1], [P[i][0], P[i][1], Z1]],
  )
}
for (let i = 1; i < P.length - 1; i += 1) {
  tris.push(
    [[P[0][0], P[0][1], Z0], [P[i][0], P[i][1], Z0], [P[i + 1][0], P[i + 1][1], Z0]],
    [[P[0][0], P[0][1], Z1], [P[i + 1][0], P[i + 1][1], Z1], [P[i][0], P[i][1], Z1]],
  )
}

const flat = []
for (const t of tris) for (const p of t) {
  flat.push(Math.round(p[0] / 20 * 32767), Math.round(p[1] / 20 * 32767), Math.round(p[2] / 20 * 32767))
}
const lines = []
for (let i = 0; i < flat.length; i += 100) lines.push(flat.slice(i, i + 100).join(','))

writeFileSync(join(here, '..', 'src', 'parts-bracket.js'), `// BRACKET — gantry corner brace. Rebuilt as a watertight L-profile
// extrusion by tools/gen-bracket.mjs (the Sand3D conversion it replaces was
// broken source data: degenerate tris, edges shared by up to 8 faces).
globalThis.__RF_PARTS = Object.assign(globalThis.__RF_PARTS || {}, {
  BRACKET: { name: "bracket", scale: 20, tris: [
    ${lines.join(',\n    ')}
  ] },
})
`)
console.log(`wrote src/parts-bracket.js — ${tris.length} tris, ${flat.length} int16 values`)
