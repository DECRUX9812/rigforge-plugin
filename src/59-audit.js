// ── audit: show the working ─────────────────────────────────────────────────
// Every headline number in this tool is a sum you could do by hand. That is the
// whole claim, so the claim is checkable: this dialog prints the formula, the
// inputs, and the parts that dominate the total. A number you cannot trace is a
// number you have to trust; a number you can trace is a product.

function pct(part, whole) {
  if (!whole || !isFinite(whole)) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

/** Top contributors by line cost, biggest first. */
function costContributors(design, limit = 5) {
  return design.parts
    .map(({ key, qty }) => ({ key, qty, part: PARTS[key] }))
    .filter((r) => r.part)
    .map((r) => ({ name: r.part.name, qty: r.qty, line: r.part.price * r.qty, unit: r.part.price, shop: !!r.part.shop }))
    .sort((a, b) => b.line - a.line)
    .slice(0, limit)
}

function massContributors(design, limit = 4) {
  return design.parts
    .map(({ key, qty }) => ({ key, qty, part: PARTS[key] }))
    .filter((r) => r.part && !r.part.print && !r.part.shop && r.part.mass > 0)
    .map((r) => ({ name: r.part.name, qty: r.qty, line: r.part.mass * r.qty }))
    .sort((a, b) => b.line - a.line)
    .slice(0, limit)
}

function AuditDialog({ open, onClose, design, analysis }) {
  if (!open) return null
  const mat = MATERIALS[design.brief.material] || MATERIALS.petg
  const printed = design.nodes.filter((n) => n.mat === 'shell' || n.print)
  const cutoff = ['finger', 'jaw'].includes(design.archetype) // unused, kept explicit
  void cutoff

  const shopTotal = design.parts.reduce((s, { key, qty }) => (PARTS[key]?.shop ? s + PARTS[key].price * qty : s), 0)
  const units = design.parts.reduce((s, p) => s + p.qty, 0)
  const printGrams = analysis.print.grams
  const spoolCost = (printGrams / 1000) * (PARTS[mat.priceId]?.price || 20)
  const volCm3 = analysis.print.grams / (mat.density || 1.24)
  const power = analysis.power

  const section = (title, formula, rows, total) => h('div', { style: { marginBottom: '18px' } },
    h('div', { style: { ...S.sectionLabel, marginBottom: '4px' } }, title),
    h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.accent, marginBottom: '8px' } }, formula),
    rows,
    total ? h('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', gap: '10px', paddingTop: '6px',
        marginTop: '4px', borderTop: `1px solid ${C.line}`, fontSize: '11.5px', color: C.text,
      },
    }, h('span', { style: { color: C.dim } }, total[0]), h('span', { style: { fontFamily: C.mono } }, total[1])) : null)

  const contrib = (list, whole, fmtLine) => list.map((r, i) => h('div', {
    key: 'c' + i,
    style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'baseline', padding: '3px 0' },
  },
    h('span', { style: { fontSize: '11px', color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
    h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, pct(r.line, whole)),
    h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text, textAlign: 'right', minWidth: '58px' } }, fmtLine(r))))

  return h('div', { style: S.paletteBackdrop, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('div', {
      style: { ...S.palette, maxHeight: 'min(78vh, 720px)', width: 'min(660px, 94vw)', overflowY: 'auto', padding: '18px 20px 16px' },
      role: 'dialog', 'aria-label': 'Show the working',
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '12px' } },
      h('div', {},
        h('div', { style: { ...S.simpleLabel, margin: 0 } }, 'show the working'),
        h('div', { style: { fontSize: '11px', color: C.faint, marginTop: '2px' } }, design.title)),
      h('button', { style: { ...S.btn, height: '26px', padding: '0 10px' }, onClick: onClose, 'aria-label': 'Close' }, 'Close')),

    section('COST', 'Σ (unit price × qty) + filament used',
      h('div', {},
        contrib(costContributors(design), analysis.cost, (r) => money(r.line)),
        printGrams > 0.5
          ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', padding: '3px 0' } },
            h('span', { style: { fontSize: '11px', color: C.dim } }, `filament used · ${Math.round(printGrams)} g of ${mat.name}`),
            h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, pct(spoolCost, analysis.cost)),
            h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text, textAlign: 'right', minWidth: '58px' } }, money(spoolCost)))
          : null,
        shopTotal > 0.5
          ? h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, marginTop: '6px' } },
            `${money(shopTotal)} of this is shop stock — wire, screw kits, standoffs you buy once and reuse. It is counted here so the list is complete; it is not all burned by this build.`)
          : null),
      [`${design.parts.length} line items · ${units} units`, money(analysis.cost)]),

    section('MASS', 'Σ (part mass × qty) + printed volume × density',
      h('div', {},
        contrib(massContributors(design), analysis.mass.totalG, (r) => `${Math.round(r.line)} g`),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', padding: '3px 0' } },
          h('span', { style: { fontSize: '11px', color: C.dim } }, `${printed.length} printed parts · ${fmt(volCm3, 0)} cm³ of ${mat.name}`),
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, pct(printGrams, analysis.mass.totalG)),
          h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text, textAlign: 'right', minWidth: '58px' } }, `${Math.round(printGrams)} g`))),
      [`hardware ${Math.round(analysis.mass.partsG ?? analysis.mass.totalG - printGrams)} g`, `${Math.round(analysis.mass.totalG)} g`]),

    section('PRINT TIME', 'printed volume ÷ 18 cm³ per hour',
      h('div', { style: { fontFamily: C.mono, fontSize: '11px', color: C.dim, lineHeight: 1.7 } },
        h('div', {}, `${fmt(volCm3, 1)} cm³ ÷ 18 cm³/h = ${fmt(analysis.print.hours, 1)} h`),
        h('div', { style: { color: C.faint, fontSize: '10.5px' } },
          '18 cm³/h assumes a 0.4mm nozzle, 0.2mm layers, a well-tuned machine. Your printer is the other half of this number.')),
      [`${printed.length} parts on the bed`, `${fmt(analysis.print.hours, 1)} h`]),

    power
      ? section('POWER', 'Σ current per rail · runtime = mAh × 0.8 × 60 ÷ amps',
        h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.dim, lineHeight: 1.75 } },
          ['3V3', '5V', 'motor'].filter((r) => power.rails?.[r] && (power.rails[r].typ > 0.005 || power.rails[r].peak > 0.005))
            .map((r) => h('div', { key: r },
              `${r.padEnd(5)} ${fmt(power.rails[r].typ, 2)}A typ · ${fmt(power.rails[r].peak, 2)}A peak  (${power.rails[r].items.length} parts)`)),
          power.bat
            ? h('div', { style: { marginTop: '6px', color: C.faint } },
              `${Math.round(power.bat.mah)} mAh pack ÷ ${fmt(power.typ, 2)}A typical = ${power.runtimeMin != null ? Math.round(power.runtimeMin) + ' min' : 'n/a'}`)
            : h('div', { style: { marginTop: '6px', color: C.faint } }, 'tethered supply — no runtime to compute')),
        [`${fmt(power.typ, 2)} A typical · ${fmt(power.peak, 2)} A stall`, `${fmt(power.peak, 1)} A`])
      : null,

    h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, borderTop: `1px solid ${C.line}`, paddingTop: '10px' } },
      'Prices are catalogue estimates until you refresh live supplier prices; geometry, mass and current are computed from the parts and the mesh you see. Nothing here is narrated.'))
  )
}
