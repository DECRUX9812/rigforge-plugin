// Capture clean 1080p footage of the studio for the demo film.
// Two takes: the build/orbit story, and the machine + spec tour.
import { chromium } from 'playwright'
import { mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'tmp', 'footage')
mkdirSync(outDir, { recursive: true })

const URL = 'http://127.0.0.1:18734/preview.html'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function take(name, script) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: join(outDir, 'raw'), size: { width: 1920, height: 1080 } },
  })
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.waitForTimeout(1500)
  await script(page)
  await page.waitForTimeout(600)
  await ctx.close()
  const vid = page.video()
  const raw = await vid.path()
  const dest = join(outDir, `${name}.webm`)
  renameSync(raw, dest)
  console.log('captured', dest)
}

const click = (page, label) => page.locator(`button:has-text("${label}")`).first().click({ timeout: 4000 }).catch(() => {})
const card = (page, name) => page.locator(`button[aria-label="Build a ${name}"]`).first().click({ timeout: 4000 }).catch(() => {})

async function orbit(page, dx, dy, steps = 26) {
  const box = await page.locator('canvas').first().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps })
  await page.mouse.up()
}

// ── take 1: describe it, build it, turn it, blow it apart ──────────────────
await take('01-build', async (page) => {
  await sleep(2200)
  const ta = page.locator('textarea').first()
  await ta.click()
  const brief = 'a robot arm that sorts lego bricks'
  for (const ch of brief) { await page.keyboard.type(ch); await sleep(55) }
  await sleep(500)
  await click(page, 'BUILD')
  await sleep(2600)
  await orbit(page, 240, -40)
  await sleep(900)
  await orbit(page, 120, 30)
  await sleep(600)
  await click(page, 'EXPLODE')
  await sleep(2600)
  await click(page, 'EXPLODE')
  await sleep(900)
  // pose the arm
  const sliders = page.locator('input[type="range"]')
  const n = await sliders.count()
  for (let i = 1; i < Math.min(n, 4); i += 1) {
    const s = sliders.nth(i)
    await s.evaluate((el) => { el.value = String(Math.max(Number(el.min), 35)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
    await sleep(700)
  }
  await sleep(1200)
  await click(page, 'HOME')
  await sleep(1200)
})

// ── take 2: the machine tour, then the paperwork tabs ─────────────────────
await take('02-tour', async (page) => {
  await sleep(900)
  await card(page, 'Quadruped')
  await sleep(1600)
  await orbit(page, -140, 20)
  await sleep(700)
  await card(page, 'Humanoid')
  await sleep(1600)
  await card(page, 'Parallel Gripper')
  await sleep(1500)
  await card(page, 'Survey Rover')
  await sleep(1500)
  await card(page, 'Pick & Place Arm')
  await sleep(1200)
  for (const tab of ['BOM', 'PINS', 'POWER', 'PRINT', 'CODE', 'BUILD']) {
    await click(page, tab)
    await sleep(1300)
  }
  await click(page, 'SPEC')
  await sleep(600)
  await click(page, 'EXPORT ▾')
  await sleep(1800)
})

await browser.close()
