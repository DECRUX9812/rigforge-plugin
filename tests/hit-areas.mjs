import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const brief = encodeURIComponent(JSON.stringify({ archetype: 'arm', mission: 'x', payloadKg: 0.8, reachMm: 420, dof: 5 }))
await p.goto('http://127.0.0.1:18766/preview.html?lastBrief=' + brief)
await p.waitForTimeout(2500)
const small = await p.evaluate(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.height < 24 || r.width < 24) out.push({ label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) })
  }
  return out
})
console.log(JSON.stringify({ count: small.length, sample: small.slice(0, 12) }, null, 1))
await b.close()
