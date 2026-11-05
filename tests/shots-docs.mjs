// Documentation screenshots. One pass, current UI, into docs/screenshots/.
// The catalog page renders whatever is in this directory, so stale images are a
// false claim about the product — regenerate them when the surface changes.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = 'docs/screenshots'
mkdirSync(OUT, { recursive: true })
const URL = 'http://127.0.0.1:18734/preview.html'
const W = 1600, H = 1000

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))

const go = async (q) => {
  await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control')
  await p.waitForTimeout(220)
  await p.keyboard.type(q)
  await p.waitForTimeout(200)
  await p.keyboard.press('Enter')
  await p.waitForTimeout(1500)
}
const engineer = async () => {
  await p.locator('[role="group"][aria-label="detail level"] button:nth-child(2)').click()
  await p.waitForTimeout(700)
}
const shoot = async (name) => {
  await p.waitForTimeout(500)
  await p.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}

await p.goto(URL)
await p.waitForTimeout(1800)
// dismiss the first-run guide so screenshots show the product, not the tutorial
await p.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText || '').trim() === 'HIDE'); if (b) b.click() })
await p.waitForTimeout(600)

// 1 — hero: beginner path, a rover built from words
await p.locator('textarea[aria-label="Describe the machine to build"]').fill('a rover that maps my room')
await p.waitForTimeout(400)
await p.locator('button:has-text("BUILD")').first().click()
await p.waitForTimeout(2200)
await shoot('hero')

// 2 — quadruped, engineering view
await go('quadruped')
await engineer()
await shoot('quad')

// 3 — gripper with its mechanism
await go('parallel gripper')
await shoot('gripper')

// 4 — the controller board and its assembly tab
await go('controller board')
await p.locator('[role="tab"]:has-text("ASSY")').click()
await p.waitForTimeout(800)
await shoot('board')

// 5 — show the working
await go('pick and place arm')
await p.locator('button:has-text("how these numbers are made")').first().click().catch(async () => {
  await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control')
  await p.waitForTimeout(200); await p.keyboard.type('show the working'); await p.keyboard.press('Enter')
})
await p.waitForTimeout(1100)
await shoot('audit')
await p.keyboard.press('Escape')
await p.waitForTimeout(500)

// 6 — before/after: change one number, then compare (palette works in either mode)
await p.locator('input[type="range"]').nth(0).evaluate((el) => {
  el.value = '0.15'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})
await p.waitForTimeout(1700)
await p.keyboard.down('Control'); await p.keyboard.press('k'); await p.keyboard.up('Control')
await p.waitForTimeout(220)
await p.keyboard.type('compare'); await p.waitForTimeout(180); await p.keyboard.press('Enter')
await p.waitForTimeout(1100)
await shoot('compare')
await p.keyboard.press('Escape')
await p.waitForTimeout(400)

// 7 — the two older stills, regenerated against the current UI
await go('humanoid')
await engineer()
await shoot('posed')
await go('survey rover')
await shoot('rover')

console.log('errors', errs.slice(0, 3))
await b.close()
