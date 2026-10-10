import { describe, it, expect } from 'vitest'
import { gcSummary, stwInWindow, isPlaybackStep } from './gc'
import type { Timeline, TimelineEvent } from '../model/timeline'

function tl(events: Partial<TimelineEvent>[], durationNs = 2000): Timeline {
  return {
    meta: { scenario: 'gcpressure', numProcs: 4, durationNs, goroutines: [] },
    events: events.map((e) => ({ t: 0, type: 'metric', gid: -1, pid: -1, mid: -1, ...e }) as TimelineEvent),
  }
}

const SWEEP = 'stop-the-world (GC sweep termination)'
const MARKTERM = 'stop-the-world (GC mark termination)'
const MARK = 'GC concurrent mark phase'

describe('gcSummary', () => {
  it('is empty when there is no GC activity', () => {
    const s = gcSummary(tl([{ t: 100, type: 'g_run_start', gid: 1, pid: 0, mid: -1 }]))
    expect(s.cycles).toBe(0)
    expect(s.stw).toEqual([])
    expect(s.mark).toEqual([])
    expect(s.maxStwNs).toBe(0)
  })

  it('pairs one full GC cycle (sweep STW, concurrent mark, mark-term STW)', () => {
    const s = gcSummary(
      tl([
        { t: 100, type: 'gc_range_begin', name: SWEEP },
        { t: 150, type: 'gc_range_end', name: SWEEP },
        { t: 150, type: 'gc_range_begin', name: MARK },
        { t: 1000, type: 'gc_range_begin', name: MARKTERM },
        { t: 1040, type: 'gc_range_end', name: MARKTERM },
        { t: 1040, type: 'gc_range_end', name: MARK },
      ]),
    )
    expect(s.cycles).toBe(1)
    expect(s.mark).toEqual([{ startNs: 150, endNs: 1040 }])
    expect(s.stw).toEqual([
      { startNs: 100, endNs: 150, ns: 50 },
      { startNs: 1000, endNs: 1040, ns: 40 },
    ])
    expect(s.maxStwNs).toBe(50)
  })

  it('ignores an unclosed range (no matching end before t)', () => {
    const s = gcSummary(tl([{ t: 100, type: 'gc_range_begin', name: SWEEP }]))
    expect(s.stw).toEqual([])
    expect(s.maxStwNs).toBe(0)
  })

  it('excludes the "start trace" STW (a tracer artifact, not a GC pause)', () => {
    const s = gcSummary(
      tl([
        { t: 0, type: 'gc_range_begin', name: 'stop-the-world (start trace)' },
        { t: 1_600_000, type: 'gc_range_end', name: 'stop-the-world (start trace)' },
        { t: 2000, type: 'gc_range_begin', name: MARKTERM },
        { t: 2040, type: 'gc_range_end', name: MARKTERM },
      ]),
    )
    expect(s.stw).toEqual([{ startNs: 2000, endNs: 2040, ns: 40 }])
    expect(s.maxStwNs).toBe(40) // not the 1.6ms tracer-start pause
  })
})

describe('stwInWindow', () => {
  const s = gcSummary(
    tl([
      { t: 100, type: 'gc_range_begin', name: SWEEP },
      { t: 150, type: 'gc_range_end', name: SWEEP },
      { t: 1000, type: 'gc_range_begin', name: MARKTERM },
      { t: 1040, type: 'gc_range_end', name: MARKTERM },
    ]),
  )

  it('returns the STW interval overlapping (t0, t1]', () => {
    expect(stwInWindow(s, 90, 160)?.ns).toBe(50)
  })

  it('returns null when no STW overlaps the window', () => {
    expect(stwInWindow(s, 200, 900)).toBeNull()
  })

  it('detects a sub-frame STW fully inside the step window', () => {
    // window (990, 1100] fully contains the 1000..1040 STW
    expect(stwInWindow(s, 990, 1100)?.ns).toBe(40)
  })
})

describe('isPlaybackStep', () => {
  const dur = 1_000_000
  it('is false before the first sample (lastT < 0)', () => {
    expect(isPlaybackStep(-1, 100, dur)).toBe(false)
  })
  it('is true for a small forward step (normal playback)', () => {
    expect(isPlaybackStep(1000, 1500, dur)).toBe(true)
  })
  it('is false for a backward jump (seek back)', () => {
    expect(isPlaybackStep(5000, 1000, dur)).toBe(false)
  })
  it('is false for a large forward jump (scrub)', () => {
    expect(isPlaybackStep(0, dur * 0.5, dur)).toBe(false)
  })
})


it('draws a mark phase crossing the trace boundary without counting it as a full phase', () => {
  const timeline: Timeline = {
    meta: { scenario: 'custom', numProcs: 1, durationNs: 100, goroutines: [] },
    events: [
      { t: 0, type: 'gc_range_active', gid: -1, pid: -1, mid: -1, name: 'GC concurrent mark phase' },
      { t: 70, type: 'gc_range_end', gid: -1, pid: -1, mid: -1, name: 'GC concurrent mark phase' },
    ],
  }
  const s = gcSummary(timeline)
  expect(s.mark).toHaveLength(1)
  expect(s.mark[0].startNs).toBe(0)
  expect(s.mark[0].endNs).toBe(70)
  expect(s.cycles).toBe(0)
})
