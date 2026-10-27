import type { EditorView, ViewModule } from './view'

/** Whether `record` is the IME's own change inside the composing leaf. */
function isComposingChange(view: EditorView, record: MutationRecord): boolean {
  const leaf = view.composing ? view.composition?.leaf : undefined
  return !!leaf && leaf.contains(record.target)
}

/**
 * Safety net for DOM changes the input pipeline did not prevent: any mutation that is neither the
 * renderer's own nor the IME's inside the composing leaf is reverted by re-rendering the doc from
 * the model (the renderer patches only what differs) and restoring the DOM selection.
 */
export const attachMutation: ViewModule = (view) => {
  const Observer = view.root.ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver
  if (typeof Observer !== 'function') return () => {}
  const observer = new Observer((records) => {
    if (view.renderer.rendering) return
    if (records.every((r) => isComposingChange(view, r))) return
    view.update(view.editor.state)
  })
  observer.observe(view.root, { characterData: true, childList: true, subtree: true })
  // The renderer's own patches are queued as records too: drop them as soon as it is done.
  const removeHook = view.renderer.onRendered(() => {
    observer.takeRecords()
  })
  return () => {
    removeHook()
    observer.disconnect()
  }
}
