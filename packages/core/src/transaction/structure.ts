import { createId } from '../model/id'
import { cloneJson, deepEqualJson, getNode, isElement, isText, sameMarkSet } from '../model/node'
import { comparePath, nextPath, parentPath, pathEquals, previousPath, toRange } from '../model/path'
import type { Data, DeepReadonly, Doc, ElementNode, Mark, Node, Path, Point, Range, SelectionRange, TextNode } from '../model/types'
import { textOnly } from '../normalize'
import type { Registry } from '../plugin/registry'
import { bannedMarks, fits, hasNewline } from '../schema/validate'
import { mapSince } from './ranges'
import { runStep, splitBlockAt } from './text'
import type { Transaction } from './transaction'

/**
 * Structural transforms (spec §5.3): wrap, lift, setBlockType, split and join. Each is a composite of
 * the existing node ops (`insert_node`, `move_node`, `remove_node`, `split_node`, `merge_node`, marks)
 * and checks the result against the content matches **before** emitting anything: it produces a
 * valid document itself, or emits no ops and returns false (never relying on normalization).
 *
 * `wrap`, `lift` and `setBlockType` are per-range steps run by `runStep` (at every selection range,
 * or only at an explicit one); `split` and `join` act at the position they are given.
 */

type ReadDoc = DeepReadonly<Doc>
type ReadNode = DeepReadonly<Node>

/** The blocks a range covers: children `[start, end)` of the element (or the doc, `[]`) at `parent`. */
export interface BlockRange {
  parent: Path
  start: number
  end: number
}

/** A stand-in element of `type`, for content checks that only read types. */
function stub(type: string): ElementNode {
  return { id: '', type, data: {}, children: [] }
}

function childrenAt(doc: ReadDoc, path: Path): readonly ReadNode[] {
  if (path.length === 0) return doc.children
  return (getNode(doc, path) as DeepReadonly<ElementNode>).children ?? []
}

function typeAt(doc: ReadDoc, path: Path): string {
  return path.length === 0 ? 'doc' : (getNode(doc, path) as DeepReadonly<ElementNode>).type
}

/**
 * The nearest block-level element on `path` (unknown element types count as blocks), the node at
 * `path` itself included when `self`; null when there is none.
 */
function blockAt(doc: ReadDoc, registry: Registry, path: Path, self: boolean): Path | null {
  for (let depth = self ? path.length : path.length - 1; depth >= 1; depth--) {
    const p = path.slice(0, depth)
    const node = getNode(doc, p)
    if (isElement(node) && registry.node(node.type)?.kind !== 'inline') return p
  }
  return null
}

/** The start and end blocks of `range` (a node range: its node's block, twice). */
function edgeBlocks(doc: ReadDoc, registry: Registry, range: Range | SelectionRange): [Path, Path] | null {
  if ('node' in range && range.node) {
    const block = blockAt(doc, registry, range.node, true)
    return block && [block, block]
  }
  const r = 'anchor' in range ? toRange(range) : range
  const a = blockAt(doc, registry, r.start.path, false)
  const b = blockAt(doc, registry, r.end.path, false)
  return a && b ? [a, b] : null
}

/**
 * The blocks `range` covers at the deepest level where they are siblings: the block of each end, or
 * the children of their deepest common ancestor that hold them. Null when an end is in no block.
 */
export function blockRange(doc: ReadDoc, registry: Registry, range: Range | SelectionRange): BlockRange | null {
  const edges = edgeBlocks(doc, registry, range)
  if (!edges) return null
  const [a, b] = edges
  if (pathEquals(a, b)) return { parent: parentPath(a), start: a[a.length - 1]!, end: a[a.length - 1]! + 1 }
  let c = 0
  const max = Math.min(a.length, b.length) - 1
  while (c < max && a[c] === b[c]) c++
  return { parent: a.slice(0, c), start: a[c]!, end: b[c]! + 1 }
}

/** The ranges a check reads: `range`, else every selection range. */
function rangesOf(tr: Transaction, range?: SelectionRange): readonly SelectionRange[] {
  return range ? [range] : (tr.selection?.ranges ?? [])
}

/** Ids of the element blocks of `br`, for skipping blocks an earlier range of the same call already moved. */
function blockIds(doc: ReadDoc, br: BlockRange): string[] {
  return childrenAt(doc, br.parent)
    .slice(br.start, br.end)
    .flatMap((n) => (isElement(n) ? [n.id] : []))
}

// ---- wrap ----

/**
 * The wrapper types (outermost first: `type`, then the inner wrappers `findWrapping` gives for the
 * first block) that wrap the blocks of `br` validly, or null. `type` must fit directly where the
 * blocks are (no outer wrappers are added: a list item is never wrapped into a list on its own),
 * each wrapper must be complete holding the next one, and the innermost must be complete holding
 * the blocks.
 */
function wrapping(doc: ReadDoc, registry: Registry, type: string, br: BlockRange): string[] | null {
  const spec = registry.node(type)
  const match = registry.contentMatch(type)
  if (!spec || !match || registry.isTextblock(type)) return null
  const siblings = childrenAt(doc, br.parent)
  const blocks = siblings.slice(br.start, br.end)
  const first = blocks[0]
  const inner = first && isElement(first) && registry.node(first.type) ? match.findWrapping(first.type) : []
  if (!inner) return null
  const chain = [type, ...inner]
  const around = [...siblings.slice(0, br.start), stub(type), ...siblings.slice(br.end)]
  if (!fits(registry, typeAt(doc, br.parent), around)) return null
  for (let k = 0; k < chain.length - 1; k++) if (!fits(registry, chain[k]!, [stub(chain[k + 1]!)])) return null
  return fits(registry, chain[chain.length - 1]!, blocks) ? chain : null
}

/** Whether `wrap(type)` would change something at `range` (default: at some selection range). */
export function canWrap(tr: Transaction, type: string, range?: SelectionRange): boolean {
  return rangesOf(tr, range).some((r) => {
    const br = blockRange(tr.doc, tr.registry, r)
    return !!br && wrapping(tr.doc, tr.registry, type, br) !== null
  })
}

/**
 * Wraps the blocks of every selection range (or only `range`, see `runStep`) into `type` with
 * `data` (validated; invalid data sets `rejected` and changes nothing), adding the inner wrappers
 * `findWrapping` gives (a paragraph wrapped in a list gets a list item). The blocks are moved, so
 * every range keeps its place in them. A range whose blocks an earlier range already wrapped does
 * nothing. False (no ops) when the schema allows it nowhere.
 */
export function wrap(tr: Transaction, type: string, data?: Data, range?: SelectionRange): boolean {
  const done = new Set<string>()
  return runStep(tr, range, (r) => {
    const br = blockRange(tr.doc, tr.registry, r)
    if (!br) return false
    const ids = blockIds(tr.doc, br)
    if (ids.some((id) => done.has(id))) return false
    const chain = wrapping(tr.doc, tr.registry, type, br)
    if (!chain) return false
    const datas: Data[] = []
    for (const [k, t] of chain.entries()) {
      const result = tr.registry.validateData(t, k === 0 ? (data ?? {}) : {})
      if (!result.ok) {
        tr.rejected = result.message
        return false
      }
      datas.push(cloneJson(result.data))
    }
    let wrapper: ElementNode | null = null
    for (let k = chain.length - 1; k >= 0; k--)
      wrapper = { id: createId(), type: chain[k]!, data: datas[k]!, children: wrapper ? [wrapper] : [] }
    const from = tr.ops.length
    const at = [...br.parent, br.start]
    const inner = [...at, ...chain.slice(1).map(() => 0)]
    tr.apply({ type: 'insert_node', path: at, node: wrapper! })
    for (let k = 0; k < br.end - br.start; k++)
      tr.apply({ type: 'move_node', path: nextPath(at), newPath: [...inner, k] })
    for (const id of ids) done.add(id)
    return mapSince(tr, r, from)
  })
}

// ---- lift ----

/**
 * Whether the blocks of `br` can move out of their container (the element at `br.parent`) into the
 * container's parent: the container is a known, non-isolating element; the parts of it left before
 * and after the blocks (each kept only when not empty) are complete; and the parent's content stays
 * valid with the blocks between them.
 */
function liftable(doc: ReadDoc, registry: Registry, br: BlockRange): boolean {
  const C = br.parent
  if (C.length === 0) return false
  const container = getNode(doc, C)
  if (!isElement(container) || !registry.contentMatch(container.type) || registry.isIsolating(container.type)) return false
  const kids = container.children ?? []
  const before = kids.slice(0, br.start)
  const after = kids.slice(br.end)
  if (before.length > 0 && !fits(registry, container.type, before)) return false
  if (after.length > 0 && !fits(registry, container.type, after)) return false
  const G = parentPath(C)
  const outer = childrenAt(doc, G)
  const at = C[C.length - 1]!
  const content = [
    ...outer.slice(0, at),
    ...(before.length > 0 ? [container] : []),
    ...kids.slice(br.start, br.end),
    ...(after.length > 0 ? [container] : []),
    ...outer.slice(at + 1),
  ]
  return fits(registry, typeAt(doc, G), content)
}

/**
 * Depth (ancestor path length) the blocks of `range` can be lifted to, or null (ProseMirror
 * `liftTarget` semantics, restricted to the nearest level). Only the parent of the blocks'
 * container is tried: a block is never carried past an ancestor that does not accept it, so a
 * paragraph first in a list item (which a list does not accept) cannot be lifted on its own, and
 * list plugins handle it with their own commands. Null at the root and out of an isolating node.
 */
export function liftTarget(doc: DeepReadonly<Doc>, registry: Registry, range: Range): number | null {
  const br = blockRange(doc, registry, range)
  return br && liftable(doc, registry, br) ? br.parent.length - 1 : null
}

/** Whether `lift()` would change something at `range` (default: at some selection range). */
export function canLift(tr: Transaction, range?: SelectionRange): boolean {
  return rangesOf(tr, range).some((r) => {
    const br = blockRange(tr.doc, tr.registry, r)
    return !!br && liftable(tr.doc, tr.registry, br)
  })
}

/**
 * Moves the blocks of every selection range (or only `range`, see `runStep`) out of their container
 * into its parent (`liftTarget`), splitting the container when the blocks are in its middle; a
 * container left empty is removed. Every range keeps its place in the moved blocks. A range whose
 * blocks an earlier range already lifted does nothing. False (no ops) when the lift is not valid.
 */
export function lift(tr: Transaction, range?: SelectionRange): boolean {
  const done = new Set<string>()
  return runStep(tr, range, (r) => {
    const br = blockRange(tr.doc, tr.registry, r)
    if (!br || !liftable(tr.doc, tr.registry, br)) return false
    const ids = blockIds(tr.doc, br)
    if (ids.some((id) => done.has(id))) return false
    const C = br.parent
    const container = getNode(tr.doc, C) as DeepReadonly<ElementNode>
    const count = (container.children ?? []).length
    const half = (): Partial<ElementNode> => ({ id: createId(), type: container.type, data: container.data as Data })
    const from = tr.ops.length
    if (br.end < count) tr.apply({ type: 'split_node', path: C, position: br.end, properties: half() })
    let at = C[C.length - 1]!
    if (br.start > 0) {
      tr.apply({ type: 'split_node', path: C, position: br.start, properties: half() })
      at++
    }
    const G = parentPath(C)
    // Each block leaves the front of the (moving) middle part for the place right before it.
    for (let k = 0; k < br.end - br.start; k++) tr.apply({ type: 'move_node', path: [...G, at + k, 0], newPath: [...G, at + k] })
    tr.removeNode([...G, at + br.end - br.start])
    for (const id of ids) done.add(id)
    return mapSince(tr, r, from)
  })
}

// ---- setBlockType ----

/**
 * The textblocks `range` touches, at any depth, in document order (a node range: its node when it
 * is a textblock).
 */
function textblocksIn(doc: ReadDoc, registry: Registry, range: SelectionRange): Path[] {
  const edges = edgeBlocks(doc, registry, range)
  if (!edges) return []
  const [a, b] = edges
  const out: Path[] = []
  const walk = (nodes: readonly ReadNode[], base: Path): void => {
    for (let i = 0; i < nodes.length; i++) {
      const path = [...base, i]
      if (comparePath(path, a) < 0) continue
      if (comparePath(path, b) > 0) break
      const n = nodes[i]!
      if (!isElement(n)) continue
      if (registry.isTextblock(n.type)) out.push(path)
      else if (registry.contentMatch(n.type)) walk(n.children ?? [], path)
    }
  }
  walk(doc.children, [])
  return out
}

/**
 * What `setBlockType(type, data)` does to the textblock at `path`: 'data' (same type, other data),
 * 'type' (a new node of `type`), or null (nothing: same markup, or the result would not be valid:
 * the parent does not accept `type` there, or `type` does not accept its inline content or `\n`).
 */
function conversion(doc: ReadDoc, registry: Registry, path: Path, type: string, data: Data | null): 'data' | 'type' | null {
  const node = getNode(doc, path) as DeepReadonly<ElementNode>
  if (node.type === type) return data !== null && !deepEqualJson(node.data as Data, data) ? 'data' : null
  const parent = parentPath(path)
  const siblings = childrenAt(doc, parent)
  const at = path[path.length - 1]!
  if (!fits(registry, typeAt(doc, parent), [...siblings.slice(0, at), stub(type), ...siblings.slice(at + 1)])) return null
  const kids = node.children ?? []
  if (!fits(registry, type, kids)) return null
  if (!textOnly(type, registry) && hasNewline(kids)) return null
  return 'type'
}

/** Whether `setBlockType(type)` would change some textblock at `range` (default: at some selection range). */
export function canSetBlockType(tr: Transaction, type: string, range?: SelectionRange): boolean {
  if (!tr.registry.isTextblock(type)) return false
  return rangesOf(tr, range).some((r) =>
    textblocksIn(tr.doc, tr.registry, r).some((path) => conversion(tr.doc, tr.registry, path, type, null) !== null),
  )
}

/** Replaces the marks of the text at `path` with `marks`. */
function setTextMarks(tr: Transaction, path: Path, from: readonly DeepReadonly<Mark>[], marks: readonly DeepReadonly<Mark>[]): void {
  for (const m of [...from].reverse()) tr.apply({ type: 'remove_mark', path, mark: m as Mark })
  for (const m of marks) tr.apply({ type: 'add_mark', path, mark: m as Mark })
}

/** Merges the text at `[...parent, i]` into the one before it (both texts, same marks). */
function mergeTexts(tr: Transaction, parent: Path, i: number): void {
  const kids = childrenAt(tr.doc, parent)
  const prev = kids[i - 1] as DeepReadonly<TextNode>
  const text = kids[i] as DeepReadonly<TextNode>
  tr.apply({ type: 'merge_node', path: [...parent, i], position: prev.text.length, properties: { marks: text.marks as Mark[] } })
}

/**
 * The textblock at `path` becomes a new node of `type` (fresh id, `data`) holding its children:
 * marks `type` does not allow are removed first, and texts left with the same marks merged.
 */
function convert(tr: Transaction, path: Path, type: string, data: Data): void {
  const node = getNode(tr.doc, path) as DeepReadonly<ElementNode>
  ;(node.children ?? []).forEach((c, i) => {
    if (!isText(c)) return
    const banned = c.marks.filter((m) => !tr.registry.allowsMark(type, m.type))
    for (const m of [...banned].reverse()) tr.apply({ type: 'remove_mark', path: [...path, i], mark: m as Mark })
  })
  for (let i = childrenAt(tr.doc, path).length - 1; i >= 1; i--) {
    const kids = childrenAt(tr.doc, path)
    const prev = kids[i - 1]!
    const c = kids[i]!
    if (isText(prev) && isText(c) && sameMarkSet(prev.marks as Mark[], c.marks as Mark[])) mergeTexts(tr, path, i)
  }
  const target = nextPath(path)
  tr.apply({ type: 'insert_node', path: target, node: { id: createId(), type, data: cloneJson(data), children: [] } })
  const count = childrenAt(tr.doc, path).length
  for (let k = 0; k < count; k++) tr.apply({ type: 'move_node', path: [...path, 0], newPath: [...target, k] })
  tr.removeNode(path)
}

/**
 * Changes the textblocks of every selection range (or only `range`, see `runStep`), at any depth,
 * to the textblock `type` with `data` (validated; invalid data sets `rejected` and changes nothing),
 * keeping their children and every range's place in them. A textblock of another type becomes a new
 * node (fresh id), without the marks `type` does not allow; one of the same type gets the new data.
 * A textblock the result would not be valid for is left as it is: its parent does not accept `type`
 * there, or `type` does not accept its inline elements or a `\n`. False (no ops) when nothing changed.
 */
export function setBlockType(tr: Transaction, type: string, data?: Data, range?: SelectionRange): boolean {
  if (!tr.registry.isTextblock(type)) return false
  const result = tr.registry.validateData(type, data ?? {})
  if (!result.ok) {
    tr.rejected = result.message
    return false
  }
  const checked = result.data
  return runStep(tr, range, (r) => {
    const from = tr.ops.length
    for (const path of textblocksIn(tr.doc, tr.registry, r)) {
      const how = conversion(tr.doc, tr.registry, path, type, checked)
      if (how === 'type') convert(tr, path, type, checked)
      else if (how === 'data') {
        const node = getNode(tr.doc, path) as DeepReadonly<ElementNode>
        tr.apply({ type: 'set_node_data', path, data: cloneJson(checked), prevData: node.data as Data })
      }
    }
    return tr.ops.length > from ? mapSince(tr, r, from) : false
  })
}

// ---- split ----

/**
 * Splits the textblock holding the text at `point` and its `depth - 1` nearest ancestors there (a
 * list item and its paragraph: depth 2). `typesAfter` gives the type (and data, validated) of each
 * new right-hand node, outermost first as in ProseMirror; a missing or null entry keeps the type and
 * data of the node split. Returns the start of the new innermost block, or null with no ops when
 * the result would not be valid: `depth` reaches the doc, an ancestor to split is isolating or
 * opaque, or a half (or the parent holding both halves) would not match its content. Invalid data
 * also sets `rejected`. It does not set the selection (ranges are mapped through the split).
 */
export function split(
  tr: Transaction,
  point: Point,
  depth = 1,
  typesAfter?: readonly ({ type: string; data?: Data } | null | undefined)[],
): Point | null {
  const { doc, registry } = tr
  let text: ReadNode
  try {
    text = getNode(doc, point.path)
  } catch {
    return null
  }
  if (!isText(text)) return null
  const blockPath = blockAt(doc, registry, point.path, false)
  if (!blockPath || !Number.isInteger(depth) || depth < 1 || depth > blockPath.length) return null
  const block = getNode(doc, blockPath) as DeepReadonly<ElementNode>
  if (!registry.isTextblock(block.type)) return null

  const props: Partial<ElementNode>[] = []
  let rightType = ''
  for (let j = 0; j < depth; j++) {
    const path = blockPath.slice(0, blockPath.length - j)
    const node = getNode(doc, path) as DeepReadonly<ElementNode>
    if (j > 0 && (!registry.contentMatch(node.type) || registry.isIsolating(node.type))) return null
    const entry = typesAfter?.[depth - 1 - j]
    let data = node.data as Data
    if (entry) {
      const result = registry.validateData(entry.type, entry.data ?? {})
      if (!result.ok) {
        tr.rejected = result.message
        return null
      }
      data = result.data
    }
    const type = entry ? entry.type : node.type
    const kids = node.children ?? []
    // The child split at this level counts on both sides; above the textblock, the right side
    // starts with the new node of the level below.
    const c = (j === 0 ? point.path : blockPath)[path.length]!
    const left = kids.slice(0, c + 1)
    const right = j === 0 ? kids.slice(c) : [stub(rightType), ...kids.slice(c + 1)]
    if (!fits(registry, node.type, left) || !fits(registry, type, right)) return null
    if (j === 0 && type !== node.type && (bannedMarks(registry, type, right) || (!textOnly(type, registry) && hasNewline(right))))
      return null
    props.push({ id: createId(), type, data })
    rightType = type
  }
  const outer = blockPath.slice(0, blockPath.length - depth + 1)
  const parent = parentPath(outer)
  const siblings = childrenAt(doc, parent)
  const at = outer[outer.length - 1]!
  if (!fits(registry, typeAt(doc, parent), [...siblings.slice(0, at + 1), stub(rightType), ...siblings.slice(at + 1)])) return null

  splitBlockAt(tr, point, blockPath, props[0]!)
  for (let j = 1; j < depth; j++) {
    const path = blockPath.slice(0, blockPath.length - j)
    tr.apply({ type: 'split_node', path, position: blockPath[path.length]! + 1, properties: props[j]! })
  }
  return { path: [...nextPath(outer), ...point.path.slice(outer.length).map(() => 0)], offset: 0 }
}

// ---- join ----

/**
 * Whether the node at `path` can be joined into its previous sibling: both are known, non-atom,
 * non-isolating elements; the previous one's content stays valid with the other's children appended
 * (two lists; a list and a quote do not join); the marks and `\n` of the moved texts are allowed;
 * and the parent stays valid without the node.
 */
export function canJoin(tr: Transaction, path: Path): boolean {
  return joinable(tr.doc, tr.registry, path)
}

function joinable(doc: ReadDoc, registry: Registry, path: Path): boolean {
  if (path.length === 0 || !Number.isInteger(path[path.length - 1]) || path[path.length - 1]! <= 0) return false
  const parent = parentPath(path)
  let siblings: readonly ReadNode[]
  try {
    siblings = childrenAt(doc, parent)
  } catch {
    return false
  }
  const at = path[path.length - 1]!
  const a = siblings[at - 1]
  const b = siblings[at]
  if (!a || !b || !isElement(a) || !isElement(b)) return false
  for (const n of [a, b]) if (!registry.contentMatch(n.type) || registry.isIsolating(n.type)) return false
  const moved = b.children ?? []
  if (!fits(registry, a.type, [...(a.children ?? []), ...moved])) return false
  if (bannedMarks(registry, a.type, moved) || (!textOnly(a.type, registry) && hasNewline(moved))) return false
  return fits(registry, typeAt(doc, parent), [...siblings.slice(0, at), ...siblings.slice(at + 1)])
}

/**
 * Joins the node at `path` into its previous sibling (`canJoin`): its children are appended to it.
 * Texts meeting at the seam are merged when they have the same marks, or when one is empty (it takes
 * the other's marks). Ranges keep their place. False (no ops) when the join is not valid.
 */
export function join(tr: Transaction, path: Path): boolean {
  if (!joinable(tr.doc, tr.registry, path)) return false
  const b = getNode(tr.doc, path) as DeepReadonly<ElementNode>
  const prev = previousPath(path)
  const position = childrenAt(tr.doc, prev).length
  tr.apply({ type: 'merge_node', path, position, properties: { id: b.id, type: b.type, data: b.data as Data } })
  if (position === 0) return true
  const kids = childrenAt(tr.doc, prev)
  const l = kids[position - 1]
  const r = kids[position]
  if (!l || !r || !isText(l) || !isText(r)) return true
  if (!sameMarkSet(l.marks as Mark[], r.marks as Mark[])) {
    if (r.text === '') setTextMarks(tr, [...prev, position], r.marks, l.marks)
    else if (l.text === '') setTextMarks(tr, [...prev, position - 1], l.marks, r.marks)
    else return true
  }
  mergeTexts(tr, prev, position)
  return true
}
