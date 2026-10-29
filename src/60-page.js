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
    checks: analysis.checks.slice(0, 6).map((c) => ({ level: c.level, msg: c.msg.slice(0, 200) })),
  }
}

// Fit the camera to the machine: the largest dimension should occupy ~70% of
// the viewport, so the thing the user just designed is actually readable.
const CAM_FOR = (dims) => {
  const diag = Math.hypot(dims[0], dims[1], dims[2]) || 300
  return { ...CAM0, dist: clamp(diag * 1.06, 300, 5200) }
}

function StatChip({ k, v, color }) {
  return h('div', { style: S.statChip },
    h('span', { style: S.statKey }, k),
    h('span', { style: { ...S.statVal, color: color || C.text } }, v))
}

function ParamSlider({ label, value, min, max, step, unit, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label },
      h('span', {}, label),
      h('span', { style: { color: C.text } }, `${value}${unit || ''}`)),
    h('input', {
      type: 'range', min, max, step, value, style: S.range,
      onChange: (e) => onChange(Number(e.target.value)),
    }))
}

function Select({ label, value, options, onChange }) {
  return h('div', { style: S.field },
    h('div', { style: S.label }, h('span', {}, label)),
    h('select', {
      value, style: { ...S.input, padding: '6px 8px', cursor: 'pointer' },
      onChange: (e) => onChange(e.target.value),
    }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))))
}

const ARCHETYPES = [
  ['robot', 'FULL ROBOT'], ['arm', 'ARM'], ['rover', 'ROVER'], ['quadruped', 'QUAD'],
  ['gripper', 'GRIPPER'], ['gadget', 'ESP32'],
]

function Studio() {
  const [brief, setBrief] = useState(() => (CTX && CTX.storage.get('lastBrief', null)) || DEFAULT_BRIEF)
  const [mission, setMission] = useState(() => brief.mission)
  const [tab, setTab] = useState('spec')
  const [menu, setMenu] = useState(false)
  const [shelf, setShelf] = useState(() => (CTX && CTX.storage.get('shelf', [])) || [])
  const [link, setLink] = useState('idle') // 'live' | 'offline' | 'idle'

  const spec = useMemo(() => composeDesign(brief), [brief])
  const { design, analysis } = spec

  const [pose, setPose] = useState(() => design.joints.map(() => 0))
  const [cam, setCam] = useState(() => CAM_FOR(analysis.dims))
  const [opts, setOpts] = useState({ grid: true, dims: false, wire: false })

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

  const mesh = useMemo(() => buildMesh(posedDesign), [posedDesign])

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
    const parsed = parseBrief(mission)
    applyBrief({ ...parsed, material: brief.material, mcu: brief.mcu, battery: brief.battery })
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

  return h('div', { style: S.root },
    // ── top bar ────────────────────────────────────────────────────────────
    h('div', { style: S.top },
      h('div', { style: S.mark },
        h('span', { style: { fontFamily: C.mono, fontSize: '16px', color: C.accent, lineHeight: 1 } }, '⌬'),
        h('span', { style: S.wordmark }, 'RIGFORGE'),
        h('span', { style: S.tagline }, 'robots · printed machines · spec out')),
      h('div', { style: S.topStats },
        h(StatChip, { k: 'COST', v: money(analysis.cost) }),
        h(StatChip, { k: 'MASS', v: `${Math.round(analysis.mass.totalG)}g` }),
        h(StatChip, { k: 'PEAK', v: `${fmt(analysis.power.peak, 1)}A`, color: analysis.power.peak > (analysis.power.bat?.maxA || 99) ? C.amber : C.text }),
        h(StatChip, { k: 'PRINT', v: `${fmt(analysis.print.hours, 0)}h` }),
        h(StatChip, { k: 'CHECKS', v: fails ? `${fails} FAIL` : warns ? `${warns} WARN` : 'PASS', color: fails ? C.red : warns ? C.amber : C.green }),
        h(StatChip, { k: 'AGENT', v: link === 'live' ? 'LINKED' : link === 'offline' ? 'OFFLINE' : '…', color: link === 'live' ? C.green : link === 'offline' ? C.faint : C.dim }),
        h('button', { style: { ...S.btn, borderColor: C.accent, color: C.accent }, onClick: askHermes }, '⌁ ASK HERMES'),
        h('div', { style: { position: 'relative' } },
          h('button', { style: S.btn, onClick: () => setMenu((m) => !m) }, 'EXPORT ▾'),
          menu
            ? h('div', { style: S.menu },
              exports.map(([label, fn]) => h('div', {
                key: label, style: S.menuItem,
                onClick: () => { setMenu(false); fn() },
                onMouseEnter: (e) => { e.currentTarget.style.background = C.raise },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
              }, h('span', {}, label))))
            : null),
        h('button', { style: S.btn, onClick: saveToShelf }, 'SAVE')),
    ),

    // ── body ───────────────────────────────────────────────────────────────
    h('div', { style: S.body },
      // left rail: the brief
      h('div', { style: S.rail },
        h('div', { style: S.sectionLabel }, 'brief'),
        h('textarea', {
          rows: 3, value: mission, style: { ...S.input, marginBottom: '8px' },
          placeholder: 'Describe the machine — "4WD rover that maps a room, 3kg of gear"',
          onChange: (e) => setMission(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onBuild() },
        }),
        h('div', { style: S.chips },
          ARCHETYPES.map(([id, label]) => h('button', {
            key: id, style: brief.archetype === id ? S.chipOn : S.chip,
            onClick: () => pickArchetype(id),
          }, label))),
        h('div', { style: S.chips, marginBottom: '14px' },
          PRESETS.map((p) => h('button', {
            key: p.id, style: S.chip,
            onClick: () => { setBrief({ ...DEFAULT_BRIEF, ...p.brief }); setMission(p.brief.mission) },
          }, p.label))),

        h('button', { style: S.btnPrimary, onClick: onBuild }, 'BUILD FROM BRIEF'),

        h('div', { style: { ...S.sectionLabel, marginTop: '16px' } }, 'parameters'),
        brief.archetype === 'gadget'
          ? h(Select, {
            label: 'MATERIAL', value: brief.material,
            options: [{ value: 'pla', label: 'PLA+ · stiff' }, { value: 'petg', label: 'PETG · tough' }],
            onChange: (v) => applyBrief({ material: v }),
          })
          : h('div', {},
            h(ParamSlider, {
              label: 'PAYLOAD', value: brief.payloadKg, min: 0.1, max: brief.archetype === 'rover' ? 15 : 6, step: 0.1, unit: ' kg',
              onChange: (v) => applyBrief({ payloadKg: v }),
            }),
            brief.archetype === 'rover' || brief.archetype === 'robot'
              ? h(ParamSlider, {
                label: 'WHEEL Ø', value: brief.wheelMm || (brief.archetype === 'robot' ? 130 : 100),
                min: brief.archetype === 'robot' ? 80 : 60, max: brief.archetype === 'robot' ? 160 : 130,
                step: 5, unit: ' mm',
                onChange: (v) => applyBrief({ wheelMm: v }),
              })
              : h(ParamSlider, {
                label: brief.archetype === 'gripper' ? 'JAW OPENING' : brief.archetype === 'quadruped' ? 'LEG SPAN' : 'REACH',
                value: brief.reachMm, min: 120, max: 1200, step: 10, unit: ' mm',
                onChange: (v) => applyBrief({ reachMm: v }),
              }),
            brief.archetype === 'arm'
              ? h(ParamSlider, { label: 'AXES', value: brief.dof, min: 3, max: 6, step: 1, onChange: (v) => applyBrief({ dof: v }) })
              : null,
            h(Select, {
              label: 'MATERIAL', value: brief.material,
              options: [{ value: 'petg', label: 'PETG · tough' }, { value: 'pla', label: 'PLA+ · stiff' }],
              onChange: (v) => applyBrief({ material: v }),
            })),

        h(Select, {
          label: 'CONTROLLER', value: brief.mcu,
          options: MCU_KEYS.map((k) => ({ value: k, label: PARTS[k].name })),
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
      h('div', { style: { ...S.col, minWidth: 0, position: 'relative' } },
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
            style: cam.ortho ? S.toolOn : S.tool,
            onClick: () => setCam((c) => ({ ...c, ortho: !c.ortho })),
          }, 'ORTHO')),
        h('div', { style: S.jointBar },
          design.joints.length
            ? design.joints.map((j, i) => h('div', { key: j.id, style: S.joint },
              h('div', { style: S.jointTop },
                h('span', {}, j.label.toUpperCase().slice(0, 14)),
                h('span', { style: { color: C.accent } }, `${Math.round(pose[i] || 0)}°`)),
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
              onClick: () => setPose(design.joints.map((j, i) => (i === 0 ? 0 : Math.round(i % 2 ? j.max * 0.6 : j.min * 0.55)))),
            }, 'POSE')))),

      // right rail: the spec
      h('div', { style: S.col },
        h('div', { style: S.tabs },
          TABS.map(([id, label]) => h('button', {
            key: id, style: tab === id ? S.tabOn : S.tab,
            onClick: () => setTab(id),
          }, label))),
        h('div', { style: S.tabBody }, panel),
        h('div', { style: S.footer },
          h('span', { style: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.1em' } },
            `${design.parts.length} LINE ITEMS`),
          h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: '14px', fontWeight: 600, color: C.accent } }, money(analysis.cost)))),
    ),
  )
}
