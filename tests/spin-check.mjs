import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:18756/preview.html')
await p.waitForTimeout(1500)
await p.locator('button[aria-label="Build a FPV drone"]').first().click({ timeout: 8000 }).catch(() => {})
await p.waitForTimeout(3000)
const box = await p.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  const r = c.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})
await p.screenshot({ path: '/tmp/spin-a.png', clip: box })
await p.waitForTimeout(420)
await p.screenshot({ path: '/tmp/spin-b.png', clip: box })
console.log(JSON.stringify({ errs }))
await b.close()
