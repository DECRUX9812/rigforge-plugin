// The viewport toolbar must fit its own box: a chip that overflows is a control
// the user cannot reach.
//   node tests/toolbar-fit.mjs   (needs preview served on 127.0.0.1:18734)
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
  const r = await page.evaluate(() => {
    const bar = document.querySelector('[role="toolbar"]')
    if (!bar) return { missing: true }
    const bb = bar.getBoundingClientRect()
    const cut = [...bar.children]
      .map((k) => {
        const b = k.getBoundingClientRect()
        return { text: (k.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20), right: Math.round(b.right) }
      })
      .filter((k) => k.right > bb.right + 1)
    return {
      chips: bar.children.length,
      clientW: Math.round(bar.clientWidth),
      scrollW: Math.round(bar.scrollWidth),
      barRight: Math.round(bb.right),
      cut,
    }
  })
  rows.push({ width, ...r, errors })
  if (r.missing) problems.push(`${width}: no viewport toolbar`)
  else {
    if (r.cut.length) problems.push(`${width}: ${r.cut.length} chip(s) past the bar edge — ${r.cut.map((c) => c.text).join(', ')}`)
    if (r.scrollW > r.clientW + 1) problems.push(`${width}: toolbar content ${r.scrollW}px in a ${r.clientW}px box`)
  }
  if (errors.length) problems.push(`${width}: ${errors.join(' / ')}`)
  await page.close()
}

await browser.close()
console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 1))
