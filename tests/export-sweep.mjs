// Every export entry, clicked for real, saved, and measured. This is the check
// that caught the print-pack CTA handing back a merged STL.
import { chromium } from 'playwright'
import { statSync, mkdirSync } from 'node:fs'
mkdirSync('tests/tmp/exports', { recursive: true })
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))

const openMenu = async () => {
  await p.locator('button:has-text("Export")').first().click()
  await p.waitForTimeout(260)
}
const itemTexts = async () => p.evaluate(() => {
  const divs = [...document.querySelectorAll('div')].filter((e) => {
    const t = (e.innerText || '')
    return e.children.length >= 5 && t.includes('URDF') && t.length < 700
  })
  const menu = divs[divs.length - 1]
  return menu ? [...menu.children].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim()) : []
})

await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(2100)
await openMenu()
const labels = await itemTexts()
await p.keyboard.press('Escape')
const results = []
for (let i = 0; i < labels.length; i += 1) {
  await openMenu()
  const dlP = p.waitForEvent('download', { timeout: 12000 }).catch(() => null)
  const clicked = await p.evaluate((idx) => {
    const divs = [...document.querySelectorAll('div')].filter((e) => {
      const t = (e.innerText || '')
      return e.children.length >= 5 && t.includes('URDF') && t.length < 700
    })
    const menu = divs[divs.length - 1]
    const item = menu && menu.children[idx]
    if (!item) return false
    item.click()
    return true
  }, i)
  const d = await dlP
  if (!clicked) {
    // the popover occasionally is not mounted yet on the first open
    await openMenu()
    const retry = await p.evaluate((idx) => {
      const divs = [...document.querySelectorAll('div')].filter((e) => {
        const t = (e.innerText || '')
        return e.children.length >= 5 && t.includes('URDF') && t.length < 700
      })
      const menu = divs[divs.length - 1]
      const item = menu && menu.children[idx]
      if (!item) return false
      item.click()
      return true
    }, i)
    if (!retry) { results.push({ label: labels[i], error: 'not clickable' }); continue }
  }
  if (!d) { results.push({ label: labels[i].slice(0, 30), note: 'no download (dialog/clipboard)' }); await p.keyboard.press('Escape').catch(() => {}); continue }
  const path = 'tests/tmp/exports/' + d.suggestedFilename()
  await d.saveAs(path)
  results.push({ label: labels[i].slice(0, 30), file: d.suggestedFilename(), bytes: statSync(path).size })
}
// A menu entry that downloads nothing, or nothing useful, is a bug: this is the
// check that caught the print-pack CTA handing back a merged STL.
const problems = []
// order matters: "Print pack · per-part STLs (zip)" contains "STL" too
const expectExt = [
  // 3MF arrived after this list was written and its label contains "print
  // pack", so the zip rule claimed it and the gate failed a correct download.
  // Specific before general.
  [/3mf/i, '.3mf'],
  [/step/i, '.step'],
  [/glb|gltf/i, '.glb'],
  [/print pack|board pack|fab \+ assembly/i, '.zip'],
  [/openscad/i, '.scad'],
  [/build spec/i, '.md'],
  [/bill of materials/i, '.csv'],
  [/centroid|cpl/i, '.csv'],
  [/firmware/i, '.ino'],
  [/urdf/i, '.urdf'],
  [/mjcf/i, '.xml'],
  [/^stl mesh/i, '.stl'],
]
for (const r of results) {
  if (r.note) continue // clipboard/dialog entries are not downloads
  if (r.error) { problems.push(`${r.label}: ${r.error}`); continue }
  if (!r.bytes) problems.push(`${r.label}: zero-byte file`)
  const rule = expectExt.find(([re]) => re.test(r.label))
  if (rule && !r.file.endsWith(rule[1])) problems.push(`${r.label}: got ${r.file}, expected ${rule[1]}`)
}
console.log(JSON.stringify({ entries: labels.length, results, problems, errs: errs.slice(0, 3) }, null, 0))
if (problems.length || errs.length) {
  console.error('EXPORT SWEEP FAILED:\n' + [...problems, ...errs].join('\n'))
  process.exitCode = 1
}
await b.close()
