// Build a browser preview of the plugin page, without the app.
// Proves the components compile against real React and gives a renderable page
// for screenshots. The SDK is stubbed (no app), everything else is real.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, 'tmp')
mkdirSync(tmp, { recursive: true })

writeFileSync(join(tmp, 'sdk-stub.mjs'), `
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
export const host = {
  notify: (n) => console.log('[notify]', n.message),
  navigate: () => {},
  request: async () => ({}),
  composer: { setDraft: async () => true, focus: () => {} },
  // simulated plugin backend: the real page talks to /api/plugins/rigforge
  rest: async (path) => (String(path).indexOf('/queue') === 0 ? { requests: [] } : { ok: true }),
}
`)

const files = readdirSync(join(here, '../src')).filter((f) => f.endsWith('.js')).sort()
let code = files.map((f) => readFileSync(join(here, '../src', f), 'utf8')).join('\n\n')
code = code.replace(/from '@hermes\/plugin-sdk'/g, `from './sdk-stub.mjs'`)
  .concat(`\nexport { Studio, plugin }\n`)
writeFileSync(join(tmp, 'preview.mjs'), code)

writeFileSync(join(tmp, 'preview-entry.mjs'), `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Studio, plugin } from './preview.mjs'

// Register for real so the page's ctx door (storage + rest) is wired exactly as
// the app wires it — otherwise the AGENT chip reads OFFLINE and the harness lies.
const store = new Map()
plugin.register({
  // The app's real surface is register({id, area, …}); the harness used to stub
  // only contribution(), so a bundle that had moved to register() threw here and
  // the preview went blank while the app was fine. Both are stubbed now: the
  // harness must accept what the app accepts.
  register: () => undefined,
  contribution: () => () => {},
  registerMany: () => () => {},
  registerSettingsPage: () => () => {},
  onDispose: () => {},
  onEvent: () => () => {},
  setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
  setInterval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id) },
  addEventListener: () => () => {},
  storage: {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  },
  rest: async (path) => (String(path).indexOf('/queue') === 0 ? { requests: [] } : { ok: true }),
  os: {},
  i18n: {},
})

// Test hooks: seed the studio's storage from the query string so a scenario
// like "an agent handed back a brief" can be reproduced exactly.
const q = new URLSearchParams(location.search)
for (const key of ['lastBrief', 'pendingBrief', 'seenFirstRun']) {
  const raw = q.get(key)
  if (raw) {
    try { store.set(key, JSON.parse(raw)) } catch { store.set(key, raw === 'true' ? true : raw) }
  }
}

const el = document.getElementById('root')
createRoot(el).render(React.createElement(Studio))
`)

await build({
  entryPoints: [join(tmp, 'preview-entry.mjs')],
  bundle: true,
  format: 'esm',
  outfile: join(tmp, 'preview.bundle.js'),
  jsx: 'automatic',
  loader: { '.mjs': 'js' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

writeFileSync(join(tmp, 'preview.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Rigforge preview</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13' fill='%23FF6A1A'%3E%E2%8C%AC%3C/text%3E%3C/svg%3E">
<style>
  html,body{margin:0;height:100%;background:#0A0D10;overflow:hidden}
  #root{height:100%}
  *{box-sizing:border-box}
</style></head>
<body><div id="root"></div>
<script type="module" src="./preview.bundle.js"></script>
</body></html>`)

console.log('preview →', join(tmp, 'preview.html'))
