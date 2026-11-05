// Control clipping at the widths between the four the other gates use.
//   node tests/control-clip-mid.mjs
import { chromium } from 'playwright'

const widths = [1440, 1280, 1024, 820, 768, 700]
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const rows = []
const problems = []

for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:18734/preview.html')
  await page.waitForTimeout(1200)
  const bad = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button, input, select, textarea, [role="button"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none') continue
      let cutX = 0
      let cutY = 0
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p)
        if (/auto|scroll/.test(ps.overflowX + ps.overflowY)) break
        if (!/hidden|clip/.test(ps.overflowX + ps.overflowY)) continue
        const b = p.getBoundingClientRect()
        if (r.right > b.right + 1) cutX = Math.max(cutX, r.right - b.right)
        if (r.left < b.left - 1) cutX = Math.max(cutX, b.left - r.left)
        if (r.bottom > b.bottom + 1) cutY = Math.max(cutY, r.bottom - b.bottom)
      }
      if (cutX > 2 || cutY > 2) out.push({ label: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 22), cut: Math.round(Math.max(cutX, cutY)) })
    }
    return out
  })
  rows.push({ width, clipped: bad.length, worst: bad.slice(0, 4) })
  for (const b of bad) problems.push(`${width}px: ${b.cut}px — "${b.label}"`)
  if (errors.length) problems.push(`${width}: ${errors.join(' / ')}`)
  await page.close()
}
await browser.close()
console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 1))
