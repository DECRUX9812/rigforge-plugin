// Shoot the preview at a given width, for eyeballing the narrow layouts.
//   node tests/shot-width.mjs out-name 640 900
import { chromium } from 'playwright'

const [name = 'shot-width', w = '640', h = '900'] = process.argv.slice(2)
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 2,
})
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text()) })

await page.goto('http://127.0.0.1:18734/preview.html')
await page.waitForTimeout(1400)
await page.screenshot({ path: `tests/tmp/${name}.png`, fullPage: true })

const info = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  docW: document.documentElement.clientWidth,
  docH: document.documentElement.scrollHeight,
}))
console.log(JSON.stringify({ name, viewport: [+w, +h], ...info, errors }))
await browser.close()
