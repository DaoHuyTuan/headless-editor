import { nodeSelection } from '../model/editable'
import type { Path } from '../model/types'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'

/** The path of the outermost opaque block whose rendered root is or contains `target`, or null. */
function opaqueBlockAround(view: EditorView, target: globalThis.Node): Path | null {
  let found: Path | null = null
  let cur: globalThis.Node | null = target
  while (cur && cur !== view.root) {
    if (cur.nodeType === 1) found = view.renderer.opaqueBlockPath(cur as Element) ?? found
    cur = cur.parentNode
  }
  return found
}

function onMouseDown(view: EditorView, e: MouseEvent): void {
  // Shift-click extends the selection: left to the browser (the selection sync maps it).
  if (e.button !== 0 || e.shiftKey || isIgnoredEvent(view, e)) return
  const target = e.target as globalThis.Node | null
  if (!target || typeof target.nodeType !== 'number') return
  const path = opaqueBlockAround(view, target)
  if (!path) return
  const { editor } = view
  let sel
  try {
    sel = nodeSelection(editor.state.doc, editor.registry, path)
  } catch {
    // No editable text to anchor the selection: leave the click to the browser.
    return
  }
  e.preventDefault()
  const tr = editor.createTransaction()
  tr.setSelection(sel).setMeta('origin', 'selection').setMeta('addToHistory', false)
  editor.dispatch(tr)
  // Focusing also writes the node selection to the DOM.
  view.focus()
}

/**
 * Click-to-select: a primary `mousedown` (without Shift) on an opaque block (atom or unknown type), or inside it but
 * not in an ignored region, node-selects it instead of placing a caret. Inline opaque elements are
 * left to the browser.
 */
export const attachNodeSelect: ViewModule = (view) => {
  view.listen(view.root, 'mousedown', (e) => onMouseDown(view, e as MouseEvent))
  return () => {}
}
