import { createId, recordIds, replayIds } from '../model/id'
import { editableTextEntries, isNodeSelection, isOpaque, nodeSelection } from '../model/editable'
import { getNode, isElement, isText, sameMarkSet } from '../model/node'
import { comparePath, comparePoint, isAncestorPath, nextPath, parentPath, pathEquals, pointEquals, toRange } from '../model/path'
import { isNodeRange, rangeEquals, single } from '../model/selection'
import type { Data, DeepReadonly, Doc, ElementNode, Mark, Node, Path, Point, Range, Selection, SelectionRange, TextNode } from '../model/types'
import { applyOp } from '../ops/apply'
import { transformPath } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { Registry } from '../plugin/registry'
import { bannedMarks, fits, hasNewline, missingContent, repeatedTypes } from '../schema/validate'
import { marksAtTr, marksOfRange } from './marks'
import { currentRange, flagSwallowed, forEachRange, inForEachRange, mapSince, setCurrentRange } from './ranges'
import { liftStep, split } from './structure'
import { Transaction } from './transaction'

/**
 * Text editing algorithms. Every change is an operation on `tr`; each returns whether it did anything.
 *
 * Each editing method is a per-range step (`…Step`: edits at one range and returns the range after
 * it, without setting the selection) run by `runStep`: at every selection range when no range is
 * given, else only at the given one (spec §5.2).
 */

export type DeleteUnit = 'character' | 'word' | 'line'

/** Orders the points: callers may pass a backward selection or an unordered range. */
function asRange(at: SelectionRange | Range): Range {
  return toRange(asSelectionRange(at))
}

function asSelectionRange(at: SelectionRange | Range): SelectionRange {
  return 'anchor' in at ? at : { anchor: at.start, focus: at.end }
}

function caret(point: Point): SelectionRange {
  return { anchor: point, focus: point }
}

/**
 * What a per-range step did: the range after it (null when it is gone), or false when it did nothing
 * (the range stays where it was).
 */
export type StepResult = SelectionRange | null | false

/** Whether two ranges overlap or touch. */
function touches(a: SelectionRange, b: SelectionRange): boolean {
  const r = toRange(a)
  const t = toRange(b)
  return comparePoint(r.start, t.end) <= 0 && comparePoint(t.start, r.end) <= 0
}

/** Index of the range of `sel` that overlaps or touches `target`: the main one if it does, else the first; else main. */
function touchedRange(sel: Selection, target: SelectionRange): number {
  if (touches(sel.ranges[sel.main]!, target)) return sel.main
  const i = sel.ranges.findIndex((range) => touches(range, target))
  return i >= 0 ? i : sel.main
}

/**
 * Runs `step` (spec §5.2) and returns whether it did anything:
 * - no `at`: at every selection range, through `forEachRange` (one tr, each range mapped through the
 *   earlier edits; the selection becomes the results, set once);
 * - `at`: only there. The selection range it touches (else the main one) becomes the result; the
 *   other ranges are mapped through the edit, not collapsed. With no selection, the result becomes it;
 * - inside a `forEachRange` callback: only at `at`, without setting the selection (the result is
 *   recorded as the callback's range). A call without `at` throws in dev mode (the edit would
 *   otherwise run at every range, once per callback); else it acts at the callback's range.
 */
export function runStep(
  tr: Transaction,
  at: SelectionRange | Range | undefined,
  edit: (range: SelectionRange) => StepResult,
): boolean {
  /**
   * The edit at `target`, replacing the selection range `range`. Stored marks are cleared when the
   * result is not where `range` maps to: exactly when a single-range `setSelection` of the result
   * would have cleared them.
   */
  const step = (target: SelectionRange, range: SelectionRange = target): StepResult => {
    const from = tr.ops.length
    const out = edit(target)
    if (out === false) return out
    const mapped = mapSince(tr, range, from)
    if (!out || !mapped || !rangeEquals(out, mapped)) tr.setStoredMarks(null)
    return out
  }
  if (inForEachRange(tr)) {
    let target = at && asSelectionRange(at)
    if (!target) {
      if (tr.dev) throw new Error('Inside forEachRange, pass the callback range to tr editing methods')
      target = currentRange(tr) ?? undefined
      if (!target) return false
    }
    // The result replaces the callback's range only when the edit is at it (overlaps or touches it);
    // an edit elsewhere leaves that range mapped through the edit.
    const live = currentRange(tr)
    const own = !!live && touches(live, target)
    const out = step(target, own ? live : target)
    if (out !== false && own) setCurrentRange(tr, out)
    return out !== false
  }
  const sel = tr.selection
  let did = false
  /** Runs the step at `target`; when it did nothing, `range` stays. */
  const run = (range: SelectionRange, target = range): SelectionRange | null => {
    const out = step(target, range)
    if (out === false) return range
    did = true
    return out
  }
  if (!at) {
    forEachRange(tr, (range) => run(range))
    return did
  }
  const target = asSelectionRange(at)
  if (!sel) {
    const out = run(target)
    if (did && out) tr.setSelection(single(out))
    return did
  }
  const index = touchedRange(sel, target)
  // The steps before `index` add no ops, so `target` is still in current coordinates when it runs.
  forEachRange(tr, (range, _tr, i) => (i === index ? run(range, target) : range))
  return did
}

function textAt(tr: Transaction, path: Path): TextNode {
  const n = getNode(tr.doc, path)
  if (!isText(n)) throw new Error(`Expected a text node at [${path}]`)
  // The doc's own node, typed as op payloads are (ops never mutate it).
  return n as TextNode
}

/** Path of the nearest block-level element containing `path` (unknown element types count as blocks). */
export function blockPathOf(tr: Transaction, path: Path): Path {
  for (let depth = path.length - 1; depth >= 1; depth--) {
    const p = path.slice(0, depth)
    const node = getNode(tr.doc, p)
    if (isElement(node) && tr.registry.node(node.type)?.kind !== 'inline') return p
  }
  throw new Error(`No block contains [${path}]`)
}

/**
 * Every editable text of the element at `blockPath`, with absolute paths, in document order (none
 * for an opaque element: unknown types and atoms).
 */
function blockTexts(tr: DocEditor, blockPath: Path): [TextNode, Path][] {
  const block = getNode(tr.doc, blockPath) as ElementNode
  return [...editableTextEntries(block, tr.registry)].map(([t, rel]) => [t, [...blockPath, ...rel]])
}

function firstPoint(texts: [TextNode, Path][]): Point | null {
  const first = texts[0]
  return first ? { path: first[1], offset: 0 } : null
}

function lastPoint(texts: [TextNode, Path][]): Point | null {
  const last = texts[texts.length - 1]
  return last ? { path: last[1], offset: last[0].text.length } : null
}

/** The marks text inserted at `point` gets: stored marks, else `marksAt` that caret. */
export function insertionMarks(tr: Transaction, point: Point): Mark[] {
  return marksAtTr(tr, point)
}

/**
 * Whether the element is an inline opaque element: a registered inline atom, or an unknown type
 * inside inline content (the parent `parentType` is an inline element or a textblock, whatever its
 * content expression says: `'inline'`, `'inline*'` or omitted). It counts as one character of its
 * inline content: no caret goes inside, edits remove it whole.
 */
export function isInlineOpaque(tr: Pick<DocEditor, 'registry'>, el: DeepReadonly<ElementNode>, parentType: string): boolean {
  const { registry } = tr
  const spec = registry.node(el.type)
  if (spec) return spec.kind === 'inline' && spec.atom === true
  const parent = registry.node(parentType)
  return !!parent && !parent.atom && (parent.kind === 'inline' || registry.isTextblock(parentType))
}

/** The inline opaque elements whose paths lie strictly between `start` and `end` (text paths), in document order. */
function inlineOpaqueBetween(tr: DocEditor, start: Point, end: Point): Path[] {
  const out: Path[] = []
  const walk = (nodes: readonly DeepReadonly<Node>[], base: Path, parentType: string) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const path = [...base, i]
      if (isText(n) || comparePath(path, start.path) < 0 || comparePath(path, end.path) > 0) continue
      if (isInlineOpaque(tr, n, parentType)) {
        // Neither edge can be inside it (no caret goes inside an opaque element).
        if (!isAncestorPath(path, start.path) && !isAncestorPath(path, end.path)) out.push(path)
      } else if (!isOpaque(n, tr.registry)) {
        walk(n.children ?? [], path, n.type)
      }
    }
  }
  walk(tr.doc.children, [], 'doc')
  return out
}

/**
 * Whether anything lies between the ordered points `a` and `b`: a block boundary, a character of
 * editable text, or an inline opaque element. False for two ways to write one position (the end of a
 * text leaf and the start of the next).
 */
function hasContentBetween(tr: Transaction, a: Point, b: Point): boolean {
  if (!pathEquals(blockPathOf(tr, a.path), blockPathOf(tr, b.path))) return true
  for (const [t, p] of editableTextEntries(tr.doc, tr.registry, { start: a, end: b })) {
    const from = pathEquals(p, a.path) ? a.offset : 0
    const to = pathEquals(p, b.path) ? b.offset : t.text.length
    if (to > from) return true
  }
  return inlineOpaqueBetween(tr, a, b).length > 0
}

/**
 * Removes the editable text between two points, text by text, and the inline opaque elements
 * (inline atoms) between them, whole. No other node is removed. Works last to first, so the paths
 * still to be handled (and `start`) stay valid.
 */
function removeTextBetween(tr: DocEditor, start: Point, end: Point): void {
  const texts = [...editableTextEntries(tr.doc, tr.registry, { start, end })]
  const edits: { path: Path; text?: TextNode }[] = [
    ...texts.map(([text, path]) => ({ path, text })),
    ...inlineOpaqueBetween(tr, start, end).map((path) => ({ path })),
  ].sort((a, b) => comparePath(a.path, b.path))
  for (let i = edits.length - 1; i >= 0; i--) {
    const { path: p, text: t } = edits[i]!
    if (!t) {
      tr.removeNode(p)
      continue
    }
    const from = pathEquals(p, start.path) ? start.offset : 0
    const to = pathEquals(p, end.path) ? end.offset : t.text.length
    if (to > from) tr.apply({ type: 'remove_text', path: p, offset: from, text: t.text.slice(from, to) })
  }
}

/**
 * `point` moved out of the outermost inline opaque element containing it (an unknown type in inline
 * content), to the end of the text before it (`'before'`) or the start of the text after it
 * (`'after'`); normalization keeps a text on each side (rule 10). Unchanged when it is in none.
 */
function outOfInlineOpaque(tr: Transaction, point: Point, side: 'before' | 'after'): Point {
  let parentType = 'doc'
  for (let depth = 1; depth < point.path.length; depth++) {
    const node = getNode(tr.doc, point.path.slice(0, depth))
    if (!isElement(node)) break
    if (isOpaque(node, tr.registry) && isInlineOpaque(tr, node, parentType)) {
      const index = point.path[depth - 1]!
      const at = [...point.path.slice(0, depth - 1), side === 'before' ? index - 1 : index + 1]
      const sibling = index + (side === 'before' ? -1 : 1) >= 0 ? getNodeOrNull(tr, at) : null
      if (!sibling || !isText(sibling)) return point
      return { path: at, offset: side === 'before' ? sibling.text.length : 0 }
    }
    parentType = node.type
  }
  return point
}

function getNodeOrNull(tr: Transaction, path: Path): DeepReadonly<Node> | null {
  try {
    return getNode(tr.doc, path)
  } catch {
    return null
  }
}

/**
 * The block a range edge at `path` belongs to: the outermost opaque (unknown or atom) block-level
 * element containing it, else the nearest block. An unknown type inside inline content is inline
 * there (`isInlineOpaque`), not an edge block: an edge inside it belongs to the block around it.
 */
function edgeBlockOf(tr: Transaction, path: Path): Path {
  let parentType = 'doc'
  for (let depth = 1; depth < path.length; depth++) {
    const p = path.slice(0, depth)
    const node = getNode(tr.doc, p)
    if (!isElement(node)) break
    if (isOpaque(node, tr.registry)) {
      // Inline: the block around it (`blockPathOf` would take an unknown type itself for a block).
      return isInlineOpaque(tr, node, parentType) ? blockPathOf(tr, p) : p
    }
    parentType = node.type
  }
  return blockPathOf(tr, path)
}

/**
 * The editable caret nearest to `at` (where a removed block was): the start of the first editable
 * text at or after it, else the end of the last one before it. With no editable text left, the
 * default node of that position (`defaultNodeAt`) is inserted at `at`.
 */
function caretNearRemovedBlock(tr: Transaction, at: Path): Point {
  let before: Point | null = null
  for (const [t, p] of editableTextEntries(tr.doc, tr.registry)) {
    if (comparePath(p, at) >= 0) return { path: p, offset: 0 }
    before = { path: p, offset: t.text.length }
  }
  if (before) return before
  return insertDefaultNode(tr, at)
}

/**
 * Deletes `range` (default: every selection range; a selected node is removed) and collapses each
 * caret at its start; with `range`, the other selection ranges are mapped (see `runStep`). False
 * when nothing was deleted.
 */
export function deleteRange(tr: Transaction, range?: SelectionRange | Range): boolean {
  return runStep(tr, range, (r) => {
    if (!range && isNodeRange(r)) return replaceNodeStep(tr, r, 'delete')
    const point = deleteRangeStep(tr, asRange(r))
    return point ? caret(point) : false
  })
}

/**
 * Deletes `range` and returns where its caret lands: its start (null when the range is empty). Across
 * sibling blocks the start block keeps its id: its tail and the end block's head are removed, the
 * blocks in between are removed, and the end block is merged into the start block.
 *
 * Across blocks with different parents (nested content, spec §5.3) it is a replace that produces a
 * valid document itself (`planNestedDelete`): nodes covered whole at any depth are removed, the end
 * textblock's content joins the start textblock, containers left empty are removed or refilled, and
 * isolating nodes (table cells) are never merged or removed.
 *
 * An opaque edge block (unknown type or atom: no caret can be inside it) counts as fully inside the
 * range: it is removed whole and nothing is merged into or out of it. When the start edge is
 * opaque, the caret lands at the nearest editable point instead. An edge inside an inline opaque
 * element (only a raw range can have one) moves out of it, so that element is inside the range too.
 */
export function deleteRangeStep(tr: Transaction, range: Range): Point | null {
  const ordered = asRange(range)
  if (comparePoint(ordered.start, ordered.end) === 0) return null
  const start = outOfInlineOpaque(tr, ordered.start, 'before')
  const end = outOfInlineOpaque(tr, ordered.end, 'after')
  // A range still to run with a point strictly inside this removal is swallowed by it (its own step
  // would delete past it). "Strictly": with content on both sides, so a point at an edge written in
  // a neighbouring text leaf still counts as at the edge.
  flagSwallowed(
    tr,
    (p) =>
      comparePoint(start, p) < 0 &&
      comparePoint(p, end) < 0 &&
      hasContentBetween(tr, start, p) &&
      hasContentBetween(tr, p, end),
  )
  const startBlock = edgeBlockOf(tr, start.path)
  const endBlock = edgeBlockOf(tr, end.path)
  const opaqueAt = (p: Path) => isOpaque(getNode(tr.doc, p) as ElementNode, tr.registry)
  const startOpaque = opaqueAt(startBlock)
  const endOpaque = opaqueAt(endBlock)
  const parent = parentPath(startBlock)
  const siblings = pathEquals(parent, parentPath(endBlock))
  // Where the start block was, for the caret when it is removed (with a container it left empty).
  let startAt = startBlock
  if (pathEquals(startBlock, endBlock)) {
    if (startOpaque) {
      tr.removeNode(startBlock)
      if (parent.length > 0) startAt = pruneEmpty(tr, parent) ?? startAt
    } else removeTextBetween(tr, start, end)
  } else if (siblings && parent.length === 0) {
    // Root siblings: the flat delete, as it always was.
    startAt = siblingDelete(tr, start, end, startBlock, endBlock, startOpaque, endOpaque) ?? startAt
  } else {
    // Siblings inside a container: the flat delete when its result is valid there (planned on a
    // `Draft`); else, as across depths, the replace that is (a strict container keeps the textblock
    // its content needs: no merge), or the fallback.
    const d = siblings ? new Draft(tr.registry, tr.doc) : null
    const checked = d ? [d.watch(parent), d.watch(startBlock)] : []
    const at = d ? siblingDelete(d, start, end, startBlock, endBlock, startOpaque, endOpaque) : null
    if (d && checked.every((i) => !d.at(i) || validAt(d, d.at(i)!))) {
      for (const op of d.ops) tr.apply(op)
      startAt = at ?? startAt
    } else {
      const plan =
        planNestedDelete(tr, start, end, startBlock, endBlock, startOpaque, endOpaque, true) ??
        planNestedDelete(tr, start, end, startBlock, endBlock, startOpaque, endOpaque, false)
      if (plan) {
        for (const op of plan.ops) tr.apply(op)
        startAt = plan.startAt
      } else {
        const ops = fallbackDelete(tr, start, end, startBlock, endBlock, startOpaque, endOpaque)
        if (!ops) return null
        for (const op of ops) tr.apply(op)
      }
    }
  }
  return startOpaque ? caretNearRemovedBlock(tr, startAt) : start
}

/**
 * The delete across sibling blocks `a` .. `b` (see `deleteRangeStep`): the start block's tail and
 * the end block's head go, the blocks in between are removed, and the end block is merged into the
 * start block; two opaque edges go whole, and a container they leave empty is pruned. Returns the
 * path of what `pruneEmpty` removed, else null.
 */
function siblingDelete(
  t: DocEditor,
  start: Point,
  end: Point,
  a: Path,
  b: Path,
  aOpaque: boolean,
  bOpaque: boolean,
): Path | null {
  const parent = parentPath(a)
  if (!aOpaque) removeTextBetween(t, start, lastPoint(blockTexts(t, a))!)
  if (!bOpaque) removeTextBetween(t, firstPoint(blockTexts(t, b))!, end)
  const k = a.length - 1
  const from = a[k]! + (aOpaque ? 0 : 1)
  const to = b[k]! - (bOpaque ? 0 : 1)
  for (let i = to; i >= from; i--) t.removeNode([...parent, i])
  if (!aOpaque && !bOpaque) {
    const merged = nextPath(a)
    const node = getNode(t.doc, merged) as DeepReadonly<ElementNode>
    const position = ((getNode(t.doc, a) as DeepReadonly<ElementNode>).children ?? []).length
    t.apply({
      type: 'merge_node',
      path: merged,
      position,
      properties: { id: node.id, type: node.type, data: node.data as Data },
    })
  } else if (aOpaque && bOpaque && parent.length > 0) {
    return pruneEmpty(t, parent)
  }
  return null
}

// ---- range delete across depths ----

/** What the text helpers read and edit: a transaction, or a `Draft` of one. */
interface DocEditor {
  readonly doc: DeepReadonly<Doc>
  readonly registry: Registry
  apply(op: Operation): unknown
  removeNode(path: Path): unknown
}

/**
 * A copy of the doc that a plan's ops are applied to before any reaches the transaction, so the
 * result can be checked against the schema first. Watched paths are mapped through every op (null
 * once their node is removed).
 */
class Draft implements DocEditor {
  readonly ops: Operation[] = []
  private readonly watched: (Path | null)[] = []

  constructor(
    readonly registry: Registry,
    public doc: DeepReadonly<Doc>,
  ) {}

  apply(op: Operation): this {
    this.doc = applyOp(this.doc as Doc, op)
    this.ops.push(op)
    for (let i = 0; i < this.watched.length; i++) {
      const p = this.watched[i]
      if (p) this.watched[i] = transformPath(p, op)
    }
    return this
  }

  removeNode(path: Path): this {
    return this.apply({ type: 'remove_node', path, node: getNode(this.doc, path) as Node })
  }

  watch(path: Path): number {
    return this.watched.push(path) - 1
  }

  at(i: number | null): Path | null {
    return i === null ? null : (this.watched[i] ?? null)
  }
}

function childrenOf(doc: DeepReadonly<Doc>, path: Path): readonly DeepReadonly<Node>[] {
  if (path.length === 0) return doc.children
  return (getNode(doc, path) as DeepReadonly<ElementNode>).children ?? []
}

function typeOf(doc: DeepReadonly<Doc>, path: Path): string {
  return path.length === 0 ? 'doc' : (getNode(doc, path) as DeepReadonly<ElementNode>).type
}

const onlyIsolating = new WeakMap<Registry, Map<string, boolean>>()

/**
 * Whether everything `type`'s content can hold is isolating, or such a node itself (a table row of
 * cells, a table of rows): the parts of one a range only partly covers are emptied, never removed.
 */
function holdsOnlyIsolating(registry: Registry, type: string): boolean {
  let cache = onlyIsolating.get(registry)
  if (!cache) onlyIsolating.set(registry, (cache = new Map()))
  const cached = cache.get(type)
  if (cached !== undefined) return cached
  cache.set(type, false) // a cycle: it holds something else too
  const match = type === 'doc' ? undefined : registry.contentMatch(type)
  const types = new Set<string>()
  if (match) {
    const seen = new Set([match])
    const queue = [match]
    for (let state = queue.pop(); state; state = queue.pop()) {
      for (const e of state.edges) {
        types.add(e.type)
        if (!seen.has(e.next)) {
          seen.add(e.next)
          queue.push(e.next)
        }
      }
    }
  }
  const out = types.size > 0 && [...types].every((t) => registry.isIsolating(t) || holdsOnlyIsolating(registry, t))
  cache.set(type, out)
  return out
}

/**
 * Empties a node covered whole that must stay: an isolating node gets the content `createAndFill`
 * gives its type (only its texts are emptied when there is none); any other node (a row) is emptied
 * child by child.
 */
function emptyKept(d: Draft, path: Path): void {
  const node = getNode(d.doc, path) as DeepReadonly<ElementNode>
  const kids = node.children ?? []
  if (!d.registry.isIsolating(node.type)) {
    for (let i = 0; i < kids.length; i++) if (isElement(kids[i]!)) emptyKept(d, [...path, i])
    return
  }
  const filled = d.registry.createAndFill(node.type, node.data as Data)
  if (!filled?.children) {
    const texts = blockTexts(d, path)
    if (texts.length) removeTextBetween(d, firstPoint(texts)!, lastPoint(texts)!)
    return
  }
  for (let i = kids.length - 1; i >= 0; i--) d.removeNode([...path, i])
  filled.children.forEach((child, i) => d.apply({ type: 'insert_node', path: [...path, i], node: child }))
}

/** Removes the node at `path`, covered whole; in a node holding only isolating nodes, it is emptied instead. */
function removeCovered(d: Draft, path: Path): void {
  if (holdsOnlyIsolating(d.registry, typeOf(d.doc, parentPath(path)))) emptyKept(d, path)
  else d.removeNode(path)
}

/**
 * When the element at `path` was left empty: removes it, or the outermost of its ancestors left
 * holding only it, whose parent stays valid without it (never an isolating node, never the doc);
 * when none can go, fills it with what its content needs (`createAndFill`). Returns the path of the
 * removed node (null when nothing was removed).
 */
function pruneEmpty(t: DocEditor, path: Path | null): Path | null {
  if (!path || path.length === 0 || childrenOf(t.doc, path).length > 0) return null
  const { registry } = t
  let top = path
  while (top.length > 1) {
    const up = parentPath(top)
    if (registry.isIsolating(typeOf(t.doc, up)) || childrenOf(t.doc, up).length !== 1) break
    top = up
  }
  // Each node of the chain holds only the next one, at index 0.
  for (let p = top; p.length <= path.length; p = [...p, 0]) {
    if (registry.isIsolating(typeOf(t.doc, p))) continue
    const parent = parentPath(p)
    const siblings = childrenOf(t.doc, parent)
    const i = p[p.length - 1]!
    if (fits(registry, typeOf(t.doc, parent), [...siblings.slice(0, i), ...siblings.slice(i + 1)])) {
      t.removeNode(p)
      return p
    }
  }
  const node = getNode(t.doc, path) as DeepReadonly<ElementNode>
  const filled = registry.createAndFill(node.type, node.data as Data)
  filled?.children?.forEach((child, i) => t.apply({ type: 'insert_node', path: [...path, i], node: child }))
  return null
}

/**
 * Fills in what the content of the element at `path` lacks (`fillBefore`, `createAndFill`): before
 * its children (the rest of a container whose head was cut off), else after them (one whose tail
 * was). Nothing when it is valid or cannot be completed.
 */
function fillMissing(d: Draft, path: Path): void {
  const fill = missingContent(d.registry, typeOf(d.doc, path), childrenOf(d.doc, path))
  fill?.nodes.forEach((node, k) => d.apply({ type: 'insert_node', path: [...path, fill.at + k], node }))
}

/** Whether the element (or doc) at `path` holds valid content: its content match, the marks and `\n` of its texts. */
function validAt(d: Draft, path: Path): boolean {
  const { registry } = d
  const owner = typeOf(d.doc, path)
  if (!registry.contentMatch(owner)) return true // unknown or atom: opaque
  const kids = childrenOf(d.doc, path)
  return (
    fits(registry, owner, kids) &&
    !bannedMarks(registry, owner, kids) &&
    (registry.isTextOnly(owner) || !hasNewline(kids))
  )
}

/** Whether textblock `a` can take the children of textblock `b` (content, marks and `\n`). */
function joinsInto(registry: Registry, doc: DeepReadonly<Doc>, a: Path, b: Path): boolean {
  const left = getNode(doc, a) as DeepReadonly<ElementNode>
  const right = getNode(doc, b) as DeepReadonly<ElementNode>
  if (!registry.isTextblock(left.type) || !registry.isTextblock(right.type)) return false
  const moved = right.children ?? []
  return (
    fits(registry, left.type, [...(left.children ?? []), ...moved]) &&
    !bannedMarks(registry, left.type, moved) &&
    (registry.isTextOnly(left.type) || !hasNewline(moved))
  )
}

/**
 * The delete when no replace is valid (an exotic schema; see `planNestedDelete`), planned on a
 * `Draft`: the text between the points, then the opaque edges whole (end first: removing it cannot
 * shift the start), kept only when the elements around them stay valid. Without them, only the text
 * removal (null, no ops, if even that leaves an edge block invalid).
 */
function fallbackDelete(
  tr: Transaction,
  start: Point,
  end: Point,
  a: Path,
  b: Path,
  aOpaque: boolean,
  bOpaque: boolean,
): Operation[] | null {
  const d = new Draft(tr.registry, tr.doc)
  const edges = [d.watch(a), d.watch(b)]
  const parents = [d.watch(parentPath(a)), d.watch(parentPath(b))]
  removeTextBetween(d, start, end)
  const textOps = d.ops.length
  if (!edges.every((i) => validAt(d, d.at(i)!))) return null
  if (bOpaque && !isAncestorPath(b, a)) d.removeNode(d.at(edges[1]!)!)
  if (aOpaque && !isAncestorPath(a, b)) d.removeNode(d.at(edges[0]!)!)
  const valid = parents.every((i) => {
    const p = d.at(i)
    return !p || validAt(d, p)
  })
  return valid ? d.ops : d.ops.slice(0, textOps)
}

/**
 * The delete of `start`..`end` between edge blocks `a` and `b` that have different parents (spec
 * §5.3), planned on a `Draft` of `tr.doc`. Below their deepest common ancestor:
 * 1. the start block's tail and the end block's head are removed (texts and inline atoms);
 * 2. the nodes covered whole are removed: before the end's path at each level (deepest first),
 *    between the two at the common ancestor, after the start's path at each level. Inside a node
 *    holding only isolating nodes (a table row, a table) they are emptied instead (`emptyKept`);
 * 3. an opaque edge is removed whole. Else, with `join`, when no isolating node lies on either path
 *    (the range would cross its boundary) and the start textblock allows the end one's content
 *    (`joinsInto`), the end textblock is moved after the start one and merged into it;
 * 4. a container left empty goes, or is refilled (`pruneEmpty`), and the containers cut open get
 *    what their content lacks (`fillMissing`).
 * Returns the ops and where the start block was (for the caret, when it was opaque), or null when
 * a node it touched would not be valid.
 */
function planNestedDelete(
  tr: Transaction,
  start: Point,
  end: Point,
  a: Path,
  b: Path,
  aOpaque: boolean,
  bOpaque: boolean,
  join: boolean,
): { ops: Operation[]; startAt: Path } | null {
  if (isAncestorPath(a, b) || isAncestorPath(b, a)) return null
  const d = new Draft(tr.registry, tr.doc)
  const { registry } = d
  let c = 0
  while (a[c] === b[c]) c++
  const ca = a.slice(0, c)
  /** The ancestors of `edge` below the common ancestor, outermost first. */
  const chain = (edge: Path) => edge.slice(c + 1).map((_, k) => edge.slice(0, c + 1 + k))
  const isolated = [...chain(a), ...chain(b)].some((p) => registry.isIsolating(typeOf(d.doc, p)))
  const cut = [...chain(a), ...chain(b)].map((p) => d.watch(p))
  const checked = [d.watch(ca), d.watch(a), ...cut]
  const wb = d.watch(b)
  const aParent = a.length - 1 > c ? d.watch(parentPath(a)) : null
  const bParent = b.length - 1 > c ? d.watch(parentPath(b)) : null

  if (!aOpaque) removeTextBetween(d, start, lastPoint(blockTexts(d, a))!)
  if (!bOpaque) removeTextBetween(d, firstPoint(blockTexts(d, b))!, end)
  for (let k = b.length - 1; k > c; k--) {
    const at = d.at(wb)!
    for (let i = at[k]! - 1; i >= 0; i--) removeCovered(d, [...at.slice(0, k), i])
  }
  for (let i = d.at(wb)![c]! - 1; i > a[c]!; i--) removeCovered(d, [...ca, i])
  for (let k = a.length - 1; k > c; k--) {
    const parent = a.slice(0, k)
    for (let i = childrenOf(d.doc, parent).length - 1; i > a[k]!; i--) removeCovered(d, [...parent, i])
  }

  let startAt = a
  if (bOpaque) {
    d.removeNode(d.at(wb)!)
    pruneEmpty(d, d.at(bParent))
  } else if (join && !aOpaque && !isolated && joinsInto(registry, d.doc, a, d.at(wb)!)) {
    const at = nextPath(a)
    const from = d.at(wb)!
    if (!pathEquals(from, at)) d.apply({ type: 'move_node', path: from, newPath: at })
    const node = getNode(d.doc, at) as DeepReadonly<ElementNode>
    d.apply({
      type: 'merge_node',
      path: at,
      position: childrenOf(d.doc, a).length,
      properties: { id: node.id, type: node.type, data: node.data as Data },
    })
    pruneEmpty(d, d.at(bParent))
  }
  if (aOpaque) {
    d.removeNode(a)
    startAt = pruneEmpty(d, d.at(aParent)) ?? a
  }
  const deepestFirst = cut
    .map((i) => d.at(i))
    .filter((p): p is Path => p !== null)
    .sort((x, y) => y.length - x.length)
  for (const p of deepestFirst) fillMissing(d, p)
  for (const i of checked) {
    const p = d.at(i)
    if (p && !validAt(d, p)) return null
  }
  return { ops: d.ops, startAt }
}

// ---- placing blocks (spec §5.3) ----

/** A stand-in element of `type`, for content checks that only read types. */
function stub(type: string): ElementNode {
  return { id: '', type, data: {}, children: [] }
}

/** Whether the element holds nothing but empty texts. */
function isEmptyBlock(node: DeepReadonly<ElementNode>): boolean {
  return (node.children ?? []).every((c) => isText(c) && c.text === '')
}

/** Path (relative to `node`) of its first text leaf, depth first; null when it has none. */
function firstTextPath(node: DeepReadonly<Node>): Path | null {
  if (isText(node)) return []
  const kids = node.children ?? []
  for (let i = 0; i < kids.length; i++) {
    const inner = firstTextPath(kids[i]!)
    if (inner) return [i, ...inner]
  }
  return null
}

/**
 * Whether the element (or doc) at `parent` would hold valid content with its children
 * `[index, index + removed)` replaced by `nodes`. Also true when it has no content match (opaque)
 * or its content is not valid already, so documents the schema does not describe keep today's edits.
 */
function acceptsAt(tr: Transaction, parent: Path, index: number, removed: number, nodes: readonly Node[]): boolean {
  const { registry } = tr
  const type = typeOf(tr.doc, parent)
  const match = registry.contentMatch(type)
  if (!match) return true
  // Content repeating one set of types (the doc's `block+`): nodes of that set keep valid content
  // valid wherever they go, and invalid content is accepted anyway, so the children need no
  // reading. Keeps a split or an insert at the root of a large flat doc O(1).
  const repeated = repeatedTypes(match)
  const kids = childrenOf(tr.doc, parent)
  if (
    repeated &&
    (match.validEnd || kids.length - removed + nodes.length > 0) &&
    nodes.every((n) => (isText(n) ? repeated.has('text') : !registry.node(n.type) || repeated.has(n.type)))
  )
    return true
  if (!fits(registry, type, kids)) return true
  return fitsWith(tr, parent, index, removed, nodes)
}

/** `acceptsAt` without its leniency: the content match of the element at `parent` must hold the result. */
function fitsWith(tr: Transaction, parent: Path, index: number, removed: number, nodes: readonly Node[]): boolean {
  const type = typeOf(tr.doc, parent)
  if (!tr.registry.contentMatch(type)) return false
  const kids = childrenOf(tr.doc, parent)
  return fits(tr.registry, type, [...kids.slice(0, index), ...nodes, ...kids.slice(index + removed)])
}

/**
 * `insertBlockNode` above the caret's parent (see there): `node` goes next to the child of the
 * nearest ancestor accepting it that holds the caret, before or after it when the caret is at its
 * very start or end, else between its halves once it is split at `point`. An empty textblock is
 * never split with its ancestors (it would leave an empty copy behind): only the levels where it
 * is at a very start or end are tried. Ancestors above an isolating node are not tried. Returns
 * where `node` went, null when no ancestor accepts it (no ops), or false when `node` was rejected.
 */
function insertAbove(
  tr: Transaction,
  node: ElementNode,
  point: Point,
  blockPath: Path,
  atBlockStart: boolean,
  atBlockEnd: boolean,
): Path | null | false {
  const depth = blockPath.length
  const empty = atBlockStart && atBlockEnd
  for (let k = depth - 1; k >= 1; k--) {
    const child = blockPath.slice(0, k)
    if (tr.registry.isIsolating(typeOf(tr.doc, child))) return null
    const ancestor = parentPath(child)
    const i = child[k - 1]!
    const below = blockPath.slice(k)
    const atStart = atBlockStart && below.every((j) => j === 0)
    const atEnd = atBlockEnd && below.every((j, n) => j === childrenOf(tr.doc, blockPath.slice(0, k + n)).length - 1)
    let at: Path
    if (atStart || atEnd) {
      at = [...ancestor, atEnd ? i + 1 : i]
      if (!fitsWith(tr, ancestor, at[at.length - 1]!, 0, [node])) continue
    } else {
      if (empty || !fitsWith(tr, ancestor, i + 1, 0, [node, stub(typeOf(tr.doc, child))])) continue
      // The textblock and its ancestors up to `child` are split at the caret (no ops when not valid).
      if (!split(tr, point, depth - k + 1)) continue
      at = [...ancestor, i + 1]
    }
    tr.insertNode(at, node)
    return tr.rejected !== null ? false : at
  }
  return null
}

/**
 * `replaceSelectedNode({ node })` above the selected node's parent: the node at `path` is removed
 * and `node` goes next to the child of the nearest ancestor accepting it that holds `path`, as
 * `insertAbove` places it at a caret: before or after that child when `path` is at its very start
 * or end, else between its halves once the elements from the selected node's parent up to that
 * child are split where the selected node was. Everything is checked first (the parent stays
 * valid without the selected node, each half matches its content); ancestors above an isolating
 * node are not tried. Returns where `node` went, null when no ancestor accepts it (no ops), or
 * false when `node` was rejected.
 */
function insertAboveNode(tr: Transaction, node: ElementNode, path: Path): Path | null | false {
  const { registry } = tr
  const parent = parentPath(path)
  const index = path[path.length - 1]!
  if (!fitsWith(tr, parent, index, 1, [])) return null
  for (let k = path.length - 1; k >= 1; k--) {
    const child = path.slice(0, k)
    if (registry.isIsolating(typeOf(tr.doc, child))) return null
    const ancestor = parentPath(child)
    const i = child[k - 1]!
    const below = path.slice(k)
    const atStart = below.every((j) => j === 0)
    const atEnd = below.every((j, n) => j === childrenOf(tr.doc, path.slice(0, k + n)).length - 1)
    if (atStart || atEnd) {
      const at = [...ancestor, atEnd ? i + 1 : i]
      if (!fitsWith(tr, ancestor, at[at.length - 1]!, 0, [node])) continue
      tr.insertNode(at, node)
      if (tr.rejected !== null) return false
      // Inserted before `child`, the selected node moved one place along with it.
      tr.removeNode(atEnd ? path : [...ancestor, i + 1, ...below])
      return at
    }
    if (!fitsWith(tr, ancestor, i + 1, 0, [node, stub(typeOf(tr.doc, child))])) continue
    // The halves of each element split, from the selected node's parent up to `child`.
    let valid = true
    for (let level = path.length - 1; level >= k && valid; level--) {
      const owner = path.slice(0, level)
      const type = typeOf(tr.doc, owner)
      const kids = childrenOf(tr.doc, owner)
      const c = path[level]!
      const [left, right] =
        level === path.length - 1
          ? [kids.slice(0, c), kids.slice(c + 1)]
          : [kids.slice(0, c + 1), [stub(typeOf(tr.doc, path.slice(0, level + 1))), ...kids.slice(c + 1)]]
      valid =
        !!registry.contentMatch(type) &&
        !registry.isIsolating(type) &&
        left.length > 0 &&
        right.length > 0 &&
        fits(registry, type, left) &&
        fits(registry, type, right)
    }
    if (!valid) continue
    tr.removeNode(path)
    for (let level = path.length - 1; level >= k; level--) {
      const owner = path.slice(0, level)
      const el = getNode(tr.doc, owner) as DeepReadonly<ElementNode>
      const position = level === path.length - 1 ? index : path[level]! + 1
      tr.apply({ type: 'split_node', path: owner, position, properties: { id: createId(), type: el.type, data: el.data as Data } })
    }
    const at = [...ancestor, i + 1]
    tr.insertNode(at, node)
    return tr.rejected !== null ? false : at
  }
  return null
}

/**
 * The node the code creates at child `index` of the element (or doc) at `parent` (replacing
 * `removed` children there): `createAndFill` of the default type of that position (the first
 * auto-creatable type its content match expects there), else of the next type it expects, that
 * keeps the parent's content valid and holds a text (a textblock only, with `textblock`). Without
 * a content match there, or such a type, the default block (as in a flat doc, where both are it).
 */
function defaultNodeAt(tr: Transaction, parent: Path, index: number, removed = 0, textblock = false): ElementNode {
  const { registry } = tr
  const match = registry.contentMatch(typeOf(tr.doc, parent))
  const kids = childrenOf(tr.doc, parent)
  const known = (t: string) => t === 'text' || !!registry.node(t)
  const state = match?.matchTypes(
    kids.slice(0, index).map((k) => (isText(k) ? 'text' : k.type)),
    known,
  )
  if (state) {
    const types = new Set([...(state.defaultType ? [state.defaultType] : []), ...state.edges.map((e) => e.type)])
    for (const type of types) {
      if (type === 'text' || (textblock && !registry.isTextblock(type))) continue
      if (!acceptsAt(tr, parent, index, removed, [stub(type)])) continue
      const node = registry.createAndFill(type)
      if (node && firstTextPath(node)) return node
    }
  }
  return registry.createAndFill(registry.defaultBlock)!
}

/** `node` (an element created by the code, not shared) with its first text set to `text` and `marks`. */
function withText(node: ElementNode, text: string, marks: Mark[]): ElementNode {
  const path = firstTextPath(node)
  if (!path) return node
  let parent = node
  for (const i of path.slice(0, -1)) parent = parent.children![i] as ElementNode
  parent.children![path[path.length - 1]!] = { text, marks }
  return node
}

/** Inserts the default node of the position `at` (`defaultNodeAt`) there and returns the start of its first text. */
function insertDefaultNode(tr: Transaction, at: Path): Point {
  const node = defaultNodeAt(tr, parentPath(at), at[at.length - 1]!)
  tr.insertNode(at, node)
  return { path: [...at, ...firstTextPath(node)!], offset: 0 }
}

/**
 * `node` wrapped into the containers the content match of the element (or doc) at `parent` needs
 * to hold it at child `index` (`findWrapping`; replacing `removed` children), each completed with
 * what its content lacks after the inner one (`createAndFill`), when the parent then stays valid.
 * Null when there is no such wrapping (or `node` fits there already).
 */
function wrapToFit(tr: Transaction, parent: Path, index: number, removed: number, node: ElementNode): ElementNode | null {
  const { registry } = tr
  const match = registry.contentMatch(typeOf(tr.doc, parent))
  if (!match) return null
  const known = (t: string) => t === 'text' || !!registry.node(t)
  const kids = childrenOf(tr.doc, parent)
  const state = match.matchTypes(
    kids.slice(0, index).map((k) => (isText(k) ? 'text' : k.type)),
    known,
  )
  const chain = state?.findWrapping(node.type)
  if (!chain || chain.length === 0) return null
  let inner: ElementNode = node
  for (let k = chain.length - 1; k >= 0; k--) {
    const type = chain[k]!
    const result = registry.validateData(type, {})
    const rest = registry.contentMatch(type)?.matchTypes([inner.type], known)?.fillBefore([], true, known)
    if (!result.ok || !rest) return null
    const children: Node[] = [inner]
    for (const t of rest) {
      const filled = t === 'text' ? { text: '', marks: [] } : registry.createAndFill(t)
      if (!filled) return null
      children.push(filled)
    }
    inner = { id: createId(), type, data: result.data, children }
  }
  return acceptsAt(tr, parent, index, removed, [inner]) ? inner : null
}

/**
 * The start of the first editable text after the node at `path` (texts inside it excluded); when
 * none follows, or a block-level node is directly followed by an opaque block (the caret would skip
 * past it), the default node of the position right after the node is inserted there and its start
 * returned.
 */
function caretAfterNode(tr: Transaction, path: Path): Point {
  const node = getNode(tr.doc, path)
  const blockLevel = isElement(node) && tr.registry.node(node.type)?.kind !== 'inline'
  const parent = parentPath(path)
  const siblings = parent.length === 0 ? tr.doc.children : ((getNode(tr.doc, parent) as ElementNode).children ?? [])
  const next = siblings[path[path.length - 1]! + 1]
  if (blockLevel && next && isElement(next) && isOpaque(next, tr.registry)) return insertDefaultNode(tr, nextPath(path))
  for (const [, p] of editableTextEntries(tr.doc, tr.registry)) {
    if (comparePath(p, path) > 0) return { path: p, offset: 0 }
  }
  return insertDefaultNode(tr, nextPath(path))
}

/** What to do with a node-selected element (see `replaceSelectedNode`). */
export type NodeSelectionEdit = 'delete' | 'split' | { text: string } | { node: ElementNode }

/**
 * Every edit of a node selection, in one place. Returns false (nothing done) without a node selection.
 * - `'delete'`: removes the node; the caret is the selection's anchor, mapped.
 * - `'split'`: inserts the default node of the position after the node (`defaultNodeAt`: the
 *   default block in a flat doc); the caret goes into it.
 * - `{ text }`: replaces the node with the default node of its position holding `text` (stored
 *   marks); caret after it.
 * - `{ node }`: replaces the node with `node` (validated: false when rejected). Placed as
 *   `insertBlockNode` places it at a caret: when the parent does not accept it there, it goes next
 *   to the nearest accepting ancestor's child holding the selected node (`insertAboveNode`), else
 *   it is wrapped into the containers the parent needs (`findWrapping`), else false with no ops.
 *   The caret is at the start of the editable text following it (a default node is added when
 *   none follows).
 */
export function replaceSelectedNode(tr: Transaction, mode: NodeSelectionEdit): boolean {
  if (!isNodeSelection(tr.selection)) return false
  // A node range is always the only range.
  return runStep(tr, undefined, (range) => (isNodeRange(range) ? replaceNodeStep(tr, range, mode) : false))
}

/** `replaceSelectedNode` at one node range: returns the caret after the edit (false when rejected). */
export function replaceNodeStep(tr: Transaction, range: SelectionRange & { node: Path }, mode: NodeSelectionEdit): StepResult {
  const path = range.node
  if (mode === 'delete') {
    const from = tr.ops.length
    tr.removeNode(path)
    // The range's anchor, mapped through the removal.
    const mapped = mapSince(tr, range, from)
    return mapped && caret(mapped.anchor)
  }
  if (mode === 'split') return caret(insertDefaultNode(tr, nextPath(path)))
  const parent = parentPath(path)
  const index = path[path.length - 1]!
  let replacement: ElementNode
  if ('text' in mode) {
    replacement = withText(defaultNodeAt(tr, parent, index, 1), mode.text, tr.storedMarks ?? [])
  } else {
    replacement = mode.node
    if (!acceptsAt(tr, parent, index, 1, [replacement])) {
      const above = insertAboveNode(tr, replacement, path)
      if (above === false) return false
      if (above) return caret(caretAfterNode(tr, above))
      const wrapped = wrapToFit(tr, parent, index, 1, replacement)
      if (!wrapped) return false
      replacement = wrapped
    }
  }
  tr.insertNode(nextPath(path), replacement)
  if (tr.rejected !== null) return false
  tr.removeNode(path)
  return caret('text' in mode ? { path: [...path, ...firstTextPath(replacement)!], offset: mode.text.length } : caretAfterNode(tr, path))
}

/** Copy of `node` whose elements all get fresh ids. */
function withFreshIds(node: ElementNode): ElementNode {
  const copy = (n: Node): Node =>
    isText(n) ? n : { ...n, id: createId(), ...(n.children ? { children: n.children.map(copy) } : {}) }
  return copy(node) as ElementNode
}

/**
 * Inserts the block-level `node` at every selection range (or only at `at`, see `runStep`). The
 * first copy keeps the caller's ids (as with one range); the copies at the other ranges get fresh
 * ids throughout. (Inside a `forEachRange` callback each call is a first copy: pass a node with
 * fresh ids per range.) At each range, it replaces a selected node or an empty block; at
 * offset 0 of a block it goes before it, at its end after it, else the block is split at the caret (a
 * non-empty range is deleted first). Each caret ends at the start of the editable text following its
 * node, in a default node of that position added when none follows. False without a selection or
 * when `node` is rejected (the tr stays rejected).
 *
 * Placement follows the content match (spec §5.3). An empty block whose parent does not accept
 * `node` in its place gets it after it, else before it. Otherwise, when the caret's parent does not
 * accept `node` there, it goes to the nearest ancestor that does (not past an isolating node), next
 * to the ancestor's child holding the caret: before it when the caret is at its very start, after
 * it at its very end, else that child is split at the caret (`split`; never around an empty
 * block) and `node` goes between the halves. When no ancestor accepts it, it is wrapped
 * (`findWrapping`) where the caret is. When neither can, that range does nothing: false and no ops
 * (a non-empty range is not deleted either: the placement is tried on a copy first).
 */
export function insertBlockNode(tr: Transaction, node: ElementNode, at?: SelectionRange | Range): boolean {
  let copies = 0
  return runStep(tr, at, (range) => insertBlockNodeStep(tr, copies++ === 0 ? node : withFreshIds(node), range))
}

export function insertBlockNodeStep(tr: Transaction, node: ElementNode, sel: SelectionRange): StepResult {
  if (isNodeRange(sel)) return replaceNodeStep(tr, sel, { node })
  const range = toRange(sel)
  if (comparePoint(range.start, range.end) === 0) return placeBlock(tr, node, range.start)
  // Placement is decided before anything is deleted: a dry run on a copy of the doc first (with the
  // same ids, replayed), so a node that fits nowhere leaves the range as it is (false, no ops).
  const probe = new Transaction({ doc: tr.doc, selection: null, storedMarks: null, pluginStates: new Map() }, tr.registry)
  const ids: string[] = []
  const tried = recordIds(ids, () => placeBlock(probe, node, deleteRangeStep(probe, range) ?? range.start))
  if (tried === false) {
    if (probe.rejected !== null) tr.rejected = probe.rejected
    return false
  }
  return replayIds(ids, () => placeBlock(tr, node, deleteRangeStep(tr, range) ?? range.start))
}

/** `insertBlockNodeStep` at a caret `point` (see `insertBlockNode`): false, with no ops, when `node` fits nowhere. */
function placeBlock(tr: Transaction, node: ElementNode, point: Point): StepResult {
  const blockPath = blockPathOf(tr, point.path)
  const blockNode = getNode(tr.doc, blockPath) as ElementNode
  const block = readBlock(tr, blockPath)
  const offset = toBlockOffset(block, point)
  const empty = isEmptyBlock(blockNode)
  const parent = parentPath(blockPath)
  const index = blockPath[blockPath.length - 1]!
  type Where = 'replace' | 'before' | 'after' | 'split'
  const slot = (where: Where) =>
    where === 'replace'
      ? { index, removed: 1, kids: [] }
      : where === 'before'
        ? { index, removed: 0, kids: [] }
        : where === 'after'
          ? { index: index + 1, removed: 0, kids: [] }
          : { index: index + 1, removed: 0, kids: [stub(blockNode.type)] }
  // Where it may go in the block's parent: in place of an empty block (else after it, else before
  // it), before the block, after it, or between its halves.
  const options: Where[] = empty
    ? ['replace', 'after', 'before']
    : offset === 0
      ? ['before']
      : offset === block.text.length
        ? ['after']
        : ['split']
  let where = options.find((w) => {
    const s = slot(w)
    return acceptsAt(tr, parent, s.index, s.removed, [node, ...s.kids])
  })
  if (!where) {
    const above = insertAbove(tr, node, point, blockPath, offset === 0, offset === block.text.length)
    if (above === false) return false
    if (above) return caret(caretAfterNode(tr, above))
    where = options[0]!
    const s = slot(where)
    const wrapped = wrapToFit(tr, parent, s.index, s.removed, node)
    if (!wrapped || (s.kids.length > 0 && !acceptsAt(tr, parent, s.index, 0, [wrapped, ...s.kids]))) return false
    node = wrapped
  }
  let at: Path
  if (where === 'replace') {
    tr.insertNode(blockPath, node)
    if (tr.rejected !== null) return false
    tr.removeNode(nextPath(blockPath))
    return caret(caretAfterNode(tr, blockPath))
  }
  if (where === 'before') {
    at = blockPath
  } else if (where === 'after') {
    at = nextPath(blockPath)
  } else {
    splitBlockAt(tr, point, blockPath, { id: createId(), type: blockNode.type, data: blockNode.data })
    at = nextPath(blockPath)
  }
  tr.insertNode(at, node)
  if (tr.rejected !== null) return false
  return caret(caretAfterNode(tr, at))
}

/**
 * Deletes every selection range (or only `at`, see `runStep`), then inserts `text` with the insertion
 * marks; each caret ends after its insert. Without `at`, a selected node is replaced.
 */
export function insertText(tr: Transaction, text: string, at?: SelectionRange | Range): boolean {
  return runStep(tr, at, (range) =>
    !at && isNodeRange(range)
      ? replaceNodeStep(tr, range, text === '' ? 'delete' : { text })
      : insertTextStep(tr, text, asRange(range)),
  )
}

function insertTextStep(tr: Transaction, text: string, range: Range): SelectionRange {
  const stored = tr.storedMarks
  // Nothing to insert at a caret: a no-op, the stored marks are kept for the next typed text.
  if (text === '' && pointEquals(range.start, range.end)) return caret(range.start)
  // Typing over a range keeps the marks of its first covered character (read before deleting).
  const replaced = stored ? null : marksOfRange(tr.doc, range, tr.registry)
  const point = deleteRangeStep(tr, range) ?? range.start
  const marks = replaced ?? insertionMarks(tr, point)
  tr.setStoredMarks(null)
  if (text === '') return caret(point)
  const node = textAt(tr, point.path)
  if (sameMarkSet(marks, node.marks)) {
    tr.apply({ type: 'insert_text', path: point.path, offset: point.offset, text })
    return caret({ path: point.path, offset: point.offset + text.length })
  }
  // Different marks: a new text node at the point (splitting the text when inside it).
  let path = point.path
  if (point.offset > 0) {
    if (point.offset < node.text.length) {
      tr.apply({ type: 'split_node', path, position: point.offset, properties: { marks: node.marks } })
    }
    path = nextPath(path)
  }
  tr.insertNode(path, { text, marks })
  return caret({ path, offset: text.length })
}

// --- segmentation ---

export interface BlockText {
  texts: [TextNode, Path][]
  text: string
}

function readBlock(tr: Transaction, blockPath: Path): BlockText {
  const texts = blockTexts(tr, blockPath)
  return { texts, text: texts.map(([t]) => t.text).join('') }
}

export function toBlockOffset(block: BlockText, point: Point): number {
  let acc = 0
  for (const [t, p] of block.texts) {
    if (pathEquals(p, point.path)) return acc + point.offset
    acc += t.text.length
  }
  throw new Error(`Point [${point.path}] is not in the block`)
}

export function fromBlockOffset(block: BlockText, offset: number): Point {
  let acc = 0
  for (const [t, p] of block.texts) {
    if (offset <= acc + t.text.length) return { path: p, offset: offset - acc }
    acc += t.text.length
  }
  return lastPoint(block.texts)!
}

const segmenters = new Map<string, Intl.Segmenter>()
function segments(text: string, granularity: 'grapheme' | 'word'): Intl.SegmentData[] {
  let s = segmenters.get(granularity)
  if (!s) segmenters.set(granularity, (s = new Intl.Segmenter(undefined, { granularity })))
  return [...s.segment(text)]
}

/**
 * Characters segmented on each side of the caret: Backspace/Delete look at a window, not the whole
 * block (whose text can be very long). A cluster or word reaching the window's edge falls back to
 * the whole text, so the result is always the one segmenting the whole text gives.
 */
const SEGMENT_WINDOW = 256

/** Block offset the deletion extends to from `offset`, in the given direction. */
function targetOffset(text: string, offset: number, unit: DeleteUnit, backward: boolean): number {
  if (unit === 'line') return backward ? 0 : text.length
  const from = Math.max(0, offset - SEGMENT_WINDOW)
  const to = Math.min(text.length, offset + SEGMENT_WINDOW)
  if (from === 0 && to === text.length) return targetIn(text, offset, unit, backward)
  const target = from + targetIn(text.slice(from, to), offset - from, unit, backward)
  // At a window edge that is not the text's: the cluster or word may go on past it.
  const atCut = (backward && target === from && from > 0) || (!backward && target === to && to < text.length)
  return atCut ? targetIn(text, offset, unit, backward) : target
}

/** `targetOffset` within `text` (segmented whole). */
function targetIn(text: string, offset: number, unit: Exclude<DeleteUnit, 'line'>, backward: boolean): number {
  const segs = segments(text, unit === 'character' ? 'grapheme' : 'word')
  if (backward) {
    let target = offset
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]!
      if (seg.index >= offset) continue
      target = seg.index
      // Characters: one grapheme. Words: skip whitespace/punctuation, then one word.
      if (unit === 'character' || seg.isWordLike) break
    }
    return target
  }
  let target = offset
  for (const seg of segs) {
    const segEnd = seg.index + seg.segment.length
    if (segEnd <= offset) continue
    target = segEnd
    if (unit === 'character' || seg.isWordLike) break
  }
  return target
}

/**
 * What Backspace (`backward`) or Delete meets at the edge of the textblock at `blockPath` (spec
 * §5.3): the nearest node before (after) it, from the textblock or its nearest ancestor that has a
 * sibling on that side, never leaving an isolating node (null at its edge, and at the doc's), then
 * its last (first) descendant:
 * - `opaque`: an opaque element (an atom, an unknown type) on the way, selected first;
 * - `join`: a textblock with editable text, joined with this one;
 * - `isolated`: a textblock reached only past an isolating boundary (the last cell of a table
 *   before the caret, the first after it): the caret goes there, no join.
 * Null when there is nothing to reach (an element with no children, or an opaque one past an
 * isolating boundary).
 */
function edgeTarget(
  tr: Transaction,
  blockPath: Path,
  backward: boolean,
): { kind: 'opaque' | 'join' | 'isolated'; path: Path } | null {
  const { registry } = tr
  let path = blockPath
  for (;;) {
    const parent = parentPath(path)
    const i = path[path.length - 1]!
    if (backward ? i > 0 : i < childrenOf(tr.doc, parent).length - 1) break
    if (parent.length === 0 || registry.isIsolating(typeOf(tr.doc, parent))) return null
    path = parent
  }
  let next = [...parentPath(path), path[path.length - 1]! + (backward ? -1 : 1)]
  let isolated = false
  for (;;) {
    const node = getNode(tr.doc, next)
    if (!isElement(node)) return null
    if (isOpaque(node, registry)) return isolated ? null : { kind: 'opaque', path: next }
    if (registry.isTextblock(node.type)) {
      if (blockTexts(tr, next).length === 0) return null
      return { kind: isolated ? 'isolated' : 'join', path: next }
    }
    const kids = node.children ?? []
    if (kids.length === 0) return null
    if (registry.isIsolating(node.type)) isolated = true
    next = [...next, backward ? kids.length - 1 : 0]
  }
}

/** Editable texts of a block that no inline opaque element separates, with the ones right before and after it (null at the block's edges). */
export interface Run extends BlockText {
  before: Path | null
  after: Path | null
}

/** The run of the block at `blockPath` that holds `point`: grapheme and word edits never leave it. */
export function runAt(tr: Transaction, blockPath: Path, point: Point): Run {
  const runs: Run[] = []
  let current: Run = { texts: [], text: '', before: null, after: null }
  const walk = (nodes: readonly DeepReadonly<Node>[], base: Path, parentType: string) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const path = [...base, i]
      if (isText(n)) {
        current.texts.push([n as TextNode, path])
        current.text += n.text
      } else if (isInlineOpaque(tr, n, parentType)) {
        current.after = path
        runs.push(current)
        current = { texts: [], text: '', before: path, after: null }
      } else if (!isOpaque(n, tr.registry)) {
        walk(n.children ?? [], path, n.type)
      }
    }
  }
  const block = getNode(tr.doc, blockPath) as ElementNode
  walk(block.children ?? [], blockPath, block.type)
  runs.push(current)
  const run = runs.find((r) => r.texts.some(([, p]) => pathEquals(p, point.path)))
  if (!run) throw new Error(`Point [${point.path}] is not in the block`)
  return run
}

function deleteDirection(tr: Transaction, unit: DeleteUnit, backward: boolean, at?: SelectionRange | Range): boolean {
  const several = (tr.selection?.ranges.length ?? 0) > 1
  return runStep(tr, at, (range) => deleteDirectionStep(tr, unit, backward, range, several, !!at))
}

/**
 * Backspace/Delete at one range: a selected node is removed, a non-empty range deleted, else one
 * `unit` before/after the caret. At a block edge next to an opaque block, with one range the block
 * is node-selected (a second press removes it); with `several` ranges this caret does nothing and
 * stays (spec §5.4: a node range would drop every other range); with an `explicit` range, that
 * counts as doing nothing (false), so the selection range it touches is not collapsed onto it.
 *
 * At a textblock edge in nested content (spec §5.3), in order: Backspace in the first textblock of
 * a non-isolating container lifts it out when that is valid; else the neighbour `edgeTarget` finds
 * (searching into the last, or first, descendant of a previous, or next, container, never out of
 * an isolating node) is node-selected when opaque, joined when a textblock (across parents only
 * when the textblock before takes the content after), and past an isolating boundary (a table)
 * the caret moves to it, an empty textblock being removed first. At an isolating node's edge, and
 * the doc's, nothing.
 */
function deleteDirectionStep(
  tr: Transaction,
  unit: DeleteUnit,
  backward: boolean,
  range: SelectionRange,
  several: boolean,
  explicit: boolean,
): StepResult {
  if (isNodeRange(range)) return replaceNodeStep(tr, range, 'delete')
  const deleted = (r: Range): StepResult => {
    const p = deleteRangeStep(tr, r)
    return p ? caret(p) : false
  }
  if (!pointEquals(range.anchor, range.focus)) return deleted(toRange(range))
  const point = range.anchor
  const blockPath = blockPathOf(tr, point.path)
  // Characters and words stay within the run: an inline atom next to the caret is removed whole
  // (its neighbour texts keep the caret: the range is mapped through the removal). A word deletion
  // removes it too, alone: an atom is one unit with no word inside to stop at (it is not selected
  // first like a block atom, which only Backspace/Delete at a block edge reaches), and the words
  // beyond it are left for the next press, as browsers treat an inline image.
  if (unit !== 'line') {
    const run = runAt(tr, blockPath, point)
    const runOffset = toBlockOffset(run, point)
    const atRunEdge = backward ? runOffset === 0 : runOffset === run.text.length
    const atom = backward ? run.before : run.after
    if (atRunEdge && atom) {
      const from = tr.ops.length
      tr.removeNode(atom)
      return mapSince(tr, range, from)
    }
    if (!atRunEdge) {
      const target = fromBlockOffset(run, targetOffset(run.text, runOffset, unit, backward))
      return deleted(backward ? { start: target, end: point } : { start: point, end: target })
    }
  }
  const block = readBlock(tr, blockPath)
  const offset = toBlockOffset(block, point)
  const atEdge = backward ? offset === 0 : offset === block.text.length
  if (atEdge) {
    // Rule 1: the first textblock of a (non-isolating) container is lifted out of it, when the
    // lift is valid (`liftStep`; a container plugin with its own rule binds Backspace before this).
    if (backward && blockPath.length > 1 && blockPath[blockPath.length - 1] === 0) {
      const lifted = liftStep(tr, range)
      if (lifted !== false) return lifted
    }
    const target = edgeTarget(tr, blockPath, backward)
    if (!target) return false
    // An opaque neighbour is selected first (a second Backspace/Delete removes it); with several
    // ranges, this caret does nothing for this press (it counts as handled).
    // With an explicit range, nothing is done (false): the range it touches must not collapse onto it.
    if (target.kind === 'opaque') return several ? !explicit && range : nodeSelection(tr.doc, tr.registry, target.path).ranges[0]!
    const texts = blockTexts(tr, target.path)
    const edge = backward ? lastPoint(texts)! : firstPoint(texts)!
    if (target.kind === 'isolated') {
      // Past an isolating boundary (a table): no join. An empty textblock is removed (when its
      // parent stays valid without it), and the caret goes to the edge of the textblock reached.
      const from = tr.ops.length
      const parent = parentPath(blockPath)
      const index = blockPath[blockPath.length - 1]!
      if (isEmptyBlock(getNode(tr.doc, blockPath) as ElementNode) && fitsWith(tr, parent, index, 1, [])) tr.removeNode(blockPath)
      return mapSince(tr, caret(edge), from)
    }
    const [start, end] = backward ? [target.path, blockPath] : [blockPath, target.path]
    // A join across different parents only when the textblock before takes the content after (no ops otherwise).
    if (!pathEquals(parentPath(start), parentPath(end)) && !joinsInto(tr.registry, tr.doc, start, end)) return false
    return backward
      ? deleted({ start: edge, end: firstPoint(block.texts)! })
      : deleted({ start: lastPoint(block.texts)!, end: edge })
  }
  const target = fromBlockOffset(block, targetOffset(block.text, offset, unit, backward))
  return deleted(backward ? { start: target, end: point } : { start: point, end: target })
}

/** Backspace: see `deleteDirectionStep`; at every range, or only at `at` (see `runStep`). */
export function deleteBackward(tr: Transaction, unit: DeleteUnit = 'character', at?: SelectionRange | Range): boolean {
  return deleteDirection(tr, unit, true, at)
}

/** Delete: see `deleteDirectionStep`; at every range, or only at `at` (see `runStep`). */
export function deleteForward(tr: Transaction, unit: DeleteUnit = 'character', at?: SelectionRange | Range): boolean {
  return deleteDirection(tr, unit, false, at)
}

/**
 * At every selection range (or only at `at`, see `runStep`): deletes the range, then splits the block
 * at the caret (a selected node gets the default node of the position after it instead). The new
 * block gets a fresh id and the same type/data, except at the very end of a non-default block,
 * where it is the textblock the position expects (`createAndFill` of its default type: the default
 * block with `data {}` in a flat doc). When the parent does not take that type after the block, the
 * new block takes the textblock type its content match expects there. When none fits, nothing is
 * split: a collapsed caret does nothing (false, no ops); a non-empty range stays deleted and its
 * caret is at the deletion's start (Enter over a selection removes it, as a key press should).
 * Each caret ends at the start of its new block.
 *
 * A collapsed caret in an empty textblock inside a non-isolating container lifts it out instead,
 * when the lift is valid (spec §5.3: Enter in the last, empty paragraph of a quote leaves it).
 */
export function splitBlock(tr: Transaction, at?: SelectionRange | Range): boolean {
  return runStep(tr, at, (range) => (isNodeRange(range) ? replaceNodeStep(tr, range, 'split') : splitBlockStep(tr, toRange(range))))
}

function splitBlockStep(tr: Transaction, range: Range): StepResult {
  const collapsed = comparePoint(range.start, range.end) === 0
  const deleted = deleteRangeStep(tr, range)
  const point = deleted ?? range.start
  const blockPath = blockPathOf(tr, point.path)
  const blockNode = getNode(tr.doc, blockPath) as ElementNode
  // An empty textblock in a (non-isolating) container is lifted out of it, when that is valid.
  if (collapsed && blockPath.length > 1 && isEmptyBlock(blockNode)) {
    const lifted = liftStep(tr, caret(point))
    if (lifted !== false) return lifted
  }
  const block = readBlock(tr, blockPath)
  const atEnd = toBlockOffset(block, point) === block.text.length
  const parent = parentPath(blockPath)
  const index = blockPath[blockPath.length - 1]!
  let props: Partial<ElementNode>
  if (atEnd && blockNode.type !== tr.registry.defaultBlock) {
    const node = defaultNodeAt(tr, parent, index + 1, 0, true)
    props = { id: node.id, type: node.type, data: node.data }
  } else {
    props = { id: createId(), type: blockNode.type, data: blockNode.data }
  }
  if (acceptsAt(tr, parent, index + 1, 0, [stub(props.type!)])) return caret(splitBlockAt(tr, point, blockPath, props))
  // The parent does not take that type there: the new block takes the textblock type its content
  // match expects there (`split` checks the halves; no ops when nothing fits).
  const type = defaultNodeAt(tr, parent, index + 1, 0, true).type
  const out = acceptsAt(tr, parent, index + 1, 0, [stub(type)]) ? split(tr, point, 1, [{ type }]) : null
  return out ? caret(out) : deleted ? caret(point) : false
}

/**
 * Splits the text at `point`, then every ancestor up to and including the block at `blockPath`;
 * the new right-hand block gets `props` (inline ancestors get ids from `newId`, by default
 * `createId`; pass one that checks the ids in use when the generator may repeat them). Returns the
 * start of the new block (its first text, at offset 0).
 */
export function splitBlockAt(
  tr: Transaction,
  point: Point,
  blockPath: Path,
  props: Partial<ElementNode>,
  newId: () => string = createId,
): Point {
  let path = point.path
  let position = point.offset
  tr.apply({ type: 'split_node', path, position, properties: { marks: textAt(tr, path).marks } })
  while (path.length > blockPath.length + 1) {
    position = path[path.length - 1]! + 1
    path = parentPath(path)
    const inline = getNode(tr.doc, path) as ElementNode
    tr.apply({ type: 'split_node', path, position, properties: { id: newId(), type: inline.type, data: inline.data } })
  }
  tr.apply({ type: 'split_node', path: blockPath, position: path[path.length - 1]! + 1, properties: props })
  const newBlock = nextPath(blockPath)
  return { path: [...newBlock, ...point.path.slice(blockPath.length).map(() => 0)], offset: 0 }
}

/** Selects from the start of the first editable text to the end of the last one in the doc (a text selection: no `node`). */
export function selectAll(tr: Transaction): boolean {
  const texts = [...editableTextEntries(tr.doc, tr.registry)]
  const anchor = firstPoint(texts)
  const focus = lastPoint(texts)
  if (!anchor || !focus) return false
  tr.setSelection(single({ anchor, focus }))
  return true
}
