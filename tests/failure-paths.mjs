// Failure paths: what a person sees when the ask is impossible, empty, nonsense
// or absurd. Every one of these has to end in an honest sentence, not a crash,
// a blank panel or a silent fabrication.
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('page: ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 90)) })
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(2000)

const briefs = [
  ['empty', ''],
  ['gibberish', 'asdkjhaskjd qwpoeiru zxcv'],
  ['impossible payload', 'a robot that carries 500 kg of soil'],
  ['absurd reach', 'an arm with a 20 metre reach'],
  ['off-topic', 'a superyacht with a helipad'],
  ['very long', 'a rover that maps my room. '.repeat(40)],
  ['zero dof', 'an arm with 0 degrees of freedom'],
  ['tiny board', 'a 5mm controller board'],
]
const box = p.locator('textarea, input[type=text]').first()
const rows = []
for (const [label, text] of briefs) {
  const before = errs.length
  await box.fill(text)
  await p.locator('button:has-text("BUILD")').first().click()
  await p.waitForTimeout(1500)
  const state = await p.evaluate(() => {
    const body = document.querySelector('[data-rf="body"]')
    const text = (body ? body.innerText : document.body.innerText).replace(/\s+/g, ' ').trim()
    const hud = (document.querySelector('[data-rf="hud"]')?.innerText || '').replace(/\s+/g, ' ')
    const warn = /heads up|warning|can't|cannot|too |exceeds|out of scope|not enough/i.test(text)
    return { chars: text.length, hud, warn, head: text.slice(0, 110) }
  })
  rows.push({ label, ...state, newErrors: errs.length - before })
}
console.log(JSON.stringify({ rows, errs: errs.slice(0, 5) }, null, 0))
await b.close()
