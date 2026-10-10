// Mirror of the Go timeline DTO (internal/timeline). Keep these in sync with the
// backend's JSON contract.

export type EventType =
  | 'g_status'
  | 'gc_range_active'
  | 'trace_end'
  | 'g_create'
  | 'g_run_start'
  | 'g_run_stop'
  | 'g_block'
  | 'g_unblock'
  | 'g_syscall_enter'
  | 'g_syscall_exit'
  | 'g_exit'
  | 'p_start'
  | 'p_stop'
  | 'gc_range_begin'
  | 'gc_range_end'
  | 'metric'

/** Sentinel for an absent goroutine/proc/thread id (matches timeline.NoResource). */
export const NO_RESOURCE = -1

export interface TimelineEvent {
  /** ns since the first trace event. */
  t: number
  type: EventType
  gid: number
  pid: number
  /**
   * OS thread (M) of the *executing context*, verbatim from the trace.
   * Careful: on g_unblock/g_create it is the unblocker's/creator's M (not the
   * target goroutine's), and on a steal-caused p_stop it is the stealer's M.
   * Bind an M to a G/P only on own-execution events — see stateAt.
   */
  mid: number
  /** Executing G context for create/unblock; -1 means absent, undefined is legacy. */
  actorGid?: number
  state?: 'runnable' | 'running' | 'waiting' | 'syscall' | 'dead'
  initial?: boolean
  reason?: string
  name?: string
  value?: number
  stolen?: boolean
}

export interface Meta {
  scenario: string
  numProcs: number
  durationNs: number
  goroutines: number[]
}

export interface Timeline {
  meta: Meta
  events: TimelineEvent[]
}

export interface ScenarioParam {
  name: string
  min: number
  max: number
  default: number
}

export interface ScenarioInfo {
  id: string
  title: string
  description: string
  order: number
  params: ScenarioParam[]
}
