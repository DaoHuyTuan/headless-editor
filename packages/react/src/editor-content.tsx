import { useLayoutEffect, useRef, useSyncExternalStore, type HTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { AnyPlugin, Editor } from '@hte/core'
import { NodeViewScope } from './node-content'
import { getPortalStore, type PortalEntry, type PortalStore } from './node-views'

export type EditorContentProps = { editor: Editor<readonly AnyPlugin[]> } & HTMLAttributes<HTMLDivElement>

const NO_ENTRIES: readonly PortalEntry[] = []
const noStore: PortalStore = {
  add: () => {},
  update: () => {},
  remove: () => {},
  subscribe: () => () => {},
  getSnapshot: () => NO_ENTRIES,
  pendingOptions: new Map(),
}

/**
 * Renders the editor's root `<div>`; the editor mounts its view on it and owns its children. The
 * React node views (`useEditor`'s `nodeViews`) are rendered next to it as portals into the
 * containers the core creates inside the div; a non-atom view shows its content with `<NodeContent />`.
 * A view rendered in the same commit as a `pluginOptions` change already gets the new options.
 */
export function EditorContent({ editor, ...divProps }: EditorContentProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    editor.mount(el)
    return () => editor.unmount()
  }, [editor])
  const store = getPortalStore(editor) ?? noStore
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return (
    <>
      <div {...divProps} ref={ref} />
      {entries.map(({ id, container, Component, props }) =>
        createPortal(
          <NodeViewScope contentDOM={props.contentDOM} type={props.node.type} dev={editor.dev}>
            <Component {...props} options={store.pendingOptions.get(props.node.type) ?? props.options} />
          </NodeViewScope>,
          container,
          id,
        ),
      )}
    </>
  )
}
