import { pointEquals } from '../model/path'
import type { Point, Selection } from '../model/types'
import type { Renderer } from './renderer'

const LEAF_ATTR = 'data-hte-leaf'
const ID_ATTR = 'data-hte-id'
const SHOW_TEXT = 4
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
  let rest = Math.max(0, p.offset)
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
 * the nearest leaf boundary.
 */
export function domToModel(r: Renderer, node: globalThis.Node, offset: number): Point | null {
  const root = r.root
  if (!root.contains(node)) return null

  const leaf = leafAround(r, node)
  if (leaf) return pointInLeaf(r, leaf, node, offset)

  // Content the user cannot place a caret in counts as one opaque node at its outermost ancestor.
  const opaque = outermostNonEditable(root, node)
  if (opaque) return boundaryPoint(r, opaque.parentNode!, indexOf(opaque))
  if (node.nodeType !== 1) {
    // Static text (or other non-element) from a spec: before it at offset 0, otherwise after it.
    return boundaryPoint(r, node.parentNode!, indexOf(node) + (offset > 0 ? 1 : 0))
  }
  return boundaryPoint(r, node, offset)
}

/** The model selection for a DOM selection, or null when it has no range or leaves the root. */
export function readDomSelection(r: Renderer, domSel: globalThis.Selection): Selection | null {
  if (domSel.rangeCount === 0 || !domSel.anchorNode || !domSel.focusNode) return null
  const anchor = domToModel(r, domSel.anchorNode, domSel.anchorOffset)
  const focus = domToModel(r, domSel.focusNode, domSel.focusOffset)
  return anchor && focus ? { anchor, focus } : null
}

/**
 * Makes the DOM selection show `sel`, keeping its direction. Does nothing when the DOM selection
 * already maps to `sel`. A null `sel` clears the DOM selection only when it is inside the root.
 */
export function writeDomSelection(r: Renderer, sel: Selection | null, domSel: globalThis.Selection): void {
  if (!sel) {
    if (domSel.rangeCount > 0 && domSel.anchorNode && r.root.contains(domSel.anchorNode)) domSel.removeAllRanges()
    return
  }
  const current = readDomSelection(r, domSel)
  if (current && pointEquals(current.anchor, sel.anchor) && pointEquals(current.focus, sel.focus)) return
  const anchor = modelToDom(r, sel.anchor)
  const focus = modelToDom(r, sel.focus)
  domSel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}

// --- helpers ---

function textsIn(el: globalThis.Node): Text[] {
  const walker = el.ownerDocument!.createTreeWalker(el, SHOW_TEXT)
  const out: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

function textLength(el: globalThis.Node): number {
  return textsIn(el).reduce((sum, t) => sum + t.data.length, 0)
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
  let before = 0
  if (node.nodeType === 3) {
    for (const t of textsIn(leaf)) {
      if (t === node) break
      before += t.data.length
    }
    before += Math.min(Math.max(0, offset), (node as Text).data.length)
  } else {
    // Leaf span, mark wrapper or break as a container: count the leaf text before the boundary.
    const ref = node.childNodes[Math.max(0, offset)] ?? null
    for (const t of textsIn(leaf)) {
      const precedes = ref
        ? (ref.compareDocumentPosition(t) & PRECEDING) !== 0
        : node.contains(t) || (node.compareDocumentPosition(t) & PRECEDING) !== 0
      if (precedes) before += t.data.length
    }
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
