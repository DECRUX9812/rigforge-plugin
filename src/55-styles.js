// ── the studio ──────────────────────────────────────────────────────────────
// A dark instrument surface on purpose: this is a CAD viewport, and a machine
// reads better against graphite than against a light chat theme. Everything
// else in the app stays themed; this page is the workbench.

const C = {
  bg: '#0A0D10',
  panel: '#0E1318',
  panel2: '#121920',
  raise: '#172130',
  line: '#1F2A34',
  lineSoft: '#18212A',
  text: '#E8EFF5',
  dim: '#8FA3B3',
  faint: '#5D6F7D',
  accent: '#FF6A1A',
  accentDim: 'rgba(255,106,26,0.14)',
  cyan: '#39D3E8',
  green: '#4ED08A',
  amber: '#FFC24A',
  red: '#FF5F56',
  mono: 'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
}

const S = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    background: C.bg, color: C.text, fontFamily: 'var(--ui-font, system-ui, sans-serif)',
    fontSize: '13px',
  },
  top: {
    display: 'flex', alignItems: 'center', gap: '18px', padding: '0 16px',
    height: '54px', flex: '0 0 54px', borderBottom: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
  },
  mark: { display: 'flex', alignItems: 'baseline', gap: '9px' },
  wordmark: {
    fontFamily: C.mono, fontWeight: 700, letterSpacing: '0.22em', fontSize: '13px',
    color: C.text,
  },
  tagline: { fontSize: '11px', color: C.faint, letterSpacing: '0.04em' },
  topStats: { display: 'flex', gap: '10px', marginLeft: 'auto', alignItems: 'center' },
  statChip: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '4px 10px',
    border: `1px solid ${C.line}`, borderRadius: '6px', background: C.panel,
    minWidth: '62px',
  },
  statKey: { fontSize: '9px', letterSpacing: '0.12em', color: C.faint, fontFamily: C.mono },
  statVal: { fontSize: '12px', fontFamily: C.mono, color: C.text, fontWeight: 600 },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '30px',
    padding: '0 12px', borderRadius: '6px', border: `1px solid ${C.line}`,
    background: C.panel2, color: C.text, fontSize: '12px', cursor: 'pointer',
    fontFamily: C.mono, letterSpacing: '0.03em', whiteSpace: 'nowrap',
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    height: '34px', padding: '0 14px', borderRadius: '6px', border: '1px solid #ff8a4a',
    background: C.accent, color: '#141414', fontSize: '12px', fontWeight: 700,
    cursor: 'pointer', fontFamily: C.mono, letterSpacing: '0.08em', width: '100%',
  },
  body: {
    display: 'grid', gridTemplateColumns: '286px minmax(0,1fr) 382px',
    gap: '1px', background: C.line, flex: '1 1 auto', minHeight: 0,
  },
  col: { background: C.bg, minHeight: 0, display: 'flex', flexDirection: 'column' },
  rail: { background: C.panel, minHeight: 0, overflowY: 'auto', padding: '14px' },
  sectionLabel: {
    fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.18em', color: C.faint,
    margin: '0 0 8px 0', textTransform: 'uppercase',
  },
  field: { marginBottom: '12px' },
  label: {
    display: 'flex', justifyContent: 'space-between', fontSize: '11px',
    color: C.dim, marginBottom: '4px', fontFamily: C.mono,
  },
  input: {
    width: '100%', boxSizing: 'border-box', background: C.bg, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: '6px', padding: '8px 10px',
    fontSize: '12px', fontFamily: 'inherit', resize: 'vertical', outline: 'none',
    lineHeight: 1.45,
  },
  range: { width: '100%', accentColor: C.accent, height: '16px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' },
  chip: {
    padding: '4px 9px', borderRadius: '999px', border: `1px solid ${C.line}`,
    background: C.panel2, color: C.dim, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.mono, whiteSpace: 'nowrap',
  },
  chipOn: {
    padding: '4px 9px', borderRadius: '999px', border: `1px solid ${C.accent}`,
    background: C.accentDim, color: C.accent, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.mono, whiteSpace: 'nowrap',
  },
  cards: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '14px' },
  card: {
    padding: '8px 9px', borderRadius: '7px', border: `1px solid ${C.line}`,
    background: C.panel2, cursor: 'pointer', textAlign: 'left',
    display: 'flex', flexDirection: 'column', gap: '2px',
  },
  cardOn: {
    padding: '8px 9px', borderRadius: '7px', border: `1px solid ${C.accent}`,
    background: C.accentDim, cursor: 'pointer', textAlign: 'left',
    display: 'flex', flexDirection: 'column', gap: '2px',
  },
  cardTitle: { fontFamily: C.mono, fontSize: '11px', fontWeight: 700, color: C.text, letterSpacing: '0.02em' },
  cardSub: { fontSize: '10px', color: C.faint, lineHeight: 1.35 },
  hint: { fontSize: '10px', color: C.faint, marginTop: '-6px', marginBottom: '10px', lineHeight: 1.3 },
  viewWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', background: '#080b0e' },
  canvas: { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' },
  hudTL: {
    position: 'absolute', top: '12px', left: '14px', display: 'flex', flexDirection: 'column',
    gap: '3px', pointerEvents: 'none',
  },
  hudRow: { display: 'flex', gap: '8px', alignItems: 'baseline' },
  hudKey: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.14em', color: C.faint, width: '34px' },
  hudVal: { fontFamily: C.mono, fontSize: '11px', color: C.dim },
  hudTR: { position: 'absolute', top: '12px', right: '14px', pointerEvents: 'none' },
  hudHint: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.05em' },
  viewTitle: {
    position: 'absolute', bottom: '14px', left: '88px', fontSize: '12px',
    color: C.dim, pointerEvents: 'none', fontFamily: C.mono, letterSpacing: '0.02em',
  },
  viewSub: { color: C.faint },
  viewTools: {
    position: 'absolute', top: '44px', right: '14px', display: 'flex', flexDirection: 'column',
    gap: '4px',
  },
  tool: {
    width: '58px', padding: '4px 0', textAlign: 'center', borderRadius: '5px',
    border: `1px solid ${C.line}`, background: 'rgba(14,19,24,0.86)', color: C.dim,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.08em',
  },
  toolOn: {
    width: '58px', padding: '4px 0', textAlign: 'center', borderRadius: '5px',
    border: `1px solid ${C.accent}`, background: 'rgba(255,106,26,0.14)', color: C.accent,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.08em',
  },
  jointBar: {
    display: 'flex', gap: '16px', padding: '12px 16px 14px', borderTop: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`, overflowX: 'auto',
    alignItems: 'flex-end', flex: '0 0 auto',
  },
  joint: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '120px', flex: '1 1 120px', maxWidth: '190px' },
  jointTop: { display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '9.5px', color: C.faint },
  tabs: { display: 'flex', gap: '2px', padding: '0 8px', borderBottom: `1px solid ${C.line}`, background: C.panel },
  tab: {
    padding: '9px 8px 8px', fontFamily: C.mono, fontSize: '10px', letterSpacing: '0.1em',
    color: C.faint, cursor: 'pointer', borderBottom: '2px solid transparent', background: 'transparent',
    border: 'none',
  },
  tabOn: {
    padding: '9px 8px 8px', fontFamily: C.mono, fontSize: '10px', letterSpacing: '0.1em',
    color: C.accent, cursor: 'pointer', borderBottom: `2px solid ${C.accent}`, background: 'transparent',
    borderTop: 'none', borderLeft: 'none', borderRight: 'none',
  },
  tabBody: { overflowY: 'auto', padding: '12px 14px 44px', flex: '1 1 auto', minHeight: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontFamily: C.mono, fontSize: '10.5px' },
  th: {
    textAlign: 'left', padding: '4px 6px', color: C.faint, fontWeight: 500,
    letterSpacing: '0.08em', borderBottom: `1px solid ${C.line}`,
  },
  td: { padding: '5px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.dim, verticalAlign: 'top' },
  tdNum: { padding: '5px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.text, textAlign: 'right', whiteSpace: 'nowrap' },
  kv: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', alignItems: 'baseline' },
  kvKey: { color: C.faint, fontSize: '11px', fontFamily: C.mono },
  kvVal: { color: C.text, fontSize: '11.5px', fontFamily: C.mono, textAlign: 'right' },
  pre: {
    margin: 0, padding: '10px 12px', background: '#070A0D', border: `1px solid ${C.line}`,
    borderRadius: '6px', color: '#BFD3E0', fontFamily: C.mono, fontSize: '10.5px',
    lineHeight: 1.55, overflow: 'auto', maxHeight: '100%',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', tabSize: 2,
  },
  warn: {
    display: 'flex', gap: '8px', padding: '7px 9px', borderRadius: '5px',
    fontSize: '11px', lineHeight: 1.45, marginBottom: '6px', alignItems: 'flex-start',
  },
  step: { display: 'flex', gap: '10px', marginBottom: '12px' },
  stepNo: {
    flex: '0 0 auto', width: '20px', height: '20px', borderRadius: '50%',
    border: `1px solid ${C.accent}`, color: C.accent, display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontFamily: C.mono, fontSize: '10px',
  },
  footer: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px',
    borderTop: `1px solid ${C.line}`, background: C.panel,
  },
  shelfRow: {
    display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '6px 8px',
    border: `1px solid ${C.line}`, borderRadius: '5px', marginBottom: '5px',
    cursor: 'pointer', background: C.panel2,
  },
  menu: {
    position: 'absolute', top: '40px', right: '0', zIndex: 20, background: C.panel2,
    border: `1px solid ${C.line}`, borderRadius: '7px', padding: '5px', minWidth: '186px',
    boxShadow: '0 18px 40px rgba(0,0,0,0.55)',
  },
  menuItem: {
    display: 'flex', justifyContent: 'space-between', padding: '7px 9px', borderRadius: '5px',
    fontSize: '11.5px', color: C.text, cursor: 'pointer', fontFamily: C.mono,
  },
}

// The element factory: jsx() directly, with children folded into props.
// `key` goes through jsx's THIRD argument (React 19 warns when it is spread),
// and array children get index keys so static sibling lists stay quiet.
function h(tag, props, ...kids) {
  const p = { ...(props || {}) }
  const key = p.key != null ? p.key : undefined
  delete p.key
  if (kids.length === 1) p.children = kids[0]
  else if (kids.length > 1) p.children = kids.map((k, i) => (k && k.$$el && k.key == null ? { ...k, key: 'k' + i } : k))
  return key === undefined ? jsx(tag, p) : jsx(tag, p, key)
}

const levelColor = (lv) => (lv === 'ok' ? C.green : lv === 'warn' ? C.amber : C.red)
const levelBg = (lv) => (lv === 'ok' ? 'rgba(78,208,138,0.09)' : lv === 'warn' ? 'rgba(255,194,74,0.09)' : 'rgba(255,95,86,0.1)')

function download(name, data, type) {
  const blob = data instanceof ArrayBuffer ? new Blob([data], { type }) : new Blob([data], { type: type || 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'build'
}
