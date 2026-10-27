import { sanitizeFragment } from './content/sanitize'
import { isNodeSelection } from './model/editable'
import type { Data, Path } from './model/types'
import { definePlugin } from './plugin/define'
import type { Command, InputIntent } from './plugin/types'
import { insertFragment, type Fragment } from './transaction/fragment'
import { addMark, removeMark, toggleMark } from './transaction/marks'
import type { Transaction } from './transaction/transaction'
import { deleteBackward, deleteForward, insertText, selectAll, splitBlock, type DeleteUnit } from './transaction/text'

/**
 * The text an insert intent carries: `data`, else the plain text in `dataTransfer` (Chromium sends
 * spellcheck/autocorrect `insertReplacementText` with `data === null`). Null when there is none;
 * `getData` returns '' when the type is missing, so that counts as none too.
 */
function intentText(intent: InputIntent): string | null {
  return intent.data ?? (intent.dataTransfer?.getData('text/plain') || null)
}

/** Inserts the intent's text into `intent.range` (or the selection). Without text, does nothing (false). */
function insertIntentText(tr: Transaction, intent: InputIntent): boolean {
  const text = intentText(intent)
  if (text === null) return false
  // With a node selection the model selection is authoritative (the DOM range is only its caret):
  // typing replaces the selected node.
  return insertText(tr, text, isNodeSelection(tr.selection) ? undefined : (intent.range ?? undefined))
}

/** Default `beforeinput` handling: inputType → edit on the tr. Returning false leaves the intent unhandled. */
const INPUT_ACTIONS: Record<string, (tr: Transaction, intent: InputIntent) => boolean> = {
  insertText: insertIntentText,
  insertReplacementText: insertIntentText,
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
    insertContent:
      (fragment: Fragment): Command =>
      ({ tr }) =>
        insertFragment(tr, sanitizeFragment(fragment, tr.registry)),
    setNodeData:
      (path: Path, partial: Data): Command =>
      ({ tr }) => {
        tr.setNodeData(path, partial)
        return tr.rejected === null
      },
    // Stored-mark-only changes (caret) dispatch too: the Editor dispatches when storedMarks changed.
    toggleMark:
      (type: string, data?: Data): Command =>
      ({ tr }) =>
        toggleMark(tr, type, data) && tr.rejected === null,
    setMark:
      (type: string, data?: Data): Command =>
      ({ tr }) =>
        addMark(tr, { type, data: data ?? {} }) && tr.rejected === null,
    unsetMark:
      (type: string): Command =>
      ({ tr }) =>
        removeMark(tr, type),
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
    // An insert intent without any text is left unhandled, so nothing is deleted.
    if (action === insertIntentText && intentText(intent) === null) return false
    const tr = ctx.editor.createTransaction()
    tr.meta.origin = 'input'
    tr.meta.inputType = intent.inputType
    if (action(tr, intent) && tr.ops.length > 0) ctx.editor.dispatch(tr)
    return true
  },
})
