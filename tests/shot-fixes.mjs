import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const brief = encodeURIComponent(JSON.stringify({ archetype: 'arm', mission: 'sort parts', payloadKg: 0.8, reachMm: 420, dof: 5 }))
await p.goto('http://127.0.0.1:18766/preview.html?lastBrief=' + brief)
await p.waitForTimeout(2500)
await p.screenshot({ path: '/tmp/fix-simple.png' })
const has = await p.evaluate(() => ({
  fixes: [...document.querySelectorAll('button[aria-label^="Apply fix"]')].map(b => b.textContent.trim()),
  sample: !!document.querySelector('button[aria-label="Load a sample build into the shelf"]'),
  smallButtons: [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 24 || r.width < 24) }).length,
}))
console.log(JSON.stringify(has))
await b.close()
