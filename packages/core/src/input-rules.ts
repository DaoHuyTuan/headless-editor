import type { Editor } from './editor'
import { isNodeSelection } from './model/editable'
import { pointEquals } from './model/path'
import { createSelection, mainRange, single } from './model/selection'
import type { Point, Range, SelectionRange } from './model/types'
import { transformRange } from './ops/transform'
import type { AnyPlugin, PluginContext } from './plugin/types'
import { lockSelection } from './transaction/ranges'
import { blockPathOf, fromBlockOffset, runAt, toBlockOffset, type Run } from './transaction/text'
import { Transaction } from './transaction/transaction'

/** Meta key set on the tr of a fired input rule (recorded as its own history entry of kind `'other'`). */
export const INPUT_RULE_META = 'inputRule'

type RulesEditor = Pick<Editor, 'state' | 'registry' | 'createTransaction' | 'dispatch'>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContextOf = (plugin: AnyPlugin) => PluginContext<any, any, any, any>

/** The block text of the caret's run, from its start to `caret`, or null when it has none. */
function textBefore(tr: Transaction, caret: Point): { run: Run; text: string } | null {
  try {
    const run = runAt(tr, blockPathOf(tr, caret.path), caret)
    return { run, text: run.text.slice(0, toBlockOffset(run, caret)) }
  } catch {
    return null
  }
}

/**
 * Tries the rules (every plugin's, by priority) at `caret`: each matching rule gets `trFor()` and the
 * first handler returning true wins. Returns that tr, or null when no rule fired.
 */
function fireAt(editor: RulesEditor, contextOf: ContextOf, probe: Transaction, caret: Point, trFor: () => Transaction): Transaction | null {
  const found = textBefore(probe, caret)
  if (!found) return null
  const { run, text } = found
  for (const plugin of editor.registry.plugins) {
    for (const rule of plugin.spec.inputRules ?? []) {
      rule.match.lastIndex = 0
      const match = rule.match.exec(text)
      if (!match || match.index + match[0].length !== text.length) continue
      const range: Range = { start: fromBlockOffset(run, match.index), end: caret }
      const tr = trFor()
      tr.meta.origin = 'input'
      tr.meta[INPUT_RULE_META] = true
      if (rule.handler(contextOf(plugin), match, range, tr)) return tr
    }
  }
  return null
}

/**
 * Runs the input rules of every plugin, by priority, against the text of each caret's run (the
 * block's texts no inline atom separates, model text only) from its start to the caret. At each
 * collapsed caret, checked on its own, the first handler returning true wins and ends that caret's
 * run. Every firing goes into one rule tr (origin `input`, meta `inputRule: true`), dispatched when
 * it changed anything, so the rules are one undo step after the typing. True when a rule fired.
 *
 * Each matching rule gets a fresh tr; a handler returning false has its tr dropped. With several
 * carets, a handler's tr starts from the rule tr so far (its `range` mapped through the earlier
 * firings) with only its own caret as the selection, so its edits (no-range calls included) act
 * there; when it returns true its doc ops are added to the rule tr, its caret becomes that tr's
 * result and the other ranges are mapped. A handler must not set the selection then:
 * `setSelection` throws in dev mode.
 */
export function runInputRules(editor: RulesEditor, contextOf: ContextOf): boolean {
  const sel = editor.state.selection
  if (!sel || isNodeSelection(sel)) return false
  if (sel.ranges.length === 1) {
    const range = mainRange(sel)
    if (!pointEquals(range.anchor, range.focus)) return false
    const tr = fireAt(editor, contextOf, editor.createTransaction(), range.focus, () => editor.createTransaction())
    if (!tr) return false
    if (tr.ops.length > 0) editor.dispatch(tr)
    return true
  }
  const shared = editor.createTransaction()
  shared.meta.origin = 'input'
  shared.meta[INPUT_RULE_META] = true
  // Every range, kept mapped through the firings; a fired caret becomes its handler's result.
  const ranges: (SelectionRange | null)[] = [...sel.ranges]
  const checked = sel.ranges.map((r) => pointEquals(r.anchor, r.focus))
  let fired = false
  for (let i = 0; i < ranges.length; i++) {
    const own = ranges[i]
    if (!own || !checked[i]) continue
    // The handler sees only its own caret: its edits (no-range calls included) act there, and the
    // other carets are not its to move.
    const handlerTr = (): Transaction => {
      const state = { ...editor.state, doc: shared.doc, selection: single(own), storedMarks: shared.storedMarks }
      const tr = new Transaction(state, editor.registry, { dev: shared.dev })
      lockSelection(tr, 'An input rule handler must not set the selection when there are several ranges')
      return tr
    }
    const tr = fireAt(editor, contextOf, shared, own.focus, handlerTr)
    if (!tr) continue
    fired = true
    for (const op of tr.ops) {
      if (op.type === 'set_selection') continue
      shared.apply(op)
      ranges.forEach((r, j) => {
        if (r && j !== i) ranges[j] = transformRange(r, op)
      })
    }
    Object.assign(shared.meta, tr.meta)
    shared.setStoredMarks(tr.storedMarks)
    if (tr.rejected !== null && shared.rejected === null) shared.rejected = tr.rejected
    ranges[i] = tr.selection ? mainRange(tr.selection) : null
  }
  if (!fired) return false
  const out = ranges.filter((r): r is SelectionRange => r !== null)
  if (out.length > 0) {
    // `setSelection` clears the stored marks: they are the handlers' own.
    const marks = shared.storedMarks
    const main = ranges.slice(0, sel.main + 1).filter((r) => r !== null).length - 1
    shared.setSelection(createSelection(out, Math.max(main, 0))).setStoredMarks(marks)
  }
  if (shared.ops.length > 0) editor.dispatch(shared)
  return true
}
