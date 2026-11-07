import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:18760/preview.html')
await p.waitForTimeout(1500)
await p.locator('button[aria-label="Build a Pick & place arm"]').first().click({ timeout: 8000 }).catch(() => {})
await p.waitForTimeout(3500)
// REACH overlay is what draws the workspace map
await p.locator('button', { hasText: /^REACH$/ }).first().click({ timeout: 6000 }).catch(() => {})
await p.waitForTimeout(3000)
const txt = await p.evaluate(() => {
  const el = [...document.querySelectorAll('span')].find((s) => /lift@/.test(s.textContent || ''))
  return el ? { text: el.textContent, title: el.getAttribute('title') } : null
})
console.log(JSON.stringify({ errs, txt }))
await p.screenshot({ path: '/tmp/ws-chip.png' })
await b.close()
