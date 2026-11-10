import type { EditorView } from './view'

/**
 * Marks a subtree of a node view's own DOM (a control: an input, a select, a resize handle) that the
 * editor leaves entirely to the page. Honoured only inside a current node view's container, outside
 * its `contentDOM`; anywhere else in the root (editor content, widgets) it has no effect.
 */
export const IGNORE_ATTR = 'data-editor-ignore'

/**
 * Whether `node` is inside (or is) an element with `data-editor-ignore` that belongs to a current
 * node view's own DOM (inside its container, outside its `contentDOM`). A node view's `contentDOM`
 * is editor content: what is inside it is not ignored because of an ancestor of it, and neither is
 * anything outside node views.
 */
export function isInIgnoredElement(view: EditorView, node: globalThis.Node | null): boolean {
  let cur: globalThis.Node | null = node
  while (cur && cur !== view.root) {
    if (cur.nodeType === 1 && (cur as Element).hasAttribute(IGNORE_ATTR)) {
      // The closest node view around it, unless a contentDOM comes first (then it is content).
      return view.renderer.nodeViewAround(cur) !== null
    }
    if (view.renderer.isContentDOM(cur)) return false
    cur = cur.parentNode
  }
  return false
}

/**
 * Whether the editor must leave an event at `target` alone (no handling, no `preventDefault`): the
 * target is inside a `data-editor-ignore` element of a node view's own DOM, or inside a node view whose
 * plugin's `stopEvent` claims `event`. Other events inside node views, and every event inside a
 * node view's `contentDOM`, are handled as usual.
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
