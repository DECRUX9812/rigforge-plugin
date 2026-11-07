import { chromium } from 'playwright'
import { rmSync, mkdirSync } from 'node:fs'
const OUT = '/tmp/payload-vid'
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } })
const p = await ctx.newPage()
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
const t0 = Date.now()
const marks = {}
const mark = (k) => { marks[k] = +((Date.now() - t0) / 1000).toFixed(2) }
const brief = encodeURIComponent(JSON.stringify({ archetype: 'arm', mission: 'sort parts into bins', payloadKg: 0.8, reachMm: 420, dof: 5 }))
await p.goto('http://127.0.0.1:18762/preview.html?lastBrief=' + brief)
await p.waitForTimeout(2600)
mark('loaded')
await p.screenshot({ path: '/tmp/pay-1.png' })
const slider = p.locator('input[aria-label="PAYLOAD"]').first()
await slider.focus()
await p.waitForTimeout(600)
// climb the payload until the machine refuses
for (let i = 0; i < 16; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(90) }
await p.waitForTimeout(1400)
mark('fail')
await p.screenshot({ path: '/tmp/pay-2.png' })
const txt = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 0) || '')
const failVisible = await p.evaluate(() => /beyond|lifts|N·m/.test(document.body.innerText))
await p.waitForTimeout(1800)
// back down: the refusal has to clear, not stick
for (let i = 0; i < 16; i++) { await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(80) }
await p.waitForTimeout(1600)
mark('recovered')
await p.screenshot({ path: '/tmp/pay-3.png' })
const stillFailing = await p.evaluate(() => /beyond Feetech|is a stepper/.test(document.body.innerText))
const v = await p.video().path()
await ctx.close(); await b.close()
console.log(JSON.stringify({ errs, marks, failVisible, stillFailing, v }))
