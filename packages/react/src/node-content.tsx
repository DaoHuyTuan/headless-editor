import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'

/** What a node view's subtree knows about its view (every React node view, atoms included). */
interface NodeContentContextValue {
  /** The view's `contentDOM`; undefined in an atom node view. */
  contentDOM: HTMLElement | undefined
  /** The node type, for warnings. */
  type: string
  /** The editor's `dev` option: gates the warnings. */
  dev: boolean
  /** How many `<NodeContent />` are currently mounted in this view. */
  mounted: { count: number }
}

const NodeContentContext = createContext<NodeContentContextValue | null>(null)

/**
 * Dev mode for a `<NodeContent />` outside any node view, where there is no editor to ask: only an
 * explicit non-production `NODE_ENV`. A missing `process` (a browser bundle without a define) or a
 * missing `NODE_ENV` is not dev.
 */
function envIsDev(): boolean {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV
  return env !== undefined && env !== 'production'
}

/**
 * Wraps one React node view: gives `<NodeContent />` the view's `contentDOM`, its node type and the
 * editor's `dev` flag (the warnings follow it, not `NODE_ENV`). Rendered by `EditorContent` in each
 * portal. A non-atom view that never places its `contentDOM` (no `<NodeContent />`) is reported by
 * the core in dev mode.
 */
export function NodeViewScope({
  contentDOM,
  type,
  dev,
  children,
}: {
  contentDOM?: HTMLElement
  type: string
  dev: boolean
  children: ReactNode
}) {
  const mounted = useRef({ count: 0 }).current
  const value = useMemo(() => ({ contentDOM, type, dev, mounted }), [contentDOM, type, dev, mounted])
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
 *
 * Misuse renders an empty placeholder and warns once per instance: in an atom node view or a second
 * `<NodeContent />` of a view when the editor's `dev` option is on; outside any node view when
 * `NODE_ENV` is set and not `'production'` (there is no editor to ask).
 */
export function NodeContent({ as: Tag = 'div', className }: NodeContentProps) {
  const ctx = useContext(NodeContentContext)
  const ref = useRef<HTMLElement>(null)
  const warned = useRef(false)
  const contentDOM = ctx?.contentDOM
  useLayoutEffect(() => {
    if (warned.current || contentDOM) return
    if (ctx ? !ctx.dev : !envIsDev()) return
    warned.current = true
    console.warn(
      ctx
        ? `[penline] <NodeContent /> is rendered in the node view of "${ctx.type}", an atom: it has no content to show.`
        : '[penline] <NodeContent /> is rendered outside a node view: it shows nothing.',
    )
  }, [ctx, contentDOM])
  useLayoutEffect(() => {
    const placeholder = ref.current
    if (!ctx || !contentDOM || !placeholder) return
    if (ctx.mounted.count > 0 && ctx.dev && !warned.current) {
      warned.current = true
      console.warn('[penline] <NodeContent /> is rendered more than once in a node view: only one shows the content.')
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
  return <Tag ref={ref as never} className={className} />
}
