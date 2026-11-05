// ── compare: did the change actually make it better? ────────────────────────
// The agent, or you, can rewrite a build in one line. The only honest way to
// judge that rewrite is against the thing it replaced: cheaper? lighter?
// stiffer? Did it buy the gain by breaking a check? This is that scoreboard.

const CMP_METRICS = [
  { key: 'cost', label: 'COST', unit: '$', get: (a) => a.cost, better: 'down', digits: 2 },
  { key: 'mass', label: 'MASS', unit: ' g', get: (a) => a.mass.totalG, better: 'down', digits: 0 },
  { key: 'print', label: 'PRINT TIME', unit: ' h', get: (a) => a.print.hours, better: 'down', digits: 1 },
  { key: 'peak', label: 'PEAK CURRENT', unit: ' A', get: (a) => a.power.peak, better: 'down', digits: 2 },
  { key: 'checks', label: 'OPEN PROBLEMS', unit: '', get: (a) => a.checks.filter((c) => c.level !== 'ok').length, better: 'down', digits: 0 },
]

function compareDesigns(briefA, briefB) {
  const A = composeDesign(briefA)
  const B = composeDesign(briefB)
  const rows = CMP_METRICS.map((m) => {
    const a = m.get(A.analysis)
    const b = m.get(B.analysis)
    const delta = b - a
    const pctChange = a > 0 ? (delta / a) * 100 : (b > 0 ? 100 : 0)
    const flat = Math.abs(delta) < (m.digits === 0 ? 0.5 : 0.005)
    const good = flat ? null : (m.better === 'down' ? delta < 0 : delta > 0)
    return { ...m, a, b, delta, pctChange, flat, good }
  })
  // Compare problems by kind, not by their digits: "longest dimension 540mm"
  // and "longest dimension 568mm" are the same problem, and treating them as
  // different makes a resize look like it broke something new.
  const keyOf = (c) => `${c.level}|${c.msg.replace(/[0-9]+(?:\.[0-9]+)?/g, '#').slice(0, 60)}`
  const beforeChecks = A.analysis.checks.filter((c) => c.level !== 'ok')
  const afterChecks = B.analysis.checks.filter((c) => c.level !== 'ok')
  const beforeKeys = beforeChecks.map(keyOf)
  const afterKeys = afterChecks.map(keyOf)
  return {
    A, B, rows,
    resolved: beforeChecks.filter((c) => !afterKeys.includes(keyOf(c))).map((c) => c.msg),
    introduced: afterChecks.filter((c) => !beforeKeys.includes(keyOf(c))).map((c) => c.msg),
    sameTitle: A.design.title === B.design.title,
  }
}

/** One sentence a person can act on, not a table they have to read. */
function compareVerdict(cmp) {
  const list = (arr) => (arr.length > 1 ? arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1] : arr[0])
  const wins = cmp.rows.filter((r) => r.good === true).map((r) => r.label.toLowerCase())
  const losses = cmp.rows.filter((r) => r.good === false).map((r) => r.label.toLowerCase())
  const bits = []
  if (wins.length) bits.push(`better on ${list(wins)}`)
  if (losses.length) bits.push(`worse on ${list(losses)}`)
  if (!bits.length) bits.push('nothing moved')
  let out = bits.join('; ')
  if (cmp.introduced.length) out += ` — and ${cmp.introduced.length} new problem${cmp.introduced.length > 1 ? 's' : ''}`
  else if (cmp.resolved.length) out += ` — ${cmp.resolved.length} problem${cmp.resolved.length > 1 ? 's' : ''} cleared`
  return out + '.'
}

const BRIEF_FIELDS = [
  ['reachMm', 'reach', ' mm'],
  ['payloadKg', 'payload', ' kg'],
  ['spanX', 'span', ' mm'],
  ['material', 'material', ''],
  ['mcu', 'controller', ''],
  ['battery', 'power', ''],
  ['energy', 'energy', ''],
  ['drive', 'drive', ''],
  ['gripper', 'gripper', ''],
  ['archetype', 'machine', ''],
]

/** The knobs that changed, in the user's units. */
function briefChanges(a, b) {
  const out = []
  for (const [key, label, unit] of BRIEF_FIELDS) {
    if (a[key] === b[key]) continue
    if (a[key] === undefined && b[key] === undefined) continue
    out.push({ label, from: a[key], to: b[key], unit })
  }
  return out
}

function CompareDialog({ open, onClose, currentBrief, history }) {
  const dialogRef = useDialogFocus(open, onClose)
  if (!open) return null
  const options = (history || []).filter((h) => h && h.brief)
  if (!options.length) {
    return h('div', { style: S.paletteBackdrop, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
      h('div', { ref: dialogRef, tabIndex: -1, style: { ...S.palette, width: 'min(520px, 92vw)', padding: '20px' }, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compare builds' },
        h('div', { style: S.simpleLabel }, 'compare'),
        h('div', { style: { fontSize: '12px', color: C.dim, lineHeight: 1.6 } },
          'Nothing to compare against yet. Every build you make is remembered here, so change one number, press BUILD, and come back — you will see what actually moved.'),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
          h('button', { style: { ...S.btn, height: '30px' }, onClick: onClose }, 'Close'))))
  }
  const prev = options[0]
  const cmp = compareDesigns(prev.brief, currentBrief)
  const changes = briefChanges(prev.brief, currentBrief)
  const fmtVal = (m, v) => `${m.unit === '$' ? '$' : ''}${fmt(v, m.digits)}${m.unit === '$' ? '' : m.unit}`
  const tone = (r) => (r.flat ? C.faint : r.good ? C.green : C.red)
  const arrow = (r) => (r.flat ? '=' : r.delta < 0 ? '▼' : '▲')

  return h('div', { style: S.paletteBackdrop, onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
    h('div', {
      ref: dialogRef, tabIndex: -1,
      style: { ...S.palette, maxHeight: 'min(80vh, 760px)', width: 'min(720px, 94vw)', overflowY: 'auto', padding: '18px 20px 16px' },
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compare builds',
    },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '4px' } },
      h('div', {},
        h('div', { style: { ...S.simpleLabel, margin: 0 } }, 'before → after'),
        h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.faint, marginTop: '2px' } },
          `${cmp.A.design.title} → ${cmp.B.design.title}`)),
      h('button', { style: { ...S.btn, height: '26px', padding: '0 10px' }, onClick: onClose, 'aria-label': 'Close' }, 'Close')),

    // "Better" only means something between two versions of the same machine.
    // Across archetypes it is a choice, not a score, so the verdict is withheld.
    cmp.A.design.archetype !== cmp.B.design.archetype
      ? h('div', { style: { fontSize: '12px', color: C.amber, lineHeight: 1.5, margin: '10px 0 12px' } },
        'Two different machines — pick by what you need, not by which column wins. The numbers are side by side, not a score.')
      : h('div', { style: { fontSize: '12.5px', color: C.text, lineHeight: 1.5, margin: '10px 0 14px' } }, compareVerdict(cmp)),

    changes.length
      ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '0 0 12px' } },
        changes.slice(0, 5).map((c, i) => h('span', {
          key: i,
          style: {
            fontFamily: C.mono, fontSize: '10px', color: C.dim, padding: '3px 8px', borderRadius: '999px',
            border: `1px solid ${C.line}`, background: C.panel2,
          },
        }, `${c.label} ${c.from}${c.unit} → ${c.to}${c.unit}`)))
      : null,

    h('table', { style: S.table },
      h('thead', {}, h('tr', {},
        h('th', { style: S.th }, 'METRIC'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'BEFORE'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'AFTER'),
        h('th', { style: { ...S.th, textAlign: 'right' } }, 'CHANGE'))),
      h('tbody', {}, cmp.rows.map((r) => h('tr', { key: r.key },
        h('td', { style: { ...S.td, fontFamily: C.mono, fontSize: '10px', letterSpacing: '0.06em' } }, r.label),
        h('td', { style: S.tdNum }, fmtVal(r, r.a)),
        h('td', { style: S.tdNum }, fmtVal(r, r.b)),
        h('td', { style: { ...S.tdNum, color: tone(r) } },
          `${arrow(r)} ${r.delta === 0 ? '' : (r.delta > 0 ? '+' : '') + fmt(r.delta, r.digits)}${r.flat ? '' : ` · ${Math.abs(r.pctChange) < 0.5 ? '<1' : Math.round(r.pctChange)}%`}`))))),

    cmp.resolved.length || cmp.introduced.length
      ? h('div', { style: { marginTop: '14px' } },
        h('div', { style: S.sectionLabel }, 'what changed in the checks'),
        cmp.resolved.map((c, i) => h('div', { key: 'r' + i, style: { fontSize: '11.5px', color: C.green, marginBottom: '4px' } }, `✓ cleared — ${c}`)),
        cmp.introduced.map((c, i) => h('div', { key: 'i' + i, style: { fontSize: '11.5px', color: C.red, marginBottom: '4px' } }, `✕ new — ${c}`)))
      : h('div', { style: { marginTop: '12px', fontSize: '11px', color: C.faint } },
        'The same checks pass and fail on both builds — the change was a trade, not a fix.'),

    h('div', { style: { fontSize: '10.5px', color: C.faint, marginTop: '14px', borderTop: `1px solid ${C.line}`, paddingTop: '10px', lineHeight: 1.5 } },
      `Both machines were recomputed from scratch just now, not read from a cache. Compared against the previous ${options.length > 1 ? `build (${options.length} kept)` : 'build'}.`))
  )
}
