import type { Timeline } from '../model/timeline'
import { stateAt, type WorldState } from './state'

// At speed 1 the whole run plays over this many ms of real time, regardless of
// its absolute (tiny) trace duration — otherwise a ~66ms trace would flash by.
// Playback expands time for inspection; locations still change at event times.
const BASE_WALL_MS = 90_000

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// nextTime advances virtual time by the real elapsed ms, normalizing the whole
// run to BASE_WALL_MS at speed 1. Pure, so it is unit-tested.
export function nextTime(t: number, dtMs: number, duration: number, speed: number): number {
  if (duration <= 0) return 0
  const nsPerMs = duration / BASE_WALL_MS
  return clamp(t + dtMs * nsPerMs * speed, 0, duration)
}

// Player is the virtual clock: it advances t with requestAnimationFrame and
// pushes the reduced WorldState via onTick. All real logic lives in the pure
// functions above and in stateAt; this class is the thin browser glue.
export class Player {
  onTick?: (state: WorldState) => void

  private _t = 0
  private _playing = false
  private _speed = 1
  private raf = 0
  private lastReal = 0

  constructor(private readonly timeline: Timeline) {}

  get duration(): number {
    return this.timeline.meta.durationNs
  }
  get t(): number {
    return this._t
  }
  get playing(): boolean {
    return this._playing
  }
  get speed(): number {
    return this._speed
  }

  play(): void {
    if (this._playing) return
    if (this._t >= this.duration) this._t = 0
    this._playing = true
    this.lastReal = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  pause(): void {
    const wasPlaying = this._playing
    this._playing = false
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    if (wasPlaying) this.emit()
  }

  toggle(): void {
    if (this._playing) this.pause()
    else this.play()
  }

  setSpeed(s: number): void {
    this._speed = s
  }

  seek(t: number): void {
    this._t = clamp(t, 0, this.duration)
    this.emit()
  }

  // step pauses, then jumps to the next event time strictly after the current
  // position (without pausing, the RAF loop would immediately advance past it).
  step(): void {
    this.pause()
    const next = this.timeline.events.find((e) => e.t > this._t)
    this.seek(next ? next.t : this.duration)
  }

  stepBack(): void {
    this.pause()
    // All events at one timestamp form one observable snapshot.
    for (let i = this.timeline.events.length - 1; i >= 0; i--) {
      if (this.timeline.events[i].t < this._t) {
        this.seek(this.timeline.events[i].t)
        return
      }
    }
    this.seek(0)
  }

  // emit recomputes the world at the current time and pushes it to the listener.
  emit(): void {
    this.onTick?.(stateAt(this.timeline, this._t))
  }

  private frame = (): void => {
    if (!this._playing) return
    const now = performance.now()
    this._t = nextTime(this._t, now - this.lastReal, this.duration, this._speed)
    this.lastReal = now
    if (this._t >= this.duration) {
      // Pause first, then emit, so listeners (the play button label) see the
      // paused state at the end of playback.
      this.pause()
      return
    }
    this.emit()
    this.raf = requestAnimationFrame(this.frame)
  }
}
