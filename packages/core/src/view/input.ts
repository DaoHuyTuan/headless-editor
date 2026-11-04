import { eventToKeyName } from '../keymap'
import { mainRange } from '../model/selection'
import type { SelectionRange } from '../model/types'
import type { InputIntent } from '../plugin/types'
import type { EditorState } from '../state'
import { domToModel } from './dom-selection'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'

/** Input types owned by the clipboard module (`paste` / `cut` events): left alone here, not even prevented. */
const CLIPBOARD_INPUT = new Set(['insertFromPaste', 'deleteByCut'])

/** The model selection of the event's first target range, or null when there is none (or it is outside). */
function targetRange(view: EditorView, e: InputEvent): SelectionRange | null {
  if (typeof e.getTargetRanges !== 'function') return null
  const range = e.getTargetRanges()[0]
  if (!range) return null
  const anchor = domToModel(view.renderer, range.startContainer, range.startOffset)
  const focus = domToModel(view.renderer, range.endContainer, range.endOffset)
  return anchor && focus ? { anchor, focus } : null
}

/** The input type a plain Backspace/Delete keydown stands for when no `beforeinput` follows it. */
const DELETE_KEYS: Record<string, string> = { Backspace: 'deleteContentBackward', Delete: 'deleteContentForward' }

/**
 * How long after `compositionend` a deletion keydown is not given the fallback (ms). Safari sends the
 * keydown that ends a composition after `compositionend`, with `isComposing` false (as ProseMirror's
 * `compositionEndedAt` handles); the key belongs to the IME. Kept small so a real Backspace typed right
 * after a composition still gets the fallback.
 */
const COMPOSITION_END_WINDOW = 50

/**
 * A deletion keydown waiting for its `beforeinput`. WebKit fires none (nor `input`) when the only thing
 * to delete is an empty non-editable block, e.g. an unknown block: for the caret right after it, or for a
 * node selection covering it. Browsers fire `beforeinput` in the same task as its keydown, so a task
 * queued from the keydown runs after it: if none came, the keydown's input type runs as an intent then.
 * It runs only when nothing else answered the key: no `beforeinput` (even on an ignored target), `cut`,
 * `paste` or `compositionstart` since, the editor state is the one seen at keydown, the keydown was not
 * prevented by a later listener, and the editor still has focus.
 */
interface PendingDelete {
  inputType: string
  event: KeyboardEvent
  state: EditorState
  timer: ReturnType<typeof setTimeout>
}

interface InputModuleState {
  pending: PendingDelete | null
  /** `Date.now()` of the last `compositionend` on the root (-Infinity before any). */
  compositionEndedAt: number
}

function clearPending(m: InputModuleState): void {
  if (m.pending) clearTimeout(m.pending.timer)
  m.pending = null
}

function runPendingDelete(view: EditorView, m: InputModuleState, entry: PendingDelete): void {
  if (m.pending !== entry) return
  m.pending = null
  const { editor } = view
  if (editor.state !== entry.state || entry.event.defaultPrevented || view.composing || !view.hasFocus()) return
  view.syncSelection()
  const sel = editor.state.selection
  // The main range: the intent addresses the selection (core then acts at every range).
  editor.handleIntent({ inputType: entry.inputType, data: null, dataTransfer: null, range: sel && mainRange(sel) })
}

/** Arms the deletion-key fallback for an unhandled, unprevented plain Backspace/Delete keydown. */
function armPendingDelete(view: EditorView, e: KeyboardEvent, m: InputModuleState): void {
  const inputType = DELETE_KEYS[e.key]
  if (!inputType || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return
  // keyCode 229: the IME owns the key; a keydown just after compositionend ends the composition (Safari).
  if (e.keyCode === 229 || Date.now() - m.compositionEndedAt < COMPOSITION_END_WINDOW) return
  clearPending(m)
  const entry: PendingDelete = {
    inputType,
    event: e,
    state: view.editor.state,
    timer: setTimeout(() => runPendingDelete(view, m, entry), 0),
  }
  m.pending = entry
}

function onKeyDown(view: EditorView, e: KeyboardEvent, m: InputModuleState): void {
  if (isIgnoredEvent(view, e)) return
  const { editor } = view
  if (editor.handleDOMEvent('keydown', e)) {
    e.preventDefault()
    return
  }
  // Keys during an IME composition belong to the IME.
  if (view.composing || e.isComposing) return
  view.syncSelection()
  if (editor.runKeymap(eventToKeyName(e))) {
    e.preventDefault()
    return
  }
  armPendingDelete(view, e, m)
}

function onBeforeInput(view: EditorView, e: InputEvent, m: InputModuleState): void {
  // The keydown got its beforeinput (whatever its type or target): the browser handles the key.
  clearPending(m)
  if (isIgnoredEvent(view, e)) return
  const { editor } = view
  view.recordInput({ inputType: e.inputType, data: e.data, time: Date.now() })
  if (editor.handleDOMEvent('beforeinput', e)) return
  // Composition is handled by the composition module.
  if (view.composing || e.inputType === 'insertCompositionText') return
  if (CLIPBOARD_INPUT.has(e.inputType)) return
  if (e.inputType === 'insertFromDrop') {
    // Drops are handled by the drop module on `drop` (prevented there, so this rarely fires).
    e.preventDefault()
    return
  }
  // The browser's target range, else the main range (the DOM shows only main). A target equal to the
  // main range is plain input at every range; another target applies only there (core-plugin).
  view.syncSelection()
  const intent: InputIntent = {
    inputType: e.inputType,
    data: e.data,
    dataTransfer: e.dataTransfer,
    range: targetRange(view, e) ?? (editor.state.selection && mainRange(editor.state.selection)),
  }
  const handled = editor.handleIntent(intent)
  // Even unhandled input is prevented when possible, so the DOM never drifts from the model.
  if (handled || e.cancelable) e.preventDefault()
}

/** Keyboard, `beforeinput` and `input` handling: plugin DOM handlers, then the keymap or the intent pipeline. */
export const attachInput: ViewModule = (view) => {
  const m: InputModuleState = { pending: null, compositionEndedAt: -Infinity }
  view.listen(view.root, 'keydown', (e) => onKeyDown(view, e as KeyboardEvent, m))
  view.listen(view.root, 'beforeinput', (e) => onBeforeInput(view, e as InputEvent, m))
  // A cut (Shift+Delete), paste (Shift+Insert) or composition answered the deletion key instead.
  for (const type of ['cut', 'paste', 'compositionstart']) view.listen(view.root, type, () => clearPending(m))
  view.listen(view.root, 'compositionend', () => {
    clearPending(m)
    m.compositionEndedAt = Date.now()
  })
  // `input` has no default action here: plugins may observe it; the mutation module reverts stray DOM changes.
  view.listen(view.root, 'input', (e) => {
    if (!isIgnoredEvent(view, e)) view.editor.handleDOMEvent('input', e)
  })
  // The listeners are removed by the view's own disposers; a pending deletion is dropped.
  return () => clearPending(m)
}
