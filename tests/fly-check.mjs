import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(1600)
await p.locator('button[aria-label="Build a Ambidextrous humanoid"]').first().click({ timeout: 8000 }).catch(async () => {
  const names = ['Ambidextrous humanoid', '5-DoF arm that sorts 3D-printed parts', 'Pick & place arm', 'Survey rover, 4WD']
  for (const n of names) {
    const ok = await p.locator(`button[aria-label="Build a ${n}"]`).first().click({ timeout: 2000 }).then(() => true).catch(() => false)
    if (ok) return
  }
})
await p.waitForTimeout(2600)
// frames per second while idle, then during the flight
const fps = async () => p.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now()
  const tick = () => { n += 1; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t0) / 1000))) }
  requestAnimationFrame(tick)
}))
const idle = await fps()
const btn = p.locator('button', { hasText: /^FLY$/ }).first()
const hasFly = await btn.count()
await btn.click()
await p.waitForTimeout(300)
const flying = await fps()
const label = await p.locator('button', { hasText: /^(MOVE|FLY)$/ }).first().innerText()
const shots = []
for (const t of [0.15, 0.45, 0.62, 0.85, 1.05]) {
  await p.waitForTimeout(t * 1000 - (shots.length ? shots[shots.length-1][0]*1000 : 0))
  const path = `/tmp/fly-${shots.length}.png`
  await p.screenshot({ path }); shots.push([t, path])
}
await p.waitForTimeout(1500)
const after = await p.locator('button', { hasText: /^(MOVE|FLY)$/ }).first().innerText()
console.log(JSON.stringify({ errs, hasFly, label, after, idle, flying }))
await b.close()
