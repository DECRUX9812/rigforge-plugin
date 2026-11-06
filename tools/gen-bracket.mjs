// Regenerates src/parts-bracket.js — the gantry corner brace mesh.
//
// The previous BRACKET data was a Sand3D USD conversion that failed at the
// source: 86/233 degenerate tris and edges shared by up to 8 triangles. This
// replaces it with a watertight L-profile extrusion (bottom bar + left bar
// meeting at the corner, extruded through the full ±20mm table space). The L
// is decomposed into three edge-matched rectangles so no cap vertex exceeds
// valence 3 — strict B-rep kernels rejected the fan-centred version.
//
// Run: node tools/gen-bracket.mjs   → rewrites src/parts-bracket.js
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const Z0 = -20; const Z1 = 20
// L = three rectangles in the XZ plane, edge-matched (no T-junctions):
//   R1 x[-20,-8] z[-20,-8]   R2 x[-8,20] z[-20,-8]   R3 x[-20,-8] z[-8,20]
const RECTS = [
  [[-20, -20], [-8, -20], [-8, -8], [-20, -8]],
  [[-8, -20], [20, -20], [20, -8], [-8, -8]],
  [[-20, -8], [-8, -8], [-8, 20], [-20, 20]],
]
const tris = []
// side walls on the L's outer boundary, segmented exactly where the cap
// rectangles split (bottom edge at x=-8, left edge at z=-8) — polygon-level
// edges would leave T-junctions the manifold guard rejects.
const WALLS = [
  [[-20, -20], [-8, -20]],   // bottom, left half
  [[-8, -20], [20, -20]],    // bottom, right half
  [[20, -20], [20, -8]],     // arm right side
  [[20, -8], [-8, -8]],      // arm underside (notch top)
  [[-8, -8], [-8, 20]],      // notch right wall
  [[-8, 20], [-20, 20]],     // top
  [[-20, 20], [-20, -8]],    // left, upper half
  [[-20, -8], [-20, -20]],   // left, lower half
]
for (const [a, b] of WALLS) {
  // quad A(a,-20) B(b,-20) B'(b,+20) A'(a,+20); [A,B',B]+[A,A',B'] winds
  // outward for every wall because WALLS traverses the L boundary consistently
  tris.push(
    [[a[0], -20, a[1]], [b[0], 20, b[1]], [b[0], -20, b[1]]],
    [[a[0], -20, a[1]], [a[0], 20, a[1]], [b[0], 20, b[1]]],
  )
}
// caps: two tris per rectangle per side; the +y face needs the reversed order
// (verified by signed volume in the probe before this was committed).
for (const side of [-1, 1]) {
  const y = side * 20
  for (const r of RECTS) {
    const t1 = [r[0], r[1], r[2]].map(([x, z]) => [x, y, z])
    const t2 = [r[0], r[2], r[3]].map(([x, z]) => [x, y, z])
    if (side > 0) { tris.push([t1[0], t1[2], t1[1]], [t2[0], t2[2], t2[1]]) }
    else { tris.push(t1, t2) }
  }
}

// walls and caps are both wound outward — a previous revision flipped every
// tri globally, which fixed the walls but turned the (already outward) caps
// inward: a mixed-winding shell strict kernels reject as unorientable.

const flat = []
for (const t of tris) for (const p of t) {
  flat.push(Math.round(p[0] / 20 * 32767), Math.round(p[1] / 20 * 32767), Math.round(p[2] / 20 * 32767))
}
const lines = []
for (let i = 0; i < flat.length; i += 100) lines.push(flat.slice(i, i + 100).join(','))

writeFileSync(join(here, '..', 'src', 'parts-bracket.js'), `// BRACKET — gantry corner brace. Rebuilt as a watertight L-profile
// extrusion by tools/gen-bracket.mjs (the Sand3D conversion it replaces was
// broken source data: degenerate tris, edges shared by up to 8 faces). The L
// is three edge-matched rectangles so strict B-rep kernels accept the caps.
globalThis.__RF_PARTS = Object.assign(globalThis.__RF_PARTS || {}, {
  BRACKET: { name: "bracket", scale: 20, tris: [
    ${lines.join(',\n    ')}
  ] },
})
`)
console.log(`wrote src/parts-bracket.js — ${tris.length} tris, ${flat.length} int16 values`)
