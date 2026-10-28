import { nodeSelection } from '../model/editable'
import { pointEquals } from '../model/path'
import type { Path, Point, Selection } from '../model/types'
import { textsOutsideWidgets, widgetAround } from './decorations'
import type { Renderer } from './renderer'

const LEAF_ATTR = 'data-hte-leaf'
const ID_ATTR = 'data-hte-id'
const ZW_ATTR = 'data-hte-zw'
const ZW = '​'
const PRECEDING = 2

/**
 * The DOM position for a model point: the innermost DOM text inside the leaf with the same
 * offset (UTF-16 code units), or `(leaf, 0)` for an empty leaf. Throws when no leaf is rendered there.
 */
export function modelToDom(r: Renderer, p: Point): { node: globalThis.Node; offset: number } {
  const leaf = r.leafAt(p.path)
  if (!leaf) throw new Error(`No rendered text at path [${p.path.join(',')}]`)
  const texts = textsIn(leaf)
  if (texts.length === 0) return { node: leaf, offset: 0 }
  const zw = isZwLeaf(leaf)
  let rest = Math.max(0, p.offset)
  for (const t of texts) {
    const length = modelLength(t.data, zw)
    if (rest <= length) return { node: t, offset: zw ? domIndex(t.data, rest) : rest }
    rest -= length
  }
  const last = texts[texts.length - 1]!
  return { node: last, offset: last.data.length }
}

/**
 * The model point for a DOM position, or null when it is outside the root (or the doc has no text).
 * Positions outside text leaves (element containers, static spec nodes, non-editable content) map to
 * the nearest leaf boundary.
 */
export function domToModel(r: Renderer, node: globalThis.Node, offset: number): Point | null {
  const root = r.root
  if (!root.contains(node)) return null

  // A position inside a decoration widget (not model text) is the boundary before the widget.
  const widget = widgetAround(root, node)
  if (widget) {
    node = widget.parentNode!
    offset = indexOf(widget)
  }

  const leaf = leafAround(r, node)
  if (leaf) return pointInLeaf(r, leaf, node, offset)

  // Content the user cannot place a caret in counts as one opaque node at its outermost ancestor:
  // its position is the boundary before it, or after it for an inline atom past its middle.
  const opaque = outermostNonEditable(root, node)
  if (opaque) {
    const after = isInlineAtomRoot(r, opaque) && pastMiddle(opaque, node, offset)
    return boundaryPoint(r, opaque.parentNode!, indexOf(opaque) + (after ? 1 : 0))
  }
  if (node.nodeType !== 1) {
    // Static text (or other non-element) from a spec: before it at offset 0, otherwise after it.
    return boundaryPoint(r, node.parentNode!, indexOf(node) + (offset > 0 ? 1 : 0))
  }
  return boundaryPoint(r, node, offset)
}

/** The model selection for a DOM selection, or null when it has no range or leaves the root. */
export function readDomSelection(r: Renderer, domSel: globalThis.Selection): Selection | null {
  if (domSel.rangeCount === 0 || !domSel.anchorNode || !domSel.focusNode) return null
  const selected = selectedElementPath(r, domSel)
  if (selected) {
    try {
      return nodeSelection(r.renderedDoc, r.registry, selected)
    } catch {
      // No editable text to anchor it: read it as a caret below.
    }
  }
  const anchor = domToModel(r, domSel.anchorNode, domSel.anchorOffset)
  const focus = domToModel(r, domSel.focusNode, domSel.focusOffset)
  return anchor && focus ? { anchor, focus } : null
}

/**
 * Makes the DOM selection show `sel`, keeping its direction. Does nothing when the DOM selection
 * already maps to `sel`. A null `sel` clears the DOM selection only when it is inside the root.
 * Does nothing when a point has no rendered leaf (e.g. a text inside an unknown element).
 */
export function writeDomSelection(r: Renderer, sel: Selection | null, domSel: globalThis.Selection): void {
  if (!sel) {
    if (domSel.rangeCount > 0 && domSel.anchorNode && r.root.contains(domSel.anchorNode)) domSel.removeAllRanges()
    return
  }
  const current = readDomSelection(r, domSel)
  if (sel.node) {
    const el = r.elementAt(sel.node)
    if (el?.parentNode) {
      if (current?.node && samePath(current.node, sel.node)) return
      const i = indexOf(el)
      domSel.setBaseAndExtent(el.parentNode, i, el.parentNode, i + 1)
      return
    }
    // Not rendered: show its caret.
  }
  if (!r.leafAt(sel.anchor.path) || !r.leafAt(sel.focus.path)) return
  if (current && !current.node && pointEquals(current.anchor, sel.anchor) && pointEquals(current.focus, sel.focus)) {
    return
  }
  const anchor = modelToDom(r, sel.anchor)
  const focus = modelToDom(r, sel.focus)
  domSel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}

// --- helpers ---

/** The path of the opaque block whose root is exactly what the DOM selection covers, or null. */
function selectedElementPath(r: Renderer, domSel: globalThis.Selection): Path | null {
  const { anchorNode, focusNode, anchorOffset, focusOffset } = domSel
  if (!anchorNode || anchorNode !== focusNode || Math.abs(anchorOffset - focusOffset) !== 1) return null
  if (!r.root.contains(anchorNode) || anchorNode.nodeType !== 1) return null
  const child = anchorNode.childNodes[Math.min(anchorOffset, focusOffset)]
  return child && child.nodeType === 1 ? r.opaqueBlockPath(child as Element) : null
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** The DOM texts inside `el`, in order; texts of decoration widgets are not model text and are skipped. */
function textsIn(el: globalThis.Node): Text[] {
  return textsOutsideWidgets(el)
}

/** The model text length of a leaf (zero-width placeholders excluded). */
function textLength(leaf: Element): number {
  const zw = isZwLeaf(leaf)
  return textsIn(leaf).reduce((sum, t) => sum + modelLength(t.data, zw), 0)
}

/** Whether the leaf shows an empty text as a zero-width space (see the renderer): that character is not model text. */
function isZwLeaf(leaf: Element): boolean {
  return leaf.hasAttribute(ZW_ATTR)
}

/** How many model characters `data` holds: in a zero-width leaf, its zero-width spaces do not count. */
function modelLength(data: string, zw: boolean): number {
  return zw ? data.split(ZW).join('').length : data.length
}

/** The DOM index in `data` (of a zero-width leaf) right after its first `count` model characters, past any zero-width space. */
function domIndex(data: string, count: number): number {
  let i = 0
  for (let seen = 0; i < data.length; i++) {
    if (data[i] === ZW) continue
    if (seen === count) break
    seen++
  }
  return Math.min(i, data.length)
}

function isInlineAtomRoot(r: Renderer, el: Element): boolean {
  const node = r.nodeOfElement(el)
  const spec = node && r.registry.node(node.type)
  return !!spec && spec.kind === 'inline' && spec.atom === true
}

/** Whether the DOM position is past the middle of `el`'s text (of its child nodes, when it has no text). */
function pastMiddle(el: Element, node: globalThis.Node, offset: number): boolean {
  const total = textsIn(el).reduce((sum, t) => sum + t.data.length, 0)
  if (total === 0) return node === el && offset * 2 > el.childNodes.length
  return textBefore(el, node, offset) * 2 > total
}

/** The length of `el`'s DOM text before the position `(node, offset)` inside it. */
function textBefore(el: Element, node: globalThis.Node, offset: number): number {
  let before = 0
  if (node.nodeType === 3) {
    for (const t of textsIn(el)) {
      if (t === node) break
      before += t.data.length
    }
    return before + Math.min(Math.max(0, offset), (node as Text).data.length)
  }
  const ref = node.childNodes[Math.max(0, offset)] ?? null
  for (const t of textsIn(el)) {
    const precedes = ref
      ? (ref.compareDocumentPosition(t) & PRECEDING) !== 0
      : node.contains(t) || (node.compareDocumentPosition(t) & PRECEDING) !== 0
    if (precedes) before += t.data.length
  }
  return before
}

function indexOf(node: globalThis.Node): number {
  return Array.prototype.indexOf.call(node.parentNode!.childNodes, node) as number
}

/** The rendered leaf span that is or contains `node`. */
function leafAround(r: Renderer, node: globalThis.Node): Element | null {
  let cur: globalThis.Node | null = node
  while (cur && cur !== r.root) {
    if (cur.nodeType === 1 && (cur as Element).hasAttribute(LEAF_ATTR) && r.pathOfLeaf(cur as Element)) {
      return cur as Element
    }
    cur = cur.parentNode
  }
  return null
}

/** A position inside a leaf: the length of the leaf's text before it. */
function pointInLeaf(r: Renderer, leaf: Element, node: globalThis.Node, offset: number): Point {
  const path = r.pathOfLeaf(leaf)!
  const length = textLength(leaf)
  // Leaf span, mark wrapper or break as a container: the leaf text before the boundary counts.
  let before = textBefore(leaf, node, offset)
  if (isZwLeaf(leaf)) {
    // Zero-width placeholders are not model text: count only what precedes the position otherwise.
    const all = textsIn(leaf).map((t) => t.data).join('')
    before = modelLength(all.slice(0, before), true)
  }
  return { path, offset: Math.min(before, length) }
}

/** The outermost ancestor-or-self of `node` below the root with `contenteditable="false"`. */
function outermostNonEditable(root: HTMLElement, node: globalThis.Node): Element | null {
  let found: Element | null = null
  let cur: globalThis.Node | null = node
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && (cur as Element).getAttribute('contenteditable') === 'false') found = cur as Element
    cur = cur.parentNode
  }
  return found
}

/**
 * Maps the boundary before `container.childNodes[index]` (or its end) to the nearest leaf: the start
 * of a leaf at or inside that child, else the end of the closest leaf before it in the same element,
 * else the start of the first leaf after it there, else the same search over the whole document.
 */
function boundaryPoint(r: Renderer, container: globalThis.Node, index: number): Point | null {
  const leaves = Array.from(r.root.querySelectorAll(`[${LEAF_ATTR}]`)).filter((l) => r.pathOfLeaf(l))
  if (leaves.length === 0) return null
  const ref = container.childNodes[Math.max(0, index)] ?? null
  const start = (l: Element): Point => ({ path: r.pathOfLeaf(l)!, offset: 0 })
  const end = (l: Element): Point => ({ path: r.pathOfLeaf(l)!, offset: textLength(l) })

  if (ref) {
    const inside = leaves.find((l) => ref === l || ref.contains(l))
    if (inside) return start(inside)
  }
  const isBefore = (l: Element): boolean =>
    ref
      ? (ref.compareDocumentPosition(l) & PRECEDING) !== 0
      : container.contains(l) || (container.compareDocumentPosition(l) & PRECEDING) !== 0
  const before = leaves.filter(isBefore)
  const after = leaves.filter((l) => !isBefore(l))

  const scope = closestElementRoot(r.root, container)
  const prevIn = before.filter((l) => scope.contains(l)).at(-1)
  if (prevIn) return end(prevIn)
  const nextIn = after.find((l) => scope.contains(l))
  if (nextIn) return start(nextIn)
  const prev = before.at(-1)
  if (prev) return end(prev)
  return start(after[0]!)
}

/** The closest element root (`data-hte-id`) that is or contains `node`, or the root. */
function closestElementRoot(root: HTMLElement, node: globalThis.Node): globalThis.Node {
  let cur: globalThis.Node | null = node
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && (cur as Element).hasAttribute(ID_ATTR)) return cur
    cur = cur.parentNode
  }
  return root
}
