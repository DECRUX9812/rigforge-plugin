// Click-to-inspect: sweep the viewport and assert the chip names real parts.
//   node tests/pick-inspect.mjs
// Needs the preview bundle served: node tests/make-preview.mjs, then an http
// server over tests/tmp on 127.0.0.1:18734.
import { chromium } from 'playwright'

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 980 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(1600)

// The viewport draws camera-preset thumbnails first; the GL canvas is the big one.
const sizes = await page.evaluate(() =>
  [...document.querySelectorAll('canvas')].map((c, i) => {
    const r = c.getBoundingClientRect()
    return { i, w: Math.round(r.width), h: Math.round(r.height) }
  }),
)
const big = sizes.filter((c) => c.w > 300).sort((a, b) => b.w * b.h - a.w * a.h)[0]
if (!big) {
  console.log(JSON.stringify({ ok: false, problems: ['no viewport canvas larger than 300px'] }))
  process.exit(0)
}
const box = await page.locator('canvas').nth(big.i).boundingBox()

const hits = []
for (let gx = 0.25; gx <= 0.76; gx += 0.085) {
  for (let gy = 0.25; gy <= 0.76; gy += 0.085) {
    await page.mouse.click(box.x + box.width * gx, box.y + box.height * gy)
    await page.waitForTimeout(90)
    if (await page.locator('[data-rf="partchip"]').count()) {
      const txt = await page.locator('[data-rf="partchip"]').first().innerText()
      hits.push(txt.split('\n')[0].trim())
      // clicking the same part again is the documented way to clear it
      await page.mouse.click(box.x + box.width * gx, box.y + box.height * gy)
      await page.waitForTimeout(60)
    }
  }
}

const problems = []
const unique = [...new Set(hits)]
if (unique.length < 5) problems.push(`only ${unique.length} distinct parts named across the sweep`)
// 'Upper ARM' / 'JAW B' are the old shouting style; ids should read as prose
const shouty = unique.filter((h) => /\b[A-Z]{2,}\b/.test(h) && !/PCB|LED|DoF/.test(h))
if (shouty.length) problems.push(`labels shout: ${shouty.slice(0, 3).join(', ')}`)
if (errors.length) problems.push(...errors)

console.log(JSON.stringify({ ok: problems.length === 0, parts: unique.length, sample: unique.slice(0, 6), problems }))
await browser.close()
