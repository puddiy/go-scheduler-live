// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Inspector } from './inspector'
import { stateAt } from '../player/state'
import type { Timeline } from '../model/timeline'

const tl: Timeline = { meta: { scenario: 'test', numProcs: 2, durationNs: 50, goroutines: [7, 9] }, events: [
  { t: 0, type: 'g_status', gid: 7, pid: 0, mid: 400, state: 'running', initial: true },
  { t: 10, type: 'g_create', gid: 9, pid: 0, mid: 400, actorGid: 7 },
  { t: 20, type: 'g_run_start', gid: 9, pid: 1, mid: 800 },
  { t: 30, type: 'g_syscall_enter', gid: 9, pid: 1, mid: 800 },
  { t: 30, type: 'p_stop', gid: -1, pid: 1, mid: 400 },
  { t: 40, type: 'g_unblock', gid: 9, pid: 0, mid: 400, actorGid: 7 },
  { t: 50, type: 'trace_end', gid: -1, pid: -1, mid: -1 },
] }
function setup(t: number) {
  const view = new Inspector()
  view.setTimeline(tl)
  view.update(stateAt(tl, t))
  return view
}
describe('resource inspection', () => {
  it('clears the picker when closed so reopening can select the same resource again', () => {
    const view = setup(10)
    view.select({ kind: 'g', id: 9 })
    view.close()
    view.open()
    expect(view.root.querySelector<HTMLSelectElement>('select')?.value).toBe('')
  })
  it('keeps the requested event when seeking first publishes a paused snapshot at another time', () => {
    const view = setup(40)
    view.select({ kind: 'p', id: 1 })
    view.onSeek = ns => { view.update(stateAt(tl, 40)); view.update(stateAt(tl, ns)) }
    const buttons = view.root.querySelectorAll<HTMLButtonElement>('.inspector-event')
    buttons[buttons.length - 2].click()
    expect(view.root.querySelector('pre')?.textContent).toContain('g_syscall_enter')
  })
  it('keeps creator and unblocker context out of the target G bindings', () => {
    const view = setup(10)
    view.select({ kind: 'g', id: 9 })
    expect(view.root.querySelector('[data-fact="p"]')?.textContent).toBe('—')
    expect(view.root.querySelector('[data-fact="m"]')?.textContent).toBe('—')
    expect(view.root.querySelector('pre')?.textContent).toContain('"actorGid": 7')
    view.update(stateAt(tl, 40))
    expect(view.root.querySelector('[data-fact="p"]')?.textContent).toBe('—')
    expect(view.root.querySelector('[data-fact="m"]')?.textContent).toBe('—')
  })
  it('distinguishes the syscall origin P from current P ownership', () => {
    const view = setup(30)
    view.select({ kind: 'g', id: 9 })
    expect(view.root.querySelector('[data-fact="origin"]')?.textContent).toBe('P1')
    expect(view.root.querySelector('[data-fact="p"]')?.textContent).toBe('—')
    expect(view.root.querySelector('[data-fact="m"]')?.textContent).toContain('ThreadID 800')
    view.select({ kind: 'p', id: 1 })
    expect(view.root.querySelector('[data-fact="m"]')?.textContent).toBe('—')
  })
  it('shows absence of M bindings as unknown and preserves its real ThreadID', () => {
    const view = setup(40)
    view.select({ kind: 'm', id: 800 })
    expect(view.root.querySelector('h2')?.textContent).toContain('ThreadID 800')
    expect(view.root.querySelector('[data-fact="state"]')?.textContent).toMatch(/неизвестны/)
  })
  it('does not show future state or retain a resource from a previous trace', () => {
    const view = setup(0)
    view.select({ kind: 'g', id: 9 })
    expect(view.root.querySelector('[data-fact="state"]')?.textContent).toMatch(/ещё не/)
    expect(view.root.querySelectorAll('.inspector-event')).toHaveLength(0)
    view.setTimeline({ ...tl, events: [], meta: { ...tl.meta, goroutines: [] } })
    expect(view.root.hidden).toBe(true)
    expect(view.selection).toBeNull()
  })
  it('history seeks to a complete timestamp but allows inspecting individual simultaneous events', () => {
    const view = setup(30)
    view.select({ kind: 'p', id: 1 })
    let target = -1
    view.onSeek = ns => { target = ns; view.update(stateAt(tl, ns)) }
    const buttons = view.root.querySelectorAll<HTMLButtonElement>('.inspector-event')
    buttons[buttons.length - 2].click()
    expect(target).toBe(30)
    expect(view.root.querySelector('pre')?.textContent).toContain('g_syscall_enter')
    expect(view.root.querySelector('[data-fact="m"]')?.textContent).toBe('—')
  })
})
