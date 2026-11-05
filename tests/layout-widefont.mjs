// Layout under a deliberately wide font stack — the condition that failed on CI
// and passed on the dev machine. If the top bar relies on shaving pixels, this
// reproduces the red build; if it wraps, it holds.
//   node tests/layout-widefont.mjs
import { chromium } from 'playwright'

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const rows = []
const problems = []

for (const width of [640, 600, 560]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:18734/preview.html')
  await page.waitForTimeout(1200)
  // a wider face plus extra tracking: every string on the page grows
  // The CI runner's stack is wider than the dev machine's. Rather than guess at
  // its metrics, squeeze the viewport past the design width: same failure
  // (content wider than the page), reproducible on any machine.
  await page.addStyleTag({ content: '* { letter-spacing: 0.4px !important }' })
  await page.waitForTimeout(600)
  const r = await page.evaluate(() => {
    const docW = document.documentElement.clientWidth
    const scrollW = document.documentElement.scrollWidth
    const past = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > docW + 1)
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}:${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 24)}`)
    return { docW, scrollW, past }
  })
  rows.push({ width, ...r })
  if (r.scrollW > r.docW) problems.push(`${width}: scrolls sideways (${r.scrollW} > ${r.docW}) — ${r.past.join(', ')}`)
  if (errors.length) problems.push(`${width}: ${errors.join(' / ')}`)
  await page.close()
}

await browser.close()
console.log(JSON.stringify({ ok: problems.length === 0, rows, problems }, null, 1))
