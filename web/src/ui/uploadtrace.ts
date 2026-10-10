// Upload panel: lets a visitor replay a `.trace` they recorded themselves,
// instead of one of the curated scenarios. Shown over the stage while in
// "custom" mode (see controls.ts setCustom / main.ts onCustom). The wire
// contract (POST /api/trace, the fixed set of error `code`s) lives in
// ../api.ts; this module only builds the DOM and maps codes to copy.
//
// uploadErrorMessage/traceFacts are pure (unit-tested without a DOM);
// createUploadPanel owns the actual panel element and the upload flow.

import type { Timeline } from '../model/timeline'
import { postTrace, TraceUploadError } from '../api'
import { t } from '../i18n'

// Verbatim recording snippet from README.md's description of the pipeline
// (runtime/trace written to a file, started/stopped around the program).
const SNIPPET = `f, _ := os.Create("mytrace.trace")
trace.Start(f)
// ... your program ...
trace.Stop()
f.Close()`

// uploadErrorMessage maps a wire-contract `code` (see api.ts TraceUploadError)
// to the matching i18n string. Unrecognized codes fall back to a generic
// message keyed by HTTP status.
export function uploadErrorMessage(status: number, code: string, n?: number): string {
  const E = t().custom.error
  switch (code) {
    case 'too_big':
      return E.tooBig
    case 'unreadable':
      return E.unreadable
    case 'too_dense':
      return E.tooDense
    case 'too_many_procs':
      return E.tooManyProcs(n ?? 0)
    case 'not_a_trace':
      return E.notATrace
    default:
      return E.generic(status)
  }
}

// traceFacts pulls the handful of Meta fields worth showing next to an
// uploaded trace's title (chrome.ts setCustomTitle). There is no explicit
// thread/M count on Meta, so we don't invent one.
export function traceFacts(
  tl: Timeline,
): { durationNs: number; events: number; numProcs: number; numGoroutines: number } {
  return {
    durationNs: tl.meta.durationNs,
    events: tl.events.length,
    numProcs: tl.meta.numProcs,
    numGoroutines: tl.meta.goroutines.length,
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export interface UploadPanel {
  show(): void
  hide(): void
}

// createUploadPanel builds the instruction + upload panel and mounts it into
// `container` (the stage). It stays in the DOM (hidden) between show()/hide()
// calls so listeners aren't rebuilt on every toggle.
export function createUploadPanel(
  container: HTMLElement,
  opts: {
    // Called synchronously right before postTrace fires, so the caller can
    // stamp a supersession token BEFORE the async work starts — the same
    // pattern main.ts's run() uses for scenario fetches, sharing one counter
    // so a scenario run and an upload in flight at the same time can't stomp
    // each other's result (whichever resolves last used to win outright).
    onUploadStart: () => void
    onUploaded: (tl: Timeline, fileName: string) => void
  },
): UploadPanel {
  const S = t().custom

  const panel = el('div', 'upload-panel')
  panel.style.display = 'none'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', S.panelTitle)
  const closeBtn = el('button', 'upload-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', S.close)
  closeBtn.title = S.close
  panel.append(closeBtn)
  panel.append(el('div', 'upload-panel-title', S.panelTitle))

  const steps = document.createElement('ol')
  steps.className = 'upload-steps'

  const step1 = document.createElement('li')
  step1.append(document.createTextNode(S.step1))
  const snippetWrap = el('div', 'upload-snippet')
  const pre = document.createElement('pre')
  pre.textContent = SNIPPET
  const copyBtn = el('button', 'upload-copy-btn', S.copy) as HTMLButtonElement
  copyBtn.type = 'button'
  copyBtn.addEventListener('click', () => {
    navigator.clipboard
      .writeText(SNIPPET)
      .then(() => {
        copyBtn.textContent = S.copied
        setTimeout(() => {
          copyBtn.textContent = S.copy
        }, 1500)
      })
      .catch(() => {
        // Clipboard unavailable (permissions, non-secure context) — leave the
        // button label alone rather than pretend it worked.
      })
  })
  snippetWrap.append(pre, copyBtn)
  step1.append(snippetWrap)

  const step2 = document.createElement('li')
  step2.textContent = S.step2

  const step3 = document.createElement('li')
  step3.append(document.createTextNode(S.step3))
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.trace'
  fileInput.className = 'sr-only'
  const chooseBtn = el('button', 'upload-choose', S.choose) as HTMLButtonElement
  chooseBtn.type = 'button'
  chooseBtn.addEventListener('click', () => fileInput.click())
  step3.append(chooseBtn, fileInput)

  steps.append(step1, step2, step3)
  panel.append(steps)

  const statusEl = el('div', 'upload-status')
  statusEl.style.display = 'none'
  const errorEl = el('div', 'upload-error')
  errorEl.style.display = 'none'
  panel.append(statusEl, errorEl)

  container.append(panel)

  let visible = false
  let uploading = false
  let returnFocus: HTMLElement | null = null

  function hide(): void {
    visible = false
    panel.style.display = 'none'
    if (panel.contains(document.activeElement)) returnFocus?.focus()
  }
  closeBtn.addEventListener('click', hide)
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide() }
    if (e.key !== 'Tab') return
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const first = buttons[0], last = buttons.at(-1)
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  })

  function setUploading(on: boolean): void {
    uploading = on
    fileInput.disabled = on
    chooseBtn.disabled = on
    statusEl.style.display = on ? 'block' : 'none'
    statusEl.textContent = on ? S.uploading : ''
  }

  function showError(msg: string): void {
    errorEl.textContent = msg
    errorEl.style.display = 'block'
  }

  function clearError(): void {
    errorEl.style.display = 'none'
    errorEl.textContent = ''
  }

  async function handleFile(file: File): Promise<void> {
    clearError()
    setUploading(true)
    opts.onUploadStart()
    try {
      const tl = await postTrace(file)
      setUploading(false)
      // Success: the caller (main.ts) closes the panel via hide() as part of
      // applying the timeline, so we don't hide it ourselves here.
      opts.onUploaded(tl, file.name)
    } catch (e) {
      setUploading(false)
      if (e instanceof TraceUploadError) {
        showError(uploadErrorMessage(e.status, e.code, e.n))
      } else {
        showError(e instanceof Error ? e.message : String(e))
      }
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = '' // allow re-selecting the same file after an error
    if (file) void handleFile(file)
  })

  // Drag & drop onto the stage — basic accept/drop only, no polish.
  container.addEventListener('dragover', (e) => {
    if (!visible || uploading) return
    e.preventDefault()
  })
  container.addEventListener('drop', (e) => {
    if (!visible || uploading) return
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) void handleFile(file)
  })

  return {
    show() {
      if (!visible) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      visible = true
      clearError()
      panel.style.display = 'block'
      chooseBtn.focus()
    },
    hide,
  }
}
