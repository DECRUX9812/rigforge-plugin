// ── the studio ──────────────────────────────────────────────────────────────
// Surface: CONFIGURE (pick a machine, set two numbers, build) with an INSPECT
// secondary (the viewport and the spec rail). So: dense, calm, workmanlike —
// hierarchy from scale and spacing, not from boxes and icons.
//
// Design system
//   type    one sans for everything you read, one mono for anything that is a
//           number or a label. Mono-as-body is what made this read as a
//           terminal instead of a product.
//   colour  graphite workbench, one accent (safety orange), cyan for the
//           machine's own instrumentation, green/amber/red for verdicts only.
//   space   4 · 6 · 8 · 12 · 16 · 20 · 28 — nothing in between.
//   motion  120 ms ease for state, 180 ms for surfaces. Nothing loops.

const C = {
  bg: '#0A0D10',
  panel: '#0D1217',
  panel2: '#111820',
  raise: '#17212C',
  line: '#1E2A35',
  lineSoft: '#16202A',
  text: '#E9F0F6',
  dim: '#B2C2CF',
  faint: '#7E93A2',
  accent: '#FF6A1A',
  accentSoft: 'rgba(255,106,26,0.12)',
  accentLine: 'rgba(255,106,26,0.45)',
  cyan: '#39D3E8',
  green: '#4ED08A',
  amber: '#FFC24A',
  red: '#FF5F56',
  sans: 'var(--ui-font, "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
}


// Global rules the inline styles cannot express: responsiveness, focus rings,
// and motion that politely stops when the OS asks it to. Rendered as one
// <style> element inside the page root, scoped by data-rf attributes.
const GLOBAL_CSS = `
[data-rf="root"] * { box-sizing: border-box; }
[data-rf="root"] button, [data-rf="root"] [role="button"] { font: inherit; }
[data-rf="root"] button:focus-visible,
[data-rf="root"] input:focus-visible,
[data-rf="root"] textarea:focus-visible,
[data-rf="root"] select:focus-visible,
[data-rf="root"] [role="button"]:focus-visible {
  /* inline styles in a few fields say outline:none; the ring has to win, or a
     keyboard user cannot see where they are */
  outline: 2px solid #FF6A1A !important; outline-offset: 2px; border-radius: 8px;
}
[data-rf="root"] ::-webkit-scrollbar { width: 9px; height: 9px; }
[data-rf="root"] ::-webkit-scrollbar-thumb { background: #1E2A35; border-radius: 9px; }
[data-rf="root"] ::-webkit-scrollbar-track { background: transparent; }
[data-rf="body"] { display: grid; grid-template-columns: 288px minmax(0,1fr) 440px; }
@media (max-width: 1440px) {
  [data-rf="body"] { grid-template-columns: 262px minmax(0,1fr) 376px; }
}
@media (max-width: 1180px) {
  [data-rf="body"] { grid-template-columns: 250px minmax(0,1fr); grid-template-rows: minmax(430px, 1fr) auto; }
  [data-rf="spec"] { grid-column: 1 / -1; max-height: 32vh; border-top: 1px solid #1E2A35; }
  [data-rf="view"] { min-height: 46vh; }
  /* the bar carries camera presets, display toggles and a live power badge; it
     wraps rather than pushing the page sideways */
  [data-rf="viewbar"], [role="toolbar"] { flex-wrap: wrap; row-gap: 4px; max-width: calc(100% - 28px); }
  [data-rf="strip"] { display: none; }
}
@media (max-width: 900px) {
  /* one document that scrolls, instead of three panes fighting for height */
  [data-rf="body"] {
    grid-template-columns: 1fr;
    grid-template-rows: min-content min-content min-content;
    grid-auto-rows: min-content;
    overflow-y: auto;
  }
  /* the machine goes first: on a tablet the 3D view *is* the product, and
     having to scroll past the chooser to see it is backwards */
  [data-rf="view"] { order: 1; min-height: 54vh; }
  [data-rf="rail"] { order: 2; max-height: none !important; overflow: visible !important; }
  [data-rf="spec"] { order: 3; max-height: none; }
  [data-rf="codeInput"]::placeholder { color: #6F8493; opacity: 1; }
  [data-rf="tagline"] { display: none; }
  [data-rf="top"] { gap: 10px; padding: 0 12px; }
  [data-rf="strip"] { display: none; }
}
@media (max-width: 900px) {
  /* the pose rack wraps to three rows on a narrow screen and the fixed 78px
     window cut the last slider in half — a joint you cannot reach is worse than
     one further down the page */
  [data-rf="posegrid"] { max-height: 138px !important; }
}

@media (max-width: 780px) {
  /* the drawing title block and the HUD are sheet niceties; on a narrow screen
     they sit on top of the machine, so the machine wins */
  [data-rf="titleblock"] { display: none; }
  [data-rf="hud"] { display: none; }
  [data-rf="view"] { min-height: 50vh; }
  [data-rf="viewbar"], [role="toolbar"] { left: 8px; right: 8px; padding: 6px; max-width: calc(100% - 16px); }
  [data-rf="viewbar"] button, [role="toolbar"] button { min-height: 30px; min-width: 34px; }
  /* The top bar carries the wordmark, the project strip and five controls. On a
     font stack wider than the dev machine's it overflowed by 6px and scrolled
     the whole page sideways. Wrapping is font-independent; shaving gaps only
     moves the threshold. The ⌘K chip is hidden at this width below. */
  [data-rf="top"] { flex-wrap: wrap; row-gap: 6px; }
  [data-rf="top"] > * { min-width: 0; }
  [data-rf="paletteBtn"] { display: none; }
  /* inline style says nowrap; the caption should wrap, not trail off */
  [data-rf="viewtitle"] { left: 12px; right: 12px; white-space: normal !important; overflow: visible !important; line-height: 1.35; }
}

@media (prefers-reduced-motion: reduce) {
  [data-rf="root"] * { transition: none !important; animation: none !important; }
}
`

const S = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    background: C.bg, color: C.text, fontFamily: C.sans,
    fontSize: '13.5px', lineHeight: 1.5, WebkitFontSmoothing: 'antialiased',
    padding: '10px', gap: '10px',
  },

  // ── top bar ─────────────────────────────────────────────────────────────
  top: {
    display: 'flex', alignItems: 'center', gap: '20px', padding: '0 20px',
    height: '58px', flex: '0 0 58px', borderBottom: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
    borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
  },
  mark: { display: 'flex', alignItems: 'center', gap: '10px' },
  wordmark: {
    fontFamily: C.sans, fontWeight: 700, letterSpacing: '0.16em', fontSize: '13px',
    color: C.text,
  },
  tagline: { fontSize: '11.5px', color: C.faint, letterSpacing: '0.01em' },
  topStats: { display: 'flex', gap: '8px', marginLeft: 'auto', alignItems: 'center' },
  projectStrip: {
    display: 'flex', alignItems: 'stretch', gap: '0px', marginLeft: 'auto',
    border: `1px solid ${C.line}`, borderRadius: '9px', background: C.panel, overflow: 'hidden',
  },
  stripItem: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 12px',
    borderLeft: `1px solid ${C.lineSoft}`,
  },
  stripItemFirst: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 12px',
  },
  stripKey: { fontSize: '9px', letterSpacing: '0.13em', color: C.faint, fontFamily: C.mono },
  stripVal: { fontSize: '12.5px', fontFamily: C.mono, color: C.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', alignItems: 'center', gap: '7px' },
  seg: {
    display: 'flex', padding: '2px', borderRadius: '8px', border: `1px solid ${C.line}`,
    background: C.bg, gap: '2px',
  },
  segOn: {
    padding: '4px 10px', borderRadius: '6px', border: 'none', background: C.raise,
    color: C.text, fontSize: '11px', fontWeight: 600, cursor: 'pointer', fontFamily: C.sans,
  },
  segOff: {
    padding: '4px 10px', borderRadius: '6px', border: 'none', background: 'transparent',
    color: C.faint, fontSize: '11px', fontWeight: 500, cursor: 'pointer', fontFamily: C.sans,
  },
  dot: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' },
  statChip: {
    display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 11px',
    border: `1px solid ${C.line}`, borderRadius: '8px', background: C.panel,
    minWidth: '64px',
  },
  statKey: { fontSize: '9.5px', letterSpacing: '0.13em', color: C.faint, fontFamily: C.mono },
  statVal: { fontSize: '12.5px', fontFamily: C.mono, color: C.text, fontWeight: 600 },

  // ── controls ────────────────────────────────────────────────────────────
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', height: '32px',
    padding: '0 13px', borderRadius: '8px', border: `1px solid ${C.line}`,
    background: C.panel2, color: C.dim, fontSize: '12px', fontWeight: 500, cursor: 'pointer',
    fontFamily: C.sans, whiteSpace: 'nowrap',
    transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
    height: '40px', padding: '0 16px', borderRadius: '9px', border: '1px solid #FF8A4A',
    background: 'linear-gradient(180deg, #FF7A2A, #FF6A1A)', color: '#180B02', fontSize: '13px',
    fontWeight: 700, cursor: 'pointer', fontFamily: C.sans, letterSpacing: '0.02em', width: '100%',
    boxShadow: '0 6px 18px rgba(255,106,26,0.20), inset 0 1px 0 rgba(255,255,255,0.22)',
  },
  tool: {
    padding: '5px 9px', textAlign: 'center', borderRadius: '7px',
    border: `1px solid ${C.line}`, background: 'rgba(13,18,23,0.9)', color: C.faint,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.07em',
    transition: 'color 120ms ease, border-color 120ms ease',
  },
  toolOn: {
    padding: '5px 9px', textAlign: 'center', borderRadius: '7px',
    border: '1px solid rgba(255,106,26,0.45)', background: 'rgba(255,106,26,0.12)', color: C.accent,
    fontSize: '9.5px', fontFamily: C.mono, cursor: 'pointer', letterSpacing: '0.07em',
  },

  // ── body grid ───────────────────────────────────────────────────────────
  body: {
    display: 'grid', gap: '10px', background: 'transparent', flex: '1 1 auto', minHeight: 0,
  },
  col: {
    background: C.panel, minHeight: 0, display: 'flex', flexDirection: 'column',
    borderRadius: '12px', border: `1px solid ${C.lineSoft}`, overflow: 'hidden',
    boxShadow: '0 12px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03)',
  },
  rail: {
    background: C.panel, minHeight: 0, overflowY: 'auto', padding: '16px',
    borderRadius: '12px', border: `1px solid ${C.lineSoft}`,
    boxShadow: '0 12px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03)',
  },

  sectionLabel: {
    fontFamily: C.mono, fontSize: '9.5px', letterSpacing: '0.16em', color: C.faint,
    margin: '0 0 10px 0', textTransform: 'uppercase',
  },
  field: { marginBottom: '14px' },
  label: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px',
    fontSize: '12px', color: C.dim, marginBottom: '6px', fontFamily: C.sans,
  },
  input: {
    width: '100%', boxSizing: 'border-box', background: C.bg, color: C.text,
    border: `1px solid ${C.line}`, borderRadius: '8px', padding: '9px 11px',
    fontSize: '12.5px', fontFamily: C.sans, resize: 'vertical', outline: 'none',
    lineHeight: 1.5,
  },
  range: { width: '100%', accentColor: C.accent, height: '18px' },
  hint: { fontSize: '11.5px', color: C.faint, marginTop: '5px', lineHeight: 1.4 },

  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' },
  chip: {
    padding: '5px 10px', borderRadius: '999px', border: `1px solid ${C.line}`,
    background: 'transparent', color: C.faint, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.sans, whiteSpace: 'nowrap',
  },
  chipOn: {
    padding: '5px 10px', borderRadius: '999px', border: `1px solid ${C.accent}`,
    background: 'rgba(255,106,26,0.12)', color: C.accent, fontSize: '11px', cursor: 'pointer',
    fontFamily: C.sans, whiteSpace: 'nowrap', fontWeight: 600,
  },

  // ── machine gallery ─────────────────────────────────────────────────────
  cards: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' },
  card: {
    padding: '7px 8px 9px', borderRadius: '10px', border: `1px solid ${C.line}`,
    background: C.panel2, cursor: 'pointer', textAlign: 'left',
    display: 'flex', flexDirection: 'column', gap: '3px',
    transition: 'border-color 120ms ease, background 120ms ease',
  },
  cardOn: {
    padding: '7px 8px 9px', borderRadius: '10px', border: `1px solid ${C.accent}`,
    background: 'linear-gradient(180deg, rgba(255,106,26,0.16), rgba(255,106,26,0.07))',
    cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '3px',
    boxShadow: '0 0 0 1px rgba(255,106,26,0.22), 0 8px 20px rgba(0,0,0,0.32)',
  },
  cardTitle: { fontFamily: C.sans, fontSize: '11.5px', fontWeight: 650, color: C.text, letterSpacing: '0.01em' },
  cardSub: { fontSize: '11px', color: C.dim, lineHeight: 1.35 },
  thumb: {
    display: 'block', width: '100%', height: '62px', marginBottom: '3px',
    borderRadius: '7px', background: 'radial-gradient(circle at 50% 30%, #12202b, #0a1017 70%)',
    pointerEvents: 'none',
  },

  // ── viewport ────────────────────────────────────────────────────────────
  viewWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden', background: '#080b0e' },
  canvas: { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' },
  // The HUD used to be raw text floating over a bright render: unreadable the
  // moment a light part passed behind it. A small panel guarantees contrast.
  hudTL: {
    position: 'absolute', top: '12px', left: '14px', display: 'flex', flexDirection: 'column',
    gap: '3px', pointerEvents: 'none', padding: '8px 10px', borderRadius: '9px',
    border: `1px solid ${C.line}`, background: 'rgba(9,13,18,0.78)', backdropFilter: 'blur(8px)',
    minWidth: '132px',
  },
  hudRow: { display: 'flex', gap: '10px', alignItems: 'baseline', justifyContent: 'space-between' },
  hudKey: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.13em', color: C.faint },
  hudVal: {
    fontFamily: C.mono, fontSize: '11.5px', color: C.text, fontVariantNumeric: 'tabular-nums',
  },
  hudTR: { position: 'absolute', top: '14px', right: '16px', pointerEvents: 'none' },
  hudHint: { fontFamily: C.mono, fontSize: '10px', color: C.faint, letterSpacing: '0.04em' },
  // A drawing has a title block, bottom right, with the revision and the units
  // on it. This is the single strongest signal that a viewport is a drawing and
  // not a toy: it says what the sheet is, at what scale, and who signed it off.
  titleBlock: {
    position: 'absolute', right: '18px', bottom: '18px', zIndex: 3,
    width: '312px', padding: '9px 11px 8px',
    background: 'rgba(9,13,18,0.9)', border: `1px solid ${C.line}`, borderRadius: '3px',
    backdropFilter: 'blur(6px)', pointerEvents: 'none',
    fontFamily: C.mono, fontSize: '9.5px', letterSpacing: '0.04em', color: C.dim, lineHeight: 1.55,
  },
  tbHead: { color: C.text, fontSize: '9px', letterSpacing: '0.18em', textTransform: 'uppercase', paddingBottom: '5px', borderBottom: `1px solid ${C.line}`, marginBottom: '5px' },
  tbName: { color: C.text, fontFamily: C.sans, fontSize: '11.5px', letterSpacing: '0', marginBottom: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tbRow: { display: 'flex', justifyContent: 'space-between', gap: '8px' },
  tbKey: { color: C.faint },
  tbVal: { color: C.text, textAlign: 'right' },
  viewTitle: {
    position: 'absolute', bottom: '16px', left: '126px', right: '350px', fontSize: '12.5px',
    color: C.dim, pointerEvents: 'none', fontFamily: C.sans, letterSpacing: '0.01em',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  viewSub: { color: C.faint },
  viewTools: {
    position: 'absolute', top: '46px', right: '16px', display: 'flex', flexDirection: 'column',
    gap: '5px',
  },
  // A viewer toolbar is one horizontal instrument, not nine floating buttons:
  // camera presets are a radio group, display options are checkboxes.
  // Sits top-right: the object's numbers live top-left, the controls that act
  // on the view live on the other side, and neither fights the model.
  viewBar: {
    position: 'absolute', top: '12px', right: '14px',
    display: 'flex', alignItems: 'center', gap: '9px', padding: '5px 9px',
    borderRadius: '10px', border: `1px solid ${C.line}`, background: 'rgba(11,16,21,0.86)',
    backdropFilter: 'blur(8px)', zIndex: 4, maxWidth: 'calc(100% - 210px)',
  },
  viewGroup: { display: 'flex', alignItems: 'center', gap: '2px', padding: '2px', borderRadius: '7px', background: 'transparent' },
  viewSep: { width: '1px', height: '18px', background: C.line, flex: '0 0 auto' },
  viewPick: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'transparent',
    color: C.faint, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
  },
  viewPickOn: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'rgba(255,106,26,0.16)',
    color: C.accent, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
    fontWeight: 600,
  },
  viewChip: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'transparent',
    color: C.faint, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
  },
  viewChipOn: {
    padding: '4px 9px', borderRadius: '5px', border: 'none', background: 'rgba(255,106,26,0.16)',
    color: C.accent, fontSize: '10px', fontFamily: C.mono, letterSpacing: '0.06em', cursor: 'pointer',
  },
  viewHint: { fontFamily: C.mono, fontSize: '9.5px', color: C.faint, letterSpacing: '0.04em', whiteSpace: 'nowrap' },

  // ── joint bar ───────────────────────────────────────────────────────────
  jointBar: {
    display: 'flex', gap: '18px', padding: '12px 18px 14px', borderTop: `1px solid ${C.line}`,
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`, overflowX: 'auto',
    alignItems: 'flex-end', flex: '0 0 auto',
  },
  joint: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '124px', flex: '1 1 124px', maxWidth: '196px' },
  poseHead: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: '0 0 auto',
    paddingRight: '14px', marginRight: '2px', borderRight: `1px solid ${C.line}`,
  },
  poseTab: {
    padding: '3px 8px', borderRadius: '5px', border: `1px solid ${C.line}`, background: 'transparent',
    color: C.faint, fontSize: '9px', fontFamily: C.mono, letterSpacing: '0.08em', cursor: 'pointer',
    transition: 'color 120ms ease, border-color 120ms ease',
  },
  poseTabOn: {
    padding: '3px 8px', borderRadius: '5px', border: '1px solid rgba(255,106,26,0.5)',
    background: 'rgba(255,106,26,0.14)', color: C.accent, fontSize: '9px', fontFamily: C.mono,
    letterSpacing: '0.08em', cursor: 'pointer', fontWeight: 600,
  },
  poseGrid: {
    flex: '1 1 auto', minWidth: 0, display: 'grid', gap: '6px 18px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(238px, 1fr))',
    maxHeight: '78px', overflowY: 'auto', alignContent: 'start',
  },
  poseRow: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 74px 46px', alignItems: 'center', gap: '7px', minWidth: 0 },
  poseName: {
    fontSize: '10.5px', color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', letterSpacing: '0.01em',
  },
  poseRange: { width: '100%', accentColor: C.accent, height: '14px' },
  poseFade: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: '22px', pointerEvents: 'none',
    background: `linear-gradient(to top, ${C.panel}, rgba(13,18,23,0))`,
  },
  poseVal: {
    fontFamily: C.mono, fontSize: '10px', color: C.accent, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  jointTop: { display: 'flex', justifyContent: 'space-between', fontFamily: C.mono, fontSize: '9.5px', color: C.faint },

  // ── spec rail ───────────────────────────────────────────────────────────
  tabs: {
    display: 'flex', gap: '1px', padding: '0 4px', borderBottom: `1px solid ${C.line}`,
    background: C.panel, overflowX: 'auto', scrollbarWidth: 'none',
  },
  tab: {
    padding: '11px 9px 10px', fontFamily: C.sans, fontSize: '11px', fontWeight: 600,
    letterSpacing: '0.05em', color: C.faint, cursor: 'pointer', borderBottom: '2px solid transparent',
    background: 'transparent', border: 'none',
  },
  tabOn: {
    padding: '11px 9px 10px', fontFamily: C.sans, fontSize: '10.5px', fontWeight: 700,
    letterSpacing: '0.06em', color: C.accent, cursor: 'pointer', borderBottom: `2px solid ${C.accent}`,
    background: 'transparent', borderTop: 'none', borderLeft: 'none', borderRight: 'none',
  },
  tabBody: { overflowY: 'auto', padding: '14px 16px 48px', flex: '1 1 auto', minHeight: 0 },

  table: { width: '100%', borderCollapse: 'collapse', fontFamily: C.sans, fontSize: '11.5px' },
  th: {
    textAlign: 'left', padding: '5px 6px', color: C.faint, fontWeight: 600, fontSize: '9.5px',
    letterSpacing: '0.1em', borderBottom: `1px solid ${C.line}`, fontFamily: C.mono,
  },
  td: { padding: '6px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.dim, verticalAlign: 'top' },
  tdNum: {
    padding: '6px 6px', borderBottom: `1px solid ${C.lineSoft}`, color: C.text, textAlign: 'right',
    whiteSpace: 'nowrap', fontFamily: C.mono, fontVariantNumeric: 'tabular-nums',
  },
  kv: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '7px 12px', alignItems: 'baseline' },
  kvKey: { color: C.faint, fontSize: '11.5px', fontFamily: C.sans },
  kvVal: { color: C.text, fontSize: '12px', fontFamily: C.mono, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  pre: {
    margin: 0, padding: '11px 13px', background: '#070A0D', border: `1px solid ${C.line}`,
    borderRadius: '8px', color: '#BFD3E0', fontFamily: C.mono, fontSize: '10.5px',
    lineHeight: 1.6, overflow: 'auto', maxHeight: '100%',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', tabSize: 2,
  },
  warn: {
    display: 'flex', gap: '8px', padding: '8px 10px', borderRadius: '7px',
    fontSize: '11.5px', lineHeight: 1.5, marginBottom: '6px', alignItems: 'flex-start',
  },
  step: { display: 'flex', gap: '11px', marginBottom: '13px' },
  stepNo: {
    flex: '0 0 auto', width: '22px', height: '22px', borderRadius: '50%',
    border: '1px solid rgba(255,106,26,0.45)', color: C.accent, display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontFamily: C.mono, fontSize: '10px',
  },
  footer: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px',
    borderTop: `1px solid ${C.line}`, background: C.panel,
  },
  firstRunCompact: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px', marginBottom: '8px',
    borderRadius: '8px', border: `1px solid ${C.line}`, background: C.panel2, flexWrap: 'wrap',
  },
  firstRunItem: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: C.dim },
  chipBtn: {
    display: 'inline-flex', alignItems: 'center', height: '22px', padding: '0 8px',
    borderRadius: '11px', border: `1px solid ${C.line}`, background: C.panel2,
    color: C.dim, fontSize: '10px', cursor: 'pointer', fontFamily: C.sans,
    flex: '0 0 auto', whiteSpace: 'nowrap',
  },
  shelfRow: {
    display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '7px 9px',
    border: `1px solid ${C.line}`, borderRadius: '7px', marginBottom: '5px',
    cursor: 'pointer', background: C.panel2,
  },
  menu: {
    position: 'absolute', top: '42px', right: '0', zIndex: 20, background: C.raise,
    border: `1px solid ${C.line}`, borderRadius: '10px', padding: '6px', minWidth: '210px',
    boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
  },
  menuItem: {
    display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderRadius: '7px',
    fontSize: '12px', color: C.text, cursor: 'pointer', fontFamily: C.sans,
  },

  // ── plain-words panel ───────────────────────────────────────────────────
  simpleHead: {
    fontFamily: C.sans, fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em',
    color: C.faint, textTransform: 'uppercase', marginBottom: '10px',
  },
  simpleGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '18px' },
  bigCard: {
    border: `1px solid ${C.line}`, borderRadius: '10px', padding: '10px 11px',
    background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
  },
  bigKey: { fontFamily: C.mono, fontSize: '8.5px', letterSpacing: '0.13em', color: C.faint },
  bigVal: {
    fontSize: '20px', fontWeight: 700, fontFamily: C.mono, marginTop: '5px',
    letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums',
  },
  bigSub: { fontSize: '10.5px', color: C.faint, marginTop: '3px', lineHeight: 1.35 },
  simpleLabel: {
    fontFamily: C.sans, fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em',
    color: C.faint, textTransform: 'uppercase', marginBottom: '7px',
  },
  buyRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto 66px', gap: '10px', alignItems: 'baseline',
    padding: '6px 0', borderBottom: `1px solid ${C.lineSoft}`,
  },
  buyName: { fontSize: '12px', color: C.text, lineHeight: 1.35 },
  buyQty: { fontFamily: C.mono, fontSize: '10px', color: C.faint },
  buyPrice: {
    fontFamily: C.mono, fontSize: '12px', color: C.dim, whiteSpace: 'nowrap', textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  buyMore: { fontFamily: C.sans, fontSize: '10.5px', color: C.faint, paddingTop: '6px' },

  // ── command palette ─────────────────────────────────────────────────────
  paletteBackdrop: {
    position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,7,10,0.62)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
    backdropFilter: 'blur(3px)',
  },
  palette: {
    width: 'min(620px, 92vw)', maxHeight: '62vh', display: 'flex', flexDirection: 'column',
    background: C.raise, border: `1px solid ${C.line}`, borderRadius: '14px', overflow: 'hidden',
    boxShadow: '0 40px 80px rgba(0,0,0,0.65)',
  },
  paletteInput: {
    border: 'none', borderBottom: `1px solid ${C.line}`, background: 'transparent',
    color: C.text, fontSize: '15px', padding: '15px 18px', outline: 'none', fontFamily: C.sans,
  },
  paletteList: { overflowY: 'auto', padding: '6px' },
  paletteRow: {
    display: 'grid', gridTemplateColumns: '86px 1fr auto', gap: '10px', alignItems: 'baseline',
    width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: '8px',
    background: 'transparent', border: 'none', cursor: 'pointer', color: C.text,
  },
  paletteRowOn: {
    display: 'grid', gridTemplateColumns: '86px 1fr auto', gap: '10px', alignItems: 'baseline',
    width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: '8px',
    background: 'rgba(255,106,26,0.20)', border: 'none', cursor: 'pointer', color: C.text,
  },
  paletteGroup: { fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.13em', color: C.faint },
  paletteLabel: { fontSize: '13px', color: C.text },
  paletteHint: { fontFamily: C.mono, fontSize: '10px', color: C.dim },
  paletteEmpty: { padding: '16px', fontSize: '12.5px', color: C.faint },
  paletteFoot: {
    borderTop: `1px solid ${C.line}`, padding: '8px 14px', fontFamily: C.mono,
    fontSize: '10px', color: C.dim, letterSpacing: '0.06em',
  },

  // ── first-run strip ─────────────────────────────────────────────────────
  firstRun: {
    display: 'flex', gap: '10px', alignItems: 'flex-start',
    padding: '10px 12px', marginBottom: '14px', borderRadius: '10px',
    border: `1px solid ${C.line}`, background: `linear-gradient(180deg, ${C.panel2}, ${C.panel})`,
  },
  firstRunStep: { flex: '1 1 0', minWidth: 0 },
  firstRunNum: {
    fontFamily: C.mono, fontSize: '9px', letterSpacing: '0.1em', color: C.accent, marginBottom: '3px',
  },
  firstRunText: { fontSize: '12px', color: C.dim, lineHeight: 1.4 },
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

// "iot" is our word, not the user's. Show the machine name they picked.
function friendlyArchetype(id) {
  const p = PRESETS.find((x) => x.brief.archetype === id)
  if (p) return p.label.toLowerCase().replace(/ & /g, ' and ')
  const a = (typeof ARCHETYPES !== 'undefined' ? ARCHETYPES : []).find((x) => x[0] === id)
  return a ? a[1].toLowerCase() : id
}

function relTime(ts) {
  const secs = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'build'
}
