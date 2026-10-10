import type { TimelineEvent } from '../model/timeline'

// Event-density histogram for the unified timeline. The mockup faked the density
// with a sine; here it is the REAL count of trace events per time bucket, so the
// histogram shows where the scheduler is actually busy. Pure → unit-tested.

// bucketOfTime maps a time (ns) to its bucket index in [0, buckets-1].
export function bucketOfTime(tNs: number, buckets: number, durationNs: number): number {
  if (buckets <= 0 || durationNs <= 0) return 0
  const b = Math.floor((tNs / durationNs) * buckets)
  return Math.max(0, Math.min(buckets - 1, b))
}

// bucketCounts tallies non-metric events into `buckets` equal bins over
// [0, durationNs]. Metric events are heap samples (downsampled noise), excluded so
// the histogram reads scheduler activity. The sum equals the non-metric event count.
export function bucketCounts(events: TimelineEvent[], buckets: number, durationNs: number): number[] {
  const n = Math.max(1, buckets)
  const out = new Array<number>(n).fill(0)
  if (durationNs <= 0) return out
  for (const e of events) {
    if (e.type === 'metric' || e.type === 'trace_end') continue
    out[bucketOfTime(e.t, n, durationNs)]++
  }
  return out
}

// eventDensity normalizes bucketCounts to [0,1] against the busiest bucket, giving
// bar heights for the histogram. All-zero when there are no (non-metric) events.
export function eventDensity(events: TimelineEvent[], buckets: number, durationNs: number): number[] {
  const counts = bucketCounts(events, buckets, durationNs)
  const max = counts.reduce((m, x) => Math.max(m, x), 0)
  return max > 0 ? counts.map((x) => x / max) : counts
}

// timeOfFrac maps a horizontal fraction [0,1] of the track to a trace time (ns),
// clamped to [0, durationNs]. Turns a click/drag position into a seek target.
export function timeOfFrac(frac: number, durationNs: number): number {
  return Math.max(0, Math.min(durationNs, frac * durationNs))
}
