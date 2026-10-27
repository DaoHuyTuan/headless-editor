import { createId } from '../model/id'
import { getNode, isElement, isText, sameMarkSet, textEntries } from '../model/node'
import { comparePath, comparePoint, nextPath, parentPath, pointEquals, toRange } from '../model/path'
import type { ElementNode, Mark, Path, Point, Range, Selection, TextNode } from '../model/types'
import type { Transaction } from './transaction'

/** Text editing algorithms. Every change is an operation on `tr`; each returns whether it did anything. */

export type DeleteUnit = 'character' | 'word' | 'line'

function pathEquals(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function asRange(at: Selection | Range): Range {
  return 'anchor' in at ? toRange(at) : at
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
function blockPathOf(tr: Transaction, path: Path): Path {
  for (let depth = path.length - 1; depth >= 1; depth--) {
    const p = path.slice(0, depth)
    const node = getNode(tr.doc, p)
    if (isElement(node) && tr.registry.node(node.type)?.kind !== 'inline') return p
  }
  throw new Error(`No block contains [${path}]`)
}

/** Every text of the element at `blockPath`, with absolute paths, in document order. */
function blockTexts(tr: Transaction, blockPath: Path): [TextNode, Path][] {
  const block = getNode(tr.doc, blockPath) as ElementNode
  return [...textEntries(block)].map(([t, rel]) => [t, [...blockPath, ...rel]])
}

function firstPoint(texts: [TextNode, Path][]): Point | null {
  const first = texts[0]
  return first ? { path: first[1], offset: 0 } : null
}

function lastPoint(texts: [TextNode, Path][]): Point | null {
  const last = texts[texts.length - 1]
  return last ? { path: last[1], offset: last[0].text.length } : null
}

/** The marks text inserted at `point` gets. Task 10 swaps the fallback for `marksAt`. */
export function insertionMarks(tr: Transaction, point: Point): Mark[] {
  return tr.storedMarks ?? textAt(tr, point.path).marks
}

/** Removes the text between two points, text by text (no nodes are removed). */
function removeTextBetween(tr: Transaction, start: Point, end: Point): void {
  const texts = [...textEntries(tr.doc)].filter(
    ([, p]) => comparePath(p, start.path) >= 0 && comparePath(p, end.path) <= 0,
  )
  for (let i = texts.length - 1; i >= 0; i--) {
    const [t, p] = texts[i]!
    const from = pathEquals(p, start.path) ? start.offset : 0
    const to = pathEquals(p, end.path) ? end.offset : t.text.length
    if (to > from) tr.apply({ type: 'remove_text', path: p, offset: from, text: t.text.slice(from, to) })
  }
}

/**
 * Deletes `range` and collapses the selection at its start. Across sibling blocks the start
 * block keeps its id: its tail and the end block's head are removed, the blocks in between are
 * removed, and the end block is merged into the start block.
 */
export function deleteRange(tr: Transaction, range: Range): boolean {
  const { start, end } = asRange(range)
  if (comparePoint(start, end) === 0) return false
  const startBlock = blockPathOf(tr, start.path)
  const endBlock = blockPathOf(tr, end.path)
  if (pathEquals(startBlock, endBlock) || !pathEquals(parentPath(startBlock), parentPath(endBlock))) {
    // Same block, or blocks that are not siblings (not produced in M1): text-only deletion.
    removeTextBetween(tr, start, end)
  } else {
    removeTextBetween(tr, start, lastPoint(blockTexts(tr, startBlock))!)
    removeTextBetween(tr, firstPoint(blockTexts(tr, endBlock))!, end)
    const k = startBlock.length - 1
    for (let i = endBlock[k]! - 1; i > startBlock[k]!; i--) tr.removeNode([...parentPath(startBlock), i])
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
  tr.setSelection(caret(start))
  return true
}

/** Deletes the selection (or `at`), then inserts `text` with the insertion marks; the caret ends after it. */
export function insertText(tr: Transaction, text: string, at?: Selection | Range): boolean {
  const target = at ?? tr.selection
  if (!target) return false
  const range = asRange(target)
  // Deleting moves the selection, which clears stored marks; keep them for the insertion.
  const stored = tr.storedMarks
  deleteRange(tr, range)
  tr.setStoredMarks(stored)
  const point = range.start
  const marks = insertionMarks(tr, point)
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

interface BlockText {
  texts: [TextNode, Path][]
  text: string
}

function readBlock(tr: Transaction, blockPath: Path): BlockText {
  const texts = blockTexts(tr, blockPath)
  return { texts, text: texts.map(([t]) => t.text).join('') }
}

function toBlockOffset(block: BlockText, point: Point): number {
  let acc = 0
  for (const [t, p] of block.texts) {
    if (pathEquals(p, point.path)) return acc + point.offset
    acc += t.text.length
  }
  throw new Error(`Point [${point.path}] is not in the block`)
}

function fromBlockOffset(block: BlockText, offset: number): Point {
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

/** The sibling element of `blockPath` in the given direction, when it holds text. */
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

function deleteDirection(tr: Transaction, unit: DeleteUnit, backward: boolean): boolean {
  const sel = tr.selection
  if (!sel) return false
  if (!pointEquals(sel.anchor, sel.focus)) return deleteRange(tr, toRange(sel))
  const point = sel.anchor
  const blockPath = blockPathOf(tr, point.path)
  const block = readBlock(tr, blockPath)
  const offset = toBlockOffset(block, point)
  const atEdge = backward ? offset === 0 : offset === block.text.length
  if (atEdge) {
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
  const sel = tr.selection
  if (!sel) return false
  const range = toRange(sel)
  deleteRange(tr, range)
  const point = range.start
  const blockPath = blockPathOf(tr, point.path)
  const blockNode = getNode(tr.doc, blockPath) as ElementNode
  const block = readBlock(tr, blockPath)
  const atEnd = toBlockOffset(block, point) === block.text.length
  const props =
    atEnd && blockNode.type !== tr.registry.defaultBlock
      ? { id: createId(), type: tr.registry.defaultBlock, data: {} }
      : { id: createId(), type: blockNode.type, data: blockNode.data }

  // Split the text, then every ancestor up to and including the block.
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
  tr.setSelection(caret({ path: [...newBlock, ...point.path.slice(blockPath.length).map(() => 0)], offset: 0 }))
  return true
}

/** Selects from the start of the first text to the end of the last text in the doc. */
export function selectAll(tr: Transaction): boolean {
  const texts = [...textEntries(tr.doc)]
  const anchor = firstPoint(texts)
  const focus = lastPoint(texts)
  if (!anchor || !focus) return false
  tr.setSelection({ anchor, focus })
  return true
}
