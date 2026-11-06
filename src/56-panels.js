// ── the spec rail: seven tabs, each answering one build question ────────────

// Camera presets, one source for the toolbar's radio group.
const VIEWS = [
  ['ISO', -0.62, 0.42],
  ['FRONT', -Math.PI / 2, 0.02],
  ['SIDE', 0, 0.02],
  ['TOP', -Math.PI / 2, 1.44],
]

const TABS = [
  ['spec', 'SPEC'], ['test', 'TEST'], ['parts', 'BOM'], ['pins', 'PINS'],
  ['power', 'PWR'], ['print', 'PRINT'], ['assembly', 'ASSY'], ['code', 'CODE'], ['steps', 'STEPS'],
]

function KV({ k, v, accent }) {
  return h('div', { style: { display: 'contents' } },
    h('div', { style: S.kvKey }, k),
    h('div', { style: { ...S.kvVal, color: accent || C.text } }, v))
}

function StatBlock({ label, value, sub, color }) {
  return h('div', {
    style: {
      border: `1px solid ${C.line}`, borderRadius: '7px', padding: '8px 10px',
      background: C.panel2, minWidth: 0,
    },
  },
    h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.14em', color: C.faint } }, label),
    h('div', { style: { fontFamily: C.mono, fontSize: '17px', fontWeight: 600, color: color || C.text, marginTop: '3px' } }, value),
    sub ? h('div', { style: { fontSize: '10px', color: C.faint, marginTop: '2px' } }, sub) : null)
}

function CheckRow({ c }) {
  return h('div', { style: { ...S.warn, background: levelBg(c.level), borderLeft: `2px solid ${levelColor(c.level)}` } },
    h('span', { style: { color: levelColor(c.level), fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', paddingTop: '2px' } },
      c.level === 'ok' ? 'PASS' : c.level.toUpperCase()),
    h('span', { style: { color: C.dim, flex: '1' } }, c.msg))
}

function TabSpec({ design, analysis }) {
  const m = design.metrics || {}
  const a = analysis
  // The header already carries cost/mass/peak/print: the spec tab shows the
  // decomposition instead of repeating the same four numbers.
  const blocks = [
    h('div', { style: { ...S.kv, paddingBottom: '10px', borderBottom: `1px solid ${C.line}`, marginBottom: '12px' } },
      h(KV, { k: 'mass', v: `${Math.round(a.mass.partsG)}g hardware + ${Math.round(a.mass.printedG)}g printed` }),
      h(KV, { k: 'envelope', v: `${a.dims.map((d) => Math.round(d)).join(' × ')} mm` }),
      h(KV, { k: 'controller', v: `${a.mcu.name} · ${a.mcu.logic}V` }),
      h(KV, { k: 'print', v: `${fmt(a.print.hours, 1)}h · ${Math.round(a.print.grams)}g ${a.print.material.name}` }),
      h(KV, {
        k: 'energy',
        v: a.power.runtimeMin ? `${fmt(a.power.typ, 2)}A typ → ~${Math.round(a.power.runtimeMin)} min` : `tethered · ${fmt(a.power.typ, 2)}A typ`,
      }),
      h(KV, { k: 'part count', v: `${design.parts.reduce((s, p) => s + p.qty, 0)} units over ${design.parts.length} line items` })),
  ]

  blocks.push(h('div', { style: S.sectionLabel }, 'readiness'))
  {
    const fails = a.checks.filter((c) => c.level === 'fail').length
    const warns = a.checks.filter((c) => c.level === 'warn').length
    const plain = fails
      ? `Hold on — ${fails} thing${fails > 1 ? 's' : ''} must be fixed before this is safe to build.`
      : warns
        ? `Buildable, but read the ${warns} warning${warns > 1 ? 's' : ''} below first.`
        : 'Ready to build — every engineering check passed.'
    blocks.push(h('div', {
      style: {
        fontSize: '12px', color: C.text, lineHeight: 1.45, marginBottom: '10px',
        padding: '8px 10px', borderRadius: '6px', border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${fails ? C.red : warns ? C.amber : C.green}`,
        background: fails ? 'rgba(255,95,86,0.08)' : warns ? 'rgba(255,194,74,0.07)' : 'rgba(78,208,138,0.07)',
      },
    }, plain))
  }
  for (const c of a.checks) blocks.push(h(CheckRow, { c }))

  if (design.actuators && design.actuators.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'actuator sizing @ full extension'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'JOINT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'NEED'),
        h('th', { style: S.th }, 'PART'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'STALL'))),
      h('tbody', {}, design.actuators.map((x) => h('tr', { key: x.label },
        h('td', { style: S.td }, x.label),
        h('td', { style: S.tdNum }, `${fmt(x.need, 2)} N·m`),
        h('td', { style: S.td }, x.ratio === 0 ? '— needs another drive' : PARTS[x.servo].name.replace(/ servo| standard| micro/g, '')),
        h('td', {
          style: {
            ...S.tdNum,
            color: x.ratio === 0 ? C.red : (x.effective || PARTS[x.servo].torque) >= x.need ? C.green : C.red,
          },
        },
          x.ratio === 0 ? 'out of scope' : `${fmt(x.effective || PARTS[x.servo].torque, 2)} N·m${x.ratio > 1 ? ` ${x.ratio}:1` : ''}`))))))
  }

  if (design.mech && design.mech.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'mechanics'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'CHECK'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'VALUE'),
        h('th', { style: S.th }, 'LIMIT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'OK'))),
      h('tbody', {}, design.mech.map((r) => h('tr', { key: r.label },
        h('td', { style: S.td }, r.label),
        h('td', { style: S.tdNum }, r.value),
        h('td', { style: { ...S.td, color: C.faint } }, r.limit),
        h('td', { style: { ...S.tdNum, color: r.ok == null ? C.faint : r.ok ? C.green : C.red } },
          r.ok == null ? '·' : r.ok ? '✓' : '✗'))))))
  }

  if (m.motor) {
    const mp = PARTS[m.motor]
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'drivetrain'))
    blocks.push(h('div', { style: S.kv },
      h(KV, { k: 'motor', v: mp.name }), h(KV, { k: 'torque / wheel', v: `${fmt(m.torquePerWheel, 3)} N·m need` }),
      h(KV, { k: 'available', v: `${fmt(mp.torque, 2)} N·m stall`, accent: C.green }),
      h(KV, { k: 'top speed', v: `${fmt(m.speedMps * 3.6, 1)} km/h` }),
      h(KV, { k: 'drive mass', v: `${fmt(m.massKg, 1)} kg` })))
  }
  if (m.peakAmps) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'gait power'))
    blocks.push(h('div', { style: S.kv },
      h(KV, { k: 'servo', v: PARTS[m.servo].name }),
      h(KV, { k: 'joints', v: String(m.joints) }),
      h(KV, { k: 'peak gait', v: `${fmt(m.peakAmps, 1)} A`, accent: C.amber }),
      h(KV, { k: 'leg', v: `${m.legMm} mm` })))
  }
  if (m.gripForceN) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'grip'))
    blocks.push(h('div', { style: S.kv },
      h(KV, { k: 'jaw force', v: `${fmt(m.gripForceN, 0)} N` }),
      h(KV, { k: 'holds (rubber)', v: `${fmt(m.gripMassKg, 1)} kg` }),
      h(KV, { k: 'opening', v: `${m.spanMm} mm` })))
  }

  if (design.notes.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'design notes'))
    for (const n of design.notes) {
      blocks.push(h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.5, marginBottom: '6px', paddingLeft: '8px', borderLeft: `1px solid ${C.line}` } }, n))
    }
  }
  return h('div', { style: { display: 'contents' } }, ...blocks)
}

/** TEST: the pre-print bench. Would this machine stand, climb and hold? */
function TabTest({ design, analysis, certHistory }) {
  const [slope, setSlope] = useState(15)
  const r = useMemo(() => benchReport(design, analysis, { mat: analysis.print.material, slopeDeg: slope }), [design, analysis, slope])
  const worst = r.verdicts.some((v) => v.status === 'fail') ? 'fail' : r.verdicts.some((v) => v.status === 'warn') ? 'warn' : 'ok'
  const vc = (s) => (s === 'pass' ? 'ok' : s)
  const blocks = []

  blocks.push(h('div', {
    style: {
      fontSize: '12.5px', color: C.text, lineHeight: 1.5, marginBottom: '12px',
      padding: '10px 12px', borderRadius: '7px',
      border: `1px solid ${C.line}`, borderLeft: `3px solid ${levelColor(worst)}`,
      background: levelBg(worst),
    },
  }, worst === 'ok'
    ? `Bench says go — ${Math.round(r.massG)}g machine, ${r.contacts}-point support polygon, worst joint at ${r.torques.length ? Math.min(...r.torques.map((t) => t.margin)).toFixed(1) : '—'}× stall margin.`
    : worst === 'warn'
      ? 'Bench has concerns — read the warnings below before you print.'
      : 'Bench says stop — this design fails a pre-print check. Fix it before spending filament.'))

  blocks.push(h('div', { style: S.sectionLabel }, 'scenario: ramp test'))
  blocks.push(h('div', { style: { ...S.field, marginBottom: '4px' } },
    h('div', { style: S.label },
      h('span', {}, 'incline angle'),
      h('span', { style: { fontFamily: C.mono, color: slope > 20 ? C.amber : C.text } }, `${slope}°`)),
    h('input', {
      type: 'range', min: 0, max: 35, step: 1, value: slope,
      onInput: (e) => setSlope(Number(e.target.value)),
      style: { width: '100%', accentColor: C.accent },
      'aria-label': 'ramp incline angle in degrees',
    }),
    h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '4px' } },
      `CoM margin on the slope plane: ${Math.round(r.slopeMm)}mm ${r.slopeMm > 0 ? '(stable)' : '(tipping)'}`)))

  blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'verdicts'))
  for (const v of r.verdicts) {
    blocks.push(h('div', { style: { ...S.warn, background: levelBg(vc(v.status)), borderLeft: `2px solid ${levelColor(vc(v.status))}`, marginBottom: '6px' } },
      h('span', { style: { color: levelColor(vc(v.status)), fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', paddingTop: '2px' } },
        v.status === 'pass' ? 'PASS' : v.status.toUpperCase()),
      h('span', { style: { color: C.dim, flex: '1' } }, `${v.label} — ${v.detail}`)))
  }

  if (r.torques.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'joint torque vs stall (this pose)'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'JOINT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'NEEDS'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'STALL'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'MARGIN'))),
      h('tbody', {}, r.torques.map((t) => {
        const col = t.margin > 1.5 ? C.green : t.margin > 1 ? C.amber : C.red
        return h('tr', { key: t.joint },
          h('td', { style: S.td }, t.label),
          h('td', { style: S.tdNum }, `${t.needNm.toFixed(2)} N·m`),
          h('td', { style: S.tdNum }, `${t.stallNm.toFixed(2)} N·m`),
          h('td', { style: { ...S.tdNum, color: col } }, `${t.margin.toFixed(1)}×`))
      }))))
  }

  blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'mass & balance'))
  blocks.push(h('div', { style: S.kv },
    h(KV, { k: 'total mass', v: `${Math.round(r.massG)} g` }),
    h(KV, { k: 'centre of mass', v: `${Math.round(r.com[0])}, ${Math.round(r.com[1])}, ${Math.round(r.com[2])} mm` }),
    h(KV, { k: 'support polygon', v: `${r.hull.length} hull pts · ${r.contacts} contacts` }),
    h(KV, { k: 'flat margin', v: `${Math.round(r.flatMm)} mm`, accent: r.flatMm > 15 ? C.green : r.flatMm > 0 ? C.amber : C.red })))
  blocks.push(h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, marginTop: '10px' } },
    'Rigid-body statics at the current pose — CoM is mass-weighted over every node, the support polygon is the convex hull of ground contacts, and torque is exact r×F about each joint axis. It answers "will it stand, climb and hold?" before you spend filament.'))

  const arch = design.archetype || (design.brief && design.brief.archetype)
  const hist = (certHistory || []).filter((x) => x.arch === arch).slice(-8).reverse()
  if (hist.length) {
    blocks.push(h('div', { style: { ...S.sectionLabel, marginTop: '16px' } }, 'autopilot certification history'))
    blocks.push(h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'RUN'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'SCORE'),
        h('th', { style: S.th }, 'PHASES'))),
      h('tbody', {}, hist.map((x, i) => h('tr', { key: i },
        h('td', { style: { ...S.td, color: C.faint } }, `${x.mode} · ${new Date(x.ts).toLocaleDateString()}`),
        h('td', { style: { ...S.tdNum, color: x.passes === x.total ? C.green : x.passes > x.total / 2 ? C.amber : C.red, fontWeight: 700 } }, `${x.passes}/${x.total}`),
        h('td', { style: { ...S.td, color: C.faint, fontSize: '10px' } }, x.phases))))))
    // trend strip: one bar per run, oldest → newest; height is the pass ratio
    blocks.push(h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '34px', marginTop: '8px' } },
      [...hist].reverse().map((x, i) => {
        const ratio = x.total ? x.passes / x.total : 0
        return h('div', {
          key: i,
          title: `${x.mode} · ${x.passes}/${x.total} · ${new Date(x.ts).toLocaleDateString()}`,
          style: {
            flex: 1, height: `${Math.max(8, ratio * 100)}%`, borderRadius: '2px 2px 0 0',
            background: ratio === 1 ? C.green : ratio > 0.5 ? C.amber : C.red, opacity: 0.85,
          },
        })
      })))
    blocks.push(h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '6px' } },
      'Each AUTO run is scored by measured sim results — distance, stall time, climb height, carried mass — and kept here so you can see whether a design change actually helped. The strip is the same history as bars: green full-pass, amber partial, red failing.'))
  }
  return h('div', { style: { display: 'contents' } }, ...blocks)
}

function TabParts({ design, analysis }) {
  const rows = design.parts.map((p) => ({ ...p, part: PARTS[p.key] }))
  rows.sort((x, y) => y.part.price * y.qty - x.part.price * x.qty)
  return h('div', { style: { display: 'contents' } }, ...[
    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'PART'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'QTY'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'LINE'))),
      h('tbody', {}, rows.map((r) => h('tr', { key: r.key },
        h('td', { style: S.td },
          h('div', { style: { color: C.text } }, r.part.name),
          h('div', { style: { color: C.faint, fontSize: '9.5px', marginTop: '2px', lineHeight: 1.4 } },
            [r.role, r.part.dims ? r.part.dims.join('×') + 'mm' : '', r.part.sku ? `⌕ ${r.part.sku}` : '', r.part.note].filter(Boolean).join(' · '))),
        h('td', { style: { ...S.tdNum, color: C.dim } }, `×${r.qty}`),
        h('td', { style: S.tdNum }, money(r.part.price * r.qty)))))),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${C.line}`, fontFamily: C.mono, fontSize: '11px' } },
      h('span', { style: { color: C.faint } }, `FILAMENT ${Math.round(analysis.print.grams)}g`),
      h('span', { style: { color: C.accent, fontWeight: 600 } }, `TOTAL ${money(analysis.cost)}`)),
  ])
}

function TabPins({ analysis }) {
  const rows = analysis.pins.rows
  const dirColor = (d) => (d === 'pwr' ? C.amber : d === 'in' ? C.green : d === 'bus' || d === 'pwm' ? C.cyan : C.dim)
  // A 380px rail cannot carry four table columns: pin + signal on one line,
  // the annotation underneath. Same data, half the wrapping.
  return h('div', { style: { display: 'contents' } }, ...[
    h('div', { style: { fontSize: '11px', color: C.dim, marginBottom: '10px', lineHeight: 1.5 } },
      `${analysis.mcu.name} · ${rows.length} assignments · ${analysis.mcu.pinBudget} GPIO available. ` +
      `Strapping pins 0/3/45/46 and the SPI flash bus are never allocated.`),
    ...rows.map((r, i) => {
      const prev = rows[i - 1]
      const groupBreak = r.part && (!prev || prev.part !== r.part)
      return h('div', {
      key: `${r.pin}-${i}`,
      style: {
        display: 'grid', gridTemplateColumns: '46px 1fr auto', columnGap: '8px',
        padding: '6px 0', borderBottom: `1px solid ${C.lineSoft}`, alignItems: 'baseline',
        marginTop: groupBreak ? '10px' : 0,
        borderTop: groupBreak ? `1px solid ${C.line}` : 'none',
      },
    },
      h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.cyan } }, r.pin),
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '11.5px', color: C.text } }, r.signal),
          r.part ? h('span', { style: { fontFamily: C.mono, fontSize: '9px', color: C.faint } }, r.part.replace(/ servo| standard| micro/g, '')) : null),
        r.note ? h('div', { style: { fontFamily: C.mono, fontSize: '9.5px', color: C.faint, marginTop: '1px', whiteSpace: 'nowrap' } }, r.note) : null),
      h('span', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.08em', color: dirColor(r.dir) } }, r.dir))
    }),
  ])
}

function TabPower({ analysis }) {
  const { rails, bat, typ, peak } = analysis.power
  const max = Math.max(peak, 0.001)
  const bars = Object.entries(rails).filter(([, v]) => v.peak > 0).map(([name, v]) =>
    h('div', { key: name, style: { marginBottom: '10px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '10px', marginBottom: '3px' } },
        h('span', { style: { color: C.dim } }, `${name} rail`),
        h('span', { style: { color: C.text } }, `${fmt(v.typ, 2)}A / ${fmt(v.peak, 2)}A`)),
      h('div', { style: { height: '5px', background: C.panel2, borderRadius: '3px', overflow: 'hidden' } },
        h('div', { style: { width: `${(v.typ / max) * 100}%`, height: '100%', background: C.green } })),
      h('div', { style: { height: '5px', background: C.panel2, borderRadius: '3px', overflow: 'hidden', marginTop: '2px' } },
        h('div', { style: { width: `${(v.peak / max) * 100}%`, height: '100%', background: C.accent } })),
      h('div', { style: { fontSize: '10px', color: C.faint, marginTop: '3px' } },
        v.items.map((i) => `${PARTS[i.key].name.split(' ')[0]} ${fmt(i.peak, 2)}A`).join(' · '))))

  return h('div', { style: { display: 'contents' } }, ...[
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } },
      h(StatBlock, { label: 'TYPICAL', value: `${fmt(typ, 2)}A` }),
      h(StatBlock, { label: 'PEAK', value: `${fmt(peak, 2)}A`, color: C.accent })),
    ...bars,
    analysis.power.wiring && analysis.power.wiring.length
      ? h('div', {},
        h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'wiring'),
        h('table', { style: S.table },
          h('thead', {}, h('tr', {},
            h('th', { style: S.th }, 'RAIL'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'DRAW'),
            h('th', { style: { ...S.th, textAlign: 'right' } }, 'WIRE (PEAK)'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'FUSE'),
            h('th', { style: S.th }, 'CONNECTOR'))),
          h('tbody', {}, analysis.power.wiring.map((w) => h('tr', { key: w.rail },
            h('td', { style: S.td }, w.rail),
            h('td', { style: S.tdNum }, `${fmt(w.amps, 2)}A`),
            h('td', { style: { ...S.tdNum, color: w.over ? C.red : C.cyan } },
              w.over ? '>14 AWG' : `${w.awg} AWG · ${w.ampacity}A`),
            h('td', { style: { ...S.tdNum, color: w.fuse ? C.amber : C.faint } }, w.fuse ? `${w.fuse}A` : '—'),
            h('td', { style: { ...S.td, color: C.faint, fontSize: '9.5px' } }, w.conn))))),
      )
      : null,
    analysis.harness && analysis.harness.rows.length
      ? h('div', {},
        h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'servo harness'),
        h('table', { style: S.table },
          h('thead', {}, h('tr', {},
            h('th', { style: S.th }, 'JOINT'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'RUN'),
            h('th', { style: S.th }, 'LEAD'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'V DROP'))),
          h('tbody', {}, analysis.harness.rows.map((r) => h('tr', { key: r.id },
            h('td', { style: S.td }, r.label || r.id),
            h('td', { style: S.tdNum }, `~${r.run}mm`),
            h('td', { style: { ...S.td, color: r.lead === 'extend' ? C.red : r.lead === 'check' ? C.amber : C.faint, fontSize: '9.5px' } },
              r.lead === 'daisy-chain' ? 'TTL bus' : r.lead === 'stock' ? 'stock ok' : r.lead === 'check' ? 'check lead' : r.lead === 'extend' ? 'needs ext.' : r.lead),
            h('td', { style: { ...S.tdNum, color: r.vdrop > 0.5 ? C.red : C.faint } }, `${r.vdrop}V`))))),
        h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '6px', lineHeight: 1.5 } },
          analysis.harness.note +
          `  Run total ~${(analysis.harness.rows.reduce((s, r) => s + (r.run || 0), 0) / 1000).toFixed(2)} m` +
          (analysis.harness.rows.some((r) => r.lead === 'extend') ? ' — extension leads are in the BOM.' : '.')))
      : null,
    h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'energy'),
    h('div', { style: S.kv },
      bat ? h(KV, { k: 'pack', v: bat.name }) : h(KV, { k: 'source', v: 'n/a' }),
      bat ? h(KV, { k: 'voltage', v: `${bat.volts} V` }) : null,
      bat ? h(KV, { k: 'capacity', v: bat.mah ? `${bat.mah} mAh` : 'tethered' }) : null,
      bat ? h(KV, { k: 'burst limit', v: `${bat.maxA} A` }) : null,
      analysis.power.runtimeMin
        ? h(KV, { k: 'runtime @ 80% DoD', v: `${Math.round(analysis.power.runtimeMin)} min`, accent: C.cyan })
        : null),
    h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '10px', lineHeight: 1.55 } },
      'Green = typical draw, orange = worst case with every actuator at stall. The wire is sized for the orange bar (its ampacity is printed beside it) and the fuse never exceeds that ampacity — a fuse bigger than its wire protects nothing. A fuse below stall current is normal: it is protecting the wire, not the servo.'),
  ])
}

function TabPrint({ design, analysis }) {
  const nodes = design.nodes.filter((n) => n.print)
  const rows = nodes
    .map((n) => ({ id: n.id, name: prettyPart(n.id), kind: n.kind, mm3: shellVolume(n), dims: nodeHalf(n).map((x) => x * 2) }))
    .sort((a, b) => b.mm3 - a.mm3)
  const total = rows.reduce((s, r) => s + r.mm3, 0) || 1
  const overhang = new Map((analysis.print.overhang ? analysis.print.overhang.parts : []).map((p) => [p.id, p]))
  const supportG = overhang.size ? [...overhang.values()].reduce((s, p) => s + p.unsupported, 0) : 0
  return h('div', { style: { display: 'contents' } }, ...[
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } },
      h(StatBlock, { label: 'FILAMENT', value: `${Math.round(analysis.print.grams)}g`, sub: `${(analysis.print.grams / 1000).toFixed(2)} of a 1kg spool` }),
      h(StatBlock, { label: 'MACHINE TIME', value: `${fmt(analysis.print.hours, 1)}h`, sub: `${rows.length} parts · largest ${Math.round(analysis.printFit ? analysis.printFit.worst.largest : 0)}mm on a ${analysis.printFit ? analysis.printFit.bed : 256}mm bed` })),
    analysis.print.pack && analysis.print.pack.items.length
      ? (() => {
        const pk = analysis.print.pack
        return h('div', { style: { marginBottom: '12px' } },
          h('svg', {
            viewBox: `0 0 ${pk.bed} ${pk.bed}`, width: '100%', height: 'auto',
            style: { display: 'block', borderRadius: '6px', border: `1px solid ${C.line}`, background: C.panel2 },
            role: 'img', 'aria-label': `print bed layout — ${pk.items.length} parts, ${pk.offBed} off-bed`,
          },
            h('rect', { x: 8, y: 8, width: pk.usable, height: pk.usable, fill: 'none', stroke: C.faint, strokeWidth: 1, strokeDasharray: '4 3', opacity: 0.5 }),
            ...pk.items.map((it) => h('rect', {
              key: it.id, x: it.rect.x, y: it.rect.y, width: it.rect.w, height: it.rect.d,
              fill: it.offBed ? C.red : C.accent, fillOpacity: it.offBed ? 0.35 : 0.16,
              stroke: it.offBed ? C.red : C.accent, strokeWidth: 1,
              style: { cursor: 'default' },
            }, h('title', {}, `${prettyPart(it.id)} — ${Math.round(it.rect.w)}×${Math.round(it.rect.d)}mm${it.offBed ? ' · OFF BED' : ''}`))),
            h('text', { x: 10, y: pk.bed - 6, fill: C.faint, fontSize: 9, fontFamily: C.mono },
              `${pk.bed}mm bed · ${pk.items.length} parts${pk.offBed ? ` · ${pk.offBed} off-bed → ~${pk.plates} plate(s)` : ' · fits one plate'}`)))
      })()
      : null,
    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'PART'), h('th', { style: S.th }, 'SIZE'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'GRAMS'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'TIME'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'SUPPORT'))),
      h('tbody', {}, rows.map((r) => {
        const oh = overhang.get(r.id)
        const sup = oh && oh.unsupported > 0 ? oh.unsupported : 0
        return h('tr', { key: r.id },
          h('td', { style: { ...S.td, color: C.text } }, r.name),
          h('td', { style: { ...S.td, color: C.faint } }, r.dims.map((d) => Math.round(d)).join('×')),
          h('td', { style: S.tdNum }, fmt((r.mm3 / total) * analysis.print.grams, 1)),
          h('td', { style: { ...S.tdNum, color: C.faint } }, (() => {
            const mins = (r.mm3 / 18000) * 60
            return mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${Math.max(1, Math.round(mins))}m`
          })()),
          h('td', { style: { ...S.tdNum, color: sup > 50 ? C.amber : C.faint } }, sup > 0 ? `${Math.round(sup)}` : '—'))
      }))),
    h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'print advice'),
    h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.6 } },
      `Material: ${analysis.print.material.name}. 3 walls, 25% gyroid, 0.2mm layers. TIME is extrusion only — add ~15–20 min heat-up per part on top. ` +
      `Orient load-bearing links so the layers run ALONG the load — a printed cantilever fails at the layer line, not at the design stress. ` +
      `Parts longer than your bed are split automatically with joiner plates — the notes say which seams to glue. Every STL in the pack is laid flat by measured bed contact, centred and sitting on Z=0, so a slicer opens it ready to slice. Heat-set inserts beat printed threads every time.` +
      (supportG > 0
        ? ` SUPPORT column is mm² of surface hanging in mid-air — budget roughly 2× that in support filament and expect scars on those faces.`
        : ' SUPPORT column is clean — nothing hangs in mid-air, no support material needed.') +
      ((analysis.print.overhang.brim || []).length
        ? ` BRIM: ${analysis.print.overhang.brim.map((p) => prettyPart(p.id)).join(', ')} touch the bed on under 30% of their footprint — enable a brim or the first layer can lift.`
        : '')),
    h('div', { style: { marginTop: '10px' } },
      h('button', {
        style: { ...S.btn, height: '28px' },
        onClick: () => download(`${slug(design.title)}.scad`, toOpenSCAD(design), 'text/plain'),
      }, 'Download OpenSCAD')),
  ])
}

function TabCode({ design }) {
  const lines = design.firmware.split('\n').length
  return h('div', { style: { display: 'contents' } }, ...[
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
      h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, `${lines} lines · arduino-cli · 115200`),
      h('button', {
        style: { ...S.btn, height: '26px' },
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(design.firmware)
            host.notify({ kind: 'success', message: 'Firmware copied' })
          } catch {
            download('firmware.ino', design.firmware, 'text/plain')
          }
        },
      }, 'Copy')),
    h('pre', { style: S.pre }, design.firmware),
  ])
}

function TabSteps({ design, analysis }) {
  return h('div', { style: { display: 'contents' } }, ...[
    ...design.steps.map((s) => h('div', { key: s.n, style: S.step },
      h('div', { style: S.stepNo }, String(s.n)),
      h('div', { style: { flex: '1', minWidth: 0 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' } },
          h('div', { style: { fontSize: '12px', fontWeight: 600, color: C.text } }, s.title),
          h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, whiteSpace: 'nowrap' } }, fmtMinutes(s.min))),
        h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.55, marginTop: '2px' } }, s.detail),
        s.tools.length
          ? h('div', { style: { fontFamily: C.mono, fontSize: '9.5px', color: C.cyan, marginTop: '4px', letterSpacing: '0.04em' } }, s.tools.join(' · '))
          : null))),
    h('div', { style: { marginTop: '6px', paddingTop: '10px', borderTop: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '10.5px' } },
      h('span', { style: { color: C.faint } }, 'ESTIMATED BUILD'),
      h('span', { style: { color: C.text } }, `${(design.steps.reduce((s, x) => s + x.min, 0) / 60).toFixed(1)} h`)),
    h('div', { style: { height: '20px' } }),
  ])
}
