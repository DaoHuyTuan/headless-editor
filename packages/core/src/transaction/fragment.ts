import { isOpaque, type NodeTypes } from '../model/editable'
import { createId } from '../model/id'
import { getNode, isElement, isText, nodeEntries } from '../model/node'
import { comparePoint, parentPath } from '../model/path'
import type { DeepReadonly, Doc, ElementNode, Json, Node, Path, Point, Range, Selection, TextNode } from '../model/types'
import { blockPathOf, deleteRange, insertBlockNode, replaceSelectedNode, splitBlockAt } from './text'
import type { Transaction } from './transaction'

/**
 * Copied content. When the first node is a block element it is a block fragment (a list of
 * blocks); otherwise it is inline content (texts and inline elements).
 */
export type Fragment = Node[]

function cloneJson<T extends Json>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)])) as T
}

function cloneText(node: TextNode, text: string): TextNode {
  return { text, marks: node.marks.map((m) => ({ type: m.type, data: cloneJson(m.data) })) }
}

function ordered(at: Range | Selection): Range {
  const [a, b] = 'anchor' in at ? [at.anchor, at.focus] : [at.start, at.end]
  return comparePoint(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a }
}

/** A point relative to a node, or null when that side of the node is not cut. */
type Edge = Point | null

function below(edge: Edge, index: number): Edge {
  return edge && edge.path[0] === index ? { path: edge.path.slice(1), offset: edge.offset } : null
}

/**
 * Copies `children[from.path[0] ..= to.path[0]]`, trimming the edge children. Empty texts are
 * dropped, except that `keepOne` keeps one child so a trimmed element is never left empty.
 */
function sliceChildren(children: Node[], from: Edge, to: Edge, keepOne: boolean): Node[] {
  const first = from ? from.path[0]! : 0
  const last = to ? to.path[0]! : children.length - 1
  const out: Node[] = []
  for (let i = first; i <= last; i++) {
    out.push(sliceNode(children[i]!, i === first ? below(from, i) : null, i === last ? below(to, i) : null))
  }
  const kept = out.filter((n) => !(isText(n) && n.text === ''))
  return kept.length > 0 || !keepOne ? kept : out.slice(0, 1)
}

/** Deep copy of `node` between the two edges (null = uncut side). Elements keep id, type and data. */
function sliceNode(node: Node, from: Edge, to: Edge): Node {
  if (isText(node)) return cloneText(node, node.text.slice(from?.offset ?? 0, to ? to.offset : node.text.length))
  const copy: ElementNode = { id: node.id, type: node.type, data: cloneJson(node.data) }
  if (node.children) {
    copy.children = from || to ? sliceChildren(node.children, from, to, true) : node.children.map((c) => sliceNode(c, null, null))
  }
  return copy
}

/**
 * Deep-copies the content of `range` (points in either order; collapsed → `[]`). The copy is the
 * slice of the deepest node containing both points: a part of a single text, inline content of one
 * block, or a list of blocks whose partial edge blocks are trimmed but keep their type and data.
 */
export function getFragment(doc: DeepReadonly<Doc>, range: Range, node?: Path): Fragment {
  // A node selection copies the selected node whole (pass `selection.node`).
  if (node) return [sliceNode(getNode(doc, node), null, null)]
  const { start, end } = ordered(range)
  if (comparePoint(start, end) === 0) return []
  let depth = 0
  while (depth < start.path.length && depth < end.path.length && start.path[depth] === end.path[depth]) depth++
  const ancestor = depth === 0 ? (doc as Doc) : getNode(doc, start.path.slice(0, depth))
  // Paths point at texts, so a shared full path means both points are in one text.
  if (depth > 0 && isText(ancestor as Node)) {
    const text = ancestor as TextNode
    return [cloneText(text, text.text.slice(start.offset, end.offset))]
  }
  const rel = (p: Point): Point => ({ path: p.path.slice(depth), offset: p.offset })
  return sliceChildren((ancestor as Doc | ElementNode).children ?? [], rel(start), rel(end), false)
}

function freshId(used: Set<string>): string {
  let id = createId()
  while (used.has(id)) id = createId()
  return id
}

/**
 * Deep copy of `nodes` in which every element whose id is missing, already in `used`, or repeated
 * within the nodes gets a fresh id. Every id kept or created is added to `used`.
 */
function withUniqueIds(nodes: Node[], used: Set<string>): Node[] {
  const copy = (node: Node): Node => {
    if (isText(node)) return cloneText(node, node.text)
    const id = typeof node.id === 'string' && !used.has(node.id) ? node.id : freshId(used)
    used.add(id)
    const out: ElementNode = { id, type: node.type, data: cloneJson(node.data ?? {}) }
    if (node.children) out.children = node.children.map(copy)
    return out
  }
  return nodes.map(copy)
}

/**
 * The end of the last editable text inside `nodes` inserted at `[...parent, index]` (texts inside
 * opaque elements: unknown types and atoms, are skipped), or null if they hold none.
 */
function endOfInserted(nodes: Node[], parent: Path, index: number, types: NodeTypes): Point | null {
  const lastText = (node: Node, path: Path): Point | null => {
    if (isText(node)) return { path, offset: node.text.length }
    if (isOpaque(node, types)) return null
    const kids = node.children ?? []
    for (let k = kids.length - 1; k >= 0; k--) {
      const found = lastText(kids[k]!, [...path, k])
      if (found) return found
    }
    return null
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const found = lastText(nodes[i]!, [...parent, index + i])
    if (found) return found
  }
  return null
}

/** Inserts inline `nodes` at `point` (splitting its text); returns the end of the inserted content. */
function insertInline(tr: Transaction, point: Point, nodes: Node[]): Point {
  if (nodes.length === 0) return point
  const node = getNode(tr.doc, point.path)
  if (!isText(node)) throw new Error(`Expected a text node at [${point.path}]`)
  const parent = parentPath(point.path)
  let index = point.path[point.path.length - 1]!
  const atEnd = point.offset > 0 && point.offset === node.text.length
  if (point.offset > 0) {
    if (!atEnd) {
      tr.apply({ type: 'split_node', path: point.path, position: point.offset, properties: { marks: node.marks } })
    }
    index++
  }
  nodes.forEach((n, i) => tr.insertNode([...parent, index + i], n))
  // Nodes without any text: the caret stays where the original point now is.
  const original: Point = atEnd ? point : { path: [...parent, index + nodes.length], offset: 0 }
  return endOfInserted(nodes, parent, index, tr.registry) ?? original
}

/**
 * Splits the caret's block (the right half gets `rightId`), appends the first block's children to
 * the left half, inserts the middle blocks whole after it, and puts the last block's children in
 * front of the right half's. Returns the end of the inserted content.
 */
function insertBlocks(tr: Transaction, point: Point, blocks: Node[], rightId: string): Point {
  const blockPath = blockPathOf(tr, point.path)
  const block = getNode(tr.doc, blockPath) as ElementNode
  const rightStart = splitBlockAt(tr, point, blockPath, { id: rightId, type: block.type, data: block.data })
  const childrenOf = (n: Node): Node[] => (isElement(n) ? (n.children ?? []) : [n])

  const firstKids = childrenOf(blocks[0]!)
  const leftLength = ((getNode(tr.doc, blockPath) as ElementNode).children ?? []).length
  firstKids.forEach((n, i) => tr.insertNode([...blockPath, leftLength + i], n))

  const parent = parentPath(blockPath)
  const blockIndex = blockPath[blockPath.length - 1]!
  const middle = blocks.slice(1, -1)
  middle.forEach((b, i) => tr.insertNode([...parent, blockIndex + 1 + i], b))

  const rightPath = [...parent, blockIndex + 1 + middle.length]
  const lastKids = childrenOf(blocks[blocks.length - 1]!)
  lastKids.forEach((n, i) => tr.insertNode([...rightPath, i], n))
  // The right half's first text, shifted past the children inserted in front of it.
  const remainder: Point = {
    path: [...rightPath, lastKids.length, ...rightStart.path.slice(blockPath.length + 1)],
    offset: 0,
  }
  return endOfInserted(lastKids, rightPath, 0, tr.registry) ?? remainder
}

/**
 * Deletes `at` (default: the selection), then inserts `fragment` at the caret; the caret ends after
 * the inserted content. Inserted elements get fresh ids where theirs already exist in the doc or
 * repeat within the fragment. Pasted texts keep their own marks. Returns false without a target;
 * an empty fragment only deletes (true when something was deleted).
 */
export function insertFragment(tr: Transaction, fragment: Fragment, at?: Range | Selection): boolean {
  // A selected node is removed first; the content goes in at the (mapped) caret.
  const removedNode = !at && replaceSelectedNode(tr, 'delete')
  const target = at ?? tr.selection
  if (!target) return false
  const range = ordered(target)
  const deleted = deleteRange(tr, range)
  if (fragment.length === 0) return deleted || removedNode
  const point = range.start

  const used = new Set<string>()
  for (const [n] of nodeEntries(tr.doc)) if (isElement(n)) used.add(n.id)
  const nodes = withUniqueIds(fragment, used)
  const first = nodes[0]!
  const isBlockFragment = isElement(first) && tr.registry.node(first.type)?.kind !== 'inline'

  if (!isBlockFragment) return caretAt(tr, insertInline(tr, point, nodes))
  const opaque = (n: Node): boolean => isElement(n) && isOpaque(n, tr.registry)
  if (nodes.length === 1) {
    // A lone opaque block (e.g. a copied node selection) goes in whole, as a block of its own.
    if (!opaque(first)) return caretAt(tr, insertInline(tr, point, (first as ElementNode).children ?? []))
    tr.setSelection({ anchor: point, focus: point })
    return insertBlockNode(tr, first as ElementNode)
  }
  // Opaque edge blocks have no children to merge into the split halves: pad the fragment with a
  // childless block on that side, so they are inserted whole as middle blocks.
  const pad: ElementNode = { id: '', type: '', data: {}, children: [] }
  const last = nodes[nodes.length - 1]!
  const blocks = [...(opaque(first) ? [pad] : []), ...nodes, ...(opaque(last) ? [pad] : [])]
  return caretAt(tr, insertBlocks(tr, point, blocks, freshId(used)))
}

function caretAt(tr: Transaction, end: Point): true {
  tr.setSelection({ anchor: end, focus: end })
  return true
}
