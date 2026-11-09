import type { ComponentType } from 'react'
import type { AnyPlugin, Data, Editor, NodeViewFactory, NodeViewProps } from '@hte/core'

/**
 * A React component rendered as a node view (a non-atom one shows its content with
 * `<NodeContent />`). Type it from the plugin with `ComponentType<NodeViewPropsOf<typeof plugin>>`
 * to get typed `storage` and `state`.
 */
export type ReactNodeView<D = Data, O = unknown, T = unknown, S = unknown> = ComponentType<NodeViewProps<D, O, T, S>>

export interface PortalEntry {
  id: string
  container: HTMLElement
  Component: ReactNodeView<any, any, any, any>
  props: NodeViewProps<any, any, any, any>
}

/**
 * The live React node views of one editor, as an external store for `useSyncExternalStore`. Every
 * change replaces the snapshot array, and listeners are called synchronously: the core calls the
 * factories while rendering, which happens in `EditorContent`'s layout effect or in a dispatch, never
 * while React renders a component.
 */
export interface PortalStore {
  add(entry: PortalEntry): void
  /** Replaces the props of the entry `id` (no-op when it was removed). */
  update(id: string, props: NodeViewProps<any, any, any, any>): void
  /** Removes the entry `id` (no-op when there is none). */
  remove(id: string): void
  subscribe(onChange: () => void): () => void
  getSnapshot(): readonly PortalEntry[]
  /**
   * Options of node plugins (keyed by plugin name, which is the node type) that `useEditor` received
   * in the render being committed but has not applied to the editor yet (it does in an effect).
   * `EditorContent` renders the views with these in place of `props.options`, so no render shows the
   * old options; `useEditor` replaces the map on every render and drops an entry once applied.
   */
  pendingOptions: Map<string, Readonly<Record<string, unknown>>>
}

export function createPortalStore(): PortalStore {
  let entries: readonly PortalEntry[] = []
  const listeners = new Set<() => void>()
  const set = (next: readonly PortalEntry[]) => {
    entries = next
    for (const fn of [...listeners]) fn()
  }
  return {
    add: (entry) => set([...entries, entry]),
    update: (id, props) => {
      if (!entries.some((e) => e.id === id)) return
      set(entries.map((e) => (e.id === id ? { ...e, props } : e)))
    },
    remove: (id) => {
      if (!entries.some((e) => e.id === id)) return
      set(entries.filter((e) => e.id !== id))
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    getSnapshot: () => entries,
    pendingOptions: new Map(),
  }
}

let nextId = 0

/** A core node view factory that renders `Component` into its container through a portal of `store`. */
export function toNodeViewFactory<D = Data, O = unknown, T = unknown, S = unknown>(
  Component: ReactNodeView<D, O, T, S>,
  store: PortalStore,
): NodeViewFactory<D, O, T, S> {
  return (container, props) => {
    const id = `hte-node-view-${++nextId}`
    store.add({ id, container, Component: Component as ReactNodeView<any, any, any, any>, props })
    return {
      update: (p) => store.update(id, p),
      destroy: () => store.remove(id),
    }
  }
}

/** Keyed by editor instance (any plugin list). */
const stores = new WeakMap<object, PortalStore>()

/** Records the portal store of an editor created by `useEditor`, for `EditorContent`. */
export function setPortalStore(editor: object, store: PortalStore): void {
  stores.set(editor, store)
}

/** The portal store of `editor`, or undefined when it was not created by `useEditor`. */
export function getPortalStore(editor: Editor<readonly AnyPlugin[]>): PortalStore | undefined {
  return stores.get(editor)
}
