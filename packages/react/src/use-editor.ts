import { useEffect, useInsertionEffect, useRef } from 'react'
import { Editor, type AnyPlugin, type EditorEvent, type EditorOptions, type NodeViewFactory, type NodeViewSpec } from '@penline/core'
import { createPortalStore, setPortalStore, toNodeViewSpec, type PortalStore, type ReactNodeView, type ReactNodeViewSpec } from './node-views'

export type UseEditorOptions<P extends readonly AnyPlugin[]> = Omit<EditorOptions<P>, 'nodeViews'> & {
  /**
   * Called once per doc-changing commit (the editor's `'update'` event), for the editor's whole life:
   * it is passed to the editor as `listeners.update`, so dispatches from a plugin's `onCreate` are
   * reported too (synchronously, while `useEditor` builds the editor during the first render; the
   * `editor` argument is then not returned yet), as are those from a child's layout effect or a
   * plugin's `onMount` during the first commit. The callback of the render being committed is the
   * one called. A `listeners.update` given as well is kept and runs first.
   */
  onUpdate?: (e: { editor: Editor<P> }) => void
  /**
   * React components rendered as node views, keyed by node type. Read on the first render only. A
   * `ReactNodeViewSpec` in place of a component also sets the tags of its container and `contentDOM`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeViews?: Record<string, ReactNodeView<any, any, any, any> | ReactNodeViewSpec<any, any, any, any>>
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
 * callback identity never recreates the editor. `listeners` (see `EditorOptions`) are registered
 * before the plugins' `onCreate` hooks run; `onUpdate` goes through them.
 *
 * The editor is built once, StrictMode included: it is created lazily in a ref, which React 19 keeps
 * across StrictMode's double render (a `useState` initializer would be called twice and build a
 * throwaway editor whose `onCreate` hooks ran). A render React discards before its first commit
 * (a suspended mount) still leaves its editor undestroyed, as with any render-time resource.
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

  // Created lazily in a ref rather than a `useState` initializer, which StrictMode calls twice (the
  // second call would build a throwaway editor, running its plugins' `onCreate`, never destroyed).
  // React 19 keeps the hooks of the first pass for StrictMode's second render, so this runs once.
  const created = useRef<{ editor: Editor<P>; store: PortalStore } | null>(null)
  if (created.current === null) {
    const { onUpdate: _onUpdate, nodeViews, pluginOptions, listeners, ...editorOptions } = options
    const store = createPortalStore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factories: Record<string, NodeViewFactory<any, any> | NodeViewSpec<any, any>> = {}
    for (const [type, view] of Object.entries(nodeViews ?? {})) factories[type] = toNodeViewSpec(view, store)
    // `onUpdate` is registered through `listeners`, before the plugins' `onCreate` hooks run, so their
    // dispatches are reported too, as are those of children's layout effects and `onMount` (run when
    // `EditorContent` mounts, in a layout effect), which come before this hook's effects. Once per
    // editor, so StrictMode's effect re-runs never subscribe twice; `destroy()` removes it.
    const userUpdate = listeners?.update
    const onUpdate = (e: EditorEvent) => {
      try {
        userUpdate?.(e)
      } finally {
        onUpdateRef.current?.({ editor: e.editor as unknown as Editor<P> })
      }
    }
    const editor = new Editor<P>({
      ...editorOptions,
      listeners: { ...listeners, update: onUpdate },
      nodeViews: factories,
    } as EditorOptions<P>)
    for (const [name, value] of Object.entries(pluginOptions ?? {})) editor.setPluginOptions(name, value)
    setPortalStore(editor, store)
    created.current = { editor, store }
  }
  const { editor, store } = created.current

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
        editor.destroy()
      }, 0)
    }
  }, [editor])

  return editor
}
