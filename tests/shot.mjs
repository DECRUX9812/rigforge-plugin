// Shoot the preview at a given state — one call, one PNG, plus frame timing.
//   node tests/shot.mjs out-name [tabOrAction...]
import { chromium } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [name = 'shot', ...actions] = process.argv.slice(2)

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text()) })

await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(1200)

for (const a of actions) {
  if (a.startsWith('click:')) {
    await page.locator(`button:has-text("${a.slice(6)}")`).first().click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(500)
  } else if (a.startsWith('orbit:')) {
    const [dx, dy] = a.slice(6).split(',').map(Number)
    const box = await page.locator('canvas').first().boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(400)
  } else if (a.startsWith('wait:')) {
    await page.waitForTimeout(Number(a.slice(5)))
  }
}

const perf = await page.evaluate(() => new Promise((res) => {
  const t0 = performance.now()
  let n = 0
  const tick = () => { n += 1; if (performance.now() - t0 < 700) requestAnimationFrame(tick); else res({ fps: Math.round((n * 1000) / (performance.now() - t0)) }) }
  requestAnimationFrame(tick)
}))

await page.screenshot({ path: join(here, 'tmp', name + '.png') })
console.log('perf', JSON.stringify(perf))
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors')
await browser.close()
