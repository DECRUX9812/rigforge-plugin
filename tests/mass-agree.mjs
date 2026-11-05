// The header MASS and the mass printed inside the stability verdict must agree.
//   node tests/mass-agree.mjs   (needs preview served on 127.0.0.1:18734)
import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(1800)
const out = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, ' ')
  const header = text.match(/MASS\s+([\d.,]+)\s*g/i)
  const verdict = text.match(/support polygon\s*·\s*([\d.,]+)\s*g/i)
  return { header: header && header[1], verdict: verdict && verdict[1], snippet: text.match(/.{0,60}support polygon.{0,40}/i)?.[0] || null }
})
const problems = [...errors]
if (!out.header) problems.push('no MASS figure in the header')
if (!out.verdict) problems.push('no mass inside the stability verdict')
if (out.header && out.verdict && Math.abs(Number(out.header.replace(/,/g, '')) - Number(out.verdict.replace(/,/g, ''))) > 1) {
  problems.push(`header ${out.header}g vs verdict ${out.verdict}g`)
}
console.log(JSON.stringify({ ok: problems.length === 0, ...out, problems }, null, 1))
await browser.close()
