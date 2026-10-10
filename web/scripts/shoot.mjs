// Headless screenshot harness: loads the app, seeks the player to a few points
// in the trace, and writes a PNG per point so the canvas scene can be reviewed
// without a human in the loop.
//
// Usage (with backend + vite dev already running):
//   SHOOT_URL=http://localhost:5176 node scripts/shoot.mjs
import { chromium } from 'playwright'

const url = process.env.SHOOT_URL ?? 'http://localhost:5173'
const outDir = process.env.SHOOT_OUT ?? '/tmp'
const fractions = [0.05, 0.15, 0.45, 0.85]
const delay = Number(process.env.SHOOT_DELAY ?? 550)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForFunction(
  () => {
    const g = /** @type {any} */ (globalThis).gmp
    return Boolean(g && g.player && g.player.duration > 0)
  },
  { timeout: 20000 },
)

for (const f of fractions) {
  await page.evaluate((frac) => {
    const p = /** @type {any} */ (globalThis).gmp.player
    p.pause()
    p.seek(p.duration * frac)
  }, f)
  await page.waitForTimeout(delay) // allow the canvas renderer to paint
  const path = `${outDir}/shoot-${Math.round(f * 100)}.png`
  await page.screenshot({ path })
  console.log('wrote', path)
}

console.log('console errors:', errors.length ? errors : 'none')
await browser.close()
process.exitCode = errors.length ? 1 : 0
