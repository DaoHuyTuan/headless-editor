import type { Editor } from '../editor'
import { checkAttrName, checkTag, checkVoidHole, isAttrs, markAttrs } from '../html/serialize'
import { deepEqualJson, isText, sameMarkSet } from '../model/node'
import type { DeepReadonly, Doc, ElementNode, Node, Path, TextNode } from '../model/types'
import { isOpaque } from '../model/editable'
import type { DOMOutputSpec, NodeViewFactory } from '../plugin/types'
import type { Registry } from '../plugin/registry'
import { NodeViewHost } from './node-view'
import {
  DECO_ATTR,
  WIDGET_ATTR,
  decorationSignature,
  groupDecorations,
  leafParts,
  pathKey,
  type Decoration,
  type LeafDecorations,
  type LeafPart,
} from './decorations'
import { ZW, ZW_ATTR } from './zero-width'

const ID_ATTR = 'data-hte-id'
const LEAF_ATTR = 'data-hte-leaf'
const NODE_VIEW_ATTR = 'data-hte-node-view'
const CONTENT_ATTR = 'data-hte-content'
const SELECTED_ATTR = 'data-hte-selected'

/**
 * The rendered DOM of one element (or of the root, for the doc). Children occupy the hole's
 * child nodes strictly between `before` and `anchor`; anything else there is swept on render.
 */
interface Holder {
  /** Where children are placed. */
  hole: HTMLElement
  /** Static spec node right before the hole, or null when the hole starts at the first child. */
  before: globalThis.Node | null
  /** Static spec node right after the hole (children are inserted before it), or null to append. */
  anchor: globalThis.Node | null
  /** Managed child DOM (element roots and leaf spans), in model order, as last rendered. */
  kids: HTMLElement[]
}

interface ElementEntry extends Holder {
  dom: HTMLElement
  node: ElementNode
  /** Unknown elements and atoms render no children. */
  rendersChildren: boolean
  /** The node view factory when `dom` is a node-view container. */
  nodeView?: NodeViewFactory
  /** A non-atom node view's content element: the hole, placed by the view inside `dom`. */
  contentDOM?: HTMLElement
}

interface HolePosition {
  hole: HTMLElement
  before: globalThis.Node | null
  anchor: globalThis.Node | null
}

export interface RenderOptions {
  /**
   * A leaf owned by composition. This render never changes its content and never removes it. It is
   * not moved, nor is the element child of its hole that holds it, while it sits in its hole between
   * the static `before` and `anchor` nodes: the other children are placed around it. The shells of
   * the elements around it are not rebuilt (a data change or `invalidate` is applied on the next
   * render without `skipLeaf`). It is still moved when it is not where it belongs: in another
   * parent, outside its hole's window, or when the text it shows moved to another parent, or when an
   * element around it is replaced (another type or id).
   */
  skipLeaf?: HTMLElement
  /**
   * The path, in the doc being rendered, of the text `skipLeaf` shows. When given, that text is
   * rendered by `skipLeaf` whatever its position. Otherwise `skipLeaf` keeps its positional slot
   * among its parent's leaves: when leaves before it come or go, another leaf can show the text it
   * shows (the text appears twice) until the next render without `skipLeaf`. Pass it while composing.
   */
  skipPath?: Path
  /** The path of the node-selected element: its root gets `data-hte-selected`, its node view `selected: true`. */
  selectedNode?: Path
  /** Decorations to draw (see `Decoration`); those not pointing into a text of the doc are dropped. */
  decorations?: readonly Decoration[]
}

interface RenderPass {
  next: Map<string, ElementEntry>
  skipLeaf?: HTMLElement
  skipPath?: Path
  selectedNode?: Path
  /** Ids whose shell (node view: instance) a previous render left as it was around its `skipLeaf`: rebuilt now. */
  forced: ReadonlySet<string>
  /** Decorations by text path (`pathKey`). */
  decorations: Map<string, LeafDecorations>
  /** Widget elements by key, as shown after this render. */
  widgets: Map<string, HTMLElement>
}

/** A leaf part with its widget element resolved. */
type ResolvedPart = Exclude<LeafPart, { kind: 'widget' }> | { kind: 'widget'; key: string; el: HTMLElement }

/**
 * Renders a document into a contenteditable root and patches it on later renders.
 *
 * DOM contract: each element's root is the first element produced by its `renderHTML` (a `<div>` /
 * `<span>` wrapper for block / inline types without one) carrying `data-hte-id`; children go into the
 * content hole. Each text is a `<span data-hte-leaf>` holding its marks nested by rank (lowest
 * outermost) around the DOM text, or `<br data-hte-break>` when empty. An empty text next to an element
 * sibling (e.g. beside an inline atom) shows a zero-width space instead, and its leaf carries
 * `data-hte-zw`: that character is not model text. The last text of an element ending with `\n` gets a
 * `<br data-hte-break>` after its text, so the empty line after that newline shows and takes the
 * caret (the break is not model text). Decorations split a leaf's text inside its mark
 * wrappers: decorated segments are `<span data-hte-deco …attrs>`, widgets sit between segments
 * (`contenteditable="false"`, `data-hte-widget`, reused by key); a leaf is kept while its text, marks
 * and decoration signature are unchanged and its DOM is intact. Unknown elements render as an empty
 * `<div data-hte-id data-hte-unknown="<type>" contenteditable="false">`; inline atoms' roots get
 * `contenteditable="false"` too. A node view's root is a container (`data-hte-node-view`) whose
 * content is the view's: an atom's is `contenteditable="false"`; a non-atom's children go into its
 * `contentDOM` (`data-hte-content contenteditable="true"`, the whole hole), which the view places.
 *
 * Patching is keyed by element id: an element's DOM is reused while its id stays in the doc, and its
 * own root is re-rendered only when its type or data changes (or its spec DOM was damaged). Text
 * leaves are reconciled by position within their parent. Nodes the renderer did not create (in the
 * root, in holes, inside leaves) are removed or corrected. Assumes element ids are unique in the doc.
 */
export class Renderer {
  private readonly doc: Document
  private readonly rootHolder: Holder
  private byId = new Map<string, ElementEntry>()
  private readonly byDom = new WeakMap<Element, ElementEntry>()
  /** Node-view entries by their `contentDOM`. */
  private readonly byContent = new WeakMap<Element, ElementEntry>()
  /** contentDOMs already warned about by `checkContentPlacement`. */
  private readonly warnedContent = new WeakSet<Element>()
  /** The text each leaf span currently shows; missing when unknown (skipped while the model moved on). */
  private readonly leafText = new WeakMap<Element, TextNode>()
  /** The decoration signature each leaf span was last rendered with (see `decorationSignature`). */
  private readonly leafDecos = new WeakMap<Element, string>()
  /** The parts (widgets resolved) each leaf span was last rendered with: an unchanged leaf is checked against them. */
  private readonly leafShape = new WeakMap<Element, ResolvedPart[]>()
  /** Widget elements by key, as last rendered: a widget decorated again with the same key reuses its element. */
  private widgets = new Map<string, HTMLElement>()
  /** Widget elements rendered for a key another widget already held in that render (not keyed). */
  private readonly duplicateWidgets = new WeakSet<HTMLElement>()
  /** Element types whose shells are rebuilt (node views: updated) on the next render. */
  private readonly invalidated = new Set<string>()
  /** Mark types whose leaves are re-rendered on the next render. */
  private readonly invalidatedMarks = new Set<string>()
  /** Ids of node views rebuilt (new container, new instance) on the next render. */
  private readonly rebuildViews = new Set<string>()
  /** Ids whose rebuild was deferred because their DOM holds the composing leaf (see `RenderOptions.skipLeaf`). */
  private readonly deferred = new Set<string>()
  private readonly nodeViews: NodeViewHost
  private lastDoc: DeepReadonly<Doc> = { type: 'doc', children: [] }
  private _rendering = false
  /** Run synchronously at the end of every render (the mutation observer drops the records of our own patches). */
  private readonly renderedHooks = new Set<() => void>()

  constructor(
    /** The contenteditable root the document renders into. */
    readonly root: HTMLElement,
    private readonly editor: Editor,
  ) {
    this.doc = root.ownerDocument
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('role', 'textbox')
    root.setAttribute('aria-multiline', 'true')
    root.style.whiteSpace = 'pre-wrap'
    this.rootHolder = { hole: root, before: null, anchor: null, kids: [] }
    this.nodeViews = new NodeViewHost(editor)
  }

  /**
   * Renders `doc`. When it throws (a plugin's `renderHTML`, a mark's `render`, a node view factory),
   * the DOM is left partly patched: the elements this render already built stay known (by id, so
   * the next render reuses or replaces them) and pending invalidations are kept for the next render.
   */
  render(doc: DeepReadonly<Doc>, opts: RenderOptions = {}): void {
    const forced = new Set(this.deferred)
    this.deferred.clear()
    const pass: RenderPass = {
      next: new Map(),
      skipLeaf: opts.skipLeaf,
      skipPath: opts.skipPath,
      selectedNode: opts.selectedNode,
      forced,
      decorations: groupDecorations(doc, opts.decorations ?? []),
      widgets: new Map(),
    }
    // The composing leaf keeps its DOM, widgets included: keep their keys.
    if (opts.skipLeaf) {
      for (const [key, el] of this.widgets) if (opts.skipLeaf.contains(el)) pass.widgets.set(key, el)
    }
    this._rendering = true
    let done = false
    try {
      // Read-only: the renderer keeps references to the nodes but never changes them.
      this.reconcile(this.rootHolder, (doc as Doc).children, [], pass)
      this.byId = pass.next
      this.widgets = pass.widgets
      this.lastDoc = doc
      // Destroy the node views whose element left the doc (or is no longer shown by a node view).
      const live = new Set<string>()
      for (const [id, entry] of pass.next) if (entry.nodeView) live.add(id)
      this.nodeViews.prune(live)
      done = true
    } finally {
      this._rendering = false
      if (done) {
        this.invalidated.clear()
        this.invalidatedMarks.clear()
        this.rebuildViews.clear()
      } else {
        // What this render built replaces what it replaced (shells, node views, widgets); the rest
        // is kept as last rendered. The invalidations and deferred rebuilds stay pending.
        this.byId = new Map([...this.byId, ...pass.next])
        this.widgets = new Map([...this.widgets, ...pass.widgets])
        for (const id of forced) this.deferred.add(id)
      }
      for (const hook of [...this.renderedHooks]) hook()
    }
  }

  /**
   * Rebuilds the shell of every element of `type` on the next render; their children's DOM is
   * reused. Node views of `type` keep their container and get `update` with fresh options instead.
   */
  invalidate(type: string): void {
    this.invalidated.add(type)
  }

  /** Re-renders, on the next render, every text leaf that carries a mark of `type` (after its plugin's options changed). */
  invalidateMark(type: string): void {
    this.invalidatedMarks.add(type)
  }

  /** Rebuilds the node view of the element `id` on the next render: a new container and a new instance. */
  invalidateNodeView(id: string): void {
    this.rebuildViews.add(id)
  }

  /** Destroys every node view (the rendered DOM stays). */
  destroy(): void {
    this.nodeViews.destroyAll()
  }

  /** The doc of the last render. */
  get renderedDoc(): DeepReadonly<Doc> {
    return this.lastDoc
  }

  get registry(): Registry {
    return this.editor.registry
  }

  /** The current model node of a rendered element root, or null when `dom` is not one. */
  nodeOfElement(dom: Element): ElementNode | null {
    const entry = this.byDom.get(dom)
    return entry && this.byId.get(entry.node.id) === entry ? entry.node : null
  }

  /**
   * Warns (once per contentDOM) when a node view placed its `contentDOM` below a
   * `contenteditable="false"` element of its container: that makes it a separate editing host, which
   * the caret, selection extension and select-all do not cross. Only the view's own DOM beside the
   * path to `contentDOM` (headers, controls) may be non-editable.
   */
  checkContentPlacement(contentDOM: globalThis.Node): void {
    // A dev-only warning, like the other node-view misuse warnings.
    if (!this.editor.dev) return
    const entry = this.byContent.get(contentDOM as Element)
    if (!entry || this.warnedContent.has(contentDOM as Element)) return
    for (let cur = contentDOM.parentNode; cur && cur !== entry.dom; cur = cur.parentNode) {
      if (cur.nodeType === 1 && (cur as Element).getAttribute('contenteditable') === 'false') {
        this.warnedContent.add(contentDOM as Element)
        console.warn(
          `[hte] The node view of "${entry.node.type}" placed its contentDOM inside a contenteditable="false" ` +
            'element: mark only the elements beside contentDOM (headers, controls) as non-editable, never an ancestor.',
        )
        return
      }
    }
  }

  /** Whether `node` is the `contentDOM` of a current non-atom node view. */
  isContentDOM(node: globalThis.Node): boolean {
    if (node.nodeType !== 1 || !(node as Element).hasAttribute(CONTENT_ATTR)) return false
    const entry = this.byContent.get(node as Element)
    return !!entry && this.byId.get(entry.node.id) === entry
  }

  /**
   * The closest current node-view container that is or contains `node` (within the root), or null.
   * Null too when `node` is inside that view's `contentDOM` (or a nested one): that is editor content.
   */
  nodeViewAround(node: globalThis.Node): HTMLElement | null {
    let cur: globalThis.Node | null = node
    while (cur && cur !== this.root) {
      if (this.isContentDOM(cur)) return null
      if (cur.nodeType === 1 && (cur as Element).hasAttribute(NODE_VIEW_ATTR)) {
        const entry = this.byDom.get(cur as Element)
        if (entry?.nodeView && this.byId.get(entry.node.id) === entry) return cur as HTMLElement
      }
      cur = cur.parentNode
    }
    return null
  }

  /**
   * The path of the opaque block (atom or unknown type) whose rendered root is `dom`, or null.
   * Inline opaque elements are never node-selected.
   */
  opaqueBlockPath(dom: Element): Path | null {
    const node = this.nodeOfElement(dom)
    if (!node || !isOpaque(node, this.editor.registry)) return null
    if (this.editor.registry.node(node.type)?.kind === 'inline') return null
    return this.pathOf(dom)
  }

  /** True while `render` patches the DOM: mutations made then are the renderer's own. */
  get rendering(): boolean {
    return this._rendering
  }

  /** Runs `fn` synchronously at the end of every render; returns its remover. */
  onRendered(fn: () => void): () => void {
    this.renderedHooks.add(fn)
    return () => {
      this.renderedHooks.delete(fn)
    }
  }

  /** The `<span data-hte-leaf>` rendered for the text at `path`. */
  leafAt(path: Path): HTMLElement | null {
    const dom = this.domAt(path)
    return dom && this.isLeaf(dom) ? dom : null
  }

  /**
   * Whether the text at `path` is rendered by a leaf that is not inside the root: its node view has
   * not placed its `contentDOM` (yet). `leafAt` returns null for such a leaf.
   */
  isLeafDetached(path: Path): boolean {
    const dom = this.domAt(path)
    return !!dom && dom.hasAttribute(LEAF_ATTR) && !this.root.contains(dom)
  }

  /** The element root rendered for the element at `path`. */
  elementAt(path: Path): HTMLElement | null {
    const dom = this.domAt(path)
    return dom && !this.isLeaf(dom) ? dom : null
  }

  /** The path of a rendered leaf span, or null when `leaf` is not one. */
  pathOfLeaf(leaf: Element): Path | null {
    if (!this.isLeaf(leaf)) return null
    return this.pathOf(leaf)
  }

  // --- internals ---

  private isLeaf(dom: Element): boolean {
    return dom.hasAttribute(LEAF_ATTR) && this.leafOwner(dom) !== null
  }

  /** The holder whose kids include `dom`, found via its closest rendered element ancestor. */
  private leafOwner(dom: Element): Holder | null {
    const holder = this.holderAround(dom)
    return holder && holder.kids.includes(dom as HTMLElement) ? holder : null
  }

  private holderAround(dom: Element): Holder | null {
    let cur = dom.parentElement
    while (cur) {
      if (cur === this.root) return this.rootHolder
      if (cur.hasAttribute(ID_ATTR)) {
        const entry = this.byDom.get(cur)
        return entry && this.byId.get(entry.node.id) === entry ? entry : null
      }
      cur = cur.parentElement
    }
    return null
  }

  private pathOf(dom: Element): Path | null {
    const path: number[] = []
    let cur: Element = dom
    for (;;) {
      const holder = this.holderAround(cur)
      if (!holder) return null
      const index = holder.kids.indexOf(cur as HTMLElement)
      if (index < 0) return null
      path.unshift(index)
      if (holder === this.rootHolder) return path
      cur = (holder as ElementEntry).dom
    }
  }

  private domAt(path: Path): HTMLElement | null {
    if (path.length === 0) return null
    let holder: Holder = this.rootHolder
    for (let i = 0; i < path.length; i++) {
      const dom = holder.kids[path[i]!]
      if (!dom) return null
      if (i === path.length - 1) return dom
      const entry = this.byDom.get(dom)
      if (!entry) return null
      holder = entry
    }
    return null
  }

  /** Brings `holder`'s children in line with `children`, reusing DOM by id (elements) or position (leaves). */
  private reconcile(holder: Holder, children: Node[], path: Path, pass: RenderPass): void {
    const { skipLeaf, skipPath } = pass
    // With a skipPath, skipLeaf is pinned to that text and leaves the positional pool.
    const pinned = skipLeaf !== undefined && skipPath !== undefined
    const oldLeaves = holder.kids.filter((k) => k.hasAttribute(LEAF_ATTR) && !(pinned && k === skipLeaf))
    let leafIndex = 0
    const kids: HTMLElement[] = []
    children.forEach((child, i) => {
      const childPath = [...path, i]
      if (!isText(child)) {
        kids.push(this.element(child, childPath, pass))
      } else if (pinned && samePath(childPath, skipPath)) {
        this.leafText.delete(skipLeaf)
        kids.push(skipLeaf)
      } else {
        const zw = child.text === '' && [children[i - 1], children[i + 1]].some((n) => n !== undefined && !isText(n))
        // The last text of its parent ending with a newline: browsers show no line after that newline
        // (and cannot put the caret there) unless something follows it, so the leaf ends with a break.
        const trailingBreak = i === children.length - 1 && child.text.endsWith('\n')
        kids.push(this.leaf(oldLeaves[leafIndex++], child, zw, trailingBreak, childPath, pass))
      }
    })

    const { hole, anchor } = holder
    // Composition owns skipLeaf: the kid that is or holds it stays where it is when that is inside the
    // hole's window, and the other kids are placed around it.
    const fixed = skipLeaf ? kids.find((k) => k === skipLeaf || k.contains(skipLeaf)) : undefined
    const stay = fixed !== undefined && inWindow(holder, fixed) ? fixed : undefined
    let ref = anchor
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!
      if (kid === stay) {
        ref = kid
        continue
      }
      if (kid.parentNode !== hole || kid.nextSibling !== ref) hole.insertBefore(kid, ref)
      ref = kid
    }

    // Sweep the hole: drop everything between `before` and `anchor` that is not a current kid
    // (old kids, pre-existing content, nodes the browser inserted), except skipLeaf.
    const keep = new Set<globalThis.Node>(kids)
    let cur = holder.before ? holder.before.nextSibling : hole.firstChild
    while (cur && cur !== anchor) {
      const nextSibling = cur.nextSibling
      if (!keep.has(cur) && cur !== skipLeaf) cur.remove()
      cur = nextSibling
    }
    holder.kids = kids
  }

  private element(node: ElementNode, path: Path, pass: RenderPass): HTMLElement {
    const { next } = pass
    const duplicate = next.has(node.id)
    const prev = duplicate ? undefined : this.byId.get(node.id)
    const selected = pass.selectedNode !== undefined && samePath(path, pass.selectedNode)
    let entry: ElementEntry
    const forced = pass.forced.has(node.id)
    const keepView = prev?.nodeView && prev.node.type === node.type && !this.rebuildViews.has(node.id) && !forced
    if (keepView && this.nodeViews.has(node.id)) {
      // A node view keeps its container: data, selection and option changes go through `update`.
      entry = prev
      entry.node = node
      this.nodeViews.update(node, selected, this.invalidated.has(node.type))
    } else if (
      prev &&
      !prev.nodeView &&
      !forced &&
      this.shellIntact(prev) &&
      !this.invalidated.has(node.type) &&
      (prev.node === node || (prev.node.type === node.type && deepEqualJson(prev.node.data, node.data)))
    ) {
      entry = prev
      entry.node = node
    } else if (
      prev &&
      pass.skipLeaf &&
      prev.node.type === node.type &&
      prev.dom.contains(pass.skipLeaf) &&
      this.shellIntact(prev) &&
      (!prev.nodeView || this.nodeViews.has(node.id))
    ) {
      // Rebuilding would move the composing leaf into a new shell: keep this one until the next render.
      entry = prev
      entry.node = node
      this.deferred.add(node.id)
      if (prev.nodeView) this.nodeViews.update(node, selected, false)
    } else {
      entry = this.shell(node)
      // Keep the old children's DOM so they are moved into the new shell, not recreated.
      if (prev && entry.rendersChildren) entry.kids = prev.kids
      this.byDom.set(entry.dom, entry)
      if (entry.contentDOM) this.byContent.set(entry.contentDOM, entry)
      if (prev?.nodeView) this.nodeViews.destroy(node.id)
      // Views are keyed by id: a duplicate id gets a container showing only its content.
      if (entry.nodeView && !duplicate) {
        this.nodeViews.create(entry.nodeView, entry.dom, node, selected, entry.contentDOM)
        // Placed by the factory itself (a later placement is checked by the mutation module).
        if (entry.contentDOM?.parentNode) this.checkContentPlacement(entry.contentDOM)
      } else if (entry.contentDOM) {
        entry.dom.appendChild(entry.contentDOM)
      }
    }
    if (selected) entry.dom.setAttribute(SELECTED_ATTR, '')
    else if (entry.dom.hasAttribute(SELECTED_ATTR)) entry.dom.removeAttribute(SELECTED_ATTR)
    // Duplicate ids get fresh DOM and are not keyed.
    if (!duplicate) next.set(node.id, entry)
    if (entry.rendersChildren) this.reconcile(entry, node.children ?? [], path, pass)
    return entry.dom
  }

  /** Whether the hole and its static boundary nodes are still where the spec put them. */
  private shellIntact(entry: ElementEntry): boolean {
    const { dom, hole, before, anchor } = entry
    if (hole !== dom && !dom.contains(hole)) return false
    return (!before || before.parentNode === hole) && (!anchor || anchor.parentNode === hole)
  }

  /** Builds an element's own root and content hole (no children). */
  private shell(node: ElementNode): ElementEntry {
    const registered = this.editor.registry.node(node.type)
    if (!registered) {
      const dom = this.doc.createElement('div')
      dom.setAttribute(ID_ATTR, node.id)
      dom.setAttribute('data-hte-unknown', node.type)
      dom.setAttribute('contenteditable', 'false')
      return { dom, node, hole: dom, before: null, anchor: null, kids: [], rendersChildren: false }
    }
    const nodeView = this.editor.nodeViewFactory(node.type)
    if (nodeView) {
      // The view owns the container's content; the renderer only manages a non-atom's contentDOM,
      // which the view places somewhere inside it.
      const tag = registered.kind === 'inline' ? 'span' : 'div'
      const dom = this.doc.createElement(tag)
      dom.setAttribute(ID_ATTR, node.id)
      dom.setAttribute(NODE_VIEW_ATTR, '')
      if (registered.atom) {
        dom.setAttribute('contenteditable', 'false')
        return { dom, node, hole: dom, before: null, anchor: null, kids: [], rendersChildren: false, nodeView }
      }
      const contentDOM = this.doc.createElement(tag)
      contentDOM.setAttribute(CONTENT_ATTR, '')
      contentDOM.setAttribute('contenteditable', 'true')
      return { dom, node, hole: contentDOM, before: null, anchor: null, kids: [], rendersChildren: true, nodeView, contentDOM }
    }
    const render = registered.plugin.spec.renderHTML
    const spec = render?.(node, { options: this.editor.getPluginOptions(registered.plugin.name) })
    let dom: HTMLElement
    let position: HolePosition | null = null
    if (Array.isArray(spec)) {
      const built = this.buildSpec(spec)
      dom = built.dom as HTMLElement
      position = built.hole
    } else if (spec === undefined || spec === 0) {
      dom = this.doc.createElement(registered.kind === 'inline' ? 'span' : 'div')
    } else {
      throw new Error(`renderHTML for "${node.type}" must return an element spec`)
    }
    dom.setAttribute(ID_ATTR, node.id)
    // An inline atom is one character: the user never edits inside it.
    if (registered.atom && registered.kind === 'inline') dom.setAttribute('contenteditable', 'false')
    // Without a hole, children are appended after the spec's own content.
    const fallback: HolePosition = { hole: dom, before: dom.lastChild, anchor: null }
    return {
      dom,
      node,
      ...(position ?? fallback),
      kids: [],
      rendersChildren: !registered.atom || position !== null,
    }
  }

  /** Builds DOM for a spec; records the first content hole with the static nodes around it. */
  private buildSpec(spec: DOMOutputSpec): { dom: globalThis.Node; hole: HolePosition | null } {
    if (typeof spec === 'string') return { dom: this.doc.createTextNode(spec), hole: null }
    if (spec === 0) throw new Error('Content hole `0` must be inside an element')
    const [rawTag, maybeAttrs, ...rest] = spec
    const el = this.doc.createElement(checkTag(rawTag))
    let children: DOMOutputSpec[] = rest
    if (isAttrs(maybeAttrs)) {
      for (const [name, value] of Object.entries(maybeAttrs)) {
        checkAttrName(name)
        if (value !== undefined) el.setAttribute(name, String(value))
      }
    } else if (maybeAttrs !== undefined) {
      children = [maybeAttrs, ...rest]
    }
    checkVoidHole(rawTag, children)
    let hole: HolePosition | null = null
    let pending: HolePosition | null = null
    for (const child of children) {
      if (child === 0) {
        if (!hole && !pending) pending = { hole: el, before: el.lastChild, anchor: null }
        continue
      }
      const built = this.buildSpec(child)
      el.appendChild(built.dom)
      if (pending) {
        hole = { ...pending, anchor: built.dom }
        pending = null
      }
      if (!hole && built.hole) hole = built.hole
    }
    if (pending) hole = pending
    return { dom: el, hole }
  }

  private leaf(
    old: HTMLElement | undefined,
    text: TextNode,
    zw: boolean,
    trailingBreak: boolean,
    path: Path,
    pass: RenderPass,
  ): HTMLElement {
    if (old && old === pass.skipLeaf) {
      // Composition owns this leaf's DOM; forget what it shows so a later render checks it again.
      this.leafText.delete(old)
      return old
    }
    const decos = pass.decorations.get(pathKey(path))
    // The trailing break is in the signature: the same text gains or loses it as later siblings come and go.
    const signature = decorationSignature(decos) + (trailingBreak ? '|br' : '')
    const shown = old && this.leafText.get(old)
    const stale = this.invalidatedMarks.size > 0 && text.marks.some((m) => this.invalidatedMarks.has(m.type))
    if (
      old &&
      shown &&
      !stale &&
      shown.text === text.text &&
      sameMarkSet(shown.marks, text.marks) &&
      (this.leafDecos.get(old) ?? '') === signature
    ) {
      // Same text, marks and decorations: the parts are those last rendered (no re-segmenting).
      const cached = this.leafShape.get(old)
      if (cached && this.claimWidgets(cached, pass) && this.leafIntact(old, text, zw, cached)) {
        this.leafText.set(old, text)
        return old
      }
    }
    const parts = this.resolveParts(text, zw, decos, pass)
    if (trailingBreak) parts.push({ kind: 'break' })
    const leaf = old ?? this.doc.createElement('span')
    if (!old) leaf.setAttribute(LEAF_ATTR, '')
    if (zw) leaf.setAttribute(ZW_ATTR, '')
    else if (leaf.hasAttribute(ZW_ATTR)) leaf.removeAttribute(ZW_ATTR)
    const content = this.leafContent(text, parts)
    const same =
      old !== undefined &&
      leaf.childNodes.length === content.length &&
      content.every((n, i) => n === leaf.childNodes[i] || leaf.childNodes[i]!.isEqualNode(n))
    // Same shape with other text (typing): the old Text nodes take the new data, so the DOM caret
    // and an IME composition in them survive. Anything else is rebuilt.
    if (!same && !(old !== undefined && sameShapes(leaf.childNodes, content) && patchTexts(leaf.childNodes, content)))
      leaf.replaceChildren(...content)
    this.leafText.set(leaf, text)
    this.leafDecos.set(leaf, signature)
    this.leafShape.set(leaf, parts)
    return leaf
  }

  /**
   * Keeps the widgets of a reused leaf under their keys for this render (a duplicate-key widget is
   * kept as it is, not keyed). False (nothing claimed) when a key was already taken by another
   * element in this render and the leaf's widget was keyed: the leaf is then rebuilt.
   */
  private claimWidgets(parts: ResolvedPart[], pass: RenderPass): boolean {
    for (const part of parts) {
      if (part.kind !== 'widget') continue
      const taken = pass.widgets.get(part.key)
      if (taken && taken !== part.el && !this.duplicateWidgets.has(part.el)) return false
    }
    for (const part of parts) if (part.kind === 'widget' && !pass.widgets.has(part.key)) pass.widgets.set(part.key, part.el)
    return true
  }

  /**
   * The parts of a leaf inside its marks (see `leafParts`), with each widget's element: the one
   * last rendered for its key (unless another leaf already took that key in this render), else a new one.
   */
  private resolveParts(text: TextNode, zw: boolean, decos: LeafDecorations | undefined, pass: RenderPass): ResolvedPart[] {
    const empty: LeafPart | null = zw ? { kind: 'text', text: ZW } : text.text === '' ? { kind: 'break' } : null
    return leafParts(text.text, decos, empty).map((part): ResolvedPart => {
      if (part.kind !== 'widget') return part
      const taken = pass.widgets.has(part.key)
      let el = taken ? undefined : this.widgets.get(part.key)
      if (!el) {
        el = part.render(this.doc)
        el.setAttribute(WIDGET_ATTR, '')
        el.setAttribute('contenteditable', 'false')
      }
      // A duplicate key gets its own element, not keyed (kept while its leaf is unchanged).
      if (!taken) pass.widgets.set(part.key, el)
      else this.duplicateWidgets.add(el)
      return { kind: 'widget', key: part.key, el }
    })
  }

  /**
   * Cheap check that a leaf still has the shape we rendered: a single-child chain with one wrapper
   * per known mark, holding the parts in order (texts, decoration spans around their text, widget
   * elements, the break). Decoration spans must carry exactly their attributes; attributes on mark
   * wrappers are not compared.
   */
  private leafIntact(leaf: HTMLElement, text: TextNode, zw: boolean, parts: ResolvedPart[]): boolean {
    if (leaf.hasAttribute(ZW_ATTR) !== zw) return false
    const markCount = text.marks.filter((m) => this.editor.registry.mark(m.type)).length
    let inner: globalThis.Node = leaf
    for (let depth = 0; depth < markCount; depth++) {
      if (inner.childNodes.length !== 1) return false
      inner = inner.firstChild!
      if (inner.nodeType !== 1) return false
    }
    const nodes = inner.childNodes
    if (nodes.length !== parts.length) return false
    return parts.every((part, i) => {
      const node = nodes[i]!
      if (part.kind === 'widget') return node === part.el
      if (part.kind === 'break') return node.nodeName === 'BR' && (node as Element).hasAttribute('data-hte-break')
      if (!part.attrs) return node.nodeType === 3 && (node as Text).data === part.text
      if (node.nodeType !== 1 || !(node as Element).hasAttribute(DECO_ATTR) || node.childNodes.length !== 1) return false
      const span = node as Element
      const names = Object.keys(part.attrs)
      if (span.attributes.length !== names.length + 1 || names.some((n) => span.getAttribute(n) !== part.attrs![n])) return false
      const inside = node.firstChild!
      return inside.nodeType === 3 && (inside as Text).data === part.text
    })
  }

  /**
   * The leaf's content: mark wrappers nested by rank (lowest outermost) around its parts — the text
   * (decorated segments in `<span data-hte-deco>`), widgets, or the break / `ZW` when empty.
   */
  private leafContent(text: TextNode, parts: ResolvedPart[]): globalThis.Node[] {
    const inner = parts.map((part): globalThis.Node => {
      if (part.kind === 'widget') return part.el
      if (part.kind === 'break') {
        const br = this.doc.createElement('br')
        br.setAttribute('data-hte-break', '')
        return br
      }
      const textNode = this.doc.createTextNode(part.text)
      if (!part.attrs) return textNode
      const span = this.doc.createElement('span')
      span.setAttribute(DECO_ATTR, '')
      for (const [name, value] of Object.entries(part.attrs)) {
        checkAttrName(name)
        span.setAttribute(name, value)
      }
      span.appendChild(textNode)
      return span
    })
    const registry = this.editor.registry
    const marks = text.marks
      .filter((m) => registry.mark(m.type))
      .sort((a, b) => registry.markRank(a.type) - registry.markRank(b.type))
    let out = inner
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i]!
      const dom = registry.mark(mark.type)!.render(mark.data, {
        options: this.editor.getPluginOptions(mark.type),
      })
      const el = this.doc.createElement(checkTag(dom.tag))
      for (const [name, value] of Object.entries(markAttrs(dom))) {
        checkAttrName(name)
        if (value !== undefined) el.setAttribute(name, String(value))
      }
      el.append(...out)
      out = [el]
    }
    return out
  }
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Whether `node` is a child of `holder`'s hole strictly between its `before` and `anchor` nodes. */
function inWindow(holder: Holder, node: globalThis.Node): boolean {
  if (node.parentNode !== holder.hole) return false
  let cur = holder.before ? holder.before.nextSibling : holder.hole.firstChild
  for (; cur && cur !== holder.anchor; cur = cur.nextSibling) if (cur === node) return true
  return false
}

/**
 * Whether `old` and `next` are the same DOM shape: Text nodes pair with Text nodes, elements with
 * elements of the same tag and attributes and the same shape inside. A widget pairs only with itself.
 */
function sameShapes(old: NodeListOf<ChildNode> | readonly globalThis.Node[], next: readonly globalThis.Node[]): boolean {
  if (old.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    const a = old[i]!
    const b = next[i]!
    if (a === b) continue
    if (a.nodeType === 3 && b.nodeType === 3) continue
    if (a.nodeType !== 1 || b.nodeType !== 1) return false
    const ea = a as Element
    const eb = b as Element
    if (ea.hasAttribute(WIDGET_ATTR) || eb.hasAttribute(WIDGET_ATTR) || ea.tagName !== eb.tagName) return false
    if (ea.attributes.length !== eb.attributes.length) return false
    for (const attr of eb.attributes) if (ea.getAttribute(attr.name) !== attr.value) return false
    if (!sameShapes(ea.childNodes, [...eb.childNodes])) return false
  }
  return true
}

/** Copies the text of `next`'s Text nodes into `old`'s (same shapes, see `sameShapes`). True. */
function patchTexts(old: NodeListOf<ChildNode> | readonly globalThis.Node[], next: readonly globalThis.Node[]): boolean {
  for (let i = 0; i < next.length; i++) {
    const a = old[i]!
    const b = next[i]!
    if (a === b) continue
    if (a.nodeType === 3) {
      if ((a as Text).data !== (b as Text).data) (a as Text).data = (b as Text).data
    } else patchTexts(a.childNodes, [...b.childNodes])
  }
  return true
}
