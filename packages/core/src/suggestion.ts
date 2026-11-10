import { isNodeSelection } from './model/editable'
import { getNode, isText } from './model/node'
import { comparePath, parentPath, pointEquals } from './model/path'
import { mainRange } from './model/selection'
import type { Node, Path, Point, Range } from './model/types'
import type { Registry } from './plugin/registry'
import type { EditorState } from './state'
import { blockPathOf, runAt, toBlockOffset, type Run } from './transaction/text'
import { Transaction } from './transaction/transaction'

export interface FindTriggerOptions {
  /** The trigger, e.g. `'@'`. */
  char: string
  /** Whether the query may contain spaces. Default false: a space between trigger and caret means no match. A newline always does. */
  allowSpaces?: boolean
  /**
   * The editor's registry (`editor.registry`). With it, the text searched is the one input rules
   * match against (`textBeforeCaret`): the caret's run in its block, across inline elements such as
   * links. Without it, only the sibling texts of the caret's text node are searched (see `findTrigger`).
   */
  registry?: Registry
}

export interface TriggerMatch {
  /** From the trigger to the caret. */
  range: Range
  /** The text between the trigger and the caret. */
  query: string
}

const isSpace = (ch: string) => /\s/.test(ch)

/**
 * The text before `caret` that input rules and `findTrigger` (with a registry) see: the text of the
 * caret's run (the block's texts, model text only, across inline elements such as links; an inline
 * atom or an unknown inline element ends a run) from its start to the caret. Null when the caret is
 * in no block or no run.
 * @internal
 */
export function textBeforeCaret(tr: Transaction, caret: Point): { run: Run; text: string } | null {
  try {
    const run = runAt(tr, blockPathOf(tr, caret.path), caret)
    return { run, text: run.text.slice(0, toBlockOffset(run, caret)) }
  } catch {
    return null
  }
}

/**
 * Finds `char` before a collapsed caret (the main range; the other ranges are ignored on purpose).
 *
 * The text searched: with `registry`, the caret's run as input rules see it (`textBeforeCaret`): the
 * block's texts across inline elements such as links, up to an inline atom. Without it (kept for
 * callers that have no registry), only the adjacent sibling texts of the caret's text node (any
 * sibling element ends the run, and the start of an inline element's content counts as a line start:
 * pass the registry to avoid that false positive).
 *
 * The trigger must be at the start of a line (the run starts its block's content, or a `\n` precedes
 * it) or right after whitespace. The nearest trigger before the caret decides: when it is not at such
 * a position, null. The range starts in the text holding the trigger. Model text only; the trigger
 * is found in any block (plugins decide where it applies).
 */
export function findTrigger(
  state: EditorState,
  { char, allowSpaces = false, registry }: FindTriggerOptions,
): TriggerMatch | null {
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

  let parts: { path: Path; text: string }[]
  let runStartsLine: boolean
  if (registry) {
    const found = textBeforeCaret(new Transaction(state, registry), caret)
    if (!found) return null
    parts = []
    for (const [t, path] of found.run.texts) {
      const atCaret = comparePath(path, caret.path) === 0
      parts.push({ path, text: atCaret ? t.text.slice(0, caret.offset) : t.text })
      if (atCaret) break
    }
    runStartsLine = found.run.before === null
  } else {
    let first = index
    while (first > 0 && isText(siblings[first - 1]!)) first--
    const base = parentPath(caret.path)
    parts = []
    for (let i = first; i < index; i++) parts.push({ path: [...base, i], text: (siblings[i] as { text: string }).text })
    parts.push({ path: caret.path, text: node.text.slice(0, caret.offset) })
    runStartsLine = first === 0
  }
  const before = parts.map((p) => p.text).join('')

  for (let i = before.length - char.length; i >= 0; i--) {
    if (before.startsWith(char, i)) {
      const atLineStart = i === 0 ? runStartsLine : isSpace(before[i - 1]!)
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
