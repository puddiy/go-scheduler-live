import { describe, it, expect } from 'vitest'
import { stateAt } from './state'
import { nextTime, clamp } from './player'
import { NO_RESOURCE, type Timeline, type TimelineEvent } from '../model/timeline'

function tl(events: TimelineEvent[], numProcs = 2): Timeline {
  return { meta: { scenario: 't', numProcs, durationNs: 1000, goroutines: [] }, events }
}

describe('stateAt', () => {
  it('places a running goroutine on its P and leaves others idle', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 5, pid: 0, mid: -1 },
        { t: 2, type: 'g_run_start', gid: 5, pid: 1, mid: -1 },
      ]),
      2,
    )
    expect(s.goroutines.get(5)?.state).toBe('running')
    expect(s.goroutines.get(5)?.pid).toBe(1)
    expect(s.procs[1].gid).toBe(5)
    expect(s.procs[0].gid).toBe(NO_RESOURCE)
  })

  it('ignores events after t', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 5, pid: 0, mid: -1 },
        { t: 10, type: 'g_run_start', gid: 5, pid: 1, mid: -1 },
      ]),
      5,
    )
    expect(s.goroutines.get(5)?.state).toBe('runnable')
    expect(s.procs[1].gid).toBe(NO_RESOURCE)
  })

  it('frees the P and records the reason when a goroutine blocks', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 5, pid: 0, mid: -1 },
        { t: 2, type: 'g_run_start', gid: 5, pid: 0, mid: -1 },
        { t: 3, type: 'g_block', gid: 5, pid: 0, mid: -1, reason: 'chan receive' },
      ]),
      3,
    )
    const v = s.goroutines.get(5)!
    expect(v.state).toBe('waiting')
    expect(v.reason).toBe('chan receive')
    expect(s.procs[0].gid).toBe(NO_RESOURCE)
  })

  it('ignores the obsolete steal heuristic in older recordings', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 7, pid: 0, mid: -1 },
        { t: 2, type: 'g_run_start', gid: 7, pid: 1, mid: -1, stolen: true },
      ]),
      2,
    )
    expect(s.goroutines.get(7)?.stolen).toBe(false)
  })

  it('marks a goroutine dead after exit and frees its P', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 5, pid: 0, mid: -1 },
        { t: 2, type: 'g_run_start', gid: 5, pid: 0, mid: -1 },
        { t: 3, type: 'g_exit', gid: 5, pid: 0, mid: -1 },
      ]),
      3,
    )
    expect(s.goroutines.get(5)?.state).toBe('dead')
    expect(s.procs[0].gid).toBe(NO_RESOURCE)
  })

  it('excludes the tracer start-trace stop-the-world from gcActive', () => {
    // "stop-the-world (start trace)" is the tracer starting up, not a GC pause;
    // it must not surface as a GC phase (else the header/caption falsely read STW
    // at t=0, before anything has run). A real GC STW still shows.
    const s = stateAt(
      tl([
        { t: 1, type: 'gc_range_begin', gid: NO_RESOURCE, pid: NO_RESOURCE, mid: -1, name: 'stop-the-world (start trace)' },
        { t: 2, type: 'gc_range_begin', gid: NO_RESOURCE, pid: NO_RESOURCE, mid: -1, name: 'stop-the-world (GC mark termination)' },
      ]),
      2,
    )
    expect(s.gcActive).not.toContain('stop-the-world (start trace)')
    expect(s.gcActive).toContain('stop-the-world (GC mark termination)')
  })

  it('tracks active GC ranges and heap metrics', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'gc_range_begin', gid: NO_RESOURCE, pid: NO_RESOURCE, mid: -1, name: 'stop-the-world' },
        { t: 2, type: 'metric', gid: NO_RESOURCE, pid: NO_RESOURCE, mid: -1, name: '/gc/heap/goal:bytes', value: 1000 },
        { t: 3, type: 'metric', gid: NO_RESOURCE, pid: NO_RESOURCE, mid: -1, name: '/memory/classes/heap/objects:bytes', value: 512 },
      ]),
      5,
    )
    expect(s.gcActive).toContain('stop-the-world')
    expect(s.heapGoal).toBe(1000)
    expect(s.heapLive).toBe(512)
  })
})

describe('stateAt M (OS thread) binding', () => {
  it('binds the M to both G and P on run start', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 5, pid: 0, mid: 3 },
        { t: 2, type: 'g_run_start', gid: 5, pid: 1, mid: 7 },
      ]),
      2,
    )
    expect(s.goroutines.get(5)?.mid).toBe(7)
    expect(s.procs[1].mid).toBe(7)
  })

  it('never binds the creator M from g_create', () => {
    const s = stateAt(tl([{ t: 1, type: 'g_create', gid: 5, pid: 0, mid: 3 }]), 2)
    expect(s.goroutines.get(5)?.mid).toBe(NO_RESOURCE)
  })

  it('never binds the unblocker M from g_unblock', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_create', gid: 5, pid: 0, mid: 3 },
        { t: 2, type: 'g_unblock', gid: 5, pid: 0, mid: 9 }, // M9 is the waker, not ours
      ]),
      2,
    )
    expect(s.goroutines.get(5)?.state).toBe('runnable')
    expect(s.goroutines.get(5)?.mid).toBe(NO_RESOURCE)
  })

  it('keeps the M with a syscall-blocked G while the P is handed to a new M', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_run_start', gid: 5, pid: 0, mid: 7 },
        { t: 2, type: 'g_syscall_enter', gid: 5, pid: 0, mid: 7 }, // M7 blocks with G5
        { t: 3, type: 'p_stop', gid: NO_RESOURCE, pid: 0, mid: 4 }, // sysmon/stealer M4 retakes
        { t: 4, type: 'p_start', gid: NO_RESOURCE, pid: 0, mid: 4 }, // M4 now drives P0
      ]),
      4,
    )
    const v = s.goroutines.get(5)!
    expect(v.state).toBe('syscall')
    expect(v.mid).toBe(7) // travels with the gopher
    expect(v.pid).toBe(0) // came-from hint survives
    expect(s.procs[0].mid).toBe(4) // station shows the new M
  })

  it('keeps the P M through syscall enter until p_stop (fast-path exit reuses it)', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_run_start', gid: 5, pid: 0, mid: 7 },
        { t: 2, type: 'g_syscall_enter', gid: 5, pid: 0, mid: 7 },
      ]),
      2,
    )
    expect(s.procs[0].mid).toBe(7) // _Psyscall: M still holds the P
    expect(s.procs[0].gid).toBe(NO_RESOURCE) // but no G runs on it
  })

  it('clears the G M when it stops, blocks or exits, keeping the P M', () => {
    for (const type of ['g_run_stop', 'g_block', 'g_exit'] as const) {
      const s = stateAt(
        tl([
          { t: 1, type: 'g_run_start', gid: 5, pid: 0, mid: 7 },
          { t: 2, type, gid: 5, pid: 0, mid: 7 },
        ]),
        2,
      )
      expect(s.goroutines.get(5)?.mid).toBe(NO_RESOURCE)
      expect(s.procs[0].mid).toBe(7) // M stays on the P looking for work
    }
  })

  it('releases the G M when a syscall return finds no P (syscall->runnable)', () => {
    const s = stateAt(
      tl([
        { t: 1, type: 'g_run_start', gid: 5, pid: 0, mid: 7 },
        { t: 2, type: 'g_syscall_enter', gid: 5, pid: 0, mid: 7 },
        { t: 3, type: 'g_unblock', gid: 5, pid: NO_RESOURCE, mid: 7 }, // returned, P gone
      ]),
      3,
    )
    expect(s.goroutines.get(5)?.state).toBe('runnable')
    expect(s.goroutines.get(5)?.mid).toBe(NO_RESOURCE) // its M parked
  })
})

describe('nextTime', () => {
  it('clamps to [0, duration]', () => {
    expect(nextTime(0, -100, 1000, 1)).toBe(0)
    expect(nextTime(999, 1e9, 1000, 1)).toBe(1000)
  })

  it('scales with speed', () => {
    const a = nextTime(0, 100, 20000, 1)
    const b = nextTime(0, 100, 20000, 2)
    expect(b).toBeCloseTo(a * 2)
  })

  it('returns 0 for a zero-duration timeline', () => {
    expect(nextTime(5, 100, 0, 1)).toBe(0)
  })
})

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})


describe('trace boundary fidelity', () => {
  it('preserves all initial states without inventing a wakeup or execution P', () => {
    const states = ['runnable', 'waiting', 'running', 'syscall'] as const
    for (const state of states) {
      const s = stateAt(tl([{ t: 0, type: 'g_status', gid: 42, pid: 1, mid: 7, state }]), 0)
      expect(s.goroutines.get(42)?.state).toBe(state)
      expect(s.goroutines.get(42)?.mid).toBe(state === 'running' || state === 'syscall' ? 7 : -1)
      expect(s.procs[1].gid).toBe(state === 'running' ? 42 : -1)
    }
  })

  it('never retains the waker P as the runnable G binding', () => {
    const s = stateAt(tl([{ t: 1, type: 'g_unblock', gid: 5, pid: 1, mid: 7 }]), 1)
    expect(s.goroutines.get(5)?.pid).toBe(NO_RESOURCE)
  })

  it('does not bind a single M to two Ps', () => {
    const s = stateAt(tl([
      { t: 1, type: 'p_start', gid: -1, pid: 0, mid: 7 },
      { t: 2, type: 'p_start', gid: -1, pid: 1, mid: 7 },
    ]), 2)
    expect(s.procs.filter(p => p.mid === 7)).toHaveLength(1)
  })

  it('tracks recorded GOMAXPROCS changes and disables retired P stations', () => {
    const s = stateAt(tl([
      { t: 0, type: 'metric', gid: -1, pid: -1, mid: -1, name: '/sched/gomaxprocs:threads', value: 4 },
      { t: 1, type: 'metric', gid: -1, pid: -1, mid: -1, name: '/sched/gomaxprocs:threads', value: 1 },
    ]), 1)
    expect(s.gomaxprocs).toBe(1)
    expect(s.procs.slice(1).every(p => p.status === 'inactive')).toBe(true)
  })

  it('seeds a phase already active at trace start exactly once', () => {
    const s = stateAt(tl([
      { t: 0, type: 'gc_range_active', gid: -1, pid: -1, mid: -1, name: 'GC concurrent mark phase' },
      { t: 1, type: 'gc_range_active', gid: -1, pid: -1, mid: -1, name: 'GC concurrent mark phase' },
    ]), 1)
    expect(s.gcActive).toEqual(['GC concurrent mark phase'])
  })
})
