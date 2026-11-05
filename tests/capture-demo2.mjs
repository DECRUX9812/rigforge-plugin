// Capture clean 1080p footage of the studio for the demo film (v3 look:
// plain-words summary, machine cards with live 3D previews).
import { chromium } from 'playwright'
import { mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'tmp', 'footage2')
mkdirSync(outDir, { recursive: true })

const URL = 'http://127.0.0.1:18734/preview.html'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function take(name, script) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: join(outDir, 'raw'), size: { width: 1920, height: 1080 } },
    acceptDownloads: false,
  })
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.waitForTimeout(2200) // thumbnails render in idle time
  await script(page)
  await page.waitForTimeout(700)
  await ctx.close()
  renameSync(await page.video().path(), join(outDir, `${name}.webm`))
  console.log('captured', name)
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

// ── take 1: pick a card, build, turn it, then open the engineering ─────────
await take('01-build', async (page) => {
  await sleep(1800)
  await card(page, 'Quadruped')
  await sleep(1400)
  await click(page, 'BUILD')
  await sleep(2200)
  await orbit(page, 200, -30)
  await sleep(800)
  await orbit(page, 90, 24)
  await sleep(700)
  await click(page, 'EXPLODE')
  await sleep(1900)
  await click(page, 'EXPLODE')
  await sleep(900)
  await click(page, 'SHOW ME THE ENGINEERING')
  await sleep(2400)
})

// ── take 2: the machine family, then the engineering tabs ─────────────────
await take('02-tour', async (page) => {
  await sleep(700)
  await card(page, 'Humanoid')
  await sleep(1500)
  await orbit(page, -130, 18)
  await sleep(700)
  await card(page, 'Parallel Gripper')
  await sleep(1400)
  await card(page, 'Survey Rover')
  await sleep(1400)
  await card(page, 'Pick & Place Arm')
  await sleep(1200)
  await click(page, 'SHOW ME THE ENGINEERING')
  await sleep(1600)
  for (const tab of ['BOM', 'PINS', 'POWER', 'PRINT', 'CODE']) {
    await click(page, tab)
    await sleep(1200)
  }
  await click(page, 'SPEC')
  await sleep(500)
  await click(page, 'EXPORT ▾')
  await sleep(1700)
})

await browser.close()
