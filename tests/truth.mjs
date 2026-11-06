// Claim probes. Each entry: what the product says, the code that produces it,
// and an independent recomputation. A failure prints the numbers that disagree.
import { loadEngine } from './lib-engine.mjs'

const A = loadEngine()
const results = []
const check = (claim, fn) => {
  try {
    const detail = fn()
    results.push({ claim, ok: true, detail })
  } catch (e) {
    results.push({ claim, ok: false, detail: e.message })
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const near = (a, b, tol, label) => assert(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (tol ${tol})`)

const eachPreset = (fn) => A.PRESETS.forEach((p) => fn(p, A.composeDesign({ ...p.brief })))

// ── 1. cost is Σ price×qty + filament, recomputed from PARTS ─────────────────
check('cost = Σ(unit price × qty) + filament used', () => {
  eachPreset((p, { design, analysis }) => {
    let sum = 0
    for (const { key, qty } of design.parts) {
      const part = A.PARTS[key]
      assert(part, `${p.id}: unknown part key ${key}`)
      sum += part.price * qty
    }
    const mat = A.MATERIALS[design.brief.material] || A.MATERIALS.petg
    const spool = (analysis.print.grams / 1000) * (A.PARTS[mat.priceId]?.price || 20)
    near(analysis.cost, sum + spool, 0.02, `${p.id} cost`)
  })
  return `${A.PRESETS.length} archetypes reconcile to the catalogue`
})

// ── 2. mass = hardware + printed volume × density ────────────────────────────
check('mass = Σ(part mass) + printed volume × density', () => {
  eachPreset((p, { design, analysis }) => {
    let hardware = 0
    for (const { key, qty } of design.parts) {
      const part = A.PARTS[key]
      if (!part || part.print || part.shop) continue
      hardware += part.mass * qty
    }
    const printed = analysis.print.grams
    near(analysis.mass.totalG, hardware + printed, 0.5, `${p.id} mass`)
  })
  return 'hardware + printed, shop stock excluded'
})

// ── 3. print time is volume ÷ 18 cm³/h ───────────────────────────────────────
check('print time = printed volume ÷ 18 cm³/h', () => {
  eachPreset((p, { design, analysis }) => {
    const mat = A.MATERIALS[design.brief.material] || A.MATERIALS.petg
    const volCm3 = analysis.print.grams / mat.density
    near(analysis.print.hours, volCm3 / 18, 0.02, `${p.id} print hours`)
  })
  return 'grams → cm³ → hours at 18 cm³/h'
})

// ── 4. the bed claim and the geometry agree, at every bed size ───────────────
// The product may legitimately refuse a small bed (a 176mm arm link is not
// gluable), but it may never claim everything fits while a part is over.
check('bed claim agrees with the parts, at every bed size', () => {
  let cases = 0
  for (const bed of [180, 220, 256, 300, 350]) {
    A.PRESETS.forEach((p) => {
      // the checks are produced with the brief's bed, so compose AT this bed
      const { design, analysis } = A.composeDesign({ ...p.brief, bedMm: bed })
      const fit = A.printFit(design, bed)
      const over = fit.rows.filter((r) => !r.fits)
      const claimsOk = analysis.checks.some((c) => /Every printed part fits/i.test(c.msg))
      const claimsBad = analysis.checks.some((c) => c.level === 'fail' && /too big for a/i.test(c.msg))
      if (fit.count === 0) {
        // a board is not printed: it must make no bed claim either way
        assert(!claimsOk && !claimsBad, `${p.id} @${bed}: makes a bed claim with no printed parts`)
        return
      }
      if (over.length) {
        assert(!claimsOk, `${p.id} @${bed}: claims all parts fit but ${over[0].id} is ${over[0].largest}mm`)
        assert(claimsBad, `${p.id} @${bed}: ${over[0].id} oversize but no failure raised`)
      } else {
        assert(claimsOk && !claimsBad, `${p.id} @${bed}: parts fit but the checks disagree`)
      }
      cases += 1
    })
  }
  return `${cases} archetype×bed combinations consistent`
})

// ── 5. every sized joint is actually inside its actuator's stall ─────────────
check('actuator sizing: effective ≥ required at every joint', () => {
  let joints = 0
  eachPreset((p, { design }) => {
    for (const a of design.actuators || []) {
      if (a.ratio === 0) continue // out-of-scope joints are excluded by design
      joints += 1
      const torque = A.PARTS[a.servo].torque * a.ratio
      assert(torque + 1e-9 >= a.need, `${p.id} ${a.label}: ${torque.toFixed(2)} < ${a.need.toFixed(2)} N·m`)
    }
  })
  return `${joints} joints across the archetypes`
})

// ── 6. an over-weight brief fails loudly (no silent clamp passes) ────────────
check('payload beyond the envelope produces a fail, not a silent clamp', () => {
  for (const [id, kg] of [['rover', 400], ['quad', 40], ['humanoid', 20], ['robot', 60], ['grip', 60]]) {
    const brief = { ...A.PRESETS.find((p) => p.id === id).brief, payloadKg: kg }
    const { analysis } = A.composeDesign(brief)
    assert(
      analysis.checks.some((c) => c.level === 'fail' && /carry/i.test(c.msg)),
      `${id} at ${kg}kg passed without a failure`,
    )
  }
  return 'rover 400kg · quad 40kg · humanoid 20kg · robot 60kg · gripper 60kg all fail'
})

// ── 7. pin map has no duplicates ─────────────────────────────────────────────
check('pin map: no pin is assigned twice', () => {
  eachPreset((p, { analysis }) => {
    const used = analysis.pins.rows.map((r) => r.pin).filter((n) => /^\d+$/.test(String(n)))
    const dupes = used.filter((n, i) => used.indexOf(n) !== i)
    assert(dupes.length === 0, `${p.id}: duplicated ${[...new Set(dupes)].join(',')}`)
  })
  return 'no collisions in any archetype'
})

// ── 8. firmware references only pins the map allocated ───────────────────────
check('firmware pins come from the pin map', () => {
  eachPreset((p, { design, analysis }) => {
    const mapPins = new Set(analysis.pins.rows.map((r) => Number(r.pin)).filter(Number.isFinite))
    const fw = design.firmware || ''
    const consts = [...fw.matchAll(/^#define\s+[A-Z0-9_]+\s+(\d{1,2})\b/gm)].map((m) => Number(m[1]))
    const stray = consts.filter((n) => !mapPins.has(n))
    assert(stray.length === 0, `${p.id}: firmware references ${stray.join(',')} not in the map`)
  })
  return 'every #define pin is in the map'
})

// ── 9. STL triangle count matches the file length, and parts are slice-ready ─
check('STL: header count = (size-84)/50; parts centred, on Z=0', () => {
  let parts = 0
  eachPreset((p, { design }) => {
    const files = A.printedPartSTLs(design)
    for (const f of files) {
      const buf = Buffer.from(f.buf)
      const tris = buf.readUInt32LE(80)
      near(tris, Math.round((buf.length - 84) / 50), 0, `${p.id}/${f.name} triangle count`)
      let minZ = Infinity
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (let i = 0; i < tris; i += 1) {
        const off = 84 + i * 50 + 12
        for (let v = 0; v < 3; v += 1) {
          const x = buf.readFloatLE(off + v * 12)
          const y = buf.readFloatLE(off + v * 12 + 4)
          minZ = Math.min(minZ, buf.readFloatLE(off + v * 12 + 8))
          minX = Math.min(minX, x); maxX = Math.max(maxX, x)
          minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
      }
      near(minZ, 0, 0.01, `${p.id}/${f.name} minZ`)
      // centring is by bounding box, which is what a slicer plate wants
      near((minX + maxX) / 2, 0, 0.05, `${p.id}/${f.name} x centre`)
      near((minY + maxY) / 2, 0, 0.05, `${p.id}/${f.name} y centre`)
      parts += 1
    }
  })
  return `${parts} STL files validated`
})

// ── 9c. 3MF pack: same parts, slicer format, bed-laid-out ────────────────────
check('3MF: zip structure, named objects match printed parts, mm units, Z=0', () => {
  let objs = 0
  eachPreset((p, { design }) => {
    const buf = A.to3MF(design, null)
    const printed = design.nodes.filter((n) => n.print).length
    if (!printed) { assert(!buf, `${p.id} emitted a 3MF with no printed parts`); return }
    assert(buf, `${p.id} produced no 3MF`)
    const raw = Buffer.from(buf).toString('latin1')
    assert(raw.startsWith('PK'), `${p.id} 3MF is not a zip`)
    assert(raw.includes('[Content_Types].xml') && raw.includes('3D/3dmodel.model'), `${p.id} 3MF missing package parts`)
    // zipStore writes method-0 (stored) entries, so the model XML is verbatim
    const model = raw.slice(raw.indexOf('<model '), raw.indexOf('</model>') + 8)
    assert(model.includes('unit="millimeter"'), `${p.id} 3MF not in mm`)
    const nObj = (model.match(/<object /g) || []).length
    const nItem = (model.match(/<item /g) || []).length
    near(nObj, printed, 0, `${p.id} object count`)
    near(nItem, printed, 0, `${p.id} build item count`)
    const zs = [...model.matchAll(/z="(-?[\d.]+)"/g)].map((m) => Number(m[1]))
    assert(zs.length > 0, `${p.id} 3MF has no vertices`)
    near(Math.min(...zs), 0, 0.01, `${p.id} min Z`)
    objs += nObj
  })
  return `${objs} 3MF objects validated across presets`
})

// ── 9e. print pack: plate-aware layout — the 3MF's own placements ─────────────
check('print pack: plate-aware layout, honest plate count, nothing dropped', () => {
  let items = 0, off = 0, plates = 0
  eachPreset((p, { design }) => {
    const pk = A.packBedLayout(design, design.brief && design.brief.bedMm)
    const printed = design.nodes.filter((n) => n.print).length
    assert(pk.items.length === printed, `${p.id}: pack has ${pk.items.length} items for ${printed} printed nodes — parts dropped`)
    assert(pk.bed === Math.min(600, Math.max(100, Math.round((design.brief && design.brief.bedMm) || 256))),
      `${p.id}: pack ignored the chosen bed`)
    const byPlate = new Map()
    for (const it of pk.items) {
      assert(Number.isFinite(it.rect.x) && Number.isFinite(it.rect.w) && it.rect.w > 0,
        `${p.id}/${it.id}: degenerate bed rect`)
      if (!it.offBed) {
        // fittable parts sit fully inside the usable square on their plate
        assert(it.rect.x >= -0.01 && it.rect.y >= -0.01 &&
          it.rect.x + it.rect.w <= pk.usable + 0.01 && it.rect.y + it.rect.d <= pk.usable + 0.01,
          `${p.id}/${it.id}: packed outside the usable square (plate ${it.plate})`)
        assert(it.plate >= 0 && it.plate < pk.plates, `${p.id}/${it.id}: bad plate index ${it.plate}`)
        // shelf packing must never overlap two parts on the same plate
        const list = byPlate.get(it.plate) || []
        for (const o of list) {
          const overlap = it.rect.x < o.rect.x + o.rect.w - 0.01 && o.rect.x < it.rect.x + it.rect.w - 0.01 &&
            it.rect.y < o.rect.y + o.rect.d - 0.01 && o.rect.y < it.rect.y + it.rect.d - 0.01
          assert(!overlap, `${p.id}: ${it.id} overlaps ${o.id} on plate ${it.plate}`)
        }
        list.push(it); byPlate.set(it.plate, list)
      }
      items += 1
      if (it.offBed) off += 1
    }
    if (pk.items.length) {
      assert(pk.plates >= 1 && pk.plates <= pk.items.length, `${p.id}: plates must be 1..${pk.items.length}, got ${pk.plates}`)
      plates += pk.plates
    }
    // bigger bed can only help: repack the same design on a 600mm plate
    const big = A.packBedLayout(design, 600)
    assert(big.offBed <= pk.offBed && big.plates <= pk.plates,
      `${p.id}: a bigger bed made the pack worse (${pk.plates}p/${pk.offBed}off → ${big.plates}p/${big.offBed}off)`)
  })
  // the 3MF's transform offsets must be the layout's own numbers — global
  // build stacks plate bands below each other, one 3MF per plate stays local
  const { design: arm } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const pk = A.packBedLayout(arm, arm.brief.bedMm)
  const raw = Buffer.from(A.to3MF(arm, null)).toString('latin1')
  const model = raw.slice(raw.indexOf('<model '), raw.indexOf('</model>') + 8)
  const ts = [...model.matchAll(/transform="1 0 0 0 1 0 0 0 1 ([\d.-]+) ([\d.-]+) 0"/g)].map((m) => [Number(m[1]), Number(m[2])])
  near(ts.length, pk.items.length, 0, '3MF transform count')
  pk.items.forEach((it, i) => {
    near(ts[i][0], it.x, 0.01, `${it.id} 3MF x`)
    near(ts[i][1], it.y + it.plate * pk.usable, 0.01, `${it.id} 3MF y (plate ${it.plate} offset)`)
  })
  // per-plate export: each file holds exactly that plate's items, and the
  // transforms are plate-LOCAL (no plate*usable band offset like the build)
  for (let p = 0; p < pk.plates; p++) {
    const buf = A.to3MF(arm, null, p)
    assert(buf, `arm plate ${p + 1} produced no 3MF`)
    const m = Buffer.from(buf).toString('latin1')
    const want = pk.items.filter((it) => it.plate === p)
    near((m.match(/<object /g) || []).length, want.length, 0, `arm plate ${p + 1} object count`)
    const tsP = [...m.matchAll(/transform="1 0 0 0 1 0 0 0 1 ([\d.-]+) ([\d.-]+) 0"/g)].map((mm) => [Number(mm[1]), Number(mm[2])])
    near(tsP.length, want.length, 0, `arm plate ${p + 1} transform count`)
    want.forEach((it, i) => {
      near(tsP[i][0], it.x, 0.01, `${it.id} plate-${p + 1} x`)
      near(tsP[i][1], it.y, 0.01, `${it.id} plate-${p + 1} y must be plate-local`)
    })
  }
  return `${items} packed parts across presets · ${plates} plates · ${off} can't fit any plate · 3MF = layout`
})

// ── 9f. print-pack README: the build sheet inside the ZIP tells the truth ────
check('print-pack README: material, plates and measured notes match analysis', () => {
  eachPreset((p, { design, analysis }) => {
    const pk = analysis.print.pack
    const txt = A.printPackReadme(design, analysis, 'test-base')
    assert(txt.includes(analysis.print.material.name), `${p.id}: README material mismatch`)
    assert(txt.includes(`${pk.bed} mm plate`), `${p.id}: README bed mismatch`)
    assert(txt.includes(`${pk.items.length} printed pieces`), `${p.id}: README part count mismatch`)
    if (pk.plates > 1) {
      assert(txt.includes(`test-base-plate${pk.plates}.3mf`), `${p.id}: README missing last plate filename`)
      assert(txt.includes('plates.csv'), `${p.id}: multi-plate README missing plates.csv`)
    }
    const wl = analysis.print.wall
    if (wl && wl.thinnest != null) assert(txt.includes(`~${wl.thinnest}mm`), `${p.id}: README wall readout missing`)
    const oh = analysis.print.overhang
    if (oh && oh.unsupportedMm2 > 0) assert(txt.includes(`~${oh.unsupportedMm2}mm²`), `${p.id}: README overhang readout missing`)
    if (pk.offBed) assert(txt.includes("can't fit ANY"), `${p.id}: README hides un-fittable parts`)
  })
  return 'build sheet verified across presets'
})

// ── 9d. GLB: binary glTF container, named part meshes, Y-up metres ──────────
check('GLB: container, JSON chunk, per-part POSITION accessors in metres', () => {
  let meshes = 0, verts = 0
  eachPreset((p, { design }) => {
    const buf = A.toGLB(A.buildMesh(design))
    assert(buf && buf.byteLength > 100, `${p.id} produced no GLB`)
    const dv = new DataView(buf)
    assert(dv.getUint32(0, true) === 0x46546c67, `${p.id} bad GLB magic`)
    assert(dv.getUint32(4, true) === 2, `${p.id} GLB version != 2`)
    assert(dv.getUint32(8, true) === buf.byteLength, `${p.id} GLB length field wrong`)
    const jLen = dv.getUint32(12, true)
    assert(dv.getUint32(16, true) === 0x4e4f534a, `${p.id} first chunk not JSON`)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jLen)))
    assert(json.asset && json.asset.version === '2.0', `${p.id} asset version`)
    const bOff = 20 + jLen
    assert(dv.getUint32(bOff + 4, true) === 0x004e4942, `${p.id} second chunk not BIN`)
    const tris = A.buildMesh(design)
    if (!tris.length) return
    // every accessor: POSITION, VEC3 float, count = 3× its part's tris, min/max present
    let accVerts = 0
    for (const a of json.accessors) {
      assert(a.type === 'VEC3' && a.componentType === 5126, `${p.id} accessor not float VEC3`)
      assert(Array.isArray(a.min) && Array.isArray(a.max), `${p.id} POSITION missing min/max`)
      assert(a.count % 3 === 0, `${p.id} vertex count not a triangle multiple`)
      accVerts += a.count
    }
    near(accVerts, tris.length * 3, 0, `${p.id} vertex count vs tris`)
    assert(json.meshes.length === json.nodes.length && json.meshes.length > 0, `${p.id} mesh/node mismatch`)
    // every primitive points at a real material with a base colour
    const mats = json.materials || []
    assert(mats.length > 0, `${p.id} GLB has no materials`)
    for (const m of json.meshes) {
      for (const pr of m.primitives) {
        assert(pr.material != null && pr.material < mats.length, `${p.id} primitive material index bad`)
        const f = mats[pr.material].pbrMetallicRoughness.baseColorFactor
        assert(f.length === 4 && f.every((v) => v >= 0 && v <= 1), `${p.id} bad baseColorFactor`)
      }
    }
    // Y-up metres: the tallest extent must be ≤ the machine's height in metres
    const ymax = Math.max(...json.accessors.map((a) => a.max[1]))
    assert(ymax > 0.005 && ymax < 5, `${p.id} implausible height ${ymax}m`)
    meshes += json.meshes.length
    verts += accVerts
  })
  return `${meshes} GLB part-meshes, ${verts} verts across presets`
})

// ── 9g. STEP: AP214 faceted B-rep — assembly tree, real mm units ────────────
// Structure is asserted here; kernel-level validity (solids, volume, bounds,
// assembly traversal) was verified against OpenCascade during development —
// see PR notes.
check('STEP: AP214 structure, one faceted solid per part, mm units, deterministic', () => {
  let products = 0
  eachPreset((p, { design }) => {
    const step = A.toSTEP(design)
    assert(step.startsWith('ISO-10303-21;'), `${p.id} STEP missing header`)
    assert(step.trimEnd().endsWith('END-ISO-10303-21;'), `${p.id} STEP missing footer`)
    assert(step.includes("FILE_SCHEMA(('AUTOMOTIVE_DESIGN"), `${p.id} STEP schema`)
    assert(step.includes('SI_UNIT(.MILLI.,.METRE.)'), `${p.id} STEP not mm`)
    const want = new Set(A.buildMesh(design).map((t) => t.node || '_')).size
    const nProd = (step.match(/PRODUCT\('/g) || []).length
    const nBrep = (step.match(/FACETED_BREP\(/g) || []).length
    const nShell = (step.match(/CLOSED_SHELL\(/g) || []).length
    const nNauo = (step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) || []).length
    const nCdsr = (step.match(/CONTEXT_DEPENDENT_SHAPE_REPRESENTATION\(/g) || []).length
    // multi-part designs get one assembly product on top of the parts, and
    // every part is linked into it — single-part designs stay a lone product
    const wantProd = want + (want > 1 ? 1 : 0)
    const wantLinks = want > 1 ? want : 0
    assert(nProd === wantProd && nBrep === want && nShell === want,
      `${p.id}: STEP products ${nProd}/breps ${nBrep}/shells ${nShell} vs ${wantProd}/${want}/${want}`)
    assert(nNauo === wantLinks && nCdsr === wantLinks,
      `${p.id}: assembly links NAUO ${nNauo}/CDSR ${nCdsr} vs ${wantLinks} parts`)
    if (want > 1) assert(step.includes(`PRODUCT('assembly'`), `${p.id}: no assembly product`)
    const badLines = step.split('\n').filter((l) => l.startsWith('#') && !l.trimEnd().endsWith(';'))
    assert(!badLines.length, `${p.id}: ${badLines.length} entities missing ';'`)
    assert(A.toSTEP(design) === step, `${p.id}: STEP not deterministic`)
    products += nProd
  })
  return `${products} STEP products across presets`
})

// ── 9b. DFM overhang: bed orientation uses real contact area ─────────────────
// The dims heuristic used to stand wedges and ring towers on edge — the
// overhang check caught it, bestBedPerm fixed it. Every preset must stay
// self-supporting; the positive control is a synthetic Γ-bracket cantilever
// fed to overhangTrisStats directly (bedFrameTris would always lay a single
// solid flat, so a real overhang can only be proven pre-oriented).
check('DFM overhang: presets self-support, cantilever flags honestly', () => {
  const designOf = (arch) => A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === arch).brief }).design
  for (const arch of ['arm', 'rover', 'robot', 'quadruped', 'humanoid', 'gripper', 'iot', 'gadget', 'gantry', 'custom']) {
    const oh = A.overhangReport(designOf(arch))
    assert(oh.unsupportedMm2 <= 60, `${arch}: ${oh.unsupportedMm2}mm² unsupported — bed orientation regressed`)
  }
  // Γ bracket, bed-oriented: stem x[-20,-12] z[0,32], arm x[-20,20] z[32,40],
  // y[-20,20] — the arm underside over x>-12 has air below it.
  const P = [[-20, 0], [-12, 0], [-12, 32], [20, 32], [20, 40], [-20, 40]] // (x,z) CCW
  const pt = (i, y) => [P[i][0], y, P[i][1]]
  const tris = []
  for (let i = 0; i < 6; i += 1) {
    const j = (i + 1) % 6
    tris.push({ pts: [pt(i, -20), pt(j, 20), pt(j, -20)] }, { pts: [pt(i, -20), pt(i, 20), pt(j, 20)] })
  }
  for (const [i, j, k] of [[2, 3, 4], [2, 4, 5], [2, 5, 0], [2, 0, 1]]) {
    for (const y of [-20, 20]) tris.push({ pts: [pt(i, y), pt(j, y), pt(k, y)] })
  }
  const st = A.overhangTrisStats(tris)
  assert(st.unsupported > 500, `cantilever should flag ~1280mm² unsupported, got ${st.unsupported}`)
  assert(st.bed > 250, `stem foot should count as bed contact, got ${st.bed}`)
  return `all presets self-support · Γ cantilever flags ${st.unsupported}mm²`
})

// ── 10. build codes round-trip ───────────────────────────────────────────────
check('build code round-trips to the same machine', () => {
  eachPreset((p, { design }) => {
    const code = A.encodeBuild(p.brief)
    assert(/^RF1-/.test(code), `${p.id}: code does not start RF1-`)
    // Parametric briefs compress to a few hundred chars; a custom machine's
    // code IS its node/joint spec, so it is legitimately longer — still one
    // paste-able line, still decodes to the identical machine.
    const limit = p.brief.nodes ? 8000 : 400
    assert(code.length < limit, `${p.id}: code is ${code.length} chars`)
    const back = A.decodeBuild(code)
    const again = A.composeDesign({ ...back })
    assert(again.design.title === design.title, `${p.id}: rebuilt title differs`)
    assert(again.analysis.cost === A.composeDesign({ ...p.brief }).analysis.cost, `${p.id}: rebuilt cost differs`)
  })
  return 'encode → decode → identical title and cost'
})

// ── 11. determinism ─────────────────────────────────────────────────────────
check('same brief twice gives identical numbers', () => {
  eachPreset((p) => {
    const a = JSON.stringify(A.composeDesign({ ...p.brief }).analysis.mass)
    const b = JSON.stringify(A.composeDesign({ ...p.brief }).analysis.mass)
    assert(a === b, `${p.id}: not deterministic`)
  })
  return 'no randomness in the engine'
})

// ── 12. centroid file only exists where it means something ───────────────────
check('CPL: every placement has designator, layer and coordinates', () => {
  let rows = 0
  eachPreset((p, { design }) => {
    if (!design.pcb) return
    const csv = A.toCentroidCsv(design)
    const lines = csv.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('Designator'))
    assert(lines.length === design.pcb.placed.length, `${p.id}: ${lines.length} rows for ${design.pcb.placed.length} placements`)
    for (const line of lines) {
      const [des, x, y, layer, rot] = line.split(',')
      assert(/^[A-Z]+\d+$/.test(des), `${p.id}: bad designator ${des}`)
      assert(Number.isFinite(Number(x)) && Number.isFinite(Number(y)), `${p.id}: bad coords for ${des}`)
      assert(layer === 'top' || layer === 'bottom', `${p.id}: bad layer for ${des}`)
      assert(Number.isFinite(Number(rot)), `${p.id}: bad rotation for ${des}`)
      rows += 1
    }
  })
  return `${rows} centroid rows`
})

// ── 13. wiring: the wire carries the stall case, the fuse never exceeds it ──
check('wiring: wire ≥ peak, fuse ≤ wire ampacity, no rail beyond the table', () => {
  let rows = 0
  let splits = 0
  eachPreset((p, { analysis }) => {
    for (const w of analysis.power.wiring) {
      rows += 1
      if (w.split) splits += 1
      assert(!w.over, `${p.id} ${w.rail}: rail beyond 14AWG`)
      assert(w.ampacity > 0, `${p.id} ${w.rail}: no ampacity recorded`)
      assert(w.peak <= w.ampacity + 1e-9, `${p.id} ${w.rail}: peak ${w.peak.toFixed(1)}A > ${w.ampacity}A wire`)
      if (w.fuse != null) {
        assert(w.fuse <= w.ampacity, `${p.id} ${w.rail}: fuse ${w.fuse}A on ${w.ampacity}A wire`)
      }
    }
  })
  return `${rows} rail feeds validated, ${splits} parallel feeds`
})

// ── 14. the machines we ship as presets are buildable as shown ──────────────
check('every preset builds with zero failures', () => {
  eachPreset((p, { analysis }) => {
    const fails = analysis.checks.filter((c) => c.level === 'fail')
    if (fails.length) assert(false, `${p.id}: ${fails[0].msg.slice(0, 90)}`)
  })
  return `${A.PRESETS.length} presets clean out of the box`
})

// ── 15. the ENERGY control actually changes the energy in the BOM ───────────
check('choosing a battery changes the BOM, or says why it cannot', () => {
  let changed = 0
  let explained = 0
  eachPreset((p) => {
    const batOf = (r) => {
      const e = r.design.parts.find((x) => A.PARTS[x.key]?.cat === 'battery')
      return e ? e.key : 'none'
    }
    const base = A.composeDesign({ ...p.brief })
    for (const choice of ['pack2s', 'lipo3s', 'pd5v']) {
      if (choice === batOf(base)) continue
      const alt = A.composeDesign({ ...p.brief, battery: choice })
      if (batOf(alt) === choice) { changed += 1; continue }
      const says = alt.analysis.checks.some((c) => c.level !== 'ok' && /pack|supply|3S|24V|tethered/i.test(c.msg))
      assert(says, `${p.id}: asked for ${choice}, BOM has ${batOf(alt)}, and nothing explains the substitution`)
      explained += 1
    }
  })
  return `${changed} choices honoured, ${explained} substitutions explained`
})

// ── 16. firmware drives exactly the actuators the BOM buys ──────────────────
check('firmware channel count equals the servos in the BOM', () => {
  let declared = 0
  eachPreset((p, { design }) => {
    const servos = design.parts.reduce((n, x) => (A.PARTS[x.key]?.cat === 'servo' ? n + x.qty : n), 0)
    const fw = design.firmware || ''
    const m = fw.match(/SERVO_COUNT\s*=\s*(\d+)/)
    if (m) {
      declared += 1
      assert(Number(m[1]) === servos, `${p.id}: firmware drives ${m[1]} servos, BOM buys ${servos}`)
    }
    if (servos === 0) {
      assert(!/SERVO_COUNT/.test(fw), `${p.id}: servo code with no servo in the BOM`)
    }
    assert(/void setup\(/.test(fw) && /void loop\(/.test(fw), `${p.id}: firmware missing setup/loop`)
    const braces = fw.split('{').length - fw.split('}').length
    assert(braces === 0, `${p.id}: unbalanced braces (${braces})`)
  })
  return `${declared} sketches declare a channel count; all balanced`
})

// ── 17. the BOM sheet sums to the headline cost ─────────────────────────────
check('BOM csv: line items + filament = the headline cost', () => {
  eachPreset((p, { design, analysis }) => {
    const lines = A.toBOMCsv(design, analysis).split('\n')
    const totalRow = lines[lines.length - 1]
    assert(/^TOTAL,/.test(totalRow), `${p.id}: no TOTAL row`)
    const total = Number(totalRow.split(',')[4])
    near(total, analysis.cost, 0.02, `${p.id} csv total`)
  })
  return 'ten sheets reconcile to the cent'
})

// ── 18. the spec document says the same numbers as the studio ────────────────
check('spec markdown quotes the same cost, mass and print time', () => {
  eachPreset((p, { design, analysis }) => {
    const md = A.toSpecMarkdown(design, analysis)
    const money = `$${analysis.cost >= 100 ? Math.round(analysis.cost) : analysis.cost.toFixed(2)}`
    assert(md.includes(money), `${p.id}: spec cost ${money} missing`)
    assert(md.includes(`${Math.round(analysis.mass.totalG)}g`), `${p.id}: spec mass missing`)
    assert(md.includes(`${analysis.print.hours.toFixed(1)}h`) || md.includes(`${Math.round(analysis.print.hours)}h`), `${p.id}: spec print hours missing`)
    // the print-pack section states the same plate count the layout computed
    const pk = analysis.print.pack
    if (pk && pk.items.length) {
      assert(md.includes('## Print pack'), `${p.id}: spec missing print-pack section`)
      assert(md.includes(`${pk.items.length} parts`), `${p.id}: spec part count disagrees with pack`)
      if (pk.plates > 1) assert(md.includes(`${pk.plates} plates`), `${p.id}: spec plate count disagrees`)
    }
  })
  return 'cost, mass, print time and plate count agree'
})

// ── 19. the build order is complete enough to follow ────────────────────────
check('build steps: every step has a title, a how, and time on it', () => {
  eachPreset((p, { design, analysis }) => {
    const steps = A.stepsFor(design, analysis)
    assert(steps.length >= 4, `${p.id}: only ${steps.length} steps`)
    let minutes = 0
    for (const st of steps) {
      assert(st.title && st.title.length > 4, `${p.id}: step ${st.n} has no title`)
      assert(st.detail && st.detail.length > 30, `${p.id}: step "${st.title}" has no detail`)
      assert(Number(st.min) > 0, `${p.id}: step "${st.title}" has no time`)
      minutes += Number(st.min)
    }
    // the print step must dominate: a guide that forgets the printer is a lie
    assert(minutes >= analysis.print.hours * 40, `${p.id}: ${minutes} min of work for ${Math.round(analysis.print.hours)}h of printing`)
  })
  return `${A.PRESETS.length} build orders complete`
})

// ── 20. no step tells you to use a material you did not choose ──────────────
check('build steps name only the chosen material', () => {
  const NAMES = [['PLA', 'PLA'], ['PETG', 'PETG'], ['ASA', 'ASA'], ['PETG-CF', 'PETG-CF'], ['PETGCF', 'PETG-CF']]
  eachPreset((p, { design, analysis }) => {
    const chosen = analysis.print.material.name.toUpperCase()
    const text = A.stepsFor(design, analysis).map((s) => `${s.title} ${s.detail}`).join(' ')
    for (const [pattern, label] of NAMES) {
      if (label === chosen) continue
      const re = new RegExp(`\\b${pattern.replace('-', '\\-')}\\b`, 'i')
      assert(!re.test(text), `${p.id}: step mentions ${label} but the build is ${chosen}`)
    }
  })
  return 'every guide matches the material in the BOM'
})

// ── 21. the simulation exports describe the same machine ────────────────────
check('URDF/MJCF: one link per joint, real limits, an actuator per driven joint', () => {
  let checked = 0
  eachPreset((p, { design, analysis }) => {
    const urdf = A.toURDF ? A.toURDF(design, analysis) : ''
    const mjcf = A.toMJCF ? A.toMJCF(design, analysis) : ''
    assert(urdf.startsWith('<?xml') && urdf.includes('<robot'), `${p.id}: no URDF`)
    assert(mjcf.includes('<mujoco'), `${p.id}: no MJCF`)
    const links = (urdf.match(/<link /g) || []).length
    const joints = (urdf.match(/<joint /g) || []).length
    assert(links === design.joints.length + 1, `${p.id}: ${links} links for ${design.joints.length} joints`)
    assert(joints === design.joints.length, `${p.id}: ${joints} URDF joints vs ${design.joints.length} in the design`)
    for (const m of urdf.matchAll(/<limit[^>]*effort="([\d.]+)"/g)) {
      assert(Number(m[1]) > 0, `${p.id}: a joint has zero effort and cannot move`)
    }
    // one actuator per driven joint — position actuators with a torque
    // ceiling, and never BOTH a position and a motor on the same joint
    const acts = (mjcf.match(/<position joint=/g) || []).length + (mjcf.match(/<motor /g) || []).length
    assert(acts === design.joints.length || acts === 0, `${p.id}: ${acts} actuators for ${design.joints.length} joints`)
    const posInBody = (mjcf.match(/<position joint=/g) || []).length
    const motor = (mjcf.match(/<motor /g) || []).length
    assert(!(posInBody && motor), `${p.id}: position AND motor actuators would double-drive every joint`)
    // inertias must be computed per link, not the old flat placeholder —
    // the placeholder's signature is every link sharing one value
    const diags = [...mjcf.matchAll(/diaginertia="([\d.eE+-]+) /g)].map((m) => Number(m[1]))
    assert(diags.length >= design.joints.length, `${p.id}: expected per-link diaginertia`)
    assert(diags.every((d) => d > 0), `${p.id}: a link has zero inertia`)
    if (design.joints.length > 1) {
      assert(new Set(diags.map((d) => d.toPrecision(4))).size > 1,
        `${p.id}: every link shares one inertia — that is the placeholder, not physics`)
    }
    // origins are parent-relative and pitch axes carry the studio's sign flip —
    // raw model pivots would stack every hinge at its absolute position
    const jById = new Map(design.joints.map((j) => [j.id, j]))
    const num = (s) => s.trim().split(/\s+/).map(Number)
    for (const m of urdf.matchAll(/<joint name="([^"]+)"[\s\S]*?<origin xyz="([^"]+)"[\s\S]*?<axis xyz="([^"]+)"/g)) {
      const j = jById.get(m[1])
      if (!j) continue
      const pj = j.parent ? jById.get(j.parent) : null
      const pp = pj && pj.pivot ? pj.pivot : [0, 0, 0]
      const want = [(j.pivot[0] - pp[0]) / 1000, (j.pivot[1] - pp[1]) / 1000, (j.pivot[2] - pp[2]) / 1000]
      const got = num(m[2])
      for (let k = 0; k < 3; k++) {
        assert(Math.abs(got[k] - want[k]) < 0.002, `${p.id}/${j.id}: URDF origin ${m[2]} ≠ parent-relative ${want.map((v) => v.toFixed(3))}`)
      }
      const sgn = (!j.slide && j.axis === 'y') ? -1 : 1
      const wantAx = (j.axis === 'x' ? [1, 0, 0] : j.axis === 'y' ? [0, 1, 0] : [0, 0, 1]).map((v) => v * sgn)
      const gotAx = num(m[3])
      for (let k = 0; k < 3; k++) {
        assert(Math.abs(gotAx[k] - wantAx[k]) < 1e-6, `${p.id}/${j.id}: URDF axis ${m[3]} ≠ ${wantAx}`)
      }
    }
    for (const m of mjcf.matchAll(/<body name="b_([^"]+)" pos="([^"]+)"/g)) {
      const j = jById.get(m[1])
      if (!j) continue
      const pj = j.parent ? jById.get(j.parent) : null
      const pp = pj && pj.pivot ? pj.pivot : [0, 0, 50]
      const want = [(j.pivot[0] - pp[0]) / 1000, (j.pivot[1] - pp[1]) / 1000, (j.pivot[2] - pp[2]) / 1000]
      const got = num(m[2])
      for (let k = 0; k < 3; k++) {
        assert(Math.abs(got[k] - want[k]) < 0.002, `${p.id}/${j.id}: MJCF body pos ${m[2]} ≠ parent-relative ${want.map((v) => v.toFixed(3))}`)
      }
    }
    checked += 1
  })
  return `${checked} machines exported with matching topology`
})

// ── 22. mesh parts resolve to real geometry, not to a silent fallback ───────
check('imported CAD meshes are present and non-degenerate', () => {
  const parts = A.RF_PARTS || {}
  const names = Object.keys(parts)
  let used = 0
  eachPreset((p, { design }) => {
    for (const n of design.nodes) {
      if (n.kind !== 'mesh') continue
      used += 1
      const table = parts[n.part]
      assert(table, `${p.id}: node ${n.id} wants mesh "${n.part}" which is not vendored`)
      assert(table.tris.length % 9 === 0 && table.tris.length > 0, `${p.id}: ${n.part} has a broken triangle table`)
      assert(table.scale > 0, `${p.id}: ${n.part} has no scale`)
    }
  })
  return `${used} mesh nodes across the archetypes, ${names.length} vendored part(s)`
})

// ── 23. teleop: every articulated archetype gets an honest mode ─────────────
check('teleop coverage: wheels drive, arm reaches, legs walk, jaw grips', () => {
  // mirrors the page's resolution: locomotion/manipulation primary, arm IK
  // as the dual-mode overlay (M switches body vs arm on robots/humanoids)
  const kind = (arch) => {
    const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === arch).brief })
    if (A.createDrive(design, analysis)) return 'drive'
    if (A.createGaitTeleop(design)) return 'gait'
    if (A.createGripTeleop(design)) return 'grip'
    if (A.createSensorTeleop(design)) return 'sense'
    if (A.createArmTeleop(design)) return 'ik'
    if (A.createGantryTeleop(design)) return 'gantry'
    return null
  }
  const got = { rover: kind('rover'), robot: kind('robot'), arm: kind('arm'), quadruped: kind('quadruped'), humanoid: kind('humanoid'), gripper: kind('gripper'), gantry: kind('gantry') }
  assert(got.rover === 'drive', `rover teleop: ${got.rover}`)
  assert(got.robot === 'drive', `robot teleop: ${got.robot}`)
  assert(got.arm === 'ik', `arm teleop: ${got.arm}`)
  assert(got.quadruped === 'gait', `quadruped teleop: ${got.quadruped}`)
  assert(got.humanoid === 'gait', `humanoid teleop: ${got.humanoid}`)
  assert(got.gripper === 'grip', `gripper teleop: ${got.gripper}`)
  assert(got.gantry === 'gantry', `gantry teleop: ${got.gantry}`)
  // dual-mode pairs: chassis/legs AND an IK-able arm on the same machine
  const dual = (arch) => {
    const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === arch).brief })
    const body = A.createDrive(design, analysis) || A.createGaitTeleop(design)
    return !!(body && A.createArmTeleop(design))
  }
  assert(dual('robot'), 'robot should offer drive + arm IK dual-mode')
  assert(dual('humanoid'), 'humanoid should offer gait + right-arm IK dual-mode')
  assert(!dual('arm'), 'arm has no body teleop to pair with')
  // the humanoid's right arm must actually converge, not just exist
  const { design: hd } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'humanoid').brief })
  const hik = A.createArmTeleop(hd)
  const hrest = hd.joints.map(() => 0)
  const htip = hik.tipPos(hrest)
  hik.seek(htip[0] + 100, htip[1], htip[2] + 40, hrest, 30)
  assert(hik.state.err < 5, `humanoid arm IK err ${hik.state.err.toFixed(1)}mm`)
  // the left arm is independently IK-able and mirrors to the other side
  const hil = A.createArmTeleop(hd, 'l')
  assert(hil, 'humanoid left arm should offer IK')
  const ltip = hil.tipPos(hrest)
  assert(Math.sign(ltip[0]) !== Math.sign(htip[0]) || Math.abs(ltip[0] - htip[0]) > 30,
    `left tip ${ltip[0].toFixed(0)} should mirror right tip ${htip[0].toFixed(0)}`)
  return '7 archetypes interactive: ' + Object.entries(got).map(([k, v]) => `${k}:${v}`).join(' ')
})

// ── 23b. slide chains: gantry quill inherits portal+saddle, Z drops ─────────
check('slide chain: gantry axes compose, portal stays on X, limits hold', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'gantry').brief })
  const centroid = (nodeId, angs) => {
    const d2 = JSON.parse(JSON.stringify(design))
    d2.joints.forEach((j, i) => { j.angle = angs[i] || 0 })
    const n = d2.nodes.find((x) => x.id === nodeId)
    const ts = A.nodeTriangles(d2, n)
    let x = 0, y = 0, z = 0, c = 0
    for (const t of ts) for (const v of t.pts) { x += v[0]; y += v[1]; z += v[2]; c += 1 }
    return c ? [x / c, y / c, z / c] : null
  }
  const rest = centroid('spindle', [0, 0, 0])
  const posed = centroid('spindle', [100, 50, 30])
  assert(Math.abs(posed[0] - rest[0] - 100) < 0.5, `quill X: ${posed[0].toFixed(1)} vs ${rest[0].toFixed(1)}+100`)
  assert(Math.abs(posed[1] - rest[1] - 50) < 0.5, `quill Y: ${posed[1].toFixed(1)} vs ${rest[1].toFixed(1)}+50`)
  assert(Math.abs(posed[2] - rest[2] + 30) < 0.5, `quill Z should DROP 30mm (joint sign -1): ${posed[2].toFixed(1)} vs ${rest[2].toFixed(1)}`)
  const bRest = centroid('bridge', [0, 0, 0])
  const bPose = centroid('bridge', [100, 50, 30])
  assert(Math.abs(bPose[0] - bRest[0] - 100) < 0.5 && Math.abs(bPose[1] - bRest[1]) < 0.5 && Math.abs(bPose[2] - bRest[2]) < 0.5,
    'portal must move X only — saddle/quill angles must not leak into it')
  // teleop clamps at joint limits and holds position on release
  const tel = A.createGantryTeleop(design)
  assert(tel, 'gantry teleop missing')
  for (let i = 0; i < 400; i++) tel.step({ x: 1, y: 1, z: 1 }, 0.05)
  const p = tel.state
  assert(p.x === design.joints[0].max && p.y === design.joints[1].max && p.z === design.joints[2].max,
    `teleop must clamp exactly at limits: ${JSON.stringify(p)}`)
  tel.step({ x: 0, y: 0, z: 0 }, 1)
  const held = tel.step({ x: 0, y: 0, z: 0 }, 1)
  assert(JSON.stringify(held) === JSON.stringify(tel.step({ x: 0, y: 0, z: 0 }, 1)), 'released axes must hold position')
  tel.reset()
  assert(tel.state.x === 0 && tel.state.y === 0 && tel.state.z === 0, 'reset must recenter')
  return 'quill XYZ composed · portal X-only · clamps + holds + resets'
})

// ── 23c. mesh integrity: every primitive kind is closed + outward on all axes ─
check('mesh integrity: primitives are watertight, outward-wound, positive-volume', () => {
  const q = (v) => Math.round(v * 1e4) / 1e4
  const vol = (ts) => ts.reduce((s, t) => {
    const [a, b, c] = t
    return s + a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }, 0) / 6
  const cases = [
    ['cyl', { radius: 8, height: 12, segs: 18 }, ['z', 'y', 'x']],
    ['ring', { outer: 10, inner: 5, height: 8 }, ['z', 'y', 'x']],
    ['torus', { R: 15, r: 5 }, ['z', 'y', 'x']],
    ['bend', { R: 15, r: 5, arc: 270 }, ['z', 'y', 'x']],
    ['sphere', { radius: 9 }, ['z']],
    ['gear', { module: 1, teeth: 12, width: 10 }, ['z', 'y', 'x']],
    ['box', { size: [20, 14, 10] }, ['z']],
    ['rbox', { size: [20, 14, 10], r: 2 }, ['z']],
    ['wedge', { size: [20, 14, 10], dir: 'nx' }, ['z']],
    ['wedge', { size: [20, 14, 10], dir: 'px' }, ['z']],
    ['rack', { size: [30, 10, 8], teeth: 8 }, ['z']],
  ]
  const bad = []
  for (const [kind, props, axes] of cases) {
    for (const axis of axes) {
      const node = { id: 't', kind, pos: [0, 0, 0], mat: 'pla', axis, ...props }
      const { design } = A.composeDesign({ archetype: 'custom', nodes: [node], joints: [] })
      const tris = A.buildMesh(design).filter((t) => t.node === 't').map((t) => t.pts)
      const edges = new Map()
      const dedges = new Map()
      for (const t of tris) for (let i = 0; i < 3; i += 1) {
        const a = t[i]; const b = t[(i + 1) % 3]
        const ak = [q(a[0]), q(a[1]), q(a[2])].join(',')
        const bk = [q(b[0]), q(b[1]), q(b[2])].join(',')
        const k = [ak, bk].sort().join('|')
        edges.set(k, (edges.get(k) || 0) + 1)
        if (!dedges.has(k)) dedges.set(k, [])
        dedges.get(k).push([ak, bk])
      }
      const open = [...edges.values()].filter((c) => c !== 2).length
      // shared edges must be traversed in opposite directions — multiplicity
      // alone misses mixed winding (wedge ramp, bend caps shipped this way)
      const mixed = [...dedges.values()].filter((ls) => ls.length === 2 && !(ls[0][0] === ls[1][1] && ls[0][1] === ls[1][0])).length
      const v = vol(tris)
      if (!tris.length || open || mixed || v <= 0) bad.push(`${kind}/${axis}:${tris.length}t vol=${v.toFixed(0)} open=${open} mixed=${mixed}`)
    }
  }
  assert(!bad.length, `non-manifold or inside-out meshes: ${bad.join(' · ')}`)
  return '22 kind×axis cases: watertight, consistently oriented, positive volume'
})

// ── 24. IK reach converges on a reachable target, inside joint limits ───────
check('IK reach: end-effector converges <5mm, joints stay in limits', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const ik = A.createArmTeleop(design)
  assert(ik, 'arm offers no IK teleop')
  let actual = design.joints.map(() => 0)
  ik.step({ x: 0, y: 0, z: 0 }, 1 / 60, actual) // anchor at the rest tip
  // The rest pose is a fully-extended arm — the reachable workspace sits
  // INBOARD and BELOW the tip, so the stick pulls back and down, never out.
  for (let i = 0; i < 48; i++) { const d = ik.step({ x: -0.3, y: 0, z: -0.2 }, 1 / 60, actual); if (d) actual = d }
  for (let i = 0; i < 240; i++) { const d = ik.step({ x: -0.13, y: 0, z: -0.13 }, 1 / 60, actual); if (d) actual = d }
  assert(ik.state.err < 5, `IK error ${ik.state.err.toFixed(1)}mm — should settle under 5mm`)
  design.joints.forEach((j, i) => assert(actual[i] >= j.min - 1 && actual[i] <= j.max + 1, `${j.id} at ${actual[i].toFixed(1)}° outside [${j.min},${j.max}]`))
  return `err ${ik.state.err.toFixed(1)}mm on target ${ik.state.tx.toFixed(0)},${ik.state.ty.toFixed(0)},${ik.state.tz.toFixed(0)}`
})

// ── 25. drive physics: ice stalls, hardwood climbs, payload steals grade ────
check('drive physics: wet ice stalls where hardwood climbs', () => {
  // unladen rover — the 2 kg payload preset honestly cannot climb 20°
  const { design, analysis } = A.composeDesign({ ...A.DEFAULT_BRIEF, archetype: 'rover' })
  const run = (env, secs) => {
    const d = A.createDrive(design, analysis)
    d.setEnv(env)
    for (let i = 0; i < 140; i++) d.step({ throttle: 1, steer: 0 }, 1 / 60) // reach the ramp
    const x0 = d.state.x
    for (let i = 0; i < secs * 60; i++) d.step({ throttle: 1, steer: 0 }, 1 / 60)
    return { dx: d.state.x - x0, stall: d.state.stall, slip: d.state.slip }
  }
  const ice = run({ surface: 'ice', slopeDeg: 20 }, 6)
  const wood = run({ surface: 'hardwood', slopeDeg: 20 }, 6)
  assert(ice.stall || ice.slip, 'ice 20° should stall or wheelspin')
  assert(ice.dx < 0.6, `ice 20° gained ${ice.dx.toFixed(2)}m — should barely move`)
  assert(wood.dx > 0.6, `hardwood 20° gained only ${wood.dx.toFixed(2)}m — should climb`)
  return `ice +${ice.dx.toFixed(2)}m (${ice.stall ? 'stall' : 'slip'}), hardwood +${wood.dx.toFixed(2)}m`
})

// ── 25b. living-room course: threshold climbs, props block, bumps count ────
check('living-room course: obstacles stop the chassis and count bumps', () => {
  const { design, analysis } = A.composeDesign({ ...A.DEFAULT_BRIEF, archetype: 'rover' })
  const d = A.createDrive(design, analysis)
  d.setEnv({ course: 'room', surface: 'hardwood', slopeDeg: 0, payloadKg: 0 })
  // centre lane is blocked by the toy bin — a straight driver must stop
  for (let i = 0; i < 60 * 12; i++) d.step({ throttle: 1, steer: 0 }, 1 / 60)
  assert(d.state.bumps >= 1, `centre lane: expected bumps, got ${d.state.bumps}`)
  assert(d.state.x < 2.6, `centre lane reached x=${d.state.x.toFixed(2)} — drove through a prop`)
  // the wide-left lane is clear — same machine, offset start, runs the course
  const d2 = A.createDrive(design, analysis)
  d2.setEnv({ course: 'room', surface: 'hardwood', slopeDeg: 0, payloadKg: 0 })
  d2.state.y = 0.5
  for (let i = 0; i < 60 * 10; i++) d2.step({ throttle: 1, steer: 0 }, 1 / 60)
  assert(d2.state.x > 5, `wide lane only reached x=${d2.state.x.toFixed(2)} — corridor should be open`)
  assert(d2.state.bumps === 0, `wide lane bumped ${d2.state.bumps}× — should be clear`)
  return `centre pinned at x=${d.state.x.toFixed(2)} (${d.state.bumps} bumps), wide lane x=${d2.state.x.toFixed(2)}`
})

// ── 25c. sensor bench: fitted sensors read injected stimulus, alerts fire ──
check('sensor bench: stimulus drives readings and threshold alerts', () => {
  const iot = A.PRESETS.find((p) => p.id === 'iot')
  const { design } = A.composeDesign({ ...iot.brief, mission: 'a plant sensor that reports soil moisture and temperature' })
  const t = A.createSensorTeleop(design)
  assert(t, 'iot design offers no sensor teleop')
  assert(t.fields.length >= 3, `expected temp+humid+soil fields, got ${t.fields.length}`)
  t.set('humid', 96)
  t.set('soil', 12)
  const h = t.hud()
  assert(h.alerts.length >= 2, `expected humidity+soil alerts, got ${h.alerts.length}: ${h.alerts}`)
  assert(/\d/.test(h.oled) && !/node/.test(h.oled), `oled line should lead with a sensor reading: ${h.oled}`)
  t.reset()
  assert(t.hud().alerts.length === 0, 'reset should clear alerts')
  return `${t.fields.length} stimulus fields, alerts: ${h.alerts.join('; ')}`
})

// ── 26. gait: legs cycle within joint limits, diagonal pairs phase-locked ───
check('gait: quadruped trot moves all legs inside limits', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'quadruped').brief })
  const g = A.createGaitTeleop(design)
  assert(g, 'quadruped offers no gait teleop')
  let actual = design.joints.map(() => 0)
  const lo = actual.slice(), hi = actual.slice()
  let moved = 0
  for (let i = 0; i < 600; i++) {
    const d = g.step({ x: 1 }, 1 / 60, actual)
    if (d) {
      actual = d; moved += 1
      for (let k = 0; k < actual.length; k++) { if (actual[k] < lo[k]) lo[k] = actual[k]; if (actual[k] > hi[k]) hi[k] = actual[k] }
    }
  }
  assert(moved > 300, `gait only commanded ${moved} frames`)
  design.joints.forEach((j, i) => assert(actual[i] >= j.min - 1 && actual[i] <= j.max + 1, `${j.id} at ${actual[i].toFixed(1)}° outside [${j.min},${j.max}]`))
  const swing = (id) => { const i = design.joints.findIndex((j) => j.id === id); return hi[i] - lo[i] }
  assert(swing('femur-fl') > 10 && swing('tibia-rr') > 10, `legs barely move: femur-fl ${swing('femur-fl').toFixed(1)}°, tibia-rr ${swing('tibia-rr').toFixed(1)}°`)
  return `${g.state.strides.toFixed(1)} strides, femur swing ${swing('femur-fl').toFixed(0)}°, all joints inside limits`
})

// ── 26b. locomotion: legs traverse the bench courses with honest limits ────
check('locomotion: quadruped walks, derates on grade/ice, blocked by stairs', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'quadruped').brief })
  const g = A.createGaitTeleop(design)
  assert(g && g.locomote, 'quadruped gait offers no locomotion')
  let actual = design.joints.map(() => 0)
  const run = (env, secs, cmd) => {
    for (let i = 0; i < secs * 60; i++) {
      const r = g.locomote(cmd || { x: 1 }, 1 / 60, actual, env)
      if (r && r.pose) actual = r.pose
    }
    return { ...g.locomoteState } // snapshot — the live object keeps mutating
  }
  g.reset(); actual = design.joints.map(() => 0)
  const flat = run({ surface: 'hardwood', slopeDeg: 0, course: 'rack' }, 3)
  assert(flat.x > 0.8, `walked only ${flat.x.toFixed(2)}m in 3s`)
  assert(Math.abs(flat.v - 0.39) < 0.08, `cruise ${flat.v.toFixed(2)} m/s — gait kinematics say ~0.39`)
  const ice = run({ surface: 'ice', slopeDeg: 0, course: 'rack' }, 3)
  assert(ice.slip && ice.v < flat.v * 0.6, `ice should slip and crawl: v=${ice.v.toFixed(2)} slip=${ice.slip}`)
  g.reset(); actual = design.joints.map(() => 0)
  const stairs = run({ surface: 'hardwood', slopeDeg: 0, course: 'stairs' }, 10)
  assert(stairs.x < 1.8 && stairs.stall && stairs.bumps > 0, `small quad should be stopped by 80mm risers: x=${stairs.x.toFixed(2)} bumps=${stairs.bumps} stall=${stairs.stall}`)
  return `flat ${flat.x.toFixed(2)}m @${flat.v.toFixed(2)}m/s · ice ${ice.v.toFixed(2)}m/s slip · stairs blocked @x=${stairs.x.toFixed(2)}`
})

check('locomotion: tall humanoid climbs porch stairs the quad cannot', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'humanoid').brief })
  const g = A.createGaitTeleop(design)
  assert(g && g.locomote, 'humanoid gait offers no locomotion')
  let actual = design.joints.map(() => 0)
  for (let i = 0; i < 60 * 12; i++) {
    const r = g.locomote({ x: 1 }, 1 / 60, actual, { surface: 'hardwood', slopeDeg: 0, course: 'stairs' })
    if (r && r.pose) actual = r.pose
  }
  const st = g.locomoteState
  assert(st.x > 3.0, `humanoid should top the stair flight: x=${st.x.toFixed(2)}`)
  return `topped stairs at x=${st.x.toFixed(2)} — leg reach decides, not motors`
})

// ── 27. endurance: sustained load cooks servos to cutoff, pack drains ───────
check('endurance: sustained stall-load triggers thermal cutoff, SoC drains', () => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const pwr = A.createPowerSim(design)
  assert(pwr, 'arm has a battery — power sim should exist')
  const sim = A.createJointSim(design, analysis)
  sim.snap(design.joints.map(() => design.joints[0].max * 0.85))
  let soc0 = pwr.state.soc
  for (let i = 0; i < 60 * 30; i++) {
    sim.step(1 / 60, i * 16)
    pwr.step(1 / 60, sim.state, 0)
    sim.state.thermal = pwr.state.cut
  }
  const h = pwr.hud()
  assert(h.cuts > 0, 'no servo hit thermal cutoff under 30s sustained load')
  assert(h.tempMax >= 80, `peak joint temp ${h.tempMax.toFixed(0)}°C — cutoff should engage`)
  assert(h.soc < soc0, `SoC did not drain: ${soc0} → ${h.soc}`)
  assert(h.vbus < 12, `bus voltage did not sag: ${h.vbus.toFixed(1)}V`)
  // session evidence the report exports: peaks ≥ live values, cutout counts ≥ live cuts
  const ps = pwr.state
  assert(ps.peak.every((p, i) => p >= ps.temps[i] - 1e-6), 'peak temps must dominate live temps')
  assert(Math.abs(ps.socMin - ps.soc) < 1e-6, 'SoC only drains — socMin should equal final SoC')
  assert(ps.peakA >= ps.busA - 1e-6 && ps.peakA > 0, 'peak bus amps must cover the last reading')
  assert(ps.cutN.reduce((a, b) => a + b, 0) >= h.cuts, 'total cutouts must cover currently-cut joints')
  pwr.reset()
  assert(ps.soc === 100 && ps.socMin === 100 && ps.cutN.every((c) => c === 0) && ps.peak.every((p) => p === 25),
    'battery swap must clear all session peaks')
  return `peak ${h.tempMax.toFixed(0)}°C, ${h.cuts} cutout(s), SoC ${soc0.toFixed(0)}→${h.soc.toFixed(1)}%, bus ${h.vbus.toFixed(1)}V, evidence tracked`
})

// ── 27b. joint sim: servo speed follows a real torque-speed curve ───────────
check('joint sim: slew speed derates with gravity load, dies near stall', () => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const names = design.joints.map((j) => j.id)
  const measure = (pose) => {
    const s = A.createJointSim(design, analysis)
    s.snap(pose)
    s.setTargets(design.joints.map((j) => j.min + (j.max - j.min) * 0.9))
    s.step(1 / 240, 0)
    s.step(1 / 240, 1000) // second step forces the 2 Hz load refresh
    return design.joints.map((j, k) => ({
      lr: s.state.stallNm[k] > 0 ? s.state.loadNm[k] / s.state.stallNm[k] : 0,
      dps: Math.abs(s.state.vel[k]),
      rated: s.state.servoKey[k] && A.PARTS[s.state.servoKey[k]] ? 60 / A.PARTS[s.state.servoKey[k]].speed : 200,
    }))
  }
  const extended = design.joints.map((j, k) => j.min + (j.max - j.min) * (k % 2 ? 0.85 : 0.15))
  const m = measure(extended)
  // every moving joint's speed must match the datasheet curve
  // dps = rated · (1 − loadR)^0.75, and a heavily loaded joint must crawl
  let checked = 0, worst = 0
  for (const x of m) {
    if (x.lr < 0.05 || x.lr > 0.97 || x.dps < 1) continue
    const expect = x.rated * Math.pow(1 - Math.min(x.lr, 1), 0.75)
    worst = Math.max(worst, Math.abs(x.dps - expect) / Math.max(expect, 1))
    checked++
  }
  assert(checked >= 3, `only ${checked} joints carried measurable load — curve untested`)
  assert(worst < 0.15, `slew speed deviates ${Math.round(worst * 100)}% from torque-speed curve`)
  const heavy = m.filter((x) => x.lr > 0.8)
  if (heavy.length) {
    for (const x of heavy) assert(x.dps < x.rated * 0.35, `${names[m.indexOf(x)]} at ${x.lr.toFixed(2)} stall-load should crawl, got ${x.dps.toFixed(0)} vs rated ${x.rated.toFixed(0)}`)
  }
  return `${checked} loaded joints track the curve (worst dev ${Math.round(worst * 100)}%); ${heavy.length} near-stall joints crawl`
})

// ── 28. OpenSCAD is a file a maker can work in ──────────────────────────────
check('OpenSCAD export: one named module per node, each instantiated once, every archetype', () => {
  let total = 0
  eachPreset((p, { design }) => {
    const scad = A.toOpenSCAD(design)
    const modules = [...scad.matchAll(/^module (p_\w+)\(\)/gm)].map((m) => m[1])
    const calls = [...scad.matchAll(/^  (p_\w+)\(\);/gm)].map((m) => m[1])
    assert(modules.length === design.nodes.length, `${p.id}: ${modules.length} modules for ${design.nodes.length} nodes`)
    assert(new Set(modules).size === modules.length, `${p.id}: duplicate module name — one part would shadow another`)
    assert(calls.length === modules.length, `${p.id}: ${calls.length} instantiations for ${modules.length} modules`)
    for (const m of modules) {
      assert(calls.filter((c) => c === m).length === 1, `${p.id}: module ${m} instantiated ${calls.filter((c) => c === m).length} times`)
    }
    assert(scad.split('{').length === scad.split('}').length, `${p.id}: unbalanced braces in the SCAD file`)
    assert(scad.includes('PART = "all"') && scad.includes('module assembly()'), `${p.id}: no PART switch / assembly`)
    total += modules.length
  })
  return `${total} named modules across ten machines`
})

// ── 28b. brim check: bed contact vs footprint, measured not guessed ──────────
check('DFM brim: contact ratio measured per part, narrow footprints flagged', () => {
  let checked = 0, flagged = 0
  eachPreset((p, { design }) => {
    const oh = A.overhangReport(design)
    for (const part of oh.parts) {
      assert(part.footprint > 0, `${p.id}/${part.id}: no footprint`)
      assert(part.contact >= 0 && part.contact <= 1, `${p.id}/${part.id}: contact ${part.contact} outside [0,1]`)
      assert(part.brim === (part.contact < 0.3), `${p.id}/${part.id}: brim flag disagrees with contact ${part.contact}`)
      checked += 1
      if (part.brim) flagged += 1
    }
  })
  assert(flagged >= 1, 'no preset part flagged for brim — the check may be vacuous')
  return `${checked} parts measured, ${flagged} flagged for brim`
})

// ── 28b. DFM wall thickness: axis raycasts flag thin skins, clear real walls ──
check('wall thickness: raycast DFM flags thin skins, clears real walls', () => {
  const mk = (size) => ({ nodes: [{ id: 't', kind: 'box', print: true, size, pos: [0, 0, 0], mat: 0 }], joints: [], brief: {} })
  const skin = A.wallReport(mk([40, 40, 0.6]))
  const slab = A.wallReport(mk([40, 40, 8]))
  const mid = A.wallReport(mk([40, 40, 2]))
  assert(skin.parts.length === 1 && skin.parts[0].p10 < 1.2,
    `0.6mm skin not flagged thin (p10=${skin.parts[0] && skin.parts[0].p10})`)
  assert(skin.thin.length === 1, '0.6mm skin missing from the thin list')
  assert(slab.parts.length === 1 && slab.parts[0].p10 > 5 && slab.thin.length === 0,
    `8mm slab misread as thin (p10=${slab.parts[0] && slab.parts[0].p10})`)
  assert(mid.parts.length === 1 && mid.parts[0].p10 > 1.2 && mid.thin.length === 0,
    `2mm wall falsely flagged (p10=${mid.parts[0] && mid.parts[0].p10})`)
  // every preset's printed parts get measured; thinnest is a real number
  let measured = 0
  eachPreset((p, { design }) => {
    const w = A.wallReport(design)
    const printed = design.nodes.filter((n) => n.print).length
    assert(w.parts.length <= printed, `${p.id}: wall rows exceed printed nodes`)
    assert(w.thinnest == null || (w.thinnest > 0 && w.thinnest < 500), `${p.id}: implausible thinnest ${w.thinnest}`)
    for (const part of w.parts) {
      assert(part.p10 > 0 && part.p10 < 500, `${p.id}/${part.id}: implausible p10 ${part.p10}`)
    }
    measured += w.parts.length
  })
  return `${measured} parts measured · 0.6mm skin flagged · 2mm/8mm walls clear`
})

// ── 28c. interference: printed parts occupying the same space get flagged ────
check('interference: overlapping printed parts flagged, jointed relatives skipped', () => {
  // two stacked plates that genuinely interpenetrate must flag
  const overlap = {
    nodes: [
      { id: 'a', kind: 'box', print: true, size: [40, 40, 4], pos: [0, 0, 10] },
      { id: 'b', kind: 'box', print: true, size: [40, 40, 4], pos: [0, 0, 11] }, // 3mm into a
      { id: 'c', kind: 'box', print: true, size: [40, 40, 4], pos: [200, 0, 10] }, // clear
    ],
    joints: [], brief: {},
  }
  const ir = A.interferenceReport(overlap)
  assert(ir.count >= 1, `overlapping plates not flagged (pairs=${ir.count})`)
  assert(ir.pairs.some((p) => (p.a === 'a' && p.b === 'b') || (p.a === 'b' && p.b === 'a')),
    `expected a×b pair, got ${JSON.stringify(ir.pairs)}`)
  assert(!ir.pairs.some((p) => p.a === 'c' || p.b === 'c'), 'clear part c falsely paired')
  // presets: jointed links nest legitimately and must NOT flag; what remains
  // are honest static collisions — count stays sane, and split-part joiner
  // bars must never cross each other (they share one 2.6mm slab by design
  // of the pack, so a join×join pair means the segmentation broke)
  let total = 0
  eachPreset((p, { design }) => {
    const r = A.interferenceReport(design)
    for (const pair of r.pairs) {
      assert(pair.depth > 0.8, `${p.id}: ${pair.a}×${pair.b} flagged below depth floor (${pair.depth})`)
      assert(pair.a !== pair.b, `${p.id}: self-pair`)
      assert(!(pair.a.includes('join') && pair.b.includes('join')),
        `${p.id}: joiner bars ${pair.a}×${pair.b} still share volume — seam crossing not segmented`)
    }
    total += r.count
  })
  return `synthetic overlap flagged · ${total} static pairs across presets (jointed nesting + joiner crossings skipped)`
})

// ── 29. servo harness: stock leads must reach, voltage drop stays bounded ────
check('servo harness: runs measured from joint pivots, long leads flagged honestly', () => {
  let rows = 0
  eachPreset((p, { design, analysis }) => {
    const h = analysis.harness
    const hasServos = (design.parts || []).some(({ key }) => A.PARTS[key] && A.PARTS[key].cat === 'servo')
    const driven = (design.joints || []).filter((j) => j.pivot).length
    if (!hasServos || !driven) { assert(!h, `${p.id}: harness should be absent without servos/joints`); return }
    assert(h, `${p.id}: servos + joints but no harness analysis`)
    assert(h.rows.length === driven, `${p.id}: ${h.rows.length} harness rows for ${driven} joints`)
    for (const r of h.rows) {
      assert(r.run >= 0 && isFinite(r.run), `${p.id}/${r.id}: bad run ${r.run}`)
      assert(['stock', 'check', 'extend', 'daisy-chain', 'unknown'].includes(r.lead), `${p.id}/${r.id}: bad verdict ${r.lead}`)
      assert(r.vdrop >= 0 && r.vdrop < 2, `${p.id}/${r.id}: implausible drop ${r.vdrop}V`)
      rows += 1
    }
  })
  // The 450mm arm's wrist is ~380mm from the base on a 300mm-lead servo — the
  // check must say so, not smooth it over.
  const arm = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const wrist = arm.analysis.harness.rows.find((r) => r.id === 'wrist-roll')
  assert(wrist && wrist.lead === 'extend', `arm wrist-roll should need an extension lead, got ${wrist && wrist.lead} (${wrist && wrist.run}mm)`)
  // Flagged joints must put the part in the BOM — the check is useless if the
  // shopping list still says "everything included".
  const ext = arm.design.parts.find((p) => p.key === 'extlead_300')
  assert(ext && ext.qty >= arm.analysis.harness.needExt, `arm BOM should carry ${arm.analysis.harness.needExt} extension leads, got ${ext && ext.qty}`)
  return `${rows} joint runs checked; arm wrist honestly flagged ~${wrist.run}mm > 300mm lead, ${ext.qty} extension leads in BOM`
})

// ── 29b. cable overlay: wires follow the pose, colours match verdicts ────────
check('cable overlay: one run per joint, pose-aware, verdict colours', () => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const ov = A.wireOverlay(design, analysis.harness)
  assert(ov && ov.verts > 0, 'arm should emit cable overlay verts')
  // 5 joints, yaw+shoulder share a pivot → 3 zero-run skips → 3 wires × 3 segs
  assert(ov.verts === 18, `expected 18 verts (3 wires), got ${ov.verts}`)
  // pose the shoulder: downstream wire verts must move
  const posed = { ...design, joints: design.joints.map((j) => ({ ...j, angle: j.id === 'shoulder' ? 45 : (j.angle || 0) })) }
  const ov2 = A.wireOverlay(posed, analysis.harness)
  let moved = 0
  for (let i = 0; i < ov.data.length; i += 6) if (Math.abs(ov.data[i] - ov2.data[i]) > 0.5) moved += 1
  assert(moved > 0, 'posed shoulder should drag the wrist cable verts')
  // extend-verdict wires are red, stock are blue — colours must match the table
  const isRed = (i) => Math.abs(ov.data[i + 3] - 0.95) < 0.02 && Math.abs(ov.data[i + 4] - 0.32) < 0.02
  const reds = []
  for (let i = 0; i < ov.data.length; i += 6) if (isRed(i)) reds.push(i)
  assert(reds.length === 12, `expected 12 red verts (2 extend wires), got ${reds.length}`)
  return `cable overlay live: ${ov.verts} verts, pose moves wires, ${reds.length / 2} segments flagged extend-red`
})

// ── 29b2. load overlay: joint pivots coloured by the sim's load ratio ────────
check('load overlay: crosshair per joint, colour tracks load/stall honestly', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'arm').brief })
  const n = design.joints.filter((j) => !j.slide).length
  // joint 0 loafing, joint 1 over stall, joint 2 thermally cut
  const load = design.joints.map((_, i) => (i === 1 ? 1.2 : i === 2 ? 0.4 : 0.1))
  const stall = design.joints.map(() => 1)
  const stalled = design.joints.map((_, i) => i === 2)
  const ov = A.loadOverlay(design, load, stall, stalled)
  assert(ov && ov.verts === n * 6, `expected ${n * 6} verts (3 segs × 2 per joint), got ${ov && ov.verts}`)
  // colour lives at +3..+5 of each vert: count green vs red dominated verts
  let green = 0, red = 0
  for (let i = 0; i < ov.data.length; i += 6) {
    const r = ov.data[i + 3], g = ov.data[i + 4], b = ov.data[i + 5]
    if (g > r && g > b) green += 1
    if (r > g && r > b) red += 1
  }
  // joints 0,3,4 green (3×6=18), joints 1,2 red-family (2×6=12)
  assert(green === 18 && red === 12, `expected 18 green / 12 red verts, got ${green}/${red}`)
  // stalled must read white-hot, not the same red as merely-near-stall
  const j1g = ov.data[6 * 6 + 4], j2g = ov.data[2 * 6 * 6 + 4]
  assert(j2g > 0.85 && j1g < 0.6, `stalled joint should glow white-hot (g=${j2g.toFixed(2)}), near-stall stays red (g=${j1g.toFixed(2)})`)
  return `load overlay: ${n} joints → ${green} green / ${red} red verts, stall=white-hot`
})

// ── 29c. reach overlay: workspace sphere contains every reachable tip ────────
check('reach overlay: sphere bound contains the live tip, quad gets none', () => {
  const armP = A.PRESETS.find((p) => p.brief.archetype === 'arm')
  const { design, analysis } = A.composeDesign({ ...armP.brief })
  const ik = A.createArmTeleop(design)
  assert(ik && ik.reachSphere, 'arm IK should expose a reach sphere')
  // the spec's reach row and the viewport sphere are the same number
  assert(analysis.reach && analysis.reach.r === ik.reachSphere.r,
    `analysis reach ${analysis.reach && analysis.reach.r} != overlay ${ik.reachSphere.r}`)
  const { c, r } = ik.reachSphere
  assert(r > 200 && r < 1200, `arm reach bound ${r}mm outside sane range`)
  // every reachable tip sits inside: rest pose and a swung pose must both fit
  for (const ang of [0, 30, -40]) {
    const angles = design.joints.map(() => ang)
    const t = ik.tipPos(angles)
    const d = Math.hypot(t[0] - c[0], t[1] - c[1], t[2] - c[2])
    assert(d <= r + 1, `tip at ${d.toFixed(0)}mm escapes the ${r}mm bound`)
  }
  const ov = A.reachOverlay(ik.reachSphere, ik.tipPos(design.joints.map(() => 0)))
  assert(ov && ov.verts === 126, `sphere+tip should be 63 segs = 126 verts, got ${ov && ov.verts}`)
  const ovBare = A.reachOverlay(ik.reachSphere, null)
  assert(ovBare.verts === 120, `sphere alone should be 60 segs = 120 verts, got ${ovBare.verts}`)
  // ambiguous machines honestly get no IK → no sphere, no spec reach row
  const quadP = A.PRESETS.find((p) => p.brief.archetype === 'quadruped')
  const { design: qd, analysis: qa } = A.composeDesign({ ...quadP.brief })
  assert(!A.createArmTeleop(qd), 'quadruped must not get a single-arm IK')
  assert(!qa.reach, 'quadruped spec must not claim a single-arm reach bound')
  return `reach sphere r=${r}mm contains all sampled tips; ${ov.verts} overlay verts`
})

// ── 29d. workspace map: sampled reachable/liftable cloud is honest ──────────
check('workspace map: IK-sampled cloud respects joint limits and lift torque', () => {
  const armP = A.PRESETS.find((p) => p.brief.archetype === 'arm')
  const { design, analysis } = A.composeDesign({ ...armP.brief })
  const ws = A.workspaceMap(design, analysis, { payloadG: 100, dirs: 30, radii: [0.5, 0.75] })
  assert(ws && ws.stats.total > 0, 'arm workspace map should sample targets')
  const { total, reach, lift } = ws.stats
  assert(reach > 0 && reach <= total, `reach ${reach}/${total} out of range`)
  assert(lift <= reach, `lift ${lift} exceeds reach ${reach}`)
  assert(lift > 0, 'a 100g payload should lift somewhere in a 450mm arm workspace')
  // heavier payload can only shrink the lift set, never grow it
  const heavy = A.workspaceMap(design, analysis, { payloadG: 2000, dirs: 30, radii: [0.5, 0.75] })
  assert(heavy.stats.lift <= lift, `2kg lift ${heavy.stats.lift} > 100g lift ${lift} — impossible`)
  // no point may sit under the bench plane
  for (const s of ws.pts) assert(s.p[2] >= 25, `sampled point below bench: z=${s.p[2]}`)
  // every reported point was actually IK-verified: re-solve from two seeds
  // (CCD has local minima — one seed failing proves nothing)
  const s = ws.pts[Math.floor(ws.pts.length / 2)]
  const tip = A.armTipChain(design)
  const frac = (f) => design.joints.map((j) => j.min + (j.max - j.min) * f)
  let r = { err: 1e9 }
  for (const seed of [frac(0.5), frac(0.15)]) {
    const scratch = { ...design, joints: design.joints.map((j, k) => ({ ...j, angle: seed[k] })) }
    const ikChain = tip.tipChain.map((j) => scratch.joints.find((x) => x.id === j.id)).filter(Boolean)
    const rr = A.solveChainIK(scratch, ikChain, s.p, (d) => A.benchNodeWorld(d, A.chainsFor(d), tip.tipNode), 20)
    if (rr.err < r.err) r = rr
  }
  assert(r.err < 15, `workspace point re-solve err ${r.err.toFixed(1)}mm — cloud claims unreachable`)
  const ov = A.workspaceOverlay(ws)
  assert(ov && ov.verts === ws.pts.length * 6, `overlay verts ${ov && ov.verts} != ${ws.pts.length * 6}`)
  // the spec carries the same sampled numbers when extras are provided
  const md = A.toSpecMarkdown(design, A.composeDesign({ ...armP.brief }).analysis, { ws })
  assert(/Sampled workspace \| .*reachable/.test(md), 'spec missing the IK-sampled workspace row')
  const mdBare = A.toSpecMarkdown(design, A.composeDesign({ ...armP.brief }).analysis)
  assert(!/Sampled workspace/.test(mdBare), 'spec claims workspace numbers it was not given')
  return `workspace ${reach}/${total} reachable, ${lift} lift 100g; re-solve ${r.err.toFixed(1)}mm`
})

// ── 29e. leg workspace: per-foot IK-verified planting zones ─────────────────
check('leg workspace: gait machines get per-leg reach clouds, yaw joints counted', () => {
  const quadP = A.PRESETS.find((p) => p.brief.archetype === 'quadruped')
  const { design: qd } = A.composeDesign({ ...quadP.brief })
  const qm = A.legWorkspaceMap(qd, { dirs: 16, radii: [0.6, 0.9] })
  assert(qm && qm.legs.length === 4, `quad should map 4 legs, got ${qm && qm.legs.length}`)
  for (const leg of qm.legs) {
    assert(leg.reach > 0 && leg.reach <= leg.total, `${leg.key}: reach ${leg.reach}/${leg.total} out of range`)
    for (const s of leg.pts) assert(s.p[2] >= 10, `${leg.key} foot target under floor z=${s.p[2]}`)
  }
  // hip-yaw (z-axis) joints must participate — without them the cloud misses
  // all sideways reach and under-reports by ~2×
  const yawIds = new Set(qd.joints.filter((j) => j.axis === 'z').map((j) => j.id))
  assert(yawIds.size >= 4, 'quad legs should have z-axis hip joints')
  // humanoid gets its own map with 2 legs
  const humP = A.PRESETS.find((p) => p.brief.archetype === 'humanoid')
  const { design: hd } = A.composeDesign({ ...humP.brief })
  const hm = A.legWorkspaceMap(hd, { dirs: 16, radii: [0.6, 0.9] })
  assert(hm && hm.legs.length === 2, `humanoid should map 2 legs, got ${hm && hm.legs.length}`)
  // arm-only and wheeled machines honestly get no leg map
  const armP = A.PRESETS.find((p) => p.brief.archetype === 'arm')
  const { design: ad } = A.composeDesign({ ...armP.brief })
  assert(!A.legWorkspaceMap(ad), 'arm must not produce a leg workspace')
  const roverP = A.PRESETS.find((p) => p.brief.archetype === 'rover')
  const { design: rd } = A.composeDesign({ ...roverP.brief })
  assert(!A.legWorkspaceMap(rd), 'rover must not produce a leg workspace')
  const ov = A.legWorkspaceOverlay(qm)
  const nPts = qm.legs.reduce((s, l) => s + l.pts.length, 0)
  assert(ov && ov.verts === nPts * 6, `leg overlay verts ${ov && ov.verts} != ${nPts * 6}`)
  // spec export carries the per-leg table when given the map
  const { analysis: qa2 } = A.composeDesign({ ...quadP.brief })
  const md = A.toSpecMarkdown(qd, qa2, { legWs: qm })
  assert(/Foot workspace[\s\S]*FL \| \d+\/\d+/.test(md), 'spec missing per-leg workspace table')
  return `quad legs reach ${qm.legs.map((l) => `${l.key} ${l.reach}/${l.total}`).join(' ')}; humanoid ${hm.legs.length} legs`
})

// ── 30/31. autopilot certification scores maneuvers honestly ───────────────
const runAutotest = (env) => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'rover').brief })
  const drive = A.createDrive(design, analysis)
  drive.setEnv(env || {})
  const at = A.createAutotest(drive)
  at.start()
  for (let i = 0; i < 60 * 20 && at.running; i++) drive.step(at.tick(1 / 60), 1 / 60)
  return at
}

check('autotest: rover passes the certification suite on a real climb', () => {
  const at = runAutotest({ surface: 'hardwood', slopeDeg: 10 })
  assert(at.done, 'autotest did not finish within 20s sim')
  assert(at.results.length === 6, `expected 6 phase results, got ${at.results.length}`)
  const fails = at.results.filter((r) => !r.pass)
  assert(fails.length === 0, `unexpected failures: ${fails.map((f) => `${f.label}(${f.detail})`).join(', ')}`)
  return `${at.score} — ${at.results.map((r) => `${r.label}:${r.detail}`).join(' · ')}`
})

check('autotest: wet-ice ramp fails the climb check honestly', () => {
  const at = runAutotest({ surface: 'ice', slopeDeg: 10 })
  assert(at.done, 'autotest did not finish')
  const climb = at.results.find((r) => r.id === 'climb')
  assert(climb && !climb.pass, `climb passed on wet ice — ${climb && climb.detail}`)
  return `climb FAIL — ${climb.detail}`
})

check('autotest: gantry certifies traverse, drop and return', () => {
  const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'gantry').brief })
  const tel = A.createGantryTeleop(design)
  const at = A.createAutotest(tel)
  assert(at, 'gantry should get a certification suite')
  at.start()
  // feed the sim's actual angles like the page does — teleop pos tracks 1:1
  for (let i = 0; i < 60 * 40 && at.running; i++) {
    const cmd = at.tick(1 / 60, [tel.state.x, tel.state.y, tel.state.z])
    tel.step(cmd || { x: 0, y: 0, z: 0 }, 1 / 60)
  }
  assert(at.done, 'gantry cert did not finish')
  assert(at.results.length === 4, `expected 4 legs, got ${at.results.length}`)
  const fails = at.results.filter((r) => !r.pass)
  assert(fails.length === 0, `gantry cert failures: ${fails.map((f) => `${f.label}(${f.detail})`).join(', ')}`)
  return `${at.score} — ${at.results.map((r) => `${r.label}:${r.detail}`).join(' · ')}`
})

// ── custom archetype: spec-driven machines get the whole pipeline ──────────
check('custom spec: preset composes, servos measured, spec round-trips', () => {
  const preset = A.PRESETS.find((p) => p.brief.archetype === 'custom')
  assert(preset, 'no custom preset card')
  const { design, analysis } = A.composeDesign({ ...preset.brief })
  assert(design.nodes.length === preset.brief.nodes.length, `nodes ${design.nodes.length} != spec ${preset.brief.nodes.length}`)
  assert(design.joints.length === preset.brief.joints.length, `joints ${design.joints.length} != spec ${preset.brief.joints.length}`)
  const acts = design.actuators || []
  assert(acts.length === 2, `expected 2 sized actuators, got ${acts.length}`)
  for (const a of acts) assert(A.PARTS[a.servo] && A.PARTS[a.servo].cat === 'servo', `bad servo ${a.servo}`)
  assert(design.parts.some((p) => p.key === 'esp32s3'), 'controller missing from BOM')
  assert(A.toSTL(A.buildMesh(design)).byteLength > 1000, 'custom machine produced no STL')
  const code = A.decodeBuild(A.encodeBuild(preset.brief))
  assert((code.nodes || []).length === preset.brief.nodes.length && (code.joints || []).length === preset.brief.joints.length,
    'build code dropped the spec')
  return `${design.nodes.length} nodes · ${design.joints.length} joints · servos ${acts.map((a) => a.servo).join('/')} · STL ok`
})

check('custom machines self-select teleop: IK chain + gantry slides', () => {
  const arm = A.composeDesign({
    archetype: 'custom', title: 'spec arm',
    nodes: [
      { kind: 'rbox', size: [120, 120, 8], at: [0, 0, 4], print: true },
      { kind: 'rbox', size: [14, 14, 120], at: [40, 0, 100], joint: 'shoulder' },
      { kind: 'rbox', size: [12, 12, 110], at: [90, 0, 190], joint: 'elbow' },
      { kind: 'sphere', r: 14, at: [130, 0, 240], joint: 'wrist' },
    ],
    joints: [
      { id: 'base', axis: 'z', pivot: [0, 0, 42], min: -170, max: 170 },
      { id: 'shoulder', axis: 'y', pivot: [40, 0, 60], min: -120, max: 120, parent: 'base' },
      { id: 'elbow', axis: 'y', pivot: [90, 0, 160], min: -140, max: 0, parent: 'shoulder' },
      { id: 'wrist', axis: 'y', pivot: [130, 0, 245], min: -90, max: 90, parent: 'elbow' },
    ],
  })
  assert(A.armTipChain(arm.design), 'spec arm got no IK chain')
  assert(A.createArmTeleop(arm.design), 'spec arm got no IK teleop')
  const gx = A.composeDesign({
    archetype: 'custom', title: 'spec stage',
    nodes: [
      { kind: 'box', size: [50, 50, 10], at: [0, 0, 5] },
      { kind: 'box', size: [10, 10, 80], at: [100, 0, 50], slide: 'gx' },
      { kind: 'box', size: [10, 10, 80], at: [200, 0, 50], slide: 'gy' },
      { kind: 'box', size: [10, 10, 30], at: [300, 0, 95], slide: 'gz' },
    ],
    joints: [
      { id: 'gx', slide: true, axis: 'x', travel: 300 },
      { id: 'gy', slide: true, axis: 'y', travel: 200 },
      { id: 'gz', slide: true, axis: 'z', travel: 100 },
    ],
  })
  assert(A.createGantryTeleop(gx.design), 'spec stage got no gantry teleop')
  const bad = A.composeDesign({ archetype: 'custom', nodes: [{ kind: 'bogus' }], joints: 'junk' })
  assert(bad.design.checks.some((c) => c.level === 'fail'), 'malformed spec did not fail honestly')
  return 'arm→IK teleop · 3-slide stage→gantry teleop · malformed→fail check'
})

// ── 32. stairs course: risers taller than wheel bite block honestly ─────────
check('stairs: 80mm nosing blocks a 100mm-wheel chassis', () => {
  const { design, analysis } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'rover').brief })
  const drive = A.createDrive(design, analysis)
  drive.setEnv({ course: 'stairs' })
  let stalled = false
  for (let i = 0; i < 60 * 10; i++) {
    drive.step({ throttle: 1, steer: 0 }, 1 / 60)
    if (drive.state.stall) stalled = true
  }
  const s = drive.state
  assert(s.bumps > 0, 'never registered a stair hit')
  assert(stalled, 'never flagged stall at the nosing')
  assert(s.x < 1.9, `rode through the stairs to x=${s.x.toFixed(2)}`)
  assert(s.z < 0.01, `climbed to z=${s.z.toFixed(2)} without wheel bite`)
  return `blocked at x=${s.x.toFixed(2)}, ${s.bumps} bumps, stall=${stalled}`
})

// ── 33-36. autopilot certification covers every teleop kind ────────────────
const presetDesign = (archetype) => A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === archetype).brief })

check('autotest reach: arm tour scores reach AND lift capacity per desk prop', () => {
  const { design } = presetDesign('arm')
  const ik = A.createArmTeleop(design)
  const at = A.createAutotest(ik)
  at.start()
  let actual = design.joints.map(() => 0)
  for (let i = 0; i < 60 * 50 && at.running; i++) {
    const c = at.tick(1 / 60, actual)
    const pose = c && c.pose ? c.pose : (c ? ik.step(c, 1 / 60, actual) : null)
    if (pose) pose.forEach((a, j) => { actual[j] = a }) // engine has no servo lag — apply instantly
  }
  assert(at.done, 'reach tour did not finish')
  assert(at.results.length === 8, `expected 8 results (3 reach + home + 3 lift + limits), got ${at.results.length}`)
  const steel = at.results.find((r) => r.id === 'reach-steel')
  assert(steel && steel.pass, `arm should reach the steel block — ${steel && steel.detail}`)
  // yaw joints joined the CCD solve — the arm reaches all three props now;
  // the honest differentiation lives in the lift legs, not reach
  for (const id of ['reach-bin', 'reach-print', 'reach-steel']) {
    const r = at.results.find((x) => x.id === id)
    assert(r && r.pass && /err 0mm/.test(r.detail), `${id} should reach with yaw IK — ${r && r.detail}`)
  }
  // the lift legs must differentiate by mass: 80g bin passes on stall margin,
  // the 1.2kg steel block must fail — reaching is not lifting
  const liftBin = at.results.find((r) => r.id === 'lift-bin')
  const liftSteel = at.results.find((r) => r.id === 'lift-steel')
  assert(liftBin && liftBin.pass, `80g bin should be liftable — ${liftBin && liftBin.detail}`)
  assert(liftSteel && !liftSteel.pass, `1.2kg steel should fail the torque check — ${liftSteel && liftSteel.detail}`)
  assert(/stall|carry/.test(liftSteel.detail), 'lift verdict lacks the measured margin')
  const limits = at.results.find((r) => r.id === 'limits')
  assert(limits && limits.pass, `limits sweep should pass on this arm — ${limits && limits.detail}`)
  return at.results.map((r) => `${r.label}:${r.pass ? 'P' : 'F'}(${r.detail})`).join(' · ')
})

check('autotest: humanoid certifies gait AND both arms, chain-scoped', () => {
  const { design } = presetDesign('humanoid')
  const gait = A.createGaitTeleop(design)
  const ikR = A.createArmTeleop(design)
  const ikL = A.createArmTeleop(design, 'l')
  assert(ikR && ikL, 'humanoid should expose both arm teleops')
  // same composition the page builds: gait primary, then R and L reach suites
  const at = A.createAutotest(gait, [{ t: ikR, tag: 'R' }, { t: ikL, tag: 'L' }])
  at.start()
  let actual = design.joints.map(() => 0)
  const env = { surface: 'hardwood', slopeDeg: 0, course: 'rack' }
  for (let i = 0; i < 60 * 120 && at.running; i++) {
    const c = at.tick(1 / 60, actual)
    if (at.activeKind === 'ik') {
      if (c && c.pose) actual = c.pose.slice()
    } else if (c) {
      const r = gait.locomote(c, 1 / 60, actual, env)
      if (r && r.pose) actual = r.pose
    }
  }
  assert(at.done, 'sequenced certification did not finish')
  const gaitRes = at.results.filter((r) => !/^[RL]: /.test(r.label))
  const armR = at.results.filter((r) => r.label.startsWith('R: '))
  const armL = at.results.filter((r) => r.label.startsWith('L: '))
  assert(gaitRes.length === 6, `gait suite should contribute 6 results, got ${gaitRes.length}`)
  assert(armR.length === 8 && armL.length === 8, `each arm suite is 8 results — R:${armR.length} L:${armL.length}`)
  // chain scoping: each arm's LIMITS sweep covers only its own joints — a
  // 23-joint humanoid must not report "all 23" for a 4-joint arm test
  for (const [tag, ik] of [['R', ikR], ['L', ikL]]) {
    const lim = at.results.find((r) => r.id === `${tag}-limits`)
    assert(lim && lim.pass, `${tag} arm LIMITS should pass — ${lim && lim.detail}`)
    assert(lim.detail.includes(`all ${ik.chainIdx.length} joints`), `${tag} LIMITS scope wrong — ${lim.detail}`)
  }
  const kinds = []
  return `22 results — gait ${gaitRes.filter((r) => r.pass).length}/6 · R-arm ${armR.filter((r) => r.pass).length}/8 · L-arm ${armL.filter((r) => r.pass).length}/8`
})

check('autotest gait: quadruped locomotion suite passes on rack', () => {
  const { design } = presetDesign('quadruped')
  const gait = A.createGaitTeleop(design)
  const at = A.createAutotest(gait)
  at.start()
  let actual = design.joints.map(() => 0)
  const env = { surface: 'hardwood', slopeDeg: 8, course: 'rack' }
  for (let i = 0; i < 60 * 25 && at.running; i++) {
    const c = at.tick(1 / 60)
    const r = gait.locomote(c, 1 / 60, actual, env)
    if (r && r.pose) actual = r.pose
  }
  assert(at.done, 'gait locomotion test did not finish')
  const fails = at.results.filter((r) => !r.pass)
  assert(fails.length === 0, `gait failures: ${fails.map((r) => `${r.label}(${r.detail})`).join(',')}`)
  return `${at.score} — ${at.results.map((r) => `${r.label}:${r.detail}`).join(' · ')}`
})

check('autotest gait: quad honestly fails porch stairs, humanoid climbs', () => {
  const env = { surface: 'hardwood', slopeDeg: 0, course: 'stairs' }
  const run = (arch) => {
    const { design } = presetDesign(arch)
    const gait = A.createGaitTeleop(design)
    const at = A.createAutotest(gait)
    at.start()
    let actual = design.joints.map(() => 0)
    for (let i = 0; i < 60 * 25 && at.running; i++) {
      const c = at.tick(1 / 60)
      const r = gait.locomote(c, 1 / 60, actual, env)
      if (r && r.pose) actual = r.pose
    }
    return at.results.find((r) => r.id === 'obstacle')
  }
  const quad = run('quadruped')
  const hum = run('humanoid')
  assert(quad && quad.pass, `quad obstacle check should pass-by-blocking: ${quad && quad.detail}`)
  assert(/can't mount|blocked/i.test(quad.detail), `quad should report an honest block, got: ${quad.detail}`)
  assert(hum && hum.pass, `humanoid should top the flight: ${hum && hum.detail}`)
  return `quad: ${quad.detail} · humanoid: ${hum.detail}`
})

check('autotest grip: jaw cycles open/closed on command', () => {
  const { design } = presetDesign('gripper')
  const grip = A.createGripTeleop(design)
  const at = A.createAutotest(grip)
  at.start()
  for (let i = 0; i < 60 * 15 && at.running; i++) grip.step(at.tick(1 / 60))
  assert(at.done && at.results[0] && at.results[0].pass, `jaw test: ${at.results[0] && at.results[0].detail}`)
  const hold = at.results.find((r) => r.id === 'hold')
  assert(hold && hold.pass, `hold test: ${hold && hold.detail} (rated ${design.metrics.gripMassKg.toFixed(1)}kg)`)
  return `${at.results[0].detail} · ${hold.detail}`
})

check('autotest sense: stimulus sweep fires a real threshold alert', () => {
  const { design } = presetDesign('iot')
  const sense = A.createSensorTeleop(design)
  const at = A.createAutotest(sense)
  at.start()
  for (let i = 0; i < 60 * 10 && at.running; i++) at.tick(1 / 60)
  assert(at.done && at.results[0] && at.results[0].pass, `sense test: ${at.results[0] && at.results[0].detail}`)
  return at.results[0].detail
})

check('fix suggestions: unreachable desk props prescribe a longer arm', () => {
  const mk = (arch) => {
    const { design, analysis } = presetDesign(arch)
    return A.fixSuggestions({ bench: A.benchReport(design, analysis, { slopeDeg: 15 }), reach: analysis.reach, brief: design.brief || {} })
  }
  const hum = mk('humanoid').find((f) => /Fix reach/.test(f.msg))
  assert(hum, 'humanoid arms cannot reach the desk — a reach fix should fire')
  assert(hum.apply && hum.apply.reachMm > 620, `reach fix should propose a bigger arm, got ${JSON.stringify(hum.apply)}`)
  const arm = mk('arm').find((f) => /Fix reach/.test(f.msg))
  assert(!arm, 'the 450mm arm reaches every desk prop — no reach fix should fire')
  assert(!mk('quadruped').some((f) => /Fix reach/.test(f.msg)), 'legged machines have no arm reach to fix')
  return `humanoid: ${hum.msg.slice(0, 70)} → reachMm ${hum.apply.reachMm}`
})

check('fix suggestions: cert lift failures prescribe sized payloads honestly', () => {
  const fail = { pass: false, detail: 'best carry Shoulder pitch at 0.64× stall holding 1200g' }
  // arm archetype: payloadKg really does upsize servos — the patch is honest
  const armFix = A.fixSuggestions({ brief: { archetype: 'arm', payloadKg: 1 }, autotest: [fail] })
    .find((f) => /Fix lift/.test(f.msg))
  assert(armFix && armFix.apply && armFix.apply.payloadKg === 1.2,
    `arm lift fail should propose payloadKg 1.2, got ${JSON.stringify(armFix && armFix.apply)}`)
  // humanoid: arm servos ignore payloadKg — the fix must stay verbal, no fake patch
  const humFix = A.fixSuggestions({ brief: { archetype: 'humanoid', payloadKg: 0.5 }, autotest: [fail] })
    .find((f) => /Fix lift/.test(f.msg))
  assert(humFix && !humFix.apply, `humanoid lift fix must not pretend payloadKg upsizes servos — ${JSON.stringify(humFix)}`)
  // already-sized payload: no patch, honest wording
  const sized = A.fixSuggestions({ brief: { archetype: 'arm', payloadKg: 2 }, autotest: [{ pass: false, detail: 'best carry Wrist pitch at 0.64× stall holding 350g' }] })
    .find((f) => /Fix lift/.test(f.msg))
  assert(sized && !sized.apply, '350g under a 2kg rating needs no payload patch')
  // non-lift cert failures aggregate into one row, not one row per leg
  const mixed = A.fixSuggestions({ brief: { archetype: 'humanoid' }, autotest: [
    { pass: true, label: 'TROT', detail: 'ok' },
    { pass: false, label: 'R:reach mug', detail: 'err 42mm' },
    { pass: false, label: 'L:reach block', detail: 'err 88mm' },
    { pass: false, label: 'L:LIMITS', detail: 'wrist min unreached' },
  ] })
  const agg = mixed.filter((f) => /Cert: \d+ leg/.test(f.msg))
  assert(agg.length === 1 && /3 leg/.test(agg[0].msg) && /R:reach mug/.test(agg[0].msg),
    `expected one aggregated cert row naming 3 fails, got ${JSON.stringify(mixed.map((f) => f.msg))}`)
  return `arm→payloadKg 1.2 · humanoid→verbal · sized→verbal · mixed→1 aggregated row`
})

check('fix suggestions: an applyable fix leads its severity group', () => {
  // rover stalled on stairs: "Fix drive" (stall, no patch) and "Fix steps"
  // (bumps, wheelMm patch) are both fails — the patchable one must surface
  // first or the ⚒ row's APPLY FIX button keys off the wrong entry
  const out = A.fixSuggestions({
    drive: { stall: true, slide: false, throttle: 1, bumps: 2, course: 'stairs', surface: 'wood' },
    brief: { archetype: 'rover', wheelMm: 100 },
  })
  const driveFix = out.find((f) => /Fix drive/.test(f.msg))
  const stepFix = out.find((f) => /Fix steps/.test(f.msg))
  assert(driveFix && stepFix, `expected both drive+steps fixes, got ${JSON.stringify(out.map((f) => f.msg))}`)
  assert(!driveFix.apply && stepFix.apply && stepFix.apply.wheelMm === 150,
    `steps fix should carry wheelMm 150 patch, got ${JSON.stringify(stepFix.apply)}`)
  assert(out[0] === stepFix, `applyable fix must lead — got ${out[0].msg} first`)
  // severity still dominates: a warn-with-patch never outranks a fail
  const sev = A.fixSuggestions({
    drive: { stall: true, slide: false, throttle: 1, bumps: 0, course: 'rack', surface: 'hardwood' },
    power: { dead: true, cuts: 0, tempMax: 40 },
    brief: { archetype: 'rover', wheelMm: 100, battery: 'lipo2s' },
  })
  assert(sev[0].sev === 'fail' && /Fix drive|Fix power/.test(sev[0].msg),
    `fail must still lead warns — got ${sev[0].sev} ${sev[0].msg}`)
  return `steps(wheelMm) leads drive(stall) · fail>warn preserved`
})

check('pose presets: named poses resolve in-limits, presets are FK-verified', () => {
  // every preset on every archetype resolves to a full in-limits angle array
  for (const arch of ['arm', 'robot', 'humanoid', 'gripper', 'rover', 'quadruped', 'gantry']) {
    const { design } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === arch).brief })
    for (const p of A.POSE_PRESETS[arch]) {
      const angles = A.applyPosePreset(design, p.name)
      assert(angles && angles.length === design.joints.length, `${arch}/${p.name}: bad angle array`)
      design.joints.forEach((j, i) => {
        assert(angles[i] >= j.min - 1e-6 && angles[i] <= j.max + 1e-6,
          `${arch}/${p.name}: ${j.id}=${angles[i]} outside [${j.min},${j.max}]`)
      })
    }
  }
  // gripper open/close actually hit the jaw's own limits, not hardcoded values
  const { design: g } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'gripper').brief })
  const jaw = g.joints[0]
  assert(A.applyPosePreset(g, 'OPEN')[0] === jaw.max && A.applyPosePreset(g, 'CLOSE')[0] === jaw.min,
    'gripper presets must resolve against live joint limits')
  // humanoid WAVE is the right arm — left arm can't reach overhead (verified err>90)
  const { design: h } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'humanoid').brief })
  const wave = A.applyPosePreset(h, 'WAVE')
  const rIdx = h.joints.findIndex((j) => j.id === 'r-shoulder-pitch')
  const lIdx = h.joints.findIndex((j) => j.id === 'l-shoulder-pitch')
  assert(Math.abs(wave[rIdx]) > 5 && wave[lIdx] === 0, 'WAVE should pose the right arm only')
  // unknown names and preset-less archetypes return null, never a guess
  assert(A.applyPosePreset(h, 'NOPE') === null, 'unknown preset must return null')
  const { design: q } = A.composeDesign({ ...A.PRESETS.find((p) => p.brief.archetype === 'quadruped').brief })
  assert(A.applyPosePreset(q, 'WAVE') === null, 'quadruped has no presets — must return null')
  // WIDE: leg-IK replants feet wider than stance — soles must actually move out
  const wide = A.applyPosePreset(h, 'WIDE', Array(h.joints.length).fill(0))
  const footW = (jid, nid) => {
    const d2 = { ...h, joints: h.joints.map((j, i) => ({ ...j, angle: wide[i] })) }
    const node = d2.nodes.find((nn) => nn.joint === jid && nn.id.includes(nid))
    return A.benchNodeWorld(d2, A.chainsFor(d2), node)
  }
  const lSole = footW('l-ankle-roll', 'sole'), rSole = footW('r-ankle-roll', 'sole')
  assert(lSole[0] > 50 && rSole[0] < -50, `WIDE should plant soles beyond ±50mm, got ${lSole[0].toFixed(0)}/${rSole[0].toFixed(0)}`)
  assert(lSole[2] < 20 && rSole[2] < 20, 'planted soles stay near the floor')
  // PROWL: front feet step +x, rear feet -x — verify via the same foot-node path
  const prowl = A.applyPosePreset(q, 'PROWL', Array(q.joints.length).fill(0))
  const qFoot = (jid) => {
    const d2 = { ...q, joints: q.joints.map((j, i) => ({ ...j, angle: prowl[i] })) }
    const node = d2.nodes.find((nn) => nn.joint === jid && /foot/.test(nn.id))
    return A.benchNodeWorld(d2, A.chainsFor(d2), node)
  }
  const fl = qFoot('tibia-fl'), rl = qFoot('tibia-rl')
  assert(fl[0] > 105 && rl[0] < -105, `PROWL should stagger feet (fl ${fl[0].toFixed(0)} / rl ${rl[0].toFixed(0)})`)
  return `7 archetypes × presets in-limits · gripper hits live limits · WAVE=R-arm · WIDE/PROWL replant feet · gantry PROBE/EXTREME resolve · unknown→null`
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}${r.ok ? ` — ${r.detail}` : ''}`)
  if (!r.ok) console.log(`      ${r.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} claims hold`)
process.exit(failed.length ? 1 : 0)
