// Every joint slider must be fully visible or fully scrolled — never halved.
// A rack with a fixed pixel height cuts whatever lands on the boundary, and a
// joint you cannot reach is a joint the machine does not have.
//   node tests/pose-reach.mjs   (needs preview served on 127.0.0.1:18734)
import { chromium } from 'playwright'

const widths = [1440, 1180, 900, 640]
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
  const r = await page.evaluate(() => {
    const g = document.querySelector('[data-rf="posegrid"]')
    if (!g) return { missing: true }
    const box = g.getBoundingClientRect()
    const labels = [...g.querySelectorAll('label')]
    // a label that starts above the window and ends below it is a half row
    const straddling = labels.filter((el) => {
      const b = el.getBoundingClientRect()
      return b.top < box.bottom - 1 && b.bottom > box.bottom + 1
    }).length
    return {
      joints: labels.length,
      clientH: Math.round(g.clientHeight),
      scrollH: Math.round(g.scrollHeight),
      straddling,
    }
  })
  rows.push({ width, ...r, errors })
  if (r.missing) problems.push(`${width}: no pose rack on the page`)
  else {
    if (!r.joints) problems.push(`${width}: the pose rack is empty`)
    if (r.straddling) problems.push(`${width}: ${r.straddling} joint row(s) cut in half by the rack height`)
  }
  if (errors.length) problems.push(`${width}: ${errors.join(' / ')}`)
  await page.close()
}

await browser.close()
console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 1))
