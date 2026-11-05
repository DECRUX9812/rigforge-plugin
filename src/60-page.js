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


/** Live-price strip: what has a real supplier number, and what is still a guess. */
function LivePrices({ design }) {
  const [prices, setPrices] = useState(() => (CTX && CTX.storage.get('livePrices', null)) || null)
  const [busy, setBusy] = useState(false)
  const askPrices = async () => {
    setBusy(true)
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
    setBusy(false)
  }
  const age = prices && prices.fetched ? Math.max(0, Math.round(Date.now() / 1000 - prices.fetched)) : null
  const ageText = age == null ? '' : age < 90 ? 'just now' : age < 5400 ? `${Math.round(age / 60)} min ago` : `${Math.round(age / 3600)}h ago`
  return h('div', { style: { border: `1px solid ${C.line}`, borderRadius: '9px', padding: '9px 11px', marginBottom: '14px', background: C.panel } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
      h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.14em', color: C.faint } }, 'PRICES'),
      h('button', { style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10.5px' }, onClick: askPrices, disabled: busy },
        busy ? '…' : 'GET LIVE PRICES')),
    prices
      ? h('div', { style: { fontSize: '11.5px', color: C.text, marginTop: '6px', lineHeight: 1.5 } },
        `${prices.liveLines} of ${prices.lines} lines priced live — $${(prices.liveTotal || 0).toFixed(2)}`,
        h('span', { style: { color: C.faint } }, ` · ${(prices.estimateTotal || 0).toFixed(2)} still estimated · ${ageText}`))
      : h('div', { style: { fontSize: '11px', color: C.faint, marginTop: '6px', lineHeight: 1.45 } },
        'The totals here are catalogue estimates. Ask Hermes for live LCSC prices and they replace the guessed lines.'))
}

/** The plain-language panel: what it costs, what to buy, what to print. */
function SimplePanel({ design, analysis, exports, onEngineer }) {
  const rows = design.parts.map((p) => ({ ...p, part: PARTS[p.key] }))
  rows.sort((x, y) => y.part.price * y.qty - x.part.price * x.qty)
  const printed = design.nodes.filter((n) => n.mat === 'shell' || n.print).length
  const big = (k, v, sub, color) => h('div', { style: S.bigCard },
    h('div', { style: S.bigKey }, k),
    h('div', { style: { ...S.bigVal, color: color || C.text } }, v),
    sub ? h('div', { style: S.bigSub }, sub) : null)

  return h('div', { style: { padding: '14px 0 8px' } },
    h('div', { style: S.simpleHead }, 'Your machine, in plain words'),
    h('div', { style: S.simpleGrid },
      big('COST', money(analysis.cost), 'parts, at hobby prices', C.accent),
      big('PRINT TIME', `${fmt(analysis.print.hours, 0)} h`, `${Math.round(analysis.print.grams)}g of filament`, C.amber),
      big('WEIGHT', `${Math.round(analysis.mass.totalG)} g`, 'finished machine', C.cyan)),
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
    h('div', { style: S.simpleLabel }, 'WHAT TO BUY'),
    h('div', { style: { marginBottom: '14px' } }, rows.slice(0, 6).map((r) => h('div', { key: r.key, style: S.buyRow },
      h('span', { style: S.buyName }, r.part.name),
      h('span', { style: S.buyQty }, `×${r.qty}`),
      h('span', { style: S.buyPrice }, money(r.part.price * r.qty)))),
      rows.length > 6 ? h('div', { style: S.buyMore }, `+ ${rows.length - 6} more line items`) : null),
    h('div', { style: S.simpleLabel }, 'WHAT TO PRINT'),
    h('div', { style: { fontFamily: C.mono, fontSize: '11.5px', color: C.dim, lineHeight: 1.6, marginBottom: '16px' } },
      `${printed} printed parts · ${fmt(analysis.print.hours, 1)} h · ${Math.round(analysis.print.grams)} g PETG`,
      h('div', { style: { color: C.faint, fontSize: '10.5px', marginTop: '3px' } },
        'One file per part, already oriented and bed-checked.')),
    h('button', { style: { ...S.btnPrimary, height: '40px', fontSize: '13px' }, onClick: exports[1][1] },
      '⬇ DOWNLOAD THE PRINT PACK (.zip)'),
    h('button', {
      style: { ...S.btn, marginTop: '8px', height: '32px', width: '100%', justifyContent: 'center' },
      onClick: onEngineer,
    }, '⌁ SHOW ME THE ENGINEERING'))
}

const ARCHETYPES = [
  ['iot', 'IoT'], ['gadget', 'ESP32'], ['gripper', 'GRIPPER'], ['arm', 'ARM'], ['rover', 'ROVER'],
  ['quadruped', 'QUAD'], ['humanoid', 'HUMANOID'], ['robot', 'FULL ROBOT'], ['gantry', 'GANTRY'],
]

// Plain words next to every preset — the cards are how a first-timer builds
// without ever typing a brief.
const PRESET_BLURBS = {
  iot: 'one sensor, one case, one afternoon',
  gantry: 'metre-scale, belts + rails',
  arm: 'lifts and sorts small parts',
  rover: 'a rolling robot that explores',
  quad: 'a robot dog that walks',
  grip: 'a claw that grabs things',
  humanoid: 'a walking robot with arms',
  robot: 'rover + arm in one machine',
  desk: 'a little electronic desk gadget',
}

/** One honest sentence anybody can read — the tables below carry the detail. */
function plainVerdict(checks) {
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
  const [tab, setTab] = useState('spec')
  const [simple, setSimple] = useState(() => (CTX && CTX.storage.get('simple', true)) !== false)
  const [guideOff, setGuideOff] = useState(false)
  const [menu, setMenu] = useState(false)
  const [shelf, setShelf] = useState(() => (CTX && CTX.storage.get('shelf', [])) || [])
  const [link, setLink] = useState('idle') // 'live' | 'offline' | 'idle'
  const [jointGroup, setJointGroup] = useState('all')

  const spec = useMemo(() => composeDesign(brief), [brief])
  const { design, analysis } = spec

  const [pose, setPose] = useState(() => design.joints.map(() => 0))
  const [cam, setCam] = useState(() => CAM_FOR(analysis.dims))
  const [opts, setOpts] = useState({ grid: true, dims: false, wire: false, explode: false })

  // A joint set can change with the brief (3-DoF → 6-DoF): keep the pose array
  // the same length as the chain, or the sliders lie about the machine.
  useEffect(() => {
    setPose((p) => design.joints.map((j, i) => (p[i] == null ? 0 : clamp(p[i], j.min, j.max))))
  }, [design])

  useEffect(() => {
    setCam((c) => ({ ...c, dist: CAM_FOR(analysis.dims).dist }))
  }, [analysis.dims[0], analysis.dims[1], analysis.dims[2]])

  useEffect(() => {
    if (CTX) CTX.storage.set('lastBrief', brief)
  }, [brief])

  // A build handed over by the agent (`::rigforge{...}` → shelf) lands here.
  useEffect(() => {
    if (!CTX) return
    const pending = CTX.storage.get('pendingBrief', null)
    if (pending && pending.mission) {
      CTX.storage.remove('pendingBrief')
      setBrief({ ...DEFAULT_BRIEF, ...pending })
      setMission(pending.mission || '')
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
    joints: design.joints.map((j, i) => ({ ...j, angle: pose[i] || 0 })),
  }), [design, pose])

  const mesh = useMemo(() => buildMesh(posedDesign, opts.explode ? 1 : 0), [posedDesign, opts.explode])

  const applyBrief = useCallback((next) => {
    setBrief((cur) => ({ ...cur, ...next }))
  }, [])

  const pickArchetype = (id) => {
    const preset = PRESETS.find((p) => p.brief.archetype === id)
    const next = { ...DEFAULT_BRIEF, ...(preset ? preset.brief : { archetype: id }) }
    setBrief(next)
    setMission(next.mission)
  }

  const onBuild = () => {
    // An empty brief is not an error — it is an invitation. Surprise them.
    const parsed = mission.trim() ? parseBrief(mission) : { ...PRESETS[Math.floor(Math.random() * PRESETS.length)].brief }
    applyBrief({ ...parsed, material: brief.material, mcu: brief.mcu, battery: brief.battery })
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

  const fileBase = slug(design.title)
  const exports = [
    ['STL mesh (mm)', () => download(`${fileBase}.stl`, toSTL(buildMesh(posedDesign)), 'model/stl')],
    ['Print pack · per-part STLs (zip)', () => download(`${fileBase}-printpack.zip`, zipStore(printedPartSTLs(design)), 'application/zip')],
    ['OpenSCAD source', () => download(`${fileBase}.scad`, toOpenSCAD(design), 'text/plain')],
    ['Build spec .md', () => download(`${fileBase}.md`, toSpecMarkdown(design, analysis), 'text/markdown')],
    ['Bill of materials .csv', () => download(`${fileBase}-bom.csv`, toBOMCsv(design), 'text/csv')],
    ['Firmware .ino', () => download(`${fileBase}.ino`, design.firmware, 'text/plain')],
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

  const fails = analysis.checks.filter((c) => c.level === 'fail').length
  const warns = analysis.checks.filter((c) => c.level === 'warn').length

  const panel = tab === 'spec' ? h(TabSpec, { design, analysis })
    : tab === 'parts' ? h(TabParts, { design, analysis })
      : tab === 'pins' ? h(TabPins, { analysis })
        : tab === 'power' ? h(TabPower, { analysis })
          : tab === 'print' ? h(TabPrint, { design, analysis })
            : tab === 'code' ? h(TabCode, { design })
              : h(TabSteps, { design, analysis })

  const strip = (label, value, color, first) => h('div', { style: first ? S.stripItemFirst : S.stripItem },
    h('span', { style: S.stripKey }, label),
    h('span', { style: { ...S.stripVal, color: color || C.text } }, value))

  return h('div', { style: S.root, 'data-rf': 'root' },
    h('style', {}, GLOBAL_CSS),
    // ── top bar: brand · one project strip · actions ────────────────────────
    h('div', { style: S.top },
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
        h('button', { style: S.btn, onClick: saveToShelf, title: 'keep this build on the shelf' }, 'Save')),
    ),

    // ── body ───────────────────────────────────────────────────────────────
    h('div', { style: S.body, 'data-rf': 'body' },
      // left rail: the brief
      h('div', { style: S.rail, 'data-rf': 'rail' },
        h('div', { style: S.sectionLabel }, 'pick a machine — or describe your own'),
        (guideOff || (CTX && CTX.storage.get('seenFirstRun', false))) ? null : h('div', { style: S.firstRun },
          h('div', { style: S.firstRunStep },
            h('div', { style: S.firstRunNum }, 'STEP 1'),
            h('div', { style: S.firstRunText }, 'Pick a machine. Each card is a real, buildable design.')),
          h('div', { style: S.firstRunStep },
            h('div', { style: S.firstRunNum }, 'STEP 2'),
            h('div', { style: S.firstRunText }, 'Set one number — payload or reach. Everything rescales.')),
          h('div', { style: S.firstRunStep },
            h('div', { style: S.firstRunNum }, 'STEP 3'),
            h('div', { style: S.firstRunText }, 'Press BUILD. You get parts, files and code.')),
          h('button', {
            style: { ...S.btn, height: '24px', padding: '0 9px', fontSize: '10.5px', flex: '0 0 auto' },
            'aria-label': 'Dismiss the guide',
            onClick: () => { if (CTX) { CTX.storage.set('seenFirstRun', true); setGuideOff(true) } },
          }, 'GOT IT')),
        h('div', { style: S.cards },
          PRESETS.map((p) => h('button', {
            key: p.id,
            style: brief.archetype === p.brief.archetype ? S.cardOn : S.card,
            'aria-label': `Build a ${p.label}`,
            onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission) },
          },
            h(Thumb, { archetype: p.brief.archetype }),
            h('span', { style: S.cardTitle }, p.label.toUpperCase()),
            h('span', { style: S.cardSub }, PRESET_BLURBS[p.id] || '')))),

        h('textarea', {
          rows: 2, value: mission, style: { ...S.input, marginBottom: '8px' },
          placeholder: '…or describe the machine you want — "a robot car that maps my room"',
          'aria-label': 'Describe the machine to build',
          onChange: (e) => setMission(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onBuild() } },
        }),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('button', { style: S.btnPrimary, onClick: onBuild }, 'BUILD'),
          h('button', {
            style: { ...S.btn, flex: '0 0 auto' },
            title: 'roll a random machine',
            'aria-label': 'Build a random machine',
            onClick: surprise,
          }, '⚄')),

        h('div', { style: S.chips, marginTop: '10px' },
          ARCHETYPES.map(([id, label]) => h('button', {
            key: id, style: brief.archetype === id ? S.chipOn : S.chip,
            title: `switch machine type to ${label.toLowerCase()}`,
            onClick: () => pickArchetype(id),
          }, label))),

        (() => { const v = plainVerdict(analysis.checks); return h('div', {
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
              : null,
            h(Select, {
              label: 'MATERIAL', value: brief.material,
              options: MAT_OPTIONS,
              hint: 'what you print the frame in — PETG survives drops',
              onChange: (v) => applyBrief({ material: v }),
            })),

        h(Select, {
          label: 'CONTROLLER', value: brief.mcu,
          options: MCU_KEYS.map((k) => ({ value: k, label: PARTS[k].name })),
          hint: 'the robot\'s brain',
          onChange: (v) => applyBrief({ mcu: v }),
        }),
        brief.archetype !== 'gadget'
          ? h(Select, {
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
          })
          : null,

        shelf.length
          ? h('div', {},
            h('div', { style: { ...S.sectionLabel, marginTop: '10px' } }, 'shelf'),
            shelf.map((s) => h('div', {
              key: s.id, style: S.shelfRow,
              onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...s.brief }); setMission(s.brief.mission) },
            },
              h('span', { style: { fontSize: '11px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title),
              h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint } }, money(s.cost)))))
          : null,

        h('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: `1px solid ${C.line}`, fontSize: '10px', color: C.faint, lineHeight: 1.5 } },
          'Deterministic engine: torque, current, mass and print time are computed, not narrated. The agent redesigns; the maths here is yours.')),

      // centre: viewport
      h('div', { style: { ...S.col, minWidth: 0, position: 'relative' }, 'data-rf': 'view' },
        h(Viewport, { mesh, cam, setCam, opts, design, analysis }),
        h('div', { style: S.viewTools },
          ['ISO', 'FRONT', 'SIDE', 'TOP'].map((v, i) => {
            const views = [
              { yaw: -0.62, pitch: 0.42 }, { yaw: -Math.PI / 2, pitch: 0.02 },
              { yaw: 0, pitch: 0.02 }, { yaw: -Math.PI / 2, pitch: 1.44 },
            ]
            return h('button', {
              key: v, style: S.tool, onClick: () => setCam((c) => ({ ...c, ...views[i] })),
            }, v)
          }),
          h('button', {
            style: opts.grid ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, grid: !o.grid })),
          }, 'GRID'),
          h('button', {
            style: opts.dims ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, dims: !o.dims })),
          }, 'DIMS'),
          h('button', {
            style: opts.wire ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, wire: !o.wire })),
          }, 'WIRE'),
          h('button', {
            style: opts.explode ? S.toolOn : S.tool,
            onClick: () => setOpts((o) => ({ ...o, explode: !o.explode })),
          }, 'EXPLODE'),
          h('button', {
            style: cam.ortho ? S.toolOn : S.tool,
            onClick: () => setCam((c) => ({ ...c, ortho: !c.ortho })),
          }, 'ORTHO')),
        h('div', { style: S.jointBar },
          // 23 joints do not fit in one row: a group filter beats a scrollbar
          // nobody notices, and it is how you actually pose a humanoid.
          design.joints.length > 6
            ? h('div', {
              style: {
                display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto',
                paddingRight: '10px', marginRight: '4px', borderRight: `1px solid ${C.line}`,
              },
            },
              h('span', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', color: C.faint } },
                `${design.joints.length} JOINTS`),
              h('div', { style: { display: 'flex', gap: '3px' } },
                [['all', 'ALL'], ['body', 'TORSO'], ['l', 'LEFT'], ['r', 'RIGHT']].map(([id, label]) => h('button', {
                  key: id,
                  style: { ...(jointGroup === id ? S.toolOn : S.tool), width: 'auto', padding: '3px 7px' },
                  onClick: () => setJointGroup(id),
                }, label)),
              jointGroup === 'all'
                ? h('span', { style: { fontFamily: C.mono, fontSize: '8px', color: C.faint, letterSpacing: '0.06em' } }, 'scroll →')
                : null))
            : null,
          design.joints.length
            ? design.joints.map((j, i) => [j, i])
              .filter(([j]) => jointGroup === 'all' || (jointGroup === 'body'
                ? j.id.startsWith('waist') || j.id.startsWith('neck')
                : j.id.startsWith(`${jointGroup}-`)))
              .map(([j, i]) => h('div', { key: j.id, style: S.joint },
              h('div', { style: S.jointTop },
                h('span', {}, j.label.toUpperCase().slice(0, 14)),
                h('span', { style: { color: C.accent } }, `${Math.round(pose[i] || 0)}${j.slide ? 'mm' : '°'}`)),
              h('input', {
                type: 'range', min: j.min, max: j.max, step: 1, value: pose[i] || 0,
                style: { ...S.range, height: '14px' },
                onChange: (e) => {
                  const v = Number(e.target.value)
                  setPose((p) => p.map((x, k) => (k === i ? v : x)))
                },
              })))
            : h('div', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, padding: '8px 0' } },
              'no articulated joints — static assembly'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
            h('button', { style: S.tool, onClick: () => setPose(design.joints.map(() => 0)) }, 'HOME'),
            h('button', {
              style: S.tool,
              onClick: () => setPose(design.joints.map((j, i) => (i === 0 && design.joints.length > 1 ? 0 : Math.round(i % 2 ? j.max * 0.6 : j.min * 0.55)))),
            }, 'POSE')))),

      // right rail: the spec
      h('div', { style: S.col, 'data-rf': 'spec' },
        simple ? h('div', { style: { ...S.tabBody, padding: '4px 16px 24px' } },
          h(SimplePanel, { design, analysis, exports, onEngineer: () => { setSimple(false); if (CTX) CTX.storage.set('simple', false); setTab('spec') } }))
          : h('div', { style: S.tabs },
          TABS.map(([id, label]) => h('button', {
            key: id, style: tab === id ? S.tabOn : S.tab,
            onClick: () => setTab(id),
          }, label))),
        simple ? null : h('div', { style: S.tabBody }, panel),
        simple ? null : h('div', { style: S.footer },
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.1em' } },
            `${design.parts.length} LINE ITEMS`),
          h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: '14px', fontWeight: 600, color: C.accent } }, money(analysis.cost)))),
    ),
  )
}
