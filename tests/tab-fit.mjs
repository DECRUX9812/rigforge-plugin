import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const out = []
for (const w of [1440, 1180, 1024]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } })
  await p.goto('http://127.0.0.1:18745/preview.html')
  await p.waitForTimeout(1500)
  await p.locator('button[aria-label="Build a Ambidextrous humanoid"]').first().click({ timeout: 8000 }).catch(()=>{})
  await p.waitForTimeout(2200)
  await p.locator('button', { hasText: /^Engineer$/ }).first().click({ timeout: 3000 }).catch(()=>{})
  await p.waitForTimeout(900)
  const r = await p.evaluate(() => {
    const col = document.querySelector('[data-rf="spec"]').getBoundingClientRect()
    const tabs = [...document.querySelectorAll('[data-tab]')].map(e => { const r = e.getBoundingClientRect(); return { id: e.getAttribute('data-tab'), right: Math.round(r.right), bottom: Math.round(r.bottom) } })
    const clipped = tabs.filter(t => t.right > col.right + 1).map(t => t.id)
    const rows = new Set(tabs.map(t => Math.round(t.bottom))).size
    return { colRight: Math.round(col.right), clipped, rows, count: tabs.length }
  })
  out.push({ w, ...r }); await p.close()
}
console.log(JSON.stringify(out))
await b.close()
