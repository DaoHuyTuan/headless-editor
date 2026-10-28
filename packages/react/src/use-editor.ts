import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Editor, type AnyPlugin, type EditorOptions, type NodeViewFactory } from '@hte/core'
import { createPortalStore, setPortalStore, toNodeViewFactory, type ReactNodeView } from './node-views'

export type UseEditorOptions<P extends readonly AnyPlugin[]> = Omit<EditorOptions<P>, 'nodeViews'> & {
  onUpdate?: (e: { editor: Editor<P> }) => void
  /** React components rendered as node views, keyed by (atom) node type. Read on the first render only. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodeViews?: Record<string, ReactNodeView<any, any>>
  /**
   * Plugin options kept in sync with the editor, keyed by plugin name. On every render each entry is
   * shallow-compared with the last value applied, and `editor.setPluginOptions(name, value)` is called
   * (in an effect) when it differs. The values given on the first render are applied at creation.
   * Options merge: a key dropped from a value keeps its last applied value.
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
  const [editor] = useState(() => {
    const { onUpdate: _onUpdate, nodeViews, pluginOptions, ...editorOptions } = options
    const store = createPortalStore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factories: Record<string, NodeViewFactory<any, any>> = {}
    for (const [type, Component] of Object.entries(nodeViews ?? {})) factories[type] = toNodeViewFactory(Component, store)
    const created = new Editor<P>({ ...editorOptions, nodeViews: factories } as EditorOptions<P>)
    for (const [name, value] of Object.entries(pluginOptions ?? {})) created.setPluginOptions(name, value)
    setPortalStore(created, store)
    return created
  })

  const onUpdateRef = useRef(options.onUpdate)
  useLayoutEffect(() => {
    onUpdateRef.current = options.onUpdate
  })

  const appliedOptions = useRef<Record<string, Record<string, unknown>> | null>(null)
  if (appliedOptions.current === null) {
    appliedOptions.current = Object.fromEntries(Object.entries(options.pluginOptions ?? {}).map(([k, v]) => [k, { ...v }]))
  }
  const pluginOptions = options.pluginOptions
  useEffect(() => {
    const applied = appliedOptions.current!
    for (const [name, value] of Object.entries(pluginOptions ?? {})) {
      if (shallowEqual(applied[name], value)) continue
      applied[name] = { ...value }
      editor.setPluginOptions(name, value)
    }
  })

  useEffect(
    () => editor.on('update', () => onUpdateRef.current?.({ editor })),
    [editor],
  )

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
