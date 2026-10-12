// Actual browser interaction checks for resource selection and timestamp stepping.
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const url = process.env.SHOOT_URL ?? 'http://127.0.0.1:5173'
const out = process.env.SHOOT_OUT ?? '/tmp/gmp-inspector'
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
let checks = 0
function check(ok, name) { if (!ok) throw new Error(name); checks++; console.log('PASS', name) }
try {
  await page.goto(`${url}/?scenario=syscalls`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => globalThis.gmp?.player?.duration > 0)
  if (await page.locator('.intro button').isVisible()) await page.locator('.intro button').click()
  await page.evaluate(() => { const p = globalThis.gmp.player; p.pause(); p.seek(p.duration * .3) })
  const point = await page.evaluate(() => {
    const { scene } = globalThis.gmp
    const [id, rec] = [...scene.gophers].find(([, r]) => r.kind !== 'dead')
    const b = rec.g.container.getBounds(), r = document.querySelector('.stage').getBoundingClientRect()
    return { id, x: r.left + b.x + b.width / 2, y: r.top + b.y + b.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  check(await page.locator('.inspector').isVisible(), 'clicking an actual G opens the inspector')
  check((await page.locator('.inspector-title').textContent()) === `G${point.id}`, 'G selection preserves the real gid')
  check(await page.evaluate(() => !globalThis.gmp.player.playing), 'object selection pauses playback')
  await page.screenshot({ path: `${out}/desktop.png` })
  await page.keyboard.press('Escape')
  check(!(await page.locator('.inspector').isVisible()), 'Escape closes a scene-opened inspector')
  check(await page.locator('.inspect-btn').evaluate(e => document.activeElement === e), 'closing restores keyboard focus')

  // Pan must not accidentally pin an object at pointerup.
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 18, point.y + 12, { steps: 4 })
  await page.mouse.up()
  check(!(await page.locator('.inspector').isVisible()), 'dragging over a G pans without selecting')
  await page.locator('.proc-pill[data-pid="0"]').click()
  check((await page.locator('.inspector-title').textContent()) === 'P0', 'P label is a native inspect button')
  check(await page.locator('.proc-pill[data-pid="0"]').getAttribute('aria-pressed') === 'true', 'selected P has a visible and accessible selection state')
  await page.keyboard.press('Escape')
  check(!(await page.locator('.inspector').isVisible()), 'Escape closes inspector while the P button owns focus')

  // Native picker is the keyboard alternative to tiny world sprites.
  await page.locator('.inspect-btn').click()
  check(await page.locator('.inspector-picker').evaluate(e => document.activeElement === e), 'toolbar opens a focused keyboard resource picker')
  const mid = await page.locator('.inspector-picker optgroup[label="M"] option').first().getAttribute('value')
  await page.locator('.inspector-picker').selectOption(mid)
  check((await page.locator('.inspector-title').textContent()).includes('ThreadID'), 'M selection exposes ThreadID alongside its screen alias')
  const before = await page.evaluate(() => globalThis.gmp.player.t)
  await page.keyboard.press('Space')
  check(await page.evaluate(() => !globalThis.gmp.player.playing), 'Space in the resource picker does not start playback')
  await page.locator('.step-back-btn').click()
  check(await page.evaluate(t => globalThis.gmp.player.t < t, before), 'Back moves to a strictly earlier recorded timestamp')
  const nextTime = await page.evaluate(() => { const { player, timeline } = globalThis.gmp; return timeline.events.find(e => e.t > player.t)?.t ?? player.duration })
  await page.locator('.step-forward-btn').click()
  check(await page.evaluate(t => globalThis.gmp.player.t === t && !globalThis.gmp.player.playing, nextTime), 'forward stepping stays paused at the next timestamp')
  await page.locator('.inspector-raw summary').click()
  check(await page.locator('.inspector-raw pre').isVisible(), 'normalized event fields can be expanded')
  const event = page.locator('.inspector-event').first()
  await event.focus()
  const eventIndex = Number(await event.getAttribute('data-event-index'))
  await page.keyboard.press('Enter')
  check(await page.evaluate(i => globalThis.gmp.player.t === globalThis.gmp.timeline.events[i].t, eventIndex), 'history event seeks to its exact timestamp')
  check(await page.locator(`[data-event-index="${eventIndex}"]`).evaluate(e => document.activeElement === e), 'keyboard history selection retains focus after snapshot replacement')

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForTimeout(100)
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px: open inspector has no horizontal overflow`)
    check(await page.locator('.inspector').evaluate(e => e.getBoundingClientRect().width <= innerWidth), `${width}px: inspector fits viewport`)
    if (width === 375) await page.screenshot({ path: `${out}/mobile.png`, fullPage: true })
  }
  await page.locator('.inspector-close').click()
  const mPoint = await page.evaluate(() => {
    const { scene } = globalThis.gmp
    const [id, rec] = [...scene.threads].find(([, r]) => r.t.container.visible)
    const b = rec.t.container.getBounds(), r = document.querySelector('.stage').getBoundingClientRect()
    return { id, x: r.left + b.x + b.width / 2, y: r.top + b.y + b.height / 2 }
  })
  await page.mouse.click(mPoint.x, mPoint.y)
  check((await page.locator('.inspector-title').textContent()).includes(`ThreadID ${mPoint.id}`), 'clicking an actual M selects its ThreadID')
  await page.locator('.controls select').selectOption('gcpressure')
  await page.waitForFunction(() => globalThis.gmp.timeline.meta.scenario === 'gcpressure')
  check(!(await page.locator('.inspector').isVisible()), 'new trace clears stale selection and closes inspector')
  check(await page.locator('.inspect-btn').getAttribute('aria-expanded') === 'false', 'new trace resets inspector launcher state')
  check(errors.length === 0, `no browser errors (${errors.join('; ')})`)
  console.log(`\n${checks}/${checks} inspector checks passed`)
} finally { await browser.close() }
