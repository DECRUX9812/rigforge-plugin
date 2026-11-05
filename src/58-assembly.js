// ── assembly: what you can solder, and what you should hand over ─────────────
// The BOM says what to buy. This says how it physically gets together: which
// joints need an iron, which packages are past what a person can place by hand,
// and what an assembly house needs from you if you send it out.

// Package → verdict. "hand" is honest for a beginner with a fine tip and flux;
// "reflow" is hot air and paste; "house" is a machine plus X-ray.
const SOLDER_CLASSES = [
  { match: /^(1206|0805|0603)$/i, verdict: 'hand', why: 'comfortable with a fine tip and flux' },
  { match: /^0402$/i, verdict: 'hand', why: 'doable under magnification — expect some rework' },
  { match: /^(0201|01005)$/i, verdict: 'house', why: 'below what a hand can place reliably' },
  { match: /^(soic|sop)-?\d*/i, verdict: 'hand', why: '0.65mm+ pitch drag-solders easily' },
  { match: /^(tssop|ssop|msop)/i, verdict: 'hand', why: 'fine but regular pitch — drag solder with flux' },
  { match: /^(tqfp|lqfp|qfp)-?\d*/i, verdict: 'hand', why: '0.5mm pitch is learnable; 0.4mm is not fun' },
  { match: /^(qfn|dfn)/i, verdict: 'reflow', why: 'no exposed leads — hot air and paste, an iron cannot reach' },
  { match: /^(bga|ubga|wlcsp)/i, verdict: 'house', why: 'needs reflow profile and X-ray to verify' },
  { match: /^(sot-?23|sot-?223|sc-?70)/i, verdict: 'hand', why: 'three legs, easy' },
  { match: /^(dip|pdip)-?\d*/i, verdict: 'hand', why: 'through-hole, easiest of all' },
  { match: /^(to-?220|to-?252)/i, verdict: 'hand', why: 'big tabs, hand solderable' },
  { match: /^(module|mod\b)/i, verdict: 'hand', why: 'a finished module — castellated pads or headers, no fine pitch' },
  { match: /^lga/i, verdict: 'reflow', why: 'land grid, no leads — hot air and paste' },
  { match: /^(jst|tht|usb|header|conn)/i, verdict: 'hand', why: 'through-hole or big pads' },
]

function solderVerdict(text) {
  const pkg = String(text || '').trim()
  if (!pkg) return null
  for (const c of SOLDER_CLASSES) {
    if (c.match.test(pkg)) return { pkg, ...c }
  }
  // through-hole-ish fallbacks and everything unknown
  if (/^(m\d|pin|header|conn)/i.test(pkg)) return { pkg, verdict: 'hand', why: 'connector or header — through-hole or big pads' }
  return { pkg, verdict: 'unknown', why: 'not a package I recognise — check the datasheet footprint' }
}

/** Parts whose connection needs an iron, with the joint count that implies. */
function solderJobs(design) {
  return design.parts
    .map((p) => ({ ...p, part: PARTS[p.key] }))
    .filter((p) => p.part && /solder|bare tabs|tabs|pads/i.test(p.part.conn || ''))
    .map((p) => ({
      key: p.key,
      name: p.part.name,
      qty: p.qty,
      joints: p.qty * (/bare tabs/i.test(p.part.conn) ? 2 : 2),
      conn: p.part.conn,
    }))
}

// Colour is a process hint, not a verdict on quality: "send it out" is normal
// for a BGA, so it gets the neutral accent, never the error red.
const VERDICT_COLOR = { hand: 'green', reflow: 'amber', house: 'cyan', unknown: 'faint' }

function TabAssembly({ design, analysis }) {
  const [probe, setProbe] = useState('')
  const jobs = solderJobs(design)
  const boardJoints = (design.pcb && design.pcb.joints) || 0
  const jointCount = boardJoints + jobs.reduce((s, j) => s + j.joints, 0)
  const parsed = probe.split(/[,;\s]+/).map(solderVerdict).filter(Boolean)
  const tone = (v) => (v === 'hand' ? C.green : v === 'reflow' ? C.amber : v === 'house' ? C.cyan : C.faint)
  const label = (v) => (v === 'hand' ? 'BY HAND' : v === 'reflow' ? 'HOT AIR' : v === 'house' ? 'SEND OUT' : 'CHECK DATA')

  const placements = (design.pcb && design.pcb.placed) || []
  const byMethod = placements.reduce((acc, p) => {
    const v = solderVerdict(p.pkg)
    const k = v ? v.verdict : 'unknown'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})

  return [
    placements.length
      ? h('div', { style: { marginBottom: '16px' } },
        h('div', { style: S.sectionLabel }, 'placements on this board'),
        h('div', { style: { display: 'flex', gap: '14px', marginBottom: '10px' } },
          [['hand', 'BY HAND'], ['reflow', 'HOT AIR'], ['house', 'SEND OUT'], ['unknown', 'CHECK']]
            .filter(([k]) => byMethod[k])
            .map(([k, label]) => h('div', { key: k, style: { flex: '0 0 auto' } },
              h('div', { style: S.kvKey }, label),
              h('div', { style: { ...S.bigVal, fontSize: '18px', color: tone(k) } }, byMethod[k])))),
        h('table', { style: S.table },
          h('thead', {}, h('tr', {},
            h('th', { style: S.th }, 'DES'), h('th', { style: S.th }, 'PACKAGE'),
            h('th', { style: S.th }, 'METHOD'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'X · Y'))),
          h('tbody', {}, placements.map((p) => {
            const v = solderVerdict(p.pkg)
            return h('tr', { key: p.des },
              h('td', { style: { ...S.td, fontFamily: C.mono, color: C.text } }, p.des),
              h('td', { style: S.td }, p.pkg),
              h('td', { style: { ...S.td, color: tone(v ? v.verdict : 'unknown'), fontFamily: C.mono, fontSize: '9.5px' } },
                label(v ? v.verdict : 'unknown')),
              h('td', { style: S.tdNum }, `${p.x} · ${p.y}`))
          }))))
      : null,

    h('div', { style: { display: 'flex', gap: '14px', marginBottom: '14px' } },
      h('div', { style: { flex: '1 1 0' } },
        h('div', { style: S.kvKey }, 'SOLDER JOINTS'),
        h('div', { style: { ...S.bigVal, fontSize: '22px', color: jointCount ? C.amber : C.green } }, jointCount)),
      h('div', { style: { flex: '1 1 0' } },
        h('div', { style: S.kvKey }, 'PARTS NEEDING AN IRON'),
        h('div', { style: { ...S.bigVal, fontSize: '22px' } }, jobs.length))),

    jobs.length
      ? h('table', { style: S.table },
        h('thead', {}, h('tr', {},
          h('th', { style: S.th }, 'OFF-BOARD PART WITH SOLDER TABS'), h('th', { style: { ...S.th, textAlign: 'right' } }, 'JOINTS'))),
        h('tbody', {}, jobs.map((j) => h('tr', { key: j.key },
          h('td', { style: S.td },
            h('div', { style: { color: C.text } }, j.name),
            h('div', { style: { color: C.faint, fontSize: '10px', marginTop: '2px' } }, j.conn)),
          h('td', { style: S.tdNum }, `×${j.qty}`)))))
      : h('div', { style: { fontSize: '11.5px', color: C.dim, lineHeight: 1.5, marginBottom: '14px' } },
        h('span', { style: { color: C.green, fontFamily: C.mono, marginRight: '6px' } }, '0 JOINTS'),
        'every part in this BOM plugs in — JST, XT60 or 0.1\" headers. Nothing to solder on this build.'),

    h('div', { style: { ...S.sectionLabel, marginTop: '18px' } }, 'solder checker — your own board'),
    h('div', { style: S.hint, marginBottom: '8px' },
      'Does not touch the BOM above. Type the footprints from any board and it answers the real question: can you place this by hand?'),
    h('input', {
      style: { ...S.input, fontFamily: C.mono, fontSize: '11.5px' },
      placeholder: '0402, 0603, QFN-32, TQFP-48, BGA-49',
      'aria-label': 'Packages to check, comma separated',
      value: probe,
      onChange: (e) => setProbe(e.target.value),
    }),
    parsed.length
      ? h('div', { style: { marginTop: '10px' } },
        h('div', { style: { display: 'grid', gridTemplateColumns: '80px 76px 1fr', gap: '10px', padding: '4px 0', borderBottom: `1px solid ${C.line}` } },
          h('span', { style: S.th }, 'PACKAGE'),
          h('span', { style: S.th }, 'METHOD'),
          h('span', { style: S.th }, 'WHY')),
        parsed.map((r, i) => h('div', {
          key: 'p' + i,
          style: { display: 'grid', gridTemplateColumns: '80px 76px 1fr', gap: '10px', alignItems: 'baseline', padding: '6px 0', borderBottom: `1px solid ${C.lineSoft}` },
        },
        h('span', { style: { fontFamily: C.mono, fontSize: '11px', color: C.text } }, r.pkg),
        h('span', { style: { fontFamily: C.mono, fontSize: '9.5px', color: tone(r.verdict), letterSpacing: '0.08em' } }, label(r.verdict)),
        h('span', { style: { fontSize: '11px', color: C.dim, lineHeight: 1.4 } }, r.why))))
      : h('div', { style: S.hint }, 'Type the footprints from your board — the answer is per package, not per board.'),

    h('div', { style: { ...S.sectionLabel, marginTop: '20px' } }, 'if you send it out'),
    h('div', { style: { fontSize: '11.5px', color: C.dim, lineHeight: 1.6, marginBottom: '10px' } },
      h('div', {}, 'Assembly houses quote from three files, and only three:'),
      h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.text, marginTop: '6px', lineHeight: 1.7 } },
        '1. Gerber (the board)',
        h('br'),
        '2. BOM with manufacturer part numbers',
        h('br'),
        '3. Centroid / pick-and-place file (X, Y, rotation per part)'),
      h('div', { style: { marginTop: '8px' } },
        'You already have the parts, so ask for consigned / kitted assembly — they place what you ship. Their published capability runs to 01005 passives, 0.25mm pitch and BGA with X-ray; minimum order is a handful of boards, and lead time starts when the parts and the three files are all in.')),
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      h('button', {
        style: S.btn,
        onClick: () => {
          const lines = [
            `Rigforge build: ${design.title}`,
            `${design.parts.length} line items, ${money(analysis.cost)}`,
            '',
            'Parts needing an iron:',
            ...(jobs.length ? jobs.map((j) => `  ${j.name} ×${j.qty} (${j.conn})`) : ['  none']),
            '',
            'Assembly-house handoff needs: Gerber, BOM with MPNs, centroid/CPL file.',
            'Ask for consigned/kitted assembly — customer supplies the components.',
          ].join('\n')
          try { navigator.clipboard.writeText(lines); host.notify({ kind: 'success', message: 'Assembly handoff copied' }) } catch { host.notify({ kind: 'info', message: 'Copy blocked' }) }
        },
      }, 'Copy handoff summary'),
      h('button', { style: S.btn, onClick: () => host.openExternal?.('https://www.pcbway.com/assembly-capabilities.html') }, 'Assembly capabilities ↗')),
  ]
}
