import { createId } from '../model/id'
import { editableTextEntries, isNodeSelection, isOpaque, nodeSelection } from '../model/editable'
import { getNode, isElement, isText, sameMarkSet } from '../model/node'
import { comparePath, comparePoint, isAncestorPath, nextPath, parentPath, pointEquals, toRange } from '../model/path'
import { isNodeRange, rangeEquals, single } from '../model/selection'
import type { ElementNode, Mark, Node, Path, Point, Range, Selection, SelectionRange, TextNode } from '../model/types'
import { marksAtTr, marksOfRange } from './marks'
import { currentRange, flagSwallowed, forEachRange, inForEachRange, mapSince, setCurrentRange } from './ranges'
import type { Transaction } from './transaction'

/**
 * Text editing algorithms. Every change is an operation on `tr`; each returns whether it did anything.
 *
 * Each editing method is a per-range step (`…Step`: edits at one range and returns the range after
 * it, without setting the selection) run by `runStep`: at every selection range when no range is
 * given, else only at the given one (spec §5.2).
 */

export type DeleteUnit = 'character' | 'word' | 'line'

function pathEquals(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

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
  return n
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
function blockTexts(tr: Transaction, blockPath: Path): [TextNode, Path][] {
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
 * inside inline content (the parent `parentType` is an inline element or a `content: 'inline'` block).
 * It counts as one character of its inline content: no caret goes inside, edits remove it whole.
 */
export function isInlineOpaque(tr: Transaction, el: ElementNode, parentType: string): boolean {
  const spec = tr.registry.node(el.type)
  if (spec) return spec.kind === 'inline' && spec.atom === true
  const parent = tr.registry.node(parentType)
  return !!parent && !parent.atom && (parent.kind === 'inline' || parent.content === 'inline')
}

/** The inline opaque elements whose paths lie strictly between `start` and `end` (text paths), in document order. */
function inlineOpaqueBetween(tr: Transaction, start: Point, end: Point): Path[] {
  const out: Path[] = []
  const walk = (nodes: Node[], base: Path, parentType: string) => {
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
function removeTextBetween(tr: Transaction, start: Point, end: Point): void {
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

function getNodeOrNull(tr: Transaction, path: Path): Node | null {
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
 * text at or after it, else the end of the last one before it. With no editable text left, an
 * empty default block is inserted at `at`.
 */
function caretNearRemovedBlock(tr: Transaction, at: Path): Point {
  let before: Point | null = null
  for (const [t, p] of editableTextEntries(tr.doc, tr.registry)) {
    if (comparePath(p, at) >= 0) return { path: p, offset: 0 }
    before = { path: p, offset: t.text.length }
  }
  if (before) return before
  tr.insertNode(at, { id: createId(), type: tr.registry.defaultBlock, data: {}, children: [{ text: '', marks: [] }] })
  return { path: [...at, 0], offset: 0 }
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
  const siblings = pathEquals(parentPath(startBlock), parentPath(endBlock))
  if (pathEquals(startBlock, endBlock)) {
    if (startOpaque) tr.removeNode(startBlock)
    else removeTextBetween(tr, start, end)
  } else if (!siblings) {
    // Blocks that are not siblings (no nested containers yet): text-only deletion, then opaque
    // edges whole (end first: removing it cannot shift the start).
    removeTextBetween(tr, start, end)
    if (endOpaque && !isAncestorPath(endBlock, startBlock)) tr.removeNode(endBlock)
    if (startOpaque && !isAncestorPath(startBlock, endBlock)) tr.removeNode(startBlock)
  } else {
    if (!startOpaque) removeTextBetween(tr, start, lastPoint(blockTexts(tr, startBlock))!)
    if (!endOpaque) removeTextBetween(tr, firstPoint(blockTexts(tr, endBlock))!, end)
    const k = startBlock.length - 1
    const parent = parentPath(startBlock)
    const from = startBlock[k]! + (startOpaque ? 0 : 1)
    const to = endBlock[k]! - (endOpaque ? 0 : 1)
    for (let i = to; i >= from; i--) tr.removeNode([...parent, i])
    if (!startOpaque && !endOpaque) {
      const merged = nextPath(startBlock)
      const node = getNode(tr.doc, merged) as ElementNode
      const position = ((getNode(tr.doc, startBlock) as ElementNode).children ?? []).length
      tr.apply({
        type: 'merge_node',
        path: merged,
        position,
        properties: { id: node.id, type: node.type, data: node.data },
      })
    }
  }
  return startOpaque ? caretNearRemovedBlock(tr, startBlock) : start
}

function emptyDefaultBlock(tr: Transaction, text = '', marks: Mark[] = []): ElementNode {
  return { id: createId(), type: tr.registry.defaultBlock, data: {}, children: [{ text, marks }] }
}

/**
 * The start of the first editable text after the node at `path` (texts inside it excluded); when
 * none follows, or a block-level node is directly followed by an opaque block (the caret would skip
 * past it), an empty default block is inserted right after the node and its start returned.
 */
function caretAfterNode(tr: Transaction, path: Path): Point {
  const node = getNode(tr.doc, path)
  const blockLevel = isElement(node) && tr.registry.node(node.type)?.kind !== 'inline'
  const parent = parentPath(path)
  const siblings = parent.length === 0 ? tr.doc.children : ((getNode(tr.doc, parent) as ElementNode).children ?? [])
  const next = siblings[path[path.length - 1]! + 1]
  if (blockLevel && next && isElement(next) && isOpaque(next, tr.registry)) {
    const at = nextPath(path)
    tr.insertNode(at, emptyDefaultBlock(tr))
    return { path: [...at, 0], offset: 0 }
  }
  for (const [, p] of editableTextEntries(tr.doc, tr.registry)) {
    if (comparePath(p, path) > 0) return { path: p, offset: 0 }
  }
  const at = nextPath(path)
  tr.insertNode(at, emptyDefaultBlock(tr))
  return { path: [...at, 0], offset: 0 }
}

/** What to do with a node-selected element (see `replaceSelectedNode`). */
export type NodeSelectionEdit = 'delete' | 'split' | { text: string } | { node: ElementNode }

/**
 * Every edit of a node selection, in one place. Returns false (nothing done) without a node selection.
 * - `'delete'`: removes the node; the caret is the selection's anchor, mapped.
 * - `'split'`: inserts an empty default block after the node; the caret goes into it.
 * - `{ text }`: replaces the node with a default block holding `text` (stored marks); caret after it.
 * - `{ node }`: replaces the node with `node` (validated: false when rejected); the caret is at the
 *   start of the editable text following it (an empty default block is added when none follows).
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
  if (mode === 'split') {
    const at = nextPath(path)
    tr.insertNode(at, emptyDefaultBlock(tr))
    return caret({ path: [...at, 0], offset: 0 })
  }
  const replacement = 'text' in mode ? emptyDefaultBlock(tr, mode.text, tr.storedMarks ?? []) : mode.node
  tr.insertNode(nextPath(path), replacement)
  if (tr.rejected !== null) return false
  tr.removeNode(path)
  return caret('text' in mode ? { path: [...path, 0], offset: mode.text.length } : caretAfterNode(tr, path))
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
 * node, in an empty default block added when none follows. False without a selection or when `node`
 * is rejected (the tr stays rejected).
 */
export function insertBlockNode(tr: Transaction, node: ElementNode, at?: SelectionRange | Range): boolean {
  let copies = 0
  return runStep(tr, at, (range) => insertBlockNodeStep(tr, copies++ === 0 ? node : withFreshIds(node), range))
}

export function insertBlockNodeStep(tr: Transaction, node: ElementNode, sel: SelectionRange): StepResult {
  if (isNodeRange(sel)) return replaceNodeStep(tr, sel, { node })
  const range = toRange(sel)
  const point = deleteRangeStep(tr, range) ?? range.start
  const blockPath = blockPathOf(tr, point.path)
  const blockNode = getNode(tr.doc, blockPath) as ElementNode
  const block = readBlock(tr, blockPath)
  const offset = toBlockOffset(block, point)
  const empty = (blockNode.children ?? []).every((c) => isText(c) && c.text === '')
  let at: Path
  if (empty) {
    tr.insertNode(blockPath, node)
    if (tr.rejected !== null) return false
    tr.removeNode(nextPath(blockPath))
    at = blockPath
  } else if (offset === 0) {
    at = blockPath
  } else if (offset === block.text.length) {
    at = nextPath(blockPath)
  } else {
    splitBlockAt(tr, point, blockPath, { id: createId(), type: blockNode.type, data: blockNode.data })
    at = nextPath(blockPath)
  }
  if (!empty) {
    tr.insertNode(at, node)
    if (tr.rejected !== null) return false
  }
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
 * The sibling element of `blockPath` in the given direction, when it holds editable text. Opaque
 * siblings (unknown types, atoms) give null: Backspace/Delete node-selects them instead.
 */
function adjacentBlock(tr: Transaction, blockPath: Path, backward: boolean): Path | null {
  const k = blockPath.length - 1
  const index = blockPath[k]! + (backward ? -1 : 1)
  if (index < 0) return null
  const parent = parentPath(blockPath)
  const siblings = parent.length === 0 ? tr.doc.children : ((getNode(tr.doc, parent) as ElementNode).children ?? [])
  const sibling = siblings[index]
  if (!sibling || !isElement(sibling)) return null
  const path = [...parent, index]
  return blockTexts(tr, path).length > 0 ? path : null
}

/** The sibling of `blockPath` in the given direction when it is an opaque element (atom or unknown). */
function adjacentOpaque(tr: Transaction, blockPath: Path, backward: boolean): Path | null {
  const k = blockPath.length - 1
  const index = blockPath[k]! + (backward ? -1 : 1)
  if (index < 0) return null
  const parent = parentPath(blockPath)
  const siblings = parent.length === 0 ? tr.doc.children : ((getNode(tr.doc, parent) as ElementNode).children ?? [])
  const sibling = siblings[index]
  return sibling && isElement(sibling) && isOpaque(sibling, tr.registry) ? [...parent, index] : null
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
  const walk = (nodes: Node[], base: Path, parentType: string) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const path = [...base, i]
      if (isText(n)) {
        current.texts.push([n, path])
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
    // An opaque neighbour is selected first (a second Backspace/Delete removes it); with several
    // ranges, this caret does nothing for this press (it counts as handled).
    const opaque = adjacentOpaque(tr, blockPath, backward)
    // With an explicit range, nothing is done (false): the range it touches must not collapse onto it.
    if (opaque) return several ? !explicit && range : nodeSelection(tr.doc, tr.registry, opaque).ranges[0]!
    const other = adjacentBlock(tr, blockPath, backward)
    if (!other) return false
    const texts = blockTexts(tr, other)
    return backward
      ? deleted({ start: lastPoint(texts)!, end: firstPoint(block.texts)! })
      : deleted({ start: lastPoint(block.texts)!, end: firstPoint(texts)! })
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
 * at the caret (a selected node gets an empty default block after it instead). The new block gets a
 * fresh id and the same type/data, except at the very end of a non-default block, where it is the
 * default block with `data {}`. Each caret ends at the start of its new block.
 */
export function splitBlock(tr: Transaction, at?: SelectionRange | Range): boolean {
  return runStep(tr, at, (range) => (isNodeRange(range) ? replaceNodeStep(tr, range, 'split') : splitBlockStep(tr, toRange(range))))
}

function splitBlockStep(tr: Transaction, range: Range): SelectionRange {
  const point = deleteRangeStep(tr, range) ?? range.start
  const blockPath = blockPathOf(tr, point.path)
  const blockNode = getNode(tr.doc, blockPath) as ElementNode
  const block = readBlock(tr, blockPath)
  const atEnd = toBlockOffset(block, point) === block.text.length
  const props =
    atEnd && blockNode.type !== tr.registry.defaultBlock
      ? { id: createId(), type: tr.registry.defaultBlock, data: {} }
      : { id: createId(), type: blockNode.type, data: blockNode.data }
  return caret(splitBlockAt(tr, point, blockPath, props))
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
