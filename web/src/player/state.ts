import { NO_RESOURCE, type Timeline } from '../model/timeline'
import { isTracerArtifact } from './gc'

export type GState = 'runnable' | 'running' | 'waiting' | 'syscall' | 'dead'

export interface GoroutineView {
  gid: number
  state: GState
  /**
   * associated P: for `running` it is the P actually executing this goroutine.
   * For `syscall` it is the P the goroutine left on entering the call — the P
   * may still be in _Psyscall, or may have been released to another M;
   * this is only a "came from" hint (shown in the tooltip). For `waiting` it is
   * NO_RESOURCE (a blocked goroutine holds no P).
   */
  pid: number
  /**
   * OS thread (M) executing this goroutine (`running`) or associated with
   * its recorded syscall (`syscall`); NO_RESOURCE otherwise. Real ids from
   * the trace — bound only on the goroutine's own execution events, because
   * on g_unblock/g_create the event's mid belongs to the unblocker/creator.
   */
  mid: number
  reason?: string
  /** Legacy compatibility field; always false, never interpreted as fact. */
  stolen: boolean
}

export interface ProcView {
  pid: number
  /** the goroutine currently running on this P, or NO_RESOURCE. */
  gid: number
  /**
   * OS thread (M) that owns this P, or NO_RESOURCE. Kept through a running
   * goroutine's syscall enter (the M holds the P in _Psyscall until sysmon
   * takes it away, which arrives as p_stop) and through idle gaps between
   * runs (the M stays on the P looking for work).
   */
  mid: number
  status?: 'unknown' | 'running' | 'idle' | 'syscall' | 'inactive'
}

export interface WorldState {
  t: number
  gomaxprocs?: number
  procs: ProcView[]
  goroutines: Map<number, GoroutineView>
  /** names of GC ranges active at t (e.g. stop-the-world). */
  gcActive: string[]
  heapLive?: number
  heapGoal?: number
}

// Heap metric names (must match the backend's traceparse constants).
const metricHeapLive = '/memory/classes/heap/objects:bytes'
const metricHeapGoal = '/gc/heap/goal:bytes'

// stateAt folds every event with t' <= t into the world state at time t. It is
// pure (no clock, no rendering), which makes scrubbing trivial and the logic
// unit-testable. Proc occupancy is derived from goroutine events; the explicit
// p_start/p_stop events contribute only M ownership.
export function stateAt(timeline: Timeline, t: number): WorldState {
  const n = timeline.meta.numProcs
  const procs: ProcView[] = Array.from({ length: n }, (_, pid) => ({
    pid,
    gid: NO_RESOURCE,
    mid: NO_RESOURCE,
  }))
  const goroutines = new Map<number, GoroutineView>()
  const gcActive: string[] = []
  let gomaxprocs: number | undefined
  let heapLive: number | undefined
  let heapGoal: number | undefined

  const setProc = (pid: number, gid: number) => {
    if (pid >= 0 && pid < n) procs[pid].gid = gid
  }
  const clearProc = (pid: number, gid: number) => {
    if (pid >= 0 && pid < n && procs[pid].gid === gid) procs[pid].gid = NO_RESOURCE
  }
  const setProcM = (pid: number, mid: number) => {
    if (pid >= 0 && pid < n && mid >= 0) {
      // One M can execute with only one P. Release stale ownership on handoff.
      for (const p of procs) if (p.pid !== pid && p.mid === mid) p.mid = NO_RESOURCE
      procs[pid].mid = mid
      procs[pid].status = 'running'
    }
  }
  const view = (gid: number): GoroutineView => {
    let v = goroutines.get(gid)
    if (!v) {
      v = { gid, state: 'runnable', pid: NO_RESOURCE, mid: NO_RESOURCE, stolen: false }
      goroutines.set(gid, v)
    }
    return v
  }

  for (const e of timeline.events) {
    if (e.t > t) break
    switch (e.type) {
      case 'g_status': {
        if (!e.state) break
        const v = view(e.gid)
        v.state = e.state
        v.pid = e.state === 'running' || e.state === 'syscall' ? e.pid : NO_RESOURCE
        v.mid = e.state === 'running' || e.state === 'syscall' ? e.mid : NO_RESOURCE
        if (e.state === 'running') { setProc(e.pid, e.gid); setProcM(e.pid, e.mid) }
        break
      }
      case 'g_create': {
        // The ordinary go statement starts Runnable; runtime helpers may be
        // created Waiting or in Syscall (e.g. cgo). Creator M never binds a
        // Runnable/Waiting target.
        const state = e.state ?? 'runnable'
        goroutines.set(e.gid, {
          gid: e.gid, state,
          pid: NO_RESOURCE,
          mid: state === 'syscall' ? e.mid : NO_RESOURCE,
          stolen: false,
        })
        break
      }
      case 'g_run_start': {
        const v = view(e.gid)
        v.state = 'running'
        v.pid = e.pid
        v.mid = e.mid
        v.stolen = false
        v.reason = undefined
        setProc(e.pid, e.gid)
        setProcM(e.pid, e.mid)
        break
      }
      case 'g_syscall_exit': {
        const v = view(e.gid)
        v.state = 'running'
        v.pid = e.pid
        v.mid = e.mid // the M that blocked in the kernel is the one that returns
        v.stolen = false
        setProc(e.pid, e.gid)
        setProcM(e.pid, e.mid)
        break
      }
      case 'g_run_stop': {
        const v = view(e.gid)
        clearProc(e.pid, e.gid)
        v.state = 'runnable'
        v.reason = e.reason
        v.pid = NO_RESOURCE
        v.mid = NO_RESOURCE // the M stays on the P (procs keeps it), not on the G
        v.stolen = false
        break
      }
      case 'g_unblock': {
        const v = view(e.gid)
        v.state = 'runnable'
        v.reason = e.reason
        v.pid = NO_RESOURCE
        // e.mid is the UNBLOCKER's M; and for syscall->runnable the goroutine's
        // own M just parked. Either way: no M.
        v.mid = NO_RESOURCE
        v.stolen = false
        break
      }
      case 'g_block': {
        const v = view(e.gid)
        clearProc(e.pid, e.gid)
        v.state = 'waiting'
        v.reason = e.reason
        v.pid = NO_RESOURCE
        v.mid = NO_RESOURCE
        v.stolen = false
        break
      }
      case 'g_syscall_enter': {
        const v = view(e.gid)
        clearProc(e.pid, e.gid)
        v.state = 'syscall'
        v.pid = e.pid
        v.mid = e.mid // the M blocks in the kernel together with its G
        v.stolen = false
        if (e.pid >= 0 && e.pid < n) procs[e.pid].status = 'syscall'
        // procs[pid].mid is left as-is: the M holds the P until sysmon takes
        // it away, which shows up as an explicit p_stop.
        break
      }
      case 'g_exit': {
        const v = view(e.gid)
        clearProc(e.pid, e.gid)
        v.state = 'dead'
        v.pid = NO_RESOURCE
        v.mid = NO_RESOURCE
        v.stolen = false
        break
      }
      case 'p_start':
        // Proc occupancy is derived from goroutine events; p_start contributes
        // the M acquiring this P.
        setProcM(e.pid, e.mid)
        break
      case 'p_stop':
        // e.mid on a steal is the STEALER's M — just drop ownership.
        if (e.pid >= 0 && e.pid < n) { procs[e.pid].mid = NO_RESOURCE; procs[e.pid].status = 'idle' }
        break
      case 'gc_range_active':
      case 'gc_range_begin':
        // Skip the tracer's start-trace STW artifact so it never reads as a GC
        // phase (its matching end below simply finds nothing to remove).
        if (e.name && !isTracerArtifact(e.name) && !gcActive.includes(e.name)) gcActive.push(e.name)
        break
      case 'gc_range_end': {
        if (e.name) {
          const i = gcActive.lastIndexOf(e.name)
          if (i >= 0) gcActive.splice(i, 1)
        }
        break
      }
      case 'metric':
        if (e.name === '/sched/gomaxprocs:threads' && e.value !== undefined) {
          gomaxprocs = e.value
          for (const p of procs) {
            if (p.pid >= e.value) { p.status = 'inactive'; p.gid = NO_RESOURCE; p.mid = NO_RESOURCE }
            else if (p.status === 'inactive') p.status = 'unknown'
          }
        }
        else if (e.name === metricHeapLive) heapLive = e.value
        else if (e.name === metricHeapGoal) heapGoal = e.value
        break
    }
  }

  return { t, gomaxprocs, procs, goroutines, gcActive, heapLive, heapGoal }
}
