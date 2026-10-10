import { describe, it, expect } from 'vitest'
import { buildLogRows, fmtDur, fmtMs } from './eventlog'
import type { TimelineEvent } from '../model/timeline'

function ev(extra: Partial<TimelineEvent> & { type: TimelineEvent['type']; t: number }): TimelineEvent {
  return { gid: -1, pid: -1, mid: -1, ...extra }
}

const text = (rows: ReturnType<typeof buildLogRows>, i: number): string => rows[i].text

describe('buildLogRows causality', () => {
  it('attributes creation to the goroutine running on the creating M', () => {
    const rows = buildLogRows([
      ev({ t: 1, type: 'g_run_start', gid: 1, pid: 0, mid: 7 }),
      ev({ t: 2, type: 'g_create', gid: 5, pid: 0, mid: 7 }),
    ])
    expect(text(rows, 1)).toBe('G5 создана горутиной G1')
  })

  it('explains a run start: how long it waited and who woke it', () => {
    const rows = buildLogRows([
      ev({ t: 0, type: 'g_run_start', gid: 1, pid: 0, mid: 7 }), // the waker runs on M7
      ev({ t: 1_000, type: 'g_block', gid: 5, pid: 1, mid: 3, reason: 'chan receive' }),
      ev({ t: 3_000, type: 'g_unblock', gid: 5, pid: 0, mid: 7 }), // woken by G1's M
      ev({ t: 5_000, type: 'g_run_start', gid: 5, pid: 1, mid: 3 }),
    ])
    expect(text(rows, 2)).toBe('G5 разбужена горутиной G1 — ждала «chan receive» 2.0 мкс')
    expect(text(rows, 3)).toBe('G5 встала на P1 · M3 — ждала 2.0 мкс (разбужена G1)')
  })

  it('never blames the woken goroutine itself (unblocker trap)', () => {
    const rows = buildLogRows([
      ev({ t: 0, type: 'g_run_start', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 10, type: 'g_block', gid: 5, pid: 0, mid: 7, reason: 'sleep' }),
      ev({ t: 20, type: 'g_unblock', gid: 5, pid: -1, mid: -1 }), // timer: no waker context
    ])
    expect(text(rows, 2)).toBe('G5 разбужена — ждала «sleep» 10 нс')
  })

  it('marks the first run and reports the kernel time on syscall exit', () => {
    const rows = buildLogRows([
      ev({ t: 0, type: 'g_create', gid: 5, pid: 0 }),
      ev({ t: 1_000, type: 'g_run_start', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 2_000, type: 'g_syscall_enter', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 9_500_000, type: 'g_syscall_exit', gid: 5, pid: 2, mid: 7 }),
    ])
    expect(text(rows, 1)).toBe('G5 встала на P0 · M7 — ждала 1.0 мкс (первый запуск)')
    expect(text(rows, 3)).toBe('G5 вернулась из syscall на P2 (в syscall 9.50 мс)')
  })

  it('records a syscall return to Runnable without inferring why', () => {
    const rows = buildLogRows([
      ev({ t: 0, type: 'g_run_start', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 100, type: 'g_syscall_enter', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 4_100, type: 'g_unblock', gid: 5, pid: -1, mid: 7 }), // syscall -> runnable
      ev({ t: 8_000, type: 'g_run_start', gid: 5, pid: 1, mid: 9 }),
    ])
    expect(text(rows, 2)).toBe('G5 завершила syscall, стала Runnable (в syscall 4.0 мкс)')
    expect(text(rows, 3)).toBe('G5 встала на P1 · M9 — ждала 3.9 мкс (после syscall)')
  })

  it('records a P release while its G remains in syscall without naming the initiator', () => {
    const rows = buildLogRows([
      ev({ t: 0, type: 'g_run_start', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 100, type: 'g_syscall_enter', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 200, type: 'p_stop', pid: 0, mid: 4 }), // stealer's M on the event
    ])
    expect(text(rows, 2)).toBe('P0 освобождён; G5 остаётся в syscall на M7')
  })

  it('reports run time on descheduling and lifetime on exit', () => {
    const rows = buildLogRows([
      ev({ t: 0, type: 'g_create', gid: 5, pid: 0 }),
      ev({ t: 1_000, type: 'g_run_start', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 2_100_000, type: 'g_run_stop', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 2_100_000, type: 'g_run_start', gid: 5, pid: 0, mid: 7 }),
      ev({ t: 12_300_000, type: 'g_exit', gid: 5, pid: 0, mid: 7 }),
    ])
    expect(text(rows, 2)).toBe('G5 освободила P0, стала Runnable (бежала 2.10 мс)')
    expect(text(rows, 4)).toBe('G5 завершилась (жила 12.30 мс)')
  })

  it('ignores legacy steal guesses, preserves M aliases and skips heap metrics', () => {
    const rows = buildLogRows(
      [
        ev({ t: 1, type: 'metric', name: '/gc/heap/goal:bytes', value: 1 }),
        ev({ t: 2, type: 'g_run_start', gid: 5, pid: 2, mid: 6103904256, stolen: true }),
      ],
      new Map([[6103904256, 3]]),
    )
    expect(rows).toHaveLength(1)
    expect(text(rows, 0)).toBe('G5 встала на P2 · M3')
  })
})

describe('formatting helpers', () => {
  it('fmtDur picks legible units', () => {
    expect(fmtDur(720)).toBe('720 нс')
    expect(fmtDur(9_400)).toBe('9.4 мкс')
    expect(fmtDur(1_510_000)).toBe('1.51 мс')
  })

  it('fmtMs renders ns as fixed ms', () => {
    expect(fmtMs(1_234_567)).toBe('1.23')
  })
})


it('does not present a boundary snapshot as a fresh start or a full duration', () => {
  const rows = buildLogRows([
    ev({ t: 0, type: 'g_status', gid: 5, pid: 0, mid: 7, state: 'waiting' }),
    ev({ t: 100, type: 'g_unblock', gid: 5, pid: -1 }),
  ])
  expect(rows[0].text).toContain('первое наблюдаемое состояние')
  expect(rows[1].text).toContain('≥')
})

// Runtime can emit work on an M while another G is recorded in syscall there.
// A syscall G is associated with M, but is not an executing Go actor.
it('does not attribute runtime creation to a G in syscall on the same M', () => {
  const rows = buildLogRows([
    ev({ t: 0, type: 'g_status', gid: 1, state: 'syscall', mid: 7 }),
    ev({ t: 1, type: 'g_create', gid: 2, mid: 7 }),
  ])
  expect(rows[1].text).toBe('G2 создана')
})

it('does not label GOMAXPROCS stop-the-world as GC', () => {
  const rows = buildLogRows([ev({ t: 1, type: 'gc_range_begin', name: 'stop-the-world (GOMAXPROCS)' })])
  expect(rows[0].text).toBe('Runtime: stop-the-world (GOMAXPROCS) — начало')
})

it('uses the recorded actor even when prior Running history is unavailable', () => {
  const rows = buildLogRows([ev({ t: 1, type: 'g_create', gid: 4, mid: -1, state: 'waiting', actorGid: 9 })])
  expect(rows[0].text).toBe('G4 создана горутиной G9')
})

it('does not infer an actor when the recorded executing context is absent', () => {
  const rows = buildLogRows([
    ev({ t: 0, type: 'g_run_start', gid: 1, mid: 7, pid: 0 }),
    ev({ t: 1, type: 'g_unblock', gid: 2, mid: 7, actorGid: -1 }),
  ])
  expect(rows[1].text).toBe('G2 разбужена')
})

it('clears a destroyed syscall G before its M is reused', () => {
  const rows = buildLogRows([
    ev({ t: 0, type: 'g_create', gid: 4, mid: 7, state: 'syscall' }),
    ev({ t: 1, type: 'g_exit', gid: 4, mid: 7 }),
    ev({ t: 2, type: 'p_start', pid: 0, mid: 7 }),
    ev({ t: 3, type: 'p_stop', pid: 0, mid: 7 }),
  ])
  expect(rows[3].text).toBe('P0 остановлен')
})
