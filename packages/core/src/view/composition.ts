import { getNode, isText, sameMarkSet } from '../model/node'
import { isCollapsed, toRange } from '../model/path'
import { mainRange, single } from '../model/selection'
import type { Mark, Path } from '../model/types'
import { marksAt, marksOfRange } from '../transaction/marks'
import { isNodeSelection } from '../model/editable'
import { replaceSelectedNode } from '../transaction/text'
import { textsOutsideWidgets } from './decorations'
import { modelToDom } from './dom-selection'
import { isIgnoredEvent } from './ignore'
import type { EditorView, ViewModule } from './view'
import { isZwLeaf, stripPlaceholder } from './zero-width'

const INPUT_TYPE = 'insertCompositionText'

/**
 * The text an IME left in a leaf: its DOM text (a lone `<br data-penline-break>` counts as empty). In a
 * zero-width leaf (an empty text beside an inline atom) its one placeholder is not text, while a
 * real U+200B the IME wrote is (see `stripPlaceholder`).
 * Decoration spans are read through (their text is the leaf's); decoration widgets are not text.
 */
function leafDomText(leaf: HTMLElement): string {
  const text = textsOutsideWidgets(leaf)
    .map((t) => t.data)
    .join('')
  return stripPlaceholder(text, isZwLeaf(leaf))
}

/**
 * Text an IME wrote right beside the leaf instead of inside it (bare Text nodes next to it, e.g. a
 * caret at the leaf's edge), in document order; nodes in `known` (there at `compositionstart`, e.g.
 * a static text of the block's `renderHTML`) are not. The nodes are removed: the leaf's text now has
 * it, and the render that follows does not know them.
 */
function strayText(leaf: HTMLElement, side: 'previousSibling' | 'nextSibling', known: ReadonlySet<globalThis.Node>): string {
  const parts: string[] = []
  for (let n = leaf[side]; n && n.nodeType === 3 && !known.has(n); n = leaf[side]) {
    parts.push((n as Text).data)
    n.remove()
  }
  if (side === 'previousSibling') parts.reverse()
  return parts.join('')
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

/**
 * The marks the composed text must get, captured at `compositionstart` by the typing rule: stored
 * marks, else the marks of the first replaced character, else the marks at the caret.
 */
const compositionMarks = new WeakMap<EditorView, Mark[]>()

/** The composing leaf's siblings at `compositionstart`: never read as stray IME text. */
const startSiblings = new WeakMap<EditorView, Set<globalThis.Node>>()

function onCompositionStart(view: EditorView): void {
  if (view.composing) return
  const { editor, renderer } = view
  // While not yet composing, so the model follows the DOM caret.
  view.syncSelection()
  // The IME composes at one place: the main range on purpose (spec §3). Several ranges collapse to
  // it first, keeping the stored marks (a Mod-b before composing still applies).
  const before = editor.state.selection
  if (before && before.ranges.length > 1) {
    const tr = editor.createTransaction()
    const marks = editor.state.storedMarks
    tr.setSelection(single(mainRange(before))).setStoredMarks(marks)
    tr.setMeta('origin', 'selection').setMeta('addToHistory', false)
    editor.dispatch(tr)
  }
  if (isNodeSelection(editor.state.selection)) {
    // The IME replaces the selected node: swap it for an empty default block holding the caret first.
    const tr = editor.createTransaction()
    if (replaceSelectedNode(tr, { text: '' })) {
      tr.setMeta('origin', 'input').setMeta('inputType', INPUT_TYPE)
      editor.dispatch(tr)
    }
  }
  // One range left (collapsed above): the main range, on purpose.
  const sel = editor.state.selection && mainRange(editor.state.selection)
  if (sel) {
    const state = editor.state
    const marks = state.storedMarks ?? (isCollapsed(sel) ? null : marksOfRange(state.doc, sel, editor.registry))
    compositionMarks.set(view, marks ?? marksAt(state))
  } else {
    compositionMarks.delete(view)
  }
  if (sel && !isCollapsed(sel)) {
    // The IME replaces the selection: delete it in the model first (the render collapses the DOM selection).
    const tr = editor.createTransaction()
    tr.deleteRange(toRange(sel)).setMeta('origin', 'input').setMeta('inputType', INPUT_TYPE)
    editor.dispatch(tr)
  }
  view.composing = true
  // The composition lands at the main range, on purpose (spec §3).
  const focus = editor.state.selection && mainRange(editor.state.selection).focus
  const leaf = focus && renderer.leafAt(focus.path)
  if (!focus || !leaf) return
  view.composition = { leaf, path: [...focus.path] }
  startSiblings.set(view, new Set(leaf.parentNode ? [...leaf.parentNode.childNodes] : []))
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
  compositionMarks.delete(view)
  startSiblings.delete(view)
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
  const known = startSiblings.get(view) ?? new Set()
  const after = strayText(leaf, 'previousSibling', known) + leafDomText(leaf) + strayText(leaf, 'nextSibling', known)
  if (after === before) return
  const { prefix, suffix } = commonEnds(before, after)
  const removed = before.slice(prefix, before.length - suffix)
  const inserted = after.slice(prefix, after.length - suffix)
  const tr = editor.createTransaction()
  const marks = compositionMarks.get(view)
  if (inserted && marks && !sameMarkSet(marks, node.marks as Mark[])) {
    // The composed text needs other marks than the composing text's (e.g. Mod-b before composing):
    // insert it like typed text, which splits the text and applies the marks.
    const start = { path, offset: prefix }
    tr.setStoredMarks(marks).insertText(inserted, { start, end: { path, offset: prefix + removed.length } })
  } else {
    if (removed) tr.apply({ type: 'remove_text', path, offset: prefix, text: removed })
    if (inserted) tr.apply({ type: 'insert_text', path, offset: prefix, text: inserted })
    const caret = { path, offset: prefix + inserted.length }
    tr.setSelection(single({ anchor: caret, focus: caret }))
  }
  tr.setMeta('origin', 'input').setMeta('inputType', INPUT_TYPE)
  editor.dispatch(tr)
}

/**
 * IME composition: the browser owns the composing leaf's DOM from `compositionstart` until
 * `compositionend` (or `blur`, if that never comes), then the leaf's text is diffed against the model.
 */
export const attachComposition: ViewModule = (view) => {
  view.listen(view.root, 'compositionstart', (e) => {
    if (!isIgnoredEvent(view, e)) onCompositionStart(view)
  })
  view.listen(view.root, 'compositionend', (e) => {
    if (!isIgnoredEvent(view, e)) onCompositionEnd(view)
  })
  view.listen(view.root, 'blur', () => onCompositionEnd(view))
  return () => {
    view.composing = false
    view.composition = null
  }
}
