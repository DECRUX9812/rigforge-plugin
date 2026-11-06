// ── the page ────────────────────────────────────────────────────────────────

let CTX = null // set in register(); the storage/host door for every component

// ── the agent bridge ────────────────────────────────────────────────────────
// ctx.rest is namespace-scoped to /api/plugins/rigforge. A plugin with no
// mounted backend, an OAuth remote or an older host simply fails closed, so
// every call is wrapped and the topbar shows LINKED / OFFLINE rather than lying.
async function bridge(path, opts) {
  if (!CTX || typeof CTX.rest !== 'function') throw new Error('no plugin backend')
  return CTX.rest(path, opts)
}

/** What the agent reads back after a build: bounded, rounded, no geometry. */
function summarise(design, analysis, brief) {
  return {
    title: design.title,
    archetype: brief.archetype,
    brief,
    cost: Number(analysis.cost.toFixed(2)),
    massG: Math.round(analysis.mass.totalG),
    printHours: Number(analysis.print.hours.toFixed(1)),
    peakAmps: Number(analysis.power.peak.toFixed(2)),
    partCount: design.parts.reduce((s, p) => s + p.qty, 0),
    parts: design.parts.map((p) => {
      const part = PARTS[p.key] || {}
      return { key: p.key, name: part.name || p.key, sku: part.sku || '', qty: p.qty, price: part.price || 0, shop: !!part.shop }
    }),
    checks: analysis.checks.slice(0, 6).map((c) => ({ level: c.level, msg: c.msg.slice(0, 200) })),
  }
}

// Fit the camera to the machine: the largest dimension should occupy ~70% of
// the viewport, so the thing the user just designed is actually readable.
const CAM_FOR = (dims) => {
  const diag = Math.hypot(dims[0], dims[1], dims[2]) || 300
  return { ...CAM0, dist: clamp(diag * 1.06, 300, 5200) }
}

function StatChip({ k, v, color, title }) {
  return h('div', { style: S.statChip, title },
    h('span', { style: S.statKey }, k),
    h('span', { style: { ...S.statVal, color: color || C.text } }, v))
}

function ParamSlider({ label, value, min, max, step, unit, hint, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label },
      h('span', {}, label),
      h('span', { style: { color: C.text } }, `${value}${unit || ''}`)),
    h('input', {
      type: 'range', min, max, step, value, style: S.range,
      'aria-label': label,
      onChange: (e) => onChange(Number(e.target.value)),
    }),
    hint ? h('div', { style: S.hint }, hint) : null)
}

function Select({ label, value, options, hint, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label }, h('span', {}, label)),
    h('select', {
      value, style: { ...S.input, padding: '6px 8px', cursor: 'pointer' },
      'aria-label': label,
      onChange: (e) => onChange(e.target.value),
    }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
    hint ? h('div', { style: S.hint }, hint) : null)
}

/**
 * A live 3D mini of an archetype, drawn by the same engine as the viewport.
 * Cards that show the machine read as a catalogue of things you can build; a
 * card that shows an icon reads as a form field.
 */
function Thumb({ archetype }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return undefined
    let alive = true
    let raf = 0
    const draw = () => {
      const preset = PRESETS.find((p) => p.brief.archetype === archetype)
      const b = preset ? { ...DEFAULT_BRIEF, ...preset.brief } : DEFAULT_BRIEF
      let mesh = []
      try {
        const { design } = composeDesign(b)
        mesh = buildMesh(design)
      } catch {
        return
      }
      if (!alive || !mesh.length) return
      let r = 60
      for (const t of mesh) for (const p of t.pts) {
        const d = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])
        if (d > r) r = d
      }
      drawScene(cv, mesh, { yaw: -0.7, pitch: 0.34, dist: r * 3.0, ortho: false }, [0, 0, r * 0.35], {
        grid: false, reflect: false, shadow: false, outline: true, colour: true, dims: false, wire: false, ao: false, gizmo: false,
      })
    }
    // decoration only: build thumbnails in idle time so the page paints first
    const idle = window.requestIdleCallback
    const handle = idle ? idle(draw, { timeout: 900 }) : (raf = requestAnimationFrame(draw))
    return () => {
      alive = false
      if (idle && window.cancelIdleCallback) window.cancelIdleCallback(handle)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [archetype])
  return h('canvas', { ref, style: S.thumb, 'aria-hidden': 'true' })
}


/**
 * Ask Hermes for live prices. Shared by the PRICES note and the "what to buy"
 * header, so there is one trigger and one wording.
 */
async function askPrices(design) {
  const prompt = [
    'Get live prices for the build currently loaded in Rigforge and hand them back to the studio.',
    `Build: ${design.title} — ${design.parts.length} line items.`,
    'Call the rigforge_prices tool, then put its directive on its own line so the studio can render it.',
    'Only report a price as live if it came from the supplier; estimates stay labelled as estimates.',
  ].join('\n')
  try {
    const staged = await host.composer.setDraft(null, prompt)
    host.composer.focus(null)
    host.notify({ kind: staged ? 'success' : 'error', message: staged ? 'Price request handed to Hermes — press Enter' : 'Copied the price request instead' })
    if (!staged) await navigator.clipboard?.writeText(prompt)
  } catch {
    host.notify({ kind: 'info', message: 'Ask Hermes for live prices (rigforge_prices tool)' })
  }
}

/** Live-price strip: what has a real supplier number, and what is still a guess. */
function LivePrices({ design }) {
  const [prices] = useState(() => (CTX && CTX.storage.get('livePrices', null)) || null)
  const age = prices && prices.fetched ? Math.max(0, Math.round(Date.now() / 1000 - prices.fetched)) : null
  const ageText = age == null ? '' : age < 90 ? 'just now' : age < 5400 ? `${Math.round(age / 60)} min ago` : `${Math.round(age / 3600)}h ago`
  return prices
    ? h('div', { style: { fontSize: '11.5px', color: C.text, marginTop: '-4px', marginBottom: '12px', lineHeight: 1.5 } },
      `${prices.liveLines} of ${prices.lines} lines priced live — $${(prices.liveTotal || 0).toFixed(2)}`,
      h('span', { style: { color: C.faint } }, ` · $${(prices.estimateTotal || 0).toFixed(2)} still estimated · ${ageText}`))
    : h('div', { style: { fontSize: '11px', color: C.faint, marginTop: '-4px', marginBottom: '12px', lineHeight: 1.45 } },
      'Totals are catalogue estimates. Live prices come from the LCSC parts index when you ask for them.')
}

function BuildCodeDialog({ open, onOpen, onClose }) {
  const dialogRef = useDialogFocus(open, onClose)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { if (open) { setCode(''); setErr('') } }, [open])
  if (!open) return null
  const submit = () => {
    try {
      const b = decodeBuild(code)
      onOpen(b)
      onClose()
    } catch (e) {
      setErr(e.message)
    }
  }
  return h('div', {
    style: S.paletteBackdrop,
    onClick: (e) => { if (e.target === e.currentTarget) onClose() },
  },
  h('div', { ref: dialogRef, tabIndex: -1, style: { ...S.palette, maxHeight: 'none', width: 'min(560px, 92vw)', padding: 0 }, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Open a build code' },
    h('div', { style: { padding: '16px 18px 0' } },
      h('div', { style: { ...S.simpleLabel, margin: '0 0 4px' } }, 'open a build code'),
      h('div', { style: { ...S.hint, marginBottom: '10px' } },
        'A build code is the whole design in one line — send it to someone else and they get the same machine, priced with their own suppliers.')),
    h('input', {
      'data-rf': 'codeInput',
      style: {
        ...S.paletteInput,
        fontFamily: C.mono, fontSize: '12px', height: '40px',
        border: `1px solid ${err ? C.red : C.line}`,
        margin: '0 18px', width: 'calc(100% - 36px)',
      },
      placeholder: 'paste the code someone sent you',
      value: code,
      autoFocus: true,
      'aria-label': 'Build code',
      onChange: (e) => { setCode(e.target.value); setErr('') },
      onKeyDown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() },
    }),
    h('div', { style: { padding: '8px 18px 0', minHeight: '26px' } },
      err
        ? h('div', { style: { color: C.red, fontSize: '11.5px', lineHeight: 1.4 } }, err)
        : h('div', { style: { color: C.faint, fontSize: '11px', lineHeight: 1.4 } },
          'One line, starts with RF1-. Pastes cleanly into chat, email or a README.')),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', padding: '12px 18px 16px' } },
      h('button', { style: { ...S.btn, height: '32px', padding: '0 14px' }, onClick: onClose }, 'Cancel'),
      h('button', { style: { ...S.btnPrimary, width: 'auto', height: '32px', padding: '0 18px', fontSize: '12px' }, onClick: submit }, 'OPEN IT'))))
}

/** Edit a custom machine's nodes/joints spec as JSON — the same shape
 *  rigforge_build and build codes carry, so an agent's spec pastes straight in. */
function SpecDialog({ open, brief, onApply, onClose }) {
  const dialogRef = useDialogFocus(open, onClose)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!open) return
    setErr('')
    setText(JSON.stringify({ nodes: brief.nodes || [], joints: brief.joints || [] }, null, 1))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null
  const submit = () => {
    let obj
    try {
      obj = JSON.parse(text)
    } catch (e) {
      setErr(`Not valid JSON — ${e.message}`)
      return
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.nodes)) {
      setErr('The spec needs a nodes[] array — joints[] is optional.')
      return
    }
    onApply({
      archetype: 'custom',
      nodes: obj.nodes,
      joints: Array.isArray(obj.joints) ? obj.joints : [],
      title: typeof obj.title === 'string' && obj.title ? obj.title.slice(0, 80) : brief.title,
    })
    onClose()
  }
  return h('div', {
    style: S.paletteBackdrop,
    onClick: (e) => { if (e.target === e.currentTarget) onClose() },
  },
  h('div', { ref: dialogRef, tabIndex: -1, style: { ...S.palette, maxHeight: 'none', width: 'min(640px, 94vw)', padding: 0 }, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit machine spec' },
    h('div', { style: { padding: '16px 18px 0' } },
      h('div', { style: { ...S.simpleLabel, margin: '0 0 4px' } }, 'edit the machine spec'),
      h('div', { style: { ...S.hint, marginBottom: '10px' } },
        'nodes[] place shapes (kind, at, size/r/h…, joint or slide, print), joints[] are the axes (axis, pivot, min/max, parent — or slide+travel). The engine measures and checks everything; bad entries are named, never silently dropped.')),
    h('textarea', {
      'data-rf': 'specInput',
      style: {
        ...S.paletteInput,
        fontFamily: C.mono, fontSize: '11.5px', height: '300px', resize: 'vertical',
        border: `1px solid ${err ? C.red : C.line}`,
        margin: '0 18px', width: 'calc(100% - 36px)', padding: '10px', lineHeight: 1.5,
      },
      value: text,
      autoFocus: true,
      'aria-label': 'Machine spec JSON',
      onChange: (e) => { setText(e.target.value); setErr('') },
    }),
    h('div', { style: { padding: '8px 18px 0', minHeight: '26px' } },
      err
        ? h('div', { style: { color: C.red, fontSize: '11.5px', lineHeight: 1.4 } }, err)
        : h('div', { style: { color: C.faint, fontSize: '11px', lineHeight: 1.4 } },
          'Kinds: box rbox cyl ring torus wedge sphere gear rack bend mesh. Node rot is in degrees.')),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', padding: '12px 18px 16px' } },
      h('button', { style: { ...S.btn, height: '32px', padding: '0 14px' }, onClick: onClose }, 'Cancel'),
      h('button', { style: { ...S.btnPrimary, width: 'auto', height: '32px', padding: '0 18px', fontSize: '12px' }, onClick: submit }, 'BUILD IT'))))
}

function CommandPalette({ open, commands, onClose }) {
  const dialogRef = useDialogFocus(open, onClose)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)

  const scored = useMemo(() => {
    // People type what they read: "pick and place arm", not "pick & place arm".
    // Normalise both sides so punctuation and "&" never decide a match.
    const norm = (t) => String(t).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    const needle = norm(q)
    if (!needle) return commands
    const rank = (raw) => {
      const t = norm(raw)
      if (t.startsWith(needle)) return 0
      if (t.includes(needle)) return 1
      // every word of the query must appear somewhere, in any order
      const words = needle.split(' ').filter(Boolean)
      if (words.every((w) => t.includes(w))) return 2
      // initials only: "ppe" → "Pick & place arm", but "cpl" must not land on
      // it just because those letters appear somewhere in the label.
      const initials = t.split(' ').filter(Boolean).map((w) => w[0]).join('')
      let k = 0
      const bare = needle.replace(/ /g, '')
      for (const ch of initials) { if (ch === bare[k]) k += 1; if (k === bare.length) return 3 }
      return -1
    }
    return commands
      .map((c) => ({ c, r: rank(c.label + ' ' + (c.group || '')) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.c.label.length - b.c.label.length)
      .map((x) => x.c)
  }, [q, commands])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 20)
      return () => clearTimeout(t)
    }
    return undefined
  }, [open])

  if (!open) return null
  const clampSel = Math.max(0, Math.min(sel, scored.length - 1))

  const run = (cmd) => {
    onClose()
    if (cmd && cmd.run) cmd.run()
  }

  return h('div', {
    style: S.paletteBackdrop,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', { ref: dialogRef, tabIndex: -1, style: S.palette, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      h('input', {
        ref: inputRef,
        style: S.paletteInput,
        value: q,
        placeholder: 'Jump to a machine, a tab, an export…',
        'aria-label': 'Search commands',
        onChange: (e) => { setQ(e.target.value); setSel(0) },
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, scored.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); run(scored[clampSel]) }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        },
      }),
      h('div', { style: S.paletteList },
        scored.length === 0
          ? h('div', { style: S.paletteEmpty }, 'nothing matches — try "rover", "bom", "stl"')
          : scored.map((c, i) => h('button', {
            key: c.id,
            style: i === clampSel ? S.paletteRowOn : S.paletteRow,
            onMouseEnter: () => setSel(i),
            onClick: () => run(c),
          },
            h('span', { style: S.paletteGroup }, c.group || ''),
            h('span', { style: S.paletteLabel }, c.label),
            c.hint ? h('span', { style: S.paletteHint }, c.hint) : null))),
      h('div', { style: S.paletteFoot }, '↑↓ move · ⏎ run · esc close')),
  )
}

/** The plain-language panel: what it costs, what to buy, what to print. */
function SimplePanel({ design, analysis, exports, onEngineer, onAudit, onCompare, onTest }) {
  // The primary CTA is picked by meaning: the export list keeps growing, and
  // selecting the "print pack" by index once shipped a whole-machine STL under a
  // button that promised a zip.
  const packEntry = exports.find(([label]) => /print pack|board pack|fab \+ assembly/i.test(label))
  const packAction = (packEntry || exports[1])[1]
  const rows = design.parts.map((p) => ({ ...p, part: PARTS[p.key] }))
  rows.sort((x, y) => y.part.price * y.qty - x.part.price * x.qty)
  const printed = design.nodes.filter((n) => n.mat === 'shell' || n.print).length
  // The bench verdict in one sentence — "will it stand?" is the question a
  // first-time builder actually has, and it belongs in plain words too.
  const bench = useMemo(
    () => benchReport(design, analysis, { mat: analysis.print && analysis.print.material, slopeDeg: 15 }),
    [design, analysis],
  )
  const benchWorst = bench.verdicts.find((v) => v.status === 'fail') || bench.verdicts.find((v) => v.status === 'warn')
  const benchOk = !benchWorst
  const big = (k, v, sub, color) => h('div', { style: S.bigCard },
    h('div', { style: S.bigKey }, k),
    h('div', { style: { ...S.bigVal, color: color || C.text } }, v),
    sub ? h('div', { style: S.bigSub }, sub) : null)

  return h('div', { style: { padding: '14px 0 8px' } },
    h('div', { style: S.simpleHead }, 'Your machine, in plain words'),
    // Three numbers, chosen for what this design actually costs the builder.
    h('div', { style: S.simpleGrid },
      big('COST', money(analysis.cost), 'parts, at hobby prices', C.accent),
      design.pcb
        ? big('BOARD', `${Math.round(design.pcb.W)}×${Math.round(design.pcb.H)}`, 'mm · 2 layers', C.amber)
        : big('PRINT TIME', `${fmt(analysis.print.hours, 0)} h`, `${Math.round(analysis.print.grams)}g of filament`, C.amber),
      design.pcb
        ? big('JOINTS', `${design.pcb.joints || 0}`, `${(design.pcb.placed || []).length} placements`, C.cyan)
        : big('WEIGHT', `${Math.round(analysis.mass.totalG)} g`, 'finished machine', C.cyan)),
    h('button', {
      style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10px', margin: '0 0 12px' },
      onClick: onAudit,
      title: 'every number here is a sum you can check',
      'aria-label': 'Show the working behind these numbers',
    }, '⌁ how these numbers are made'),
    h('button', {
      style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10px', margin: '0 0 12px 6px' },
      onClick: onCompare,
      title: 'did the last change actually make it better?',
      'aria-label': 'Compare this build with the previous one',
    }, '↔ what changed'),
    h('button', {
      style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10px', margin: '0 0 12px 6px' },
      onClick: onTest,
      title: 'the pre-print test bench: stability, ramp, joint torque',
      'aria-label': 'Open the test bench tab',
    }, '⚗ test bench'),
    h('div', {
      role: 'status',
      style: {
        display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px',
        borderRadius: '7px', marginBottom: '12px', fontSize: '11.5px', lineHeight: 1.45,
        color: C.text, background: levelBg(benchOk ? 'ok' : benchWorst.status === 'fail' ? 'fail' : 'warn'),
        borderLeft: `3px solid ${levelColor(benchOk ? 'ok' : benchWorst.status === 'fail' ? 'fail' : 'warn')}`,
      },
    },
      h('span', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', paddingTop: '2px', color: levelColor(benchOk ? 'ok' : benchWorst.status === 'fail' ? 'fail' : 'warn') } },
        benchOk ? 'BENCH ✓' : 'BENCH !'),
      h('span', {}, benchOk
        ? `Would stand, climb a 15° ramp and hold — ${Math.round(bench.massG)}g, CoM ${Math.round(bench.flatMm)}mm inside its footprint.`
        : `Heads up: ${benchWorst.label.toLowerCase()} — ${benchWorst.detail}`)),
    h(LivePrices, { design }),
    (analysis.checks.filter((c) => c.level !== 'ok').length
      ? h('div', {},
        h('div', { style: S.simpleLabel }, 'HEADS UP, BEFORE YOU BUY'),
        h('div', { style: { marginBottom: '14px' } },
          analysis.checks.filter((c) => c.level !== 'ok').slice(0, 3).map((c, i) => h('div', {
            key: 'w' + i,
            style: {
              display: 'flex', gap: '7px', alignItems: 'flex-start', padding: '6px 8px',
              borderRadius: '6px', marginBottom: '5px', lineHeight: 1.45, fontSize: '11px',
              color: C.text, background: levelBg(c.level), borderLeft: `2px solid ${levelColor(c.level)}`,
            },
          },
            h('span', { style: { color: levelColor(c.level), flex: '0 0 auto', fontFamily: C.mono } }, c.level === 'fail' ? '✕' : '!'),
            h('span', {}, c.msg)))))
      : null),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '7px' } },
      h('div', { style: S.simpleLabel }, 'WHAT TO BUY'),
      h('button', {
        style: { ...S.btn, height: '22px', padding: '0 8px', fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.04em' },
        title: 'read real unit prices from the LCSC parts index (asks Hermes to run the price tool)',
        onClick: () => askPrices(design),
      }, '⌁ LIVE PRICES')),
    h('div', { style: { marginBottom: '14px' } }, rows.slice(0, 6).map((r) => h('div', { key: r.key, style: S.buyRow },
      h('span', { style: S.buyName }, r.part.name),
      h('span', { style: S.buyQty }, `×${r.qty}`),
      h('span', { style: S.buyPrice }, money(r.part.price * r.qty)))),
      rows.length > 6 ? h('div', { style: S.buyMore }, `+ ${rows.length - 6} more line items`) : null),
    // A board is not printed, so this block says what actually happens to it:
    // the fab makes the PCB, you place the parts, or an assembly house does.
    design.pcb
      ? h('div', {},
        h('div', { style: S.simpleLabel }, 'WHAT HAPPENS NOW'),
        h('div', { style: { fontSize: '11.5px', color: C.dim, lineHeight: 1.7, marginBottom: '12px' } },
          h('div', {}, `The board is fabricated: ${Math.round(design.pcb.W)}×${Math.round(design.pcb.H)}mm, 2 layers, 1.6mm.`),
          h('div', {}, `Then ${(design.pcb.placed || []).length} parts go on — ${(design.pcb.joints || 0)} solder joints.`),
          h('div', { style: { color: C.faint } }, 'Send the board files to a fab; send the parts to an assembly house if you would rather not solder.')))
      : h('div', {},
        h('div', { style: S.simpleLabel }, 'WHAT TO PRINT'),
        h('div', { style: { fontFamily: C.mono, fontSize: '11.5px', color: C.dim, lineHeight: 1.6, marginBottom: '16px' } },
          `${printed} printed parts · ${fmt(analysis.print.hours, 1)} h · ${Math.round(analysis.print.grams)} g PETG`,
          h('div', { style: { color: C.faint, fontSize: '10.5px', marginTop: '3px' } },
            'One file per part: laid flat, centred on the bed, sitting on Z=0.'))),
    // The primary call to action must not be an index into a list that other
    // features keep inserting into: this used to say "print pack" and download
    // the whole-machine STL because the STL entry moved to position 1.
    h('button', { style: { ...S.btnPrimary, height: '40px', fontSize: '13px' }, onClick: packAction },
      design.pcb ? '⬇ DOWNLOAD THE FAB + ASSEMBLY FILES' : '⬇ DOWNLOAD THE PRINT PACK (.zip)'),
    h('button', {
      style: { ...S.btn, marginTop: '8px', height: '32px', width: '100%', justifyContent: 'center' },
      onClick: onEngineer,
    }, '⌁ SHOW ME THE ENGINEERING'))
}

// Sentences a person can actually type, each of which the matcher resolves.
// Deterministic worked examples: a fixed brief, and why an engineer would use it.
const WORKED_EXAMPLES = [
  { label: 'Bench arm, 5-DoF', why: 'sorts 3D-printed parts', brief: { archetype: 'arm', mission: '5-DoF arm that sorts 3D-printed parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 } },
  { label: 'Survey rover, 4WD', why: 'maps a room at walking pace', brief: { archetype: 'rover', mission: 'a rover that maps my room', payloadKg: 2, wheelMm: 100 } },
  { label: 'Plant sensor, IoT case', why: 'STEM build, one afternoon', brief: { archetype: 'iot', mission: 'a plant sensor that reports soil moisture to my phone', payloadKg: 0, battery: 'lipo2s' } },
]

const EXAMPLES = [
  'a rover that maps my room',
  'a gripper that sorts screws',
  'a board with a screen and a sensor',
]

const ARCHETYPES = [
  ['iot', 'IoT'], ['gadget', 'ESP32'], ['gripper', 'GRIPPER'], ['arm', 'ARM'], ['rover', 'ROVER'],
  ['quadruped', 'QUAD'], ['humanoid', 'HUMANOID'], ['robot', 'FULL ROBOT'], ['gantry', 'GANTRY'],
]

// Plain words next to every preset — the cards are how a first-timer builds
// without ever typing a brief.
const PRESET_BLURBS = {
  iot: 'one sensor, one case, one afternoon',
  pcb: 'a real board, fab + assembly files',
  gantry: 'metre-scale, belts + rails',
  arm: 'lifts and sorts small parts',
  rover: 'a rolling robot that explores',
  quad: 'a robot dog that walks',
  grip: 'a claw that grabs things',
  humanoid: 'a walking robot with arms',
  robot: 'rover + arm in one machine',
  desk: 'a little electronic desk gadget',
  custom: 'your own node spec — any shape, any joints',
}

/** One honest sentence anybody can read — the tables below carry the detail. */
function plainVerdict(checks, brief) {
  // A brief that named nothing must not collect a green tick just because the
  // checks pass on a machine nobody asked for.
  if (brief && brief.archetypeMatched === false) {
    return {
      icon: '!', color: C.amber,
      text: 'Those words did not name a machine — this is the closest one I build. Name the kind (rover, arm, quadruped, gripper, board, gantry) and the numbers will mean something.',
    }
  }
  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  if (fails) return { icon: '✗', color: C.red, text: `Hold on — ${fails} thing${fails > 1 ? 's' : ''} must be fixed before this is safe to build.` }
  if (warns) return { icon: '!', color: C.amber, text: `Buildable, but read the ${warns} warning${warns > 1 ? 's' : ''} first.` }
  return { icon: '✓', color: C.green, text: 'Ready to build — every engineering check passed.' }
}

const MAT_OPTIONS = Object.entries(MATERIALS).map(([k, m]) => ({
  value: k, label: `${m.name} · E${m.elastic}GPa`,
}))

function Studio() {
  const [brief, setBrief] = useState(() => (CTX && CTX.storage.get('lastBrief', null)) || DEFAULT_BRIEF)
  const [mission, setMission] = useState(() => brief.mission)
  const [missionDirty, setMissionDirty] = useState(false)
  const [tab, setTab] = useState('spec')
  const [simple, setSimple] = useState(() => (CTX && CTX.storage.get('simple', true)) !== false)
  const [guideOff, setGuideOff] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [allMachines, setAllMachines] = useState(false)
  const [menu, setMenu] = useState(false)
  const [shelf, setShelf] = useState(() => (CTX && CTX.storage.get('shelf', [])) || [])
  const [certHistory, setCertHistory] = useState(() => (CTX && CTX.storage.get('certHistory', [])) || [])
  const [link, setLink] = useState('idle') // 'live' | 'offline' | 'idle'
  const [jointGroup, setJointGroup] = useState('all')
  // pose bookmarks: named joint configurations kept across sessions — the
  // "wave" from the demo video, the carry pose from the build log
  const [bookmarks, setBookmarks] = useState(() => (CTX && CTX.storage.get('poseBookmarks', [])) || [])
  const saveBookmark = () => {
    const next = [...bookmarks, { id: `${Date.now()}-${bookmarks.length}`, name: `Pose ${bookmarks.length + 1}`, pose: pose.slice(), n: design.joints.length }].slice(-12)
    setBookmarks(next)
    if (CTX) CTX.storage.set('poseBookmarks', next)
  }
  const delBookmark = (i) => {
    const next = bookmarks.filter((_, k) => k !== i)
    setBookmarks(next)
    if (CTX) CTX.storage.set('poseBookmarks', next)
  }
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const [specOpen, setSpecOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [history, setHistory] = useState([])

  const spec = useMemo(() => composeDesign(brief), [brief])
  const { design, analysis } = spec

  const [pose, setPose] = useState(() => design.joints.map(() => 0))
  // `pose` is the COMMAND (what the sliders ask for); `dispPose` is the STATE
  // (where the joints physically are). The sim slews one toward the other at
  // each servo's real speed and stalls under overload — drag a slider and the
  // machine follows like hardware, not like a slider preview.
  const [dispPose, setDispPose] = useState(() => design.joints.map(() => 0))
  const simRef = useRef(null)
  const [cam, setCam] = useState(() => CAM_FOR(analysis.dims))
  const [opts, setOpts] = useState({ grid: true, dims: false, wire: false, cables: false, explode: false, heat: false })
  const [explodeF, setExplodeF] = useState(0.7) // assembly-view spread, 0..1.2

  // A joint set can change with the brief (3-DoF → 6-DoF): keep the pose array
  // the same length as the chain, or the sliders lie about the machine.
  useEffect(() => {
    setPose((p) => design.joints.map((j, i) => (p[i] == null ? 0 : clamp(p[i], j.min, j.max))))
  }, [design])

  // The physics loop: rebuild the sim when the machine changes, feed it every
  // commanded pose, and publish actual angles only while something is moving.
  useEffect(() => {
    const sim = createJointSim(design, analysis)
    simRef.current = sim
    sim.snap(pose)
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (sim.step(dt, now)) setDispPose([...sim.state.angles])
      // joint telemetry: actual angles + gravity-load ratio ~10Hz, ring of
      // 80 (~8s) — the scope shows motion AND where torque peaks
      telemetryRef.current.n += 1
      if (telemetryRef.current.n % 6 === 0) {
        const ts = telemetryRef.current
        const st = sim.state
        ts.samples.push({
          a: st.angles.slice(),
          l: st.stallNm.map((s, i) => (s > 0 ? Math.min(1.2, st.loadNm[i] / s) : 0)),
          f: st.stalled ? st.stalled.slice() : null,
        })
        if (ts.samples.length > 80) ts.samples.shift()
      }
      // endurance: drain the pack, heat the servos, feed thermal cutoffs back
      if (powerRef.current) {
        const drv = driveRef.current
        const motorA = drv ? Math.abs(drv.state.throttle) * motorARef.current : 0
        powerRef.current.step(dt * timeWarpRef.current, sim.state, motorA)
        sim.state.thermal = powerRef.current.state.cut
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); simRef.current = null }
    // pose is read once at snap; later commands arrive via the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, analysis])

  useEffect(() => {
    simRef.current && simRef.current.setTargets(pose)
  }, [pose])

  useEffect(() => {
    setCam((c) => ({ ...c, dist: CAM_FOR(analysis.dims).dist }))
  }, [analysis.dims[0], analysis.dims[1], analysis.dims[2]])

  useEffect(() => {
    if (CTX) CTX.storage.set('lastBrief', brief)
  }, [brief])

  // A build handed over by the agent (`::rigforge{...}` → card → here) lands
  // now, and the first thing it shows is what it changed: an agent rewrite is a
  // proposal, so it gets the same before/after as your own edits.
  const [fromAgent, setFromAgent] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  useEffect(() => {
    if (!CTX) return
    const pending = CTX.storage.get('pendingBrief', null)
    if (pending && pending.mission) {
      CTX.storage.remove('pendingBrief')
      const before = CTX.storage.get('lastBrief', null)
      if (before && before.mission) setHistory([{ brief: before, at: Date.now() }])
      setBrief({ ...DEFAULT_BRIEF, ...pending })
      setMission(pending.mission || '')
      setFromAgent(true)
      setSimple(false)
      setCompareOpen(true)
    }
  }, [])

  // Publish the computed summary so the agent can read back what was built
  // (`rigforge_state`): debounced, because sliders rebuild the design live.
  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      try {
        await bridge('/state', { method: 'POST', body: summarise(design, analysis, brief) })
        if (alive) setLink('live')
      } catch {
        if (alive) setLink('offline')
      }
    }, 600)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [design, analysis, brief])

  // Drain what the agent queued. Draining (not peeking) means each request is
  // applied exactly once, even with two windows open.
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const res = await bridge('/queue?limit=5')
        if (stopped) return
        setLink('live')
        const requests = (res && res.requests) || []
        if (!requests.length) return
        const req = requests[requests.length - 1] // oldest of the batch wins
        const next = { ...DEFAULT_BRIEF, ...(req.brief || {}) }
        setBrief(next)
        if (next.mission) setMission(next.mission)
        setTab('spec')
        host.notify({ kind: 'success', message: `Hermes queued a build: ${next.archetype}${req.note ? ' — ' + req.note : ''}` })
      } catch {
        if (!stopped) setLink('offline')
      }
    }
    tick()
    const id = setInterval(tick, 4000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [])

  const posedDesign = useMemo(() => ({
    ...design,
    joints: design.joints.map((j, i) => ({ ...j, angle: dispPose[i] || 0 })),
  }), [design, dispPose])

  const mesh = useMemo(() => buildMesh(posedDesign, opts.explode ? explodeF : 0), [posedDesign, opts.explode, explodeF])

  // teleop handles + kind live above the overlay memos: REACH reads them.
  const ikRef = useRef(null)
  const ikLRef = useRef(null) // left-arm teleop on dual-arm machines (humanoid)
  const [teleopKind, setTeleopKind] = useState(null)
  // Dual-mode machines (the robot: wheels + arm; the humanoid: legs + two
  // arms) cycle body → right arm → left arm with M or the ARM chip; the
  // body holds position while an arm poses. armMode: 0 body, 1 right, 2 left.
  // Declared up here because the overlay memos below read armMode.
  const [armMode, setArmMode] = useState(0)
  const [dualMode, setDualMode] = useState(false)
  const [armSides, setArmSides] = useState(1)
  const armModeRef = useRef(0)
  armModeRef.current = armMode

  // Live bench overlay: support polygon + CoM plumb recomputed with the pose,
  // so the floor tells the stability story while joints move.
  const benchOv = useMemo(
    () => benchOverlay(posedDesign, analysis.print && analysis.print.material),
    [posedDesign, analysis],
  )
  // Cable harness: one run per driven joint, coloured by whether the stock
  // servo lead reaches. Follows the live pose — wires drag with the arm.
  const cableOv = useMemo(
    () => (opts.cables && analysis.harness ? wireOverlay(posedDesign, analysis.harness) : null),
    [posedDesign, analysis.harness, opts.cables],
  )
  // Reach envelope: workspace sphere at the arm's base + live tip crosshair
  // when teleop is running. The sphere itself is pose-independent — it
  // renders for arm designs even before DRIVE mode is engaged.
  const designReach = useMemo(() => {
    const tip = primaryArmTip(design, armMode === 2 ? 'l' : undefined)
    return tip ? armReachBound(tip) : null
  }, [design, armMode])
  const reachOv = useMemo(() => {
    if (!opts.reach || !designReach) return null
    const armIk = armMode === 2 ? (ikLRef.current || ikRef.current) : ikRef.current
    const t = (teleopKind === 'ik' || (armMode && armIk)) ? armIk : null
    return reachOverlay(designReach, t ? t.tipPos(dispPose) : null)
  }, [opts.reach, teleopKind, armMode, designReach, design, dispPose])
  // Sampled workspace: the sphere is the bound; the cloud is what IK actually
  // reaches — cyan reachable, green also-liftable at the payload rating.
  const wsMap = useMemo(
    () => (opts.reach ? workspaceMap(design, analysis, { side: armMode === 2 ? 'l' : undefined }) : null),
    [opts.reach, design, analysis, armMode],
  )
  const wsOv = useMemo(() => workspaceOverlay(wsMap), [wsMap])
  // Legged machines get the same honest sampling per foot — where each leg
  // can actually plant, colour-coded FL/FR/RL/RR (or L/R on the humanoid).
  // Pose-independent: the clouds render whenever REACH is on, teleop or not.
  const legWsMap = useMemo(
    () => (opts.reach ? legWorkspaceMap(design) : null),
    [opts.reach, design],
  )
  const legWsOv = useMemo(() => legWorkspaceOverlay(legWsMap), [legWsMap])
  // Joint-load heat: crosshair per driven joint, coloured by the sim's live
  // gravity-load ratio — the torque story drawn on the machine itself.
  const loadOv = useMemo(() => {
    if (!opts.heat) return null
    const st = simRef.current && simRef.current.state
    if (!st || !st.loadNm) return null
    return loadOverlay(posedDesign, st.loadNm, st.stallNm, st.stalled)
  }, [opts.heat, posedDesign, dispPose])
  const rawOv = useMemo(() => {
    const parts = [benchOv, cableOv, reachOv, wsOv, legWsOv, loadOv].filter(Boolean)
    if (!parts.length) return null
    if (parts.length === 1) return parts[0]
    const total = parts.reduce((s, p) => s + p.data.length, 0)
    const d = new Float32Array(total)
    let off = 0
    for (const p of parts) { d.set(p.data, off); off += p.data.length }
    return { data: d, verts: parts.reduce((s, p) => s + p.verts, 0) }
  }, [benchOv, cableOv, reachOv, wsOv, legWsOv, loadOv])

  // ── drive mode: WASD / gamepad throttle+steer on wheeled machines ────────
  const driveRef = useRef(null)
  const gaitRef = useRef(null)
  const gripRef = useRef(null)
  const senseRef = useRef(null)
  const gantryRef = useRef(null)
  const powerRef = useRef(null)
  const motorARef = useRef(0)
  const [driveAvail, setDriveAvail] = useState(false)
  const [driveOn, setDriveOn] = useState(false)
  const [chassis, setChassis] = useState(null)
  const [benchEnv, setBenchEnv] = useState({ surface: 'hardwood', slopeDeg: 0, payloadKg: 0, course: 'rack' })
  const [, setSenseTick] = useState(0)
  const [timeWarp, setTimeWarp] = useState(1)
  const timeWarpRef = useRef(1)
  timeWarpRef.current = timeWarp
  const keysRef = useRef({})
  // Touch joystick: {x,y} in [-1,1], y+ = stick down. Injected into the same
  // input mix as keys/gamepad so every teleop mode gets it for free.
  const touchRef = useRef({ x: 0, y: 0, active: false })
  const [isTouch] = useState(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  const joyRef = useRef(null)
  const joyKnobRef = useRef(null)
  const joyVec = useCallback((e) => {
    const r = joyRef.current.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const R = r.width / 2 - 8
    let dx = (e.clientX - cx) / R, dy = (e.clientY - cy) / R
    const m = Math.hypot(dx, dy)
    if (m > 1) { dx /= m; dy /= m }
    touchRef.current = { x: +dx.toFixed(3), y: +dy.toFixed(3), active: true }
    if (joyKnobRef.current) joyKnobRef.current.style.transform = `translate(${dx * R * 0.62}px, ${dy * R * 0.62}px)`
  }, [])
  const joyEnd = useCallback(() => {
    touchRef.current = { x: 0, y: 0, active: false }
    if (joyKnobRef.current) joyKnobRef.current.style.transform = 'translate(0,0)'
  }, [])
  // pose sweep: {active,t} — tick() walks every joint min→max→rest so the
  // servo sim (not a teleport) exercises the real limits
  const sweepRef = useRef({ active: false, t: 0 })
  // joint telemetry ring: actual (not commanded) angles at ~10Hz for the scope
  const telemetryRef = useRef({ samples: [], n: 0 })
  // POSES▸ cycles presets per archetype without a chip row the layout gate hates
  const presetCycleRef = useRef({ arch: null, i: 0 })
  const spaceEdgeRef = useRef(false)
  const rumbleRef = useRef({})
  const benchStatsRef = useRef(null)
  const gpBtnRef = useRef(false)
  const autotestRef = useRef(null)
  const autoReportOffRef = useRef(false)
  const certLoggedRef = useRef(false)

  useEffect(() => {
    driveRef.current = createDrive(design, analysis)
    // Locomotion/manipulation primaries resolve first; arm IK is attempted
    // last and ALWAYS — dual-mode machines (robot: drive+arm, humanoid:
    // gait+arm) switch between them with M, everything else ignores it.
    gaitRef.current = driveRef.current ? null : createGaitTeleop(design)
    gripRef.current = (driveRef.current || gaitRef.current) ? null : createGripTeleop(design)
    senseRef.current = (driveRef.current || gaitRef.current || gripRef.current) ? null : createSensorTeleop(design)
    ikRef.current = createArmTeleop(design)
    // second arm only exists on side-prefixed designs (the humanoid)
    ikLRef.current = ikRef.current ? createArmTeleop(design, 'l') : null
    // gantry is the only all-slide machine — it gets teleop when nothing else did
    gantryRef.current = (driveRef.current || gaitRef.current || gripRef.current || senseRef.current || ikRef.current)
      ? null : createGantryTeleop(design)
    const kind = driveRef.current ? 'drive' : gaitRef.current ? 'gait' : gripRef.current ? 'grip' : senseRef.current ? 'sense' : ikRef.current ? 'ik' : gantryRef.current ? 'gantry' : null
    setTeleopKind(kind)
    // the primary suite doesn't have to be the only one: a humanoid walks AND
    // reaches with both arms, a drive robot with an arm tours the desk too
    const primaryTel = driveRef.current || gaitRef.current || gripRef.current || senseRef.current || ikRef.current || gantryRef.current
    const armSubs = []
    if (primaryTel !== ikRef.current && ikRef.current) armSubs.push({ t: ikRef.current, tag: ikLRef.current ? 'R' : 'ARM' })
    if (ikLRef.current) armSubs.push({ t: ikLRef.current, tag: 'L' })
    autotestRef.current = createAutotest(primaryTel, armSubs)
    setDriveAvail(!!kind)
    setDualMode(!!((driveRef.current || gaitRef.current) && ikRef.current))
    setArmSides((ikRef.current ? 1 : 0) + (ikLRef.current ? 1 : 0))
    setChassis(null)
    setArmMode(0)
    if (ikRef.current) ikRef.current.reset()
    if (ikLRef.current) ikLRef.current.reset()
    if (gaitRef.current) gaitRef.current.reset()
    if (gripRef.current) gripRef.current.reset()
    if (gantryRef.current) gantryRef.current.reset()
    powerRef.current = createPowerSim(design)
    const mk = design.metrics && design.metrics.motor ? PARTS[design.metrics.motor] : null
    motorARef.current = mk && mk.curr ? (mk.curr.typ || 0.5) * 2 : 0
  }, [design, analysis])

  useEffect(() => {
    if (driveRef.current) driveRef.current.setEnv(benchEnv)
  }, [benchEnv])

  useEffect(() => {
    if (!driveOn || (!driveRef.current && !ikRef.current && !gaitRef.current && !gripRef.current && !senseRef.current && !gantryRef.current)) return undefined
    const drive = driveRef.current
    const ik = ikRef.current
    const ikL = ikLRef.current
    const ikUse = armModeRef.current === 2 ? (ikL || ik) : ik
    const gait = gaitRef.current
    const grip = gripRef.current
    const sense = senseRef.current
    const gantry = gantryRef.current
    benchStatsRef.current = {
      seconds: 0, maxV: 0, bumps: 0, stallMs: 0, slipMs: 0,
      minSoc: 100, maxTemp: 0, cutouts: 0, ikErr: null, mode: teleopKind,
    }
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      // a dead pack is a dead machine — honest cutoff, not a slowdown
      const pwrDead = powerRef.current && powerRef.current.state.soc < 2
      const k = keysRef.current
      const gps = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
      const gp = gps && gps[0]
      // dual-mode: an arm IK owns the sticks while M cycles body→R→L, unless
      // the autopilot is mid-certification (it always runs the primary mode)
      const armDrive = !!(armModeRef.current && (ik || ikL) && !(autotestRef.current && autotestRef.current.running))
      // a sequenced autopilot (gait + both arms) reports which suite is live —
      // route the tick to that teleop's channel instead of the machine's primary
      const atKind = autotestRef.current && autotestRef.current.running && autotestRef.current.activeKind
        ? autotestRef.current.activeKind : null
      if (!pwrDead && drive && !armDrive && (!atKind || atKind === 'drive')) {
        const at = autotestRef.current
        let throttle, steer
        if (at && at.running) {
          ;({ throttle, steer } = at.tick(dt))
        } else {
          throttle = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
          steer = (k.a || k.arrowleft ? 1 : 0) - (k.d || k.arrowright ? 1 : 0)
        }
        if (gp && !(at && at.running)) {
          const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v)
          const gx = dz(gp.axes[0] || 0)
          const gy = dz(gp.axes[1] || 0)
          if (Math.abs(gx) > 0.04 || Math.abs(gy) > 0.04) { steer = -gx; throttle = -gy }
        }
        // a finger on the stick is a deliberate input — it wins over keys
        if (touchRef.current.active && !(at && at.running)) {
          steer = touchRef.current.x
          throttle = -touchRef.current.y
        }
        drive.step({ throttle, steer }, dt)
        // gamepad face button = shove test (edge-triggered)
        if (gp && gp.buttons && gp.buttons[1] && gp.buttons[1].pressed && !gpBtnRef.current) drive.shove(15)
        gpBtnRef.current = !!(gp && gp.buttons && gp.buttons[1] && gp.buttons[1].pressed)
        setChassis({ ...drive.state })
      } else if (!pwrDead && ikUse && (atKind ? atKind === 'ik' : (armModeRef.current || !gait))) {
        // WASD/arrows plane, R/F height; left stick plane, right stick height
        let cx = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
        let cy = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0)
        let cz = (k.r ? 1 : 0) - (k.f ? 1 : 0)
        const at = autotestRef.current
        const actual = simRef.current ? simRef.current.state.angles : dispPose
        if (gp && !(at && at.running)) {
          const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v)
          const gx = dz(gp.axes[0] || 0)
          const gy = dz(gp.axes[1] || 0)
          const gz = dz(gp.axes[3] != null ? gp.axes[3] : gp.axes[2] || 0)
          if (Math.abs(gx) > 0.04 || Math.abs(gy) > 0.04 || Math.abs(gz) > 0.04) {
            cx = -gy; cy = gx; cz = -gz
          }
        }
        if (touchRef.current.active && !(at && at.running)) {
          cx = -touchRef.current.y; cy = touchRef.current.x; cz = 0
        }
        let certPose = null
        if (at && at.running) {
          const c = at.tick(dt, actual)
          if (c && c.pose) certPose = c.pose
          else if (c) { cx = c.x || 0; cy = c.y || 0; cz = c.z || 0 }
        }
        // certification runs carry their own IK-solved pose — applying it
        // directly skips the velocity-cmd layer the script already bypassed
        const desired = certPose || ikUse.step({ x: cx, y: cy, z: cz }, dt, actual)
        if (desired) setPose(desired)
      } else if (!pwrDead && gait && (!atKind || atKind === 'gait')) {
        // W/S walk speed, A/D steer; gamepad left stick same
        const want = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
        const turn = (k.a || k.arrowleft ? 1 : 0) - (k.d || k.arrowright ? 1 : 0)
        let gx = want, gy = turn
        const at = autotestRef.current
        if (gp && !(at && at.running)) {
          const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v)
          const gx2 = dz(gp.axes[0] || 0)
          const gy2 = dz(gp.axes[1] || 0)
          if (Math.abs(gx2) > 0.04 || Math.abs(gy2) > 0.04) { gy = -gx2; gx = -gy2 }
        }
        if (touchRef.current.active && !(at && at.running)) { gx = -touchRef.current.y; gy = -touchRef.current.x }
        let gaitEnv = benchEnv
        if (at && at.running) {
          const c = at.tick(dt)
          if (c) {
            gx = c.x || 0; gy = c.y || 0
            // LOAD certification phase carries a virtual payload — merge it
            // into the env for this frame only
            if (c.payloadKg != null && c.payloadKg !== benchEnv.payloadKg) {
              gaitEnv = { ...benchEnv, payloadKg: c.payloadKg }
            }
          }
        }
        const actual = simRef.current ? simRef.current.state.angles : dispPose
        if (gait.locomote) {
          const r = gait.locomote({ x: gx, y: gy }, dt, actual, gaitEnv)
          if (r && r.pose) setPose(r.pose)
          if (r && r.chassis) setChassis({ ...r.chassis })
        } else {
          const desired = gait.step({ x: gx }, dt, actual)
          if (desired) setPose(desired)
        }
      } else if (!pwrDead && grip && (!atKind || atKind === 'grip')) {
        const at = autotestRef.current
        const gcmd = at && at.running ? at.tick(dt) : { grip: k.space, gripEdge: spaceEdgeRef.current }
        const desired = grip.step(gcmd, dt)
        if (desired) setPose(desired)
      } else if (!pwrDead && sense && (!atKind || atKind === 'sense')) {
        // sensor nodes have no motion cmd — the autopilot writes stimulus
        // fields straight into teleop state on its own timeline
        const at = autotestRef.current
        if (at && at.running) at.tick(dt)
      } else if (!pwrDead && gantry && (!atKind || atKind === 'gantry')) {
        // gantry: WASD plane, F feeds / R raises — or the cert script's cmd
        const at = autotestRef.current
        let cx = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0)
        let cy = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0)
        let cz = (k.f ? 1 : 0) - (k.r ? 1 : 0)
        if (!(at && at.running)) {
          if (gp) {
            const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v)
            const gx = dz(gp.axes[0] || 0)
            const gy = dz(gp.axes[1] || 0)
            const gz = dz(gp.axes[3] != null ? gp.axes[3] : gp.axes[2] || 0)
            if (Math.abs(gx) > 0.04 || Math.abs(gy) > 0.04 || Math.abs(gz) > 0.04) {
              cx = -gy; cy = gx; cz = gz
            }
          }
          if (touchRef.current.active) { cx = -touchRef.current.y; cy = touchRef.current.x; cz = 0 }
        }
        if (at && at.running) {
          const c = at.tick(dt, simRef.current ? simRef.current.state.angles : null)
          if (c) { cx = c.x || 0; cy = c.y || 0; cz = c.z || 0 }
        }
        const desired = gantry.step({ x: cx, y: cy, z: cz }, dt)
        if (desired) setPose(desired)
      }
      // POSE→SWEEP: command min, then max, then rest — the joint sim slews at
      // real servo speed, so stalls and torque limits show up live
      const sw = sweepRef.current
      if (sw.active) {
        sw.t += dt
        const PH = 1.15
        if (sw.t < PH) setPose(design.joints.map((j) => j.min * 0.85))
        else if (sw.t < PH * 2) setPose(design.joints.map((j) => j.max * 0.85))
        else if (sw.t < PH * 3) { setPose(design.joints.map(() => 0)); sw.active = false }
      }
      // a finished certification run goes into persistent history once —
      // the card and REPORT can then show "best for this machine"
      const atDone = autotestRef.current
      if (atDone && atDone.done && !certLoggedRef.current) {
        certLoggedRef.current = true
        try {
          const entry = {
            arch: design.archetype || (design.brief && design.brief.archetype) || '?',
            mode: drive ? 'drive' : ik ? 'ik' : gait ? 'gait' : grip ? 'grip' : sense ? 'sense' : '?',
            passes: atDone.results.filter((r) => r.pass).length,
            total: atDone.results.length,
            ts: Date.now(),
            phases: atDone.results.map((r) => `${r.label}:${r.pass ? 'P' : 'F'}`).join(' '),
          }
          setCertHistory((h) => {
            const next = [...h, entry].slice(-30)
            if (CTX) CTX.storage.set('certHistory', next)
            return next
          })
        } catch { /* storage may be unavailable */ }
      } else if (atDone && atDone.running) {
        certLoggedRef.current = false
      }
      // bench stats: everything the test report needs, accumulated live
      const bs = benchStatsRef.current
      if (bs) {
        bs.seconds += dt
        const st = drive ? drive.state : (gait && gait.locomoteState) || null
        if (st) {
          bs.maxV = Math.max(bs.maxV, Math.abs(st.v))
          bs.stallMs += st.stall ? dt * 1000 : 0
          bs.slipMs += st.slip ? dt * 1000 : 0
          bs.bumps = Math.max(bs.bumps, st.bumps || 0)
        }
        if (ik && ik.state && ik.state.ready) bs.ikErr = Math.max(bs.ikErr || 0, ik.state.err || 0)
        const ps = powerRef.current && powerRef.current.state
        if (ps) {
          bs.minSoc = Math.min(bs.minSoc, ps.soc)
          const tmax = ps.temps && ps.temps.length ? Math.max(...ps.temps) : 0
          bs.maxTemp = Math.max(bs.maxTemp, tmax)
          bs.cutouts = Math.max(bs.cutouts, (ps.cut || []).filter(Boolean).length)
        }
      }
      // haptics: edge-triggered rumble — stall, wheelspin, bumps, joint stall,
      // dead pack, sensor alert. One buzz per event, not a continuous scream.
      if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
        const mob = drive ? drive.state : (gait && gait.locomoteState) || null
        const bumpN = (mob && mob.bumps) || 0
        const jstall = !!(simRef.current && simRef.current.state.stalled && simRef.current.state.stalled.some(Boolean))
        const sal = sense ? sense.hud().alerts.length : 0
        const now2 = {
          stall: !!(mob && mob.stall),
          slip: !!(mob && mob.slip),
          bump: bumpN,
          jstall,
          dead: !!pwrDead,
          sense: sal > 0,
        }
        const prev = rumbleRef.current
        const buzz = (sMag, wMag, ms) => {
          try { gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: sMag, weakMagnitude: wMag }) } catch { /* pad went away */ }
        }
        if (now2.stall && !prev.stall) buzz(0.7, 0.5, 220)
        else if (now2.slip && !prev.slip) buzz(0.35, 0.35, 120)
        if (now2.bump > prev.bump) buzz(0.9, 0.2, 140)
        if (now2.jstall && !prev.jstall) buzz(0.6, 0.6, 200)
        if (now2.dead && !prev.dead) buzz(1, 1, 400)
        if (now2.sense && !prev.sense) buzz(0.3, 0.5, 150)
        rumbleRef.current = now2
      }
      spaceEdgeRef.current = false
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [driveOn])

  useEffect(() => {
    if (!driveOn) return undefined
    const dn = (e) => {
      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) {
        keysRef.current[key === ' ' ? 'space' : key] = true
        if (key === ' ' && !e.repeat) spaceEdgeRef.current = true
        e.preventDefault()
      }
      if (key === '0') { driveRef.current && driveRef.current.reset(); ikRef.current && ikRef.current.reset(); ikLRef.current && ikLRef.current.reset(); gaitRef.current && gaitRef.current.reset(); gripRef.current && gripRef.current.reset(); senseRef.current && senseRef.current.reset(); gantryRef.current && gantryRef.current.reset(); powerRef.current && powerRef.current.reset() }
      if (key === 'x' && driveRef.current) driveRef.current.shove(15)
      if (key === 'm' && (driveRef.current || gaitRef.current) && ikRef.current && !(autotestRef.current && autotestRef.current.running)) {
        const sides = (ikRef.current ? 1 : 0) + (ikLRef.current ? 1 : 0)
        setArmMode((v) => (sides > 1 ? (v + 1) % 3 : v ? 0 : 1))
      }
    }
    const up = (e) => { keysRef.current[e.key.toLowerCase() === ' ' ? 'space' : e.key.toLowerCase()] = false }
    window.addEventListener('keydown', dn)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up) }
  }, [driveOn])

  // The displayed mesh: applyChassis mutates verts in place on persistent tri
  // objects so the array identity — and the renderer's topology/tint cache —
  // survives every frame. The traction rack rides along as extra world-space
  // tris appended once per (mesh, slope, drive) change.
  const xfRef = useRef(null)
  // World-space bench props ride along as extra tris: the traction rack for
  // drive mode, the pick-place desk for reach mode. Identity-stable per
  // (mesh, mode, slope) so the renderer caches survive every frame.
  const rtTris = useMemo(
    () => (driveOn && (teleopKind === 'drive' || teleopKind === 'gait')
      ? (benchEnv.course === 'room' ? livingRoomTris() : benchEnv.course === 'stairs' ? stairsTris() : benchRampTris(benchEnv.slopeDeg))
      : driveOn && teleopKind === 'ik' ? deskPropsTris()
      : driveOn && teleopKind === 'grip' ? gripBenchTris() : null),
    [driveOn, teleopKind, benchEnv],
  )
  const viewMesh = useMemo(() => {
    if (!chassis && !rtTris) return mesh
    const rtSig = rtTris ? ((teleopKind === 'drive' || teleopKind === 'gait') ? (benchEnv.course === 'room' ? 'room' : benchEnv.course === 'stairs' ? 'stairs' : `ramp${benchEnv.slopeDeg}`) : teleopKind === 'ik' ? 'desk' : 'grip') : null
    let xf = xfRef.current
    if (!xf || xf.src !== mesh || xf.rtSig !== rtSig || (xf.mach && !chassis)) {
      xf = {
        src: mesh, rtSig,
        mach: chassis ? new Array(mesh.length) : null,
        rt: rtTris, combined: null,
      }
      xfRef.current = xf
    }
    const mach = chassis ? applyChassis(mesh, chassis, benchEnv.slopeDeg, xf.mach, benchEnv.course) : mesh
    if (!xf.combined) {
      const n = mach.length + (xf.rt ? xf.rt.length : 0)
      xf.combined = new Array(n)
      for (let i = 0; i < mach.length; i++) xf.combined[i] = mach[i]
      if (xf.rt) for (let i = 0; i < xf.rt.length; i++) xf.combined[mach.length + i] = xf.rt[i]
    }
    return xf.combined
  }, [mesh, chassis, rtTris, teleopKind, benchEnv])

  // The overlay rides the machine in plan, but its points live ON the terrain:
  // yaw+translate in x/y, then each point takes the ramp height under it.
  // camera chases the machine, not the course: course dressing can span
  // metres while cam.dist is framed on the machine's own dimensions
  const machBounds = useMemo(() => boundsOfMesh(mesh), [mesh])
  const camFocus = useMemo(() => {
    if (!chassis) return null
    const c = Math.cos(chassis.yaw), sn = Math.sin(chassis.yaw)
    const cx = (machBounds.min[0] + machBounds.max[0]) / 2
    const cy = (machBounds.min[1] + machBounds.max[1]) / 2
    const cz = (machBounds.min[2] + machBounds.max[2]) / 2
    return [
      cx * c - cy * sn + chassis.x * 1000,
      cx * sn + cy * c + chassis.y * 1000,
      terrainHeight(chassis.x, benchEnv.slopeDeg, benchEnv.course) * 1000 + cz,
    ]
  }, [chassis, machBounds, benchEnv])
  // floor contact-shadow radius tracks the machine, not the (possibly huge) course
  const subjectR = useMemo(() => {
    const d = [0, 1, 2].map((i) => machBounds.max[i] - machBounds.min[i])
    return Math.min(1600, Math.max(160, Math.max(...d) * 0.8))
  }, [machBounds])
  const viewOpts = useMemo(
    () => ({ ...opts, subjectR, subjectBounds: machBounds, focus: camFocus }),
    [opts, subjectR, machBounds, camFocus],
  )
  const benchOvWorld = useMemo(() => {
    if (!rawOv || !chassis) return rawOv
    const c = Math.cos(chassis.yaw), sn = Math.sin(chassis.yaw)
    const slope = benchEnv.slopeDeg
    const d = rawOv.data
    const out = new Float32Array(d.length)
    for (let i = 0; i < d.length; i += 6) {
      // overlay verts are mm (design space); chassis state is metres
      const wx = (d[i] * c - d[i + 1] * sn) / 1000 + chassis.x
      const wy = (d[i] * sn + d[i + 1] * c) / 1000 + chassis.y
      out[i] = wx * 1000
      out[i + 1] = wy * 1000
      out[i + 2] = terrainHeight(wx, slope, benchEnv.course) * 1000 + d[i + 2]
      out[i + 3] = d[i + 3]; out[i + 4] = d[i + 4]; out[i + 5] = d[i + 5]
    }
    return { data: out, verts: rawOv.verts }
  }, [rawOv, chassis, benchEnv])

  const armHudIk = armMode === 2 ? (ikLRef.current || ikRef.current) : ikRef.current
  const armHud = armMode && armHudIk && !(autotestRef.current && autotestRef.current.running)
  const teleop = (armHud ? armHudIk : null) || driveRef.current || ikRef.current || gaitRef.current || gripRef.current || senseRef.current || gantryRef.current
  const driveHud = driveOn && teleop && (teleopKind !== 'ik' || ikRef.current.state.ready)
    ? teleop.hud()
    : null
  const powerHud = powerRef.current ? powerRef.current.hud() : null
  // Desk-bench verdict: which pick-place prop is the end-effector over, and
  // does its mass beat the arm's payload rating?
  const propHud = useMemo(() => {
    if (teleopKind !== 'ik' || !ikRef.current || !ikRef.current.state.ready) return null
    const s = ikRef.current.state
    const near = deskPropNear(s.tx, s.ty, s.tz)
    if (!near) return null
    const ratingG = ((design.metrics && design.metrics.payloadKg) || 0) * 1000
    return { name: near.prop.name, massG: near.prop.massG, ratingG, over: ratingG > 0 && near.prop.massG > ratingG }
  }, [driveHud, teleopKind, design])
  // Grip bench verdict: the 1kg test mass vs this gripper's hold capacity.
  const gripHud = useMemo(() => {
    if (teleopKind !== 'grip') return null
    const hold = design.metrics && design.metrics.gripMassKg
    if (!hold) return null
    return { holdKg: hold, blockKg: GRIP_BENCH.massG / 1000, ok: hold >= GRIP_BENCH.massG / 1000 }
  }, [teleopKind, design])
  // Break → Fix: the bench detects failures; this line prescribes the fix.
  // benchLive mirrors SimplePanel's verdict but lives in Studio scope.
  const benchLive = useMemo(() => benchReport(design, analysis, { slopeDeg: 15 }), [design, analysis])
  const certArch = design.archetype || (design.brief && design.brief.archetype)
  const certBest = certHistory.filter((x) => x.arch === certArch)
    .reduce((m, x) => (!m || x.passes > m.passes ? x : m), null)

  const fixes = useMemo(() => fixSuggestions({ bench: benchLive, drive: driveHud, prop: propHud, grip: gripHud, sense: driveHud, power: powerHud, reach: analysis.reach, autotest: autotestRef.current ? autotestRef.current.results : null, brief }),
    [benchLive, driveHud, propHud, gripHud, powerHud, analysis.reach, certHistory, brief])

  // Field-test report: everything the bench logged, as a markdown file the
  // builder can attach to the print pack or paste into a build log.
  const downloadReport = useCallback(() => {
    const bs = benchStatsRef.current || {}
    const modeName = { drive: 'DRIVE', ik: 'REACH', gait: 'WALK', grip: 'GRIP', sense: 'SENSE' }[bs.mode] || 'MANUAL'
    const md = [
      '# RigForge field-test report',
      '',
      `- **machine:** ${design.title || design.subtitle || 'untitled'}`,
      `- **mode:** ${modeName} · **duration:** ${((bs.seconds || 0)).toFixed(0)}s sim`,
      bs.maxV ? `- **top speed:** ${bs.maxV.toFixed(2)} m/s` : null,
      bs.bumps ? `- **obstacle hits:** ${bs.bumps}` : null,
      (bs.stallMs || bs.slipMs) ? `- **stall time:** ${(bs.stallMs / 1000).toFixed(1)}s · **slip time:** ${(bs.slipMs / 1000).toFixed(1)}s` : null,
      bs.ikErr != null ? `- **worst IK error:** ${bs.ikErr.toFixed(1)} mm` : null,
      `- **battery:** lowest SoC ${(bs.minSoc ?? 100).toFixed(0)}% of pack`,
      bs.maxTemp ? `- **peak servo temp:** ${bs.maxTemp.toFixed(0)}°C · **thermal cutouts:** ${bs.cutouts || 0}` : null,
      `- **verdict:** ${fixes.length ? fixes[0].msg : 'no failures logged — bench clean'}`,
      '',
      '## Engineering summary',
      `- **mass:** ${(analysis.mass.totalG / 1000).toFixed(2)} kg (printed ${(analysis.mass.printedG / 1000).toFixed(2)} kg, parts ${(analysis.mass.partsG / 1000).toFixed(2)} kg)`,
      `- **cost:** $${analysis.cost.toFixed(2)} ($${analysis.costBuy.toFixed(2)} to buy, $${analysis.costShop.toFixed(2)} to print)`,
      `- **print:** ${(analysis.print.grams / 1000).toFixed(2)} kg ${(analysis.print.material || 'filament')}, ~${analysis.print.hours.toFixed(1)}h · ${analysis.print.overhang.unsupportedMm2}mm² unsupported`,
      `- **power:** ${analysis.power.typ != null ? `${analysis.power.typ.toFixed(1)}A typical / ${analysis.power.peak.toFixed(1)}A peak` : 'n/a'}${analysis.power.runtimeMin != null ? ` · ~${analysis.power.runtimeMin.toFixed(0)} min runtime` : ''}`,
      ...(analysis.checks.some((c) => c.level === 'fail')
        ? ['', '### Blocking checks', ...analysis.checks.filter((c) => c.level === 'fail').map((c) => `- FAIL ${c.msg}`)]
        : analysis.checks.some((c) => c.level === 'warn')
          ? ['', '### Warnings', ...analysis.checks.filter((c) => c.level === 'warn').map((c) => `- WARN ${c.msg}`)]
          : ['', '### Checks', ...analysis.checks.filter((c) => c.level === 'ok').slice(0, 4).map((c) => `- ${c.msg}`)]),
      ...(autotestRef.current && autotestRef.current.results.length ? [
        '',
        `## Auto test — ${autotestRef.current.score}`,
        ...autotestRef.current.results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} **${r.label}** — ${r.detail}`),
      ] : []),
      ...(telemetryRef.current.samples.length > 2 ? (() => {
        const S = telemetryRef.current.samples
        const secs = ((S.length / 10) | 0)
        const rows = design.joints.map((j, i) => {
          const av = S.map((s) => s.a[i] ?? 0)
          const lv = S.map((s) => s.l[i] ?? 0)
          const fv = S.map((s) => (s.f && s.f[i]) ? 1 : 0)
          const unit = j.slide ? 'mm' : '°'
          const peak = Math.max(...lv)
          return `| ${j.label} | ${Math.min(...av).toFixed(0)}…${Math.max(...av).toFixed(0)}${unit} | ${peak >= 1.19 ? '≥119%' : `${(peak * 100).toFixed(0)}%`} | ${fv.reduce((n, v) => n + v, 0)} |`
        })
        return ['', `## Joint telemetry — last ${secs}s actual (not commanded)`, '',
          '| joint | travelled | peak load | stall samples |', '|---|---|---|---|', ...rows]
      })() : []),
      // thermal evidence: which servo actually cooked during the run —
      // peaks and cutout counts come from the live power sim, not a guess
      ...(powerRef.current && powerRef.current.state && powerRef.current.state.peak ? (() => {
        const ps = powerRef.current.state
        const hot = ps.peak.map((p, i) => ({ i, p })).filter((x) => x.p > 40)
        if (!hot.length && !ps.cutN.some(Boolean)) return []
        const rows = design.joints.map((j, i) =>
          `| ${j.label} | ${(ps.peak[i] ?? 25).toFixed(0)}°C | ${ps.cutN[i] || 0} |`)
        return ['', '## Thermals — peak joint temps this session', '',
          '| joint | peak | cutouts |', '|---|---|---|', ...rows,
          '', `_pack ${ps.soc.toFixed(1)}% SoC (lowest ${ps.socMin.toFixed(1)}%) · peak bus draw ${(ps.peakA || 0).toFixed(1)}A · ambient 25°C_`]
      })() : []),
      '',
      '_Generated by RigForge test bench — numbers are simulated, not measured._',
    ].filter(Boolean).join('\n')
    try {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = 'rigforge-test-report.md'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch { /* SSR / no DOM */ }
  }, [design, analysis, fixes])

  const applyBrief = useCallback((next) => {
    setBrief((cur) => ({ ...cur, ...next }))
  }, [])

  const pickArchetype = (id) => {
    const preset = PRESETS.find((p) => p.brief.archetype === id)
    const next = { ...DEFAULT_BRIEF, ...(preset ? preset.brief : { archetype: id }) }
    setBrief(next)
    setMission(next.mission)
  }

  // One place records what a change replaced, whatever path made it: a preset,
  // the palette, a slider or an agent directive. Debounced so a slider drag is
  // one "before", not forty.
  const briefRef = useRef(brief)
  useEffect(() => {
    const prev = briefRef.current
    if (prev === brief) return undefined
    briefRef.current = brief
    if (JSON.stringify(prev) === JSON.stringify(brief)) return undefined
    const t = setTimeout(() => {
      setHistory((h) => (JSON.stringify(h[0] && h[0].brief) === JSON.stringify(prev) ? h : [{ brief: prev, at: Date.now() }, ...h].slice(0, 4)))
    }, 900)
    return () => clearTimeout(t)
  }, [brief])

  // ⌘K / Ctrl+K opens the palette; Esc closes it from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onBuild = () => {
    // An empty brief is not an error — it is an invitation. Surprise them.
    const parsed = mission.trim() ? parseBrief(mission) : { ...PRESETS[Math.floor(Math.random() * PRESETS.length)].brief }
    // A custom machine's design IS its nodes/joints spec — re-parsing the
    // mission text would silently swap it for an archetype guess.
    const keep = brief.archetype === 'custom' && parsed.archetype !== 'custom'
      ? { archetype: 'custom', nodes: brief.nodes, joints: brief.joints, title: brief.title } : {}
    applyBrief({ ...parsed, ...keep, material: brief.material, mcu: brief.mcu, battery: brief.battery })
  }

  const loadWorkedExample = (ex) => {
    const next = { ...DEFAULT_BRIEF, ...ex.brief }
    setBrief(next)
    setMission(next.mission || '')
    setMissionDirty(true)
  }

  const surprise = () => {
    const p = PRESETS[Math.floor(Math.random() * PRESETS.length)]
    const jitter = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v * (0.8 + Math.random() * 0.5))))
    const b = { ...DEFAULT_BRIEF, ...p.brief, payloadKg: Math.round((p.brief.payloadKg || 1) * (0.7 + Math.random() * 0.9) * 10) / 10 }
    if (p.brief.reachMm) b.reachMm = jitter(p.brief.reachMm, 150, 900)
    setBrief(b)
    setMission(b.mission)
  }

  const saveToShelf = () => {
    const entry = {
      id: `${Date.now()}`,
      title: design.title,
      archetype: brief.archetype,
      cost: Math.round(analysis.cost * 100) / 100,
      brief,
      code: encodeBuild(brief),
      at: Date.now(),
    }
    const next = [entry, ...shelf.filter((s) => s.title !== design.title)].slice(0, 8)
    setShelf(next)
    if (CTX) CTX.storage.set('shelf', next)
    host.notify({ kind: 'success', message: `${design.title} saved` })
  }

  const askHermes = async () => {
    const prompt = agentPrompt(brief, spec, `Redesign this ${brief.archetype} — make it better and hand it back as a directive.`)
    try {
      const staged = await host.composer.setDraft(null, prompt)
      host.composer.focus(null)
      host.notify({
        kind: staged ? 'success' : 'error',
        message: staged ? 'Spec handed to Hermes — press Enter to send' : 'No composer surface answered; spec copied instead',
      })
      if (!staged) await navigator.clipboard.writeText(prompt)
    } catch {
      try { await navigator.clipboard.writeText(prompt) } catch { /* clipboard blocked */ }
      host.notify({ kind: 'info', message: 'Spec copied — paste it into chat' })
    }
  }

  const copyBuildCode = async () => {
    const code = encodeBuild(brief)
    try {
      await navigator.clipboard.writeText(code)
      host.notify({ kind: 'success', message: `Build code copied — ${code.length} characters` })
    } catch {
      download(`${slug(design.title)}-code.txt`, code, 'text/plain')
      host.notify({ kind: 'info', message: 'Clipboard blocked — saved as a file instead' })
    }
  }

  const fileBase = slug(design.title)
  // plates > 1 means the single 3MF can't slice clean — the ZIP then carries
  // one ready-to-slice 3MF per plate alongside the per-part STLs.
  const packPlates = !design.pcb && analysis.print && analysis.print.pack ? analysis.print.pack.plates : 0
  const exports = [
    ['Build code · share this design', copyBuildCode],
    ['STL mesh (mm)', () => download(`${fileBase}.stl`, toSTL(buildMesh(posedDesign)), 'model/stl')],
    ['glTF mesh (.glb · viewers/engines)', () => download(`${fileBase}.glb`, toGLB(buildMesh(posedDesign)), 'model/gltf-binary')],
    ['CAD solid · STEP (mm · Fusion/SolidWorks)', () => download(`${fileBase}.step`, toSTEP(posedDesign), 'application/step')],
    // What leaves the app has to match what the machine actually needs: a
    // printed machine wants STLs, a board wants the fab/assembly three files.
    design.pcb
      ? ['Board pack · BOM + CPL + spec (zip)', () => download(`${fileBase}-boardpack.zip`, zipStore(boardPack(design, analysis, fileBase)), 'application/zip')]
      : [`Print pack · per-part STLs${packPlates > 1 ? ` + ${packPlates} plate-ready 3MFs + plate map` : ''} (zip)`, () => {
        const entries = printedPartSTLs(design)
        const mat = analysis.print && analysis.print.material
        for (let p = 0; p < packPlates; p++) {
          const b = to3MF(design, mat, p)
          if (b) entries.push({ name: `${fileBase}-plate${p + 1}.3mf`, buf: b })
        }
        if (packPlates > 1) {
          // part→plate map for anyone slicing the loose STLs themselves —
          // the 3MFs already group, but STL users need the same answer
          const plateOf = new Map((analysis.print.pack.items || []).map((it) => [it.id, it.plate + 1]))
          const rows = ['part,plate']
          for (const n of design.nodes) if (n.print) rows.push(`${slug(n.id)},${plateOf.get(n.id) || '?'}`)
          entries.push({ name: 'plates.csv', buf: rows.join('\n') })
        }
        entries.push({ name: 'README.txt', buf: printPackReadme(design, analysis, fileBase) })
        download(`${fileBase}-printpack.zip`, zipStore(entries), 'application/zip')
      }],
    ...(design.pcb ? [] : [['Print pack · 3MF slicer file', () => {
      const buf = to3MF(design, analysis.print && analysis.print.material)
      if (buf) download(`${fileBase}-printpack.3mf`, buf, 'model/3mf')
    }]]),
    ['OpenSCAD source', () => download(`${fileBase}.scad`, toOpenSCAD(design), 'text/plain')],
    ['Build spec .md', () => {
      // workspace maps are memoized when REACH was on; otherwise compute now —
      // a one-time ~1s IK sweep is the honest price of real numbers in the spec
      const extras = {
        ws: wsMap || workspaceMap(design, analysis),
        legWs: legWsMap || legWorkspaceMap(design),
      }
      download(`${fileBase}.md`, toSpecMarkdown(design, analysis, extras), 'text/markdown')
    }],
    ['Bill of materials .csv', () => download(`${fileBase}-bom.csv`, toBOMCsv(design, analysis), 'text/csv')],
    ...(design.pcb && design.pcb.placed.length
      ? [['Centroid / CPL .csv (for assembly)', () => download(`${fileBase}-cpl.csv`, toCentroidCsv(design), 'text/csv')]]
      : []),
    ['Firmware .ino', () => download(`${fileBase}.ino`, design.firmware, 'text/plain')],
    // a real simulator loads these: URDF for ROS/Isaac/Drake/PyBullet, MJCF for MuJoCo
    ['URDF (ROS · Gazebo · Isaac)', () => download(`${fileBase}.urdf`, toURDF(design, analysis), 'application/xml')],
    ['MJCF (MuJoCo dynamics)', () => download(`${fileBase}.xml`, toMJCF(design, analysis), 'application/xml')],
    ['Spec JSON (for Hermes)', async () => {
      const json = JSON.stringify({ brief, design: design.title, metrics: design.metrics, checks: analysis.checks, parts: design.parts }, null, 2)
      try {
        await navigator.clipboard.writeText(json)
        host.notify({ kind: 'success', message: 'Spec JSON copied' })
      } catch {
        download(`${fileBase}.json`, json, 'application/json')
      }
    }],
  ]

  const shownJoints = design.joints.filter((j) => jointGroup === 'all' || (jointGroup === 'body'
    ? j.id.startsWith('waist') || j.id.startsWith('neck')
    : j.id.startsWith(`${jointGroup}-`)))
  const poseOverflows = shownJoints.length > 9

  const canMirror = design.joints.some((j) => j.id.startsWith('r-')
    && design.joints.some((k) => k.id === `l-${j.id.slice(2)}`))

  // Everything the palette can reach. Built from the same lists the UI renders,
  // so a new archetype or export shows up here without a second edit.
  const commands = useMemo(() => {
    const list = []
    for (const p of PRESETS) {
      list.push({
        id: 'machine-' + p.id, group: 'MACHINE', label: p.label, hint: p.brief.archetype,
        run: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission); setMissionDirty(false) },
      })
    }
    for (const [id, label] of TABS) {
      list.push({ id: 'tab-' + id, group: 'TAB', label, hint: 'open', run: () => { setSimple(false); setTab(id) } })
    }
    for (const [label, fn] of exports) {
      list.push({ id: 'export-' + label, group: 'EXPORT', label, run: fn })
    }
    list.push({ id: 'act-audit', group: 'ACTION', label: 'Show the working — audit every number', run: () => setAuditOpen(true) })
    list.push({ id: 'act-compare', group: 'ACTION', label: 'Compare with the previous build', run: () => setCompareOpen(true) })
    list.push({ id: 'act-share', group: 'ACTION', label: 'Copy a build code to share this design', run: copyBuildCode })
    list.push({ id: 'act-open-code', group: 'ACTION', label: 'Open a build code', run: () => setCodeOpen(true) })
    list.push({ id: 'act-build', group: 'ACTION', label: 'Build this machine', hint: '⏎', run: onBuild })
    list.push({ id: 'act-hermes', group: 'ACTION', label: 'Ask Hermes to redesign it', run: askHermes })
    list.push({ id: 'act-save', group: 'ACTION', label: 'Save this build to the shelf', run: saveToShelf })
    list.push({ id: 'act-simple', group: 'ACTION', label: 'Toggle plain words / engineering', run: () => { const n = !simple; setSimple(n); if (CTX) CTX.storage.set('simple', n) } })
    list.push({ id: 'act-home', group: 'ACTION', label: 'Reset every joint to zero', run: () => setPose(design.joints.map(() => 0)) })
    for (const p of POSE_PRESETS[design.archetype] || []) {
      list.push({
        id: `act-pose-${p.name}`, group: 'ACTION', label: `Pose: ${p.name}`,
        run: () => {
          const live = simRef.current && simRef.current.state ? simRef.current.state.angles : null
          const a = applyPosePreset(design, p.name, live)
          if (a) setPose(a)
        },
      })
    }
    return list
  }, [simple, brief, design])

  const fails = analysis.checks.filter((c) => c.level === 'fail').length
  const warns = analysis.checks.filter((c) => c.level === 'warn').length

  const panel = tab === 'spec' ? h(TabSpec, { design, analysis })
    : tab === 'test' ? h(TabTest, { design, analysis, certHistory })
    : tab === 'parts' ? h(TabParts, { design, analysis })
      : tab === 'pins' ? h(TabPins, { analysis })
        : tab === 'power' ? h(TabPower, { analysis })
          : tab === 'assembly' ? h(TabAssembly, { design, analysis })
          : tab === 'print' ? h(TabPrint, { design, analysis })
            : tab === 'code' ? h(TabCode, { design })
              : h(TabSteps, { design, analysis })

  const strip = (label, value, color, first) => h('div', { style: first ? S.stripItemFirst : S.stripItem },
    h('span', { style: S.stripKey }, label),
    h('span', { style: { ...S.stripVal, color: color || C.text } }, value))

  return h('div', { style: S.root, 'data-rf': 'root' },
    h('style', {}, GLOBAL_CSS),
    // ── top bar: brand · one project strip · actions ────────────────────────
    h('div', { style: S.top, 'data-rf': 'top' },
      h('div', { style: S.mark },
        h('span', { style: { fontFamily: C.mono, fontSize: '16px', color: C.accent, lineHeight: 1 } }, '⌬'),
        h('span', { style: S.wordmark }, 'RIGFORGE'),
        h('span', { style: S.tagline, 'data-rf': 'tagline' }, 'robots · printed machines · spec out')),

      // the numbers belong to the build, so they read as one object, not six chips
      h('div', { style: S.projectStrip, 'data-rf': 'strip' },
        strip('COST', money(analysis.cost), C.text, true),
        strip('MASS', `${Math.round(analysis.mass.totalG)}g`),
        strip('PEAK', `${fmt(analysis.power.peak, 1)}A`, analysis.power.peak > (analysis.power.bat?.maxA || 99) ? C.amber : C.text),
        strip('PRINT', `${fmt(analysis.print.hours, 0)}h`),
        h('button', {
          style: {
            ...S.stripItem, borderLeft: `1px solid ${C.lineSoft}`, background: 'transparent',
            cursor: 'pointer', textAlign: 'left', border: 'none', borderLeftWidth: '1px',
            borderLeftStyle: 'solid', borderLeftColor: C.lineSoft,
          },
          title: 'jump to the engineering self-checks for this design',
          onClick: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') },
        },
          h('span', { style: S.stripKey }, 'CHECKS'),
          h('span', { style: { ...S.stripVal, color: fails ? C.red : warns ? C.amber : C.green } },
            fails ? `${fails} FAIL` : warns ? `${warns} WARN` : 'PASS'))),

      h('div', { style: S.actions },
        h('div', { style: S.seg, role: 'group', 'aria-label': 'detail level' },
          h('button', {
            style: simple ? S.segOn : S.segOff,
            'aria-pressed': simple,
            title: 'plain words: cost, print time, what to buy',
            onClick: () => { setSimple(true); if (CTX) CTX.storage.set('simple', true) },
          }, 'Simple'),
          h('button', {
            style: simple ? S.segOff : S.segOn,
            'aria-pressed': !simple,
            title: 'the engineering: BOM, pins, power, print sheet, firmware, build order',
            onClick: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') },
          }, 'Engineer')),

        h('button', {
          style: { ...S.btn, borderColor: 'rgba(255,106,26,0.5)', color: C.accent, gap: '7px' },
          onClick: askHermes,
          title: link === 'live' ? 'Hermes is connected — hand it this build' : 'hand this build to Hermes',
        },
          h('span', { style: { ...S.dot, background: link === 'live' ? C.green : link === 'offline' ? C.red : C.faint } }),
          'Ask Hermes'),

        h('div', { style: { position: 'relative' } },
          h('button', { style: S.btn, onClick: () => setMenu((m) => !m), 'aria-expanded': !!menu }, 'Export ▾'),
          menu
            ? h('div', { style: S.menu },
              exports.map(([label, fn]) => h('div', {
                key: label, style: S.menuItem,
                onClick: () => { setMenu(false); fn() },
                onMouseEnter: (e) => { e.currentTarget.style.background = C.raise },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
              }, h('span', {}, label))))
            : null),
        h('button', { style: S.btn, onClick: saveToShelf, title: 'keep this build on the shelf' }, 'Save'),
        h('button', {
          style: { ...S.btn, fontFamily: C.mono, letterSpacing: '0.06em' },
          onClick: () => setPaletteOpen(true),
          title: 'command palette (⌘K)',
          // a keyboard shortcut is not a touch control; the stylesheet hides it
          // below 780px, and it needs a hook that actually exists in the DOM
          'data-rf': 'paletteBtn',
        }, '⌘K')),
    ),

    // ── body ───────────────────────────────────────────────────────────────
    h('div', { style: S.body, 'data-rf': 'body' },
      // left rail: the brief
      h('div', { style: S.rail, 'data-rf': 'rail' },
        fromAgent
          ? h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '6px 9px',
              borderRadius: '7px', border: `1px solid ${C.accentLine}`, background: 'rgba(255,106,26,0.08)',
              fontSize: '10.5px', color: C.dim,
            },
          },
            h('span', { style: { color: C.accent, fontFamily: C.mono, fontSize: '9.5px', letterSpacing: '0.08em' } }, 'FROM HERMES'),
            h('button', {
              style: { ...S.btn, height: '20px', padding: '0 7px', fontSize: '9.5px', marginLeft: 'auto' },
              onClick: () => setCompareOpen(true),
              'aria-label': 'Compare this agent build with what you had',
            }, 'see what changed'),
            h('button', {
              style: { background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '0 2px' },
              onClick: () => setFromAgent(false),
              'aria-label': 'Dismiss the agent notice',
            }, '×'))
          : null,
        h('div', { style: S.sectionLabel }, 'pick a machine — or describe your own'),
        // Three steps, one row: the guide must not push BUILD below the fold
        // on an 800px window, which is where a laptop actually sits.
        (guideOff || (CTX && CTX.storage.get('seenFirstRun', false))) ? null : h('div', { style: S.firstRunCompact },
          [['1', 'pick or describe'], ['2', 'set one number'], ['3', 'press BUILD']].map(([n, t]) => h('span', { key: n, style: S.firstRunItem },
            h('span', { style: S.firstRunNum }, n),
            h('span', {}, t))),
          h('button', {
            style: { ...S.btn, height: '20px', padding: '0 7px', fontSize: '9.5px', flex: '0 0 auto' },
            'aria-label': 'Hide this guide',
            title: 'hide the guide — it never comes back',
            onClick: () => { if (CTX) { CTX.storage.set('seenFirstRun', true); setGuideOff(true) } },
          }, 'HIDE')),
        h('div', { style: S.cards },
          (allMachines ? PRESETS : PRESETS.slice(0, 4)).map((p) => h('button', {
            key: p.id,
            style: brief.archetype === p.brief.archetype ? S.cardOn : S.card,
            'aria-label': `Build a ${p.label}`,
            onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission) },
          },
            h(Thumb, { archetype: p.brief.archetype }),
            h('span', { style: S.cardTitle }, p.label.toUpperCase()),
            h('span', { style: S.cardSub }, PRESET_BLURBS[p.id] || '')))),
        PRESETS.length > 4
          ? h('button', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              width: '100%', padding: '7px 0', marginTop: '-8px', marginBottom: '12px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: C.faint, fontSize: '10.5px', fontFamily: C.mono, letterSpacing: '0.1em',
            },
            'aria-expanded': allMachines,
            onClick: () => setAllMachines((v) => !v),
          }, allMachines ? '− FEWER MACHINES' : `+ ${PRESETS.length - 4} MORE MACHINES`)
          : null,

        h('textarea', {
          rows: 2, value: mission, style: { ...S.input, marginBottom: '8px' },
          placeholder: '…or describe the machine you want — "a robot car that maps my room"',
          'aria-label': 'Describe the machine to build',
          onChange: (e) => { setMission(e.target.value); setMissionDirty(true) },
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onBuild() } },
        }),
        // What the parser hears, before you commit to it. The matcher already
        // existed; hiding it behind BUILD meant people typed blind.
        (() => {
          const text = (mission || '').trim()
          if (!missionDirty || text.length < 4) return null
          const match = matchArchetype(text)
          const guess = match.id
          const preset = PRESETS.find((x) => x.brief.archetype === guess)
          const same = guess === brief.archetype
          return h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '7px', margin: '0 0 8px', fontSize: '10.5px', flexWrap: 'wrap' },
          },
            h('span', { style: { color: C.faint } }, match.confident ? 'reads as' : 'no match — closest is'),
            h('span', { style: { color: match.confident ? C.cyan : C.amber, fontFamily: C.mono, letterSpacing: '0.04em' } },
              (preset ? preset.label : friendlyArchetype(guess)).toUpperCase()),
            same
              ? h('span', { style: { color: C.faint } }, '· already selected')
              : h('button', {
                style: { ...S.btn, height: '20px', padding: '0 7px', fontSize: '9.5px', flex: '0 0 auto' },
                onClick: () => {
                  if (!preset) return
                  setBrief({ ...DEFAULT_BRIEF, ...preset.brief, mission: text })
                  setMission(text)
                },
              }, 'use its numbers'))
        })(),
        // No words yet? Three sentences that work, one click each.
        (!missionDirty
          ? h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'nowrap', overflowX: 'auto', margin: '0 0 8px', paddingBottom: '2px' } },
            EXAMPLES.map((ex) => h('button', {
              key: ex,
              style: { ...S.chipBtn },
              title: `Build this: ${ex}`,
              onClick: () => {
                const b = { ...DEFAULT_BRIEF, ...brief, mission: ex, archetype: matchArchetype(ex).id }
                const p2 = PRESETS.find((x) => x.brief.archetype === b.archetype)
                setBrief(p2 ? { ...DEFAULT_BRIEF, ...p2.brief, mission: ex } : b)
                setMission(ex)
                setMissionDirty(true)
              },
            }, ex)))
          : null),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { style: S.btnPrimary, onClick: onBuild }, 'BUILD'),
          brief.archetype === 'custom'
            ? h('button', {
              style: { ...S.btn, flex: '0 0 auto', padding: '0 10px', gap: '6px' },
              title: 'edit this machine\'s nodes/joints spec — the JSON IS the design',
              'aria-label': 'Edit machine spec',
              onClick: () => setSpecOpen(true),
            }, 'SPEC')
            : null,
          h('button', {
            style: { ...S.btn, flex: '0 0 auto', padding: '0 10px', gap: '6px' },
            title: 'load a worked example — deterministic, not a random draw',
            'aria-label': 'Load a worked example build',
            onClick: () => setExamplesOpen((v) => !v),
            'aria-expanded': !!examplesOpen,
          }, 'EXAMPLES ▾')),
        // A dice that conjures a random design reads as a slot machine. An
        // engineer wants a worked example they can check, and a child wants the
        // same thing: a known-good machine to take apart.
        examplesOpen
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 8px' } },
            WORKED_EXAMPLES.map((ex) => h('button', {
              key: ex.label,
              style: { ...S.btn, height: '26px', justifyContent: 'flex-start', fontSize: '10.5px', padding: '0 9px' },
              onClick: () => { setExamplesOpen(false); loadWorkedExample(ex) },
            }, `${ex.label} — ${ex.why}`)))
          : null,

        (() => { const v = plainVerdict(analysis.checks, brief); return h('div', {
          style: { display: 'flex', gap: '7px', alignItems: 'flex-start', margin: '2px 0 4px', fontSize: '11px', lineHeight: 1.4, color: C.text },
        },
          h('span', { style: { fontFamily: C.mono, fontWeight: 700, color: v.color, flex: '0 0 auto' } }, v.icon),
          h('span', {}, v.text)) })(),

        h('div', { style: { ...S.sectionLabel, marginTop: '16px' } }, 'parameters'),
        brief.archetype === 'gadget'
          ? h(Select, {
            label: 'MATERIAL', value: brief.material,
            options: MAT_OPTIONS,
            onChange: (v) => applyBrief({ material: v }),
          })
          : h('div', {},
            h(ParamSlider, {
              label: 'PAYLOAD', value: brief.payloadKg, min: 0.1, max: brief.archetype === 'rover' ? 15 : 6, step: 0.1, unit: ' kg',
              hint: 'how much weight it must carry',
              onChange: (v) => applyBrief({ payloadKg: v }),
            }),
            brief.archetype === 'rover' || brief.archetype === 'robot'
              ? h(ParamSlider, {
                label: 'WHEEL Ø', value: brief.wheelMm || (brief.archetype === 'robot' ? 130 : 100),
                min: brief.archetype === 'robot' ? 80 : 60, max: brief.archetype === 'robot' ? 160 : 130,
                step: 5, unit: ' mm',
                hint: 'bigger wheels roll over bumps but drive slower',
                onChange: (v) => applyBrief({ wheelMm: v }),
              })
              : h(ParamSlider, {
                label: brief.archetype === 'gripper' ? 'JAW OPENING' : brief.archetype === 'quadruped' ? 'LEG SPAN' : brief.archetype === 'humanoid' ? 'HEIGHT' : 'REACH',
                value: brief.reachMm, min: 120, max: 1200, step: 10, unit: ' mm',
                hint: brief.archetype === 'gripper' ? 'the widest thing it can grab'
                  : brief.archetype === 'quadruped' ? 'width across the hips'
                    : brief.archetype === 'humanoid' ? 'how tall it stands'
                      : 'how far the arm reaches',
                onChange: (v) => applyBrief({ reachMm: v }),
              }),
            brief.archetype === 'arm'
              ? h(ParamSlider, { label: 'AXES', value: brief.dof, min: 3, max: 6, step: 1, hint: 'how many joints — more axes, more ways to move', onChange: (v) => applyBrief({ dof: v }) })
              : null),

        // Two numbers decide most builds. The rest is real, but it is a second
        // decision — behind a disclosure, not in a beginner's face.
        brief.archetype === 'gadget' ? null : h('button', {
          style: {
            display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
            background: 'none', border: 'none', borderTop: `1px solid ${C.line}`,
            padding: '9px 0 3px', marginTop: '2px', cursor: 'pointer',
            color: C.faint, fontSize: '10.5px', fontFamily: C.mono, letterSpacing: '0.1em',
          },
          'aria-expanded': advanced,
          onClick: () => setAdvanced((v) => !v),
        },
          h('span', { style: { color: advanced ? C.accent : C.faint } }, advanced ? '−' : '+'),
          advanced ? 'FEWER OPTIONS' : `MORE OPTIONS · ${brief.archetype === 'arm' ? 3 : 3}`),

        advanced && brief.archetype !== 'gadget'
          ? h('div', { style: { paddingTop: '10px' } },
            h(Select, {
              label: 'MATERIAL', value: brief.material,
              options: MAT_OPTIONS,
              hint: 'what you print the frame in — PETG survives drops',
              onChange: (v) => applyBrief({ material: v }),
            }),
            h(Select, {
              label: 'CONTROLLER', value: brief.mcu,
              options: MCU_KEYS.map((k) => ({ value: k, label: PARTS[k].name })),
              hint: 'the robot\'s brain',
              onChange: (v) => applyBrief({ mcu: v }),
            }),
            h(Select, {
              label: 'ENERGY', value: brief.battery,
              options: [
                { value: 'pack2s', label: '2S 18650 · 7.4V' },
                { value: 'pack3s', label: '3S 18650 · 11.1V' },
                { value: 'lipo2s', label: 'LiPo 2S 1000mAh' },
                { value: 'lipo3s', label: 'LiPo 3S 2200mAh' },
                { value: 'pd5v', label: 'USB-C tethered' },
              ],
              hint: 'battery pack, or plug it into the wall',
              onChange: (v) => applyBrief({ battery: v }),
            }),
            h(Select, {
              label: 'PRINTER BED', value: String(brief.bedMm || 256),
              options: [
                { value: '180', label: '180mm · Prusa MINI' },
                { value: '220', label: '220mm · Ender 3' },
                { value: '256', label: '256mm · P1S / X1C' },
                { value: '300', label: '300mm · large format' },
                { value: '350', label: '350mm · Voron 350' },
              ],
              hint: 'every printed part is checked against this — parts, not the whole machine',
              onChange: (v) => applyBrief({ bedMm: Number(v) }),
            }))
          : null,

        h('div', { style: { ...S.sectionLabel, marginTop: '12px' } },
          shelf.length ? `shelf · ${shelf.length}` : 'shelf'),
        shelf.length
          ? shelf.map((s) => {
            const code = s.code || encodeBuild(s.brief)
            const age = s.at ? relTime(s.at) : ''
            return h('div', {
              key: s.id, style: S.shelfRow,
              onMouseEnter: (e) => { e.currentTarget.style.borderColor = C.accentLine },
              onMouseLeave: (e) => { e.currentTarget.style.borderColor = C.line },
            },
              h('button', {
                style: { flex: '1 1 auto', minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
                title: `Load ${s.title}`,
                'aria-label': `Load ${s.title}`,
                onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...s.brief }); setMission(s.brief.mission || '') },
              },
                h('span', { style: { fontSize: '11.5px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title),
                h('span', { style: { fontFamily: C.mono, fontSize: '9.5px', color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `${money(s.cost)} · ${friendlyArchetype(s.brief.archetype)}${age ? ' · ' + age : ''}`)),
              h('button', {
                style: { background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '2px 5px', flex: '0 0 auto' },
                'aria-label': `Copy build code for ${s.title}`,
                title: 'copy its build code',
                onClick: async (e) => {
                  e.stopPropagation()
                  try {
                    await navigator.clipboard.writeText(code)
                    host.notify({ kind: 'success', message: `Code for ${s.title} copied` })
                  } catch {
                    host.notify({ kind: 'info', message: 'Clipboard blocked' })
                  }
                },
              }, '⧉'),
              h('button', {
                style: { background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '2px 4px', flex: '0 0 auto' },
                'aria-label': `Remove ${s.title} from the shelf`,
                title: 'remove from shelf',
                onClick: (e) => {
                  e.stopPropagation()
                  const next = shelf.filter((x) => x.id !== s.id)
                  setShelf(next)
                  if (CTX) CTX.storage.set('shelf', next)
                },
              }, '×'))
          })
          : h('div', { style: { fontSize: '10.5px', color: C.faint, lineHeight: 1.5, padding: '2px 0 4px' } },
            'Nothing saved yet. Press SAVE and the build lands here with its own build code.'),

        h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: `1px solid ${C.line}`, fontSize: '10px', color: C.faint, lineHeight: 1.5 } },
          'Deterministic engine: torque, current, mass and print time are computed, not narrated. The agent redesigns; the maths here is yours.')),

      // centre: viewport
      h('div', { style: { ...S.col, minWidth: 0, position: 'relative' }, 'data-rf': 'view' },
        h(Viewport, { mesh: viewMesh, cam, setCam, opts: viewOpts, design, analysis, overlay: benchOvWorld, focus: camFocus }),
        driveHud ? h('div', {
          style: {
            position: 'absolute', left: '14px', bottom: '14px', zIndex: 5,
            fontFamily: C.mono, fontSize: '10.5px', color: C.cyan,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '5px 9px', pointerEvents: 'none',
            display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          },
        },
          driveHud.kind === 'ik'
            ? [
                h('span', { key: 'a' }, `IK err ${driveHud.err.toFixed(0)}mm`),
                h('span', { key: 'b', style: { color: C.faint } }, `tgt ${driveHud.tx},${driveHud.ty},${driveHud.tz}`),
                propHud ? h('span', {
                  key: 'prop',
                  style: { color: propHud.over ? C.red : C.green },
                  title: propHud.over ? 'heavier than the arm payload rating — expect sag/stall' : 'within payload rating',
                }, `⛏ ${propHud.name} ${propHud.massG}g${propHud.over ? ' ⚠OVER' : ''}`) : null,
                wsMap && wsMap.stats.reach ? h('span', {
                  key: 'ws',
                  style: { color: C.cyan },
                  title: `sampled workspace: ${wsMap.stats.reach}/${wsMap.stats.total} targets reachable · ${wsMap.stats.lift} also lift ${wsMap.stats.payloadG}g`,
                }, `◌ ${Math.round((wsMap.stats.lift / wsMap.stats.total) * 100)}% lift@${wsMap.stats.payloadG}g`) : null,
                h('span', { key: 'c', style: { color: C.faint } }, 'WASD+RF reach · 0 reset'),
              ]
            : driveHud.kind === 'gait'
            ? [
                driveHud.loco ? h('span', { key: 'v' }, `v ${driveHud.loco.v.toFixed(2)} m/s`) : null,
                h('span', { key: 'a' }, `gait ${driveHud.cadence}Hz`),
                driveHud.loco && driveHud.loco.gradeDeg ? h('span', { key: 'g' }, `grade ${driveHud.loco.gradeDeg}°`) : null,
                driveHud.loco ? h('span', { key: 'd', style: { color: C.faint } }, `${driveHud.loco.surface} μ${driveHud.loco.mu.toFixed(2)}`) : null,
                driveHud.loco && driveHud.loco.slip ? h('span', { key: 'f', style: { color: C.amber } }, 'SLIP') : null,
                driveHud.loco && driveHud.loco.stall ? h('span', { key: 'g2', style: { color: C.red } }, 'STALL') : null,
                legWsMap ? h('span', {
                  key: 'lws',
                  style: { color: C.cyan },
                  title: legWsMap.legs.map((l) => `${l.key.toUpperCase()} ${l.reach}/${l.total}`).join(' · '),
                }, `◌ feet ${Math.round((legWsMap.stats.reach / Math.max(1, legWsMap.stats.total)) * 100)}%`) : null,
                driveHud.loco && driveHud.loco.bumps ? h('span', { key: 'k', style: { color: C.amber } }, `bump×${driveHud.loco.bumps}`) : null,
                h('span', { key: 'b', style: { color: C.faint } }, `${driveHud.strides} strides`),
                h('span', { key: 'c', style: { color: C.faint } }, 'W walk · A/D steer · release to stand'),
              ]
            : driveHud.kind === 'grip'
            ? [
                h('span', { key: 'a' }, `jaw ${driveHud.open ? 'OPEN' : 'SHUT'}`),
                gripHud ? h('span', {
                  key: 'g',
                  style: { color: gripHud.ok ? C.green : C.red },
                  title: `hold capacity ${gripHud.holdKg.toFixed(2)}kg vs ${gripHud.blockKg}kg test mass`,
                }, `${gripHud.ok ? 'HOLD' : 'SLIP'} ${gripHud.blockKg}kg/${gripHud.holdKg.toFixed(1)}kg`) : null,
                h('span', { key: 'b', style: { color: C.faint } }, 'Space toggles'),
              ]
            : driveHud.kind === 'sense'
            ? [
                h('span', { key: 'a' }, `OLED ${driveHud.oled}`),
                ...(driveHud.lines || []).map((ln, i) => h('span', { key: `s${i}`, style: { color: C.faint } }, ln)),
                driveHud.alerts && driveHud.alerts.length
                  ? h('span', { key: 'al', style: { color: C.amber } }, `⚠ ${driveHud.alerts[0]}${driveHud.alerts.length > 1 ? ` +${driveHud.alerts.length - 1}` : ''}`)
                  : h('span', { key: 'ok', style: { color: C.green } }, 'all readings nominal'),
              ]
            : driveHud.kind === 'gantry'
            ? [
                h('span', { key: 'a' }, `X ${driveHud.x} Y ${driveHud.y} Z ${driveHud.z}`),
                h('span', { key: 'b', style: { color: C.faint } }, `${driveHud.span}mm axes`),
                h('span', { key: 'c', style: { color: C.faint } }, isTouch ? 'STICK traverse' : 'WASD·F/R · 0 center'),
              ]
            : [
                h('span', { key: 'a' }, `v ${driveHud.speed.toFixed(2)} m/s`),
                h('span', { key: 'b' }, `hdg ${driveHud.yawDeg}°`),
                driveHud.gradeDeg ? h('span', { key: 'c' }, `grade ${driveHud.gradeDeg}°`) : null,
                h('span', { key: 'd', style: { color: C.faint } }, `${driveHud.surface} μ${driveHud.mu}`),
                driveHud.mass > 0 ? h('span', { key: 'e', style: { color: C.faint } }, `${driveHud.mass.toFixed(1)}kg`) : null,
                driveHud.slip ? h('span', { key: 'f', style: { color: C.amber } }, 'WHEELSPIN') : null,
                driveHud.stall ? h('span', { key: 'g', style: { color: C.red } }, 'STALL') : null,
                driveHud.slide ? h('span', { key: 'i', style: { color: C.amber } }, 'SLIDE') : null,
                driveHud.course === 'room' ? h('span', { key: 'j', style: { color: C.cyan } }, 'ROOM') : null,
                driveHud.course === 'stairs' ? h('span', { key: 'j2', style: { color: C.cyan } }, 'STAIRS') : null,
                driveHud.bumps ? h('span', { key: 'k', style: { color: C.amber } }, `bump×${driveHud.bumps}`) : null,
                h('span', { key: 'h', style: { color: C.faint } }, isTouch ? 'STICK drive · 0 reset' : 'WASD · X shove · 0 reset'),
              ],
          // endurance telemetry rides every teleop HUD — the pack drains and
          // the servos cook whether you are driving, reaching or walking
          powerHud ? [
            h('span', { key: 'p1', style: { color: powerHud.dead ? C.red : powerHud.soc < 25 ? C.amber : C.faint } },
              `⚡${powerHud.soc.toFixed(0)}%`),
            h('span', { key: 'p2', style: { color: C.faint } }, `${powerHud.vbus.toFixed(1)}V`),
            h('span', { key: 'p3', style: { color: powerHud.tempMax > 70 ? C.amber : C.faint } },
              `🌡${powerHud.tempMax.toFixed(0)}°`),
            powerHud.cuts ? h('span', { key: 'p4', style: { color: C.red } }, `${powerHud.cuts} CUT`) : null,
            powerHud.dead ? h('span', { key: 'p5', style: { color: C.red } }, 'BATTERY DEAD — 0 swaps') : null,
          ] : null,
          fixes.length && (driveHud || propHud || powerHud)
            ? h('div', {
              key: 'fix',
              style: { flexBasis: '100%', display: 'flex', alignItems: 'center', gap: '6px' },
            },
              h('span', {
                style: { color: fixes[0].sev === 'fail' ? C.red : C.amber, fontWeight: 600 },
                title: fixes.map((f) => f.msg).join('\n'),
              }, `⚒ ${fixes[0].msg}${fixes.length > 1 ? `  (+${fixes.length - 1} more)` : ''}`),
              fixes[0].apply ? h('button', {
                style: { ...S.viewChip, padding: '1px 7px', fontSize: '9px', flex: '0 0 auto' },
                title: `rebuild with ${JSON.stringify(fixes[0].apply)} and re-run the bench`,
                onClick: () => { setBrief((b) => ({ ...b, ...fixes[0].apply })); setDriveOn(false) },
              }, 'APPLY FIX') : null)
            : null,
        ) : null,
        driveOn && isTouch ? h('div', {
          ref: joyRef,
          onPointerDown: (e) => { try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older webview */ } joyVec(e) },
          onPointerMove: (e) => { if (touchRef.current.active) joyVec(e) },
          onPointerUp: joyEnd,
          onPointerCancel: joyEnd,
          style: {
            position: 'absolute', left: '14px', bottom: '14px', width: '104px', height: '104px',
            borderRadius: '50%', background: 'rgba(16,22,28,0.55)', border: `1px solid ${C.line}`,
            touchAction: 'none', zIndex: 4, userSelect: 'none',
          },
        },
          h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.faint, fontFamily: C.mono, fontSize: '8.5px', letterSpacing: '0.08em', pointerEvents: 'none' } }, 'STICK'),
          h('div', {
            ref: joyKnobRef,
            style: {
              position: 'absolute', left: '50%', top: '50%', width: '44px', height: '44px',
              margin: '-22px 0 0 -22px', borderRadius: '50%',
              background: `linear-gradient(135deg, ${C.accent}, ${C.accent}cc)`,
              boxShadow: '0 2px 10px rgba(0,0,0,0.5)', pointerEvents: 'none',
            },
          })) : null,
        driveOn && autotestRef.current && (autotestRef.current.running || autotestRef.current.done) ? h('div', {
          style: {
            position: 'absolute', top: '14px', left: '50%', transform: 'translateX(-50%)', zIndex: 5,
            fontFamily: C.mono, fontSize: '10.5px',
            color: autotestRef.current.done && autotestRef.current.results.every((r) => r.pass) ? C.green : C.cyan,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '5px 10px', pointerEvents: 'none',
            title: (autotestRef.current.results || []).map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.label} — ${r.detail}`).join('\n'),
          },
        }, autotestRef.current.running
          ? `AUTO ${autotestRef.current.phase.label} ${autotestRef.current.phase.t.toFixed(1)}/${autotestRef.current.phase.dur}s · ${autotestRef.current.score}`
          : `AUTO TEST ${autotestRef.current.score} — ${autotestRef.current.results.every((r) => r.pass) ? 'all checks pass' : 'click REPORT for details'}`) : null,
        driveOn && autotestRef.current && autotestRef.current.done && !autoReportOffRef.current ? h('div', {
          style: {
            position: 'absolute', top: '44px', left: '50%', transform: 'translateX(-50%)', zIndex: 6,
            fontFamily: C.mono, fontSize: '10.5px', minWidth: '300px', maxWidth: '440px',
            background: 'rgba(10,13,16,0.88)', border: `1px solid ${C.line}`,
            borderRadius: '8px', padding: '8px 12px', pointerEvents: 'auto',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
            h('span', {
              style: { fontWeight: 700, color: autotestRef.current.results.every((r) => r.pass) ? C.green : C.amber },
            }, `CERTIFICATION ${autotestRef.current.score}`),
            h('button', {
              style: { marginLeft: 'auto', background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: '12px', padding: '0 4px' },
              title: 'dismiss — results stay in REPORT',
              onClick: () => { autoReportOffRef.current = true },
            }, '×')),
          certBest ? h('div', {
            style: { fontSize: '9.5px', color: C.faint, marginBottom: '4px' },
            title: certHistory.filter((x) => x.arch === certArch).map((x) => `${x.passes}/${x.total} · ${x.phases}`).join('\n'),
          }, `best for this machine: ${certBest.passes}/${certBest.total}`) : null,
          ...autotestRef.current.results.map((r) => h('div', {
            key: r.id || r.label,
            style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '2px 0' },
          },
            h('span', { style: { color: r.pass ? C.green : C.red, fontWeight: 700, flex: '0 0 38px' } }, r.pass ? 'PASS' : 'FAIL'),
            h('span', { style: { color: C.dim, flex: '0 0 74px' } }, r.label),
            h('span', { style: { color: C.text } }, r.detail)))) : null,
        driveOn && teleopKind === 'drive' ? h('div', {
          style: {
            position: 'absolute', right: '14px', bottom: '14px', zIndex: 5,
            fontFamily: C.mono, fontSize: '10px', color: C.dim,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '7px 10px', width: '188px',
            display: 'flex', flexDirection: 'column', gap: '6px',
          },
        },
          h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            [['rack', 'RACK'], ['room', 'ROOM'], ['stairs', 'STAIRS']].map(([ck, cl]) => h('button', {
              key: ck,
              onClick: () => setBenchEnv((e) => ({ ...e, course: ck })),
              title: ck === 'room' ? 'living-room course: threshold hump, rug zone, three obstacles'
                : ck === 'stairs' ? 'porch stairs: 4×80mm risers — mounts only if wheel radius bites the nosing'
                : 'traction rack: adjustable ramp and surface',
              style: {
                fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.4px',
                padding: '2px 7px', borderRadius: '4px', cursor: 'pointer',
                border: `1px solid ${benchEnv.course === ck ? C.cyan : C.line}`,
                background: benchEnv.course === ck ? 'rgba(0,229,255,0.12)' : 'transparent',
                color: benchEnv.course === ck ? C.cyan : C.dim,
              },
            }, cl))),
          benchEnv.course === 'rack' ? h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            Object.keys(DRIVE_SURFACES).map((sk) => h('button', {
              key: sk,
              onClick: () => setBenchEnv((e) => ({ ...e, surface: sk })),
              style: {
                fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.4px',
                padding: '2px 7px', borderRadius: '4px', cursor: 'pointer',
                border: `1px solid ${benchEnv.surface === sk ? C.cyan : C.line}`,
                background: benchEnv.surface === sk ? 'rgba(0,229,255,0.12)' : 'transparent',
                color: benchEnv.surface === sk ? C.cyan : C.dim,
              },
            }, sk.toUpperCase()))) : h('div', { style: { fontSize: '9px', color: C.faint } },
              benchEnv.course === 'stairs' ? 'stairs: wood treads, μ0.8 — risers decide' : 'course surfaces: hardwood + rug'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            h('span', { style: { width: '52px', color: C.faint } }, 'RAMP'),
            h('input', {
              type: 'range', min: 0, max: 35, step: 1, value: benchEnv.slopeDeg,
              onChange: (e) => setBenchEnv((b) => ({ ...b, slopeDeg: Number(e.target.value) })),
              style: { flex: 1, accentColor: C.cyan },
              'aria-label': 'ramp angle',
            }),
            h('span', { style: { width: '30px', textAlign: 'right', color: C.cyan } }, `${benchEnv.slopeDeg}°`)),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            h('span', { style: { width: '52px', color: C.faint } }, 'LOAD'),
            h('input', {
              type: 'range', min: 0, max: 2, step: 0.1, value: benchEnv.payloadKg,
              onChange: (e) => setBenchEnv((b) => ({ ...b, payloadKg: Number(e.target.value) })),
              style: { flex: 1, accentColor: C.amber },
              'aria-label': 'payload mass',
            }),
            h('span', { style: { width: '30px', textAlign: 'right', color: C.amber } }, `${benchEnv.payloadKg.toFixed(1)}kg`)),
          h('div', { style: { display: 'flex', gap: '4px', marginTop: '2px' } },
            [5, 15, 30].map((n) => h('button', {
              key: n,
              onClick: () => driveRef.current && driveRef.current.shove(n),
              style: {
                flex: 1, fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.4px',
                padding: '3px 0', borderRadius: '4px', cursor: 'pointer',
                border: `1px solid ${C.line}`, background: 'transparent', color: C.dim,
              },
              title: `shove test — ${n}N lateral impulse`,
            }, `SHOVE ${n}N`))),
        ) : null,
        driveOn && teleopKind === 'sense' && senseRef.current ? h('div', {
          style: {
            position: 'absolute', right: '14px', bottom: '14px', zIndex: 5,
            fontFamily: C.mono, fontSize: '10px', color: C.dim,
            background: 'rgba(10,13,16,0.72)', border: `1px solid ${C.line}`,
            borderRadius: '7px', padding: '7px 10px', width: '188px',
            display: 'flex', flexDirection: 'column', gap: '6px',
          },
        },
          (senseRef.current.fields || []).map((f) => h('label', {
            key: f.k,
            style: { display: 'flex', alignItems: 'center', gap: '7px' },
          },
            h('span', { style: { width: '52px', color: C.faint } }, `${f.sensorLabel.split(' ')[0]} ${f.label}`),
            h('input', {
              type: 'range', min: f.min, max: f.max, step: f.bool ? 1 : (f.max - f.min) / 100,
              value: senseRef.current.state[f.k],
              onChange: (e) => {
                senseRef.current.set(f.k, f.bool ? Number(e.target.value) > 0.5 : Number(e.target.value))
                setSenseTick((t) => t + 1)
              },
              style: { flex: 1, accentColor: C.cyan },
              'aria-label': `stimulus ${f.k}`,
            }),
            h('span', { style: { width: '34px', textAlign: 'right', color: C.cyan } },
              `${f.bool ? (senseRef.current.state[f.k] ? 'YES' : 'no') : `${senseRef.current.state[f.k]}${f.unit}`}`))),
        ) : null,
        // one instrument: camera presets as a radio group, display as toggles
        h('div', { style: S.viewBar, role: 'toolbar', 'aria-label': 'view options' },
          h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'camera preset' },
            VIEWS.map(([label, yaw, pitch]) => {
              const on = Math.abs(cam.yaw - yaw) < 0.02 && Math.abs(cam.pitch - pitch) < 0.02
              return h('button', {
                key: label,
                style: on ? S.viewPickOn : S.viewPick,
                'aria-pressed': on,
                title: `${label.toLowerCase()} view`,
                onClick: () => setCam((c) => ({ ...c, yaw, pitch })),
              }, label)
            })),
          h('div', { style: S.viewSep }),
          h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'overlays' },
            [['GRID', 'grid'], ['DIMS', 'dims'], ['WIRE', 'wire'], ['CABLES', 'cables'], ['REACH', 'reach'], ['LOAD', 'heat'], ['EXPLODE', 'explode']].map(([label, key]) => h('button', {
              key,
              style: opts[key] ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!opts[key],
              title: key === 'heat'
                ? 'joint load heat — green <50% stall · amber 50–90% · red ≥90% · white-hot = stalled/thermal cutoff'
                : `${label.toLowerCase()} ${opts[key] ? 'on' : 'off'}`,
              onClick: () => setOpts((o) => ({ ...o, [key]: !o[key] })),
            }, label))),
          opts.explode
            ? h('input', {
              type: 'range', min: 0.1, max: 1.2, step: 0.05, value: explodeF,
              style: { width: 72, accentColor: '#ff6b1a' },
              'aria-label': 'explode amount',
              title: 'assembly spread — scrub to separate the parts',
              onChange: (e) => setExplodeF(Number(e.target.value)),
            })
            : null,
          h('div', { style: S.viewSep }),
          h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'projection' },
            h('button', {
              style: cam.ortho ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!cam.ortho,
              title: 'orthographic projection',
              onClick: () => setCam((c) => ({ ...c, ortho: !c.ortho })),
            }, 'ORTHO'),
            h('button', {
              style: timeWarp === 10 ? S.viewChipOn : S.viewChip,
              'aria-pressed': timeWarp === 10,
              title: 'endurance time warp — battery drains and servos heat 10× faster',
              onClick: () => setTimeWarp((w) => (w === 1 ? 10 : 1)),
            }, `TIME ${timeWarp}×`),
            h('button', {
              style: S.viewChip,
              title: 'download the field-test report (markdown) — stats the bench logged this session',
              onClick: downloadReport,
            }, 'REPORT')),
          driveAvail ? h('div', { style: S.viewSep }) : null,
          driveAvail ? h('div', { style: S.viewGroup, role: 'group', 'aria-label': 'bench teleop' },
            h('button', {
              style: driveOn ? S.viewChipOn : S.viewChip,
              'aria-pressed': driveOn,
              title: teleopKind === 'ik'
                ? 'reach mode — WASD plane, R/F height, gamepad sticks, 0 re-anchors'
                : teleopKind === 'gait'
                ? 'gait mode — W walks the course, A/D steers, gamepad left stick'
                : teleopKind === 'grip'
                ? 'jaw mode — Space opens/closes the gripper'
                : teleopKind === 'sense'
                ? 'sense mode — stimulus sliders inject the environment'
                : teleopKind === 'gantry'
                ? 'gantry mode — WASD portal/saddle, F feeds / R raises the quill, 0 centers'
                : 'drive mode — WASD or gamepad: W/S throttle, A/D steer, 0 reset',
              onClick: () => setDriveOn((o) => !o),
            }, teleopKind === 'ik' ? 'REACH' : teleopKind === 'gait' ? 'WALK' : teleopKind === 'grip' ? 'GRIP' : teleopKind === 'sense' ? 'SENSE' : teleopKind === 'gantry' ? 'GANTRY' : 'DRIVE'),
            dualMode ? h('button', {
              style: armMode ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!armMode,
              title: armMode === 2
                ? 'left-arm mode — WASD plane, R/F height drives the left arm; body holds. M cycles back'
                : armMode === 1
                ? 'arm mode — WASD plane, R/F height drives the arm; body holds. M cycles' + (armSides > 1 ? ' to left arm' : ' back to body')
                : 'body mode — WASD/gamepad drives or walks; M or click to pose the arm',
              onClick: () => setArmMode((v) => (armSides > 1 ? (v + 1) % 3 : v ? 0 : 1)),
            }, armMode === 2 ? 'ARM·L' : armMode === 1 ? 'ARM·R' : 'ARM') : null,
            autotestRef.current ? h('button', {
              style: autotestRef.current.running || (autotestRef.current.done && !autotestRef.current.results.every((r) => r.pass)) ? S.viewChipOn : S.viewChip,
              'aria-pressed': !!(autotestRef.current && autotestRef.current.running),
              title: 'autopilot certification — scripts sprint, turn, climb, shove-recovery and return, scoring each check',
              onClick: () => {
                const at = autotestRef.current
                if (!at) return
                if (at.running) { at.stop(); return }
                at.start()
                setArmMode(0) // certification always runs the primary mode
                autoReportOffRef.current = false
                setDriveOn(true)
              },
            }, autotestRef.current.running ? 'AUTO ■' : autotestRef.current.done ? `AUTO ${autotestRef.current.score}` : 'AUTO') : null) : null,
          powerHud ? h('span', {
            style: {
              fontFamily: C.mono, fontSize: '10px', marginLeft: 'auto',
              color: powerHud.dead ? C.red : powerHud.soc < 25 ? C.amber : C.faint,
              border: `1px solid ${C.line}`, borderRadius: '6px', padding: '3px 8px',
            },
            title: `bus ${powerHud.busA.toFixed(1)}A · ${powerHud.vbus.toFixed(1)}V · peak joint ${powerHud.tempMax.toFixed(0)}°C${powerHud.cuts ? ` · ${powerHud.cuts} thermal cutouts` : ''}`,
          }, `⚡ ${powerHud.soc.toFixed(0)}%`) : null,
        ),

        h('div', { style: S.jointBar },
          // A pose rack, not a spreadsheet: fixed controls on the left, and the
          // joints themselves in a wrapped grid so 23 of them occupy two rows
          // instead of one endless strip.
          h('div', { style: S.poseHead },
            h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.12em', color: C.faint, display: 'flex', alignItems: 'center', gap: '6px' } },
              `${design.joints.length ? `${shownJoints.length} JOINTS` : 'NO JOINTS'}`,
              poseOverflows ? h('span', { style: { color: C.accent } }, ' · scroll') : null,
              design.joints.length
                ? h('button', {
                  style: { ...S.poseTab, marginLeft: 'auto', padding: '1px 7px', fontSize: '9px' },
                  title: 'bookmark this pose — saved across sessions, click a chip to re-apply',
                  onClick: saveBookmark,
                }, '＋POSE')
                : null),
            design.joints.length > 6
              ? h('div', { style: { display: 'flex', gap: '3px', marginTop: '5px' } },
                [['all', 'ALL'], ['body', 'TORSO'], ['l', 'LEFT'], ['r', 'RIGHT']].map(([id, label]) => h('button', {
                  key: id,
                  style: { ...(jointGroup === id ? S.poseTabOn : S.poseTab) },
                  onClick: () => setJointGroup(id),
                }, label)))
              : null,
            h('div', { style: { display: 'flex', gap: '5px', marginTop: '6px' } },
              h('button', { style: S.poseTab, title: 'every joint back to zero', onClick: () => setPose(design.joints.map(() => 0)) }, 'HOME'),
              h('button', {
                style: S.poseTab,
                title: (POSE_PRESETS[design.archetype] || []).length
                  ? `cycle pose presets: ${(POSE_PRESETS[design.archetype] || []).map((p) => p.name).join(' → ')}`
                  : 'a quick working pose',
                onClick: () => {
                  const list = POSE_PRESETS[design.archetype] || []
                  if (list.length) {
                    const cyc = presetCycleRef.current
                    const i = cyc.arch === design.archetype ? (cyc.i + 1) % list.length : 0
                    presetCycleRef.current = { arch: design.archetype, i }
                    const live = simRef.current && simRef.current.state ? simRef.current.state.angles : null
                    const a = applyPosePreset(design, list[i].name, live)
                    if (a) { setPose(a); return }
                  }
                  setPose(design.joints.map((j, i) => (i === 0 && design.joints.length > 1 ? 0 : Math.round(i % 2 ? j.max * 0.6 : j.min * 0.55))))
                },
              }, 'POSE'),
              design.joints.length
                ? h('button', {
                  style: S.poseTab,
                  title: 'stress the limits — every joint sweeps min → max → rest at real servo speed',
                  onClick: () => { sweepRef.current = { active: true, t: 0 } },
                }, 'SWEEP')
                : null,
              canMirror
                ? h('button', {
                  style: S.poseTab,
                  title: 'copy every left-side joint onto its right twin',
                  onClick: () => setPose((p) => p.map((v, i) => {
                    const id = design.joints[i].id
                    if (!id.startsWith('r-')) return v
                    const li = design.joints.findIndex((j) => j.id === `l-${id.slice(2)}`)
                    return li >= 0 ? p[li] : v
                  })),
                }, 'MIRROR')
                : null)),
            bookmarks.some((b) => b.n === design.joints.length)
              ? h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' } },
                bookmarks.map((b, i) => (b.n === design.joints.length
                  ? h('span', {
                    key: b.id || i,
                    style: { ...S.poseTab, cursor: 'pointer', display: 'inline-flex', gap: '4px', alignItems: 'center' },
                    title: 'apply this pose',
                    onClick: () => setPose(b.pose.slice()),
                  }, b.name,
                    h('span', {
                      style: { color: C.faint },
                      onClick: (e) => { e.stopPropagation(); delBookmark(i) },
                      title: 'delete bookmark',
                    }, '×'))
                  : null)))
              : null,

          design.joints.length
            ? h('div', { style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: S.poseGrid, 'data-rf': 'posegrid' },
              design.joints.map((j, i) => [j, i])
                .filter(([j]) => jointGroup === 'all' || (jointGroup === 'body'
                  ? j.id.startsWith('waist') || j.id.startsWith('neck')
                  : j.id.startsWith(`${jointGroup}-`)))
                .map(([j, i]) => {
                  // the slider commands a target; the number shows where the
                  // joint actually IS — they differ while the servo slews or
                  // stalls, which is exactly the feedback that teaches torque
                  const simSt = simRef.current && simRef.current.state
                  const loadRatio = simSt && simSt.stallNm[i] ? simSt.loadNm[i] / simSt.stallNm[i] : 0
                  const stalled = !!(simSt && simSt.stalled[i])
                  return h('label', { key: j.id, style: S.poseRow, title: `${j.label} · ${j.min}…${j.max}${j.slide ? 'mm' : '°'}` },
                    h('span', { style: S.poseName }, j.label),
                    h('input', {
                      type: 'range', min: j.min, max: j.max, step: 1, value: pose[i] || 0,
                      style: S.poseRange,
                      'aria-label': j.label,
                      onChange: (e) => {
                        sweepRef.current.active = false // a hand on the slider ends the sweep
                        const v = Number(e.target.value)
                        setPose((p) => p.map((x, k) => (k === i ? v : x)))
                      },
                    }),
                    h('span', {
                      style: { ...S.poseVal, color: stalled ? C.red : loadRatio > 0.7 ? C.amber : undefined },
                    }, stalled ? 'STALL' : `${Math.round(dispPose[i] || 0)}${j.slide ? 'mm' : '°'}${loadRatio > 0.55 ? ` ·${Math.round(loadRatio * 100)}%` : ''}`))
                })),
              poseOverflows ? h('div', { style: S.poseFade }) : null,
            // live scope: actual joint angles over the last ~8s — oscillation,
            // stalls and limit riding are visible as shapes, not just numbers
            telemetryRef.current.samples.length > 2
              ? h('div', { style: { marginTop: '10px' } },
                h('div', { style: { ...S.sectionLabel, marginBottom: '4px' } },
                  `telemetry · last ${((telemetryRef.current.samples.length / 10) | 0)}s — cyan angle · amber %stall`),
                design.joints.slice(0, 10).map((j, i) => {
                  const ns = telemetryRef.current.samples.length - 1 || 1
                  const angPts = telemetryRef.current.samples
                    .map((s, k) => {
                      const a = (s.a ? s.a[i] : s[i]) || 0
                      const n = j.max !== j.min ? (a - j.min) / (j.max - j.min) : 0.5
                      return `${((k / ns) * 100).toFixed(1)},${(22 - Math.max(0, Math.min(1, n)) * 20).toFixed(1)}`
                    }).join(' ')
                  // load trace: 0–100% stall on the same 24px rail, amber —
                  // spikes here are the joints about to stall
                  const loadPts = telemetryRef.current.samples
                    .map((s, k) => {
                      const lr = (s.l ? s.l[i] : 0) || 0
                      return `${((k / ns) * 100).toFixed(1)},${(22 - Math.max(0, Math.min(1, lr)) * 20).toFixed(1)}`
                    }).join(' ')
                  return h('div', { key: j.id, style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' } },
                    h('span', { style: { width: '86px', flex: '0 0 auto', fontSize: '9px', color: C.faint, fontFamily: C.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.label),
                    h('svg', { viewBox: '0 0 100 24', preserveAspectRatio: 'none', style: { flex: '1 1 auto', height: '18px', display: 'block' } },
                      h('polyline', { points: angPts, fill: 'none', stroke: C.cyan, strokeWidth: '1.2', vectorEffect: 'non-scaling-stroke' }),
                      h('polyline', { points: loadPts, fill: 'none', stroke: C.amber, strokeWidth: '0.9', strokeDasharray: '2 1.5', vectorEffect: 'non-scaling-stroke', opacity: '0.9' })))
                }),
                design.joints.length > 10
                  ? h('div', { style: { fontSize: '9px', color: C.faint, marginTop: '2px' } }, `+${design.joints.length - 10} more joints — scope shows the first ten`)
                  : null)
              : null)
            : h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, padding: '8px 0' } },
              'no articulated joints — static assembly')),
      ),

      // right rail: the spec
      h('div', { style: S.col, 'data-rf': 'spec' },
        simple ? h('div', { style: { ...S.tabBody, padding: '4px 16px 24px' } },
          h(SimplePanel, {
            design, analysis, exports,
            onAudit: () => setAuditOpen(true),
            onCompare: () => setCompareOpen(true),
            onTest: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('test') },
            onEngineer: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') },
          }))
          : h('div', {
            style: S.tabs, role: 'tablist',
            // arrow keys are what a tablist promises a keyboard user
            onKeyDown: (e) => {
              const ids = TABS.map(([id]) => id)
              const i = ids.indexOf(tab)
              let next = null
              if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length]
              else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length]
              else if (e.key === 'Home') next = ids[0]
              else if (e.key === 'End') next = ids[ids.length - 1]
              if (!next) return
              e.preventDefault()
              setTab(next)
              const btn = e.currentTarget.querySelector(`[data-tab="${next}"]`)
              if (btn) btn.focus()
            },
          },
          TABS.map(([id, label]) => {
            // a badge is information scent: how much sits behind the tab
            // badges only where the count changes a decision: how much to buy,
            // how much to print. A number on every tab is noise.
            const badge = id === 'parts' ? design.parts.length
              : id === 'print' ? design.nodes.filter((n) => n.print).length
                : null
            return h('button', {
              key: id,
              style: tab === id ? S.tabOn : S.tab,
              role: 'tab',
              'data-tab': id,
              'aria-selected': tab === id,
              tabIndex: tab === id ? 0 : -1,
              onClick: () => setTab(id),
            }, label,
            badge ? h('span', { style: { ...S.tabBadge, color: tab === id ? C.accent : C.faint } }, badge) : null)
          })),
        simple ? null : h('div', { style: S.tabBody }, panel),
        simple ? null : h('div', { style: S.footer },
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.1em' } },
            `${design.parts.length} LINE ITEMS`),
          h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: '14px', fontWeight: 600, color: C.accent } }, money(analysis.cost)))),
    ),
    h(CommandPalette, { open: paletteOpen, commands, onClose: () => setPaletteOpen(false) }),
    h(AuditDialog, { open: auditOpen, onClose: () => setAuditOpen(false), design, analysis }),
    h(CompareDialog, { open: compareOpen, onClose: () => setCompareOpen(false), currentBrief: brief, history }),
    h(BuildCodeDialog, {
      open: codeOpen,
      onOpen: (b) => { setBrief({ ...DEFAULT_BRIEF, ...b }); setMission(b.mission || ''); setSimple(false) },
      onClose: () => setCodeOpen(false),
    }),
    h(SpecDialog, {
      open: specOpen,
      brief,
      onApply: (spec) => setBrief((cur) => ({ ...cur, ...spec })),
      onClose: () => setSpecOpen(false),
    }),
  )
}
