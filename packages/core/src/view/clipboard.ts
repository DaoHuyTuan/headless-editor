import { isCollapsed, toRange } from '../model/path'
import { isNodeRange, mainRange } from '../model/selection'
import type { Path, Range } from '../model/types'
import { replaceSelectedNode } from '../transaction/text'
import { FRAGMENT_MIME, serializeForClipboard } from '../content/clipboard'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'

/** The model range to copy, or null when the browser should handle the event (collapsed, or outside the root). */
function copyRange(view: EditorView): { range: Range; node?: Path } | null {
  view.syncSelection()
  const domSel = view.root.ownerDocument.getSelection()
  const inside = (n: globalThis.Node | null | undefined) => !!n && view.root.contains(n)
  if (!domSel || !inside(domSel.anchorNode) || !inside(domSel.focusNode)) return null
  const sel = view.editor.state.selection
  if (!sel) return null
  const range = mainRange(sel)
  // A node selection copies its node, although its caret is collapsed.
  if (isNodeRange(range)) return { range: toRange(range), node: range.node }
  return !isCollapsed(range) ? { range: toRange(range) } : null
}

function onCopy(view: EditorView, e: ClipboardEvent, cut: boolean): void {
  if (isIgnoredEvent(view, e)) return
  // A cut while composing would change the IME's text: the composition owns the DOM.
  if (cut && view.composing) return
  const data = e.clipboardData
  const target = data && copyRange(view)
  if (!data || !target) return
  e.preventDefault()
  const { html, text, json } = serializeForClipboard(view.editor, target.range, target.node)
  data.setData('text/plain', text)
  data.setData('text/html', html)
  data.setData(FRAGMENT_MIME, json)
  if (!cut) return
  const tr = view.editor.createTransaction()
  // A node selection: the node is removed and the caret goes where node deletion puts it.
  if (target.node) replaceSelectedNode(tr, 'delete')
  else tr.deleteRange(target.range)
  tr.setMeta('origin', 'input').setMeta('inputType', 'deleteByCut')
  view.editor.dispatch(tr)
}

/** Paste goes through the intent pipeline (`insertFromPaste`): plugins first, then the core default. */
function onPaste(view: EditorView, e: ClipboardEvent): void {
  if (isIgnoredEvent(view, e)) return
  if (view.composing) return
  view.syncSelection()
  e.preventDefault()
  const { editor } = view
  editor.handleIntent({
    inputType: 'insertFromPaste',
    data: null,
    dataTransfer: e.clipboardData,
    range: editor.state.selection && mainRange(editor.state.selection),
  })
}

/** `copy` / `cut` / `paste` handling: the editor owns the clipboard flavors; paste becomes an intent. */
export const attachClipboard: ViewModule = (view) => {
  view.listen(view.root, 'copy', (e) => onCopy(view, e as ClipboardEvent, false))
  view.listen(view.root, 'cut', (e) => onCopy(view, e as ClipboardEvent, true))
  view.listen(view.root, 'paste', (e) => onPaste(view, e as ClipboardEvent))
  // The listeners are removed by the view's own disposers.
  return () => {}
}
