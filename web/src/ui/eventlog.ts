// Event log panel: a scrollable, human-readable journal of every timeline
// event (metrics excluded — thousands of heap samples would drown it), synced
// to the playhead. The one-line caption above shows "the most notable thing
// now"; this panel is the full record the caption deliberately is not.
//
// formatLogRow is pure (vitest); EventLog owns the DOM. Rows are built once
// per timeline (a few thousand light divs), then playback only moves the
// past/future split and auto-scrolls — no per-frame rebuilding.

import type { TimelineEvent } from '../model/timeline'
import { PAL } from '../scene/palette'
import { t } from '../i18n'

export type LogCat = 'sched' | 'wait' | 'syscall' | 'gc' | 'proc'

export interface LogRow {
  cat: LogCat
  text: string
}

export const LOG_CATS: ReadonlyArray<readonly [LogCat, string]> = [
  ['sched', PAL.running],
  ['wait', PAL.waiting],
  ['syscall', PAL.syscall],
  ['gc', PAL.teal],
  ['proc', PAL.platEdge],
]

export interface TimedLogRow extends LogRow {
  t: number
}

// fmtDur renders a real duration in the most legible unit.
export function fmtDur(ns: number): string {
  const u = t().units
  if (ns < 1_000) return `${Math.round(ns)} ${u.ns}`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(ns < 10_000 ? 1 : 0)} ${u.us}`
  return `${(ns / 1_000_000).toFixed(2)} ${u.ms}`
}

export function fmtMs(tNs: number): string {
  return `${(tNs / 1e6).toFixed(2)}`
}

// How a goroutine last became runnable — the provenance of its next run start.
type RunnableVia = 'create' | 'stop' | 'unblock' | 'sysreturn'

interface GCtx {
  state: 'runnable' | 'running' | 'waiting' | 'syscall' | 'dead'
  since: number
  created?: number
  reason?: string
  partial?: boolean
  via?: RunnableVia
  wakerGid?: number
}

// buildLogRows folds the whole event stream once and renders every row WITH
// its causality — all of it derived strictly from trace facts, never from the
// visual reconstructions:
//  - who woke/created a goroutine: the event's mid is the waker's/creator's M,
//    and the fold knows which G was executing on that M (same executor
//    semantics as stateAt, unblocker trap included);
//  - how long it waited / ran / stayed in syscall: time since it entered the
//    previous state;
//  - a p_stop releases P; the initiator and next owner are not inferred.
// Metrics are skipped (thousands of heap samples would drown the journal).
export function buildLogRows(events: TimelineEvent[], midAlias?: Map<number, number>): TimedLogRow[] {
  const L = t().log
  const m = (mid: number): string => `M${midAlias?.get(mid) ?? mid}`
  const gs = new Map<number, GCtx>()
  const mBusy = new Map<number, number>() // executing mid -> gid
  const gToM = new Map<number, number>() // gid -> its executing/syscall mid
  const pOwner = new Map<number, number>() // pid -> mid
  const sysWithM = new Map<number, number>() // mid blocked in kernel -> its gid

  const bind = (gid: number, mid: number, running = true): void => {
    if (mid < 0) return
    if (running) mBusy.set(mid, gid)
    else mBusy.delete(mid)
    gToM.set(gid, mid)
  }
  const unbind = (gid: number): void => {
    const mid = gToM.get(gid)
    if (mid !== undefined) {
      gToM.delete(gid)
      if (mBusy.get(mid) === gid) mBusy.delete(mid)
    }
  }
  // The G executing on the event's M — the actor behind creates/unblocks.
  const actor = (e: TimelineEvent): number | undefined => {
    if (e.actorGid !== undefined) return e.actorGid >= 0 && e.actorGid !== e.gid ? e.actorGid : undefined
    if (e.mid < 0) return undefined
    const gid = mBusy.get(e.mid)
    return gid !== undefined && gid !== e.gid ? gid : undefined
  }

  const out: TimedLogRow[] = []
  const push = (t: number, cat: LogCat, text: string): void => {
    out.push({ t, cat, text })
  }

  for (const e of events) {
    const ctx = gs.get(e.gid)
    const dur = (): string => (ctx ? `${ctx.partial ? '≥' : ''}${fmtDur(e.t - ctx.since)}` : '')
    switch (e.type) {
      case 'g_status': {
        if (!e.state) break
        push(e.t, 'sched', L.snapshot(e.gid, t().scene.states[e.state]))
        gs.set(e.gid, { state: e.state, since: e.t, partial: true })
        if (e.state === 'running' || e.state === 'syscall') bind(e.gid, e.mid, e.state === 'running')
        if (e.state === 'syscall' && e.mid >= 0) sysWithM.set(e.mid, e.gid)
        if (e.state === 'running' && e.mid >= 0 && e.pid >= 0) pOwner.set(e.pid, e.mid)
        break
      }
      case 'g_create': {
        const by = actor(e)
        push(e.t, 'sched', L.created(e.gid, by))
        gs.set(e.gid, { state: e.state ?? 'runnable', since: e.t, created: e.t, via: 'create' })
        if (e.state === 'syscall') { bind(e.gid, e.mid, false); if (e.mid >= 0) sysWithM.set(e.mid, e.gid) }
        break
      }
      case 'g_run_start': {
        let why = ''
        if (ctx?.state === 'runnable') {
          if (ctx.via === 'create') why = L.whyFirst(dur())
          else if (ctx.via === 'sysreturn') why = L.whyAfterSyscall(dur())
          else why = L.whyWoken(dur(), ctx.via === 'unblock' ? ctx.wakerGid : undefined)
        }
        push(e.t, 'sched', L.gotP(e.gid, e.pid, e.mid >= 0 ? m(e.mid) : null, why))
        gs.set(e.gid, { ...ctx, partial: false, state: 'running', since: e.t })
        bind(e.gid, e.mid)
        if (e.mid >= 0 && e.pid >= 0) pOwner.set(e.pid, e.mid)
        break
      }
      case 'g_run_stop': {
        push(e.t, 'sched', L.offP(e.gid, e.pid, ctx?.state === 'running' ? dur() : null) + (e.reason ? ` · ${e.reason}` : ''))
        gs.set(e.gid, { ...ctx, partial: false, state: 'runnable', since: e.t, via: 'stop', wakerGid: undefined })
        unbind(e.gid)
        break
      }
      case 'g_block': {
        push(e.t, 'wait', L.blocked(e.gid, e.reason, ctx?.state === 'running' ? dur() : null))
        gs.set(e.gid, { ...ctx, partial: false, state: 'waiting', since: e.t, reason: e.reason })
        unbind(e.gid)
        break
      }
      case 'g_unblock': {
        if (ctx?.state === 'syscall') {
          // This transition establishes Runnable, without proving why it was scheduled.
          push(e.t, 'syscall', L.sysReturnRunnable(e.gid, dur()))
          const mid = gToM.get(e.gid)
          if (mid !== undefined) sysWithM.delete(mid)
          gs.set(e.gid, { ...ctx, partial: false, state: 'runnable', since: e.t, via: 'sysreturn', wakerGid: undefined })
          unbind(e.gid)
          break
        }
        const by = actor(e)
        const inWait = ctx?.state === 'waiting'
        push(e.t, 'wait', L.woken(e.gid, by, inWait ? ctx?.reason : undefined, inWait ? dur() : null))
        gs.set(e.gid, { ...ctx, partial: false, state: 'runnable', since: e.t, via: 'unblock', wakerGid: by })
        break
      }
      case 'g_syscall_enter': {
        push(e.t, 'syscall', L.sysEnter(e.gid, e.mid >= 0 ? m(e.mid) : null))
        gs.set(e.gid, { ...ctx, partial: false, state: 'syscall', since: e.t })
        bind(e.gid, e.mid, false)
        if (e.mid >= 0) sysWithM.set(e.mid, e.gid)
        break
      }
      case 'g_syscall_exit': {
        push(e.t, 'syscall', L.sysExit(e.gid, e.pid, ctx?.state === 'syscall' ? dur() : null))
        if (e.mid >= 0) sysWithM.delete(e.mid)
        gs.set(e.gid, { ...ctx, partial: false, state: 'running', since: e.t })
        bind(e.gid, e.mid)
        if (e.mid >= 0 && e.pid >= 0) pOwner.set(e.pid, e.mid)
        break
      }
      case 'g_exit': {
        const mid = gToM.get(e.gid)
        if (mid !== undefined && sysWithM.get(mid) === e.gid) sysWithM.delete(mid)
        push(e.t, 'sched', L.exited(e.gid, ctx?.created !== undefined ? fmtDur(e.t - ctx.created) : null))
        gs.set(e.gid, { ...ctx, partial: false, state: 'dead', since: e.t })
        unbind(e.gid)
        break
      }
      case 'p_start':
        push(e.t, 'proc', e.initial ? L.pSnapshot(e.pid, 'running') : L.pStart(e.pid, e.mid >= 0 ? m(e.mid) : null))
        if (e.mid >= 0) pOwner.set(e.pid, e.mid)
        break
      case 'p_stop': {
        const owner = pOwner.get(e.pid)
        const stuckG = owner !== undefined ? sysWithM.get(owner) : undefined
        push(e.t, 'proc', e.initial ? L.pSnapshot(e.pid, 'idle') : stuckG !== undefined ? L.pStopRetake(e.pid, m(owner!), stuckG) : L.pStop(e.pid))
        pOwner.delete(e.pid)
        break
      }
      case 'gc_range_active':
        push(e.t, 'gc', L.gcActive(e.name ?? '?'))
        break
      case 'gc_range_begin':
        push(e.t, 'gc', L.gcBegin(e.name ?? '?'))
        break
      case 'gc_range_end':
        push(e.t, 'gc', L.gcEnd(e.name ?? '?'))
        break
      case 'metric':
        if (e.name === '/sched/gomaxprocs:threads') push(e.t, 'proc', `GOMAXPROCS = ${e.value}`)
        break
    }
  }
  return out
}

// EventLog renders and owns the panel. Auto-scroll follows the playhead unless
// the pointer is over the panel (the user is reading — don't yank the scroll).
export class EventLog {
  readonly root: HTMLDivElement
  private readonly list: HTMLDivElement
  private times: number[] = []
  private rows: HTMLDivElement[] = []
  private cursor = 0 // rows[0..cursor) are past, the rest future
  private hovered = false
  private visible = true

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'event-log'

    const head = document.createElement('div')
    head.className = 'event-log-head'
    const title = document.createElement('span')
    title.className = 'event-log-title'
    title.textContent = t().log.header
    title.title = t().log.headerTip
    head.append(title)
    for (const [cat, color] of LOG_CATS) {
      const label = t().log.cats[cat]
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'event-log-chip active'
      chip.textContent = label
      chip.style.setProperty('--chip', color)
      chip.setAttribute('aria-pressed', 'true')
      chip.addEventListener('click', () => {
        const on = this.root.classList.toggle(`hide-${cat}`) === false
        chip.classList.toggle('active', on)
        chip.setAttribute('aria-pressed', String(on))
      })
      head.append(chip)
    }

    this.list = document.createElement('div')
    this.list.className = 'event-log-list'
    this.list.addEventListener('pointerenter', () => (this.hovered = true))
    this.list.addEventListener('pointerleave', () => (this.hovered = false))

    this.root.append(head, this.list)
  }

  build(events: TimelineEvent[], midAlias?: Map<number, number>): void {
    this.list.textContent = ''
    this.times = []
    this.rows = []
    this.cursor = 0
    const frag = document.createDocumentFragment()
    for (const row of buildLogRows(events, midAlias)) {
      const div = document.createElement('div')
      div.className = `event-log-row cat-${row.cat} future`
      const t = document.createElement('span')
      t.className = 'event-log-t'
      t.textContent = fmtMs(row.t)
      div.append(t, document.createTextNode(row.text))
      frag.append(div)
      this.times.push(row.t)
      this.rows.push(div)
    }
    this.list.append(frag)
  }

  // setT moves the past/future split to the playhead and keeps the newest past
  // row in view. O(rows crossed since the last call), not O(total).
  setT(tNs: number): void {
    let c = this.cursor
    while (c < this.times.length && this.times[c] <= tNs) c++
    while (c > 0 && this.times[c - 1] > tNs) c--
    if (c === this.cursor) return
    const lo = Math.min(c, this.cursor)
    const hi = Math.max(c, this.cursor)
    for (let i = lo; i < hi; i++) this.rows[i].classList.toggle('future', i >= c)
    this.cursor = c
    if (this.visible && !this.hovered && c > 0) {
      this.rows[c - 1].scrollIntoView({ block: 'nearest' })
    }
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.root.style.display = v ? '' : 'none'
  }
}
