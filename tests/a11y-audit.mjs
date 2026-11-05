// Keyboard and screen-reader audit: what a person who cannot use a mouse gets.
// Records the focus order, whether each stop is visibly focused, whether it has
// an accessible name, and the contrast of the text colours actually used.
import { chromium } from 'playwright'

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(2400)

const describe = () => p.evaluate(() => {
  const el = document.activeElement
  if (!el || el === document.body) return { tag: 'BODY', name: '', visible: false }
  const s = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'
  const name = el.getAttribute('aria-label') || (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 32) || el.getAttribute('placeholder') || el.tagName.toLowerCase()
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    name,
    visible: ring,
    size: [Math.round(rect.width), Math.round(rect.height)],
    offscreen: rect.right < 0 || rect.bottom < 0,
  }
})

const stops = []
for (let i = 0; i < 40; i += 1) {
  await p.keyboard.press('Tab')
  await p.waitForTimeout(60)
  const d = await describe()
  if (d.tag === 'BODY') { stops.push({ i, ...d, wrapped: true }); break }
  stops.push({ i, ...d })
}

// the canvas: is it reachable, and does it say what it is?
const canvasInfo = await p.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]
  if (!c) return null
  return {
    tabIndex: c.getAttribute('tabindex'),
    role: c.getAttribute('role'),
    label: c.getAttribute('aria-label'),
    title: c.getAttribute('title'),
    hasFallbackText: c.textContent.trim().length > 0,
  }
})

// contrast of the two quiet greys against the panel background
const contrast = await p.evaluate(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
  }
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (l1 + 0.05) / (l2 + 0.05)
  }
  const body = getComputedStyle(document.body)
  const bg = parse(body.backgroundColor)
  const sample = (sel) => {
    const el = document.querySelector(sel)
    return el ? parse(getComputedStyle(el).color) : null
  }
  const out = {}
  for (const [name, sel] of [['dim', '[data-rf="hud"]'], ['title', '[data-rf="viewtitle"]']]) {
    const c = sample(sel)
    if (c) out[name] = +ratio(c, bg).toFixed(2)
  }
  return out
})

const problems = []
if (canvasInfo && !canvasInfo.tabIndex && !canvasInfo.role && !canvasInfo.label) {
  problems.push('the 3D canvas is unreachable and unnamed to a keyboard/screen-reader user')
}
const unnamed = stops.filter((s) => !s.wrapped && !s.name)
if (unnamed.length) problems.push(`${unnamed.length} focus stop(s) without an accessible name`)
const unringed = stops.filter((s) => !s.wrapped && !s.visible && s.tag !== 'BODY')
if (unringed.length) problems.push(`${unringed.length} focus stop(s) with no visible focus ring — e.g. ${unringed[0].tag}:${unringed[0].name}`)
for (const [k, v] of Object.entries(contrast)) {
  if (v < 4.5) problems.push(`contrast ${k} = ${v}:1, under 4.5:1`)
}

console.log(JSON.stringify({
  stops: stops.map((s) => `${s.tag}${s.type ? ':' + s.type : ''} "${s.name}"${s.visible ? '' : ' [NO RING]'}`),
  wrapped: Boolean(stops[stops.length - 1].wrapped),
  canvasInfo,
  contrast,
  problems,
  errs: errs.slice(0, 2),
}, null, 1))

if (problems.length) {
  console.error('A11Y FAILED:\n' + problems.join('\n'))
  process.exitCode = 1
}
await b.close()
