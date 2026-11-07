// One screenshot per preset, seeded through the harness URL so the shot does not
// depend on which preset buttons happen to be visible in the strip.
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const PORT = process.env.PORT || 18761
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
const eng = await import('/tmp/rf-vs/tests/lib-engine.mjs').then((m) => m.loadEngine())
const rows = []
for (const [i, preset] of eng.PRESETS.entries()) {
  errs.length = 0
  const brief = encodeURIComponent(JSON.stringify(preset.brief))
  await p.goto(`http://127.0.0.1:${PORT}/preview.html?lastBrief=${brief}`)
  await p.waitForTimeout(2400)
  const n = String(i + 1).padStart(2, '0')
  await p.screenshot({ path: `/tmp/p-${n}.png` })
  const title = await p.evaluate(() => (document.body.innerText.match(/^[^\n]{8,70}$/m) || [''])[0])
  rows.push({ id: preset.id, title: title.slice(0, 50), errs: [...errs] })
}
await b.close()
writeFileSync('/tmp/presets-shot.json', JSON.stringify(rows, null, 1))
console.log(JSON.stringify(rows.map(r => `${r.id.padEnd(9)} ${r.errs.length ? 'ERR ' + r.errs[0].slice(0,40) : 'ok'}`), null, 1))
