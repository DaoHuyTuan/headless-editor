import { eventToKeyName } from '../keymap'
import type { Selection } from '../model/types'
import type { InputIntent } from '../plugin/types'
import { domToModel } from './dom-selection'
import type { EditorView, ViewModule } from './view'

/** Input types owned by the clipboard module (Task 22): left alone here, not even prevented. */
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

function onKeyDown(view: EditorView, e: KeyboardEvent): void {
  const { editor } = view
  if (editor.handleDOMEvent('keydown', e)) {
    e.preventDefault()
    return
  }
  // Keys during an IME composition belong to the IME.
  if (view.composing || e.isComposing) return
  view.syncSelection()
  if (editor.runKeymap(eventToKeyName(e))) e.preventDefault()
}

function onBeforeInput(view: EditorView, e: InputEvent): void {
  const { editor } = view
  view.recordInput({ inputType: e.inputType, data: e.data, time: Date.now() })
  if (editor.handleDOMEvent('beforeinput', e)) return
  // Composition is handled by the composition module.
  if (view.composing || e.inputType === 'insertCompositionText') return
  if (CLIPBOARD_INPUT.has(e.inputType)) return
  if (e.inputType === 'insertFromDrop') {
    // Drag and drop arrives in M2.
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
  view.listen(view.root, 'keydown', (e) => onKeyDown(view, e as KeyboardEvent))
  view.listen(view.root, 'beforeinput', (e) => onBeforeInput(view, e as InputEvent))
  // `input` has no default action here: plugins may observe it; the mutation module reverts stray DOM changes.
  view.listen(view.root, 'input', (e) => view.editor.handleDOMEvent('input', e))
  // The listeners are removed by the view's own disposers.
  return () => {}
}
