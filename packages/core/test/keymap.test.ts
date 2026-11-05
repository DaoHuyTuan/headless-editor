import { describe, expect, it } from 'vitest'
import { eventToKeyName, normalizeKeyName } from '../src/keymap'

function ev(key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}, code = ''): KeyboardEvent {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as KeyboardEvent
}

describe('normalizeKeyName', () => {
  it('maps Mod per platform', () => {
    expect(normalizeKeyName('Mod-b', 'other')).toBe('Ctrl-b')
    expect(normalizeKeyName('Mod-b', 'mac')).toBe('Meta-b')
  })

  it('orders modifiers Ctrl-Alt-Shift-Meta', () => {
    expect(normalizeKeyName('Shift-Mod-z', 'mac')).toBe('Shift-Meta-z')
    expect(normalizeKeyName('Shift-Mod-z', 'other')).toBe('Ctrl-Shift-z')
    expect(normalizeKeyName('Meta-Shift-Alt-Ctrl-x', 'other')).toBe('Ctrl-Alt-Shift-Meta-x')
    expect(normalizeKeyName('Cmd-a', 'other')).toBe('Meta-a')
    expect(normalizeKeyName('Control-a', 'mac')).toBe('Ctrl-a')
  })

  it('handles plain keys, uppercase letters and a literal dash', () => {
    expect(normalizeKeyName('Enter', 'other')).toBe('Enter')
    expect(normalizeKeyName('Shift-Enter', 'other')).toBe('Shift-Enter')
    expect(normalizeKeyName('Mod-B', 'other')).toBe('Ctrl-b')
    expect(normalizeKeyName('Mod--', 'other')).toBe('Ctrl--')
    expect(normalizeKeyName('Space', 'other')).toBe('Space')
  })

  it('rejects unknown modifiers', () => {
    expect(() => normalizeKeyName('Hyper-a', 'other')).toThrow()
  })
})

describe('eventToKeyName', () => {
  it('builds names in canonical modifier order', () => {
    expect(eventToKeyName(ev('b', { ctrlKey: true }))).toBe('Ctrl-b')
    expect(eventToKeyName(ev('Z', { metaKey: true, shiftKey: true }))).toBe('Shift-Meta-z')
    expect(eventToKeyName(ev('Enter', { shiftKey: true }))).toBe('Shift-Enter')
    expect(eventToKeyName(ev('x', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }))).toBe(
      'Ctrl-Alt-Shift-Meta-x',
    )
  })

  it('drops Shift for shifted punctuation and names the space bar', () => {
    expect(eventToKeyName(ev('?', { shiftKey: true }))).toBe('?')
    expect(eventToKeyName(ev(' ', { ctrlKey: true }))).toBe('Ctrl-Space')
  })

  it('falls back to the physical letter for non-latin keys with modifiers', () => {
    expect(eventToKeyName(ev('и', { ctrlKey: true }, 'KeyB'))).toBe('Ctrl-b')
    expect(eventToKeyName(ev('∫', { altKey: true }, 'KeyB'))).toBe('Alt-b')
    expect(eventToKeyName(ev('и', {}, 'KeyB'))).toBe('и')
  })

  it('keeps Shift on digit keys with a command modifier, so Mod-Shift-1 can match', () => {
    expect(eventToKeyName(ev('!', { ctrlKey: true, shiftKey: true }, 'Digit1'))).toBe('Ctrl-Shift-1')
    expect(eventToKeyName(ev('#', { metaKey: true, shiftKey: true }, 'Digit3'))).toBe('Shift-Meta-3')
    expect(normalizeKeyName('Mod-Shift-1', 'other')).toBe('Ctrl-Shift-1')
    // Without a command modifier, Shift+1 is still the typed character.
    expect(eventToKeyName(ev('!', { shiftKey: true }, 'Digit1'))).toBe('!')
  })
})
