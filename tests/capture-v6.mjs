// Capture v4 — footage for the current build of the studio.
// One take per beat so the film can cut on real action instead of guessing.
import { chromium } from 'playwright'
import { mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'tmp', 'footage6')
mkdirSync(join(outDir, 'raw'), { recursive: true })

const URL = 'http://127.0.0.1:18734/preview.html'
const W = 1920, H = 1080
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function take(name, script) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: join(outDir, 'raw'), size: { width: W, height: H } },
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await page.goto(URL)
  await page.waitForTimeout(1800)
  const t0 = Date.now()
  const marks = []
  const mark = (label) => { marks.push({ label, ms: Date.now() - t0 }); console.log('  •', label, Date.now() - t0) }
  await script(page, mark)
  await page.waitForTimeout(400)
  await ctx.close()
  const vid = page.video()
  const raw = await vid.path()
  const dest = join(outDir, `${name}.webm`)
  renameSync(raw, dest)
  console.log('captured', name, JSON.stringify(marks))
}

const click = (page, label) => page.locator(`button:has-text("${label}")`).first().click({ timeout: 5000 }).catch(() => {})

async function orbit(page, dx, dy, steps = 30) {
  const box = await page.locator('canvas').first().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps })
  await page.mouse.up()
}

async function typeInto(page, text, per = 42) {
  const ta = page.locator('textarea[aria-label="Describe the machine to build"]').first()
  await ta.click()
  await page.keyboard.press('Control+a')
  for (const ch of text) { await page.keyboard.type(ch); await sleep(per) }
}

// ── 1: the sentence becomes a machine ──────────────────────────────────────
await take('01-sentence', async (page, mark) => {
  await page.keyboard.press('Escape')
  await sleep(500)
  await typeInto(page, 'a rover that maps my room')
  await sleep(700); mark('typed')
  await click(page, 'BUILD')
  await sleep(2400); mark('built')
  await orbit(page, 200, -30)
  await sleep(700); mark('orbit')
})

// ── 2: the machine itself, posed ───────────────────────────────────────────
await take('02-machine', async (page, mark) => {
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
  await page.waitForTimeout(300)
  await page.keyboard.type('quadruped'); await page.keyboard.press('Enter')
  await sleep(2000); mark('quad')
  await orbit(page, 260, -60)
  await sleep(500)
  await click(page, 'EXPLODE'); await sleep(2200); mark('explode')
  await click(page, 'EXPLODE'); await sleep(600)
  await click(page, 'HOME'); await sleep(900)
  await click(page, 'POSE'); await sleep(500)
  const sliders = page.locator('input[type="range"]')
  const n = await sliders.count()
  for (let i = 0; i < Math.min(n, 3); i += 1) {
    await sliders.nth(i).evaluate((el) => { el.value = String(Math.max(Number(el.min), 32)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
    await sleep(520)
  }
  mark('posed')
  await orbit(page, -120, 20)
  await sleep(700)
})

// ── 3: the numbers and the working ─────────────────────────────────────────
await take('03-numbers', async (page, mark) => {
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
  await page.waitForTimeout(250)
  await page.keyboard.type('pick and place arm'); await page.keyboard.press('Enter')
  await sleep(2000); mark('arm')
  await page.locator('button:has-text("how these numbers are made")').first().click()
  await sleep(2000); mark('audit')
  await page.mouse.move(960, 700)
  await page.mouse.wheel(0, 320)
  await sleep(1800); mark('audit-scrolled')
  await click(page, 'Close'); await sleep(700)
  await page.locator('[role="group"][aria-label="detail level"] button:nth-child(2)').click()
  await sleep(900); mark('engineer')
  for (const tab of ['BOM', 'PWR', 'PRINT']) { await click(page, tab); await sleep(900) }
  mark('tabs')
})

// ── 4: files out ───────────────────────────────────────────────────────────
await take('04-files', async (page, mark) => {
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
  await page.waitForTimeout(250)
  await page.keyboard.type('controller board'); await page.keyboard.press('Enter')
  await sleep(2200); mark('board')
  await orbit(page, 90, -140)
  await sleep(700)
  await page.locator('[role="group"][aria-label="detail level"] button:nth-child(2)').click()
  await sleep(600)
  await click(page, 'ASSY'); await sleep(1600); mark('assy')
  await click(page, 'Export ▾'); await sleep(1900); mark('menu')
  await page.locator('span:text-is("Board pack · BOM + CPL + spec (zip)")').first().click().catch(() => {})
  await sleep(1400); mark('boardpack')
})

// ── 5: share it ────────────────────────────────────────────────────────────
await take('05-share', async (page, mark) => {
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
  await page.waitForTimeout(250)
  await page.keyboard.type('gripper'); await page.keyboard.press('Enter')
  await sleep(1800); mark('gripper')
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control')
  await page.waitForTimeout(250)
  await page.keyboard.type('open a build code'); await page.keyboard.press('Enter')
  await sleep(900); mark('dialog')
  await page.locator('input[aria-label="Build code"]').fill('RF1-eyJhcmNoZXR5cGUiOiJxdWFkcnVwZWQiLCJtaXNzaW9uIjoiMTItc2Vydm8gcXVhZHJ1cGVkIiwicGF5bG9hZEtnIjoxfQ')
  await sleep(1200); mark('pasted')
  await page.locator('button:has-text("OPEN IT")').click()
  await sleep(1900); mark('rebuilt')
  await orbit(page, 150, -40)
  await sleep(600)
})

// ── 6: the ladder of scale ─────────────────────────────────────────────────
await take('06-ladder', async (page, mark) => {
  await page.locator('button:has-text("MORE MACHINES")').first().click().catch(() => {})
  await sleep(900)
  const names = ['IoT sensor node', 'Survey rover', 'Quadruped', 'Humanoid', 'Full-scale gantry']
  for (const n of names) {
    await page.locator(`button[aria-label="Build a ${n}"]`).first().click({ timeout: 4000 }).catch(() => {})
    await sleep(1150)
    mark(n)
  }
})

await browser.close()
console.log('done →', outDir)
