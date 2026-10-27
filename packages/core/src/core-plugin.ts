import type { Data, Path } from './model/types'
import { definePlugin } from './plugin/define'
import type { Command, InputIntent } from './plugin/types'
import type { Transaction } from './transaction/transaction'
import { deleteBackward, deleteForward, insertText, selectAll, splitBlock, type DeleteUnit } from './transaction/text'

/** Default `beforeinput` handling: inputType → edit on the tr. */
const INPUT_ACTIONS: Record<string, (tr: Transaction, intent: InputIntent) => boolean> = {
  insertText: (tr, intent) => insertText(tr, intent.data ?? '', intent.range ?? undefined),
  insertReplacementText: (tr, intent) => insertText(tr, intent.data ?? '', intent.range ?? undefined),
  deleteContentBackward: (tr) => deleteBackward(tr, 'character'),
  deleteWordBackward: (tr) => deleteBackward(tr, 'word'),
  deleteSoftLineBackward: (tr) => deleteBackward(tr, 'line'),
  deleteHardLineBackward: (tr) => deleteBackward(tr, 'line'),
  deleteContentForward: (tr) => deleteForward(tr, 'character'),
  deleteWordForward: (tr) => deleteForward(tr, 'word'),
  insertParagraph: (tr) => splitBlock(tr),
  insertLineBreak: (tr) => splitBlock(tr),
}

/**
 * Built-in core editing plugin, always prepended by the Editor. Priority 0 so its default
 * intent handling runs after every other plugin.
 */
export const corePlugin = definePlugin({
  name: 'core',
  priority: 0,
  commands: () => ({
    insertText:
      (text: string): Command =>
      ({ tr }) =>
        insertText(tr, text),
    deleteBackward:
      (unit: DeleteUnit = 'character'): Command =>
      ({ tr }) =>
        deleteBackward(tr, unit),
    deleteForward:
      (unit: DeleteUnit = 'character'): Command =>
      ({ tr }) =>
        deleteForward(tr, unit),
    splitBlock: (): Command => ({ tr }) => splitBlock(tr),
    selectAll: (): Command => ({ tr }) => selectAll(tr),
    setNodeData:
      (path: Path, partial: Data): Command =>
      ({ tr }) => {
        tr.setNodeData(path, partial)
        return tr.rejected === null
      },
  }),
  // Runs selectAll on its own tr: going through `ctx.editor.commands` would make corePlugin's
  // type depend on the Editor's command types, which are derived from corePlugin.
  keymap: (ctx) => ({
    'Mod-a': (): boolean => {
      const tr = ctx.editor.createTransaction()
      tr.meta.origin = 'command'
      if (!selectAll(tr)) return false
      if (tr.ops.length > 0) ctx.editor.dispatch(tr)
      return true
    },
  }),
  // Handled input types are consumed even when there is nothing to change (e.g. Backspace at the
  // doc start), so the browser never edits the DOM on its own; the tr is dispatched only if it has ops.
  onBeforeInput: (intent, ctx) => {
    const action = INPUT_ACTIONS[intent.inputType]
    if (!action) return false
    const tr = ctx.editor.createTransaction()
    tr.meta.origin = 'input'
    tr.meta.inputType = intent.inputType
    if (action(tr, intent) && tr.ops.length > 0) ctx.editor.dispatch(tr)
    return true
  },
})
