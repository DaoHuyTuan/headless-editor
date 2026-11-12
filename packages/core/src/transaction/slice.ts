import { recordIds, replayIds, createId } from '../model/id'
import { isOpaque } from '../model/editable'
import { deepEqualJson, getNode, isElement, isText } from '../model/node'
import { parentPath, toRange } from '../model/path'
import { isNodeRange, mainRange } from '../model/selection'
import type { DeepReadonly, Doc, ElementNode, Node, Path, Point, Range, SelectionRange } from '../model/types'
import { textOnly } from '../normalize'
import type { Registry } from '../plugin/registry'
import type { ContentMatch } from '../schema/content-match'
import { bannedMarks, fits, hasNewline, matchChild } from '../schema/validate'
import {
  docIds,
  endOfInserted,
  freshId,
  getFragment,
  insertFragmentStep,
  withUniqueIds,
  type Fragment,
  type FragmentStep,
} from './fragment'
import { ordered } from './ranges'
import { blockPathOf, deleteRangeStep, replaceNodeStep, runStep, splitBlockAt } from './text'
import { Transaction } from './transaction'

/**
 * Copied content with its context (spec §5.4): `content` is the content of a range below the
 * deepest node holding both of its ends, and `openStart` / `openEnd` how many levels of block
 * elements are cut open at each end (a range across two list items: both items, open at depth 2 at
 * each end). A slice of inline content is open at depth 0.
 */
export interface Slice {
  content: Fragment
  openStart: number
  openEnd: number
}

type ReadDoc = DeepReadonly<Doc>

/** Unknown element types count as blocks (as in `insertFragment`). */
function isBlockNode(node: DeepReadonly<Node> | undefined, registry: Registry): node is ElementNode {
  return !!node && isElement(node as Node) && registry.node((node as ElementNode).type)?.kind !== 'inline'
}

/** A registered non-atom block that is not a textblock: it holds blocks. */
function isContainer(node: Node, registry: Registry): node is ElementNode {
  if (!isElement(node)) return false
  const spec = registry.node(node.type)
  return !!spec && spec.kind === 'block' && !spec.atom && !registry.isTextblock(node.type)
}

function childrenOf(doc: ReadDoc, path: Path): readonly DeepReadonly<Node>[] {
  if (path.length === 0) return doc.children
  return (getNode(doc, path) as DeepReadonly<ElementNode>).children ?? []
}

function typeOf(doc: ReadDoc, path: Path): string {
  return path.length === 0 ? 'doc' : (getNode(doc, path) as DeepReadonly<ElementNode>).type
}

/** How deep `node` can be open on `side`: down its edge children to a textblock, through containers only. */
function maxOpen(node: Node | undefined, side: 'start' | 'end', registry: Registry): number {
  if (!isBlockNode(node, registry) || isOpaque(node, registry)) return 0
  if (registry.isTextblock(node.type)) return 1
  const kids = node.children ?? []
  return 1 + maxOpen(side === 'start' ? kids[0] : kids[kids.length - 1], side, registry)
}

/** `slice` with its open depths clamped to what its content can support (whole numbers, 0 for inline content). */
export function clampSlice(slice: Slice, registry: Registry): Slice {
  const { content } = slice
  const depth = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0)
  if (!isBlockNode(content[0], registry)) return { content, openStart: 0, openEnd: 0 }
  return {
    content,
    openStart: Math.min(depth(slice.openStart), maxOpen(content[0], 'start', registry)),
    openEnd: Math.min(depth(slice.openEnd), maxOpen(content[content.length - 1], 'end', registry)),
  }
}

/**
 * The slice `insertFragment` inserts a fragment as: open at depth 1 at an end whose block is a
 * textblock (it merges into the caret's block), 0 elsewhere and for inline content.
 */
export function fragmentSlice(content: Fragment, registry: Registry): Slice {
  if (!isBlockNode(content[0], registry)) return { content, openStart: 0, openEnd: 0 }
  const edge = (n: Node) => (registry.isTextblock((n as ElementNode).type) ? 1 : 0)
  return { content, openStart: edge(content[0]!), openEnd: edge(content[content.length - 1]!) }
}

/** Whether `slice` has the open depths of its content as a plain fragment (`fragmentSlice`). */
export function hasFragmentDepths(slice: Slice, registry: Registry): boolean {
  const plain = fragmentSlice(slice.content, registry)
  return plain.openStart === slice.openStart && plain.openEnd === slice.openEnd
}

/**
 * The slice of `range` (points in either order), with the path of the deepest node holding both
 * ends (`ancestor`; the doc is `[]`). With `node` (a node selection's node), that node alone,
 * closed. A collapsed range gives an empty slice.
 */
export function sliceAt(doc: ReadDoc, registry: Registry, range: Range, node?: Path): { slice: Slice; ancestor: Path } {
  if (node) return { slice: { content: getFragment(doc, range, node), openStart: 0, openEnd: 0 }, ancestor: parentPath(node) }
  const { start, end } = ordered(range)
  const content = getFragment(doc, range)
  let depth = 0
  while (depth < start.path.length && depth < end.path.length && start.path[depth] === end.path[depth]) depth++
  const ancestor = start.path.slice(0, depth)
  if (!isBlockNode(content[0], registry)) return { slice: { content, openStart: 0, openEnd: 0 }, ancestor }
  /** The block elements cut open between the common ancestor and the text at `p`. */
  const open = (p: Point) => {
    let n = 0
    for (let d = depth + 1; d < p.path.length; d++) if (isBlockNode(getNode(doc, p.path.slice(0, d)), registry)) n++
    return n
  }
  return { slice: clampSlice({ content, openStart: open(start), openEnd: open(end) }, registry), ancestor }
}

/**
 * `tr.getSlice`: the slice of `range`, by default of the main selection range (a node range gives
 * its node, closed). Acts on the main range on purpose: a slice is one piece of content. Empty
 * without a selection or for a collapsed range.
 */
export function getSlice(tr: Transaction, range?: Range): Slice {
  if (range) return sliceAt(tr.doc, tr.registry, range).slice
  const sel = tr.selection
  if (!sel) return { content: [], openStart: 0, openEnd: 0 }
  const main = mainRange(sel)
  return sliceAt(tr.doc, tr.registry, toRange(main), isNodeRange(main) ? main.node : undefined).slice
}

/**
 * Drops the outer levels a slice of one node open at both ends only cuts through: its content is
 * that node's children, one level less open. Stops at a textblock unless `textblocks`.
 */
function reduce(slice: Slice, registry: Registry, textblocks: boolean): Slice {
  let { content, openStart, openEnd } = slice
  while (content.length === 1 && openStart > 0 && openEnd > 0) {
    const only = content[0]!
    if (!isElement(only) || (!textblocks && registry.isTextblock(only.type))) break
    content = only.children ?? []
    openStart--
    openEnd--
  }
  return { content, openStart, openEnd }
}

/**
 * Whether today's fragment insert (`insertFragmentStep`) applies: inline or empty content, or flat
 * blocks (textblocks and opaque blocks, no container) with the open depths of a fragment, going into
 * a root block of a doc that accepts them there. Every flat document keeps its exact behaviour.
 */
function flatFits(tr: Transaction, slice: Slice, sel: SelectionRange, nodeEdit: boolean): boolean {
  const { registry } = tr
  const { content } = slice
  if (!isBlockNode(content[0], registry)) return true
  if (!hasFragmentDepths(slice, registry) || content.some((n) => isContainer(n, registry))) return false
  const node = nodeEdit && isNodeRange(sel) ? sel.node : blockPathOf(tr, toRange(sel).start.path)
  if (node.length !== 1) return false
  const kids = tr.doc.children
  const i = node[0]!
  const stub = { id: '', type: typeOf(tr.doc, node), data: {}, children: [] }
  return !fits(registry, 'doc', kids) || fits(registry, 'doc', [...kids.slice(0, i), stub, ...content, stub, ...kids.slice(i + 1)])
}

/** One way to fit a slice at a caret: merge depth at the start and at the end, and how many levels are split. */
interface Fit {
  s: number
  e: number
  k: number
}

/**
 * The ways to fit `slice` at the textblock `blockPath`, in the order they are tried. An end merges
 * (depth `n` > 0) only when its whole open chain lines up with the textblock and its ancestors: the
 * innermost open node is a textblock and every open node above it has the type of the ancestor at
 * its level, none isolating (two list items merge into a list item, not into a root paragraph).
 * Then: both ends merged (same depth), the start only, the end only, and last both ends closed,
 * splitting 1, 2, … levels (never an isolating node), the nearest level first.
 */
function fitsToTry(tr: Transaction, slice: Slice, blockPath: Path): Fit[] {
  const { registry, doc } = tr
  const D = blockPath.length
  const { content } = slice
  const aligned = (side: 'start' | 'end'): number => {
    const depth = side === 'start' ? slice.openStart : slice.openEnd
    if (depth < 1 || depth > D) return 0
    let node: Node | undefined = side === 'start' ? content[0] : content[content.length - 1]
    for (let j = 1; j < depth; j++) {
      const type = typeOf(doc, blockPath.slice(0, D - depth + j))
      if (!node || !isElement(node) || node.type !== type || registry.isIsolating(type) || !registry.contentMatch(type)) return 0
      const kids: Node[] = node.children ?? []
      node = side === 'start' ? kids[0] : kids[kids.length - 1]
    }
    return node && isElement(node) && registry.isTextblock(node.type) ? depth : 0
  }
  const s = aligned('start')
  const e = aligned('end')
  const out: Fit[] = []
  if (s && e && s === e) out.push({ s, e, k: s })
  if (s) out.push({ s, e: 0, k: s })
  if (e) out.push({ s: 0, e, k: e })
  for (let k = 1; k <= D; k++) {
    if (k > 1) {
      const type = typeOf(doc, blockPath.slice(0, D - k + 1))
      if (registry.isIsolating(type) || !registry.contentMatch(type)) break
    }
    out.push({ s: 0, e: 0, k })
  }
  return out
}

/** Whether the node holds nothing but empty texts, at any depth (no inline element, no opaque node). */
function isEmptyTree(node: DeepReadonly<Node>, registry: Registry): boolean {
  if (isText(node as Node)) return (node as { text: string }).text === ''
  const el = node as ElementNode
  if (!isBlockNode(el, registry) || isOpaque(el, registry)) return false
  return (el.children ?? []).every((c) => isEmptyTree(c, registry))
}

/** Whether `node` and its whole subtree are valid: content matches, marks allowed, `\n` only in text-only content. */
function validNode(node: DeepReadonly<Node>, registry: Registry): boolean {
  if (isText(node as Node)) return true
  const el = node as DeepReadonly<ElementNode>
  const spec = registry.node(el.type)
  if (!spec || spec.atom) return true
  const kids = el.children ?? []
  return (
    fits(registry, el.type, kids) &&
    !bannedMarks(registry, el.type, kids) &&
    (textOnly(el.type, registry) || !hasNewline(kids)) &&
    kids.every((k) => validNode(k, registry))
  )
}

/** Appends the open node `node`'s content to the element at `path` (its counterpart), `levels` deep along last children. */
function mergeBack(tr: Transaction, path: Path, node: ElementNode, levels: number): void {
  const kids = node.children ?? []
  const len = childrenOf(tr.doc, path).length
  if (levels > 1) mergeBack(tr, [...path, len - 1], kids[0] as ElementNode, levels - 1)
  const rest = levels > 1 ? kids.slice(1) : kids
  rest.forEach((c, j) => tr.insertNode([...path, len + j], c))
}

/**
 * Prepends the open node `node`'s content to the element at `path`, `levels` deep along first
 * children. Returns the innermost element's path and the inline nodes prepended to it.
 */
function mergeFront(tr: Transaction, path: Path, node: ElementNode, levels: number): { path: Path; kids: Node[] } {
  const kids = node.children ?? []
  if (levels === 1) {
    kids.forEach((c, j) => tr.insertNode([...path, j], c))
    return { path, kids }
  }
  const inner = mergeFront(tr, [...path, 0], kids[kids.length - 1] as ElementNode, levels - 1)
  const rest = kids.slice(0, -1)
  rest.forEach((c, j) => tr.insertNode([...path, j], c))
  const at = [...inner.path]
  at[path.length]! += rest.length
  return { path: at, kids: inner.kids }
}

const knownIn = (registry: Registry) => (t: string) => t === 'text' || !!registry.node(t)

/**
 * `first` and the nodes after it in `queue` that fit with it, wrapped into the containers `state`
 * needs to hold them (`findWrapping`), each completed with what its content lacks. Takes the queued
 * nodes it holds from `queue`. Null when there is no such wrapping.
 */
function wrapRun(registry: Registry, state: ContentMatch, first: ElementNode, queue: Node[]): ElementNode | null {
  const chain = state.findWrapping(first.type)
  if (!chain || chain.length === 0) return null
  const known = knownIn(registry)
  const innerType = chain[chain.length - 1]!
  let inner = matchChild(registry.contentMatch(innerType)!, first, registry)
  if (!inner) return null
  const group: Node[] = [first]
  let taken = 0
  for (const next of queue) {
    const after = matchChild(inner, next, registry)
    if (!after || matchChild(state, next, registry)) break
    inner = after
    group.push(next)
    taken++
  }
  const build = (type: string, children: Node[], rest: string[] | null): ElementNode | null => {
    const result = registry.validateData(type, {})
    if (!result.ok || !rest) return null
    for (const t of rest) {
      const filled = t === 'text' ? { text: '', marks: [] } : registry.createAndFill(t)
      if (!filled) return null
      children.push(filled)
    }
    return { id: createId(), type, data: result.data, children }
  }
  let node = build(innerType, group, inner.fillBefore([], true, known))
  for (let k = chain.length - 2; k >= 0 && node; k--) {
    const type = chain[k]!
    node = build(type, [node], registry.contentMatch(type)?.matchTypes([node.type], known)?.fillBefore([], true, known) ?? null)
  }
  if (node) queue.splice(0, taken)
  return node
}

/**
 * `nodes` as they can go at child `index` of the element (or doc) at `parent`: each node its
 * content match accepts there as is; else wrapped, with the nodes after it that fit along
 * (`wrapRun`: two list items become a list); else, for a container, its children instead
 * (unwrapped one level, then retried). Null when a node fits in none of these ways.
 */
function place(tr: Transaction, parent: Path, index: number, nodes: Node[]): Node[] | null {
  const { registry } = tr
  let state: ContentMatch | null = registry.contentMatch(typeOf(tr.doc, parent)) ?? null
  for (const k of childrenOf(tr.doc, parent).slice(0, index)) state = state && matchChild(state, k, registry)
  if (!state) return null
  const out: Node[] = []
  const queue = [...nodes]
  while (queue.length > 0) {
    const n = queue.shift()!
    const next: ContentMatch | null = matchChild(state, n, registry)
    if (next) {
      out.push(n)
      state = next
      continue
    }
    const wrapped: ElementNode | null = isElement(n) ? wrapRun(registry, state, n, queue) : null
    if (wrapped) {
      out.push(wrapped)
      state = state.matchType(wrapped.type)!
      continue
    }
    if (isContainer(n, registry) && (n.children ?? []).length > 0) {
      queue.unshift(...n.children!)
      continue
    }
    return null
  }
  return out
}

/**
 * Fits block `slice` at `point` in the textblock `blockPath` the way `fit` says (see `fitsToTry`):
 * 1. the textblock and its `k - 1` nearest ancestors are split at the point;
 * 2. a merged end's open content goes into the halves on its side, level by level (the start's
 *    appended to the left halves, the end's prepended to the right ones);
 * 3. the other nodes go between the halves, wrapped or unwrapped where the content match needs it
 *    (`place`);
 * 4. a half left empty beside a closed end is removed when its parent stays valid without it.
 * As in `insertFragment`, a textblock end does not merge into a single-level half that is empty and
 * of another type or data (it goes in whole). Returns the caret (the end of the inserted content),
 * or null when a step fails or the result is not valid (the caller drops the ops: this runs on a
 * dry-run transaction first).
 */
function fitAt(tr: Transaction, slice: Slice, point: Point, blockPath: Path, fit: Fit): Point | null {
  const { registry } = tr
  let { s, e } = fit
  const { k } = fit
  const D = blockPath.length
  const block = getNode(tr.doc, blockPath) as ElementNode
  const used = docIds(tr)
  const nodes = withUniqueIds(slice.content, used)
  const newId = () => {
    const id = freshId(used)
    used.add(id)
    return id
  }
  const rightStart = splitBlockAt(tr, point, blockPath, { id: newId(), type: block.type, data: block.data }, newId)
  for (let j = 1; j < k; j++) {
    const path = blockPath.slice(0, D - j)
    const node = getNode(tr.doc, path) as ElementNode
    tr.apply({ type: 'split_node', path, position: blockPath[D - j]! + 1, properties: { id: newId(), type: node.type, data: node.data } })
  }
  const parent = blockPath.slice(0, D - k)
  const i = blockPath[D - k]!
  const leftTop = [...parent, i]
  const rightTop = [...parent, i + 1]
  const first = nodes[0] as ElementNode
  const last = nodes[nodes.length - 1] as ElementNode
  if (k === 1) {
    const sameKind = (n: ElementNode) => n.type === block.type && deepEqualJson(n.data, block.data)
    if (s && isEmptyTree(getNode(tr.doc, leftTop), registry) && !sameKind(first)) s = 0
    if (e && isEmptyTree(getNode(tr.doc, rightTop), registry) && !sameKind(last)) e = 0
  }

  let rightInner: Path = [...rightTop, ...blockPath.slice(D - k + 1).map(() => 0)]
  let lastKids: Node[] = []
  if (e) ({ path: rightInner, kids: lastKids } = mergeFront(tr, rightTop, last, k))
  if (s) mergeBack(tr, leftTop, first, k)
  const middle = nodes.slice(s ? 1 : 0, e ? nodes.length - 1 : nodes.length)
  const placed = place(tr, parent, i + 1, middle)
  if (!placed) return null
  placed.forEach((n, j) => tr.insertNode([...parent, i + 1 + j], n))
  if (tr.rejected !== null) return null
  rightInner[parent.length] = i + 1 + placed.length

  const lastPlaced = placed[placed.length - 1]
  const end =
    !e && lastPlaced && !(isElement(lastPlaced) && isOpaque(lastPlaced, registry))
      ? endOfInserted(placed, parent, i + 1, registry)
      : null
  const fitsWithout = (index: number) => {
    const kids = childrenOf(tr.doc, parent)
    return fits(registry, typeOf(tr.doc, parent), [...kids.slice(0, index), ...kids.slice(index + 1)])
  }
  let count = 2 + placed.length
  const rightIndex = i + 1 + placed.length
  if (end && isEmptyTree(getNode(tr.doc, [...parent, rightIndex]), registry) && fitsWithout(rightIndex)) {
    tr.removeNode([...parent, rightIndex])
    count--
  }
  let shift = 0
  if (!s && isEmptyTree(getNode(tr.doc, leftTop), registry) && fitsWithout(i)) {
    tr.removeNode(leftTop)
    shift = 1
    count--
  }

  const kids = childrenOf(tr.doc, parent)
  if (!fits(registry, typeOf(tr.doc, parent), kids)) return null
  for (let n = i; n < i + count; n++) if (!validNode(kids[n]!, registry)) return null

  const remainder: Point = { path: [...rightInner, lastKids.length, ...rightStart.path.slice(D + 1)], offset: 0 }
  const caret = end ?? (e ? (endOfInserted(lastKids, rightInner, 0, registry) ?? remainder) : remainder)
  const path = [...caret.path]
  path[parent.length]! -= shift
  return { path, offset: caret.offset }
}

/**
 * One try of the fitter at `sel` (dry run or replay): the node range is replaced by an empty
 * default block, the range deleted, then `fitsToTry(...)[index]` is fitted at the caret. `'none'`
 * when there is no such try (or no textblock to fit into).
 */
function fitTry(tr: Transaction, slice: Slice, sel: SelectionRange, nodeEdit: boolean, index: number): Point | null | 'none' {
  let target = sel
  if (nodeEdit && isNodeRange(sel)) {
    const out = replaceNodeStep(tr, sel, { text: '' })
    if (!out) return 'none'
    target = out
  }
  const range = toRange(target)
  const point = deleteRangeStep(tr, range) ?? range.start
  const blockPath = blockPathOf(tr, point.path)
  if (!tr.registry.isTextblock(typeOf(tr.doc, blockPath))) return 'none'
  const fit = fitsToTry(tr, slice, blockPath)[index]
  return fit ? fitAt(tr, slice, point, blockPath, fit) : 'none'
}

/**
 * The fitter at one range: each way to fit (`fitsToTry`) is tried on a copy of the doc first, and
 * the first that gives a valid result is replayed on `tr` with the same ids. When none does,
 * nothing happens (false, no ops; a rejected node's data leaves the tr rejected).
 */
function fitStep(tr: Transaction, slice: Slice, sel: SelectionRange, nodeEdit: boolean): FragmentStep {
  let rejected: string | null = null
  for (let index = 0; ; index++) {
    const probe = new Transaction({ doc: tr.doc, selection: null, storedMarks: tr.storedMarks, pluginStates: new Map() }, tr.registry)
    const ids: string[] = []
    const tried = recordIds(ids, () => fitTry(probe, slice, sel, nodeEdit, index))
    if (tried === 'none') break
    if (probe.rejected !== null) rejected ??= probe.rejected
    if (tried === null || probe.rejected !== null) continue
    const out = replayIds(ids, () => fitTry(tr, slice, sel, nodeEdit, index))
    if (out === null || out === 'none') return { out: false, failed: true }
    return { out: { anchor: out, focus: out } }
  }
  if (rejected !== null) tr.rejected = rejected
  return { out: false, failed: true }
}

/**
 * `insertSlice` at one range. Inline content, and flat blocks with a fragment's open depths going
 * into a root block (`flatFits`), take today's fragment insert; anything else goes through the
 * fitter (`fitStep`).
 */
export function insertSliceStep(tr: Transaction, input: Slice, sel: SelectionRange, nodeEdit: boolean): FragmentStep {
  const { registry } = tr
  let slice = reduce(clampSlice(input, registry), registry, false)
  if (flatFits(tr, slice, sel, nodeEdit)) return insertFragmentStep(tr, slice.content, sel, nodeEdit)
  slice = reduce(slice, registry, true)
  if (!isBlockNode(slice.content[0], registry)) return insertFragmentStep(tr, slice.content, sel, nodeEdit)
  return fitStep(tr, slice, sel, nodeEdit)
}

/**
 * Deletes every selection range (or only `at`, see `runStep` in `text.ts`), then fits `slice` there
 * (spec §5.4); each caret ends after its inserted content. The open content at each end merges into
 * the textblock at the caret when its open nodes line up with the caret's ancestors (two list items
 * pasted into a list item's paragraph), whole nodes go where the content match accepts them, wrapped
 * (`findWrapping`: list items pasted into a root paragraph become a list) or unwrapped when needed.
 * Open depths are clamped to what the content supports. A node selection (without `at`) is replaced
 * in place. Inserted elements get fresh ids where theirs already exist. Valid result or no ops: a
 * range where the slice fits nowhere is left as it is and the result is false. Inside a
 * `forEachRange` callback pass the callback's range as `at`.
 */
export function insertSlice(tr: Transaction, slice: Slice, at?: SelectionRange | Range): boolean {
  let failed = false
  const did = runStep(tr, at, (range) => {
    const step = insertSliceStep(tr, slice, range, !at)
    if (step.failed) failed = true
    return step.out
  })
  return did && !failed
}
