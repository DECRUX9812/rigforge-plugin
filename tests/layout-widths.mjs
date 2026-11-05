// Does the studio survive a small screen? A STEM kid on a tablet is a stated
// user, so measure real layout at four widths instead of assuming the CSS is fine.
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const rows = []
for (const [w, h, label] of [[1440, 900, 'laptop'], [1180, 820, 'small laptop'], [900, 780, 'tablet'], [640, 800, 'phone-ish']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto('http://127.0.0.1:18734/preview.html')
  await p.waitForTimeout(2200)
  const m = await p.evaluate(() => {
    const de = document.documentElement
    const view = document.querySelector('[data-rf="view"]')
    const rail = document.querySelector('[data-rf="rail"]')
    const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    // anything sticking out sideways is a layout bug at this width
    const overflow = [...document.querySelectorAll('div,button,span')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1) })
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}:${(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24)}@${Math.round(el.getBoundingClientRect().right)}`)
    return {
      docW: de.clientWidth,
      scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
      view: rect(view),
      railY: rail ? Math.round(rail.getBoundingClientRect().y) : 0,
      canvas: canvas ? { css: rect(canvas), px: [canvas.width, canvas.height] } : null,
      overflow,
    }
  })
  rows.push({ label, ...m, errs: errs.slice(0, 2) })
  await p.screenshot({ path: `tests/tmp/layout-${w}.png` })
  await p.close()
}
// A studio whose machine is below the fold, or that scrolls sideways, is broken
// no matter how good the render is.
const problems = []
for (const r of rows) {
  if (r.scrollW > r.docW) problems.push(`${r.label}: page scrolls sideways (${r.scrollW} > ${r.docW})`)
  if (r.overflow.length) problems.push(`${r.label}: ${r.overflow.length} element(s) past the right edge — ${r.overflow[0]}`)
  if (!r.canvas || r.canvas.css.h < 260) problems.push(`${r.label}: canvas only ${r.canvas ? r.canvas.css.h : 0}px tall`)
  const railY = r.railY || 0
  if (railY && r.view.y > railY) problems.push(`${r.label}: the machine sits below the chooser (view y ${r.view.y} > rail y ${railY})`)
  if (r.errs.length) problems.push(`${r.label}: ${r.errs[0]}`)
}
console.log(JSON.stringify({ rows, problems }, null, 0))
if (problems.length) {
  console.error('LAYOUT FAILED:\n' + problems.join('\n'))
  process.exitCode = 1
}
await b.close()
