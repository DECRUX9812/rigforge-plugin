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

// the page now carries gallery thumbnails + the viewport — shoot the biggest one.
// The viewport is a WebGL2 canvas, and a WebGL drawing buffer is cleared after
// compositing unless preserveDrawingBuffer is on, so toDataURL() would return a
// blank frame. Screenshot the element instead: that is the composited pixels,
// which is what a person sees.
const shot = async (name) => {
  const index = await page.evaluate(() => {
    const arr = [...document.querySelectorAll('canvas')]
    let best = 0
    for (let i = 0; i < arr.length; i += 1) {
      if (arr[i].width * arr[i].height > arr[best].width * arr[best].height) best = i
    }
    return best
  })
  const path = join(here, 'tmp', name)
  await page.locator('canvas').nth(index).screenshot({ path })
  return readFileSync(path)
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
// The simple panel's primary button promises a print pack. It used to resolve
// the export by index and hand back the whole-machine STL, which is not
// printable as a pack — so this asserts the file is a real zip of per-part STLs.
const packPromise = page.waitForEvent('download', { timeout: 25000 })
// click the button by its own hook: "has-text" also matches the menu entry with
// a similar label, and that ambiguity once pointed the assertion at the wrong
// control
await page.locator('[data-rf="packcta"]').first().click()
const packDl = await packPromise
const packPath = join(here, 'tmp', packDl.suggestedFilename())
await packDl.saveAs(packPath)
const pack = readFileSync(packPath)
const isZip = pack.subarray(0, 2).toString('latin1') === 'PK'
const entries = isZip ? (() => {
  // count local file headers without a zip library
  let n = 0
  for (let i = 0; i < pack.length - 4; i += 1) {
    if (pack[i] === 0x50 && pack[i + 1] === 0x4b && pack[i + 2] === 0x03 && pack[i + 3] === 0x04) n += 1
  }
  return n
})() : 0
const stlOnly = pack.subarray(30, 34).toString('latin1') === 'sol' || pack.subarray(0, 5).toString('latin1') === 'solid'
console.log('print pack:', packDl.suggestedFilename(), pack.length, 'bytes,', entries, 'entries, zip:', isZip, '| looks like a single STL:', stlOnly)
if (!isZip || entries < 3) { errs.push('print pack is not a multi-part zip') }
if (stlOnly) { errs.push('print pack returned the merged STL') }

console.log(errs.length ? 'PAGE ERRORS: ' + errs.join(' | ') : 'no page errors')
await browser.close()
