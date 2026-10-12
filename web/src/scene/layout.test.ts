import { describe, it, expect } from 'vitest'
import { placeIso, placeThreads, midAliases, zoneTotals, WAITING, SYSCALL, GLOBAL, CAPS, THREAD_ST_DX, THREAD_ST_DY, THREAD_SYS_DY } from './layout'
import { stationPositions } from './iso'
import { NO_RESOURCE } from '../model/timeline'
import type { GoroutineView, WorldState } from '../player/state'

function world(views: GoroutineView[]): WorldState {
  const goroutines = new Map<number, GoroutineView>()
  for (const v of views) goroutines.set(v.gid, v)
  return { t: 0, procs: [], goroutines, gcActive: [] }
}

function inRect(p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

function runnables(n: number, pid: number): GoroutineView[] {
  return Array.from({ length: n }, (_, i) => ({ gid: i + 1, state: 'runnable' as const, pid, mid: -1, stolen: false }))
}

describe('placeIso', () => {
  it('stands a running goroutine on its station at full scale', () => {
    const st = stationPositions(4)[2]
    const p = placeIso(world([{ gid: 1, state: 'running', pid: 2, mid: -1, stolen: false }]), 4)
    expect(p.get(1)).toEqual({ x: st.x, y: st.y, scale: 1 })
  })

  it('places runnable Gs in one pool without assigning invented local queues', () => {
    const w = world(runnables(8, 0))
    const p = placeIso(w, 4)
    expect([...p.values()].every(q => inRect(q, GLOBAL))).toBe(true)
    expect(new Set([...p.values()].map(q => `${q.x},${q.y}`)).size).toBe(8)
  })

  it('caps the runnable drawing without changing its real count', () => {
    const w = world(runnables(CAPS.global + 12, NO_RESOURCE))
    expect(placeIso(w, 4).size).toBe(CAPS.global)
    expect(zoneTotals(w).global).toBe(CAPS.global + 12)
  })

  it('renders zone (waiting/syscall) gophers at reduced scale so they do not overlap', () => {
    const p = placeIso(
      world([
        { gid: 1, state: 'waiting', pid: NO_RESOURCE, mid: -1, stolen: false, reason: 'chan receive' },
        { gid: 2, state: 'syscall', pid: 1, mid: -1, stolen: false },
      ]),
      4,
    )
    expect(inRect(p.get(1)!, WAITING)).toBe(true)
    expect(inRect(p.get(2)!, SYSCALL)).toBe(true)
    expect(p.get(1)!.scale).toBeLessThan(1)
    expect(p.get(2)!.scale).toBeLessThan(1)
  })

  it('skips dead goroutines', () => {
    const p = placeIso(world([{ gid: 3, state: 'dead', pid: NO_RESOURCE, mid: -1, stolen: false }]), 4)
    expect(p.has(3)).toBe(false)
  })


})

describe('zoneTotals', () => {
  it('counts all runnable Gs without claiming local or global queue membership', () => {
    const tot = zoneTotals(world(runnables(8, 0)))
    expect(tot.global).toBe(8)
  })

  it('counts waiting and syscall', () => {
    const tot = zoneTotals(
      world([
        { gid: 1, state: 'waiting', pid: -1, mid: -1, stolen: false },
        { gid: 2, state: 'waiting', pid: -1, mid: -1, stolen: false },
        { gid: 3, state: 'syscall', pid: 0, mid: -1, stolen: false },
      ]),
    )
    expect(tot.waiting).toBe(2)
    expect(tot.syscall).toBe(1)
  })
})

describe('placeThreads', () => {
  const procsWith = (mids: number[]): WorldState['procs'] =>
    mids.map((mid, pid) => ({ pid, gid: NO_RESOURCE, mid }))

  it('docks a P-bound M at its station offset, full scale', () => {
    const w = world([])
    w.procs = procsWith([7, NO_RESOURCE])
    const st = stationPositions(2)[0]
    const t = placeThreads(w, 2, placeIso(w, 2))
    expect(t.get(7)).toEqual({ x: st.x + THREAD_ST_DX, y: st.y + THREAD_ST_DY, scale: 1 })
    expect(t.size).toBe(1) // unbound P1 contributes nothing
  })

  it('docks the M even when no G runs on the P', () => {
    const w = world([]) // empty stations, M parked looking for work
    w.procs = procsWith([3])
    expect(placeThreads(w, 1, placeIso(w, 1)).has(3)).toBe(true)
  })

  it('puts a syscall M under its gopher at the gopher scale', () => {
    const w = world([{ gid: 5, state: 'syscall', pid: 0, mid: 7, stolen: false }])
    const gophers = placeIso(w, 2)
    const g = gophers.get(5)!
    const t = placeThreads(w, 2, gophers)
    expect(t.get(7)).toEqual({ x: g.x, y: g.y + THREAD_SYS_DY * g.scale, scale: g.scale })
  })

  it('prefers the syscall side when the same M still owns a P (_Psyscall gap)', () => {
    const w = world([{ gid: 5, state: 'syscall', pid: 0, mid: 7, stolen: false }])
    w.procs = procsWith([7])
    const gophers = placeIso(w, 1)
    const t = placeThreads(w, 1, gophers)
    expect(t.size).toBe(1)
    expect(t.get(7)!.scale).toBeLessThan(1) // zone placement, not the station dock
  })

  it('omits Ms of syscall gophers beyond the render cap', () => {
    const views: GoroutineView[] = Array.from({ length: CAPS.syscall + 2 }, (_, i) => ({
      gid: i + 1,
      state: 'syscall' as const,
      pid: NO_RESOURCE,
      mid: 100 + i,
      stolen: false,
    }))
    const w = world(views)
    const t = placeThreads(w, 2, placeIso(w, 2))
    expect(t.size).toBe(CAPS.syscall) // the +N badge covers the rest
  })

  it('shows nothing for parked Ms (no P, no syscall)', () => {
    const w = world([{ gid: 5, state: 'waiting', pid: NO_RESOURCE, mid: NO_RESOURCE, stolen: false }])
    expect(placeThreads(w, 2, placeIso(w, 2)).size).toBe(0)
  })
})

describe('midAliases', () => {
  it('numbers threads 1..N in first-seen order, skipping NO_RESOURCE', () => {
    const ev = (mid: number): Parameters<typeof midAliases>[0][number] =>
      ({ t: 0, type: 'g_run_start', gid: 1, pid: 0, mid })
    const a = midAliases([ev(6103904256), ev(-1), ev(42), ev(6103904256)])
    expect(a.get(6103904256)).toBe(1)
    expect(a.get(42)).toBe(2)
    expect(a.size).toBe(2)
  })
})
