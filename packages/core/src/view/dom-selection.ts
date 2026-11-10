import { nodeSelection } from '../model/editable'
import { pointEquals } from '../model/path'
import { mainRange, single } from '../model/selection'
import type { Path, Point, Selection } from '../model/types'
import { textsOutsideWidgets, widgetAround } from './decorations'
import type { Renderer } from './renderer'
import { isZwLeaf, placeholderIndex, stripPlaceholder } from './zero-width'

const LEAF_ATTR = 'data-hte-leaf'
const ID_ATTR = 'data-hte-id'
const PRECEDING = 2

/**
 * The DOM position for a model point: the innermost DOM text inside the leaf with the same
 * offset (UTF-16 code units), or `(leaf, 0)` for an empty leaf. Throws when no leaf is rendered there.
 * In a zero-width leaf, a point at or after its placeholder maps past it.
 */
export function modelToDom(r: Renderer, p: Point): { node: globalThis.Node; offset: number } {
  const leaf = r.leafAt(p.path)
  if (!leaf) throw new Error(`No rendered text at path [${p.path.join(',')}]`)
  const texts = textsIn(leaf)
  if (texts.length === 0) return { node: leaf, offset: 0 }
  const placeholder = placeholderIndex(texts.map((t) => t.data).join(''), isZwLeaf(leaf))
  let rest = Math.max(0, p.offset)
  if (placeholder >= 0 && rest >= placeholder) rest++
  for (const t of texts) {
    if (rest <= t.data.length) return { node: t, offset: rest }
    rest -= t.data.length
  }
  const last = texts[texts.length - 1]!
  return { node: last, offset: last.data.length }
}

/**
 * The model point for a DOM position, or null when it is outside the root (or the doc has no text).
 * Positions outside text leaves (element containers, static spec nodes, non-editable content) map to
 * the nearest leaf boundary. In or on non-editable content, the offset picks the side: the boundary
 * before its outermost non-editable ancestor, or after it once past its middle (see `pastMiddle`).
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

  // Content the user cannot place a caret in counts as one opaque node at its outermost ancestor
  // (an inline atom, a block atom, an unknown element, a non-editable static spec node): its position
  // is the boundary before it, or after it when past its middle (see `pastMiddle`).
  const opaque = outermostNonEditable(r, node)
  if (opaque) {
    const after = pastMiddle(opaque, node, offset)
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
  return anchor && focus ? single({ anchor, focus }) : null
}

/**
 * Makes the DOM selection show the main range of `sel`, keeping its direction. Does nothing when the DOM selection
 * already maps to `sel` and none of its ends is stray (see `isStrayPosition`). A null `sel` clears
 * the DOM selection only when it is inside the root.
 * Does nothing when a point has no rendered leaf (e.g. a text inside an unknown element).
 */
export function writeDomSelection(r: Renderer, sel: Selection | null, domSel: globalThis.Selection): void {
  if (!sel) {
    if (domSel.rangeCount > 0 && domSel.anchorNode && r.root.contains(domSel.anchorNode)) domSel.removeAllRanges()
    return
  }
  const read = readDomSelection(r, domSel)
  const current = read && mainRange(read)
  const range = mainRange(sel)
  if (range.node) {
    const el = r.elementAt(range.node)
    if (el?.parentNode) {
      if (current?.node && samePath(current.node, range.node)) return
      const i = indexOf(el)
      domSel.setBaseAndExtent(el.parentNode, i, el.parentNode, i + 1)
      return
    }
    // Not rendered: show its caret.
  }
  // `leafAt` is null for a leaf not in the root (e.g. in a contentDOM its view has not placed yet).
  if (!r.leafAt(range.anchor.path) || !r.leafAt(range.focus.path)) return
  // Kept unless an end is stray (see `isStrayPosition`): e.g. a caret the browser collapsed into the
  // root after its leaf was removed maps to the same point while no caret shows there, and typing at
  // it never reaches the model.
  if (
    current &&
    !current.node &&
    pointEquals(current.anchor, range.anchor) &&
    pointEquals(current.focus, range.focus) &&
    !isStrayPosition(r, domSel.anchorNode!, domSel.isCollapsed) &&
    !isStrayPosition(r, domSel.focusNode!, domSel.isCollapsed)
  ) {
    return
  }
  const anchor = modelToDom(r, range.anchor)
  const focus = modelToDom(r, range.focus)
  domSel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}

// --- helpers ---

/**
 * Whether a DOM selection end in `node` is stray, so a write that maps to the same model points still
 * moves it into the leaves:
 * - the root itself;
 * - for a collapsed caret (`collapsed`), any editable position outside every leaf: e.g. parked at a
 *   block element's child index or in a static text of a spec, where typing would land outside the
 *   leaves and never reach the model;
 * - for an end of a non-collapsed selection, an editable element outside every leaf that contains no
 *   leaf (e.g. a block or contentDOM whose leaf was removed).
 * Positions in leaves and in non-editable content (inline atoms, node-view controls) are never stray,
 * nor are the ends of a non-collapsed selection at block boundaries or in static text (e.g. mid-drag):
 * they are the user's, and kept while they map to the model selection.
 */
function isStrayPosition(r: Renderer, node: globalThis.Node, collapsed: boolean): boolean {
  if (node === r.root) return true
  if (leafAround(r, node) || outermostNonEditable(r, node)) return false
  if (collapsed) return true
  if (node.nodeType !== 1) return false
  return !(node as Element).querySelector(`[${LEAF_ATTR}]`)
}

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

/** The DOM text of a leaf (decoration widgets excluded). */
function leafDomText(leaf: Element): string {
  return textsIn(leaf)
    .map((t) => t.data)
    .join('')
}

/** The model text length of a leaf (the zero-width placeholder excluded, see `stripPlaceholder`). */
function textLength(leaf: Element): number {
  return stripPlaceholder(leafDomText(leaf), isZwLeaf(leaf)).length
}

/**
 * Whether the DOM position is past the middle of `el`'s text, or, when it has no text, of its child
 * nodes: a position inside child `i` counts as halfway through it (`i + 0.5` children before it), so
 * one inside the last of two children is past the middle, like one after both.
 */
function pastMiddle(el: Element, node: globalThis.Node, offset: number): boolean {
  const total = textsIn(el).reduce((sum, t) => sum + t.data.length, 0)
  if (total > 0) return textBefore(el, node, offset) * 2 > total
  const count = el.childNodes.length
  if (node === el) return offset * 2 > count
  let child: globalThis.Node = node
  while (child.parentNode && child.parentNode !== el) child = child.parentNode
  if (child.parentNode !== el) return false
  return indexOf(child) * 2 + 1 > count
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
  // The zero-width placeholder is not model text: drop it when it precedes the position.
  const placeholder = placeholderIndex(leafDomText(leaf), isZwLeaf(leaf))
  if (placeholder >= 0 && before > placeholder) before--
  return { path, offset: Math.min(before, length) }
}

/**
 * The outermost ancestor-or-self of `node` below the root with `contenteditable="false"`, not looking
 * past a node view's `contentDOM` (editable content, even inside a non-editable wrapper of its view).
 */
function outermostNonEditable(r: Renderer, node: globalThis.Node): Element | null {
  let found: Element | null = null
  let cur: globalThis.Node | null = node
  while (cur && cur !== r.root && !r.isContentDOM(cur)) {
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
  // Every leaf span in document order; whether one is a current leaf (`pathOfLeaf`) is only asked of
  // the few looked at below, not of all of them.
  const leaves = Array.from(r.root.querySelectorAll(`[${LEAF_ATTR}]`))
  if (leaves.length === 0) return null
  const valid = (l: Element) => r.pathOfLeaf(l) !== null
  const ref = container.childNodes[Math.max(0, index)] ?? null
  const start = (l: Element): Point => ({ path: r.pathOfLeaf(l)!, offset: 0 })
  const end = (l: Element): Point => ({ path: r.pathOfLeaf(l)!, offset: textLength(l) })
  const isBefore = (l: Element): boolean =>
    ref
      ? (ref.compareDocumentPosition(l) & PRECEDING) !== 0
      : container.contains(l) || (container.compareDocumentPosition(l) & PRECEDING) !== 0
  // Leaves before the position come first in document order: the first one not before it, by bisection.
  let lo = 0
  let hi = leaves.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (isBefore(leaves[mid]!)) lo = mid + 1
    else hi = mid
  }
  const split = lo
  // A position right before an element holding leaves: the first (current) leaf inside it.
  if (ref) {
    for (let i = split; i < leaves.length && (ref === leaves[i] || ref.contains(leaves[i]!)); i++)
      if (valid(leaves[i]!)) return start(leaves[i]!)
  }
  // The closest current leaf on each side, inside the position's element first (its leaves are
  // contiguous in document order), else anywhere.
  const scope = closestElementRoot(r.root, container)
  for (let i = split - 1; i >= 0 && scope.contains(leaves[i]!); i--) if (valid(leaves[i]!)) return end(leaves[i]!)
  for (let i = split; i < leaves.length && scope.contains(leaves[i]!); i++) if (valid(leaves[i]!)) return start(leaves[i]!)
  for (let i = split - 1; i >= 0; i--) if (valid(leaves[i]!)) return end(leaves[i]!)
  for (let i = split; i < leaves.length; i++) if (valid(leaves[i]!)) return start(leaves[i]!)
  return null
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
