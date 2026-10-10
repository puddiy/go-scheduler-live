import type { WorldState } from '../player/state'
import type { TimelineEvent } from '../model/timeline'
import { stationPositions, type Pt } from './iso'

// Spatial layout encodes observed G states and own-execution P/M bindings.
// Runnable Gs share an unassigned pool: runtime/trace exposes neither queue
// membership nor steals. Render caps only hide sprites; counters retain all Gs.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Placement extends Pt {
  /** sprite render scale: 1 on a platform, <1 for queue/zone crowds. */
  scale: number
}

// Bottom-zone rectangles, a clean left-to-right row [global | waiting | syscall].
export const GLOBAL: Rect = { x: 20, y: 232, w: 150, h: 90 }
export const WAITING: Rect = { x: 196, y: 232, w: 156, h: 90 }
export const SYSCALL: Rect = { x: 402, y: 232, w: 150, h: 90 }

// Per-zone render caps. Surplus goroutines are counted, not placed (see zoneTotals).
export const CAPS = { global: 18, waiting: 18, syscall: 14 } as const

// Sprite scales by role. Crowded zones shrink so neighbours don't overlap into a
// blob (the sprite footprint is ~48x52; zone spacing below is sized to the scaled
// footprint).
const RUN_SCALE = 1
const ZONE_SCALE = 0.55

const PACK_DX = 20
const PACK_DY = 22

// packStagger lays index i into a staggered grid filling the rect by columns,
// wrapping into half-offset rows. Sized for ZONE_SCALE sprites.
function packStagger(r: Rect, i: number): Pt {
  const cols = Math.max(1, Math.floor((r.w - 8) / PACK_DX))
  const row = Math.floor(i / cols)
  const col = i % cols
  return {
    x: r.x + 12 + col * PACK_DX + (row % 2) * (PACK_DX / 2),
    y: r.y + 26 + row * PACK_DY,
  }
}

export interface ZoneTotals {
  /** All observed runnable Gs, regardless of unknown queue membership. */
  global: number
  waiting: number
  syscall: number
}

// Counts cover all observed Gs, including sprites hidden by the render caps.
export function zoneTotals(world: WorldState): ZoneTotals {
  let global = 0, waiting = 0, syscall = 0
  for (const v of world.goroutines.values()) {
    if (v.state === 'runnable') global++
    else if (v.state === 'waiting') waiting++
    else if (v.state === 'syscall') syscall++
  }
  return { global, waiting, syscall }
}

// midAliases maps every real thread id in the trace to a small display ordinal
// (1, 2, 3… in first-seen order). Real ThreadIDs on darwin are huge mach ids
// (e.g. 6103904256) that would never fit a sprite tag; the ordinal is a stable
// per-run alias, and the tooltip still reports the real id. Pure.
export function midAliases(events: TimelineEvent[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const e of events) {
    if (e.mid >= 0 && !out.has(e.mid)) out.set(e.mid, out.size + 1)
  }
  return out
}

// M (OS thread) placement offsets relative to its anchor.
export const THREAD_ST_DX = 13 // front-right of the P platform, clear of the gopher
export const THREAD_ST_DY = 7
export const THREAD_SYS_DY = 6 // just below a syscall gopher's feet

// placeThreads maps each *visible* M to a position: with the syscall gopher it
// is blocked under (same spot, so they travel together), or docked at the P
// station it owns. Parked Ms have no trace events and are honestly absent.
// Takes the already-computed placeIso result so a syscall M lands exactly on
// its gopher. During the brief _Psyscall gap one M can be both "in syscall"
// and still own the P — the syscall side wins (one M, one sprite). Pure.
export function placeThreads(
  world: WorldState,
  numProcs: number,
  gophers: Map<number, Placement>,
): Map<number, Placement> {
  const out = new Map<number, Placement>()
  const stations = stationPositions(numProcs)

  const gids = [...world.goroutines.keys()].sort((a, b) => a - b)
  for (const gid of gids) {
    const v = world.goroutines.get(gid)!
    if (v.state !== 'syscall' || v.mid < 0) continue
    const g = gophers.get(gid)
    if (!g) continue // gopher beyond CAPS.syscall — the "+N" badge covers its M too
    out.set(v.mid, { x: g.x, y: g.y + THREAD_SYS_DY * g.scale, scale: g.scale })
  }

  for (const p of world.procs) {
    if (p.mid < 0 || out.has(p.mid)) continue
    const st = stations[p.pid]
    if (!st) continue
    // Docked whether or not a G is running: "an M parked on its P looking for
    // work" is real, and it makes the syscall handoff readable.
    out.set(p.mid, { x: st.x + THREAD_ST_DX, y: st.y + THREAD_ST_DY, scale: 1 })
  }
  return out
}

export function placeIso(world: WorldState, numProcs: number): Map<number, Placement> {
  const out = new Map<number, Placement>()
  const stations = stationPositions(numProcs)
  let globalN = 0
  let waitN = 0
  let sysN = 0

  const gids = [...world.goroutines.keys()].sort((a, b) => a - b)
  for (const gid of gids) {
    const v = world.goroutines.get(gid)!
    switch (v.state) {
      case 'running': {
        const onP = v.pid >= 0 && v.pid < stations.length
        if (!onP) break // Never invent an execution P for an unknown binding.
        const st = stations[v.pid]
        out.set(gid, { x: st.x, y: st.y, scale: RUN_SCALE })
        break
      }
      case 'syscall':
        if (sysN < CAPS.syscall) out.set(gid, { ...packStagger(SYSCALL, sysN), scale: ZONE_SCALE })
        sysN++
        break
      case 'waiting':
        if (waitN < CAPS.waiting) out.set(gid, { ...packStagger(WAITING, waitN), scale: ZONE_SCALE })
        waitN++
        break
      case 'runnable':
        if (globalN < CAPS.global) out.set(gid, { ...packStagger(GLOBAL, globalN), scale: ZONE_SCALE })
        globalN++
        break
      case 'dead':
        break
    }
  }
  return out
}
