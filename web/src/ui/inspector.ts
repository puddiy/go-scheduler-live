import type { Timeline, TimelineEvent } from '../model/timeline'
import type { WorldState } from '../player/state'
import { midAliases } from '../scene/layout'
import { t } from '../i18n'
import { fmtDur } from './eventlog'

export type ResourceSelection = { kind: 'g' | 'm' | 'p'; id: number }
type RecordedEvent = { index: number; event: TimelineEvent }
const key = (s: ResourceSelection): string => `${s.kind}:${s.id}`

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}

// The inspector owns selection and event provenance, never runtime state. Its
// facts come from the very same folded snapshot that drives the scene.
export class Inspector {
  readonly root = el('aside', 'inspector')
  onSelect?: (selection: ResourceSelection | null) => void
  onSeek?: (ns: number) => void
  onClose?: () => void
  private selected: ResourceSelection | null = null
  private world: WorldState | null = null
  private aliases = new Map<number, number>()
  private records = new Map<string, RecordedEvent[]>()
  private chosen: RecordedEvent | null = null
  private readonly title = el('h2', 'inspector-title')
  private readonly picker = el('select', 'inspector-picker')
  private readonly content = el('div', 'inspector-content')
  private readonly time = el('span', 'inspector-playhead')
  private renderKey = ''

  constructor() {
    const S = t().inspector
    this.root.id = 'trace-inspector'
    this.root.hidden = true
    this.root.setAttribute('aria-label', S.title)
    const head = el('div', 'inspector-head')
    const close = el('button', 'inspector-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', S.close)
    close.addEventListener('click', () => this.close())
    head.append(el('span', 'inspector-eyebrow', S.title), close)
    this.picker.id = 'inspector-resource'
    const label = el('label', 'inspector-label', S.choose)
    label.htmlFor = this.picker.id
    this.picker.addEventListener('change', () => {
      if (!this.picker.value) return
      const [kind, id] = this.picker.value.split(':')
      this.select({ kind: kind as ResourceSelection['kind'], id: Number(id) })
    })
    this.root.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close() }
    })
    this.root.append(head, label, this.picker, this.title, this.time, this.content)
  }

  get selection(): ResourceSelection | null { return this.selected }

  setTimeline(tl: Timeline): void {
    this.selected = null
    this.chosen = null
    this.world = null
    this.renderKey = ''
    this.root.hidden = true
    this.records.clear()
    this.aliases = midAliases(tl.events)
    const resources = new Map<string, ResourceSelection>()
    const add = (s: ResourceSelection, record?: RecordedEvent) => {
      const k = key(s)
      resources.set(k, s)
      if (record) {
        const list = this.records.get(k) ?? []
        list.push(record)
        this.records.set(k, list)
      }
    }
    for (let id = 0; id < tl.meta.numProcs; id++) add({ kind: 'p', id })
    for (const id of tl.meta.goroutines) add({ kind: 'g', id })
    tl.events.forEach((event, index) => {
      const record = { event, index }
      if (event.gid >= 0 && event.type.startsWith('g_')) add({ kind: 'g', id: event.gid }, record)
      // These histories are recorded event contexts. In particular, create and
      // unblock are not evidence of ownership of their target G by this P/M.
      if (event.pid >= 0) add({ kind: 'p', id: event.pid }, record)
      if (event.mid >= 0) add({ kind: 'm', id: event.mid }, record)
    })
    this.picker.replaceChildren(el('option', '', t().inspector.choose))
    this.picker.options[0].value = ''
    for (const kind of ['g', 'm', 'p'] as const) {
      const group = el('optgroup', '')
      group.label = kind.toUpperCase()
      for (const s of [...resources.values()].filter(s => s.kind === kind).sort((a, b) => a.id - b.id)) {
        const option = el('option', '', this.name(s))
        option.value = key(s)
        group.append(option)
      }
      this.picker.append(group)
    }
    this.onSelect?.(null)
  }

  open(): void {
    this.root.hidden = false
    this.root.scrollTop = 0
    this.render()
    this.picker.focus({ preventScroll: true })
  }

  close(): void {
    this.root.hidden = true
    this.selected = null
    this.picker.value = ''
    this.chosen = null
    this.renderKey = ''
    this.onSelect?.(null)
    this.onClose?.()
  }

  select(selection: ResourceSelection): void {
    this.selected = selection
    this.chosen = null
    this.renderKey = ''
    this.picker.value = key(selection)
    this.root.hidden = false
    this.root.scrollTop = 0
    this.onSelect?.(selection)
    this.render()
  }

  update(world: WorldState): void {
    this.world = world
    this.time.textContent = `${t().inspector.snapshot} · ${fmtDur(world.t)}`
    this.time.title = `${world.t} ns`
    if (this.chosen && this.chosen.event.t !== world.t) this.chosen = null
    if (!this.root.hidden) this.render()
  }

  private name(s: ResourceSelection): string {
    return s.kind === 'm' ? `M${this.aliases.get(s.id) ?? '?'} · ThreadID ${s.id}` : `${s.kind.toUpperCase()}${s.id}`
  }

  private past(): RecordedEvent[] {
    if (!this.selected || !this.world) return []
    const records = this.records.get(key(this.selected)) ?? []
    let lo = 0, hi = records.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (records[mid].event.t <= this.world.t) lo = mid + 1
      else hi = mid
    }
    return records.slice(Math.max(0, lo - 12), lo)
  }

  private render(): void {
    const S = t().inspector
    const s = this.selected, w = this.world
    this.title.textContent = s ? this.name(s) : S.choose
    if (!s || !w) {
      this.content.replaceChildren(el('p', 'inspector-note', S.prompt))
      return
    }
    const past = this.past()
    const record = this.chosen ?? past.at(-1)
    // Clock-only ticks need not replace focused history buttons or <details>.
    const renderKey = `${key(s)}:${record?.index}:${past.at(-1)?.index}:${JSON.stringify(s.kind === 'g' ? w.goroutines.get(s.id) : s.kind === 'p' ? w.procs[s.id] : [w.procs.filter(p => p.mid === s.id), [...w.goroutines.values()].filter(g => g.mid === s.id)])}`
    if (this.renderKey === renderKey) return
    this.renderKey = renderKey
    const rawOpen = this.root.querySelector('details')?.open ?? false
    const facts = el('dl', 'inspector-facts')
    const fact = (id: string, label: string, value: string) => {
      const v = el('dd', '', value)
      v.dataset.fact = id
      facts.append(el('dt', '', label), v)
    }
    const mName = (mid: number) => mid < 0 ? '—' : this.name({ kind: 'm', id: mid })
    if (s.kind === 'g') {
      const g = w.goroutines.get(s.id)
      fact('state', S.state, g ? g.state : S.unseen)
      fact('p', S.bindingP, g?.state === 'running' ? g.pid >= 0 ? `P${g.pid}` : S.unknown : '—')
      fact('m', S.bindingM, g && (g.state === 'running' || g.state === 'syscall') && g.mid < 0 ? S.unknown : mName(g?.mid ?? -1))
      if (g?.state === 'syscall') fact('origin', S.origin, g.pid >= 0 ? `P${g.pid}` : S.unknown)
      if (g?.reason) fact('reason', S.reason, g.reason)
    } else if (s.kind === 'p') {
      const p = w.procs[s.id]
      fact('state', S.state, p?.status ?? S.unknown)
      fact('m', S.owner, !p?.status || p.status === 'unknown' ? S.unknown : mName(p.mid))
      fact('g', S.goroutine, p && p.gid >= 0 ? `G${p.gid}` : '—')
    } else {
      const ps = w.procs.filter(p => p.mid === s.id)
      const gs = [...w.goroutines.values()].filter(g => g.mid === s.id)
      fact('state', S.bindings, ps.length || gs.length ? S.knownBindings : S.unknownBindings)
      fact('p', 'P', ps.map(p => `P${p.pid}`).join(', ') || S.unknown)
      fact('g', 'G', gs.map(g => `G${g.gid} (${g.state})`).join(', ') || S.unknown)
    }
    const history = el('div', 'inspector-history')
    history.append(el('h3', '', S.history), el('p', 'inspector-note', S.latest))
    if (!past.length) history.append(el('p', 'inspector-note', S.empty))
    for (const row of past) {
      const button = el('button', 'inspector-event')
      button.type = 'button'
      button.dataset.eventIndex = String(row.index)
      button.setAttribute('aria-pressed', String(row.index === record?.index))
      button.append(el('span', 'inspector-event-time', fmtDur(row.event.t)), el('span', '', S.events[row.event.type]))
      button.addEventListener('click', () => {
        const hadFocus = document.activeElement === button
        this.onSeek?.(row.event.t)
        // pause() may publish the old playhead before seek() publishes the new
        // one. Pin the requested record only after both snapshots are applied.
        this.chosen = row
        this.renderKey = ''
        this.render()
        if (hadFocus) this.root.querySelector<HTMLButtonElement>(`[data-event-index='${row.index}']`)?.focus({ preventScroll: true })
      })
      history.append(button)
    }
    this.content.replaceChildren(facts,
      el('p', 'inspector-note inspector-boundary', s.kind === 'm' ? S.mBoundary : S.boundary), history)
    if (record) {
      const e = record.event
      const evidence = el('div', 'inspector-evidence')
      evidence.append(el('h3', '', S.events[e.type]), el('p', 'inspector-note', `${S.exact}: ${e.t} ns`))
      if (e.initial || e.type === 'g_status' || e.type === 'gc_range_active') evidence.append(el('p', 'inspector-note', S.initial))
      if (e.type === 'g_create' || e.type === 'g_unblock') evidence.append(el('p', 'inspector-note', S.context))
      if (e.reason) evidence.append(el('p', 'inspector-reason', e.reason))
      evidence.append(el('p', 'inspector-note', S.group))
      const details = el('details', 'inspector-raw')
      details.open = rawOpen
      const pre = el('pre', '')
      // Legacy stolen is not evidence; the parser no longer produces it.
      const { stolen: _legacy, ...normalized } = e
      pre.textContent = JSON.stringify(normalized, null, 2)
      details.append(el('summary', '', S.normalized), pre)
      evidence.append(details)
      this.content.append(evidence)
    }
  }
}
