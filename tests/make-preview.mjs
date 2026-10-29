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
}
`)

const files = readdirSync(join(here, '../src')).filter((f) => f.endsWith('.js')).sort()
let code = files.map((f) => readFileSync(join(here, '../src', f), 'utf8')).join('\n\n')
code = code.replace(/from '@hermes\/plugin-sdk'/g, `from './sdk-stub.mjs'`)
  .concat(`\nexport { Studio }\n`)
writeFileSync(join(tmp, 'preview.mjs'), code)

writeFileSync(join(tmp, 'preview-entry.mjs'), `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Studio } from './preview.mjs'

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
<style>
  html,body{margin:0;height:100%;background:#0A0D10;overflow:hidden}
  #root{height:100%}
  *{box-sizing:border-box}
</style></head>
<body><div id="root"></div>
<script type="module" src="./preview.bundle.js"></script>
</body></html>`)

console.log('preview →', join(tmp, 'preview.html'))
