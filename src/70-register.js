// ── registration: page, nav, palette, and the agent's way back in ───────────

/**
 * The transcript directive. An agent that wants to hand a machine to the user
 * writes ONE line in chat:
 *
 *   ::rigforge{brief={"archetype":"rover","mission":"moon rover","payloadKg":4}}
 *
 * and this renders as a load-into-studio card. This is the agent→plugin door:
 * the studio page is the plugin's state, storage carries the brief across the
 * navigation, and nothing here trusts the attrs beyond the JSON parse.
 */
function DirectiveCard({ attrs }) {
  const brief = parseDirective(attrs)
  if (!brief) {
    return h('div', { style: { fontFamily: C.mono, fontSize: '11px', color: C.red, padding: '8px 10px', border: `1px solid ${C.line}`, borderRadius: '6px' } },
      'rigforge: could not parse the brief JSON in this directive')
  }
  const { design, analysis } = composeDesign(brief)
  const open = () => {
    if (CTX) CTX.storage.set('pendingBrief', brief)
    host.navigate(ROUTE)
  }
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 14px',
      border: `1px solid ${C.line}`, borderRadius: '8px', background: C.panel,
      color: C.text, maxWidth: '640px',
    },
  },
    h('div', { style: { flex: '1', minWidth: 0 } },
      h('div', { style: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.16em', color: C.accent } }, 'RIGFORGE · BUILD'),
      h('div', { style: { fontSize: '13px', fontWeight: 600, marginTop: '3px' } }, design.title),
      h('div', { style: { fontFamily: C.mono, fontSize: '10.5px', color: C.dim, marginTop: '3px' } },
        `${design.parts.length} parts · ${money(analysis.cost)} · ${Math.round(analysis.mass.totalG)}g · ${fmt(analysis.print.hours, 0)}h print`)),
    h('button', {
      style: { ...S.btn, borderColor: C.accent, color: C.accent, flex: '0 0 auto' },
      onClick: open,
    }, 'OPEN IN STUDIO'))
}

const plugin = {
  id: 'rigforge',
  name: 'Rigforge',
  description: 'Build studio for robots and printed machines: posed 3D geometry, joint/physics sizing, ESP32 pin map, firmware, BOM and STL export.',
  version: '1.0.0',
  defaultEnabled: true,

  register(ctx) {
    CTX = ctx

    ctx.contribution(ROUTES_AREA, {
      id: 'rigforge.page',
      data: { path: ROUTE },
      title: 'Rigforge',
      render: () => h(Studio),
    })

    ctx.contribution(SIDEBAR_NAV_AREA, {
      id: 'rigforge.nav',
      data: { path: ROUTE, label: 'Rigforge', codicon: 'circuit-board' },
    })

    const quick = (id, label, keywords, brief, detail) => ctx.contribution(PALETTE_AREA, {
      id,
      data: {
        label,
        keywords,
        icon: 'circuit-board',
        detail: () => detail,
        run: () => {
          if (brief) {
            CTX.storage.set('pendingBrief', { ...DEFAULT_BRIEF, ...brief })
            host.navigate(ROUTE)
          } else {
            host.navigate(ROUTE)
          }
        },
      },
    })

    quick('rigforge.open', 'Rigforge: build studio', ['robot', 'hardware', 'cad', '3d', 'esp32'], null, 'Robots and printed machines, spec’d end to end')
    quick('rigforge.arm', 'Rigforge: new robot arm', ['servo', 'arm', 'manipulator'], PRESETS[0].brief, '5-DoF arm with sized servos')
    quick('rigforge.rover', 'Rigforge: new rover', ['rover', 'wheels', 'drive'], PRESETS[1].brief, '4WD rover with torque + runtime maths')
    quick('rigforge.quad', 'Rigforge: new quadruped', ['quadruped', 'walking', 'servos'], PRESETS[2].brief, '12-servo gait machine')
    quick('rigforge.gadget', 'Rigforge: new ESP32 device', ['esp32', 'sensor', 'enclosure'], PRESETS[4].brief, 'Desk device with a printed case')

    ctx.contribution(TRANSCRIPT_DIRECTIVE_AREA, {
      id: 'rigforge.directive',
      data: {
        name: 'rigforge',
        render: (props) => h(DirectiveCard, { attrs: props.attrs || {} }),
      },
    })

    // Settings ▸ Plugins ▸ Rigforge — plain themed text, no studio palette here:
    // this page lives inside the app's own chrome.
    ctx.registerSettingsPage?.({
      id: 'about',
      title: 'Rigforge',
      icon: 'circuit-board',
      render: () => h('div', { style: { padding: '4px 2px', display: 'grid', gap: '10px', maxWidth: '620px' } },
        h('div', { style: { fontSize: '13px', lineHeight: 1.6, color: 'var(--ui-text-secondary, inherit)' } },
          'A build studio for robots and printed machines. Describe a machine and it returns geometry, joint sizing, a power budget, a pin map, firmware, a BOM and assembly order — all computed, not generated prose.'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 12px', fontFamily: C.mono, fontSize: '11px' } },
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'archetypes'),
          h('span', {}, 'arm · rover · quadruped · gripper · gadget'),
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'engine'),
          h('span', {}, 'deterministic, offline'),
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'exports'),
          h('span', {}, 'STL · OpenSCAD · spec.md · BOM.csv · firmware.ino'),
          h('span', { style: { color: 'var(--ui-text-tertiary, #888)' } }, 'agent door'),
          h('span', {}, '::rigforge{brief={"archetype":"rover","payloadKg":4}}'))),
    })
  },
}

export default plugin
