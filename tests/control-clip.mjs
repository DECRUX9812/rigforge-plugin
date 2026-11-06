// Any control clipped by an ancestor is a control someone cannot click.
// The toolbar bug hid inside an overlay that clips its own children, so this
// walks the tree and intersects every interactive element with the clipping
// boxes above it.
//   node tests/control-clip.mjs   (needs preview served on 127.0.0.1:18734)
import { chromium } from 'playwright'

const widths = [1600, 1180, 900, 640]
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const rows = []
const problems = []

for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 980 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:18734/preview.html')
  await page.waitForTimeout(1400)
  const bad = await page.evaluate(() => {
    const clipBox = (el) => {
      const s = getComputedStyle(el)
      // only non-scrollable clipping counts: content below the fold of a
      // scrollable panel is reachable, content clipped by overflow:hidden is not
      const clips = /hidden|clip/.test(s.overflowX + s.overflowY)
      if (!clips) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    }
    const out = []
    for (const el of document.querySelectorAll('button, input, select, textarea, [role="button"], a')) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none') continue
      // walk up until we meet a scrollable ancestor: anything between here and
      // there can be scrolled into view, so only a non-scrollable clipper above
      // that point can actually hide a control
      let cutX = 0
      let cutY = 0
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p)
        if (/auto|scroll/.test(ps.overflowX + ps.overflowY)) break
        const box = clipBox(p)
        if (!box) continue
        if (r.right > box.right + 1) cutX = Math.max(cutX, r.right - box.right)
        if (r.left < box.left - 1) cutX = Math.max(cutX, box.left - r.left)
        if (r.bottom > box.bottom + 1) cutY = Math.max(cutY, r.bottom - box.bottom)
        if (r.top < box.top - 1) cutY = Math.max(cutY, box.top - r.top)
      }
      if (cutX > 2 || cutY > 2) {
        out.push({
          label: (el.innerText || el.getAttribute('aria-label') || el.value || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 26),
          cutBy: Math.round(Math.max(cutX, cutY)),
          axis: cutX > 2 ? 'x' : 'y',
        })
      }
    }
    return out
  })
  rows.push({ width, clipped: bad.length, worst: bad.slice(0, 5) })
  for (const b of bad) problems.push(`${width}px: ${b.axis} ${b.cutBy}px — "${b.label}"`)
  if (errors.length) problems.push(`${width}: ${errors.join(' / ')}`)
  await page.close()
}

await browser.close()
console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 1))
