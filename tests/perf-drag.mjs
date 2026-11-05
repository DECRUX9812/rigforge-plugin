// Drag a joint slider hard and measure what a person actually feels: the
// longest frame, and how many frames blow the 16.7 ms budget.
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(2600)

const result = await p.evaluate(async () => {
  const ranges = [...document.querySelectorAll('input[type=range]')]
  const el = ranges.find((r) => r.max === '85') || ranges[0]
  if (!el) return { error: 'no slider' }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const frames = []
  let last = performance.now()
  let running = true
  const tick = () => {
    const now = performance.now()
    frames.push(now - last)
    last = now
    if (running) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await new Promise((r) => setTimeout(r, 300))
  // 40 rapid changes, the way a person drags
  const started = performance.now()
  for (let i = 0; i < 40; i += 1) {
    setter.call(el, String(-40 + i * 2))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 16))
  }
  const elapsed = performance.now() - started
  await new Promise((r) => setTimeout(r, 400))
  running = false
  const during = frames.length > 14 ? frames.slice(12) : frames.slice()
  if (!during.length) return { error: 'no frames captured', total: frames.length }
  const sorted = [...during].sort((a, b) => a - b)
  return {
    events: 40,
    elapsedMs: Math.round(elapsed),
    frames: during.length,
    medianFrameMs: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
    p95FrameMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    worstFrameMs: +sorted[sorted.length - 1].toFixed(1),
    over33ms: during.filter((f) => f > 33).length,
    fps: +(1000 / (during.reduce((s, f) => s + f, 0) / during.length)).toFixed(1),
  }
})
console.log(JSON.stringify({ ...result, errs: errs.slice(0, 2) }))
await b.close()
