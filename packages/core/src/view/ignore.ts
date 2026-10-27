import type { EditorView } from './view'

/** Marks a subtree (typically inside a node view) that the editor leaves entirely to the page. */
export const IGNORE_ATTR = 'data-editor-ignore'

/** Whether `node` is inside (or is) an element with `data-editor-ignore`, below the root. */
export function isInIgnoredElement(view: EditorView, node: globalThis.Node | null): boolean {
  let cur: globalThis.Node | null = node
  while (cur && cur !== view.root) {
    if (cur.nodeType === 1 && (cur as Element).hasAttribute(IGNORE_ATTR)) return true
    cur = cur.parentNode
  }
  return false
}

/**
 * Whether the editor must leave an event at `target` alone (no handling, no `preventDefault`): the
 * target is inside a `data-editor-ignore` element within the root, or inside a node view whose
 * plugin's `stopEvent` claims `event`. Other events inside node views are handled as usual.
 */
export function isIgnoredTarget(view: EditorView, target: EventTarget | null, event?: Event): boolean {
  const node = target as globalThis.Node | null
  if (!node || typeof node.nodeType !== 'number' || node === view.root || !view.root.contains(node)) return false
  if (isInIgnoredElement(view, node)) return true
  if (!event) return false
  const container = view.renderer.nodeViewAround(node)
  const model = container && view.renderer.nodeOfElement(container)
  return !!model && view.editor.handleStopEvent(event, model)
}

/** `isIgnoredTarget` for an event's own target. */
export function isIgnoredEvent(view: EditorView, event: Event): boolean {
  return isIgnoredTarget(view, event.target, event)
}
