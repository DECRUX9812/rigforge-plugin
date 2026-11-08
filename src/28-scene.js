// ── scene: several machines sharing one bench ──────────────────────────────
// A workshop lineup is a real deliverable — the rover beside the arm it feeds,
// the sensor node watching both. Each machine is built through the normal
// pipeline (own analysis, own BOM), then merged into ONE design: ids prefixed,
// placement baked as yaw + offset. Cost, mass, pin budget, power and print
// packing are then computed over the whole scene — two machines cannot
// silently share a pin or a watt.
//
// v1 transforms are yaw-about-Z + translation only. Arbitrary orientation
// would have to rotate every joint axis AND every node euler; yaw covers
// "machines side by side on a bench" honestly, and the spec says so.

const SCENE_GAP = 140 // mm of clear floor between machine envelopes
const SCENE_DEFAULT = [
  { preset: 'arm', label: 'pick & place arm' },
  { preset: 'rover', label: 'survey rover' },
  { preset: 'iot', label: 'sensor node' },
]

/** Resolve a scene slot to a composed machine. spec.preset may be a PRESETS
 *  id ('arm') or an archetype ('rover'); other spec fields override the
 *  preset's brief. 'scene' itself is refused — recursion is not a machine. */
function sceneMachine(spec, material) {
  if (!spec || typeof spec !== 'object') return null
  const preset = PRESETS.find((p) => p.id === spec.preset || p.brief.archetype === spec.preset || p.id === spec.archetype)
  const arch = preset ? preset.brief.archetype : spec.archetype || spec.preset
  // composeDesign falls through to the arm builder for unknown archetypes —
  // a scene slot must name a real machine or be refused, not silently arm.
  const BUILDABLE = ['arm', 'rover', 'quadruped', 'gripper', 'gadget', 'robot', 'humanoid', 'gantry', 'iot', 'pcb', 'custom']
  if (!arch || arch === 'scene' || !BUILDABLE.includes(arch)) return null
  const brief = { ...(preset ? preset.brief : { archetype: arch }), ...spec }
  delete brief.scene
  delete brief.preset
  // Material is a scene-level decision — print packing and cost assume one
  // filament, so a slot cannot quietly order a different one.
  brief.material = material || brief.material || 'petg'
  return { spec, label: spec.label || (preset ? preset.id : arch), out: composeDesign(brief) }
}

/** Bake one machine into the scene frame: translate its bounding-box anchor
 *  to the slot centre, floor its lowest point at z=0, yaw about that anchor. */
function sceneBake(design, slot, yawRad) {
  const bb = boundsOf(design.nodes)
  const anchor = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, bb.min[2]]
  const c = Math.cos(yawRad), s = Math.sin(yawRad)
  const R = (p) => [
    c * (p[0] - anchor[0]) - s * (p[1] - anchor[1]) + slot.x,
    s * (p[0] - anchor[0]) + c * (p[1] - anchor[1]) + slot.y,
    p[2] - anchor[2] + slot.z,
  ]
  // 'z' survives a z-yaw as the letter (sign conventions and exporters read
  // it); 'x'/'y' become vectors and keep their model letter in axis0 so the
  // pitch-joint sign check still knows what it was. yaw=0 leaves axes alone.
  const axisFor = (axis) => {
    if (Math.abs(s) < 1e-12 && Math.abs(c - 1) < 1e-12) return axis
    const v = axisVec3(axis)
    const rv = [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]
    if (Math.abs(rv[0]) < 1e-9 && Math.abs(rv[1]) < 1e-9 && Math.abs(Math.abs(rv[2]) - 1) < 1e-9) return 'z'
    return rv
  }
  return { R, axisFor, prefix: slot.prefix }
}

function buildScene(brief) {
  // An omitted scene means the default lineup; an empty one is a user error
  // and must fail honestly rather than quietly materialising three machines.
  const specs = brief.scene == null ? SCENE_DEFAULT
    : Array.isArray(brief.scene) ? brief.scene : [brief.scene]
  const d = newDesign('scene', brief)
  const machines = []
  const sceneMat = brief.material || 'petg'
  for (const raw of specs) {
    const spec = typeof raw === 'string' ? { preset: raw } : raw
    const m = sceneMachine(spec, sceneMat)
    if (m) machines.push(m)
    else d.notes.push(`Scene slot skipped — '${raw && (raw.preset || raw.archetype || raw)}' is not a buildable machine.`)
  }
  if (!machines.length) {
    d.checks.push({ level: 'fail', msg: 'Scene has no machines — name presets in brief.scene.' })
    return d
  }

  // auto-layout: a row along X, envelopes separated by SCENE_GAP, all facing
  // the same way unless a spec asks for yaw. Slot width must be the yawed
  // footprint — a 90° turn swaps width and depth, and spacing by the unrotated
  // number would let neighbours overlap.
  const widths = machines.map(({ spec, out }) => {
    const bb = boundsOf(out.design.nodes)
    const w = bb.max[0] - bb.min[0], d = bb.max[1] - bb.min[1]
    const yaw = ((spec.yaw || 0) * Math.PI) / 180
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw))
    return { w: w * c + d * s }
  })
  const total = widths.reduce((a, w) => a + w.w, 0) + SCENE_GAP * (machines.length - 1)
  let cursor = -total / 2
  const slots = machines.map((m, i) => {
    const slot = { x: cursor + widths[i].w / 2, y: 0, z: 0, prefix: `s${i}-` }
    cursor += widths[i].w + SCENE_GAP
    return slot
  })

  machines.forEach(({ spec, label, out }, i) => {
    const yaw = ((spec.yaw || 0) * Math.PI) / 180
    const { R, axisFor, prefix } = sceneBake(out.design, slots[i], yaw)
    const sd = out.design

    for (const n of sd.nodes || []) {
      d.nodes.push({
        ...n,
        id: prefix + n.id,
        pos: R(n.pos || [0, 0, 0]),
        // scene yaw about Z composes with the node euler as rz += yaw —
        // rotEuler applies rx→ry→rz, so Rz(θ)·R_node = Rz(θ+rz)·Ry·Rx
        rot: n.rot ? [n.rot[0], n.rot[1], n.rot[2] + yaw] : n.rot,
        joint: n.joint ? prefix + n.joint : n.joint,
        slide: n.slide ? { ...n.slide, joint: prefix + n.slide.joint } : n.slide,
      })
    }
    for (const j of sd.joints || []) {
      const nj = {
        ...j,
        id: prefix + j.id,
        label: `${label} · ${j.label || j.id}`,
        pivot: R(j.pivot || [0, 0, 0]),
        parent: j.parent ? prefix + j.parent : null,
        axis: axisFor(j.axis),
      }
      if (nj.axis !== j.axis) nj.axis0 = j.axis
      d.joints.push(nj)
    }
    for (const p of sd.parts || []) addPart(d, p.key, p.qty, `${label}: ${p.role || 'part'}`)
    // Firmware is per-machine too — keep each member's own sketch for the
    // composite doc firmwareFor emits, with its servo count so the doc can
    // account for every channel the lineup's BOM buys.
    d._memberFirmware = d._memberFirmware || []
    const servoQty = (sd.parts || []).reduce((n, p) => (PARTS[p.key] && PARTS[p.key].cat === 'servo' ? n + p.qty : n), 0)
    d._memberFirmware.push({ label, file: `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ino`, servos: servoQty, code: out.design.firmware })
    // A machine that fails its own checks fails the scene — the lineup is
    // only as buildable as its weakest member.
    for (const c of (out.design.checks || []).filter((c) => c.level === 'fail'))
      d.checks.push({ level: 'fail', msg: `${label}: ${c.msg}` })
    const subWarn = (out.design.checks || []).filter((c) => c.level === 'warn').length
    if (subWarn) d.notes.push(`${label}: ${subWarn} build warning(s) — see its standalone report.`)
    d.notes.push(`${label} — ${Math.round(out.analysis.mass.totalG)}g · $${out.analysis.cost.toFixed(0)} · placed at x=${Math.round(slots[i].x)}${spec.yaw ? ` yaw ${spec.yaw}°` : ''}`)
  })

  // Harness is per-machine, not per-scene: each member's stock-lead runs were
  // measured in its own composeDesign, and yaw+translate preserves every
  // distance, so those rows stay true in the scene frame. Ids get the slot
  // prefix so they resolve against the merged joint table.
  const hRows = []
  const hHomes = []
  const hDrops = []
  let needExt = 0
  machines.forEach(({ label, out }, i) => {
    const h = out.analysis && out.analysis.harness
    if (!h) return
    const prefix = slots[i].prefix
    for (const r of h.rows || []) hRows.push({ ...r, id: prefix + r.id, label: `${label} · ${r.label || r.id}` })
    hHomes.push({ label, home: h.home })
    hDrops.push(...(h.dropBad || []))
    needExt += h.needExt || 0
  })
  if (hRows.length) {
    d._sceneHarness = {
      // home stays null: there is no single driver bay in a lineup — the
      // cable overlay needs per-machine homes and stays off for scenes.
      home: null, homes: hHomes, rows: hRows,
      worst: hRows.reduce((a, b) => (b.run > (a ? a.run : -1) ? b : a), null),
      needExt, dropBad: hDrops,
      minLead: Math.min(...machines.map((m) => m.out.analysis.harness?.minLead ?? Infinity).filter(isFinite)),
      maxLead: Math.max(...machines.map((m) => m.out.analysis.harness?.maxLead ?? -Infinity).filter((v) => v > -Infinity)),
      busOnly: machines.every((m) => m.out.analysis.harness?.busOnly),
      note: 'Per-machine harnesses — runs measured inside each member, not across the bench.',
    }
  }

  // Post-merge envelope check: yawed footprints can still intersect where
  // slot maths can't see (irregular shapes, extreme angles). AABB overlap is
  // honest warn-level evidence — it is not proof of solid contact.
  const envs = machines.map((_, i) => {
    const ns = d.nodes.filter((n) => n.id.startsWith(`s${i}-`))
    return ns.length ? boundsOf(ns) : null
  }).filter(Boolean)
  for (let a = 0; a < envs.length; a++) {
    for (let b = a + 1; b < envs.length; b++) {
      const A = envs[a], B = envs[b]
      const ox = Math.min(A.max[0], B.max[0]) - Math.max(A.min[0], B.min[0])
      const oy = Math.min(A.max[1], B.max[1]) - Math.max(A.min[1], B.min[1])
      const oz = Math.min(A.max[2], B.max[2]) - Math.max(A.min[2], B.min[2])
      if (ox > 1 && oy > 1 && oz > 1)
        d.checks.push({ level: 'warn', msg: `Machine envelopes overlap by ~${Math.round(Math.min(ox, oy, oz))}mm — the lineup may collide. Reduce yaw or ask for a wider bench.` })
    }
  }

  d.title = `Workshop scene · ${machines.length} machine${machines.length > 1 ? 's' : ''}`
  d.subtitle = machines.map((m) => m.label).join(' + ')
  d.metrics = { machines: machines.length }
  d.notes.push('Each machine keeps its own kinematics under prefixed ids (s0-, s1-…) — pose presets, single-arm IK and per-machine teleop do not span the scene.')
  d.notes.push('Scene transforms are yaw + offset only; every machine prints in the scene material.')
  return d
}
