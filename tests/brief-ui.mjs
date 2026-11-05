// Does the warning actually reach the person? Type nonsense, press BUILD, read
// the panel the same way a user would.
import { chromium } from 'playwright'

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(2000)
const box = p.locator('textarea, input[type=text]').first()
await box.fill('asdkjhaskjd qwpoeiru zxcv')
await p.locator('button:has-text("BUILD")').first().click({ force: true })
await p.waitForTimeout(1700)
const seen = await p.evaluate(() => {
  const body = document.querySelector('[data-rf="body"]')?.innerText || ''
  const line = body.split('\n').find((l) => /did not name a machine/i.test(l)) || ''
  return { shown: Boolean(line), line: line.slice(0, 130) }
})
await p.screenshot({ path: 'tests/tmp/brief-warning.png' })
console.log(JSON.stringify({ ...seen, errs: errs.slice(0, 2) }))
await b.close()
