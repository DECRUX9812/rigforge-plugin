// What a first-time user actually sees: empty storage, no design memory.
//   node tests/first-run.mjs   (needs preview served on 127.0.0.1:18734)
import { chromium } from 'playwright'

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text()) })

// wipe the harness's seeded state before the app boots
await page.addInitScript(() => { try { localStorage.clear() } catch { } })
await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(1800)
await page.screenshot({ path: 'tests/tmp/first-run.png' })

const info = await page.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, ' ')
  const big = [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height })).sort((a, b) => b.w * b.h - a.w * a.h)[0]
  const buttons = [...document.querySelectorAll('button')].map((b) => b.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return {
    canvases: document.querySelectorAll('canvas').length,
    biggestCanvas: big,
    buttons: buttons.slice(0, 12),
    hasBuild: /BUILD/i.test(text),
    hasChooser: /PICK A MACHINE/i.test(text),
    firstSentence: (text.match(/^.{0,180}/) || [''])[0],
  }
})
console.log(JSON.stringify({ ...info, errors }, null, 1))
await browser.close()
