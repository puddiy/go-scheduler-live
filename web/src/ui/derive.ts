import type { WorldState } from '../player/state'
import { reasonCategory, REASON_CATEGORIES, type ReasonCategory } from '../player/reason'
import { PAL } from '../scene/palette'
import { t } from '../i18n'

// Pure derivations from a WorldState for the DOM chrome (GC indicator, heap bar,
// waiting-reasons breakdown). Kept separate from the DOM Chrome so they stay
// unit-testable, mirroring player/narrate.ts and player/reason.ts.

export type GcKind = 'idle' | 'mark' | 'stw'

export interface GcPhase {
  kind: GcKind
  label: string
  color: string
}

// gcPhase reduces the active GC range names to the one phase the header shows.
// stop-the-world wins over a concurrent mark; absence of both reads as idle.
export function gcPhase(world: WorldState): GcPhase {
  const active = world.gcActive
  if (active.some((n) => n.includes('stop-the-world'))) return { kind: 'stw', label: t().gcPhase.stw, color: PAL.gcStw }
  if (active.some((n) => n.includes('mark'))) return { kind: 'mark', label: t().gcPhase.mark, color: PAL.teal }
  return { kind: 'idle', label: t().gcPhase.idle, color: PAL.gcIdle }
}

// heapPct is the allocated-objects fraction of the soft GC goal, including overshoot, or null
// when the trace carries no heap metrics yet (the bar then reads empty).
export function heapPct(world: WorldState): number | null {
  const { heapLive, heapGoal } = world
  if (heapLive === undefined || heapGoal === undefined || heapGoal <= 0) return null
  return Math.max(0, heapLive / heapGoal)
}

export interface WaitGroup {
  category: ReasonCategory
  count: number
}

// waitingBreakdown counts blocked goroutines per reason category, dropping empty
// buckets and keeping the canonical category order for a stable readout.
export function waitingBreakdown(world: WorldState): WaitGroup[] {
  const counts = new Map<ReasonCategory, number>()
  for (const v of world.goroutines.values()) {
    if (v.state !== 'waiting') continue
    const c = reasonCategory(v.reason)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  return REASON_CATEGORIES.filter((c) => counts.has(c)).map((c) => ({ category: c, count: counts.get(c)! }))
}

/** Counts include every observed G, independently of scene render caps. */
export function schedulerCounts(world: WorldState): Record<'running' | 'runnable' | 'waiting' | 'syscall', number> {
  const counts = { running: 0, runnable: 0, waiting: 0, syscall: 0 }
  for (const g of world.goroutines.values()) if (g.state !== 'dead') counts[g.state]++
  return counts
}
