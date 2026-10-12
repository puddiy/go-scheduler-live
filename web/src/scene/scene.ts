import { Application, Container, Graphics, Texture, type FederatedPointerEvent } from 'pixi.js'
import type { GState, GoroutineView, WorldState } from '../player/state'
import { t as tr } from '../i18n'
import type { Timeline } from '../model/timeline'
import type { ResourceSelection } from '../ui/inspector'
import { gcSummary, stwInWindow, isPlaybackStep, STW_FLASH_MS, type GcSummary } from '../player/gc'
import { PAL, stateColors } from './palette'
import { gopherCanvas, type GopherOpts } from './drawgopher'
import {
  drawGrid,
  drawStation,
  drawIdleMarker,
  drawZoneFloor,
  drawProps,
  stationPositions,
  WORLD_W,
  WORLD_H,
  type Pt,
} from './iso'
import { GLOBAL, WAITING, SYSCALL, placeIso, placeThreads, zoneTotals, midAliases } from './layout'
import { buildBackdrop, type Backdrop } from './backdrop'
import { heapPct, gcPhase } from '../ui/derive'
import { heapTileCount } from './heap'
import { botTarget } from './bot'
import {
  drawBoothShell,
  drawBoothFx,
  drawBelt,
  drawHeapPile,
  drawRobot,
  drawSiren,
  HEAP_CENTER,
  BOT_DOCK,
  SIREN_POS,
} from './factory'
import { clampView, fitView, panBy, zoomAt, type View, type ViewBounds } from './viewport'
import { makeGopher, type Gopher } from './gopher'
import { threadCanvas } from './drawthread'
import { makeThread, type ThreadSprite } from './thread'

const POOF_MS = 320
// floor796-style viewport: wheel zooms toward the cursor up to MAX_ZOOM x the
// fit scale, drag pans, double-click resets. Id-tag Texts re-rasterize per
// integer zoom bucket so labels stay crisp instead of scaling blurry.
const MAX_ZOOM = 6
const WHEEL_SENS = 0.0015
const PAN_THRESHOLD_PX = 4
// The STW flash highlights a recorded range; individual G states remain authoritative.

// State names for tooltips come from the i18n dictionary (scene.states).

type AnimKind = GState

interface Rec {
  g: Gopher
  tx: number
  ty: number
  scale: number
  view?: GoroutineView
  kind: AnimKind
  phase: number // per-gopher animation phase offset (de-syncs the crowd)
  dying: number // dead-poof timer (ms remaining); 0 = alive
}

// bakeTextures bakes a small frame atlas per animated state once; the scene cycles
// the frames on a wall clock (see FPS) with a per-gopher phase offset.
function bakeTextures() {
  const t = (o: GopherOpts): Texture => {
    const tx = Texture.from(gopherCanvas(o))
    tx.source.scaleMode = 'nearest'
    return tx
  }
  const arr = (os: GopherOpts[]): Texture[] => os.map(t)
  return {
    running: arr([
      { state: 'running', work: true, armPhase: 1, laptop: true, screenLit: true },
      { state: 'running', work: true, armPhase: -1, laptop: true, screenLit: false },
    ]),
    runnable: arr([{ state: 'runnable' }]),
    waiting: arr([
      { state: 'waiting', zzz: true, zt: 0, blink: true },
      { state: 'waiting', zzz: true, zt: 0.34, blink: true },
      { state: 'waiting', zzz: true, zt: 0.68, blink: true },
    ]),
    syscall: arr([
      { state: 'syscall', flip: true, dots: 1 },
      { state: 'syscall', flip: true, dots: 2 },
      { state: 'syscall', flip: true, dots: 3 },
    ]),
    dead: arr([{ state: 'dead', dead: true }]),

  }
}

const FPS: Record<AnimKind, number> = { running: 8, runnable: 0, waiting: 4, syscall: 3, dead: 0 }

interface TRec {
  t: ThreadSprite
  tx: number
  ty: number
  scale: number
  phase: number
  tip: string
}

// bakeThreadTextures bakes the M carrier's frames: a 2-frame status-lamp blink
// with NEAREST sampling, like every sprite in the world.
function bakeThreadTextures() {
  const t = (o: Parameters<typeof threadCanvas>[0]): Texture => {
    const tx = Texture.from(threadCanvas(o))
    tx.source.scaleMode = 'nearest'
    return tx
  }
  return {
    idle: [t({ lit: true }), t({ lit: false })],
  }
}

const THREAD_BLINK_FPS = 2

// Scene renders the isometric pixel-art world: floor grid + cozy props + N
// P-stations (with idle-P markers), zone floor platters, and one gopher Sprite per
// goroutine placed by placeIso. A recorded STW range triggers a brief red cue;
// it does not override individual goroutine states.
export class Scene {
  /** fired after every fit() (resize) so DOM chrome can re-anchor zone pills. */
  onLayout?: () => void
  onSelect?: (selection: ResourceSelection) => void
  private selection: ResourceSelection | null = null
  private selectionDragged = false
  private readonly selectionG = new Graphics()

  private gophers = new Map<number, Rec>()
  private threads = new Map<number, TRec>()
  private readonly world = new Container()
  private readonly grid = new Graphics()
  private readonly stationsG = new Graphics()
  private readonly zoneFloorG = new Graphics()
  private readonly backdrop: Backdrop = buildBackdrop({ global: GLOBAL, waiting: WAITING, syscall: SYSCALL })
  private readonly fxG = new Graphics()
  private readonly gopherLayer = new Container()
  private readonly stwOverlay = new Graphics()
  private readonly tex = bakeTextures()
  private readonly ttex = bakeThreadTextures()
  private showIds = true
  private showThreads = true
  private animT = 0
  private tooltip!: HTMLDivElement
  private scale = 1
  private offX = 0
  private offY = 0
  private zoom = 1 // relative to the fit scale; 1 = whole world visible
  private tagRes = 1 // current id-tag rasterization bucket

  // event-cue state
  private midAlias = new Map<number, number>()
  private gc: GcSummary = { cycles: 0, stw: [], mark: [], maxStwNs: 0 }
  private durationNs = 0
  private lastT = -1
  private stwFlash = 0
  private stepPlayback = false // was the last setWorld a forward playback step (vs a scrub/seek)?
  private playbackActive = false
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  private heapCount = 2 // heap pile tile count from the real heap fill
  private gcMark = false // concurrent mark active → robot sweeps, heap pulses
  private stations: Pt[] = []
  private occupied: boolean[] = []
  private procStates: WorldState['procs'][number]['status'][] = []

  private constructor(
    private readonly app: Application,
    private numProcs: number,
  ) {
    this.gopherLayer.sortableChildren = true
    // world layers back→front: grid → zone platters/props → factory backdrop
    // (wall/gates/board/bunks/stalls) → P stations → fx → gophers+threads → STW.
    this.world.addChild(
      this.grid,
      this.zoneFloorG,
      this.backdrop.container,
      this.stationsG,
      this.fxG,
      this.selectionG,
      this.gopherLayer,
      this.stwOverlay,
    )
    app.stage.addChild(this.world)
    drawGrid(this.grid)
    this.grid.alpha = 0.5
    drawProps(this.zoneFloorG)
    this.buildStatics()
    this.fit()
    app.ticker.add((tk) => this.tick(tk.deltaMS))
  }

  static async create(parent: HTMLElement, numProcs: number): Promise<Scene> {
    const app = new Application()
    await app.init({ resizeTo: parent, background: PAL.bg0, antialias: false })
    parent.appendChild(app.canvas)

    const scene = new Scene(app, numProcs)
    scene.tooltip = makeTooltip(parent)
    scene.attachViewport(parent)
    // Observe the stage element itself, not just the window: the stage also
    // shrinks/grows when sibling DOM changes height (e.g. the assumptions
    // disclosure expands) — Pixi's resizeTo only reacts to window resizes, so
    // without this the canvas would overhang the stage and cover the DOM below.
    new ResizeObserver(() => {
      app.resize()
      scene.fit()
    }).observe(parent)
    return scene
  }

  // attachViewport wires the floor796-style gestures: wheel = zoom toward the
  // cursor, drag = pan (with a small threshold so hovering/tooltips survive),
  // double-click = back to the full world.
  private attachViewport(el: HTMLElement): void {
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = el.getBoundingClientRect()
        const factor = Math.exp(-e.deltaY * WHEEL_SENS)
        this.applyView(zoomAt(this.view(), this.bounds(), e.clientX - r.left, e.clientY - r.top, factor))
      },
      { passive: false },
    )

    let downX = 0
    let downY = 0
    let lastX = 0
    let lastY = 0
    let down = false
    let panning = false
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest?.('button, input, select, summary')) return
      this.selectionDragged = false
      down = true
      panning = false
      downX = lastX = e.clientX
      downY = lastY = e.clientY
    })
    window.addEventListener('pointermove', (e) => {
      if (!down) return
      if (!panning && Math.hypot(e.clientX - downX, e.clientY - downY) < PAN_THRESHOLD_PX) return
      panning = true
      this.selectionDragged = true
      el.style.cursor = 'grabbing'
      this.applyView(panBy(this.view(), this.bounds(), e.clientX - lastX, e.clientY - lastY))
      lastX = e.clientX
      lastY = e.clientY
    })
    window.addEventListener('pointerup', () => {
      down = false
      panning = false
      el.style.cursor = ''
    })
    el.addEventListener('dblclick', () => this.applyView(fitView(this.bounds())))
  }

  private bounds(): ViewBounds {
    return {
      worldW: WORLD_W,
      worldH: WORLD_H,
      viewW: this.app.screen.width,
      viewH: this.app.screen.height,
      baseScale: Math.min(this.app.screen.width / WORLD_W, this.app.screen.height / WORLD_H),
      maxZoom: MAX_ZOOM,
    }
  }

  private view(): View {
    return { scale: this.scale, x: this.offX, y: this.offY }
  }

  private applyView(v: View): void {
    const b = this.bounds()
    this.scale = v.scale
    this.offX = v.x
    this.offY = v.y
    this.zoom = v.scale / b.baseScale
    this.world.scale.set(v.scale)
    this.world.x = v.x
    this.world.y = v.y
    // Edge vignette: keep its on-screen thickness constant across zoom levels.
    this.stwOverlay.clear()
    this.stwOverlay.rect(0, 0, WORLD_W, WORLD_H).stroke({ width: 30 / this.zoom, color: PAL.gcStw, alpha: 1 })
    this.retagResolution()
    this.onLayout?.()
  }

  // retagResolution re-rasterizes id tags per integer zoom bucket: cheap (only
  // on bucket change) and keeps "G512"/"M3" crisp at floor796 zoom depths.
  private retagResolution(): void {
    const bucket = Math.max(1, Math.min(4, Math.round(this.zoom)))
    if (bucket === this.tagRes) return
    this.tagRes = bucket
    for (const rec of this.gophers.values()) rec.g.setTagResolution(bucket)
    for (const rec of this.threads.values()) rec.t.setTagResolution(bucket)
  }

  reset(numProcs: number): void {
    this.setSelection(null)
    this.numProcs = numProcs
    for (const rec of this.gophers.values()) rec.g.container.destroy()
    this.gophers.clear()
    for (const rec of this.threads.values()) rec.t.container.destroy()
    this.threads.clear()
    this.buildStatics()
  }

  // loadTimeline wires the per-run trace so the scene can fire recorded STW cues
  // and reset its step-window tracking.
  loadTimeline(tl: Timeline): void {
    this.midAlias = midAliases(tl.events)
    // A new run means new thread ids: drop stale carriers so their labels
    // never mix aliases across runs.
    for (const rec of this.threads.values()) rec.t.container.destroy()
    this.threads.clear()
    this.gc = gcSummary(tl)
    this.durationNs = tl.meta.durationNs
    this.lastT = -1
    this.stwFlash = 0
  }

  setWorld(world: WorldState, playing = false): void {
    this.playbackActive = playing
    this.detectCues(world)
    this.place(world)
    this.drawSelection()
    // Board: observed runnable count, with no claim about queue membership.
    this.backdrop.setGlobalCount(zoneTotals(world).global)
    // GC yard: heap pile size from the real heap fill, robot/pulse from the mark phase.
    this.heapCount = heapTileCount(heapPct(world) ?? 0)
    this.gcMark = gcPhase(world).kind === 'mark'
  }

  setSelection(selection: ResourceSelection | null): void {
    this.selection = selection
    this.drawSelection()
    this.hideTip()
  }

  private drawSelection(): void {
    const graphics = this.selectionG
    graphics.clear()
    const s = this.selection
    if (!s) return
    const point = s.kind === 'p' ? this.stations[s.id]
      : s.kind === 'g' ? this.gophers.get(s.id)?.g.container : this.threads.get(s.id)?.t.container
    if (!point || (s.kind === 'm' && !this.showThreads)) return
    if (s.kind === 'p') graphics.ellipse(point.x, point.y + 5, 38, 18)
    else graphics.ellipse(point.x, point.y + 3, s.kind === 'g' ? 18 : 26, 10)
    graphics.stroke({ color: PAL.teal, width: 2 })
  }

  toggleIds(): boolean {
    this.showIds = !this.showIds
    for (const rec of this.gophers.values()) rec.g.showLabel(this.showIds)
    for (const rec of this.threads.values()) rec.t.showLabel(this.showIds)
    return this.showIds
  }

  toggleThreads(): boolean {
    this.showThreads = !this.showThreads
    for (const rec of this.threads.values()) rec.t.container.visible = this.showThreads
    return this.showThreads
  }

  private buildStatics(): void {
    this.stations = stationPositions(this.numProcs)
    this.occupied = this.stations.map(() => false)
    this.stationsG.clear()
    for (const st of this.stations) {
      drawStation(this.stationsG, st.x, st.y)
      drawBoothShell(this.stationsG, st.x, st.y)
    }
    this.zoneFloorG.clear()
    drawProps(this.zoneFloorG)
    drawZoneFloor(this.zoneFloorG, GLOBAL.x, GLOBAL.y, GLOBAL.w, GLOBAL.h, PAL.runnable)
    drawZoneFloor(this.zoneFloorG, WAITING.x, WAITING.y, WAITING.w, WAITING.h, PAL.waiting)
    drawZoneFloor(this.zoneFloorG, SYSCALL.x, SYSCALL.y, SYSCALL.w, SYSCALL.h, PAL.syscall)
  }

  worldToScreen(p: Pt): Pt {
    return { x: this.offX + p.x * this.scale, y: this.offY + p.y * this.scale }
  }

  // fit re-derives the view for the current canvas size, preserving the zoom
  // factor and the world point at the viewport center across resizes.
  private fit(): void {
    const b = this.bounds()
    if (this.scale <= 0 || this.offX === 0 && this.offY === 0 && this.scale === 1) {
      // first layout: plain fit
      this.applyView(fitView(b))
      return
    }
    const cx = (b.viewW / 2 - this.offX) / this.scale
    const cy = (b.viewH / 2 - this.offY) / this.scale
    const s = b.baseScale * this.zoom
    this.applyView(clampView({ scale: s, x: b.viewW / 2 - cx * s, y: b.viewH / 2 - cy * s }, b))
  }

  // Flash only on forward playback, never when seeking.
  private detectCues(world: WorldState): void {
    const t = world.t
    this.procStates = world.procs.map(p => p.status)
    this.occupied = this.stations.map((_, pid) => (world.procs[pid]?.gid ?? -1) >= 0)
    // place() uses this verdict for the decorative exit poof.
    this.stepPlayback = this.playbackActive && isPlaybackStep(this.lastT, t, this.durationNs)
    if (this.stepPlayback) {
      if (stwInWindow(this.gc, this.lastT, t)) this.stwFlash = 1
    }
    this.lastT = t
  }

  private place(world: WorldState): void {
    const places = placeIso(world, this.numProcs)
    for (const [gid, p] of places) {
      let rec = this.gophers.get(gid)
      if (!rec) rec = this.spawn(gid, p.x, p.y)
      rec.dying = 0
      const v = world.goroutines.get(gid)!
      const prevState = rec.view?.state

      rec.tx = p.x
      rec.ty = p.y
      // State locations change atomically with trace events. A running G must
      // never type while still visually travelling from its previous zone.
      rec.g.container.position.set(p.x, p.y)
      rec.g.container.zIndex = p.y
      rec.g.container.scale.set(1)
      rec.g.setAlpha(1)
      if (rec.scale !== p.scale) {
        rec.scale = p.scale
        rec.g.setScale(p.scale)
      }
      rec.view = v
      if (v.state !== prevState) rec.g.setTagColor(stateColors(v.state)[0])
      rec.kind = v.state
    }
    // gophers no longer placed: dead ones poof out (tick), the rest removed.
    for (const [gid, rec] of this.gophers) {
      if (places.has(gid)) continue
      if (this.stepPlayback && world.goroutines.get(gid)?.state === 'dead') {
        if (rec.kind !== 'dead') rec.dying = POOF_MS
        rec.kind = 'dead'
      } else {
        rec.g.container.destroy()
        this.gophers.delete(gid)
      }
    }

    // M carriers: docked at their P or under their syscall gopher. A vanished
    // M (parked — no more trace presence) honestly disappears.
    const tp = placeThreads(world, this.numProcs, places)
    for (const [mid, p] of tp) {
      let rec = this.threads.get(mid)
      if (!rec) rec = this.spawnThread(mid, p.x, p.y)
      rec.tx = p.x
      rec.ty = p.y
      rec.t.container.position.set(p.x, p.y)
      if (rec.scale !== p.scale) {
        rec.scale = p.scale
        rec.t.setScale(p.scale)
      }
      rec.tip = threadTip(mid, this.midAlias.get(mid), world)
    }
    for (const [mid, rec] of this.threads) {
      if (tp.has(mid)) continue
      rec.t.container.destroy()
      this.threads.delete(mid)
    }
  }

  private spawn(gid: number, x: number, y: number): Rec {
    const g = makeGopher()
    g.container.position.set(x, y)
    g.container.zIndex = y
    g.setLabel(`G${gid}`)
    g.showLabel(this.showIds)
    g.setTagResolution(this.tagRes)

    const c = g.container
    c.eventMode = 'static'
    c.cursor = 'pointer'
    c.on('pointerover', (e: FederatedPointerEvent) => this.showTip(gid, e))
    c.on('pointermove', (e: FederatedPointerEvent) => this.positionTip(e))
    c.on('pointerout', () => this.hideTip())
    c.on('pointertap', () => {
      if (!this.selectionDragged) this.onSelect?.({ kind: 'g', id: gid })
    })

    this.gopherLayer.addChild(c)
    const rec: Rec = { g, tx: x, ty: y, scale: 1, kind: 'runnable', phase: (gid % 17) * 0.37, dying: 0 }
    this.gophers.set(gid, rec)
    return rec
  }

  private spawnThread(mid: number, x: number, y: number): TRec {
    const t = makeThread(PAL.thread)
    t.container.position.set(x, y)
    t.container.zIndex = y - 0.5
    t.container.visible = this.showThreads
    t.setLabel(`M${this.midAlias.get(mid) ?? mid}`)
    t.showLabel(this.showIds)
    t.setTagResolution(this.tagRes)

    const c = t.container
    c.eventMode = 'static'
    c.cursor = 'pointer'
    c.on('pointerover', (e: FederatedPointerEvent) => this.showThreadTip(mid, e))
    c.on('pointermove', (e: FederatedPointerEvent) => this.positionTip(e))
    c.on('pointerout', () => this.hideTip())
    c.on('pointertap', () => {
      if (!this.selectionDragged) this.onSelect?.({ kind: 'm', id: mid })
    })

    this.gopherLayer.addChild(c) // same layer: one depth-sort domain with the gophers
    const rec: TRec = { t, tx: x, ty: y, scale: 1, phase: (mid % 7) * 0.5, tip: '' }
    this.threads.set(mid, rec)
    return rec
  }

  private tick(dtMs: number): void {
    if (this.playbackActive && !this.reducedMotion) this.animT += dtMs / 1000
    if (this.stwFlash > 0) this.stwFlash = Math.max(0, this.stwFlash - dtMs / STW_FLASH_MS)
    this.stwOverlay.alpha = this.stwFlash * 0.45
    this.stwOverlay.visible = this.stwFlash > 0

    // STWStart precedes the last stopped P; STWDone follows restarting Ps.
    // The recorded interval cannot establish that every G is frozen throughout.
    const aT = this.animT

    this.fxG.clear()
    for (let pid = 0; pid < this.stations.length; pid++) {
      const st = this.stations[pid]
      drawBelt(this.fxG, st.x, st.y, aT)
      if (!this.occupied[pid] && this.procStates[pid] === 'idle') drawIdleMarker(this.fxG, st.x, st.y)
      drawBoothFx(this.fxG, st.x, st.y, this.occupied[pid], aT)

    }
    const bot = botTarget(this.gcMark, aT, HEAP_CENTER, BOT_DOCK)
    drawHeapPile(this.fxG, HEAP_CENTER, this.heapCount, this.gcMark, false, aT, bot)
    drawRobot(this.fxG, bot.x, bot.y, bot.sweeping, false, this.animT)
    drawSiren(this.fxG, SIREN_POS.x, SIREN_POS.y, this.stwFlash, this.animT)

    for (const [gid, rec] of this.gophers) {
      const c = rec.g.container

      if (rec.dying > 0) {
        rec.dying -= dtMs
        const a = Math.max(0, rec.dying / POOF_MS)
        rec.g.setAlpha(a)
        // poof grows the CONTAINER (sprite keeps its own setScale, so zone gophers
        // at 0.55 still poof from their reduced size — the two scales compose).
        c.scale.set(1 + (1 - a) * 0.5)
        rec.g.setTexture(this.tex.dead[0])
        if (rec.dying <= 0) {
          c.destroy()
          this.gophers.delete(gid)
        }
        continue
      }

      // Event-aligned positions; depth-sort by screen-y
      c.x = rec.tx
      c.y = rec.ty
      c.zIndex = c.y

      this.applyMotion(rec)
      rec.g.setTexture(this.frameFor(rec))
    }

    for (const rec of this.threads.values()) {
      const c = rec.t.container
      c.x = rec.tx
      c.y = rec.ty
      c.zIndex = c.y - 0.5 // just under its gopher when they overlap exactly
      const i = Math.floor(this.animT * THREAD_BLINK_FPS + rec.phase) % this.ttex.idle.length
      rec.t.setTexture(this.ttex.idle[i])
    }
  }

  private frameFor(rec: Rec): Texture {
    const frames = this.tex[rec.kind]
    const fps = FPS[rec.kind]
    if (fps <= 0 || frames.length <= 1) return frames[0]
    const i = Math.floor(this.animT * fps + rec.phase) % frames.length
    return frames[i]
  }

  private applyMotion(rec: Rec): void {
    const tphase = this.animT + rec.phase
    switch (rec.kind) {
      case 'running':
        rec.g.setOffset(0, -Math.abs(Math.sin(tphase * 4.5)) * 1.6)
        break
      case 'runnable':
        rec.g.setOffset(Math.sin(tphase * 2.2) * 1.2, 0)
        break
      case 'waiting':
        rec.g.setOffset(0, Math.sin(tphase * 2) * 0.8)
        break
      default:
        rec.g.setOffset(0, 0)
    }
  }

  private showTip(gid: number, e: FederatedPointerEvent): void {
    const view = this.gophers.get(gid)?.view
    if (!view) return
    this.tooltip.textContent = formatTip(gid, view, this.midAlias.get(view.mid))
    this.tooltip.style.display = 'block'
    this.positionTip(e)
  }

  private showThreadTip(mid: number, e: FederatedPointerEvent): void {
    const tip = this.threads.get(mid)?.tip
    if (!tip) return
    this.tooltip.textContent = tip
    this.tooltip.style.display = 'block'
    this.positionTip(e)
  }

  private positionTip(e: FederatedPointerEvent): void {
    const ne = e.nativeEvent as PointerEvent
    this.tooltip.style.left = `${ne.clientX + 12}px`
    this.tooltip.style.top = `${ne.clientY + 12}px`
  }

  private hideTip(): void {
    this.tooltip.style.display = 'none'
  }
}

function formatTip(gid: number, view: GoroutineView, midAlias?: number): string {
  let s = `G${gid} • ${tr().scene.states[view.state]}`
  if (view.state === 'waiting' && view.reason) s += `: ${view.reason}`
  else if ((view.state === 'running' || view.state === 'syscall') && view.pid >= 0) s += ` (P${view.pid})`
  if ((view.state === 'running' || view.state === 'syscall') && view.mid >= 0)
    s += ` · M${midAlias ?? view.mid}`
  return s
}

// threadTip describes what an M is doing right now, from the world state: in a
// syscall with its G, or bound to a P (carrying that P's runner, if any). The
// label is the per-run ordinal alias; the real (huge) thread id stays here.
function threadTip(mid: number, alias: number | undefined, world: WorldState): string {
  const name = tr().scene.mName(alias ?? mid, mid)
  for (const v of world.goroutines.values()) {
    if (v.state === 'syscall' && v.mid === mid) return `${name}${tr().scene.inSyscallWith(v.gid)}`
  }
  for (const p of world.procs) {
    if (p.mid !== mid) continue
    let s = `${name}${tr().scene.boundTo(p.pid)}`
    if (p.gid >= 0) s += tr().scene.carries(p.gid)
    return s
  }
  return name
}

function makeTooltip(parent: HTMLElement): HTMLDivElement {
  const t = document.createElement('div')
  t.style.cssText =
    'position:fixed;display:none;pointer-events:none;z-index:10;' +
    'background:#181b29;color:#e7eafb;border:1px solid #2f344e;border-radius:3px;' +
    'padding:4px 8px;font:12px ui-monospace,monospace;white-space:nowrap'
  parent.appendChild(t)
  return t
}
