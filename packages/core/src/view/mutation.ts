import { widgetAround } from './decorations'
import { isInIgnoredElement } from './ignore'
import type { EditorView, ViewModule } from './view'

/** Whether `record` is the IME's own change inside the composing leaf. */
function isComposingChange(view: EditorView, record: MutationRecord): boolean {
  const leaf = view.composing ? view.composition?.leaf : undefined
  return !!leaf && leaf.contains(record.target)
}

/** The node views' contentDOMs `record` added to the root, directly or inside an added subtree. */
function placedContentDOMs(view: EditorView, record: MutationRecord): globalThis.Node[] {
  const out: globalThis.Node[] = []
  for (const node of Array.from(record.addedNodes)) {
    if (node.nodeType !== 1 || !view.root.contains(node)) continue
    const candidates = [node, ...Array.from((node as Element).querySelectorAll('[data-hte-content]'))]
    for (const c of candidates) if (view.renderer.isContentDOM(c)) out.push(c)
  }
  return out
}

/** Whether every node `record` adds or removes is a node view's `contentDOM`. */
function movesContentDOM(view: EditorView, record: MutationRecord): boolean {
  const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
  return nodes.length > 0 && nodes.every((n) => view.renderer.isContentDOM(n))
}

/**
 * What to do with a record that is neither the renderer's own nor the IME's: `'ignore'` when its
 * target is no longer inside the root, inside a
 * `data-editor-ignore` element, inside a decoration widget (its content belongs to whoever rendered
 * it), only moving a node view's `contentDOM`, or inside a node view (outside its `contentDOM`) unless
 * its plugin's `ignoreMutation` returns false (then the id of the node view to rebuild); `'revert'`
 * anywhere else (inside a `contentDOM` included).
 */
function classify(view: EditorView, record: MutationRecord): 'ignore' | 'revert' | { rebuild: string } {
  // A target no longer inside the root was detached later in the same batch (e.g. a node view's
  // subtree replaced by a React portal update): the detaching record, if foreign, is judged itself.
  if (!view.root.contains(record.target)) return 'ignore'
  if (isComposingChange(view, record) || isInIgnoredElement(view, record.target)) return 'ignore'
  if (widgetAround(view.root, record.target)) return 'ignore'
  // A node view placing (moving) its contentDOM: the view's business, never reverted.
  if (record.type === 'childList' && movesContentDOM(view, record)) return 'ignore'
  // Inside a contentDOM, nodeViewAround is null: the record is judged as editor content.
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
    let placed = false
    for (const record of records) {
      // A node view placed its contentDOM after the render (e.g. a React portal commit), maybe
      // inside a subtree of its own.
      for (const node of placedContentDOMs(view, record)) {
        placed = true
        view.renderer.checkContentPlacement(node)
      }
      const action = classify(view, record)
      if (action === 'ignore') continue
      revert = true
      if (action !== 'revert') view.renderer.invalidateNodeView(action.rebuild)
    }
    // The update shows the selection; otherwise a newly placed contentDOM can now show it.
    if (revert) view.update(view.editor.state)
    else if (placed) view.refreshSelection()
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
