import type { Timeline } from '../model/timeline'

// Summarize recorded mark phases and runtime STW ranges without inferring
// missing boundaries, GC cycle completion, or a global freeze.

export interface Interval {
  startNs: number
  endNs: number
  /** The phase started before, or ends after, the recording. */
  partial?: boolean
}

export interface StwInterval extends Interval {
  ns: number
}

export interface GcSummary {
  /** Number of fully recorded concurrent-mark phases. */
  cycles: number
  /** stop-the-world pauses, paired begin→end, in trace-time order. */
  stw: StwInterval[]
  /** concurrent-mark phases, paired begin→end. */
  mark: Interval[]
  /** longest real STW pause in ns (0 if none). */
  maxStwNs: number
}

// isTracerArtifact flags the "stop-the-world (start trace)" range: the tracer
// starting up, NOT a GC pause. It must be excluded everywhere a GC phase is shown
// (STW readout, gcActive, header, caption) — otherwise the UI falsely reads
// stop-the-world at t=0, before any goroutine has run.
export const isTracerArtifact = (name: string): boolean => name.includes('start trace')

const isStw = (name: string): boolean => name.includes('stop-the-world') && !isTracerArtifact(name)
const isMark = (name: string): boolean => name.includes('mark phase')

// STW_FLASH_MS is the wall-clock duration of the stop-the-world display cue (the
// scene's red vignette blink and the chrome banner). Shared so both fade in step.
// A real STW is sub-millisecond; this is only a visible flash, never a held freeze.
export const STW_FLASH_MS = 320

// gcSummary pairs each gc_range_begin with its matching gc_range_end (by name,
// LIFO) and buckets the closed intervals into STW vs concurrent-mark.
export function gcSummary(timeline: Timeline): GcSummary {
  const open = new Map<string, { start: number; partial: boolean }>()
  const stw: StwInterval[] = []
  const mark: Interval[] = []
  for (const e of timeline.events) {
    if (!e.name) continue
    if (e.type === 'gc_range_begin' || e.type === 'gc_range_active') {
      if (!open.has(e.name)) open.set(e.name, { start: e.t, partial: e.type === 'gc_range_active' })
    } else if (e.type === 'gc_range_end') {
      const interval = open.get(e.name)
      if (!interval) continue
      open.delete(e.name)
      const iv: Interval = { startNs: interval.start, endNs: e.t }
      if (interval.partial) iv.partial = true
      if (isStw(e.name) && !interval.partial) stw.push({ ...iv, ns: e.t - interval.start })
      else if (isMark(e.name)) mark.push(iv)
    }
  }
  // A phase that outlives the recording is visible up to its end; never invent
  // its completion time or count it as a complete phase.
  for (const [name, interval] of open) {
    if (isMark(name)) mark.push({ startNs: interval.start, endNs: timeline.meta.durationNs, partial: true })
  }

  const maxStwNs = stw.reduce((m, s) => Math.max(m, s.ns), 0)
  return { cycles: mark.filter(iv => !iv.partial).length, stw, mark, maxStwNs }
}

// stwInWindow returns the STW pause overlapping the half-open step window (t0, t1]
// — used to catch a sub-frame STW that began and ended between two render frames,
// so the in-world STW cue still fires. Returns the longest such pause, or null.
export function stwInWindow(s: GcSummary, t0: number, t1: number): StwInterval | null {
  let best: StwInterval | null = null
  for (const iv of s.stw) {
    // overlap of (t0, t1] with [startNs, endNs]
    if (iv.endNs > t0 && iv.startNs <= t1) {
      if (best === null || iv.ns > best.ns) best = iv
    }
  }
  return best
}

// STEP_WINDOW_PCT bounds what counts as a single normal playback step (vs a
// scrub/seek): a forward advance under this fraction of the run. Large enough to
// span a 16-33ms render frame at any speed, small enough to exclude a scrub jump.
export const STEP_WINDOW_PCT = 0.03

// isPlaybackStep reports whether (lastT, t] is one forward playback step, so the
// in-world STW cues fire during play but not when scrubbing. Shared by the
// scene (vignette) and the chrome (banner) so both detect the same window.
export function isPlaybackStep(lastT: number, t: number, durationNs: number): boolean {
  return lastT >= 0 && t > lastT && t - lastT < Math.max(1, durationNs * STEP_WINDOW_PCT)
}
