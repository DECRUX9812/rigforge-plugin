import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
const brief = encodeURIComponent(JSON.stringify({ archetype: 'arm', mission: 'sort parts', payloadKg: 0.8, reachMm: 420, dof: 5 }))
await p.goto('http://127.0.0.1:18766/preview.html?lastBrief=' + brief)
await p.waitForTimeout(2600)
const snap = async () => p.evaluate(() => ({
  fixes: [...document.querySelectorAll('button[aria-label^="Apply fix"]')].map(b => b.getAttribute('aria-label')),
  warns: (document.body.innerText.match(/HEADS UP[\s\S]{0,400}/) || [''])[0].match(/brim|current limit/gi) || [],
  checks: (document.body.innerText.match(/CHECKS[^A-Z]{0,20}/) || [''])[0].trim(),
}))
const a = await snap()
if (a.fixes.length) { await p.locator('button[aria-label^="Apply fix"]').first().click(); await p.waitForTimeout(1400) }
const c = await snap()
await p.screenshot({ path: '/tmp/live-simple.png' })
console.log(JSON.stringify({ errs, before: a, after: c }, null, 1))
await b.close()
