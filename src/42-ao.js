// ── baked vertex ambient occlusion ─────────────────────────────────────────
// A screen-space AO pass could not be made to work on these meshes (both the
// view-space and the depth-only variants came out uniformly wrong, see PR #1),
// but occlusion does not have to be screen-space: the mesh is only a few
// thousand triangles and it is static per build, so cast the rays once, on the
// CPU, and store the answer per vertex. That is deterministic, testable in
// node, costs nothing per frame, and needs no extra render target.
//
// Model: cosine-weighted hemisphere sampling around the vertex normal, rays
// against a median-split BVH. A vertex inside a crevice sees mostly its own
// neighbours and comes out dark; a vertex on the outside of a box sees sky.

const AO_RAY_COUNT = 8
const AO_CACHE = new WeakMap()

/** Cosine-weighted directions on the +Z hemisphere, deterministic and evenly spread. */
function aoDirections(n) {
  const out = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i += 1) {
    const t = (i + 0.5) / n
    const r = Math.sqrt(t)
    const phi = i * golden
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - t))])
  }
  return out
}
const AO_DIRS = aoDirections(AO_RAY_COUNT)

/** Orthonormal basis around n, so the hemisphere can be rotated to the vertex. */
function basisFor(n) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const t = norm(cross(up, n))
  const b = cross(n, t)
  return [t, b, n]
}

/** Median-split BVH over triangle centroids. Flat arrays, no allocation per ray. */
function buildBVH(tris) {
  const idx = tris.map((_, i) => i)
  const centroid = tris.map((t) => [
    (t.pts[0][0] + t.pts[1][0] + t.pts[2][0]) / 3,
    (t.pts[0][1] + t.pts[1][1] + t.pts[2][1]) / 3,
    (t.pts[0][2] + t.pts[1][2] + t.pts[2][2]) / 3,
  ])
  const nodes = []

  const build = (list, depth) => {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const i of list) {
      for (const p of tris[i].pts) {
        for (let a = 0; a < 3; a += 1) {
          if (p[a] < min[a]) min[a] = p[a]
          if (p[a] > max[a]) max[a] = p[a]
        }
      }
    }
    const node = { min, max, kids: null, tris: null }
    const at = nodes.push(node) - 1
    if (list.length <= 6 || depth > 22) {
      node.tris = list
      return at
    }
    const axis = (max[0] - min[0]) > (max[1] - min[1])
      ? ((max[0] - min[0]) > (max[2] - min[2]) ? 0 : 2)
      : ((max[1] - min[1]) > (max[2] - min[2]) ? 1 : 2)
    list.sort((a, b) => centroid[a][axis] - centroid[b][axis])
    const mid = list.length >> 1
    node.kids = [build(list.slice(0, mid), depth + 1), build(list.slice(mid), depth + 1)]
    return at
  }
  build(idx, 0)
  return { nodes, root: 0 }
}

function rayHitsBox(o, d, min, max) {
  let t0 = 0
  let t1 = Infinity
  for (let a = 0; a < 3; a += 1) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < min[a] || o[a] > max[a]) return false
      continue
    }
    const inv = 1 / d[a]
    let near = (min[a] - o[a]) * inv
    let far = (max[a] - o[a]) * inv
    if (near > far) { const t = near; near = far; far = t }
    if (near > t0) t0 = near
    if (far < t1) t1 = far
    if (t0 > t1) return false
  }
  return true
}

/** Möller–Trumbore, with a small epsilon so a vertex never occludes itself. */
function rayHitsTri(o, d, tri, eps, far) {
  const [a, b, c] = tri.pts
  const e1 = sub(b, a)
  const e2 = sub(c, a)
  const pv = cross(d, e2)
  const det = dot(e1, pv)
  if (Math.abs(det) < 1e-9) return false
  const inv = 1 / det
  const tv = sub(o, a)
  const u = dot(tv, pv) * inv
  if (u < 0 || u > 1) return false
  const qv = cross(tv, e1)
  const v = dot(d, qv) * inv
  if (v < 0 || u + v > 1) return false
  const t = dot(e2, qv) * inv
  // only nearby geometry occludes: a wall 200 mm away is not a crevice, and
  // without this limit every vertex inside the machine reads as fully dark
  return t > eps && t < far
}

/**
 * Per-corner occlusion in 0..1 (1 = fully open). Length = mesh.length * 3, in the
 * same corner order the renderer uploads, so no index remapping is needed.
 */
function bakeVertexAO(mesh, opts) {
  if (!mesh || !mesh.length) return null
  const cached = AO_CACHE.get(mesh)
  if (cached) return cached
  const o = opts || {}
  const strength = o.strength != null ? o.strength : 0.8
  const bias = o.bias != null ? o.bias : 0.35
  const maxDist = o.maxDist != null ? o.maxDist : 7

  const bvh = buildBVH(mesh)

  // weld corners by position, and accumulate a face normal per vertex
  const keyOf = (p) => `${Math.round(p[0] * 2)}|${Math.round(p[1] * 2)}|${Math.round(p[2] * 2)}`
  const verts = new Map()
  const cornerVert = new Array(mesh.length)
  for (let i = 0; i < mesh.length; i += 1) {
    const t = mesh[i]
    const n = norm(cross(sub(t.pts[1], t.pts[0]), sub(t.pts[2], t.pts[0])))
    cornerVert[i] = []
    for (let c = 0; c < 3; c += 1) {
      const p = t.pts[c]
      const k = keyOf(p)
      let v = verts.get(k)
      if (!v) {
        v = { p, n: [0, 0, 0], hits: 0 }
        verts.set(k, v)
      }
      v.n[0] += n[0]; v.n[1] += n[1]; v.n[2] += n[2]
      cornerVert[i][c] = v
    }
  }

  const out = new Float32Array(mesh.length * 3)
  const dirs = AO_DIRS
  const stack = []
  for (const v of verts.values()) {
    const n = norm(v.n)
    const [t1, t2] = basisFor(n)
    const origin = [v.p[0] + n[0] * bias, v.p[1] + n[1] * bias, v.p[2] + n[2] * bias]
    let open = 0
    for (const d0 of dirs) {
      const d = [
        t1[0] * d0[0] + t2[0] * d0[1] + n[0] * d0[2],
        t1[1] * d0[0] + t2[1] * d0[1] + n[1] * d0[2],
        t1[2] * d0[0] + t2[2] * d0[1] + n[2] * d0[2],
      ]
      stack.length = 0
      stack.push(bvh.root)
      let blocked = false
      while (stack.length) {
        const node = bvh.nodes[stack.pop()]
        if (!rayHitsBox(origin, d, node.min, node.max)) continue
        if (node.tris) {
          for (const ti of node.tris) {
            if (rayHitsTri(origin, d, mesh[ti], bias * 0.5, maxDist)) { blocked = true; break }
          }
          if (blocked) break
        } else {
          stack.push(node.kids[0], node.kids[1])
        }
      }
      if (!blocked) open += 1
    }
    // distance falloff is not modelled per ray (cheap), the hemisphere average is
    v.ao = 1 - (1 - open / dirs.length) * strength
  }

  for (let i = 0; i < mesh.length; i += 1) {
    for (let c = 0; c < 3; c += 1) out[i * 3 + c] = cornerVert[i][c].ao != null ? cornerVert[i][c].ao : 1
  }
  AO_CACHE.set(mesh, out)
  return out
}
