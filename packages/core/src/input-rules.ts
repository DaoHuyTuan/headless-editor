import type { Editor } from './editor'
import { isNodeSelection } from './model/editable'
import { pointEquals } from './model/path'
import { mainRange } from './model/selection'
import type { Range } from './model/types'
import type { AnyPlugin, PluginContext } from './plugin/types'
import { blockPathOf, fromBlockOffset, runAt, toBlockOffset, type Run } from './transaction/text'

/** Meta key set on the tr of a fired input rule (recorded as its own history entry of kind `'other'`). */
export const INPUT_RULE_META = 'inputRule'

/**
 * Runs the input rules of every plugin, by priority, against the text of the caret's run (the
 * block's texts no inline atom separates, model text only) from its start to the collapsed caret.
 * Each rule that matches gets a fresh tr (origin `input`, meta `inputRule: true`); the first handler
 * returning true has its tr dispatched (when it changed anything) and ends the run. True when a rule fired.
 */
export function runInputRules(
  editor: Pick<Editor, 'state' | 'registry' | 'createTransaction' | 'dispatch'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contextOf: (plugin: AnyPlugin) => PluginContext<any, any, any, any>,
): boolean {
  const sel = editor.state.selection
  if (!sel || isNodeSelection(sel)) return false
  const range = mainRange(sel)
  if (!pointEquals(range.anchor, range.focus)) return false
  const caret = range.focus
  let run: Run
  try {
    const probe = editor.createTransaction()
    run = runAt(probe, blockPathOf(probe, caret.path), caret)
  } catch {
    return false
  }
  const text = run.text.slice(0, toBlockOffset(run, caret))
  for (const plugin of editor.registry.plugins) {
    for (const rule of plugin.spec.inputRules ?? []) {
      rule.match.lastIndex = 0
      const match = rule.match.exec(text)
      if (!match || match.index + match[0].length !== text.length) continue
      const range: Range = { start: fromBlockOffset(run, match.index), end: caret }
      const tr = editor.createTransaction()
      tr.meta.origin = 'input'
      tr.meta[INPUT_RULE_META] = true
      if (!rule.handler(contextOf(plugin), match, range, tr)) continue
      if (tr.ops.length > 0) editor.dispatch(tr)
      return true
    }
  }
  return false
}
