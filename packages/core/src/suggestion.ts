import { isNodeSelection } from './model/editable'
import { getNode, isText } from './model/node'
import { parentPath, pointEquals } from './model/path'
import { mainRange } from './model/selection'
import type { Node, Path, Point, Range } from './model/types'
import type { EditorState } from './state'

export interface FindTriggerOptions {
  /** The trigger, e.g. `'@'`. */
  char: string
  /** Whether the query may contain spaces. Default false: a space between trigger and caret means no match. A newline always does. */
  allowSpaces?: boolean
}

export interface TriggerMatch {
  /** From the trigger to the caret. */
  range: Range
  /** The text between the trigger and the caret. */
  query: string
}

const isSpace = (ch: string) => /\s/.test(ch)

/**
 * Finds `char` before a collapsed caret within the caret's text run: the adjacent sibling texts of
 * its text node (any sibling element, e.g. an inline atom, ends the run). The trigger must be at the
 * start of a line (the run starts its parent's content, or a `\n` precedes it) or right after
 * whitespace. The nearest trigger before the caret decides: when it is not at such a position, null.
 * Model text only; the trigger is found in any block (plugins decide where it applies).
 */
export function findTrigger(state: EditorState, { char, allowSpaces = false }: FindTriggerOptions): TriggerMatch | null {
  const sel = state.selection
  if (!char || !sel || isNodeSelection(sel)) return null
  const range = mainRange(sel)
  if (!pointEquals(range.anchor, range.focus)) return null
  const caret = range.focus
  if (caret.path.length < 2) return null
  let siblings: readonly Node[]
  try {
    const parent = getNode(state.doc, parentPath(caret.path)) as { children?: readonly Node[] }
    siblings = parent.children ?? []
  } catch {
    return null
  }
  const index = caret.path[caret.path.length - 1]!
  const node = siblings[index]
  if (!node || !isText(node) || caret.offset > node.text.length) return null
  let first = index
  while (first > 0 && isText(siblings[first - 1]!)) first--

  const base = parentPath(caret.path)
  const parts: { path: Path; text: string }[] = []
  for (let i = first; i < index; i++) parts.push({ path: [...base, i], text: (siblings[i] as { text: string }).text })
  parts.push({ path: caret.path, text: node.text.slice(0, caret.offset) })
  const before = parts.map((p) => p.text).join('')

  for (let i = before.length - char.length; i >= 0; i--) {
    if (before.startsWith(char, i)) {
      const atLineStart = i === 0 ? first === 0 : isSpace(before[i - 1]!)
      if (!atLineStart) return null
      return { range: { start: pointAt(parts, i), end: caret }, query: before.slice(i + char.length) }
    }
    const ch = before[i + char.length - 1]!
    if (ch === '\n' || (!allowSpaces && isSpace(ch))) return null
  }
  return null
}

/** The point at `offset` in the joined `parts` (the start of the part when on a boundary). */
function pointAt(parts: { path: Path; text: string }[], offset: number): Point {
  let acc = 0
  for (const part of parts) {
    if (offset < acc + part.text.length) return { path: part.path, offset: offset - acc }
    acc += part.text.length
  }
  const last = parts[parts.length - 1]!
  return { path: last.path, offset: last.text.length }
}
