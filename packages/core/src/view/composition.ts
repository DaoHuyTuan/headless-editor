import { getNode, isText } from '../model/node'
import { isCollapsed, toRange } from '../model/path'
import type { Path } from '../model/types'
import { modelToDom } from './dom-selection'
import type { EditorView, ViewModule } from './view'

const INPUT_TYPE = 'insertCompositionText'

/** The text an IME left in a leaf: its DOM text (a lone `<br data-hte-break>` counts as empty). */
function leafDomText(leaf: HTMLElement): string {
  return leaf.textContent ?? ''
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Common prefix and suffix lengths of `a` and `b` (non-overlapping, never splitting a surrogate pair). */
function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++
  if (prefix > 0 && isHighSurrogate(a.charCodeAt(prefix - 1))) prefix--
  let suffix = 0
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--
  return { prefix, suffix }
}

function onCompositionStart(view: EditorView): void {
  if (view.composing) return
  const { editor, renderer } = view
  // While not yet composing, so the model follows the DOM caret.
  view.syncSelection()
  const sel = editor.state.selection
  if (sel && !isCollapsed(sel)) {
    // The IME replaces the selection: delete it in the model first (the render collapses the DOM selection).
    const tr = editor.createTransaction()
    tr.deleteRange(toRange(sel)).setMeta('origin', 'input').setMeta('inputType', INPUT_TYPE)
    editor.dispatch(tr)
  }
  view.composing = true
  const focus = editor.state.selection?.focus
  const leaf = focus && renderer.leafAt(focus.path)
  if (!focus || !leaf) return
  view.composition = { leaf, path: [...focus.path] }
  // Make sure the IME writes into that leaf (not next to it, e.g. when the caret sits in the block).
  const domSel = view.root.ownerDocument.getSelection()
  if (domSel && domSel.isCollapsed && !(domSel.anchorNode && leaf.contains(domSel.anchorNode))) {
    const { node, offset } = modelToDom(renderer, focus)
    domSel.collapse(node, offset)
  }
}

/** Commits what the IME left in the composing leaf as one input tr, then renders normally. */
function onCompositionEnd(view: EditorView): void {
  if (!view.composing) return
  const target = view.composition
  view.composing = false
  view.composition = null
  const { editor } = view
  const stateBefore = editor.state
  if (target) commit(view, target.leaf, target.path)
  // Nothing dispatched (no change, or the tr was filtered out): still rebuild the leaf and show the selection.
  if (editor.state === stateBefore) view.update(editor.state)
}

function commit(view: EditorView, leaf: HTMLElement, path: Path): void {
  const { editor } = view
  let node
  try {
    node = getNode(editor.state.doc, path)
  } catch {
    return
  }
  if (!isText(node)) return
  const before = node.text
  const after = leafDomText(leaf)
  if (after === before) return
  const { prefix, suffix } = commonEnds(before, after)
  const removed = before.slice(prefix, before.length - suffix)
  const inserted = after.slice(prefix, after.length - suffix)
  const tr = editor.createTransaction()
  if (removed) tr.apply({ type: 'remove_text', path, offset: prefix, text: removed })
  if (inserted) tr.apply({ type: 'insert_text', path, offset: prefix, text: inserted })
  const caret = { path, offset: prefix + inserted.length }
  tr.setSelection({ anchor: caret, focus: caret }).setMeta('origin', 'input').setMeta('inputType', INPUT_TYPE)
  editor.dispatch(tr)
}

/**
 * IME composition: the browser owns the composing leaf's DOM from `compositionstart` until
 * `compositionend` (or `blur`, if that never comes), then the leaf's text is diffed against the model.
 */
export const attachComposition: ViewModule = (view) => {
  view.listen(view.root, 'compositionstart', () => onCompositionStart(view))
  view.listen(view.root, 'compositionend', () => onCompositionEnd(view))
  view.listen(view.root, 'blur', () => onCompositionEnd(view))
  return () => {
    view.composing = false
    view.composition = null
  }
}
