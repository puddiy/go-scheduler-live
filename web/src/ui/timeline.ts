import type { Timeline, TimelineEvent } from '../model/timeline'
import { gcSummary, type GcSummary } from '../player/gc'
import { eventDensity, timeOfFrac } from './histogram'
import { PAL } from '../scene/palette'
import { t as tr } from '../i18n'

// TimelineBar is the unified control-panel timeline: one canvas drawing, to-scale
// over the whole run, an event-density histogram + concurrent-mark bands + STW ticks
// + a playhead — with click/drag to seek. It replaces the DOM
// GC-strip and the visible range scrubber (the native range input stays in the DOM,
// visually hidden, for keyboard + the control harness). All inputs are REAL trace
// data; no queue or work-stealing heuristic is drawn.
//
// The static layers (grid + histogram + bands + ticks + diamonds) are baked once per
// run into an offscreen canvas; render() only blits that and draws the moving
// playhead, so it is cheap enough to call every frame.

const INSET = 8 // px left/right, matching the mockup's L/R track insets
const HEIGHT = 46 // css px
const BUCKET_PX = 4 // one histogram bar per this many css px

export class TimelineBar {
  readonly root: HTMLDivElement
  /** seek callback; the composition root routes it to the current Player. */
  onSeek?: (tNs: number) => void

  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private bg: HTMLCanvasElement | null = null // cached static background (device px)

  private events: TimelineEvent[] = []
  private durationNs = 0
  private gc: GcSummary = { cycles: 0, stw: [], mark: [], maxStwNs: 0 }

  private cssW = 0
  private dpr = 1
  private tNs = 0
  private dragging = false

  constructor() {
    const S = tr()
    this.root = el('div', 'timeline')

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'timeline-canvas'
    this.canvas.title = S.timeline.tip
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.root.append(this.canvas)

    // compact legend under the track (mirrors the mockup's timeline legend)
    const legend = el('div', 'timeline-legend')
    legend.append(
      swatch('mark', S.timeline.mark),
      swatch('stw', S.timeline.stw),
      swatch('density', S.timeline.density),
    )
    this.root.append(legend)

    // seek by click/drag anywhere on the track
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true
      this.canvas.setPointerCapture(e.pointerId)
      this.seekFromClientX(e.clientX)
    })
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this.seekFromClientX(e.clientX)
    })
    const stop = (e: PointerEvent): void => {
      this.dragging = false
      try {
        this.canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    this.canvas.addEventListener('pointerup', stop)
    this.canvas.addEventListener('pointercancel', stop)

    new ResizeObserver(() => this.resize()).observe(this.root)
  }

  // setTimeline wires the per-run trace and rebuilds the static background.
  setTimeline(tl: Timeline): void {
    this.events = tl.events
    this.durationNs = tl.meta.durationNs
    this.gc = gcSummary(tl)
    this.tNs = 0
    this.resize()
  }

  // render blits the cached background and draws the playhead for time tNs.
  render(tNs: number): void {
    this.tNs = tNs
    this.paint()
  }

  // resize matches the backing store to the element width (× dpr for crisp ticks),
  // rebakes the background, and repaints.
  private resize(): void {
    const w = Math.max(0, Math.floor(this.canvas.clientWidth))
    if (w <= 0) return
    this.cssW = w
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(HEIGHT * this.dpr)
    this.bakeBackground()
    this.paint()
  }

  private xOf(ns: number): number {
    const inner = this.cssW - 2 * INSET
    const f = this.durationNs > 0 ? ns / this.durationNs : 0
    return INSET + Math.max(0, Math.min(1, f)) * inner
  }

  // bakeBackground draws all static layers once into an offscreen canvas.
  private bakeBackground(): void {
    const bg = document.createElement('canvas')
    bg.width = this.canvas.width
    bg.height = this.canvas.height
    const g = bg.getContext('2d')
    if (!g) return
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const w = this.cssW
    const h = HEIGHT

    g.fillStyle = PAL.bg0
    g.fillRect(0, 0, w, h)
    g.fillStyle = PAL.line
    g.fillRect(0, h - 2, w, 2)

    // time gridlines + ms labels at a nice step (~6 divisions)
    const durMs = this.durationNs / 1e6
    if (durMs > 0) {
      const step = niceStep(durMs / 6)
      g.font = '9px ui-monospace, monospace'
      g.textBaseline = 'top'
      for (let ms = 0; ms <= durMs + 1e-6; ms += step) {
        const x = Math.round(this.xOf(ms * 1e6))
        g.fillStyle = PAL.grid
        g.fillRect(x, 0, 1, h - 2)
        g.fillStyle = PAL.txDim
        g.fillText(String(round1(ms)), x + 3, 3)
      }
    }

    // event-density histogram (real event counts per bucket)
    const inner = w - 2 * INSET
    const buckets = Math.max(1, Math.floor(inner / BUCKET_PX))
    const density = eventDensity(this.events, buckets, this.durationNs)
    const maxBar = h - 8
    g.fillStyle = 'rgba(242,181,61,0.5)' // PAL.runnable, translucent
    for (let i = 0; i < buckets; i++) {
      if (density[i] <= 0) continue
      const bh = Math.max(2, Math.round(density[i] * maxBar)) // floor so low activity still reads
      g.fillRect(INSET + i * BUCKET_PX, h - 3 - bh, BUCKET_PX - 1, bh)
    }

    // concurrent-mark bands
    for (const m of this.gc.mark) {
      const x1 = this.xOf(m.startNs)
      const x2 = this.xOf(m.endNs)
      g.fillStyle = 'rgba(52,201,191,0.18)' // PAL.teal
      g.fillRect(x1, 3, Math.max(1, x2 - x1), h - 8)
      g.fillStyle = PAL.teal
      g.fillRect(x1, 3, Math.max(1, x2 - x1), 2)
    }

    // STW ticks (the honest sliver: sub-ms pauses shown as thin red marks)
    g.fillStyle = PAL.gcStw
    for (const s of this.gc.stw) {
      g.fillRect(Math.round(this.xOf(s.startNs)), 2, 2, h - 6)
    }

    this.bg = bg
  }

  private paint(): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (this.bg) ctx.drawImage(this.bg, 0, 0)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    const h = HEIGHT
    const x = this.xOf(this.tNs)
    // faint "past" tint up to the playhead
    ctx.fillStyle = 'rgba(231,234,251,0.05)'
    ctx.fillRect(INSET, 0, x - INSET, h)
    // playhead line + top glyph
    ctx.fillStyle = PAL.running
    ctx.fillRect(INSET, 1, x - INSET, 2)
    ctx.fillStyle = PAL.txHi
    ctx.fillRect(Math.round(x) - 1, 0, 2, h)
    ctx.fillRect(Math.round(x) - 4, 0, 9, 7)
  }

  private seekFromClientX(clientX: number): void {
    if (this.durationNs <= 0) return
    const r = this.canvas.getBoundingClientRect()
    const inner = this.cssW - 2 * INSET
    const frac = inner > 0 ? (clientX - r.left - this.canvas.clientLeft - INSET) / inner : 0
    this.onSeek?.(timeOfFrac(frac, this.durationNs))
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  return e
}

function swatch(kind: string, label: string): HTMLSpanElement {
  const s = el('span', 'tl-leg')
  const sw = el('span', `tl-sw ${kind}`)
  s.append(sw, document.createTextNode(label))
  return s
}

// niceStep rounds a raw step up to a 1/2/5 × 10^k value so gridlines land on
// readable millisecond marks.
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
