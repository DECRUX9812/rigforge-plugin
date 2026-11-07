// Demo v3 — same take as v2, plus the audit beat: the numbers a judge checks.
import { chromium } from 'playwright'
import { rmSync, mkdirSync } from 'node:fs'

const OUT = '/tmp/demo3-vid'
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
const t0 = Date.now()
const marks = {}
const mark = (k) => { marks[k] = (Date.now() - t0) / 1000 }
const wait = (ms) => p.waitForTimeout(ms)

await p.goto('http://127.0.0.1:18759/preview.html')
await wait(2400)
mark('title')

const input = p.locator('textarea[aria-label="Describe the machine to build"]').first()
await input.click()
await input.type('a 5 inch drone that follows me on a bike', { delay: 40 })
await wait(400)
await p.locator('button', { hasText: /^BUILD$/ }).first().click()
await wait(3400)
mark('built')

const box = await p.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  const r = c.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
mark('orbit')
await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5)
await p.mouse.down()
for (let i = 1; i <= 28; i += 1) { await p.mouse.move(box.x + box.w * 0.5 + i * 8, box.y + box.h * 0.5 + Math.sin(i / 5) * 10); await wait(38) }
await p.mouse.up()
await wait(600)

mark('fly')
await p.locator('button', { hasText: /^FLY$/ }).first().click()
await wait(11000)
mark('flew')

const pt = await p.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  const r = cv.getBoundingClientRect()
  for (let gy = 0.25; gy <= 0.8; gy += 0.05) for (let gx = 0.25; gx <= 0.8; gx += 0.05) {
    const h = globalThis.__rfPick && globalThis.__rfPick(gx * r.width, gy * r.height)
    if (h && h.grabbable) return { x: r.x + gx * r.width, y: r.y + gy * r.height }
  }
  return null
})
mark('grab')
if (pt) {
  await p.mouse.move(pt.x, pt.y); await p.mouse.down()
  for (let i = 1; i <= 16; i += 1) { await p.mouse.move(pt.x + i * 6, pt.y + i * 3); await wait(36) }
  await p.mouse.up()
  await wait(1400)
}
mark('grabbed')

// ── the credibility beat, while the simple card is still on screen ──────────
mark('audit')
await p.locator('button[aria-label="Show the working behind these numbers"]').first().click({ timeout: 8000 })
await wait(2000)
await p.mouse.move(900, 600)
await p.mouse.wheel(0, 300)
await wait(1800)
await p.mouse.wheel(0, 300)
await wait(2200)
mark('worked')
await p.keyboard.press('Escape')
await wait(700)

mark('test')
await p.locator('button', { hasText: /^Engineer$/ }).first().click({ timeout: 8000 }).catch(() => {})
await wait(900)
await p.locator('[data-tab="test"]').click({ timeout: 5000 }).catch(() => {})
await wait(2400)
mark('bom')
await p.locator('[data-tab="parts"]').click({ timeout: 5000 }).catch(() => {})
await wait(2200)
await p.locator('button', { hasText: /Export/ }).first().click().catch(() => {})
await wait(2400)
mark('export')
await p.keyboard.press('Escape')
await wait(1200)
mark('end')

const videoPath = await p.video().path()
await ctx.close(); await b.close()
console.log(JSON.stringify({ errs, marks, videoPath }))
