// Control-verification harness: exercises every button/affordance and asserts the
// resulting player/timeline state, so "all buttons work" has concrete evidence.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const url = process.env.SHOOT_URL ?? 'http://localhost:5173'
const outDir = process.env.SHOOT_OUT ?? '/tmp'
// Every wait here is an upper bound sized for a warm dev machine, not an
// assertion about speed. A CI runner is slower and recording a trace costs real
// seconds, so let the environment stretch them instead of failing on hardware.
const SCALE = Number(process.env.CONTRACT_TIMEOUT_SCALE ?? 1)
const ms = (base) => Math.round(base * SCALE)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
// Locator actions have their own default budget; scale it too, or a slow
// machine times out inside a click while every explicit wait is still generous.
page.setDefaultTimeout(ms(30000))
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

const results = []
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); }

// Results are only printed at the end, so anything that throws mid-run would
// otherwise take the whole picture with it. On an abort, say how far we got and
// what Playwright was waiting for — its message names the offending locator.
const onAbort = async (e) => {
  // Reason first: annotation budget is small, and "what broke" beats "what
  // worked". The last completed check is what locates the abort in the script.
  console.log('\nabort reason:', String(e?.message ?? e).split('\n').slice(0, 6).join(' / '))
  console.log(`CONTRACT ABORTED after ${results.length} checks, last one: ${results.at(-1)?.name ?? '(none)'}`)
  for (const r of results.filter((r) => !r.pass)) console.log(`  FAIL  ${r.name}`)
  console.log('page errors:', errors.length ? errors.join(' ; ') : 'none')
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`)
  await page.screenshot({ path: `${outDir}/abort.png` }).catch(() => {})
  await browser.close().catch(() => {})
  process.exit(1)
}
// A rejected top-level await surfaces as an uncaught exception, not an
// unhandled rejection — listening only for the latter reports nothing.
process.on('uncaughtException', onAbort)
process.on('unhandledRejection', onAbort)

// Not 'networkidle': the app records a trace on boot, so the network is busy by
// design and idleness never arrives on a slow machine. The real readiness
// signal is the timeline below.
await page.goto(url, { waitUntil: 'domcontentloaded' })
// The first run has to travel the whole pipeline, so when it does not arrive the
// useful question is "what did the app say", not "which line timed out".
try {
  await page.waitForFunction(() => globalThis.gmp?.player?.duration > 0, { timeout: ms(20000) })
} catch (e) {
  const appError = await page.locator('.app-error').textContent().catch(() => null)
  const fatal = await page.locator('.fatal').textContent().catch(() => null)
  console.log('BOOT FAILED: no timeline within', ms(20000), 'ms')
  console.log('  app error box:', appError?.trim() || '(empty)')
  console.log('  fatal card:   ', fatal?.trim() || '(none)')
  console.log('  page errors:  ', errors.length ? errors.join(' ; ') : 'none')
  console.log('  gmp present:  ', await page.evaluate(() => Boolean(globalThis.gmp)))
  await page.screenshot({ path: `${outDir}/boot-failure.png` }).catch(() => {})
  await browser.close()
  process.exit(1)
}

const playBtn = page.locator('.controls button').first() // play/pause toggle (label flips)
const stepBtn = page.locator('.controls button', { hasText: 'Шаг' }).first()
const btn = (label) => page.locator('.controls button', { hasText: label }).first()
const state = () => page.evaluate(() => {
  const p = globalThis.gmp.player
  return { playing: p.playing, speed: p.speed, t: p.t, duration: p.duration, scenario: globalThis.gmp.timeline?.meta?.scenario, numProcs: globalThis.gmp.timeline?.meta?.numProcs }
})
const ensurePaused = async () => { if ((await state()).playing) { await playBtn.click(); await page.waitForTimeout(120) } }

// dismiss intro card if present
await page.locator('.intro button', { hasText: 'Понятно' }).click().catch(() => {})

// 1. Pause then Play (the app auto-plays on load)
await ensurePaused()
ok('pause stops the clock', (await state()).playing === false)
await playBtn.click()
await page.waitForTimeout(300)
ok('play starts the clock', (await state()).playing === true)
ok('play button label flips to Пауза', (await playBtn.textContent()).includes('Пауза'))

// 2. Pause
await playBtn.click()
await page.waitForTimeout(150)
let s = await state()
ok('pause stops the clock again', s.playing === false)
ok('play button label flips to Играть', (await playBtn.textContent()).includes('Играть'))

// 3. Step while paused advances and stays paused
const before = (await state()).t
await stepBtn.click()
await page.waitForTimeout(120)
s = await state()
ok('step advances time', s.t > before, `t ${before}->${s.t}`)
ok('step stays paused', s.playing === false)

// 4. Step while PLAYING pauses (regression for the step-no-op bug)
await playBtn.click()
await page.waitForTimeout(150)
await stepBtn.click()
await page.waitForTimeout(150)
ok('step while playing pauses', (await state()).playing === false)

// 5. Speed chips
await btn('2×').click()
ok('speed 2x applies', (await state()).speed === 2)
await btn('0.5×').click()
ok('speed 0.5x applies', (await state()).speed === 0.5)

// 6. Scrub jumps and pauses
await page.evaluate(() => {
  const sc = document.querySelector('.controls input[type=range]')
  sc.value = '600'
  sc.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(150)
s = await state()
ok('scrub seeks (~60%)', Math.abs(s.t / s.duration - 0.6) < 0.02, `${(s.t / s.duration).toFixed(3)}`)
ok('scrub pauses', s.playing === false)

// 7. Learn/Full UI-mode toggle. The mode button carries a stable `.mode-btn`
// class, so select it directly (id/M use `aria-pressed`, not a stable class).
// This block runs BEFORE the id/M toggles below and deliberately leaves the app
// in Full mode afterward, because `.controls-advanced` (id/M/GOMAXPROCS
// stepper/goroutines) is display:none in Learn mode and 7a/7b need it clickable.
const modeBtn = page.locator('.controls .mode-btn').first()
const legendVisibleCount = () => page.locator('.chrome-legend .leg-item:visible').count()
ok(
  'starts in Learn mode: event log and legend items hidden',
  (await page.locator('.event-log').isVisible()) === false && (await legendVisibleCount()) === 0,
)
await modeBtn.click() // → Full mode
ok(
  'mode toggle reveals the event log and legend',
  (await page.locator('.event-log').isVisible()) === true && (await legendVisibleCount()) > 0,
)

// 7a. id toggle — depends on 7 above leaving the app in Full mode.
const idBtn = page.locator('.controls button', { hasText: /^id$/ }).first()
const mBtn = page.locator('.controls button', { hasText: /^M$/ }).first()
ok('id/M buttons are visible in Full mode', (await idBtn.isVisible()) && (await mBtn.isVisible()))
const wasActive = await idBtn.evaluate((e) => e.classList.contains('active'))
await idBtn.click()
ok('id toggle flips state', (await idBtn.evaluate((e) => e.classList.contains('active'))) !== wasActive)

// 7b. M (OS thread) toggle
const mWasActive = await mBtn.evaluate((e) => e.classList.contains('active'))
await mBtn.click()
ok('M toggle flips state', (await mBtn.evaluate((e) => e.classList.contains('active'))) !== mWasActive)
await mBtn.click() // back on: carriers visible for the screenshots below

// 7c. mode toggle back to Learn mode: event log + legend hide again
await modeBtn.click() // → Learn mode
ok(
  'mode toggle hides the event log and legend',
  (await page.locator('.event-log').isVisible()) === false && (await legendVisibleCount()) === 0,
)

// 7d. hard project rule: the assumptions disclosure is never hidden by the
// UI-mode toggle, even though it lives under `.chrome-legend` alongside the
// legend items that Learn mode does hide.
ok('assumptions line stays visible in Learn mode', await page.locator('.assumptions summary').isVisible())

// 7e. assumptions disclosure under the legend
const assume = page.locator('.assumptions summary')
await assume.click()
ok('assumptions panel opens', await page.locator('.assumptions').evaluate((e) => e.open))
ok('assumptions disclose unobservable queues and stealing', /Work stealing нельзя/.test(await page.locator('.assume-body').textContent()))
// Closing is cleanup, not a control under test. Expanding the panel resizes the
// stage, which relays out the Pixi canvas, so a click here waits for the summary
// to stop moving — a wait a slow machine loses. Set the state directly instead.
await page.locator('.assumptions').evaluate((e) => { e.open = false })

// 8. Scenario change auto-runs (no Запустить needed) → gcpressure (real GC)
await page.evaluate(() => {
  const sel = document.querySelector('.controls select'); sel.value = 'gcpressure'; sel.dispatchEvent(new Event('change'))
})
await page.waitForFunction(() => globalThis.gmp.timeline?.meta?.scenario === 'gcpressure', { timeout: ms(20000) }).catch(() => {})
ok('scenario change runs automatically', (await state()).scenario === 'gcpressure')
ok('intro card reappears for the new scenario', await page.locator('.intro').isVisible())
await page.locator('.intro button', { hasText: 'Понятно' }).click().catch(() => {})
const gcReadout = await page.locator('.gc-readout').textContent()
ok('GC readout shows complete mark phases', /\d+ фаз mark/.test(gcReadout), gcReadout)
// the DOM GC-strip was replaced by the unified timeline canvas; assert STW from the
// real trace data + that the timeline canvas is present.
const stwCount = await page.evaluate(() =>
  globalThis.gmp.timeline.events.filter(
    (e) => e.type === 'gc_range_begin' && /stop-the-world/.test(e.name || '') && !/start trace/.test(e.name || ''),
  ).length,
)
ok('trace surfaces real STW ranges', stwCount > 0, `${stwCount} STW`)
ok('unified timeline canvas present', (await page.locator('.timeline canvas').count()) === 1)

// 8a. custom-trace chip opens the upload panel. No real upload here — there's
// no .trace file to upload in this environment, and fabricating one would
// exercise a different path than a real user's file picker/drag-drop. The
// chip only renders when the dev server isn't a static-demo build (see
// controls.ts / isStaticDemo), so it being visible also confirms that.
const customChip = page.locator('.chip[data-id="custom"]')
ok('custom-trace chip is visible', await customChip.isVisible())
const panelHiddenBefore = !(await page.locator('.upload-panel').isVisible())
await customChip.click()
const panelVisibleAfter = await page.locator('.upload-panel').isVisible()
ok('custom-trace chip opens the upload panel', panelHiddenBefore && panelVisibleAfter)
await page.locator('.upload-close').click()

// 9. GOMAXPROCS change + run
await page.evaluate(() => {
  const inp = document.querySelectorAll('.controls input[type=number]')[0]; inp.value = '2'; inp.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.locator('.controls button', { hasText: 'Запустить' }).click()
await page.waitForTimeout(2500)
await page.waitForFunction(() => globalThis.gmp.timeline?.meta?.numProcs === 2, { timeout: ms(15000) }).catch(() => {})
ok('GOMAXPROCS change applies', (await state()).numProcs === 2)
ok('intro stays hidden on same-scenario re-run', !(await page.locator('.intro').isVisible()))

// 10. Capture a real STW moment: seek to a STW tick time
const stwShot = await page.evaluate(() => {
  const ev = globalThis.gmp.timeline.events
  const stw = ev.find((e) => e.type === 'gc_range_begin' && /stop-the-world/.test(e.name || '') && !/start trace/.test(e.name || ''))
  if (!stw) return null
  const p = globalThis.gmp.player
  p.pause(); p.seek(Math.max(0, stw.t - p.duration * 0.0005))
  return stw.t
})
await page.waitForTimeout(120)
await page.screenshot({ path: `${outDir}/verify-stw.png` })
ok('found a STW range to seek to', stwShot !== null)

// 11. language switcher: EN roundtrip (strings bake at boot, so it reloads)
await page.locator('.lang-btn').click()
await page.waitForFunction(() => globalThis.gmp?.player?.duration > 0, { timeout: ms(25000) })
ok('language switch to EN', /Go Scheduler/.test(await page.locator('.title').textContent()))
await page.locator('.lang-btn').click()
await page.waitForFunction(() => globalThis.gmp?.player?.duration > 0, { timeout: ms(25000) })
ok('language switch back to RU', /Планировщик Go/.test(await page.locator('.title').textContent()))

// 12. Present mode: F enters (body.present + controls hidden), Escape exits
// (class cleared + controls restored). requestFullscreen() is best-effort in
// present.ts and typically rejects headless — only the CSS-driven class/
// visibility are asserted here, never document.fullscreenElement.
await page.keyboard.press('f')
await page.waitForTimeout(150)
ok('present mode: F sets body.present', await page.evaluate(() => document.body.classList.contains('present')))
ok('present mode: controls hidden', !(await page.locator('.controls').isVisible()))
await page.keyboard.press('Escape')
await page.waitForTimeout(150)
ok('present mode: Escape clears body.present', !(await page.evaluate(() => document.body.classList.contains('present'))))
ok('present mode: controls visible again', await page.locator('.controls').isVisible())

// 13. Custom-trace upload, end to end. Check 8a only opened the panel; this
// one feeds a real recording through the same <input type=file> the file
// picker fills, so the parse → Timeline → replay path is what gets asserted.
// It runs last on purpose: the uploaded trace replaces the scenario, and
// "Запустить" means nothing while a custom trace is loaded.
// testdata/upload.trace is a real recording (20 CPU-bound goroutines handing
// results over a channel, GOMAXPROCS=4, go1.26.2) — data, not source.
const fixture = fileURLToPath(new URL('./testdata/upload.trace', import.meta.url))
await page.locator('.chip[data-id="custom"]').click()
await page.locator('.upload-panel input[type=file]').setInputFiles(fixture)
// The upload posts to a real backend, which parses the trace: allow for a
// cold CI runner rather than a warm dev machine.
await page
  .waitForFunction(() => globalThis.gmp.timeline?.meta?.scenario === 'custom', { timeout: ms(25000) })
  .catch(() => {})
const uploaded = await state()
ok(
  'uploaded .trace replays as a custom timeline',
  uploaded.scenario === 'custom' && uploaded.numProcs === 4 && uploaded.duration > 0,
  `scenario=${uploaded.scenario} procs=${uploaded.numProcs} duration=${Math.round(uploaded.duration)}`,
)

console.log('\n=== CONTROL VERIFICATION ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log('console errors:', errors.length ? errors : 'none')
await browser.close()
process.exit(failed.length || errors.length ? 1 : 0)
