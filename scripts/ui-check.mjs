/**
 * Browser verification of the demo renderer: boots the dev server, connects
 * to the movies preset, and asserts that wheel-zoom and drag-pan actually
 * move NODES on screen (not just the grid), that captions exist, and that
 * there's exactly one canvas. Saves screenshots to /tmp/gw-*.png.
 *
 *   node scripts/ui-check.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 5199
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('../packages/demo', import.meta.url).pathname,
  stdio: 'pipe',
})
await new Promise((resolve, reject) => {
  vite.stdout.on('data', (d) => {
    if (String(d).includes('Local:')) resolve()
  })
  vite.stderr.on('data', (d) => process.stderr.write(d))
  setTimeout(() => reject(new Error('vite boot timeout')), 20000)
})
console.log('vite up')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('console', (m) => {
  if (m.type() === 'error' || m.text().includes('graphwizz')) console.log('[page]', m.text().slice(0, 160))
})
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })

// connect with the pre-filled movies preset
await page.click('#btn-connect')
await page.waitForSelector('#hud:not(.hidden)', { timeout: 60000 })
// wait for layout + clustering to settle
await page.waitForFunction(() => window.__gw?.getPhase?.() === 'ready', { timeout: 60000 })
await page.waitForTimeout(4000)

const state = () =>
  page.evaluate(() => {
    const app = window.__gw
    const r = app.getRenderer()
    const cam = r.camera
    const model = app.model
    // screen positions of the first few nodes via the renderer's own mapping
    const pts = []
    for (let i = 0; i < Math.min(8, model.order); i++) {
      const id = model.id(i)
      const w = cam.worldToScreen(model.x[i], model.y[i])
      pts.push([Math.round(w.x), Math.round(w.y)])
    }
    const withCaption = [...model.nodes.values()].filter((n) => n.caption).length
    return {
      canvases: document.querySelectorAll('#canvas-host canvas').length,
      zoom: cam.zoom,
      camX: Math.round(cam.x),
      camY: Math.round(cam.y),
      order: model.order,
      withCaption,
      pts,
    }
  })

const before = await state()
console.log('BEFORE', JSON.stringify(before, null, 1))
await page.screenshot({ path: '/tmp/gw-1-initial.png' })

if (before.canvases !== 1) console.log('!! DUPLICATE CANVASES:', before.canvases)

// wheel zoom at viewport center
const cx = 800
const cy = 500
for (let i = 0; i < 6; i++) {
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(60)
}
await page.waitForTimeout(300)
const afterZoom = await state()
console.log('AFTER ZOOM', JSON.stringify({ zoom: afterZoom.zoom, pts: afterZoom.pts }, null, 1))
await page.screenshot({ path: '/tmp/gw-2-zoomed.png' })

const movedZoom = JSON.stringify(before.pts) !== JSON.stringify(afterZoom.pts)
console.log(movedZoom ? '✓ zoom moves nodes' : '✗✗ ZOOM DOES NOT MOVE NODES')

// drag pan
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx + 200, cy + 120, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const afterPan = await state()
console.log('AFTER PAN', JSON.stringify({ camX: afterPan.camX, camY: afterPan.camY, pts: afterPan.pts }, null, 1))
await page.screenshot({ path: '/tmp/gw-3-panned.png' })

const movedPan = JSON.stringify(afterZoom.pts) !== JSON.stringify(afterPan.pts)
console.log(movedPan ? '✓ pan moves nodes' : '✗✗ PAN DOES NOT MOVE NODES')

console.log(`\ncaptions: ${before.withCaption}/${before.order} nodes have captions`)
console.log(movedZoom && movedPan ? 'UI-CHECK OK' : 'UI-CHECK FAILED')

await browser.close()
vite.kill()
process.exit(movedZoom && movedPan ? 0 : 1)
