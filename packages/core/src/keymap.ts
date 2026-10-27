export type Platform = 'mac' | 'other'

interface Mods {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

function format(mods: Mods, key: string): string {
  let out = ''
  if (mods.ctrl) out += 'Ctrl-'
  if (mods.alt) out += 'Alt-'
  if (mods.shift) out += 'Shift-'
  if (mods.meta) out += 'Meta-'
  return out + key
}

/** Single ASCII letters are lowercased so `Shift-Z` and `Shift-z` name the same key. */
function normalizeKey(key: string): string {
  if (key === ' ') return 'Space'
  return /^[A-Za-z]$/.test(key) ? key.toLowerCase() : key
}

/**
 * Canonical key name: `Mod` becomes `Ctrl` (other) or `Meta` (mac), modifiers are ordered
 * `Ctrl-Alt-Shift-Meta`, single letters are lowercase. `Mod--` names the `-` key.
 */
export function normalizeKeyName(name: string, platform: Platform): string {
  const parts = name.split(/-(?!$)/)
  const key = parts.pop() ?? ''
  const mods: Mods = { ctrl: false, alt: false, shift: false, meta: false }
  for (const mod of parts) {
    if (/^(cmd|meta|m)$/i.test(mod)) mods.meta = true
    else if (/^a(lt)?$/i.test(mod)) mods.alt = true
    else if (/^(c|ctrl|control)$/i.test(mod)) mods.ctrl = true
    else if (/^s(hift)?$/i.test(mod)) mods.shift = true
    else if (/^mod$/i.test(mod)) {
      if (platform === 'mac') mods.meta = true
      else mods.ctrl = true
    } else throw new Error(`Unrecognized modifier name: ${mod}`)
  }
  return format(mods, normalizeKey(key))
}

/** Canonical key name (see `normalizeKeyName`) of a keyboard event. */
export function eventToKeyName(e: KeyboardEvent): string {
  let key = e.key
  const mods: Mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
  // With a command modifier, a non-latin character (other layouts, Alt on mac) maps to the physical letter.
  if ((e.ctrlKey || e.altKey || e.metaKey) && key.length === 1 && !/^[A-Za-z]$/.test(key)) {
    const m = /^Key([A-Z])$/.exec(e.code ?? '')
    if (m) key = m[1]!
  }
  // Shift is already part of a shifted punctuation character such as `?`.
  if (key.length === 1 && key !== ' ' && !/^[A-Za-z]$/.test(key)) mods.shift = false
  return format(mods, normalizeKey(key))
}
