import { describe, it, expect } from 'vitest'
import { narrate, captionWindowNs } from './narrate'
import { NO_RESOURCE, type TimelineEvent } from '../model/timeline'

function ev(t: number, type: TimelineEvent['type'], extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return { t, type, gid: NO_RESOURCE, pid: NO_RESOURCE, mid: NO_RESOURCE, ...extra }
}

describe('narrate', () => {
  it('returns empty when nothing notable is near t', () => {
    expect(narrate([ev(1, 'p_start', { pid: 0 })], 100, [])).toBe('')
  })

  it('reports stop-the-world only while it is actually active (from gcActive)', () => {
    const events = [ev(100, 'g_run_start', { gid: 7, pid: 1, stolen: true })]
    expect(narrate(events, 101, ['stop-the-world (GC mark termination)'])).toContain('STW: записанный интервал')
  })

  it('does NOT claim stop-the-world after the range ended, even if a begin is in the window', () => {
    // regression: the old code re-scanned raw events and asserted STW for ~8ms
    // after gc_range_end. With gcActive empty (STW already ended), no STW caption.
    const events = [ev(100, 'gc_range_begin', { name: 'stop-the-world (GC mark termination)' })]
    expect(narrate(events, 101, [])).not.toContain('STW: записанный интервал')
  })

  it('reports concurrent mark while the mark phase is active', () => {
    expect(narrate([], 500, ['GC concurrent mark phase'])).toContain('разметк')
  })

  it('does not narrate legacy heuristic steals as recorded facts', () => {
    expect(narrate([ev(50, 'g_run_start', { gid: 12, pid: 3, stolen: true })], 50, [])).toBe('')
  })

  it('describes a block with its reason', () => {
    expect(narrate([ev(50, 'g_block', { gid: 5, reason: 'chan receive' })], 50, [])).toBe('G5 заблокирован: chan receive')
  })

  it('ignores events outside the look-back window', () => {
    expect(narrate([ev(0, 'g_block', { gid: 5, reason: 'sync' })], 100_000_000, [])).toBe('')
  })

  it('bounds point events by an explicit window so short traces do not go stale', () => {
    const events = [ev(1_000_000, 'g_block', { gid: 5, reason: 'chan receive' })]
    // event at 1ms, viewed at 3ms: outside a 1ms window → nothing notable.
    expect(narrate(events, 3_000_000, [], 1_000_000)).toBe('')
    // but inside the default 8ms window it is still reported.
    expect(narrate(events, 3_000_000, [])).toContain('G5')
  })
})

describe('captionWindowNs', () => {
  it('caps at the 8ms look-back for long traces', () => {
    expect(captionWindowNs(2_000_000_000)).toBe(8_000_000)
  })

  it('scales down to ~1% of the run for short traces (workstealing ~39ms)', () => {
    expect(captionWindowNs(39_000_000)).toBe(390_000)
  })

  it('never returns a zero-width window', () => {
    expect(captionWindowNs(0)).toBe(1)
  })
})

describe('narrate syscall handoff', () => {
  const W = 8_000_000

  it('narrates syscall enter with the M ordinal alias', () => {
    const text = narrate(
      [ev(10, 'g_syscall_enter', { gid: 5, pid: 0, mid: 6103904256 })],
      10,
      [],
      W,
      new Map([[6103904256, 1]]),
    )
    expect(text).toBe('G5 ушла в syscall — M1 выполняет системный вызов')
  })

  it('falls back to the raw mid without an alias map', () => {
    const text = narrate([ev(10, 'g_syscall_enter', { gid: 5, pid: 0, mid: 42 })], 10, [], W)
    expect(text).toContain('M42')
  })

  it('omits the M tail when the event carries no mid', () => {
    const text = narrate([ev(10, 'g_syscall_enter', { gid: 5, pid: 0 })], 10, [], W)
    expect(text).toBe('G5 ушла в syscall')
  })

  it('narrates syscall exit with the P it returned to', () => {
    const text = narrate([ev(10, 'g_syscall_exit', { gid: 5, pid: 2, mid: 42 })], 10, [], W)
    expect(text).toBe('G5 вернулась из syscall на P2')
  })

  it('ignores legacy steal flags and yields to the recorded STW interval', () => {
    const events = [
      ev(9, 'g_run_start', { gid: 1, pid: 0, stolen: true }),
      ev(10, 'g_syscall_enter', { gid: 5, pid: 1, mid: 42 }),
    ]
    expect(narrate(events, 10, [], W)).toContain('syscall')
    expect(narrate(events, 10, ['stop-the-world (GC mark termination)'], W)).toContain('STW: записанный интервал')
  })
})
