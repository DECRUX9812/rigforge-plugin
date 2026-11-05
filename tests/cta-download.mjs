// The primary call to action must download what its label promises.
//   node tests/cta-download.mjs   (needs preview served on 127.0.0.1:18734)
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1600, height: 980 }, acceptDownloads: true })
const errs = []; p.on('pageerror', e => errs.push(e.message))
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(1500)
const btn = p.locator('button', { hasText: /DOWNLOAD THE (PRINT PACK|FAB)/i }).first()
const label = (await btn.innerText()).replace(/\s+/g, ' ').trim()
const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), btn.click()])
const path = await dl.path()
const buf = readFileSync(path)
const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
const promisesZip = /\.zip/i.test(label)
const problems = []
if (promisesZip && !isZip) problems.push(`label promises a zip, download started with ${buf.slice(0, 2).toString('hex')}`)
if (promisesZip && !/\.zip$/i.test(dl.suggestedFilename())) problems.push(`filename is ${dl.suggestedFilename()}`)
if (buf.length < 2000) problems.push(`only ${buf.length} bytes`)
problems.push(...errs)
console.log(JSON.stringify({ ok: problems.length === 0, label, file: dl.suggestedFilename(), bytes: buf.length, isZip, problems }))
await b.close()
