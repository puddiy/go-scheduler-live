import type { Player } from '../player/player'
import type { Chrome } from './chrome'
import { setPresent } from './uimode'
import { t as tr } from '../i18n'

// Present mode: a distraction-free fullscreen view. This module owns the
// enter/exit lifecycle, the best-effort Fullscreen API request/exit, the
// fullscreenchange listener that keeps uimode's `present` flag in sync when
// the user leaves fullscreen via a browser-native control, and the small
// auto-hiding "wand" control bar (play/pause, seek, time, close).
//
// Hiding header/timeline/controls/event-log is NOT this module's job — that's
// a body.present CSS rule in index.html. This module only: toggles the
// body.present class (so that CSS can key off it), talks to uimode's
// present flag, and owns the wand's own DOM + auto-hide timing. The legend's
// present-mode overlay (chrome.setPresent) shares the exact same auto-hide
// timing as the wand, driven from the same activity listener below.

const HIDE_DELAY_MS = 2500

export interface PresentModeHandle {
  toggle(): void
  exit(): void
}

export function createPresentMode(opts: {
  chrome: Chrome
  playerRef: () => Player | null
  onPlayerToggle?: () => void
}): PresentModeHandle {
  const { chrome, playerRef, onPlayerToggle } = opts

  let active = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let rafId: number | null = null

  // --- wand DOM: play/pause, seek, time readout, close ---
  const wand = document.createElement('div')
  wand.className = 'present-wand hidden'

  const playBtn = document.createElement('button')
  playBtn.type = 'button'
  playBtn.className = 'present-play'
  playBtn.addEventListener('click', () => {
    playerRef()?.toggle()
    // Sync immediately on play as well as on the player's published pause.
    onPlayerToggle?.()
    syncWand()
  })

  const seek = document.createElement('input')
  seek.type = 'range'
  seek.className = 'present-seek'
  seek.min = '0'
  seek.max = '1000'
  seek.value = '0'
  seek.setAttribute('aria-label', tr().controls.ariaScrub)
  seek.addEventListener('input', () => {
    const p = playerRef()
    if (!p) return
    p.pause()
    p.seek((p.duration * Number(seek.value)) / 1000)
    syncWand()
  })

  const time = document.createElement('span')
  time.className = 'present-time'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'present-close'
  closeBtn.textContent = '✕'
  closeBtn.title = tr().present.exitTip
  closeBtn.setAttribute('aria-label', tr().present.exitTip)
  closeBtn.addEventListener('click', () => exit())

  wand.append(playBtn, seek, time, closeBtn)
  document.body.append(wand)

  function syncWand(): void {
    const p = playerRef()
    const S = tr().controls
    playBtn.textContent = p?.playing ? S.pause : S.play
    if (!p) return
    const frac = p.duration > 0 ? p.t / p.duration : 0
    seek.value = String(Math.round(frac * 1000))
    time.textContent = `${(p.t / 1e6).toFixed(2)} / ${(p.duration / 1e6).toFixed(2)} ${S.ms}`
  }

  // rAF loop keeps the wand's time/play-state readout live while present mode
  // is active, mirroring how controls.ts syncs off the player's own onTick —
  // but the wand can't hook that callback directly since `player` is a `let`
  // reassigned per run (see main.ts), so it polls instead.
  function frame(): void {
    syncWand()
    rafId = requestAnimationFrame(frame)
  }

  // showWand reveals the wand + the legend's present overlay and (re)starts the
  // shared auto-hide timer. Both elements hide/show in lockstep because they're
  // driven from this one timer.
  function showWand(): void {
    wand.classList.remove('hidden')
    chrome.legend.classList.remove('present-hidden')
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      wand.classList.add('hidden')
      chrome.legend.classList.add('present-hidden')
    }, HIDE_DELAY_MS)
  }

  function onActivity(): void {
    if (active) showWand()
  }
  document.addEventListener('pointermove', onActivity)
  document.addEventListener('pointerdown', onActivity)

  function enter(): void {
    if (active) return
    active = true
    setPresent(true)
    document.body.classList.add('present')
    document.documentElement.requestFullscreen().catch(() => {
      // best-effort: headless/no-user-gesture contexts reject silently —
      // present mode still works visually via the body.present CSS class.
    })
    // setPresent(true) above already reached chrome.setPresent through
    // main.ts's single subscribeUiMode fan-out — no need to call it here too.
    syncWand()
    showWand()
    rafId = requestAnimationFrame(frame)
  }

  // deactivate undoes everything enter() did except the Fullscreen API call —
  // shared by exit() (explicit close) and the fullscreenchange listener below
  // (the user left fullscreen via a browser-native control).
  function deactivate(): void {
    if (!active) return
    active = false
    setPresent(false)
    document.body.classList.remove('present')
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    wand.classList.add('hidden')
    chrome.legend.classList.add('present-hidden')
  }

  function exit(): void {
    if (!active) return
    deactivate()
    // Only call exitFullscreen if something is actually fullscreen — calling
    // it otherwise (e.g. the requestFullscreen above was rejected) logs a
    // console error in some browsers for no benefit.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }

  // The user can leave fullscreen via a browser-native control (Esc handled by
  // the browser itself, a system gesture, etc.) without going through exit()
  // above — detect that and keep uimode's present flag in sync so present mode
  // doesn't stay "on" once the browser has actually left fullscreen.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && active) deactivate()
  })

  function toggle(): void {
    if (active) exit()
    else enter()
  }

  return { toggle, exit }
}
