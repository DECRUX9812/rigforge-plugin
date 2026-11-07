// Demo v2 — one continuous take, with the beat marks exported so the captions
// can be cut to what actually happened instead of to what I hoped would happen.
import { chromium } from 'playwright'
import { rmSync, mkdirSync } from 'node:fs'

const OUT = '/tmp/demo2-vid'
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5,
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
const t0 = Date.now()
const marks = {}
const mark = (k) => { marks[k] = (Date.now() - t0) / 1000 }
const wait = (ms) => p.waitForTimeout(ms)

await p.goto('http://127.0.0.1:18757/preview.html')
await wait(2400)
mark('title')

// ── the sentence ───────────────────────────────────────────────────────────
const input = p.locator('textarea[aria-label="Describe the machine to build"]').first()
await input.click()
mark('type')
await input.type('a drone that follows me on a bike', { delay: 42 })
await wait(500)
await p.locator('button', { hasText: /^BUILD$/ }).first().click()
await wait(300)
mark('build')
await wait(3200)
mark('built')

// ── orbit: the props are spinning under this ───────────────────────────────
const box = await p.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  const r = c.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
mark('orbit')
await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5)
await p.mouse.down()
for (let i = 1; i <= 30; i += 1) { await p.mouse.move(box.x + box.w * 0.5 + i * 8, box.y + box.h * 0.5 + Math.sin(i / 5) * 10); await wait(38) }
await p.mouse.up()
await wait(700)

// ── fly-through ────────────────────────────────────────────────────────────
mark('fly')
await p.locator('button', { hasText: /^FLY$/ }).first().click()
await wait(11000)
mark('flew')

// ── grab a part ────────────────────────────────────────────────────────────
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
  for (let i = 1; i <= 18; i += 1) { await p.mouse.move(pt.x + i * 6, pt.y + i * 3); await wait(36) }
  await p.mouse.up()
  await wait(1500)
}
mark('grabbed')

// ── the numbers ────────────────────────────────────────────────────────────
await p.locator('button', { hasText: /^Engineer$/ }).first().click().catch(() => {})
await wait(900)
mark('engineer')
await p.locator('[data-tab="test"]').click().catch(() => {})
await wait(2600)
mark('test')
await p.locator('[data-tab="parts"]').click().catch(() => {})
await wait(2600)
mark('bom')
await p.locator('button', { hasText: /Export/ }).first().click().catch(() => {})
await wait(2600)
mark('export')
await p.keyboard.press('Escape')
await wait(1200)
mark('end')

const videoPath = await p.video().path()
await ctx.close(); await b.close()
console.log(JSON.stringify({ errs, marks, videoPath }))
