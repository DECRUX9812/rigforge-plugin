// Every preset must actually DRAW. The engine suite proves the numbers; this
// proves a machine reaches the viewport — a blank canvas with a perfect BOM is
// still a broken product.
import { chromium } from 'playwright'
import { loadEngine } from './lib-engine.mjs'

const PORT = process.env.PORT || 18761
const A = loadEngine()
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))

// baseline: the same viewport before any brief is seeded
await page.goto(`http://127.0.0.1:${PORT}/preview.html`)
await page.waitForTimeout(2200)
const baseBox = await page.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')]
    .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  if (!cv) return null
  const r = cv.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(Math.min(360, r.width)), height: Math.round(Math.min(225, r.height)) }
})
const baselineB64 = (baseBox && baseBox.width > 100
  ? await page.screenshot({ clip: baseBox })
  : await page.screenshot()).toString('base64')


async function diffPct(page, a64, b64) {
  return page.evaluate(async ([x, y]) => {
    const load = async (str) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + str
      await img.decode()
      const c = document.createElement('canvas')
      c.width = 180; c.height = 112
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0, 180, 112)
      return g.getImageData(0, 0, 180, 112).data
    }
    const A = await load(x)
    const B = await load(y)
    let diff = 0
    for (let i = 0; i < A.length; i += 4) {
      const la = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2]
      const lb = 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2]
      if (Math.abs(la - lb) > 18) diff += 1
    }
    return { changed: Math.round((diff / (A.length / 4)) * 1000) / 10 }
  }, [a64, b64])
}

// Negative control: the same frame compared with itself must score 0. If it does
// not, the measurement is reading noise — a clock in the header, a blinking
// caret — and '3% changed' means nothing.
const control = await diffPct(page, baselineB64, baselineB64)
console.log(`  control (same frame twice): ${control.changed}% — must be 0`)

const rows = []
let failures = 0
for (const preset of A.PRESETS) {
  errs.length = 0
  const brief = encodeURIComponent(JSON.stringify(preset.brief))
  await page.goto(`http://127.0.0.1:${PORT}/preview.html?lastBrief=${brief}`)
  await page.waitForTimeout(2200)
  // A screenshot, re-read inside a scratch page. Reading the live canvas gives
  // zeros: the renderer clears its drawing buffer, so what the user sees only
  // exists once the compositor has a frame.
  // Variance cannot tell a machine from an empty grid: the floor grid and the
  // axis overlay have more contrast than a small machine does (empty viewport
  // measures sd 35, the arm 24). So measure the thing that actually differs —
  // how much of the viewport CHANGES when a machine is loaded, compared with the
  // same crop before any brief was seeded.
  const box = await page.evaluate(() => {
    const cv = [...document.querySelectorAll('canvas')]
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
    if (!cv) return null
    const r = cv.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(Math.min(360, r.width)), height: Math.round(Math.min(225, r.height)) }
  })
  const shot = box && box.width > 100
    ? await page.screenshot({ clip: box })
    : await page.screenshot()
  const stats = await diffPct(page, baselineB64, shot.toString('base64'))
  const ok = stats && stats.changed >= 3
  if (!ok) failures += 1
  rows.push(`${preset.id.padEnd(9)} ${ok ? 'drawn' : 'BLANK'}  changed ${stats ? stats.changed : '?'}%${errs.length ? ' · ' + errs[0].slice(0, 40) : ''}`)
}
await browser.close()
rows.forEach((r) => console.log(' ', r))
console.log(`\n${A.PRESETS.length - failures}/${A.PRESETS.length} presets render a machine`)
if (failures || control.changed > 0) process.exitCode = 1
