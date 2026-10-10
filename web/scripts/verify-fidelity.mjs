// Browser regressions for the boundary between trace states and drawn states.
// Run against Vite and the local Go backend, alongside verify-controls.mjs.
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const url = process.env.SHOOT_URL ?? 'http://localhost:5173'
const out = process.env.SHOOT_OUT ?? '/tmp/gmp-fidelity'
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
let checks = 0
function check(ok, name) { if (!ok) throw new Error(name); checks++; console.log('PASS', name) }
try {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => globalThis.gmp?.player?.duration > 0)
  await page.locator('.intro button').click()
  const scenarios = await page.evaluate(() => [...document.querySelector('.controls select').options].map(o => o.value))
  for (const scenario of scenarios) {
    await page.locator('.controls select').selectOption(scenario)
    await page.waitForFunction(s => globalThis.gmp.timeline.meta.scenario === s, scenario)
    const intro = page.locator('.intro button')
    if (await intro.isVisible()) await intro.click()
    const result = await page.evaluate(async () => {
      const { stateAt } = await import('/src/player/state.ts')
      const { placeIso, placeThreads } = await import('/src/scene/layout.ts')
      const { timeline, player, scene } = globalThis.gmp
      player.pause()
      const faults = []
      for (let i = 0; i <= 30; i++) {
        const time = timeline.meta.durationNs * i / 30
        player.seek(time)
        const world = stateAt(timeline, time)
        const counts = { running: 0, runnable: 0, waiting: 0, syscall: 0 }
        for (const g of world.goroutines.values()) if (g.state !== 'dead') counts[g.state]++
        const actual = [...document.querySelectorAll('.runtime-stat-count')].map(e => Number(e.textContent))
        if (actual.length !== 4 || actual.some((v, j) => v !== Object.values(counts)[j])) faults.push(`counts at ${i}`)
        for (const [gid, position] of placeIso(world, timeline.meta.numProcs)) {
          const rec = scene.gophers.get(gid)
          if (!rec || rec.kind !== world.goroutines.get(gid).state || rec.g.container.x !== position.x || rec.g.container.y !== position.y) faults.push(`G${gid} position/state at ${i}`)
        }
        for (const [mid, position] of placeThreads(world, timeline.meta.numProcs, placeIso(world, timeline.meta.numProcs))) {
          const rec = scene.threads.get(mid)
          if (!rec || rec.t.container.x !== position.x || rec.t.container.y !== position.y) faults.push(`M${mid} position at ${i}`)
        }
        const owners = world.procs.filter(p => p.mid >= 0).map(p => p.mid)
        if (new Set(owners).size !== owners.length) faults.push(`one M owns two Ps at ${i}`)
      }
      return { faults, stolen: timeline.events.some(e => e.stolen), snapshots: timeline.events.some(e => e.type === 'g_status'), end: timeline.events.at(-1).type }
    })
    check(result.faults.length === 0, `${scenario}: counts and G/M positions match the playhead at 31 points (${result.faults.slice(0, 3).join(', ')})`)
    check(!result.stolen && result.snapshots && result.end === 'trace_end', `${scenario}: snapshots, full end timestamp, no invented stealing`)
    await page.evaluate(() => { const p = globalThis.gmp.player; p.seek(p.duration * .3) })
    await page.screenshot({ path: `${out}/${scenario}.png` })
  }
  await page.evaluate(() => globalThis.gmp.player.play())
  await page.waitForTimeout(100)
  const paused = await page.evaluate(() => { globalThis.gmp.player.pause(); return { time: globalThis.gmp.player.t, anim: globalThis.gmp.scene.animT } })
  await page.waitForTimeout(120)
  check(await page.evaluate(p => globalThis.gmp.player.t === p.time && globalThis.gmp.scene.animT === p.anim, paused), 'pause freezes trace time and decorative animation')

  await page.locator('.chip[data-id="custom"]').click()
  check(await page.locator('.upload-choose').evaluate(e => e === document.activeElement), 'upload receives keyboard focus')
  await page.keyboard.press('Escape')
  check(!(await page.locator('.upload-panel').isVisible()), 'Escape closes upload')
  check(await page.locator('.chip[data-id="custom"]').evaluate(e => e === document.activeElement), 'closing upload restores focus')

  // Controlled trace sequences isolate renderer regressions without requiring
  // a specific scheduler interleaving from a nondeterministic real run.
  const renderer = await page.evaluate(async () => {
    const { stateAt } = await import('/src/player/state.ts')
    const { scene } = globalThis.gmp
    scene.reset(1)
    const ev = (t, type, extra = {}) => ({ t, type, gid: -1, pid: -1, mid: -1, ...extra })
    const tl = { meta: { scenario: 'renderer-regression', numProcs: 1, durationNs: 10000, goroutines: [9] }, events: [
      ev(0, 'g_create', { gid: 9 }), ev(1, 'g_run_start', { gid: 9, pid: 0, mid: 7 }),
      ev(2, 'gc_range_begin', { name: 'stop-the-world (GOMAXPROCS)' }),
      ev(500, 'gc_range_end', { name: 'stop-the-world (GOMAXPROCS)' }), ev(1000, 'g_exit', { gid: 9, pid: 0, mid: 7 }), ev(10000, 'trace_end'),
    ] }
    scene.loadTimeline(tl)
    scene.setWorld(stateAt(tl, 3), true)
    const before = scene.animT
    scene.tick(100)
    const stwRunning = scene.gophers.get(9)?.kind === 'running' && scene.animT > before
    scene.setWorld(stateAt(tl, 900), true)
    scene.setWorld(stateAt(tl, 1000), true)
    for (let i = 1; i <= 20; i++) { scene.setWorld(stateAt(tl, 1000 + i), true); scene.tick(20) }
    const deadGone = !scene.gophers.has(9)
    scene.setWorld(stateAt(tl, 100), false)
    const revived = scene.gophers.get(9)
    return { stwRunning, deadGone, revived: revived?.g.container.scale.x === 1 && revived?.g.container.alpha === 1 }
  })
  check(renderer.stwRunning, 'recorded STW range does not override a Running G with an inferred global freeze')
  check(renderer.deadGone, 'repeated playback frames do not restart the death fade')
  check(renderer.revived, 'seeking backwards restores a live sprite at full alpha and scale')

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => globalThis.gmp?.player?.duration > 0)
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    if (await page.locator('.intro').isVisible()) {
      const contained = await page.locator('.intro button').evaluate(e => {
        const button = e.getBoundingClientRect(), card = e.closest('.intro').getBoundingClientRect(), stage = e.closest('.stage').getBoundingClientRect()
        return button.top >= card.top && button.bottom <= card.bottom && card.top >= stage.top && card.bottom <= stage.bottom
      })
      check(contained, `${width}px: primer dismiss button stays visible inside the stage`)
      await page.screenshot({ path: `${out}/primer-${width}.png` })
      await page.locator('.intro button').click()
    }
    const responsive = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      small: [...document.querySelectorAll('button')].filter(e => e.offsetParent && (e.getBoundingClientRect().width < 43.5 || e.getBoundingClientRect().height < 43.5)).map(e => e.className),
    }))
    check(!responsive.overflow && responsive.small.length === 0, `${width}px: no horizontal overflow, visible buttons at least 44px (${responsive.small})`)
    const track = page.locator('.timeline-canvas')
    const box = await track.evaluate(e => ({ width: e.clientWidth, height: e.clientHeight }))
    // Playwright locator click positions are relative to the padding box.
    await track.click({ position: { x: 8, y: box.height / 2 } })
    const atStart = await page.evaluate(() => globalThis.gmp.player.t === 0)
    await track.click({ position: { x: box.width - 8, y: box.height / 2 } })
    const atEnd = await page.evaluate(() => globalThis.gmp.player.t === globalThis.gmp.player.duration)
    check(atStart && atEnd, `${width}px: clicks on the drawn track endpoints seek to exact trace start/end`)
    await page.evaluate(() => { const p = globalThis.gmp.player; p.seek(p.duration * .3) })
    await page.screenshot({ path: `${out}/width-${width}.png` })
  }
  check(errors.length === 0, `no browser errors (${errors.join('; ')})`)
  console.log(`\n${checks}/${checks} fidelity checks passed`)
} finally { await browser.close() }
