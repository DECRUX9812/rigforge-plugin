// A brief that names no machine must say so, not quietly build the nearest one.
//   node tests/brief-honesty.mjs   (needs preview served on 127.0.0.1:18734)
import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(1500)

const canvasTris = async () => page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]
  return c ? c.width * c.height : 0
})

const cases = [
  { brief: 'a friendly hat for my cat', expectRefusal: true },
  { brief: 'a 5 dof arm with 450mm reach for a desk', expectRefusal: false },
]
const rows = []
for (const c of cases) {
  const box = page.locator('textarea').first()
  await box.fill(c.brief)
  const go = page.locator('button', { hasText: /BUILD|MAKE IT/i }).first()
  await go.click().catch(() => {})
  await page.waitForTimeout(1800)
  const text = (await page.locator('[data-rf="root"]').innerText()).replace(/\s+/g, ' ')
  const refused = /did not name a machine/i.test(text)
  rows.push({ brief: c.brief, refused, slice: text.match(/[^.]*did not name a machine[^.]*/i)?.[0]?.slice(0, 120) || text.slice(0, 120) })
}
const problems = rows
  .filter((r, i) => r.refused !== cases[i].expectRefusal)
  .map((r, i) => `${r.brief}: refused=${r.refused}, expected ${cases[i].expectRefusal}`)
problems.push(...errors)
console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 1))
await browser.close()
