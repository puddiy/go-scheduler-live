import { describe, it, expect, vi, afterEach } from 'vitest'
import { Player } from './player'
import type { Timeline } from '../model/timeline'
const timeline: Timeline = { meta: { scenario: 'test', numProcs: 1, durationNs: 100, goroutines: [] }, events: [] }
afterEach(() => vi.unstubAllGlobals())

describe('playback publication', () => {
  it('steps backward to a distinct event time, restoring state instead of undoing one simultaneous event', () => {
    const p = new Player({ ...timeline, events: [
      { t: 10, type: 'g_create', gid: 2, pid: -1, mid: -1 },
      { t: 20, type: 'g_run_start', gid: 2, pid: 0, mid: 40 },
      { t: 20, type: 'g_exit', gid: 2, pid: 0, mid: 40 },
    ] })
    const states: string[] = []
    p.onTick = (w) => states.push(w.goroutines.get(2)?.state ?? 'unobserved')
    p.seek(21)
    p.stepBack()
    expect(p.t).toBe(20)
    expect(states.at(-1)).toBe('dead')
    p.stepBack()
    expect(p.t).toBe(10)
    expect(states.at(-1)).toBe('runnable')
    p.stepBack()
    expect(p.t).toBe(0)
    expect(states.at(-1)).toBe('unobserved')
    p.stepBack()
    expect(p.t).toBe(0)
    p.step()
    expect(p.t).toBe(10)
    p.step()
    expect(p.t).toBe(20)
    expect(states.at(-1)).toBe('dead')
  })
  it('backward stepping pauses playback even when there are no earlier events', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const p = new Player(timeline)
    p.play()
    p.stepBack()
    expect(p.playing).toBe(false)
    expect(p.t).toBe(0)
  })
  it('publishes paused state so the scene stops when transport pauses', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const player = new Player(timeline)
    const states: boolean[] = []
    player.onTick = () => states.push(player.playing)
    player.play()
    player.pause()
    expect(states.at(-1)).toBe(false)
  })
})
