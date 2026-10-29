// ── design scratchpad ───────────────────────────────────────────────────────
// Every archetype builds the same shape, so analysis, meshing, rendering and
// export never branch on archetype:
//
//   nodes[]  — geometry (boxes / cylinders) in mm, rest pose, tagged by joint
//   joints[] — serial chain: pivot (rest world), axis, limits, label
//   parts[]  — { key, qty, role } against PARTS
//   notes[]  — design decisions worth showing the user

function newDesign(archetype, brief) {
  return {
    archetype,
    brief,
    title: '',
    subtitle: '',
    nodes: [],
    joints: [],
    metrics: {},
    parts: [],
    notes: [],
    checks: [],
  }
}

function addPart(d, key, qty, role) {
  const found = d.parts.find((p) => p.key === key)
  if (found) {
    found.qty += qty
    // One line item, every job it does: "Wrist pitch · Wrist roll · Gripper".
    if (role && !found.roles.includes(role)) {
      found.roles.push(role)
      found.role = found.roles.join(' · ')
    }
    return
  }
  d.parts.push({ key, qty, role: role || '', roles: role ? [role] : [] })
}

/** Box node. `pos` is the CENTRE. */
function box(d, id, size, pos, mat, extra) {
  d.nodes.push({ id, kind: 'box', size, pos, mat, ...extra })
}

/** Cylinder node, axis is 'x' | 'y' | 'z', `pos` is the CENTRE. */
function cyl(d, id, radius, height, pos, axis, mat, extra) {
  d.nodes.push({ id, kind: 'cyl', radius, height, pos, axis, mat, ...extra })
}

/**
 * A joint. `parent` defaults to the previously declared joint (a serial chain,
 * which is what every limb is); a branching machine — a humanoid — passes it
 * explicitly so the left leg does not inherit the right leg's rotation.
 */
function joint(d, id, label, axis, pivot, min, max, parent) {
  const fallback = d.joints.length ? d.joints[d.joints.length - 1].id : null
  d.joints.push({ id, label, axis, pivot, angle: 0, min, max, parent: parent === undefined ? fallback : parent })
}

/** mm³ of a node, for mass + print estimates. */
function nodeVolume(node) {
  if (node.kind === 'box') return node.size[0] * node.size[1] * node.size[2]
  return Math.PI * node.radius * node.radius * node.height
}

/**
 * Volume of PRINTED material, modelled the way a slicer sees it: a box is a
 * WALL SHELL (2.4mm) with infill, not a solid block. Treating these as solid
 * is how a 400mm rover ends up "weighing" 2.3kg on paper.
 */
const WALL = 2.4

// Lightening holes, cable routes and motor pockets remove roughly a quarter of
// every large plate — modelled as a cap rather than as cutout geometry.
const LIGHTENING = 0.72

function shellVolume(n) {
  const solid = nodeVolume(n)
  if (n.kind === 'box') {
    const [x, y, z] = n.size
    if (Math.min(x, y, z) <= WALL * 2.2) return solid * LIGHTENING
    const surface = 2 * (x * y + y * z + x * z)
    return Math.min(solid * LIGHTENING, surface * WALL)
  }
  const r = n.radius
  if (r <= WALL * 1.6) return solid
  const tube = Math.PI * (r * r - (r - WALL) * (r - WALL)) * n.height
  const caps = 2 * Math.PI * r * r * WALL * LIGHTENING
  return Math.min(solid * LIGHTENING, tube + caps)
}

function printedVolume(nodes) {
  let v = 0
  for (const n of nodes) if (n.print) v += shellVolume(n)
  return v
}
