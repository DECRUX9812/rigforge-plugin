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

// ── 10. build codes round-trip ───────────────────────────────────────────────
check('build code round-trips to the same machine', () => {
  eachPreset((p, { design }) => {
    const code = A.encodeBuild(p.brief)
    assert(/^RF1-/.test(code), `${p.id}: code does not start RF1-`)
    assert(code.length < 400, `${p.id}: code is ${code.length} chars`)
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
  })
  return 'cost, mass and print time agree'
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}${r.ok ? ` — ${r.detail}` : ''}`)
  if (!r.ok) console.log(`      ${r.detail}`)
}
console.log(`\n${results.length - failed.length}/${results.length} claims hold`)
process.exit(failed.length ? 1 : 0)
