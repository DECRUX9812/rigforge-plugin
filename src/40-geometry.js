// ── geometry: joints → world triangles ──────────────────────────────────────
// A forward-kinematics pass over the serial chain. The renderer and the STL
// exporter read the SAME triangle list, so what you orbit is what you print.

const MAT_RGB = {
  shell: [198, 206, 214],
  accent: [255, 107, 26],
  metal: [140, 150, 162],
  pcb: [32, 96, 70],
  rubber: [38, 42, 48],
  glass: [112, 214, 232],
}

function rotAxis(p, pivot, axis, angle) {
  if (!angle) return p
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const x = p[0] - pivot[0]
  const y = p[1] - pivot[1]
  const z = p[2] - pivot[2]
  if (axis === 'z') return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, p[2]]
  if (axis === 'y') return [pivot[0] + x * c + z * s, p[1], pivot[2] - x * s + z * c]
  return [p[0], pivot[1] + y * c - z * s, pivot[2] + y * s + z * c]
}

/** Joint index a node hangs off (-1 = static). */
function jointDepth(design, id) {
  if (!id) return -1
  return design.joints.findIndex((j) => j.id === id)
}

/** Apply the chain rotations (root → leaf) to a rest-pose point. */
function applyChain(design, point, depth) {
  let p = point
  for (let i = 0; i <= depth; i += 1) {
    const j = design.joints[i]
    // Pitch joints read positive = UP: a slider that raises the arm should not
    // drive it into the table. (Servo direction is flipped in the firmware.)
    const sign = j.axis === 'y' ? -1 : 1
    p = rotAxis(p, j.pivot, j.axis, (sign * j.angle * Math.PI) / 180)
  }
  return p
}

const CYL_SEGS = 18

/** One node → triangles in world space. */
function nodeTriangles(design, node, depth) {
  const tris = []
  const push = (a, b, c) => tris.push({ pts: [applyChain(design, a, depth), applyChain(design, b, depth), applyChain(design, c, depth)], mat: node.mat })

  if (node.kind === 'box') {
    const [sx, sy, sz] = node.size.map((v) => v / 2)
    const [cx, cy, cz] = node.pos
    const corner = (i) => [cx + (i & 1 ? sx : -sx), cy + (i & 2 ? sy : -sy), cz + (i & 4 ? sz : -sz)]
    const faces = [
      [0, 2, 3, 1], // bottom
      [4, 5, 7, 6], // top
      [0, 1, 5, 4], // front
      [2, 6, 7, 3], // back
      [0, 4, 6, 2], // left
      [1, 3, 7, 5], // right
    ]
    for (const f of faces) {
      push(corner(f[0]), corner(f[1]), corner(f[2]))
      push(corner(f[0]), corner(f[2]), corner(f[3]))
    }
    return tris
  }

  // cylinder
  const [cx, cy, cz] = node.pos
  const r = node.radius
  const h = node.height / 2
  const axis = node.axis || 'z'
  const ring = (t, side) => {
    const a = (t / CYL_SEGS) * Math.PI * 2
    const u = Math.cos(a) * r
    const v = Math.sin(a) * r
    if (axis === 'z') return [cx + u, cy + v, cz + (side ? h : -h)]
    if (axis === 'y') return [cx + u, cy + (side ? h : -h), cz + v]
    return [cx + (side ? h : -h), cy + u, cz + v]
  }
  for (let i = 0; i < CYL_SEGS; i += 1) {
    const t0 = i
    const t1 = i + 1
    push(ring(t0, 1), ring(t1, 1), ring(t1, 0))
    push(ring(t0, 1), ring(t1, 0), ring(t0, 0))
    push(ring(t0, 0), ring(t1, 0), [cx, cy, cz])
    push(ring(t0, 1), [cx, cy, cz], ring(t1, 1))
  }
  return tris
}

/** Full mesh for the current pose. */
function buildMesh(design) {
  const tris = []
  for (const node of design.nodes) {
    const depth = jointDepth(design, node.joint)
    const add = nodeTriangles(design, node, depth)
    for (const t of add) tris.push(t)
  }
  return tris
}

// ── exporters ───────────────────────────────────────────────────────────────

/** Binary STL — the file a slicer actually opens. */
function toSTL(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const view = new DataView(buf)
  const header = new Uint8Array(buf, 0, 80)
  const text = 'Rigforge export - mm - generated, not modelled'.padEnd(80, ' ')
  for (let i = 0; i < 80; i += 1) header[i] = text.charCodeAt(i) & 0x7f
  view.setUint32(80, tris.length, true)
  let o = 84
  for (const t of tris) {
    const [a, b, c] = t.pts
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    n = n.map((x) => x / len)
    for (const val of n) { view.setFloat32(o, val, true); o += 4 }
    for (const p of [a, b, c]) for (const val of p) { view.setFloat32(o, val, true); o += 4 }
    view.setUint16(o, 0, true)
    o += 2
  }
  return buf
}

/** Parametric source, not a baked mesh: the user can edit dimensions. */
function toOpenSCAD(design) {
  const lines = [
    `// ${design.title} — Rigforge export`,
    `// Rest pose, mm. Edit the numbers, or $fn for smoother cylinders.`,
    '$fn = 48;',
    '',
  ]
  for (const n of design.nodes) {
    if (n.kind === 'box') {
      lines.push(`translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}]) cube([${n.size.map((v) => v.toFixed(1)).join(', ')}], center=true); // ${n.id}`)
    } else {
      const rot = n.axis === 'x' ? 'rotate([0, 90, 0]) ' : n.axis === 'y' ? 'rotate([90, 0, 0]) ' : ''
      lines.push(`${rot}translate([${n.pos.map((v) => v.toFixed(1)).join(', ')}]) cylinder(h=${n.height.toFixed(1)}, r=${n.radius.toFixed(1)}, center=true); // ${n.id}`)
    }
  }
  return lines.join('\n')
}

function toBOMCsv(design) {
  const rows = [['part', 'category', 'qty', 'unit_usd', 'line_usd', 'role']]
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    rows.push([p.name, p.cat, String(qty), p.price.toFixed(2), (p.price * qty).toFixed(2), role])
  }
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')
}

/** The build pack: everything a person needs, in one document. */
function toSpecMarkdown(design, a) {
  const L = []
  const m = design.metrics || {}
  L.push(`# ${design.title}`, '', `_${design.subtitle}_`, '')
  L.push(`**Brief:** ${design.brief.mission || '(no mission text)'}`, '')
  L.push(`| | |`, `|---|---|`)
  L.push(`| Material | ${a.print.material.name} |`)
  L.push(`| Mass | ${Math.round(a.mass.totalG)}g (${Math.round(a.mass.printedG)}g printed) |`)
  L.push(`| Footprint | ${a.dims.map((d) => Math.round(d)).join(' × ')} mm |`)
  L.push(`| Cost | ${money(a.cost)} |`)
  L.push(`| Print | ${fmt(a.print.hours, 0)} h |`)
  L.push(`| Controller | ${a.mcu.name} |`)
  if (m.joints) L.push(`| Actuated joints | ${m.joints} |`)
  if (m.runtimeMin) L.push(`| Runtime | ~${Math.round(m.runtimeMin)} min |`)
  L.push('')

  L.push('## Readiness', '')
  for (const c of a.checks) L.push(`- ${c.level === 'ok' ? 'PASS' : c.level.toUpperCase()} — ${c.msg}`)
  L.push('')

  L.push('## Bill of materials', '', '| Part | Qty | Unit | Line | Role |', '|---|---|---|---|---|')
  for (const { key, qty, role } of design.parts) {
    const p = PARTS[key]
    L.push(`| ${p.name} | ${qty} | ${money(p.price)} | ${money(p.price * qty)} | ${role} |`)
  }
  L.push('', `**Total: ${money(a.cost)}**`, '')

  L.push('## Pin map', '', '| Pin | Signal | Dir | Note |', '|---|---|---|---|')
  for (const r of a.pins.rows) L.push(`| ${r.pin} | ${r.signal} | ${r.dir} | ${r.note} |`)
  L.push('')

  L.push('## Power budget', '', '| Rail | Typical | Peak |', '|---|---|---|')
  for (const [rail, v] of Object.entries(a.power.rails)) L.push(`| ${rail} | ${fmt(v.typ, 2)} A | ${fmt(v.peak, 2)} A |`)
  L.push('', `Typical ${fmt(a.power.typ, 2)}A, peak ${fmt(a.power.peak, 2)}A${a.power.runtimeMin ? `, ~${Math.round(a.power.runtimeMin)} min on ${a.power.bat.name}` : ''}.`, '')

  L.push('## Firmware', '', '```cpp', design.firmware.trim(), '```', '')
  L.push('## Assembly', '')
  for (const s of design.steps) L.push(`${s.n}. **${s.title}** (${s.min} min) — ${s.detail}${s.tools.length ? ` _Tools: ${s.tools.join(', ')}._` : ''}`)
  L.push('')
  if (design.notes.length) {
    L.push('## Design notes', '')
    for (const n of design.notes) L.push(`- ${n}`)
  }
  L.push('', '---', '_Generated by Rigforge — deterministic spec, no model in the loop._')
  return L.join('\n')
}
