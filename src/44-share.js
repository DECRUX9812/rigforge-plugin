// ── sharing: a design is a brief, so a build code is just the brief ─────────
// Every design in Rigforge is deterministic from its brief. That makes sharing
// trivial and honest: encode the brief, not a rendered state, so the person who
// opens it gets the same machine — with their own live prices, not a snapshot.

const RF_CODE = 'RF1'
const BRIEF_KEYS = ['archetype', 'mission', 'payloadKg', 'reachMm', 'battery', 'mcu', 'material', 'energy', 'drive', 'gripper', 'spanX', 'scale', 'bedMm']

function b64uEncode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64uDecode(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function encodeBuild(brief) {
  // A whitelist here was lossy: a key the list forgot came back defaulted and
  // the recipient got a different machine. Encode everything that is in the
  // brief; it is a few hundred bytes either way.
  const slim = {}
  for (const k of Object.keys(brief || {})) {
    const v = brief[k]
    if (typeof v === 'function' || v === undefined || v === null) continue
    if (v === '') continue
    slim[k] = v
  }
  return `${RF_CODE}-${b64uEncode(JSON.stringify(slim))}`
}

/** Returns a brief, or throws with a message a person can act on. */
function decodeBuild(code) {
  const raw = String(code || '').trim().replace(/\s+/g, '')
  if (!raw) throw new Error('Paste a build code first — they start with RF1-')
  const body = raw.startsWith(RF_CODE + '-') ? raw.slice(RF_CODE.length + 1) : (/^RF1/.test(raw) ? raw.slice(3) : raw)
  let obj
  try {
    obj = JSON.parse(b64uDecode(body))
  } catch {
    throw new Error('That is not a valid build code — probably a partial paste')
  }
  if (!obj || typeof obj !== 'object' || !obj.archetype) {
    throw new Error('The code decoded but carries no machine')
  }
  const known = PRESETS.map((p) => p.brief.archetype).concat(ARCHETYPES.map((a) => a[0]))
  if (!known.includes(obj.archetype)) {
    throw new Error(`That code wants a "${obj.archetype}" machine, which this version cannot build`)
  }
  return obj
}
