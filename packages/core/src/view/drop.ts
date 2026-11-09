import { mainRange } from '../model/selection'
import type { Point, SelectionRange } from '../model/types'
import { FRAGMENT_MIME } from '../content/clipboard'
import { domToModel } from './dom-selection'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'

/** Transfer types a drop can insert: files (for plugins) and the clipboard flavors. */
const DROPPABLE = new Set(['Files', 'text/plain', 'text/html', FRAGMENT_MIME])

interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: globalThis.Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null
}

/** The model point under `(x, y)`, or null when the browser cannot tell or it is outside the root. */
function pointAt(view: EditorView, x: number, y: number): Point | null {
  const doc = view.root.ownerDocument as Document & CaretDocument
  let node: globalThis.Node | null = null
  let offset = 0
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (pos) ({ offsetNode: node, offset } = pos)
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    if (range) ({ startContainer: node, startOffset: offset } = range)
  }
  return node ? domToModel(view.renderer, node, offset) : null
}

function onDrop(view: EditorView, e: DragEvent): void {
  if (isIgnoredEvent(view, e)) return
  e.preventDefault()
  // The composition owns the DOM: moving the selection now would break it.
  if (view.composing) return
  const { editor } = view
  // A drop goes to one place: the drop point (the browser cannot tell where: the main range). The
  // selection only moves there with the insert, so a drop with nothing to insert leaves it alone.
  const point = pointAt(view, e.clientX, e.clientY)
  const sel = editor.state.selection
  const range: SelectionRange | null = point ? { anchor: point, focus: point } : sel && mainRange(sel)
  view.focus()
  editor.handleIntent({ inputType: 'insertFromDrop', data: null, dataTransfer: e.dataTransfer, range })
}

/**
 * Drag and drop: drops of files or clipboard flavors go through the intent pipeline
 * (`insertFromDrop`) at the drop point. Dragging content out of the editor is not supported (M2):
 * `dragstart` inside the root is prevented, except in ignored regions.
 */
export const attachDrop: ViewModule = (view) => {
  view.listen(view.root, 'dragstart', (e) => {
    if (!isIgnoredEvent(view, e)) e.preventDefault()
  })
  view.listen(view.root, 'dragover', (e) => {
    if (isIgnoredEvent(view, e)) return
    const types = (e as DragEvent).dataTransfer?.types ?? []
    if (Array.from(types).some((t) => DROPPABLE.has(t))) e.preventDefault()
  })
  view.listen(view.root, 'drop', (e) => onDrop(view, e as DragEvent))
  // The listeners are removed by the view's own disposers.
  return () => {}
}
