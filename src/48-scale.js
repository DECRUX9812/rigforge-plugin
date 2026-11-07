// ── scale: a person, standing next to the machine ───────────────────────────
// Every number in this product is in millimetres, and millimetres are not a
// unit anyone can feel. A 1750mm human silhouette beside the design turns
// "568 × 150 × 121 mm" into "knee height" or "taller than you", which is the
// question people actually ask when they look at a CAD render.
//
// Drawn as a wireframe out of the same line buffer as the bench overlay: no new
// render path, no fake studio props, just a figure at true scale. If the figure
// and the machine disagree, one of them is lying, and that is worth seeing.

const SCALE_HUMAN_MM = 1750
// How far past the machine's own bounding box the figure reaches: gap + half a
// shoulder width + the ladder. The camera has to frame this or the reference is
// drawn off-screen, which is the same as not drawing it.
const SCALE_EXTRA_MM = 820

// Segment boxes for a 1750mm adult, roughly 7.5 heads. [w, d, h, x, y, z]
const SCALE_PARTS = [
  [180, 180, 220, 0, 0, 1640], // head
  [90, 90, 60, 0, 0, 1500], // neck
  [400, 220, 480, 0, 0, 1240], // chest
  [340, 200, 140, 0, 0, 940], // hips
  [110, 110, 320, 255, 0, 1180], // upper arm R
  [110, 110, 320, -255, 0, 1180], // upper arm L
  [100, 100, 300, 285, 0, 880], // forearm R
  [100, 100, 300, -285, 0, 880], // forearm L
  [150, 150, 430, 105, 0, 680], // thigh R
  [150, 150, 430, -105, 0, 680], // thigh L
  [130, 130, 430, 105, 0, 250], // shin R
  [130, 130, 430, -105, 0, 250], // shin L
  [110, 240, 80, 105, 30, 40], // foot R
  [110, 240, 80, -105, 30, 40], // foot L
]

const SCALE_EDGES = [
  [0, 1], [1, 3], [3, 2], [2, 0], // bottom face
  [4, 5], [5, 7], [7, 6], [6, 4], // top face
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
]

/**
 * Wireframe figure standing beside the design, plus a 1m tick ladder at its
 * feet so the eye has something to count. Returns the same {data, verts}
 * shape the GL overlay pass expects: interleaved x,y,z,r,g,b, GL_LINES.
 */
function scaleFigureOverlay(nodes, opts) {
  if (!nodes || !nodes.length) return null
  const height = (opts && opts.heightMm) || SCALE_HUMAN_MM
  const k = height / SCALE_HUMAN_MM
  const b = boundsOf(nodes)
  if (!Number.isFinite(b.min[0])) return null
  const gap = (opts && opts.gapMm) || 320
  const ox = b.max[0] + gap + 300 * k
  const oy = (b.min[1] + b.max[1]) / 2
  const floor = Math.min(0, b.min[2])
  const col = [0.42, 0.72, 0.92]

  const arr = []
  const seg = (a, c) => {
    arr.push(a[0], a[1], a[2], col[0], col[1], col[2], c[0], c[1], c[2], col[0], col[1], col[2])
  }
  for (const [w, d, h, x, y, z] of SCALE_PARTS) {
    const hw = (w / 2) * k
    const hd = (d / 2) * k
    const hh = (h / 2) * k
    const cx = ox + x * k
    const cy = oy + y * k
    const cz = floor + z * k
    const corner = [
      [cx - hw, cy - hd, cz - hh], [cx + hw, cy - hd, cz - hh],
      [cx + hw, cy + hd, cz - hh], [cx - hw, cy + hd, cz - hh],
      [cx - hw, cy - hd, cz + hh], [cx + hw, cy - hd, cz + hh],
      [cx + hw, cy + hd, cz + hh], [cx - hw, cy + hd, cz + hh],
    ]
    for (const [i, j] of SCALE_EDGES) seg(corner[i], corner[j])
  }

  // 1m ladder behind the figure: ten ticks, the 500mm one longer
  const lx = ox - 420 * k
  for (let i = 0; i <= 10; i += 1) {
    const z = floor + i * 100 * k
    const len = i % 5 === 0 ? 150 * k : 70 * k
    seg([lx, oy, z], [lx + len, oy, z])
  }
  seg([lx, oy, floor], [lx, oy, floor + height])

  return { data: new Float32Array(arr), verts: arr.length / 6 }
}

/** Total height of the emitted figure, for tests and for the HUD. */
function scaleFigureHeight(opts) {
  const k = ((opts && opts.heightMm) || SCALE_HUMAN_MM) / SCALE_HUMAN_MM
  return 1750 * k
}
