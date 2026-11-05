import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 1440, height: 950 } })
await p.goto('http://127.0.0.1:18734/preview.html'); await p.waitForTimeout(2000)
await p.locator('button:has-text("Export")').first().click(); await p.waitForTimeout(400)
const dump = await p.evaluate(() => {
  const all = [...document.querySelectorAll('div')]
  const owners = all.filter(e => (e.innerText || '').includes('URDF') && (e.innerText || '').length < 400)
  const menu = owners[owners.length - 1]
  if (!menu) return { found: false }
  return {
    found: true,
    tag: menu.tagName,
    cls: menu.className,
    childCount: menu.children.length,
    kids: [...menu.children].map(c => ({ tag: c.tagName, text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) })),
  }
})
console.log(JSON.stringify(dump))
await b.close()
