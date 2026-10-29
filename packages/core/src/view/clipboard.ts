import type { Editor } from '../editor'
import { serializeHTML } from '../html/serialize'
import { parseHTML } from '../html/parse'
import { defaultBlock, isBlock, sanitizeFragment } from '../content/sanitize'
import { isNodeSelection } from '../model/editable'
import { nodeText } from '../content/text'
import { isCollapsed, toRange } from '../model/path'
import type { Doc, ElementNode, Node, Path, Range } from '../model/types'
import type { Registry } from '../plugin/registry'
import { getFragment, type Fragment } from '../transaction/fragment'
import { replaceSelectedNode } from '../transaction/text'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'

/** The MIME type of the lossless JSON flavor (a `JSON.stringify`-ed `Fragment`). */
export const FRAGMENT_MIME = 'application/x-hte-fragment'

/**
 * The three clipboard flavors of `range`: `json` is the fragment itself, `html` the fragment
 * serialized as a doc (inline content is wrapped into a default block first), `text` the text of
 * each block (inline elements included, through their `renderText` when they have one) joined by
 * `\n`. With `node` (a node selection's `selection.node`), the fragment is that node alone.
 */
export function serializeForClipboard(
  editor: Editor,
  range: Range,
  node?: Path,
): { html: string; text: string; json: string } {
  const { registry } = editor
  const fragment = getFragment(editor.state.doc, range, node)
  const textOf = (n: Node) => nodeText(n, registry, (plugin) => editor.getPluginOptions(plugin.name))
  const blocks = fragment.length > 0 && isBlock(fragment[0]!, registry)
  const doc: Doc = {
    type: 'doc',
    children: blocks ? (fragment as ElementNode[]) : fragment.length > 0 ? [defaultBlock(registry, fragment)] : [],
  }
  return {
    json: JSON.stringify(fragment),
    html: serializeHTML(doc, registry, (name) => editor.getPluginOptions(name)),
    text: fragment.map(textOf).join(blocks ? '\n' : ''),
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
function copyRange(view: EditorView): { range: Range; node?: Path } | null {
  view.syncSelection()
  const domSel = view.root.ownerDocument.getSelection()
  const inside = (n: globalThis.Node | null | undefined) => !!n && view.root.contains(n)
  if (!domSel || !inside(domSel.anchorNode) || !inside(domSel.focusNode)) return null
  const sel = view.editor.state.selection
  // A node selection copies its node, although its caret is collapsed.
  if (isNodeSelection(sel)) return { range: toRange(sel), node: sel.node }
  return sel && !isCollapsed(sel) ? { range: toRange(sel) } : null
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
    range: editor.state.selection,
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
