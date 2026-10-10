// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { allowPlaybackShortcut } from './shortcuts'

describe('playback keyboard shortcuts', () => {
  it('leaves native editing and button keys alone', () => {
    for (const tag of ['input', 'textarea', 'select', 'button']) {
      const target = document.createElement(tag)
      expect(allowPlaybackShortcut(target)).toBe(false)
    }
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editable.append(child)
    expect(allowPlaybackShortcut(child)).toBe(false)
  })
  it('allows shortcuts from the world and document', () => {
    expect(allowPlaybackShortcut(document.createElement('canvas'))).toBe(true)
    expect(allowPlaybackShortcut(document.body)).toBe(true)
  })
})
