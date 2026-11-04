import { isOpaque, type NodeTypes } from '../model/editable'
import { createId } from '../model/id'
import { getNode, isElement, isText, nodeEntries } from '../model/node'
import { comparePoint, parentPath, toRange } from '../model/path'
import { isNodeRange } from '../model/selection'
import type { DeepReadonly, Doc, ElementNode, Json, Node, Path, Point, Range, SelectionRange, TextNode } from '../model/types'
import {
  blockPathOf,
  deleteRangeStep,
  insertBlockNodeStep,
  isInlineOpaque,
  replaceNodeStep,
  runStep,
  splitBlockAt,
  type StepResult,
} from './text'
import { mapSince, ordered } from './ranges'
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
  // A node selection copies the selected node whole (pass the node range's `node`).
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

/**
 * Inserts inline `nodes` at `point` (splitting its text); returns the end of the inserted content.
 * When the last node is an inline atom (or `after` is set) that end is right after the last node: the
 * start of the text following it, an empty one being added when none does.
 */
function insertInline(tr: Transaction, point: Point, nodes: Node[], after = false): Point {
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
  const last = nodes[nodes.length - 1]!
  const parentType = parent.length === 0 ? 'doc' : (getNode(tr.doc, parent) as ElementNode).type
  if (after || (isElement(last) && isInlineOpaque(tr, last, parentType))) {
    return textStartAt(tr, [...parent, index + nodes.length])
  }
  // Nodes without any text: the caret stays where the original point now is.
  const original: Point = atEnd ? point : { path: [...parent, index + nodes.length], offset: 0 }
  return endOfInserted(nodes, parent, index, tr.registry) ?? original
}

/** The start of the text at `at`; when the node there is not a text (or there is none), an empty text is inserted at `at`. */
function textStartAt(tr: Transaction, at: Path): Point {
  const parent = parentPath(at)
  const siblings = parent.length === 0 ? tr.doc.children : ((getNode(tr.doc, parent) as ElementNode).children ?? [])
  const next = siblings[at[at.length - 1]!]
  if (!next || !isText(next)) tr.insertNode(at, { text: '', marks: [] })
  return { path: at, offset: 0 }
}

/** The ids of every element in the doc. */
function docIds(tr: Transaction): Set<string> {
  const used = new Set<string>()
  for (const [n] of nodeEntries(tr.doc)) if (isElement(n)) used.add(n.id)
  return used
}

function caret(point: Point): SelectionRange {
  return { anchor: point, focus: point }
}

/**
 * Inserts the inline element `node` at every selection range, replacing the range (a selected node is
 * first swapped for an empty default block); each caret ends right after its copy. A copy's ids are
 * replaced where already in the doc, so every copy gets fresh ones. A caret in a text-only block
 * (`content: 'text'`) gets nothing. False (nothing inserted) when `node` is not a registered inline
 * type, without a selection, when no range takes it, or when its data is rejected (the tr stays
 * rejected). Takes no range: inside a `forEachRange` callback it throws in dev mode.
 */
export function insertInlineNode(tr: Transaction, node: ElementNode): boolean {
  if (tr.registry.node(node.type)?.kind !== 'inline') return false
  let inserted = false
  runStep(tr, undefined, (range) => {
    let sel: SelectionRange = range
    if (isNodeRange(range)) {
      const out = replaceNodeStep(tr, range, { text: '' })
      if (!out) return out
      sel = out
    }
    const r = toRange(sel)
    const block = getNode(tr.doc, blockPathOf(tr, r.start.path)) as ElementNode
    if (tr.registry.node(block.type)?.content === 'text') return sel === range ? false : sel
    const deleted = deleteRangeStep(tr, r)
    const point = deleted ?? r.start
    const from = tr.ops.length
    const end = insertInline(tr, point, withUniqueIds([node], docIds(tr)), true)
    // A rejected tr is never applied (the editor drops it), so the split text needs no undoing: the
    // range is only mapped through it.
    if (tr.rejected !== null) {
      const base = deleted ? caret(deleted) : sel
      return mapSince(tr, base, from) ?? base
    }
    inserted = true
    return caret(end)
  })
  return inserted && tr.rejected === null
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

/** A per-range fragment step's result, plus whether it failed (false from `insertFragment`) after editing. */
interface FragmentStep {
  out: StepResult
  failed?: boolean
}

/**
 * Replaces the node of `range` (a node range) with the blocks `nodes` (fresh ids), the first at its
 * index. The caret ends at the end of the last block's last editable text; when the last block is
 * opaque (or has none), at the start of the editable text following it, an empty default block being
 * added when none follows. Fails when a block is rejected (the tr stays rejected).
 */
function replaceNodeWithBlocksStep(tr: Transaction, range: SelectionRange & { node: Path }, nodes: Node[]): FragmentStep {
  const path = range.node
  const last = nodes[nodes.length - 1] as ElementNode
  // Puts `last` where the node was and the caret after it; the blocks before it then go in front,
  // which maps the caret.
  const placed = replaceNodeStep(tr, range, { node: last })
  if (!placed) return { out: placed, failed: true }
  const from = tr.ops.length
  const parent = parentPath(path)
  const index = path[path.length - 1]!
  nodes.slice(0, -1).forEach((n, i) => tr.insertNode([...parent, index + i], n))
  const mapped = mapSince(tr, placed, from)
  if (tr.rejected !== null) return { out: mapped, failed: true }
  if (isOpaque(last, tr.registry)) return { out: mapped }
  const end = endOfInserted([last], parent, index + nodes.length - 1, tr.registry)
  return { out: end ? caret(end) : mapped }
}

/**
 * `insertFragment` at one range. `nodeEdit`: a node range is replaced in place (no explicit target).
 */
function insertFragmentStep(tr: Transaction, fragment: Fragment, sel: SelectionRange, nodeEdit: boolean): FragmentStep {
  let target: SelectionRange = sel
  // A selected node is replaced in place, as typing does. Blocks with an opaque edge go in whole at
  // the node's index (merging them into a placeholder would leave it behind as a stray empty block);
  // other content goes into the start of an empty default block put in the node's place, with the
  // same split / merge rules as at any caret. An empty fragment only removes the node.
  if (nodeEdit && isNodeRange(sel)) {
    if (fragment.length === 0) return { out: replaceNodeStep(tr, sel, 'delete') }
    const block = (n: Node): n is ElementNode => isElement(n) && tr.registry.node(n.type)?.kind !== 'inline'
    const opaqueBlock = (n: Node): boolean => block(n) && isOpaque(n, tr.registry)
    if (block(fragment[0]!) && (opaqueBlock(fragment[0]!) || opaqueBlock(fragment[fragment.length - 1]!)))
      return replaceNodeWithBlocksStep(tr, sel, withUniqueIds(fragment, docIds(tr)))
    const out = replaceNodeStep(tr, sel, { text: '' })
    if (!out) return { out, failed: true }
    target = out
  }
  const range = toRange(target)
  const deleted = deleteRangeStep(tr, range)
  if (fragment.length === 0) return { out: deleted ? caret(deleted) : false }
  const point = range.start

  // Per insert, so every copy gets ids not yet in the doc (the earlier copies included).
  const used = docIds(tr)
  const nodes = withUniqueIds(fragment, used)
  const first = nodes[0]!
  const isBlockFragment = isElement(first) && tr.registry.node(first.type)?.kind !== 'inline'

  if (!isBlockFragment) return { out: caret(insertInline(tr, point, nodes)) }
  const opaque = (n: Node): boolean => isElement(n) && isOpaque(n, tr.registry)
  if (nodes.length === 1) {
    // A lone opaque block (e.g. a copied node selection) goes in whole, as a block of its own.
    if (!opaque(first)) return { out: caret(insertInline(tr, point, (first as ElementNode).children ?? [])) }
    const out = insertBlockNodeStep(tr, first as ElementNode, caret(point))
    return out === false ? { out: caret(point), failed: true } : { out }
  }
  // Opaque edge blocks have no children to merge into the split halves: pad the fragment with a
  // childless block on that side, so they are inserted whole as middle blocks.
  const pad: ElementNode = { id: '', type: '', data: {}, children: [] }
  const last = nodes[nodes.length - 1]!
  const blocks = [...(opaque(first) ? [pad] : []), ...nodes, ...(opaque(last) ? [pad] : [])]
  return { out: caret(insertBlocks(tr, point, blocks, freshId(used))) }
}

/**
 * Deletes every selection range (or only `at`, see `runStep` in `text.ts`), then inserts the same
 * `fragment` there; each caret ends after its inserted content. A node selection (without `at`; it is
 * always the only range) is replaced in place: the content goes where the node was, as typed text
 * does. Inserted elements get fresh ids where theirs already exist in the doc (an earlier copy's
 * included) or repeat within the fragment, so every copy has its own. Pasted texts keep their own
 * marks. Returns false without a target; an empty fragment only deletes (true when something was
 * deleted). Inside a `forEachRange` callback pass the callback's range as `at` (a call without one
 * throws in dev mode).
 */
export function insertFragment(tr: Transaction, fragment: Fragment, at?: SelectionRange | Range): boolean {
  let failed = false
  const did = runStep(tr, at, (range) => {
    const step = insertFragmentStep(tr, fragment, range, !at)
    if (step.failed) failed = true
    return step.out
  })
  return did && !failed
}
