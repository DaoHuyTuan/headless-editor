import type { EditorView } from './view'

/**
 * Whether the focus, or failing that a DOM selection inside the root, counts as editor focus.
 * Internal to the view modules: not exported from the package.
 */
export function hasEditorFocus(view: EditorView): boolean {
  const doc = view.root.ownerDocument
  const active = doc.activeElement
  if (active && view.root.contains(active)) return true
  const anchor = doc.getSelection()?.anchorNode
  return !!anchor && view.root.contains(anchor)
}
