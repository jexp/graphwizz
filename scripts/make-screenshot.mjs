/**
 * Captures the README screenshot: boots the dev server, connects to a demo
 * dataset, waits for layout + labels, and saves a viewport shot to
 * docs/screenshot.png.
 *
 *   node scripts/make-screenshot.mjs [stackoverflow|movies|ckg]
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const target = process.argv[2] ?? 'stackoverflow'
const PORT = 5199
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('../packages/demo', import.meta.url).pathname,
  stdio: 'pipe',
})
await new Promise((resolve, reject) => {
  vite.stdout.on('data', (d) => String(d).includes('Local:') && resolve())
  vite.stderr.on('data', (d) => process.stderr.write(d))
  setTimeout(() => reject(new Error('vite boot timeout')), 20000)
})

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1760, height: 1050 } })
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })

// select the preset by name
const idx = { movies: 0, northwind: 1, stackoverflow: 2, ckg: 3 }[target] ?? 0
await page.selectOption('#preset', String(idx))
await page.click('#btn-connect')
await page.waitForSelector('#hud:not(.hidden)', { timeout: 120000 })
await page.waitForFunction(() => window.__gw?.getPhase?.() === 'ready', { timeout: 120000 })
// let the layout spread and the refit passes land
await page.waitForTimeout(6000)

await page.screenshot({ path: 'docs/screenshot.png' })
console.log(`saved docs/screenshot.png (${target})`)
await browser.close()
vite.kill()
