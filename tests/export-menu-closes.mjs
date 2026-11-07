import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const brief = encodeURIComponent(JSON.stringify({ archetype: 'arm', mission: 'x', payloadKg: 0.8, reachMm: 420, dof: 5 }))
await p.goto('http://127.0.0.1:18766/preview.html?lastBrief=' + brief)
await p.waitForTimeout(2400)
const openState = () => p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /Export ▾/.test(b.textContent || ''))
  return btn ? btn.getAttribute('aria-expanded') : null
})
await p.locator('button', { hasText: /Export ▾/ }).first().click()
await p.waitForTimeout(400)
const opened = await openState()
// click somewhere neutral in the viewport
await p.mouse.click(720, 500)
await p.waitForTimeout(500)
const afterOutside = await openState()
// and check Escape too
await p.locator('button', { hasText: /Export ▾/ }).first().click()
await p.waitForTimeout(300)
await p.keyboard.press('Escape')
await p.waitForTimeout(400)
const afterEsc = await openState()
console.log(JSON.stringify({ opened, afterOutside, afterEsc }))
await b.close()
