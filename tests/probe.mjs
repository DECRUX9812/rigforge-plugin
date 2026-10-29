import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1600, height: 980 } })
await p.goto('http://127.0.0.1:18734/preview.html')
await p.waitForTimeout(800)
const info = await p.evaluate(() => {
  const cv = document.querySelector('canvas')
  const wrap = cv.parentElement
  const r = cv.getBoundingClientRect(), wr = wrap.getBoundingClientRect()
  return {
    canvasCss: [r.width, r.height, r.top, r.left],
    canvasAttr: [cv.width, cv.height],
    wrap: [wr.width, wr.height, wr.top, wr.left],
    dpr: window.devicePixelRatio,
    bodyH: document.body.clientHeight,
  }
})
console.log(JSON.stringify(info, null, 1))
await b.close()
