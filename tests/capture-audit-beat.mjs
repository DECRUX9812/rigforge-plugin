// One beat, held long enough: the audit dialog open for the whole shot.
// The full take closes it to move on to the tabs, which left the last seconds
// of the film showing a plain viewport under a caption about the dialog.
import { chromium } from 'playwright'
import { mkdirSync, renameSync } from 'node:fs'

const out = 'tests/tmp/footage6'
mkdirSync(`${out}/raw`, { recursive: true })
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: `${out}/raw`, size: { width: 1920, height: 1080 } },
})
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(1800)
await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control')
await p.waitForTimeout(260)
await p.keyboard.type('pick and place arm')
await p.waitForTimeout(220)
await p.keyboard.press('Enter')
await p.waitForTimeout(1800)
await p.locator('button:has-text("how these numbers are made")').first().click()
await p.waitForTimeout(1400)
await p.mouse.move(960, 700)
await p.mouse.wheel(0, 260)
await p.waitForTimeout(1600)
await p.mouse.wheel(0, -120)
await p.waitForTimeout(4200) // hold, so the shot has room to breathe
await ctx.close()
const raw = await p.video().path()
renameSync(raw, `${out}/03b-audit.webm`)
console.log('captured 03b-audit')
await b.close()
