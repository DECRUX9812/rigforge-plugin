import { chromium } from 'playwright'
import { rmSync, mkdirSync } from 'node:fs'
const OUT = '/tmp/spin-vid'
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:18756/preview.html')
await p.waitForTimeout(1400)
await p.locator('button[aria-label="Build a FPV drone"]').first().click({ timeout: 8000 }).catch(() => {})
await p.waitForTimeout(3500)
const box = await p.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
// slow orbit so the spinning props read against a moving background
await p.mouse.move(box.x, box.y)
await p.mouse.down()
for (let i = 1; i <= 40; i += 1) { await p.mouse.move(box.x + i * 4, box.y + Math.sin(i / 6) * 8); await p.waitForTimeout(30) }
await p.mouse.up()
await p.waitForTimeout(1500)
const v = await p.video().path()
await ctx.close(); await b.close()
console.log(v)
