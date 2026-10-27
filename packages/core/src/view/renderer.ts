import type { Editor } from '../editor'
import { checkAttrName, checkTag, isAttrs, kebab } from '../html/serialize'
import { deepEqualJson, isText, sameMarkSet } from '../model/node'
import type { Doc, ElementNode, Node, Path, TextNode } from '../model/types'
import type { DOMOutputSpec } from '../plugin/types'

const ID_ATTR = 'data-hte-id'
const LEAF_ATTR = 'data-hte-leaf'

/** The rendered DOM of one element (or of the root, for the doc). */
interface Holder {
  /** Where children are placed. */
  hole: HTMLElement
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
 * own root is re-rendered only when its type or data changes. Text leaves are reconciled by position
 * within their parent. Assumes element ids are unique in the doc.
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
    this.rootHolder = { hole: root, anchor: null, kids: [] }
  }

  render(doc: Doc, opts: { skipLeaf?: HTMLElement } = {}): void {
    const next = new Map<string, ElementEntry>()
    this.reconcile(this.rootHolder, doc.children, next, opts.skipLeaf)
    this.byId = next
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
  private reconcile(holder: Holder, children: Node[], next: Map<string, ElementEntry>, skipLeaf?: HTMLElement): void {
    const oldLeaves = holder.kids.filter((k) => k.hasAttribute(LEAF_ATTR))
    let leafIndex = 0
    const kids: HTMLElement[] = []
    for (const child of children) {
      if (isText(child)) kids.push(this.leaf(oldLeaves[leafIndex++], child, skipLeaf))
      else kids.push(this.element(child, next, skipLeaf))
    }

    const keep = new Set(kids)
    for (const old of holder.kids) {
      // A kid reused elsewhere has already been moved out of this hole.
      if (!keep.has(old) && old.parentNode === holder.hole) old.remove()
    }
    let ref = holder.anchor
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!
      if (kid.parentNode !== holder.hole || kid.nextSibling !== ref) holder.hole.insertBefore(kid, ref)
      ref = kid
    }
    holder.kids = kids
  }

  private element(node: ElementNode, next: Map<string, ElementEntry>, skipLeaf?: HTMLElement): HTMLElement {
    const prev = next.has(node.id) ? undefined : this.byId.get(node.id)
    let entry: ElementEntry
    if (prev && (prev.node === node || (prev.node.type === node.type && deepEqualJson(prev.node.data, node.data)))) {
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
    if (entry.rendersChildren) this.reconcile(entry, node.children ?? [], next, skipLeaf)
    return entry.dom
  }

  /** Builds an element's own root and content hole (no children). */
  private shell(node: ElementNode): ElementEntry {
    const registered = this.editor.registry.node(node.type)
    if (!registered) {
      const dom = this.doc.createElement('div')
      dom.setAttribute(ID_ATTR, node.id)
      dom.setAttribute('data-hte-unknown', node.type)
      dom.setAttribute('contenteditable', 'false')
      return { dom, node, hole: dom, anchor: null, kids: [], rendersChildren: false }
    }
    const render = registered.plugin.spec.renderHTML
    const spec = render?.(node, { options: this.editor.getPluginOptions(registered.plugin.name) })
    let dom: HTMLElement
    let hole: HTMLElement | null = null
    let anchor: globalThis.Node | null = null
    if (Array.isArray(spec)) {
      const built = this.buildSpec(spec)
      dom = built.dom as HTMLElement
      if (built.hole) ({ hole, anchor } = built.hole)
    } else if (spec === undefined || spec === 0) {
      dom = this.doc.createElement(registered.kind === 'inline' ? 'span' : 'div')
    } else {
      throw new Error(`renderHTML for "${node.type}" must return an element spec`)
    }
    dom.setAttribute(ID_ATTR, node.id)
    return { dom, node, hole: hole ?? dom, anchor, kids: [], rendersChildren: !registered.atom || hole !== null }
  }

  /** Builds DOM for a spec; records the first content hole as its parent element plus the node after it. */
  private buildSpec(spec: DOMOutputSpec): {
    dom: globalThis.Node
    hole: { hole: HTMLElement; anchor: globalThis.Node | null } | null
  } {
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
    let hole: { hole: HTMLElement; anchor: globalThis.Node | null } | null = null
    let pendingHole = false
    for (const child of children) {
      if (child === 0) {
        if (!hole && !pendingHole) pendingHole = true
        continue
      }
      const built = this.buildSpec(child)
      el.appendChild(built.dom)
      if (pendingHole) {
        hole = { hole: el, anchor: built.dom }
        pendingHole = false
      }
      if (!hole && built.hole) hole = built.hole
    }
    if (pendingHole) hole = { hole: el, anchor: null }
    return { dom: el, hole }
  }

  private leaf(old: HTMLElement | undefined, text: TextNode, skipLeaf?: HTMLElement): HTMLElement {
    if (old && old === skipLeaf) {
      // Composition owns this leaf's DOM; forget what it shows so a later render checks it again.
      this.leafText.delete(old)
      return old
    }
    const shown = old && this.leafText.get(old)
    if (old && shown && shown.text === text.text && sameMarkSet(shown.marks, text.marks)) {
      this.leafText.set(old, text)
      return old
    }
    const leaf = old ?? this.doc.createElement('span')
    if (!old) leaf.setAttribute(LEAF_ATTR, '')
    const content = this.leafContent(text)
    if (!(old && !shown && this.sameChildren(old, content))) leaf.replaceChildren(content)
    this.leafText.set(leaf, text)
    return leaf
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

  private sameChildren(leaf: HTMLElement, content: globalThis.Node): boolean {
    return leaf.childNodes.length === 1 && leaf.firstChild!.isEqualNode(content)
  }
}
