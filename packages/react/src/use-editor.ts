import { useEffect, useInsertionEffect, useRef, useState } from 'react'
import { Editor, type AnyPlugin, type EditorOptions, type NodeViewFactory } from '@hte/core'
import { createPortalStore, setPortalStore, toNodeViewFactory, type PortalStore, type ReactNodeView } from './node-views'

export type UseEditorOptions<P extends readonly AnyPlugin[]> = Omit<EditorOptions<P>, 'nodeViews'> & {
  /**
   * Called once per doc-changing commit (the editor's `'update'` event), from the moment `useEditor`
   * returns the editor: dispatches from a child's layout effect or a plugin's `onMount` during the
   * first commit are included, and the callback of the render being committed is the one called.
   * Dispatches from a plugin's `onCreate` run inside the editor's constructor, before any listener
   * can exist, so they are not reported: read the initial state from the editor instead.
   */
  onUpdate?: (e: { editor: Editor<P> }) => void
  /** React components rendered as node views, keyed by (atom) node type. Read on the first render only. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeViews?: Record<string, ReactNodeView<any, any, any, any>>
  /**
   * Plugin options kept in sync with the editor, keyed by plugin name. On every render each entry is
   * shallow-compared with the last value applied, and `editor.setPluginOptions(name, value)` is called
   * (in an effect) when it differs. The values given on the first render are applied at creation.
   * Options merge: a key dropped from a value keeps its last applied value.
   * React node views rendered in the commit of a change already get the new (merged) options, so
   * none renders with the old ones; the editor itself (`getPluginOptions`, core-rendered DOM) has
   * them from the effect on.
   */
  pluginOptions?: Record<string, Record<string, unknown>>
}

function shallowEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  if (!a) return false
  const keys = Object.keys(b)
  if (keys.length !== Object.keys(a).length) return false
  return keys.every((k) => Object.prototype.hasOwnProperty.call(a, k) && Object.is(a[k], b[k]))
}

/**
 * Creates an editor once for the component's lifetime. Options are read only on the first render
 * (except `pluginOptions`, which are synced on every render); `onUpdate` is held in a ref, so a new
 * callback identity never recreates the editor.
 *
 * `nodeViews` components are rendered by `EditorContent` through portals into the containers the
 * core creates for their nodes.
 *
 * StrictMode-safe destruction: effect cleanup only *schedules* `destroy()` on the next tick, and the
 * effect's setup cancels any pending destroy. StrictMode's unmount → remount therefore keeps the
 * editor alive, while a real unmount destroys it.
 *
 * Limitation: `<Activity mode="hidden">` runs effect cleanups, so hiding the component destroys the
 * editor, and showing it again cannot remount a destroyed editor (followup).
 */
export function useEditor<const P extends readonly AnyPlugin[]>(options: UseEditorOptions<P>): Editor<P> {
  const onUpdateRef = useRef(options.onUpdate)
  // An insertion effect runs before every layout effect of the commit, so a dispatch from a child's
  // layout effect already calls this render's callback.
  useInsertionEffect(() => {
    onUpdateRef.current = options.onUpdate
  })

  // The unsubscribe goes with the editor it belongs to: StrictMode's second initializer call builds a
  // throwaway editor, which a ref written from the initializer would point at.
  const [[editor, unsubscribeUpdate, store]] = useState((): [Editor<P>, () => void, PortalStore] => {
    const { onUpdate: _onUpdate, nodeViews, pluginOptions, ...editorOptions } = options
    const store = createPortalStore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factories: Record<string, NodeViewFactory<any, any>> = {}
    for (const [type, Component] of Object.entries(nodeViews ?? {})) factories[type] = toNodeViewFactory(Component, store)
    const created = new Editor<P>({ ...editorOptions, nodeViews: factories } as EditorOptions<P>)
    for (const [name, value] of Object.entries(pluginOptions ?? {})) created.setPluginOptions(name, value)
    setPortalStore(created, store)
    // Subscribed at creation, not in an effect: dispatches from children's layout effects and from
    // `onMount` (run when `EditorContent` mounts, in a layout effect) come before this hook's effects.
    // Once per editor, so StrictMode's effect re-runs never subscribe twice; removed on destroy.
    const off = created.on('update', () => onUpdateRef.current?.({ editor: created }))
    return [created, off, store]
  })

  const appliedOptions = useRef<Record<string, Record<string, unknown>> | null>(null)
  if (appliedOptions.current === null) {
    appliedOptions.current = Object.fromEntries(Object.entries(options.pluginOptions ?? {}).map(([k, v]) => [k, { ...v }]))
  }
  const pluginOptions = options.pluginOptions
  // The node views rendered in this commit already see the options about to be applied (merged as
  // `setPluginOptions` will). Computed from this render's input only, so repeating it is harmless;
  // a render React discards leaves its entries only until the next render replaces the map.
  const pending = new Map<string, Readonly<Record<string, unknown>>>()
  for (const [name, value] of Object.entries(pluginOptions ?? {})) {
    if (shallowEqual(appliedOptions.current[name], value) || !editor.registry.node(name)) continue
    pending.set(name, Object.freeze({ ...editor.getPluginOptions(name), ...value }))
  }
  store.pendingOptions = pending
  useEffect(() => {
    const applied = appliedOptions.current!
    for (const [name, value] of Object.entries(pluginOptions ?? {})) {
      if (shallowEqual(applied[name], value)) continue
      applied[name] = { ...value }
      store.pendingOptions.delete(name)
      editor.setPluginOptions(name, value)
    }
  })

  const pendingDestroy = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (pendingDestroy.current !== null) {
      clearTimeout(pendingDestroy.current)
      pendingDestroy.current = null
    }
    return () => {
      pendingDestroy.current = setTimeout(() => {
        pendingDestroy.current = null
        unsubscribeUpdate()
        editor.destroy()
      }, 0)
    }
  }, [editor])

  return editor
}
