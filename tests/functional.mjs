// Functional proof, in a real browser: pose the arm, export an STL, verify bytes.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(700)

const shot = async (name) => {
  const buf = await page.locator('canvas').first().screenshot()
  writeFileSync(join(here, 'tmp', name), buf)
  return buf
}

const before = await shot('pose-before.png')

// drive the shoulder joint to 45° through the real slider (React-controlled)
const angles = await page.evaluate(() => {
  const ranges = [...document.querySelectorAll('input[type=range]')]
  const shoulders = ranges.filter((r) => r.max === '85')
  const el = shoulders[0]
  if (!el) return { ok: false, count: ranges.length }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, '45')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, value: el.value }
})
await page.waitForTimeout(400)
const after = await shot('pose-after.png')
const changed = before.length !== after.length || !before.equals(after)
console.log('shoulder slider:', JSON.stringify(angles), '| canvas pixels changed:', changed)

const label = await page.locator('div:has-text("SHOULDER PITCH")').first().innerText().catch(() => '')
console.log('joint label now:', label.replace(/\n/g, ' ').slice(0, 40))

// export the STL through the real menu
await page.locator('button:has-text("EXPORT")').first().click()
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }),
  page.locator('div:has-text("STL mesh (mm)")').last().click(),
])
const path = join(here, 'tmp', 'exported.stl')
await download.saveAs(path)
const stl = readFileSync(path)
const tris = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true)
const header = stl.subarray(0, 30).toString('latin1')
console.log('download:', download.suggestedFilename(), stl.length, 'bytes,', tris, 'triangles')
console.log('stl header:', JSON.stringify(header))
console.log('size math ok:', stl.length === 84 + 50 * tris)
console.log(errs.length ? 'PAGE ERRORS: ' + errs.join(' | ') : 'no page errors')
await browser.close()
