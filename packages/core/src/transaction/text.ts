import { createId } from '../model/id'
import { editableTextEntries, isNodeSelection, isOpaque, nodeSelection } from '../model/editable'
import { getNode, isElement, isText, sameMarkSet } from '../model/node'
import { comparePath, comparePoint, isAncestorPath, nextPath, parentPath, pointEquals, toRange } from '../model/path'
import type { ElementNode, Mark, Node, Path, Point, Range, Selection, TextNode } from '../model/types'
import { marksAtTr, marksOfRange } from './marks'
import type { Transaction } from './transaction'

/** Text editing algorithms. Every change is an operation on `tr`; each returns whether it did anything. */

export type DeleteUnit = 'character' | 'word' | 'line'

function pathEquals(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Orders the points: callers may pass a backward selection or an unordered range. */
function asRange(at: Selection | Range): Range {
  return toRange('anchor' in at ? at : { anchor: at.start, focus: at.end })
}

function caret(point: Point): Selection {
  return { anchor: point, focus: point }
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
 * The block a range edge at `path` belongs to: the outermost opaque (unknown or atom) block-level
 * element containing it, else the nearest block.
 */
function edgeBlockOf(tr: Transaction, path: Path): Path {
  for (let depth = 1; depth < path.length; depth++) {
    const p = path.slice(0, depth)
    const node = getNode(tr.doc, p)
    if (isElement(node) && isOpaque(node, tr.registry) && tr.registry.node(node.type)?.kind !== 'inline') return p
  }
  return blockPathOf(tr, path)
}

/**
 * The editable caret nearest to `at` (where a removed block was): the start of the first editable
 * text at or after it, else the end of the last one before it. With no editable text left, an
 * empty default block is inserted at `at`.
 */
function nearestEditablePoint(tr: Transaction, at: Path): Point {
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
 * Deletes `range` and collapses the selection at its start. Across sibling blocks the start
 * block keeps its id: its tail and the end block's head are removed, the blocks in between are
 * removed, and the end block is merged into the start block.
 *
 * An opaque edge block (unknown type or atom: no caret can be inside it) counts as fully inside the
 * range: it is removed whole and nothing is merged into or out of it. When the start edge is
 * opaque, the caret lands at the nearest editable point instead.
 */
export function deleteRange(tr: Transaction, range: Range): boolean {
  const { start, end } = asRange(range)
  if (comparePoint(start, end) === 0) return false
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
  tr.setSelection(caret(startOpaque ? nearestEditablePoint(tr, startBlock) : start))
  return true
}

function emptyDefaultBlock(tr: Transaction, text = '', marks: Mark[] = []): ElementNode {
  return { id: createId(), type: tr.registry.defaultBlock, data: {}, children: [{ text, marks }] }
}

/**
 * The start of the first editable text after the node at `path` (texts inside it excluded); when
 * none follows, an empty default block is inserted right after the node and its start returned.
 */
function caretAfterNode(tr: Transaction, path: Path): Point {
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
  const sel = tr.selection
  if (!isNodeSelection(sel)) return false
  const path = sel.node
  if (mode === 'delete') {
    tr.removeNode(path)
    // The removal mapped the selection (dropping `node`); collapse it explicitly.
    const mapped = tr.selection
    tr.setSelection(mapped && caret(mapped.anchor))
    return true
  }
  if (mode === 'split') {
    const at = nextPath(path)
    tr.insertNode(at, emptyDefaultBlock(tr))
    tr.setSelection(caret({ path: [...at, 0], offset: 0 }))
    return true
  }
  const replacement = 'text' in mode ? emptyDefaultBlock(tr, mode.text, tr.storedMarks ?? []) : mode.node
  tr.insertNode(nextPath(path), replacement)
  if (tr.rejected !== null) return false
  tr.removeNode(path)
  tr.setSelection(caret('text' in mode ? { path: [...path, 0], offset: mode.text.length } : caretAfterNode(tr, path)))
  return true
}

/**
 * Inserts the block-level `node` at the selection: it replaces a selected node or an empty block;
 * at offset 0 of a block it goes before it, at its end after it, else the block is split at the caret
 * (a range selection is deleted first). The caret ends at the start of the editable text following
 * the node, in an empty default block added when none follows. False without a selection or when
 * `node` is rejected (the tr stays rejected).
 */
export function insertBlockNode(tr: Transaction, node: ElementNode): boolean {
  if (isNodeSelection(tr.selection)) return replaceSelectedNode(tr, { node })
  const sel = tr.selection
  if (!sel) return false
  const range = toRange(sel)
  const point = deleteRange(tr, range) ? tr.selection!.anchor : range.start
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
  tr.setSelection(caret(caretAfterNode(tr, at)))
  return true
}

/** Deletes the selection (or `at`), then inserts `text` with the insertion marks; the caret ends after it. */
export function insertText(tr: Transaction, text: string, at?: Selection | Range): boolean {
  if (!at && isNodeSelection(tr.selection)) return replaceSelectedNode(tr, text === '' ? 'delete' : { text })
  const target = at ?? tr.selection
  if (!target) return false
  const range = asRange(target)
  // Deleting moves the selection, which clears stored marks; keep them for the insertion.
  const stored = tr.storedMarks
  // Typing over a range keeps the marks of its first covered character (read before deleting).
  const replaced = stored ? null : marksOfRange(tr.doc, range, tr.registry)
  const point = deleteRange(tr, range) ? tr.selection!.anchor : range.start
  tr.setStoredMarks(stored)
  const marks = replaced ?? insertionMarks(tr, point)
  tr.setStoredMarks(null)
  if (text === '') {
    tr.setSelection(caret(point))
    return true
  }
  const node = textAt(tr, point.path)
  if (sameMarkSet(marks, node.marks)) {
    tr.apply({ type: 'insert_text', path: point.path, offset: point.offset, text })
    tr.setSelection(caret({ path: point.path, offset: point.offset + text.length }))
    return true
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
  tr.setSelection(caret({ path, offset: text.length }))
  return true
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

/** Block offset the deletion extends to from `offset`, in the given direction. */
function targetOffset(text: string, offset: number, unit: DeleteUnit, backward: boolean): number {
  if (unit === 'line') return backward ? 0 : text.length
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

function deleteDirection(tr: Transaction, unit: DeleteUnit, backward: boolean): boolean {
  if (isNodeSelection(tr.selection)) return replaceSelectedNode(tr, 'delete')
  const sel = tr.selection
  if (!sel) return false
  if (!pointEquals(sel.anchor, sel.focus)) return deleteRange(tr, toRange(sel))
  const point = sel.anchor
  const blockPath = blockPathOf(tr, point.path)
  // Characters and words stay within the run: an inline atom next to the caret is removed whole
  // (its neighbour texts keep the caret; the selection maps through the removal).
  if (unit !== 'line') {
    const run = runAt(tr, blockPath, point)
    const runOffset = toBlockOffset(run, point)
    const atRunEdge = backward ? runOffset === 0 : runOffset === run.text.length
    const atom = backward ? run.before : run.after
    if (atRunEdge && atom) {
      tr.removeNode(atom)
      return true
    }
    if (!atRunEdge) {
      const target = fromBlockOffset(run, targetOffset(run.text, runOffset, unit, backward))
      return deleteRange(tr, backward ? { start: target, end: point } : { start: point, end: target })
    }
  }
  const block = readBlock(tr, blockPath)
  const offset = toBlockOffset(block, point)
  const atEdge = backward ? offset === 0 : offset === block.text.length
  if (atEdge) {
    // An opaque neighbour is selected first (a second Backspace/Delete removes it).
    const opaque = adjacentOpaque(tr, blockPath, backward)
    if (opaque) {
      tr.setSelection(nodeSelection(tr.doc, tr.registry, opaque))
      return true
    }
    const other = adjacentBlock(tr, blockPath, backward)
    if (!other) return false
    const texts = blockTexts(tr, other)
    return backward
      ? deleteRange(tr, { start: lastPoint(texts)!, end: firstPoint(block.texts)! })
      : deleteRange(tr, { start: lastPoint(block.texts)!, end: firstPoint(texts)! })
  }
  const target = fromBlockOffset(block, targetOffset(block.text, offset, unit, backward))
  return deleteRange(tr, backward ? { start: target, end: point } : { start: point, end: target })
}

export function deleteBackward(tr: Transaction, unit: DeleteUnit = 'character'): boolean {
  return deleteDirection(tr, unit, true)
}

export function deleteForward(tr: Transaction, unit: DeleteUnit = 'character'): boolean {
  return deleteDirection(tr, unit, false)
}

/**
 * Deletes the selection, then splits the block at the caret. The new block gets a fresh id and
 * the same type/data, except at the very end of a non-default block, where it is the default
 * block with `data {}`. The caret ends at the start of the new block.
 */
export function splitBlock(tr: Transaction): boolean {
  if (isNodeSelection(tr.selection)) return replaceSelectedNode(tr, 'split')
  const sel = tr.selection
  if (!sel) return false
  const range = toRange(sel)
  const point = deleteRange(tr, range) ? tr.selection!.anchor : range.start
  const blockPath = blockPathOf(tr, point.path)
  const blockNode = getNode(tr.doc, blockPath) as ElementNode
  const block = readBlock(tr, blockPath)
  const atEnd = toBlockOffset(block, point) === block.text.length
  const props =
    atEnd && blockNode.type !== tr.registry.defaultBlock
      ? { id: createId(), type: tr.registry.defaultBlock, data: {} }
      : { id: createId(), type: blockNode.type, data: blockNode.data }

  tr.setSelection(caret(splitBlockAt(tr, point, blockPath, props)))
  return true
}

/**
 * Splits the text at `point`, then every ancestor up to and including the block at `blockPath`;
 * the new right-hand block gets `props` (inline ancestors get fresh ids). Returns the start of the
 * new block (its first text, at offset 0).
 */
export function splitBlockAt(tr: Transaction, point: Point, blockPath: Path, props: Partial<ElementNode>): Point {
  let path = point.path
  let position = point.offset
  tr.apply({ type: 'split_node', path, position, properties: { marks: textAt(tr, path).marks } })
  while (path.length > blockPath.length + 1) {
    position = path[path.length - 1]! + 1
    path = parentPath(path)
    const inline = getNode(tr.doc, path) as ElementNode
    tr.apply({ type: 'split_node', path, position, properties: { id: createId(), type: inline.type, data: inline.data } })
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
  tr.setSelection({ anchor, focus })
  return true
}
