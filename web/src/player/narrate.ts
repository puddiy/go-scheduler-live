import type { TimelineEvent } from '../model/timeline'
const CAPTION_LOOKBACK_NS = 8_000_000
import { t as tr } from '../i18n'

// narrate returns a short sentence (in the current UI language) describing the
// most notable thing
// happening at t, for the "what's happening" caption. Empty when nothing notable
// is nearby. Pure and unit-tested.
//
// GC phase (STW / concurrent mark) is read from the folded `gcActive` so the
// caption stays consistent with the scene — it never claims stop-the-world after
// the range has ended (the previous version re-scanned raw events in an 8ms window
// and lied for ~8ms of trace time, i.e. seconds of wall time at 1x). Point events
// (blocks, exits) still come from a short look-back window.

// captionWindowNs bounds the caption's look-back to the smaller of the 8ms look-back
// window and 1% of the whole run, so a short trace (e.g. workstealing ~39ms, where
// a fixed 8ms is ~20% of the timeline and would persist ~9s of wall time at 1x)
// does not leave the caption describing something that scrolled off long ago.
export function captionWindowNs(durationNs: number): number {
  return Math.max(1, Math.min(CAPTION_LOOKBACK_NS, Math.round(durationNs * 0.01)))
}

export function narrate(
  events: TimelineEvent[],
  t: number,
  gcActive: string[],
  windowNs: number = CAPTION_LOOKBACK_NS,
  midAlias?: Map<number, number>,
): string {
  let bestSal = -1
  let bestText = ''
  const consider = (sal: number, text: string): void => {
    // Precedence: higher salience always wins (STW > mark > syscall >
    // block > exit); among equal salience, ">=" keeps the latest (events
    // iterate in time order).
    if (sal >= bestSal) {
      bestSal = sal
      bestText = text
    }
  }
  // Same ordinal aliases as the carrier tags (raw darwin thread ids are huge).
  const mName = (mid: number): string => `M${midAlias?.get(mid) ?? mid}`
  const N = tr().narrate

  // GC phase from the live folded state (truthful: only while actually active).
  if (gcActive.some((n) => n.includes('stop-the-world'))) consider(6, N.stw)
  else if (gcActive.some((n) => n.includes('mark phase'))) consider(5, N.mark)

  for (const e of events) {
    if (e.t > t) break
    if (e.t < t - windowNs) continue
    // Syscall enter/exit are own-execution events, so e.mid really is the
    // goroutine's M (unlike g_unblock, whose mid is the waker's — not shown).
    if (e.type === 'g_syscall_enter') consider(4, N.sysEnter(e.gid, e.mid >= 0 ? mName(e.mid) : null))
    else if (e.type === 'g_syscall_exit') consider(4, N.sysExit(e.gid, e.pid))
    else if (e.type === 'g_block') consider(2, N.block(e.gid, e.reason ?? '?'))
    else if (e.type === 'g_exit') consider(1, N.exit(e.gid))
  }

  return bestText
}
