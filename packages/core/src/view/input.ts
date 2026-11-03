import { eventToKeyName } from '../keymap'
import type { Selection } from '../model/types'
import type { InputIntent } from '../plugin/types'
import { domToModel } from './dom-selection'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'

/** Input types owned by the clipboard module (`paste` / `cut` events): left alone here, not even prevented. */
const CLIPBOARD_INPUT = new Set(['insertFromPaste', 'deleteByCut'])

/** The model selection of the event's first target range, or null when there is none (or it is outside). */
function targetRange(view: EditorView, e: InputEvent): Selection | null {
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
 * A deletion keydown waiting for its `beforeinput`. WebKit fires none (nor `input`) when the only thing
 * to delete is an empty non-editable block, e.g. an unknown block: for the caret right after it, or for a
 * node selection covering it. Browsers fire `beforeinput` in the same task as its keydown, so a task
 * queued from the keydown runs after it: if none came, the keydown's input type runs as an intent then.
 */
interface PendingDelete {
  inputType: string
  timer: ReturnType<typeof setTimeout>
}

type PendingRef = { current: PendingDelete | null }

function clearPending(pending: PendingRef): void {
  if (pending.current) clearTimeout(pending.current.timer)
  pending.current = null
}

function onKeyDown(view: EditorView, e: KeyboardEvent, pending: PendingRef): void {
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
  const inputType = DELETE_KEYS[e.key]
  if (!inputType || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return
  clearPending(pending)
  const entry: PendingDelete = {
    inputType,
    timer: setTimeout(() => {
      if (pending.current !== entry) return
      pending.current = null
      if (view.composing) return
      view.syncSelection()
      editor.handleIntent({ inputType, data: null, dataTransfer: null, range: editor.state.selection })
    }, 0),
  }
  pending.current = entry
}

function onBeforeInput(view: EditorView, e: InputEvent, pending: PendingRef): void {
  if (isIgnoredEvent(view, e)) return
  const { editor } = view
  // The keydown got its beforeinput (whatever its type): the browser handles the key.
  clearPending(pending)
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
  view.syncSelection()
  const intent: InputIntent = {
    inputType: e.inputType,
    data: e.data,
    dataTransfer: e.dataTransfer,
    range: targetRange(view, e) ?? editor.state.selection,
  }
  const handled = editor.handleIntent(intent)
  // Even unhandled input is prevented when possible, so the DOM never drifts from the model.
  if (handled || e.cancelable) e.preventDefault()
}

/** Keyboard, `beforeinput` and `input` handling: plugin DOM handlers, then the keymap or the intent pipeline. */
export const attachInput: ViewModule = (view) => {
  const pending: PendingRef = { current: null }
  view.listen(view.root, 'keydown', (e) => onKeyDown(view, e as KeyboardEvent, pending))
  view.listen(view.root, 'beforeinput', (e) => onBeforeInput(view, e as InputEvent, pending))
  // `input` has no default action here: plugins may observe it; the mutation module reverts stray DOM changes.
  view.listen(view.root, 'input', (e) => {
    if (!isIgnoredEvent(view, e)) view.editor.handleDOMEvent('input', e)
  })
  // The listeners are removed by the view's own disposers; a pending deletion is dropped.
  return () => clearPending(pending)
}
