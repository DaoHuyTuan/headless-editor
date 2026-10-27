import { isInIgnoredElement } from './ignore'
import type { EditorView, ViewModule } from './view'

/** Whether `record` is the IME's own change inside the composing leaf. */
function isComposingChange(view: EditorView, record: MutationRecord): boolean {
  const leaf = view.composing ? view.composition?.leaf : undefined
  return !!leaf && leaf.contains(record.target)
}

/**
 * What to do with a record that is neither the renderer's own nor the IME's: `'ignore'` inside a
 * `data-editor-ignore` element, or inside a node view unless its plugin's `ignoreMutation` returns
 * false (then the id of the node view to rebuild); `'revert'` anywhere else.
 */
function classify(view: EditorView, record: MutationRecord): 'ignore' | 'revert' | { rebuild: string } {
  if (isComposingChange(view, record) || isInIgnoredElement(view, record.target)) return 'ignore'
  const container = view.renderer.nodeViewAround(record.target)
  const node = container && view.renderer.nodeOfElement(container)
  if (!node) return 'revert'
  return view.editor.handleIgnoreMutation(record, node) ? 'ignore' : { rebuild: node.id }
}

/**
 * Safety net for DOM changes the input pipeline did not prevent: any mutation that is neither the
 * renderer's own nor the IME's inside the composing leaf is reverted by re-rendering the doc from
 * the model (the renderer patches only what differs) and restoring the DOM selection. Node views
 * own their containers: changes there are ignored unless their plugin asks for a revert, which
 * rebuilds the node view; `data-editor-ignore` subtrees are always ignored.
 */
export const attachMutation: ViewModule = (view) => {
  const Observer = view.root.ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver
  if (typeof Observer !== 'function') return () => {}
  const observer = new Observer((records) => {
    if (view.renderer.rendering) return
    let revert = false
    for (const record of records) {
      const action = classify(view, record)
      if (action === 'ignore') continue
      revert = true
      if (action !== 'revert') view.renderer.invalidateNodeView(action.rebuild)
    }
    if (revert) view.update(view.editor.state)
  })
  observer.observe(view.root, {
    characterData: true,
    childList: true,
    subtree: true,
  })
  // The renderer's own patches are queued as records too: drop them as soon as it is done.
  const removeHook = view.renderer.onRendered(() => {
    observer.takeRecords()
  })
  return () => {
    removeHook()
    observer.disconnect()
  }
}
