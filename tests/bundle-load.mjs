// The bundle as the host sees it.
//
// Every other test runs the *sources* in a vm. The thing that actually ships is
// desktop/plugin.js — one ESM file whose imports of @hermes/plugin-sdk and react
// are resolved by the app. This loads the real bundle with those three modules
// stubbed, calls register(), and checks the app would get a page, a nav entry, a
// palette entry, the directive and the tools. A bundle that cannot load is a
// plugin that does nothing, however green the rest of the suite is.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(here, 'tmp', 'bundle-load')
mkdirSync(outDir, { recursive: true })

const SDK_STUB = `
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar'
export const TRANSCRIPT_DIRECTIVE_AREA = 'directive'
export const host = globalThis.__hostStub
`

const REACT_STUB = `
const noop = () => {}
export const useEffect = (fn) => { if (typeof fn === 'function') fn() }
export const useLayoutEffect = useEffect
export const useState = (init) => [typeof init === 'function' ? init() : init, noop]
export const useMemo = (fn) => fn()
export const useCallback = (fn) => fn
export const useRef = (v) => ({ current: v })
export const memo = (f) => f
export default { useEffect, useState, useMemo, useCallback }
`

const JSX_STUB = `
const make = (type, props, key) => ({ type, props: props || {}, key, children: (props && props.children) || null })
export const jsx = (type, props, key) => make(type, props, key)
export const jsxs = (type, props, key) => make(type, props, key)
export const Fragment = 'fragment'
`

const stubPlugin = {
  name: 'host-stubs',
  setup(b) {
    b.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'stub' }))
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }))
    b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      const src = args.path === 'sdk' ? SDK_STUB : args.path === 'react' ? REACT_STUB : JSX_STUB
      return { contents: src, loader: 'js' }
    })
  },
}

// optional first argument: load a bundle from somewhere else (a worktree, a
// released artefact) instead of the working tree's build
const bundleArg = process.argv[2]
const entry = bundleArg || join(root, 'desktop', 'plugin.js')
const bundlePath = join(outDir, 'plugin.cjs')
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundlePath,
  plugins: [stubPlugin],
  logLevel: 'silent',
})

// the host surface the plugin is allowed to touch
const registered = { pages: [], nav: [], palette: [], directives: [], tools: [], settings: [], logs: [] }
globalThis.__hostStub = {
  navigate: (route) => registered.logs.push('navigate:' + route),
  notify: (n) => registered.logs.push('notify:' + (n && n.message)),
  storage: {
    get: (_k, d) => d,
    set: () => {},
    delete: () => {},
  },
  openExternal: () => {},
  registerTool: (t) => registered.tools.push(t),
}

const require = createRequire(import.meta.url)
delete require.cache[bundlePath]
const mod = require(bundlePath)
const plugin = mod.default || mod

// The host's real surface, and only that: register({ id, area, data, render }).
// The previous stub invented `contribution(area, payload)` — the API the plugin
// was actually calling — so the suite stayed green while the app threw
// "ctx.contribution is not a function" and dropped the plugin on load. A stub
// that agrees with a wrong call site is worse than no stub.
const AREAS = {
  routes: 'pages', sidebar: 'nav', palette: 'palette', directive: 'directives', settings: 'settings', statusbar: 'logs',
}
const ctx = {
  ...globalThis.__hostStub,
  register: (c) => {
    const key = AREAS[c.area]
    if (!key) { registered.logs.push('register:' + String(c.area)); return }
    if (key === 'logs') { registered.logs.push('statusbar:' + c.id); return }
    registered[key].push({ id: c.id, area: c.area, data: c.data, render: c.render })
    if (c.area === 'routes' && !c.render) registered.logs.push('page without render: ' + c.id)
  },
  registerTool: (t) => registered.tools.push(t),
  registerSettingsPage: (p) => registered.settings.push(p),
  log: (...a) => registered.logs.push(a.join(' ')),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

// The host has two generations. This bundle must survive either: a build that
// only has contribution(area, payload) is still out there, and calling the wrong
// one throws inside register() and drops the whole plugin.
const legacy = { pages: 0, nav: 0, palette: 0, directives: 0 }
const legacyCtx = {
  ...globalThis.__hostStub,
  register: undefined,
  contribution: (area, payload) => {
    if (area === 'routes') legacy.pages += 1
    else if (area === 'sidebar') legacy.nav += 1
    else if (area === 'palette') legacy.palette += 1
    else if (area === 'directive') legacy.directives += 1
  },
}

const problems = []
if (!plugin || typeof plugin.register !== 'function') problems.push('the bundle exports no register()')
else {
  plugin.register(ctx)
  // and again against a legacy host: same bundle, older API
  try {
    plugin.register(legacyCtx)
  } catch (e) {
    problems.push('legacy contribution() host threw: ' + e.message)
  }
  if (legacy.pages < 1 || legacy.nav < 1 || legacy.palette < 1 || legacy.directives < 1) {
    problems.push(`legacy host registered ${JSON.stringify(legacy)} — shim does not cover it`)
  }
}

const want = (list, n, label) => {
  if (list.length < n) problems.push(`${label}: expected at least ${n}, got ${list.length}`)
}
want(registered.pages, 1, 'page')
want(registered.nav, 1, 'nav entry')
want(registered.directives, 1, 'transcript directive')

// the page must render without a host: jsx is stubbed, hooks are inert
let rendered = null
const page = registered.pages[0]
if (page && typeof page.render === 'function') {
  try {
    rendered = page.render({})
  } catch (e) {
    problems.push('page render threw: ' + e.message)
  }
} else {
  problems.push('page has no render()')
}

// the directive card is the agent door; it must render from attrs alone
let directiveRendered = null
const dir = registered.directives[0]
if (dir && dir.data && typeof dir.data.render === 'function') {
  try {
    directiveRendered = dir.data.render({ attrs: { brief: '{"archetype":"rover","mission":"moon rover","payloadKg":4}' } })
  } catch (e) {
    problems.push('directive render threw: ' + e.message)
  }
} else {
  problems.push('directive has no render()')
}

// the shipped file must not reach for anything the host does not provide
const src = readFileSync(entry, 'utf8')
const imports = [...src.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
for (const i of imports) if (!allowed.has(i)) problems.push('forbidden import: ' + i)
for (const banned of ['node:fs', 'node:path', 'playwright', 'require(']) {
  if (src.includes(banned)) problems.push('bundle references ' + banned)
}

console.log(JSON.stringify({
  bytes: src.length,
  imports,
  registered: {
    pages: registered.pages.length,
    nav: registered.nav.length,
    palette: registered.palette.length,
    directives: registered.directives.length,
    settings: registered.settings.length,
    tools: registered.tools.length,
  },
  pageRenders: Boolean(rendered),
  directiveRenders: Boolean(directiveRendered),
  problems,
}))

if (problems.length) {
  console.error('BUNDLE LOAD FAILED:\n' + problems.join('\n'))
  process.exitCode = 1
}
