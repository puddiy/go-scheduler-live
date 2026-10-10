/** Global transport shortcuts must not consume native editing or button keys. */
export function allowPlaybackShortcut(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest('input, textarea, select, button, [contenteditable]'))
}
