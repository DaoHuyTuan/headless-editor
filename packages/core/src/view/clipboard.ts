import type { Editor } from '../editor'
import { serializeHTML } from '../html/serialize'
import { parseHTML } from '../html/parse'
import { defaultBlock, isBlock, sanitizeFragment } from '../content/sanitize'
import { isText } from '../model/node'
import { isCollapsed, toRange } from '../model/path'
import type { Doc, ElementNode, Node, Range } from '../model/types'
import type { Registry } from '../plugin/registry'
import { getFragment, type Fragment } from '../transaction/fragment'
import type { EditorView, ViewModule } from './view'

/** The MIME type of the lossless JSON flavor (a `JSON.stringify`-ed `Fragment`). */
export const FRAGMENT_MIME = 'application/x-hte-fragment'

function textOf(node: Node): string {
  return isText(node) ? node.text : (node.children ?? []).map(textOf).join('')
}

/**
 * The three clipboard flavors of `range`: `json` is the fragment itself, `html` the fragment
 * serialized as a doc (inline content is wrapped into a default block first), `text` the text of
 * each block (inline elements included) joined by `\n`.
 */
export function serializeForClipboard(editor: Editor, range: Range): { html: string; text: string; json: string } {
  const { registry } = editor
  const fragment = getFragment(editor.state.doc, range)
  const blocks = fragment.length > 0 && isBlock(fragment[0]!, registry)
  const doc: Doc = {
    type: 'doc',
    children: blocks ? (fragment as ElementNode[]) : fragment.length > 0 ? [defaultBlock(registry, fragment)] : [],
  }
  return {
    json: JSON.stringify(fragment),
    html: serializeHTML(doc, registry, (name) => editor.getPluginOptions(name)),
    text: blocks ? fragment.map(textOf).join('\n') : fragment.map(textOf).join(''),
  }
}

function fromJson(json: string, registry: Registry): Fragment {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  return Array.isArray(raw) ? sanitizeFragment(raw, registry) : []
}

function fromText(text: string, registry: Registry): Fragment {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length === 1) return [{ text, marks: [] }]
  return lines.map((line) => defaultBlock(registry, [{ text: line, marks: [] }]))
}

/**
 * Turns clipboard data into a fragment ready for `insertFragment`. Tries `json` (the
 * `application/x-hte-fragment` flavor), then `html`, then `text`, moving on when a flavor is
 * missing, malformed or yields nothing. JSON and HTML are untrusted: data is validated and unknown
 * types are dropped. Text lines become default blocks; a single line is inline text without marks.
 * Finally every plugin's `transformPasted` runs, in priority order.
 */
export function parseFromClipboard(editor: Editor, data: { json?: string; html?: string; text?: string }): Fragment {
  const { registry } = editor
  let fragment: Fragment = []
  if (data.json) fragment = fromJson(data.json, registry)
  if (fragment.length === 0 && data.html) fragment = sanitizeFragment(parseHTML(data.html, registry), registry)
  if (fragment.length === 0 && data.text) fragment = fromText(data.text, registry)
  return editor.transformPasted(fragment)
}

/** The model range to copy, or null when the browser should handle the event (collapsed, or outside the root). */
function copyRange(view: EditorView): Range | null {
  view.syncSelection()
  const domSel = view.root.ownerDocument.getSelection()
  const inside = (n: globalThis.Node | null | undefined) => !!n && view.root.contains(n)
  if (!domSel || !inside(domSel.anchorNode) || !inside(domSel.focusNode)) return null
  const sel = view.editor.state.selection
  return sel && !isCollapsed(sel) ? toRange(sel) : null
}

function onCopy(view: EditorView, e: ClipboardEvent, cut: boolean): void {
  // A cut while composing would change the IME's text: the composition owns the DOM.
  if (cut && view.composing) return
  const data = e.clipboardData
  const range = data && copyRange(view)
  if (!data || !range) return
  e.preventDefault()
  const { html, text, json } = serializeForClipboard(view.editor, range)
  data.setData('text/plain', text)
  data.setData('text/html', html)
  data.setData(FRAGMENT_MIME, json)
  if (!cut) return
  const tr = view.editor.createTransaction()
  tr.deleteRange(range).setMeta('origin', 'input').setMeta('inputType', 'deleteByCut')
  view.editor.dispatch(tr)
}

function onPaste(view: EditorView, e: ClipboardEvent): void {
  if (view.composing) return
  view.syncSelection()
  e.preventDefault()
  const data = e.clipboardData
  if (!data) return
  const { editor } = view
  const fragment = parseFromClipboard(editor, {
    json: data.getData(FRAGMENT_MIME),
    html: data.getData('text/html'),
    text: data.getData('text/plain'),
  })
  if (fragment.length === 0 || !editor.state.selection) return
  const tr = editor.createTransaction()
  tr.insertFragment(fragment).setMeta('origin', 'paste').setMeta('inputType', 'insertFromPaste')
  editor.dispatch(tr)
}

/** `copy` / `cut` / `paste` handling: the editor owns the clipboard flavors and the paste insertion. */
export const attachClipboard: ViewModule = (view) => {
  view.listen(view.root, 'copy', (e) => onCopy(view, e as ClipboardEvent, false))
  view.listen(view.root, 'cut', (e) => onCopy(view, e as ClipboardEvent, true))
  view.listen(view.root, 'paste', (e) => onPaste(view, e as ClipboardEvent))
  // The listeners are removed by the view's own disposers.
  return () => {}
}
