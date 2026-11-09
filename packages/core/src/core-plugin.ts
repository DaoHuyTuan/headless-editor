import { sanitizeFragment } from './content/sanitize'
import type { Editor } from './editor'
import { isNodeSelection } from './model/editable'
import { mainRange, single } from './model/selection'
import { comparePoint, toRange } from './model/path'
import type { Data, Path, Selection, SelectionRange } from './model/types'
import { definePlugin } from './plugin/define'
import type { Command, InputIntent } from './plugin/types'
import { insertFragment, type Fragment } from './transaction/fragment'
import { addMark, removeMark, toggleMark } from './transaction/marks'
import { FRAGMENT_MIME, parseFromClipboard } from './content/clipboard'
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

/**
 * Whether the intent addresses the main range (plain typing / pasting at the selection): no range,
 * or the main range's span (in either direction: a target range is always forward).
 */
function targetsMain(intent: InputIntent, sel: Selection): boolean {
  if (!intent.range) return true
  const a = toRange(intent.range)
  const b = toRange(mainRange(sel))
  return comparePoint(a.start, b.start) === 0 && comparePoint(a.end, b.end) === 0
}

/** Inserts the intent's text into `intent.range` (or the selection). Without text, does nothing (false). */
function insertIntentText(tr: Transaction, intent: InputIntent): boolean {
  const text = intentText(intent)
  if (text === null) return false
  // With a node selection the model selection is authoritative (the DOM range is only its caret):
  // typing replaces the selected node.
  if (isNodeSelection(tr.selection)) return insertText(tr, text)
  const sel = tr.selection
  // With one range the intent's range is used as it always was.
  if (!sel || sel.ranges.length === 1) return insertText(tr, text, intent.range ?? undefined)
  // Several ranges: plain typing (the intent targets the main range) goes to every range.
  const range = intent.range
  // Replacement text (spellcheck, autocorrect) always addresses its own range, even the main one.
  const targeted = intent.inputType === 'insertReplacementText'
  if (!range || (!targeted && targetsMain(intent, sel))) return insertText(tr, text)
  // An intent with its own target (autocorrect, spellcheck) applies only there (spec §8 call 13).
  collapseTo(tr, range)
  return insertText(tr, text, range)
}

/**
 * Collapses the selection to `range` alone, keeping the stored marks: an input that addresses one
 * place (an intent's own target, a drop point) drops the other ranges (spec §5.4).
 */
function collapseTo(tr: Transaction, range: SelectionRange): void {
  const marks = tr.storedMarks
  tr.setSelection(single(range)).setStoredMarks(marks)
}

/** Transfer input types the core inserts itself, and the origin of their tr. */
const PASTE_INPUT: Record<string, 'paste' | 'input'> = { insertFromPaste: 'paste', insertFromDrop: 'input' }

/**
 * Where a paste / drop goes: null for the selection, else a range (passed to `transformPasted` too).
 * - A drop: its drop point (`intent.range`), also while a node is selected.
 * - A paste over a node selection: null, the fragment replaces the node in place, as typing does.
 * - A paste with several ranges: null (the same fragment at every range, spec §5.4) when the intent
 *   targets the main range or nothing; a paste at another range goes only there (and collapses,
 *   as any intent with its own target: spec §8 call 13). With one range
 *   `intent.range` is kept as it always was (it is the selection).
 */
function transferTarget(intent: InputIntent, sel: Selection | null): SelectionRange | null {
  if (!sel) return intent.range
  // A drop goes to its drop point, even while a node is selected (it never replaces that node).
  if (intent.inputType === 'insertFromDrop' && intent.range) return intent.range
  if (isNodeSelection(sel)) return null
  if (intent.inputType !== 'insertFromPaste' || sel.ranges.length === 1) return intent.range
  return targetsMain(intent, sel) ? null : intent.range
}

/**
 * Default paste / drop: parses the `dataTransfer` flavors (json, html, text) and inserts the
 * fragment (see `transferTarget`): a paste at every selection range, a drop only at its drop point,
 * the selection collapsing to that one range. A transfer without usable content is still consumed,
 * so the browser never inserts anything itself.
 */
function insertTransfer(intent: InputIntent, editor: Editor): boolean {
  const transfer = intent.dataTransfer
  if (!transfer) return false
  const sel = editor.state.selection
  const at = transferTarget(intent, sel)
  const data = {
    json: transfer.getData(FRAGMENT_MIME),
    html: transfer.getData('text/html'),
    text: transfer.getData('text/plain'),
  }
  // A paste at several ranges parses once per range, each with `info.at` set to that range: a
  // `transformPasted` that decides by position (the code block: plain text inside a code block, rich
  // elsewhere) then sees every caret's own context. With one range the selection is the target
  // (`info.at` as it always was).
  if (sel && !isNodeSelection(sel) && !at && sel.ranges.length > 1 && intent.inputType === 'insertFromPaste') {
    const fragments = sel.ranges.map((range) => parseFromClipboard(editor, data, { at: range }))
    if (fragments.every((f) => f.length === 0)) return true
    const tr = editor.createTransaction()
    tr.meta.origin = PASTE_INPUT[intent.inputType]!
    tr.meta.inputType = intent.inputType
    let failed = false
    tr.forEachRange((range, t, i) => {
      const fragment = fragments[i]!
      if (fragment.length > 0 && !insertFragment(t, fragment, range)) failed = true
    })
    if (!failed && tr.ops.length > 0) editor.dispatch(tr)
    return true
  }
  const fragment = parseFromClipboard(editor, data, { at })
  if (fragment.length === 0) return true
  const tr = editor.createTransaction()
  tr.meta.origin = PASTE_INPUT[intent.inputType]!
  tr.meta.inputType = intent.inputType
  // A drop, or a paste with its own target, goes to one place: the selection collapses there (a
  // drop with no point: to the main range). A paste at the selection goes to every range.
  if (sel && (sel.ranges.length > 1 || isNodeSelection(sel)) && (at || intent.inputType === 'insertFromDrop'))
    collapseTo(tr, at ?? mainRange(sel))
  if (insertFragment(tr, fragment, at ?? undefined) && tr.ops.length > 0) editor.dispatch(tr)
  return true
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
    // At every selection range (a selected node is replaced); each copy gets fresh ids.
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
  // doc start), so the browser never edits the DOM on its own; the tr is dispatched only if it changes
  // something (ops, or the stored marks alone, as for bound commands).
  onBeforeInput: (intent, ctx) => {
    if (Object.hasOwn(PASTE_INPUT, intent.inputType)) return insertTransfer(intent, ctx.editor)
    const action = Object.hasOwn(INPUT_ACTIONS, intent.inputType) ? INPUT_ACTIONS[intent.inputType] : undefined
    if (!action) return false
    // An insert intent without any text is left unhandled, so nothing is deleted.
    if (action === insertIntentText && intentText(intent) === null) return false
    const tr = ctx.editor.createTransaction()
    tr.meta.origin = 'input'
    tr.meta.inputType = intent.inputType
    if (action(tr, intent) && (tr.ops.length > 0 || tr.storedMarks !== ctx.editor.state.storedMarks)) {
      const docBefore = ctx.editor.state.doc
      ctx.editor.dispatch(tr)
      // Typed text (not composition, paste or replacement text) runs the input rules; a rule that
      // fires is dispatched as its own tr, so it is its own undo step.
      if (intent.inputType === 'insertText' && ctx.editor.state.doc !== docBefore) ctx.editor.runInputRules()
    }
    return true
  },
})
