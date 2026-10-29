// Screenshot the preview page — headless chromium, real layout, real canvas.
import { chromium } from 'playwright'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const url = 'http://127.0.0.1:18734/preview.html'
const out = (name) => join(here, 'tmp', name)

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

await page.goto(url)
await page.waitForTimeout(900)

const stats = await page.evaluate(() => {
  const t = document.body.innerText
  return { len: t.length, hasWordmark: t.includes('RIGFORGE'), hasCost: /\$\d/.test(t), tabs: (t.match(/SPEC|BOM|PINS|POWER|PRINT|CODE|BUILD/g) || []).length }
})
console.log('page text:', JSON.stringify(stats))
await page.screenshot({ path: out('rf-default.png') })

// click through the tabs
const clickTab = async (label, shot) => {
  const el = page.locator(`button:has-text("${label}")`).first()
  await el.click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(250)
  await page.screenshot({ path: out(shot) })
}
await clickTab('BOM', 'rf-bom.png')
await clickTab('PINS', 'rf-pins.png')
await clickTab('CODE', 'rf-code.png')
await clickTab('SPEC', 'rf-spec.png')

// pose + dims + orbit
await page.locator('button:has-text("DIMS")').first().click().catch(() => {})
const cv = page.locator('canvas').first()
const box = await cv.boundingBox()
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 - 40, { steps: 12 })
  await page.mouse.up()
}
await page.waitForTimeout(300)
await page.screenshot({ path: out('rf-orbit.png') })

// switch archetype to rover
await page.locator('button:has-text("ROVER")').first().click().catch(() => {})
await page.waitForTimeout(600)
await page.screenshot({ path: out('rf-rover.png') })

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors')
await browser.close()
