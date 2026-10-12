import { fetchScenarios, fetchRun, type RunParams } from './api'
import type { ScenarioInfo, Timeline } from './model/timeline'
import { Player } from './player/player'
import { Scene } from './scene/scene'
import { Chrome } from './ui/chrome'
import { Controls } from './controls'
import { parseShare, buildShare } from './share'
import { EventLog } from './ui/eventlog'
import { TimelineBar } from './ui/timeline'
import { createUploadPanel, traceFacts } from './ui/uploadtrace'
import { midAliases } from './scene/layout'
import { t, getLang, scenarioTitle, scenarioDesc } from './i18n'
import { subscribe as subscribeUiMode, getState as getUiModeState, type UiState } from './ui/uimode'
import { allowPlaybackShortcut } from './ui/shortcuts'
import { createPresentMode } from './ui/present'
import { Inspector } from './ui/inspector'

// A run either replays a curated scenario (fetched via fetchRun, share-able,
// remembered as lastRun for re-runs) or replays a trace the visitor uploaded
// (fetched via postTrace inside the upload panel, not share-able). Both
// converge on the same scene/chrome/player wiring in applyTimeline below.
type TimelineSource = { kind: 'scenario'; params: RunParams } | { kind: 'custom'; fileName: string }

// Composition root: builds the DOM chrome (header + GC strip + legend) around the
// canvas stage and the control bar, then on each run fetches a Timeline,
// (re)configures the scene + chrome, and drives both from a fresh virtual-clock
// Player. The old player is paused so only one clock ticks.
async function boot(): Promise<void> {
  document.documentElement.lang = getLang()
  const root = document.getElementById('app')
  if (!root) throw new Error('#app not found')

  // Phase-1 pixel-art demo (static iso scene, no data): /?iso
  if (new URLSearchParams(location.search).has('iso')) {
    const { renderIsoDemo } = await import('./scene/demo')
    await renderIsoDemo(root)
    return
  }

  let scenarios: ScenarioInfo[]
  try {
    scenarios = await fetchScenarios()
    if (!scenarios.length) throw new Error(t().boot.noScenarios)
  } catch (e) {
    showFatal(root, t().boot.loadFail, e)
    return
  }

  const stage = document.createElement('div')
  stage.className = 'stage'
  const chrome = new Chrome(stage)
  const errorBox = document.createElement('div')
  errorBox.className = 'app-error'
  errorBox.style.display = 'none'
  stage.append(errorBox)

  let scene: Scene | null = null
  let player: Player | null = null
  let timeline: Timeline | null = null

  const inspector = new Inspector()
  const workspace = document.createElement('div')
  workspace.className = 'scene-workspace'
  workspace.append(stage, inspector.root)
  inspector.onSelect = selection => {
    player?.pause()
    scene?.setSelection(selection)
    controls.inspectBtn.setAttribute('aria-expanded', String(!inspector.root.hidden))
    for (const pill of stage.querySelectorAll('.proc-pill')) {
      pill.setAttribute('aria-pressed', String(selection?.kind === 'p' && Number((pill as HTMLElement).dataset.pid) === selection.id))
    }
    controls.sync()
  }
  inspector.onClose = () => controls.inspectBtn.focus({ preventScroll: true })
  inspector.onSeek = ns => { player?.pause(); player?.seek(ns); controls.sync() }
  chrome.onSelectProc = pid => inspector.select({ kind: 'p', id: pid })

  const eventLog = new EventLog()
  // The unified timeline sits in the control panel, just above the transport row.
  const timelineBar = new TimelineBar()
  timelineBar.onSeek = (ns) => {
    player?.pause()
    player?.seek(ns)
    controls.sync()
  }
  root.append(chrome.header, workspace, eventLog.root, chrome.legend, timelineBar.root)
  const controls = new Controls(
    root,
    scenarios,
    (p) => void run(p),
    () => scene?.toggleIds() ?? false,
    () => scene?.toggleThreads() ?? false,
    (info) => {
      chrome.setScenario(info)
      // Picking a real scenario after a custom upload leaves custom mode —
      // Controls doesn't know about that transition trigger on its own (see
      // controls.ts setCustom), so main.ts drives it here. The upload panel
      // itself may still be open (e.g. the user switched scenarios mid
      // upload); hide it too so it doesn't linger over the new run.
      controls.setCustom(false)
      uploadPanel.hide()
    },
    () => uploadPanel.show(),
    () => {
      if (!inspector.root.hidden) inspector.close()
      else { player?.pause(); inspector.open(); controls.inspectBtn.setAttribute('aria-expanded', 'true') }
    },
  )

  // "Upload your own trace" panel: shown over the stage in custom mode
  // (controls.ts onCustom above), hidden again once applyTimeline below has
  // applied the uploaded Timeline (or once the user switches scenarios, see
  // onScenarioChange above). uploadGen captures the shared runGen (declared
  // below, near run()) at the moment THIS upload started, so a stale upload
  // that resolves after something newer took over (another upload, or a
  // scenario run) is detected and dropped instead of clobbering it.
  let uploadGen = 0
  const uploadPanel = createUploadPanel(stage, {
    onUploadStart: () => {
      uploadGen = beginRun()
      // A newer upload supersedes any in-flight scenario fetch. That stale
      // fetch's own run() will see isCurrentRun() go false and skip applying
      // — but nothing would ever call controls.setLoading(false) for it
      // (only a future run() call does), leaving the Run button stuck on
      // "Running…" forever. Clear it proactively here instead of waiting.
      controls.setLoading(false)
    },
    onUploaded: (tl, fileName) => {
      if (!isCurrentRun(uploadGen)) return // superseded while the upload was in flight
      void applyTimeline(tl, { kind: 'custom', fileName }).catch((e) => {
        errorBox.textContent = t().boot.runError(msg(e))
        errorBox.style.display = 'block'
      })
    },
  })

  // Learn/Full UI mode: main.ts is the single subscriber, fanning the shared
  // uimode state out to setter methods on Controls/Chrome/EventLog.
  const applyUiMode = (s: UiState) => {
    controls.setMode(s.mode)
    chrome.setMode(s.mode)
    eventLog.setVisible(s.mode === 'full')
    chrome.setPresent(s.present)
  }
  subscribeUiMode(applyUiMode)
  applyUiMode(getUiModeState())

  // Present mode: distraction-free fullscreen, entered via F/the header button,
  // exited via F/Escape/the wand's close button/the browser's own fullscreen
  // exit. player is a mutable `let` reassigned per run (see applyTimeline
  // below), so present.ts reads it through this closure rather than by value.
  const present = createPresentMode({
    chrome,
    playerRef: () => player,
    onPlayerToggle: () => controls.sync(),
  })
  chrome.presentBtn.addEventListener('click', () => present.toggle())

  const intro = makeIntro(stage)

  ;(globalThis as Record<string, unknown>).gmp = {
    get player() {
      return player
    },
    get scene() {
      return scene
    },
    get timeline() {
      return timeline
    },
  }

  function scenarioInfo(id: string): ScenarioInfo | undefined {
    return scenarios.find((s) => s.id === id)
  }

  // updateShareUrl mirrors the current run (and, when paused, the playhead)
  // into the address bar so the view is shareable. replaceState only — no
  // history spam; never called while playing (see onTick).
  let lastRun: RunParams | null = null
  let lastUrl = ''
  function updateShareUrl(t?: number): void {
    if (!lastRun) return
    const qs = buildShare({ ...lastRun, t })
    if (qs === lastUrl) return
    lastUrl = qs
    history.replaceState(null, '', `${location.pathname}?${qs}`)
  }

  // applyTimeline is the reusable core shared by a scenario run and a custom
  // upload: (re)configure the scene + chrome from a freshly-fetched Timeline,
  // then drive it from a fresh virtual-clock Player. Everything specific to
  // where the Timeline came from (share-URL bookkeeping vs. custom title/
  // assumptions) branches on `source`.
  async function applyTimeline(tl: Timeline, source: TimelineSource): Promise<void> {
    timeline = tl
    if (source.kind === 'scenario') {
      lastRun = source.params
      updateShareUrl()
    } else {
      lastRun = null
      // Not dead: updateShareUrl only early-returns on !lastRun, which covers
      // calls made WHILE lastRun is null (e.g. onTick during custom
      // playback), but NOT the next scenario run's updateShareUrl() call once
      // lastRun is set again. Without resetting lastUrl here, that next call
      // could compute the same qs as before this custom trace was loaded and
      // skip replaceState — leaving the address bar stripped of the scenario
      // query string this replaceState below just removed.
      lastUrl = ''
      history.replaceState(null, '', location.pathname)
    }
    player?.pause()
    if (!scene) {
      scene = await Scene.create(stage, tl.meta.numProcs)
      scene.onLayout = () => chrome.layout()
      scene.onSelect = selection => inspector.select(selection)
      chrome.attachScene(scene)
    } else {
      scene.reset(tl.meta.numProcs)
    }
    scene.loadTimeline(tl)
    chrome.setProcs(tl.meta.numProcs)
    chrome.setTimeline(tl)
    timelineBar.setTimeline(tl)
    eventLog.build(tl.events, midAliases(tl.events))
    inspector.setTimeline(tl)
    if (source.kind === 'scenario') {
      chrome.setScenario(scenarioInfo(source.params.scenario))
      intro.show(scenarioInfo(source.params.scenario))
    } else {
      chrome.setScenario(undefined)
      chrome.setCustomTitle(source.fileName, traceFacts(tl))
      chrome.addCustomAssumptionGroup()
      intro.show(undefined)
      controls.setCustom(true)
      uploadPanel.hide()
    }

    const sc = scene
    const p = new Player(tl)
    p.onTick = (w) => {
      sc.setWorld(w, p.playing)
      chrome.update(w, p.playing)
      timelineBar.render(w.t)
      eventLog.setT(w.t)
      inspector.update(w)
      controls.sync()
      // Paused emits are discrete (seek/step/pause) — safe to mirror into the
      // URL; while playing the URL keeps the run params without t.
      if (!p.playing) updateShareUrl(w.t)
    }
    player = p
    controls.bindPlayer(p)
    p.emit()
    p.play()
  }

  // Scenario picks auto-run (see controls.ts) and a custom upload can be
  // dropped in at any time, so a scenario fetch and an upload can be in flight
  // together; this ONE shared counter is how either path tells "am I still
  // the most recent thing the user asked for" before it's allowed to call
  // applyTimeline. Both run() (below) and the upload wiring (above,
  // onUploadStart/onUploaded) bump/check the same counter — a separate
  // counter per path would not prevent one path's stale result from
  // clobbering the other's fresh one.
  let runGen = 0
  function beginRun(): number {
    return ++runGen
  }
  function isCurrentRun(gen: number): boolean {
    return gen === runGen
  }

  async function run(params: RunParams): Promise<void> {
    const gen = beginRun()
    controls.setLoading(true)
    errorBox.style.display = 'none'
    try {
      const tl = await fetchRun(params)
      if (!isCurrentRun(gen)) return // superseded by a newer run/upload while fetching
      await applyTimeline(tl, { kind: 'scenario', params })
    } catch (e) {
      if (!isCurrentRun(gen)) return
      errorBox.textContent = t().boot.runError(msg(e))
      errorBox.style.display = 'block'
    } finally {
      // A superseded run must not clear the loading state the newer one set.
      if (isCurrentRun(gen)) controls.setLoading(false)
    }
  }

  // A shared URL preselects the run (and the paused moment); otherwise boot
  // with the first scenario's defaults.
  const share = parseShare(location.search)
  if (share.scenario && scenarioInfo(share.scenario)) {
    controls.setParams(share)
  } else {
    const first = scenarios[0]
    const firstGoroutines = first.params.find((p) => p.name === 'goroutines')?.default ?? 50
    controls.setParams({ scenario: first.id, gomaxprocs: 4, goroutines: firstGoroutines })
  }
  await run(controls.params())
  if (share.t !== undefined && player) {
    const p = player as Player
    p.pause()
    p.seek(Math.min(share.t, p.duration))
    controls.sync()
  }

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code === 'Escape') {
      if (getUiModeState().present) present.exit()
      else if (!inspector.root.hidden) inspector.close()
      return
    }
    if (!allowPlaybackShortcut(e.target)) return
    if (e.code === 'Space') {
      e.preventDefault()
      player?.toggle()
      controls.sync() // keyboard toggle doesn't emit a tick when pausing — sync the label
    } else if (e.code === 'KeyF') {
      present.toggle()
    }
  })
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// showFatal renders a blocking error card when the app can't even start (e.g. the
// backend is down on first load) instead of leaving a blank page.
function showFatal(root: HTMLElement, title: string, e: unknown): void {
  const card = document.createElement('div')
  card.className = 'fatal'
  const h = document.createElement('div')
  h.className = 'fatal-title'
  h.textContent = title
  const p = document.createElement('div')
  p.className = 'fatal-msg'
  p.textContent = t().boot.backendHint(msg(e))
  const btn = document.createElement('button')
  btn.textContent = t().boot.retry
  btn.addEventListener('click', () => location.reload())
  card.append(h, p, btn)
  root.append(card)
}

// makeIntro builds a dismissible "what am I looking at" card. It appears on every
// scenario CHANGE (re-running the same scenario doesn't nag): the first time with
// the full G/P/M primer, afterwards as a short "what this scenario teaches" note.
function makeIntro(stage: HTMLElement): { show(info: ScenarioInfo | undefined): void } {
  const card = document.createElement('div')
  card.className = 'intro'
  const title = document.createElement('div')
  title.className = 'intro-title'
  const body = document.createElement('div')
  body.className = 'intro-body'
  const close = document.createElement('button')
  close.textContent = t().intro.gotIt
  close.addEventListener('click', () => (card.style.display = 'none'))
  card.append(title, body, close)
  card.style.display = 'none'
  stage.append(card)
  const PRIMER = t().intro.primer
  let primerShown = false
  let lastId: string | null = null
  return {
    show(info) {
      const id = info?.id ?? null
      if (id === lastId) return // same scenario re-run — don't nag
      lastId = id
      const desc = scenarioDesc(info)
      const teach = desc ? `<span class="intro-teach">${desc}</span>` : ''
      if (!primerShown) {
        primerShown = true
        body.innerHTML = PRIMER + (teach ? `<br>${teach}` : '')
      } else {
        if (!teach) return // nothing scenario-specific to say
        body.innerHTML = teach
      }
      title.textContent = info ? scenarioTitle(info) : t().intro.defaultTitle
      card.style.display = 'flex'
    },
  }
}

void boot()
