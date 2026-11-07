import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('http://127.0.0.1:18746/preview.html')
await p.waitForTimeout(1500)
await p.locator('button[aria-label="Build a Ambidextrous humanoid"]').first().click({ timeout: 8000 }).catch(()=>{})
await p.waitForTimeout(2600)
const pt = await p.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height)[0]
  const r = cv.getBoundingClientRect()
  for (let gy = 0.2; gy <= 0.85; gy += 0.05) for (let gx = 0.2; gx <= 0.85; gx += 0.05) {
    const h = globalThis.__rfPick(gx * r.width, gy * r.height)
    if (h && h.grabbable) return { x: r.x + gx * r.width, y: r.y + gy * r.height, node: h.node }
  }
  return null
})
const massBefore = await p.locator('body').innerText().then(t => (t.match(/MASS\s+([\d.]+ kg|[\d]+ g)/) || [])[1])
await p.mouse.move(pt.x, pt.y)
await p.mouse.down()
await p.mouse.move(pt.x + 140, pt.y + 90, { steps: 12 })
await p.waitForTimeout(250)
const during = await p.locator('[data-rf="movedchip"]').count()
const shotDrag = '/tmp/hands-drag.png'
await p.screenshot({ path: shotDrag })
await p.mouse.up()
await p.waitForTimeout(1200)
const chip = await p.locator('[data-rf="movedchip"]').count()
const chipText = chip ? (await p.locator('[data-rf="movedchip"]').innerText()).replace(/\n/g, ' ') : null
const massAfter = await p.locator('body').innerText().then(t => (t.match(/MASS\s+([\d.]+ kg|[\d]+ g)/) || [])[1])
// reset must put it back
const reset = chip ? await p.locator('[data-rf="movedchip"] button').click().then(() => true).catch(() => false) : false
await p.waitForTimeout(500)
const afterReset = await p.locator('[data-rf="movedchip"]').count()
const stats = await p.evaluate(() => globalThis.__rfStats || null)
console.log(JSON.stringify({ errs, pt, during, chip, chipText, massBefore, massAfter, reset, afterReset, stats }))
await b.close()
