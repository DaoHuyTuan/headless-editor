import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'

/** What a node view's subtree knows about its `contentDOM` (non-atom node views only). */
interface NodeContentContextValue {
  contentDOM: HTMLElement
  /** How many `<NodeContent />` are currently mounted in this view. */
  mounted: { count: number }
}

const NodeContentContext = createContext<NodeContentContextValue | null>(null)

function isDev(): boolean {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV
  return env !== 'production'
}

/**
 * Wraps one React node view: gives `<NodeContent />` the view's `contentDOM` and, in dev, warns
 * when a non-atom view committed without rendering it. Rendered by `EditorContent` in each portal.
 */
export function NodeViewScope({ contentDOM, type, children }: { contentDOM?: HTMLElement; type: string; children: ReactNode }) {
  const mounted = useRef({ count: 0 }).current
  const value = useMemo(() => (contentDOM ? { contentDOM, mounted } : null), [contentDOM, mounted])
  const warned = useRef(false)
  // After the first commit (passive effects run after every layout effect, NodeContent's included).
  useEffect(() => {
    if (!contentDOM || warned.current || mounted.count > 0 || !isDev()) return
    warned.current = true
    console.warn(
      `[hte] The node view of "${type}" rendered without <NodeContent />: its content is not shown. ` +
        'Render <NodeContent /> exactly once in a non-atom node view.',
    )
  }, [])
  return <NodeContentContext.Provider value={value}>{children}</NodeContentContext.Provider>
}

export interface NodeContentProps {
  /** The placeholder element (default `div`; use `span` in an inline node view). */
  as?: 'div' | 'span'
  className?: string
}

/**
 * Where a non-atom React node view shows its editable content: renders a placeholder and moves the
 * view's `contentDOM` (created and filled by the core) into it. Render it exactly once per node view.
 * The core owns `contentDOM`: unmounting only detaches it, and re-renders never move or recreate it.
 * Never render it inside a `contentEditable={false}` element: mark only its siblings (headers, labels)
 * non-editable, or the content becomes a separate editing host (the core warns).
 */
export function NodeContent({ as: Tag = 'div', className }: NodeContentProps) {
  const ctx = useContext(NodeContentContext)
  const ref = useRef<HTMLElement>(null)
  const contentDOM = ctx?.contentDOM
  useLayoutEffect(() => {
    const placeholder = ref.current
    if (!ctx || !contentDOM || !placeholder) return
    if (ctx.mounted.count > 0 && isDev()) {
      console.warn('[hte] <NodeContent /> is rendered more than once in a node view: only one shows the content.')
    }
    ctx.mounted.count++
    // StrictMode re-runs this effect right after its cleanup: the content is still in place then.
    if (contentDOM.parentNode !== placeholder) placeholder.appendChild(contentDOM)
    return () => {
      ctx.mounted.count--
      // Deferred, so a StrictMode re-mount (cleanup then effect, synchronously) keeps it in place:
      // detach only when no NodeContent took it back and it is still in this placeholder.
      queueMicrotask(() => {
        const unused = ctx.mounted.count === 0 || !placeholder.isConnected
        if (unused && contentDOM.parentNode === placeholder) placeholder.removeChild(contentDOM)
      })
    }
    // `Tag`: another tag is another placeholder element, which must take contentDOM.
  }, [ctx, contentDOM, Tag])
  // Outside a non-atom node view (no context) it renders an empty placeholder.
  return <Tag ref={ref as never} className={className} />
}
