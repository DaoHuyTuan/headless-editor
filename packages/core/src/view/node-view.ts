import type { Editor } from '../editor'
import { deepEqualJson } from '../model/node'
import { findPathById } from '../model/find'
import type { Data, ElementNode, Path } from '../model/types'
import type { NodeViewFactory, NodeViewInstance, NodeViewProps } from '../plugin/types'

interface HostedView {
  instance: NodeViewInstance
  container: HTMLElement
  /** The props last given to the view (factory or `update`). */
  props: NodeViewProps
}

/**
 * The node views of one renderer, keyed by element id: creates each instance once, updates it when
 * its node's data, its selected state or its plugin's options change, and destroys it when the
 * element leaves the doc. Owned by the renderer, which creates the containers. A plugin state change
 * alone does not update a view: `props.state` is a getter that reads the current state.
 */
export class NodeViewHost {
  private readonly views = new Map<string, HostedView>()

  constructor(private readonly editor: Editor) {}

  has(id: string): boolean {
    return this.views.has(id)
  }

  /**
   * Calls `factory` for the element `node`, rendered into `container`; `contentDOM` (non-atom nodes)
   * is the element the renderer renders the children into, passed in every props.
   *
   * The view may place `contentDOM` in `container` during the factory call or later (e.g. a React
   * portal commit). While it is not placed, its leaves are detached: the model selection in them is
   * kept (the view snapshots the stale DOM selection after every render, so re-rendering a leaf while
   * detached does not let that DOM selection overwrite it) and shown once it is placed. In dev mode,
   * a view that still has not placed it after a macrotask (and is still current and connected) gets
   * one warning: its content is neither shown nor editable.
   */
  create(
    factory: NodeViewFactory,
    container: HTMLElement,
    node: ElementNode,
    selected: boolean,
    contentDOM?: HTMLElement,
  ): void {
    this.destroy(node.id)
    const props = this.props(node, selected, contentDOM)
    const instance = factory(container, props)
    this.views.set(node.id, { instance, container, props })
    if (this.editor.dev && contentDOM) this.checkPlaced(node, instance, container, contentDOM)
  }

  /** Dev mode: warns when the view of `node` has not placed `contentDOM` in `container` after a macrotask. */
  private checkPlaced(node: ElementNode, instance: NodeViewInstance, container: HTMLElement, contentDOM: HTMLElement): void {
    setTimeout(() => {
      const current = this.views.get(node.id)?.instance === instance
      if (!current || !container.isConnected || container.contains(contentDOM)) return
      console.warn(
        `[hte] The node view of "${node.type}" did not place its contentDOM in its container: its content is ` +
          'neither shown nor editable. Append props.contentDOM (a React node view renders <NodeContent /> exactly once).',
      )
    }, 0)
  }

  /**
   * Gives the view of `node` its current props when its data, its selected state or (with `force`,
   * after an options change) its options changed. Other node changes only refresh the node
   * reference kept for the next update.
   */
  update(node: ElementNode, selected: boolean, force: boolean): void {
    const view = this.views.get(node.id)
    if (!view) return
    const prev = view.props
    const changed =
      force || prev.selected !== selected || (prev.node !== node && !deepEqualJson(prev.node.data as Data, node.data))
    if (!changed) return
    view.props = this.props(node, selected, prev.contentDOM)
    view.instance.update(view.props)
  }

  /** Destroys the view of the element `id` (no-op when there is none). */
  destroy(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    this.views.delete(id)
    view.instance.destroy()
  }

  /** Destroys every view whose id is not in `keep`. */
  prune(keep: ReadonlySet<string>): void {
    for (const id of [...this.views.keys()]) if (!keep.has(id)) this.destroy(id)
  }

  destroyAll(): void {
    this.prune(new Set())
  }

  private props(node: ElementNode, selected: boolean, contentDOM: HTMLElement | undefined): NodeViewProps {
    const { editor } = this
    const id = node.id
    const type = node.type
    const getPos = (): Path | null => findPathById(editor.state.doc, id)
    return {
      ...(contentDOM ? { contentDOM } : {}),
      node,
      selected,
      editor,
      options: editor.getPluginOptions(type),
      storage: (editor.storage as Record<string, unknown>)[type],
      // Read on access: always the plugin's current state, even between updates.
      get state() {
        return editor.getPluginState(type)
      },
      getPos,
      updateData: (partial) => {
        const path = getPos()
        if (!path) return false
        const tr = editor.createTransaction()
        tr.setMeta('origin', 'command')
        tr.setNodeData(path, partial as Data)
        if (tr.rejected !== null) return false
        const before = editor.state
        editor.dispatch(tr)
        return editor.state !== before
      },
    }
  }
}
