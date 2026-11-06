// ── custom: a machine authored as a node/joint spec, not an archetype ───────
// The brief carries `nodes` (geometry) and `joints` (revolute chain or linear
// slides) in the same shape the engine already poses, meshes and exports — so
// FK, STL/3MF/GLB/STEP, DFM, the bench and every teleop that self-selects
// (IK arms, gantry slides, grippers, sensors) work with zero archetype code.
// Servo sizing reuses the bench's own gravity-torque statics: placeholder
// actuators let benchTorqueMargins measure each joint's need, then the
// SERVO_LADDER picks the smallest part that holds it with the arm's 1.7×
// factor. What the spec cannot express, the checks say out loud.
//
// Spec shapes (all mm, joint angles in degrees, node `rot` in DEGREES —
// converted to the radians node.rot stores):
//   nodes[]  { kind:'box|rbox|cyl|cone|ring|torus|wedge|sphere|gear|rack|bend|mesh',
//              at:[x,y,z] centre, rot:[rx,ry,rz]?, joint:'jid'?, slide:'jid'|{joint,sign}?,
//              print:true?, mat:'shell|accent|metal|steel|brass|pcb|rubber|glass|servo|belt'?, ... }
//   joints[] { id, label?, axis:'x'|'y'|'z'|[x,y,z], pivot:[x,y,z], min, max,
//              parent:'jid'?, servo?:'ds3225', ratio?:n }                    — revolute
//            { id, label?, slide:true, axis:'x'|'y'|'z', travel:mm, min?, max?,
//              parent:'jid'? }                                              — linear
// Per-kind extras: box/rbox/wedge/rack take size:[x,y,z] (rbox also r=chamfer);
// cyl takes r,h,axis,r2(taper),segs; ring takes ro,ri (RADII),h,axis;
// torus takes R,r,axis; sphere takes r; gear takes m(module),z(teeth),w(axis);
// bend takes R,r,arc(deg),rot aims it; mesh takes part,size.

const CUSTOM_MATS = ['shell', 'accent', 'metal', 'steel', 'brass', 'pcb', 'rubber', 'glass', 'servo', 'belt']
const CUSTOM_NUM = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const CUSTOM_VEC = (v, n = 3) => (Array.isArray(v) && v.length >= n && v.slice(0, n).every((x) => Number.isFinite(Number(x)))
  ? v.slice(0, n).map(Number) : null)

function specKind(node) {
  const k = String(node.kind || node.shape || '').toLowerCase()
  return { box: 'box', rbox: 'rbox', cyl: 'cyl', cylinder: 'cyl', tube: 'cyl',
    cone: 'cone', pyramid: 'cone',
    ring: 'ring', torus: 'torus', wedge: 'wedge', sphere: 'sphere', ball: 'sphere',
    gear: 'gear', rack: 'rack', bend: 'bend', elbow: 'bend', mesh: 'mesh' }[k] || null
}

/** Emit one spec node through the same helpers every archetype uses. */
function specEmit(d, raw, idx, warn) {
  const kind = specKind(raw)
  if (!kind) { warn(`node ${idx + 1}: unknown kind '${raw.kind}' — skipped`); return }
  const at = CUSTOM_VEC(raw.at ?? raw.pos, 3) || [0, 0, 0]
  const mat = CUSTOM_MATS.includes(raw.mat) ? raw.mat : (raw.print ? 'shell' : 'metal')
  const extra = {}
  if (raw.print) extra.print = true
  if (typeof raw.joint === 'string' && raw.joint) extra.joint = raw.joint
  if (raw.slide) {
    extra.slide = typeof raw.slide === 'string' ? { joint: raw.slide, sign: 1 } : { joint: raw.slide.joint, sign: raw.slide.sign === -1 ? -1 : 1 }
  }
  const rot = CUSTOM_VEC(raw.rot, 3)
  if (rot) extra.rot = rot.map((r) => (r * Math.PI) / 180) // spec is degrees; node.rot is radians
  const size = CUSTOM_VEC(raw.size, 3)
  const axis = ['x', 'y', 'z'].includes(raw.axis) ? raw.axis : 'z'
  const id = String(raw.id || `n${idx + 1}`)
  switch (kind) {
    case 'box': if (!size) return warn(`node ${id}: box needs size:[x,y,z]`); box(d, id, size, at, mat, extra); break
    case 'rbox': if (!size) return warn(`node ${id}: rbox needs size:[x,y,z]`); rbox(d, id, size, at, CUSTOM_NUM(raw.r, 1.5), mat, extra); break
    case 'cyl': {
      const r = CUSTOM_NUM(raw.r ?? raw.radius, 0), h = CUSTOM_NUM(raw.h ?? raw.height, 0)
      if (!(r > 0) || !(h > 0)) return warn(`node ${id}: cyl needs r>0 and h>0`)
      const e = { ...extra }
      if (Number.isFinite(Number(raw.r2 ?? raw.radius2))) e.radius2 = Number(raw.r2 ?? raw.radius2)
      if (Number.isFinite(Number(raw.segs))) e.segs = Math.round(Number(raw.segs))
      cyl(d, id, r, h, at, axis, mat, e); break
    }
    case 'cone': {
      const r = CUSTOM_NUM(raw.r ?? raw.radius, 0), h = CUSTOM_NUM(raw.h ?? raw.height, 0)
      if (!(r > 0) || !(h > 0)) return warn(`node ${id}: cone needs r>0 and h>0`)
      const e = { ...extra }
      if (Number.isFinite(Number(raw.segs))) e.segs = Math.round(Number(raw.segs))
      cone(d, id, r, h, at, axis, mat, e); break
    }
    case 'ring': {
      const ro = CUSTOM_NUM(raw.ro ?? raw.outer, 0), ri = CUSTOM_NUM(raw.ri ?? raw.inner, 0), h = CUSTOM_NUM(raw.h ?? raw.height, 0)
      if (!(ro > ri && ri > 0) || !(h > 0)) return warn(`node ${id}: ring needs ro>ri>0 and h>0`)
      ring(d, id, ro, ri, h, at, axis, mat, extra); break
    }
    case 'torus': {
      const R = CUSTOM_NUM(raw.R ?? raw.major, 0), r = CUSTOM_NUM(raw.r ?? raw.minor, 0)
      if (!(R > 0) || !(r > 0)) return warn(`node ${id}: torus needs R>0 and r>0`)
      torus(d, id, R, r, at, axis, mat, extra); break
    }
    case 'wedge': if (!size) return warn(`node ${id}: wedge needs size:[x,y,z]`); wedge(d, id, size, at, ['px', 'nx', 'py', 'ny'].includes(raw.dir) ? raw.dir : 'px', mat, extra); break
    case 'sphere': { const r = CUSTOM_NUM(raw.r ?? raw.radius, 0); if (!(r > 0)) return warn(`node ${id}: sphere needs r>0`); ball(d, id, r, at, mat, extra); break }
    case 'gear': {
      const m = CUSTOM_NUM(raw.m ?? raw.module, 0), z = Math.round(CUSTOM_NUM(raw.z ?? raw.teeth, 0)), w = CUSTOM_NUM(raw.w ?? raw.width, 0)
      if (!(m > 0) || z < 6 || !(w > 0)) return warn(`node ${id}: gear needs m>0, z>=6, w>0`)
      gear(d, id, m, z, w, at, axis, mat, extra); break
    }
    case 'rack': if (!size || !(CUSTOM_NUM(raw.teeth, 0) >= 2)) return warn(`node ${id}: rack needs size:[x,y,z] and teeth>=2`); rack(d, id, size, Math.round(CUSTOM_NUM(raw.teeth, 8)), at, mat, extra); break
    case 'bend': {
      const R = CUSTOM_NUM(raw.R, 0), r = CUSTOM_NUM(raw.r, 0), arc = CUSTOM_NUM(raw.arc ?? raw.deg, 90)
      if (!(R > 0) || !(r > 0)) return warn(`node ${id}: bend needs R>0 and r>0`)
      bend(d, id, R, r, arc, at, extra.rot || [0, 0, 0], mat, extra); break
    }
    case 'mesh': {
      if (!raw.part) return warn(`node ${id}: mesh needs part (a vendored CAD name)`)
      if (!size) return warn(`node ${id}: mesh needs size:[x,y,z]`)
      mesh(d, id, String(raw.part), size, at, mat, extra); break
    }
    default: break
  }
}

/**
 * Size every revolute joint from measured gravity torque. Placeholder
 * actuators make benchTorqueMargins report needs; the real pick then
 * replaces them. Yaw/vertical joints gravity can't load get the mid-ladder
 * servo and a note saying the static model didn't measure them.
 */
function sizeCustomServos(d, mat) {
  const rev = d.joints.filter((j) => !j.slide)
  if (!rev.length) return
  d.actuators = rev.map((j) => ({ label: j.label || j.id, servo: 'sg90', ratio: 1, effective: 0 }))
  const needs = new Map()
  try {
    for (const t of benchTorqueMargins(d, mat) || []) needs.set(t.joint, t.needNm)
  } catch { /* a malformed spec must not take the whole build down */ }
  const top = 'ds3225'
  const pick = rev.map((j) => {
    const spec = (j.spec && j.spec.servo) || null
    if (spec && PARTS[spec] && PARTS[spec].cat === 'servo') return { j, servo: spec, measured: true }
    const need = needs.get(j.id) || 0
    if (!(need > 0.005)) return { j, servo: 'mg90s', measured: false } // yaw/vertical — unmeasured, mid servo
    const want = need * 1.7
    const servo = SERVO_LADDER.filter((k) => k !== 'sts3215').find((k) => PARTS[k].torque >= want) || top
    return { j, servo, measured: true, need, want }
  })
  d.actuators = pick.map(({ j, servo }) => ({
    label: j.label || j.id, need: needs.get(j.id) || 0, servo,
    ratio: (j.spec && j.spec.ratio) || 1, effective: PARTS[servo].torque,
  }))
  for (const p of pick) {
    if (p.need && p.want && PARTS[p.servo].torque < p.want) {
      d.checks.push({ level: 'fail', msg: `${p.j.label || p.j.id} needs ${fmt(p.need, 2)} N·m (${fmt(p.want, 2)} with margin) — beyond the ${PARTS[top].name}. Add a reduction stage or split the load.` })
    } else if (p.measured && p.need) {
      const ratio = PARTS[p.servo].torque / Math.max(p.need, 1e-6)
      if (ratio < 2.2) d.checks.push({ level: 'warn', msg: `${p.j.label || p.j.id} runs at ${Math.round((p.need / PARTS[p.servo].torque) * 100)}% of ${PARTS[p.servo].name} stall — thin margin for a spec-authored joint.` })
    }
  }
  return pick
}

function buildCustom(brief) {
  const d = newDesign('custom', brief)
  const specNodes = typeof brief.nodes === 'string' ? (() => { try { return JSON.parse(brief.nodes) } catch { return null } })() : brief.nodes
  const specJoints = typeof brief.joints === 'string' ? (() => { try { return JSON.parse(brief.joints) } catch { return null } })() : brief.joints
  const nodes = Array.isArray(specNodes) ? specNodes.slice(0, 64) : []
  const jspec = Array.isArray(specJoints) ? specJoints.slice(0, 16) : []
  const warns = []
  const warn = (m) => { warns.push(m); if (warns.length <= 12) d.checks.push({ level: 'warn', msg: m }) }

  d.title = brief.title || (brief.mission ? String(brief.mission).slice(0, 60) : 'Custom machine')
  d.subtitle = 'spec-driven · every number computed'

  // ── joints first: nodes reference them by id ─────────────────────────────
  const seen = new Set()
  for (const [i, js] of jspec.entries()) {
    const id = String(js && js.id || '')
    if (!id || seen.has(id)) { warn(`joint ${i + 1}: missing or duplicate id — skipped`); continue }
    seen.add(id)
    const label = String(js.label || id)
    if (js.slide || js.kind === 'slide') {
      const axis = ['x', 'y', 'z'].includes(js.axis) ? js.axis : null
      if (!axis) { warn(`slide '${id}': axis must be x, y or z — skipped`); continue }
      const travel = CUSTOM_NUM(js.travel ?? js.max, 0)
      const j = { id, label, axis, slide: true, pivot: [0, 0, 0], angle: 0,
        min: CUSTOM_NUM(js.min, 0), max: CUSTOM_NUM(js.max, travel || js.travel || 100), parent: null }
      if (!(j.max > j.min)) { warn(`slide '${id}': max must exceed min — skipped`); continue }
      j.parent = typeof js.parent === 'string' && js.parent !== id ? js.parent : null
      j.spec = js
      d.joints.push(j)
    } else {
      const axis = Array.isArray(js.axis) ? CUSTOM_VEC(js.axis, 3) : (['x', 'y', 'z'].includes(js.axis) ? js.axis : 'z')
      const pivot = CUSTOM_VEC(js.pivot, 3) || [0, 0, 0]
      const min = CUSTOM_NUM(js.min, -135), max = CUSTOM_NUM(js.max, 135)
      if (!(max > min)) { warn(`joint '${id}': max must exceed min — skipped`); continue }
      const j = { id, label, axis, pivot, angle: 0, min, max, parent: null }
      j.parent = typeof js.parent === 'string' && js.parent !== id ? js.parent : (d.joints.length ? d.joints[d.joints.length - 1].id : null)
      j.spec = js
      d.joints.push(j)
    }
  }
  // parent refs must resolve; a dangling parent silently orphans the chain
  const jids = new Set(d.joints.map((j) => j.id))
  for (const j of d.joints) {
    if (j.parent && !jids.has(j.parent)) { warn(`joint '${j.id}': parent '${j.parent}' does not exist — treated as base-mounted`); j.parent = null }
  }

  // ── nodes ────────────────────────────────────────────────────────────────
  const nodeIds = new Set()
  nodes.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return warn(`node ${i + 1}: not an object — skipped`)
    const before = d.nodes.length
    specEmit(d, raw, i, warn)
    const last = d.nodes[d.nodes.length - 1]
    if (d.nodes.length > before && last && nodeIds.has(last.id)) warn(`node '${last.id}': duplicate id — exports name products by id`)
    if (d.nodes.length > before && last) nodeIds.add(last.id)
  })
  for (const n of d.nodes) {
    if (n.joint && !jids.has(n.joint)) { warn(`node '${n.id}' tags missing joint '${n.joint}' — left static`); delete n.joint }
    if (n.slide && n.slide.joint && !jids.has(n.slide.joint)) { warn(`node '${n.id}' slides on missing joint '${n.slide.joint}' — left static`); delete n.slide }
  }

  if (warns.length > 12) d.checks.push({ level: 'warn', msg: `…and ${warns.length - 12} more spec warnings — the first ones above are the pattern.` })
  if (!d.nodes.length) {
    d.checks.push({ level: 'fail', msg: 'The spec produced no geometry — every node was skipped. Check kinds, sizes and ids.' })
  } else if (!d.joints.length) {
    d.notes.push('No joints in the spec — this is a static assembly. Add revolute joints (axis+pivot+limits) or slides (travel) to make it move.')
  }

  // ── actuators: measured, not guessed ─────────────────────────────────────
  const mat = MATERIALS[brief.material] || MATERIALS.petg
  const sized = sizeCustomServos(d, mat)
  if (sized && sized.length > 8) {
    d.notes.push(`${sized.length} joints exceeds the IK teleop limit — the machine still poses, sims and exports, but has no reach tour.`)
  }
  const slides = d.joints.filter((j) => j.slide)
  if (slides.length) {
    d.notes.push(`${slides.length} linear axis${slides.length > 1 ? 'es' : ''} (${slides.map((j) => j.label || j.id).join(', ')}) need a drive — leadscrew, belt or rack-and-pinion is your call; the sim tracks position, not motor current.`)
  }

  // ── BOM: what a spec cannot leave out ────────────────────────────────────
  const servoCount = new Map()
  for (const a of d.actuators || []) servoCount.set(a.servo, (servoCount.get(a.servo) || 0) + 1)
  for (const [key, qty] of servoCount) addPart(d, key, qty, 'joint actuator')
  const mcu = PARTS[brief.mcu] ? brief.mcu : 'esp32s3'
  addPart(d, mcu, 1, 'controller')
  addPart(d, brief.battery && PARTS[brief.battery] ? brief.battery : 'lipo2s', 1, 'energy')
  addPart(d, 'fuse', 1, 'rail protection')
  addPart(d, 'wire22', 1, 'signal harness')
  addPart(d, 'jst_kit', 1, 'connectors')
  addPart(d, 'hw_m3', Math.max(1, Math.ceil(d.joints.length / 2)), 'frame fasteners')
  if (d.nodes.some((n) => n.print)) addPart(d, (MATERIALS[brief.material] || MATERIALS.petg).priceId, 1, 'printed structure')

  d.metrics = {
    nodes: d.nodes.length, joints: d.joints.filter((j) => !j.slide).length,
    slides: slides.length, servos: d.actuators ? d.actuators.length : 0,
    spec: true,
  }
  const measured = (d.actuators || []).filter((a) => a.need > 0.005)
  if (measured.length) {
    const worst = measured.reduce((a, b) => (a.need / PARTS[a.servo].torque > b.need / PARTS[b.servo].torque ? a : b))
    d.notes.push(`Servo sizing measured ${measured.length} gravity-loaded joint${measured.length > 1 ? 's' : ''} at the rest pose — worst is ${worst.label} at ${Math.round((worst.need / PARTS[worst.servo].torque) * 100)}% of ${PARTS[worst.servo].name} stall.`)
  }
  return d
}
