// The demo, performed on the real UI and recorded as video.
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const OUT = '/tmp/demo-vid'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:18755/preview.html')
const wait = (ms) => p.waitForTimeout(ms)

// ── beat 1: the studio, empty ───────────────────────────────────────────────
await wait(2200)

// ── beat 2: a sentence, typed the way a person types it ────────────────────
const input = p.locator('textarea[aria-label="Describe the machine to build"]').first()
await input.click()
await input.type('a drone that follows me on a bike', { delay: 45 })
await wait(700)
await p.locator('button', { hasText: /^BUILD$/ }).first().click()
await wait(2600)

// ── beat 3: orbit the machine with the hand ────────────────────────────────
const box = await p.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect())
  const big = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  return { x: big.x, y: big.y, w: big.width, h: big.height }
})
await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5)
await p.mouse.down()
for (let i = 1; i <= 24; i += 1) {
  await p.mouse.move(box.x + box.w * 0.5 + i * 9, box.y + box.h * 0.5 + Math.sin(i / 4) * 12)
  await wait(40)
}
await p.mouse.up()
await wait(800)

// ── beat 4: the fly-through ────────────────────────────────────────────────
const fly = p.locator('button', { hasText: /^FLY$/ }).first()
if (await fly.count()) { await fly.click(); await wait(11500) }

// ── beat 5: grab a part ────────────────────────────────────────────────────
const pt = await p.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  const r = cv.getBoundingClientRect()
  for (let gy = 0.25; gy <= 0.8; gy += 0.05) for (let gx = 0.25; gx <= 0.8; gx += 0.05) {
    const h = globalThis.__rfPick && globalThis.__rfPick(gx * r.width, gy * r.height)
    if (h && h.grabbable) return { x: r.x + gx * r.width, y: r.y + gy * r.height }
  }
  return null
})
if (pt) {
  await p.mouse.move(pt.x, pt.y)
  await p.mouse.down()
  for (let i = 1; i <= 16; i += 1) { await p.mouse.move(pt.x + i * 6, pt.y + i * 3); await wait(35) }
  await p.mouse.up()
  await wait(1400)
}

// ── beat 6: the numbers, then the files ────────────────────────────────────
await p.locator('button', { hasText: /^Engineer$/ }).first().click().catch(() => {})
await wait(1800)
await p.locator('[data-tab="test"]').click().catch(() => {})
await wait(2000)
await p.locator('[data-tab="parts"]').click().catch(() => {})
await wait(2200)
await p.locator('button', { hasText: /Export/ }).first().click().catch(() => {})
await wait(2400)

const videoPath = await p.video().path().catch(() => null)
await ctx.close()
await b.close()
console.log(JSON.stringify({ errs, videoPath }))
