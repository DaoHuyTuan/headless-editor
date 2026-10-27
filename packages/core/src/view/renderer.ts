import type { Editor } from '../editor'
import { checkAttrName, checkTag, isAttrs, kebab } from '../html/serialize'
import { deepEqualJson, isText, sameMarkSet } from '../model/node'
import type { Doc, ElementNode, Node, Path, TextNode } from '../model/types'
import type { DOMOutputSpec } from '../plugin/types'

const ID_ATTR = 'data-hte-id'
const LEAF_ATTR = 'data-hte-leaf'

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
}

interface HolePosition {
  hole: HTMLElement
  before: globalThis.Node | null
  anchor: globalThis.Node | null
}

export interface RenderOptions {
  /** A leaf owned by composition: its DOM is never changed, moved out or removed by this render. */
  skipLeaf?: HTMLElement
  /**
   * The path, in the doc being rendered, of the text `skipLeaf` shows. When given, that text is
   * rendered by `skipLeaf` whatever its position; otherwise `skipLeaf` keeps its positional slot.
   */
  skipPath?: Path
}

interface RenderPass {
  next: Map<string, ElementEntry>
  skipLeaf?: HTMLElement
  skipPath?: Path
}

/**
 * Renders a document into a contenteditable root and patches it on later renders.
 *
 * DOM contract: each element's root is the first element produced by its `renderHTML` (a `<div>` /
 * `<span>` wrapper for block / inline types without one) carrying `data-hte-id`; children go into the
 * content hole. Each text is a `<span data-hte-leaf>` holding its marks nested by rank (lowest
 * outermost) around the DOM text, or `<br data-hte-break>` when empty. Unknown elements render as an
 * empty `<div data-hte-id data-hte-unknown="<type>" contenteditable="false">`.
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
  /** The text each leaf span currently shows; missing when unknown (skipped while the model moved on). */
  private readonly leafText = new WeakMap<Element, TextNode>()

  constructor(
    private readonly root: HTMLElement,
    private readonly editor: Editor,
  ) {
    this.doc = root.ownerDocument
    root.setAttribute('contenteditable', 'true')
    root.setAttribute('role', 'textbox')
    root.setAttribute('aria-multiline', 'true')
    root.style.whiteSpace = 'pre-wrap'
    this.rootHolder = { hole: root, before: null, anchor: null, kids: [] }
  }

  render(doc: Doc, opts: RenderOptions = {}): void {
    const pass: RenderPass = { next: new Map(), skipLeaf: opts.skipLeaf, skipPath: opts.skipPath }
    this.reconcile(this.rootHolder, doc.children, [], pass)
    this.byId = pass.next
  }

  /** The `<span data-hte-leaf>` rendered for the text at `path`. */
  leafAt(path: Path): HTMLElement | null {
    const dom = this.domAt(path)
    return dom && this.isLeaf(dom) ? dom : null
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
        kids.push(this.leaf(oldLeaves[leafIndex++], child, skipLeaf))
      }
    })

    const { hole, anchor } = holder
    let ref = anchor
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!
      // Composition owns skipLeaf: never move it (it is already in place when reused here).
      if (kid === skipLeaf && kid.parentNode === hole) {
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
    const prev = next.has(node.id) ? undefined : this.byId.get(node.id)
    let entry: ElementEntry
    if (
      prev &&
      this.shellIntact(prev) &&
      (prev.node === node || (prev.node.type === node.type && deepEqualJson(prev.node.data, node.data)))
    ) {
      entry = prev
      entry.node = node
    } else {
      entry = this.shell(node)
      // Keep the old children's DOM so they are moved into the new shell, not recreated.
      if (prev && entry.rendersChildren) entry.kids = prev.kids
      this.byDom.set(entry.dom, entry)
    }
    // Duplicate ids get fresh DOM and are not keyed.
    if (!next.has(node.id)) next.set(node.id, entry)
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

  private leaf(old: HTMLElement | undefined, text: TextNode, skipLeaf?: HTMLElement): HTMLElement {
    if (old && old === skipLeaf) {
      // Composition owns this leaf's DOM; forget what it shows so a later render checks it again.
      this.leafText.delete(old)
      return old
    }
    const shown = old && this.leafText.get(old)
    if (old && shown && shown.text === text.text && sameMarkSet(shown.marks, text.marks) && this.leafIntact(old, text)) {
      this.leafText.set(old, text)
      return old
    }
    const leaf = old ?? this.doc.createElement('span')
    if (!old) leaf.setAttribute(LEAF_ATTR, '')
    const content = this.leafContent(text)
    if (!(old && leaf.childNodes.length === 1 && leaf.firstChild!.isEqualNode(content))) leaf.replaceChildren(content)
    this.leafText.set(leaf, text)
    return leaf
  }

  /**
   * Cheap check that a leaf still has the shape we rendered: a single-child chain with one wrapper
   * per known mark, ending in the text (or the break). Attributes on wrappers are not compared.
   */
  private leafIntact(leaf: HTMLElement, text: TextNode): boolean {
    const markCount = text.marks.filter((m) => this.editor.registry.mark(m.type)).length
    let cur: globalThis.Node = leaf
    for (let depth = 0; depth <= markCount; depth++) {
      if (cur.childNodes.length !== 1) return false
      cur = cur.firstChild!
      if (depth < markCount && cur.nodeType !== 1) return false
    }
    if (text.text === '') return cur.nodeName === 'BR' && (cur as Element).hasAttribute('data-hte-break')
    return cur.nodeType === 3 && (cur as Text).data === text.text
  }

  /** The leaf's content: mark wrappers nested by rank around the text (or a break when empty). */
  private leafContent(text: TextNode): globalThis.Node {
    const inner: globalThis.Node =
      text.text === '' ? this.doc.createElement('br') : this.doc.createTextNode(text.text)
    if (text.text === '') (inner as Element).setAttribute('data-hte-break', '')
    const registry = this.editor.registry
    const marks = text.marks
      .filter((m) => registry.mark(m.type))
      .sort((a, b) => registry.markRank(a.type) - registry.markRank(b.type))
    let out = inner
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i]!
      const dom = registry.mark(mark.type)!.render(mark.data)
      const el = this.doc.createElement(checkTag(dom.tag))
      for (const [name, value] of Object.entries(dom.attrs ?? {})) el.setAttribute(checkAttrName(name), value)
      for (const [prop, value] of Object.entries(dom.style ?? {})) el.style.setProperty(kebab(prop), value)
      el.appendChild(out)
      out = el
    }
    return out
  }
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
