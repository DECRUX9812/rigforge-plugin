// ── the spec rail: seven tabs, each answering one build question ────────────

// Camera presets, one source for the toolbar's radio group.
const VIEWS = [
  ['ISO', -0.62, 0.42],
  ['FRONT', -Math.PI / 2, 0.02],
  ['SIDE', 0, 0.02],
  ['TOP', -Math.PI / 2, 1.44],
]

const TABS = [
  ['spec', 'SPEC'], ['parts', 'BOM'], ['pins', 'PINS'],
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
        h('td', { style: S.td }, PARTS[x.servo].name.replace(/ servo| standard| micro/g, '')),
        h('td', { style: { ...S.tdNum, color: (x.effective || PARTS[x.servo].torque) >= x.need ? C.green : C.red } },
          `${fmt(x.effective || PARTS[x.servo].torque, 2)} N·m${x.ratio > 1 ? ` ${x.ratio}:1` : ''}`))))))
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
  return blocks
}

function TabParts({ design, analysis }) {
  const rows = design.parts.map((p) => ({ ...p, part: PARTS[p.key] }))
  rows.sort((x, y) => y.part.price * y.qty - x.part.price * x.qty)
  return [
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
  ]
}

function TabPins({ analysis }) {
  const rows = analysis.pins.rows
  const dirColor = (d) => (d === 'pwr' ? C.amber : d === 'in' ? C.green : d === 'bus' || d === 'pwm' ? C.cyan : C.dim)
  // A 380px rail cannot carry four table columns: pin + signal on one line,
  // the annotation underneath. Same data, half the wrapping.
  return [
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
  ]
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

  return [
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
            h('th', { style: { ...S.th, textAlign: 'right' } }, 'WIRE'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'FUSE'),
            h('th', { style: S.th }, 'CONNECTOR'))),
          h('tbody', {}, analysis.power.wiring.map((w) => h('tr', { key: w.rail },
            h('td', { style: S.td }, w.rail),
            h('td', { style: S.tdNum }, `${fmt(w.amps, 2)}A`),
            h('td', { style: { ...S.tdNum, color: C.cyan } }, `${w.awg} AWG`),
            h('td', { style: { ...S.tdNum, color: w.fuse ? C.amber : C.faint } }, w.fuse ? `${w.fuse}A` : '—'),
            h('td', { style: { ...S.td, color: C.faint, fontSize: '9.5px' } }, w.conn))))),
      )
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
      'Green = typical draw, orange = worst case with every actuator at stall. Design the wiring for the orange bar, and the fuse between them.'),
  ]
}

function TabPrint({ design, analysis }) {
  const nodes = design.nodes.filter((n) => n.print)
  const rows = nodes
    .map((n) => ({ id: n.id, kind: n.kind, mm3: shellVolume(n), dims: nodeHalf(n).map((x) => x * 2) }))
    .sort((a, b) => b.mm3 - a.mm3)
  const total = rows.reduce((s, r) => s + r.mm3, 0) || 1
  return [
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '12px' } },
      h(StatBlock, { label: 'FILAMENT', value: `${Math.round(analysis.print.grams)}g`, sub: `${(analysis.print.grams / 1000).toFixed(2)} of a 1kg spool` }),
      h(StatBlock, { label: 'MACHINE TIME', value: `${fmt(analysis.print.hours, 1)}h`, sub: `${rows.length} parts` })),
    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'PART'), h('th', { style: S.th }, 'SIZE'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'GRAMS'))),
      h('tbody', {}, rows.map((r) => h('tr', { key: r.id },
        h('td', { style: { ...S.td, color: C.text } }, r.id),
        h('td', { style: { ...S.td, color: C.faint } }, r.dims.map((d) => Math.round(d)).join('×')),
        h('td', { style: S.tdNum }, fmt((r.mm3 / total) * analysis.print.grams, 1)))))),
    h('div', { style: { ...S.sectionLabel, marginTop: '14px' } }, 'print advice'),
    h('div', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.6 } },
      `Material: ${analysis.print.material.name}. 3 walls, 25% gyroid, 0.2mm layers. ` +
      `Orient load-bearing links so the layers run ALONG the load — a printed cantilever fails at the layer line, not at the design stress. ` +
      `Anything over 200mm should be split with dovetails or bolted flanges; heat-set inserts beat printed threads every time.`),
    h('div', { style: { marginTop: '10px' } },
      h('button', {
        style: { ...S.btn, height: '28px' },
        onClick: () => download(`${slug(design.title)}.scad`, toOpenSCAD(design), 'text/plain'),
      }, 'Download OpenSCAD')),
  ]
}

function TabCode({ design }) {
  const lines = design.firmware.split('\n').length
  return [
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
  ]
}

function TabSteps({ design, analysis }) {
  return [
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
  ]
}
