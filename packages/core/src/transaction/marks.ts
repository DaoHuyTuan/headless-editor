import { editableTextEntries, type NodeTypes } from '../model/editable'
import { deepEqualJson, getNode, isText, textEntries } from '../model/node'
import { comparePoint, nextPath, parentPath } from '../model/path'
import type { Data, DeepReadonly, Doc, Json, Mark, Path, Point, Range, Selection, TextNode } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { EditorState } from '../state'
import type { Transaction } from './transaction'

/** Mark algorithms. Each records its changes as operations on `tr` and returns whether it applied. */

/** The parts of a state the mark queries read (an `EditorState` or a transaction's current view). */
export type MarkStateView = Pick<EditorState, 'doc' | 'selection' | 'storedMarks'>

function pathEquals(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Orders the two points (callers may pass an unordered range or a backward selection). */
function ordered(at: Range | Selection): Range {
  const [a, b] = 'anchor' in at ? [at.anchor, at.focus] : [at.start, at.end]
  return comparePoint(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a }
}

function isCollapsedRange(r: Range): boolean {
  return comparePoint(r.start, r.end) === 0
}

/** True when `mark` has `type` and every given data entry deep-equals the mark's. */
function matches(mark: Mark, type: string, data?: Partial<Data>): boolean {
  if (mark.type !== type) return false
  if (!data) return true
  return Object.entries(data).every(
    ([k, v]) => v !== undefined && k in mark.data && deepEqualJson(mark.data[k]!, v as Json),
  )
}

function sortMarks(marks: Mark[], registry: Registry): Mark[] {
  return [...marks].sort((a, b) => registry.markRank(a.type) - registry.markRank(b.type))
}

/**
 * The marks of the text at `point`. At offset 0 of a text whose previous sibling is a text, the
 * caret belongs to the end of that previous text.
 */
function marksAtPoint(doc: DeepReadonly<Doc>, point: Point): Mark[] {
  const node = getNode(doc, point.path)
  if (!isText(node)) throw new Error(`Expected a text node at [${point.path}]`)
  const index = point.path[point.path.length - 1]!
  if (point.offset === 0 && index > 0) {
    const parent = parentPath(point.path)
    const prev = getNode(doc, [...parent, index - 1])
    if (isText(prev)) return prev.marks
  }
  return node.marks
}

/** `storedMarks`, else the marks of the text at the selection start (see `marksAtPoint`). */
export function marksAt(state: MarkStateView): Mark[] {
  if (state.storedMarks) return state.storedMarks
  if (!state.selection) return []
  return marksAtPoint(state.doc, ordered(state.selection).start)
}

/** Marks for text inserted at `point` in `tr`: stored marks, else `marksAt` that caret. */
export function marksAtTr(tr: Transaction, point: Point): Mark[] {
  return marksAt({ doc: tr.doc, selection: { anchor: point, focus: point }, storedMarks: tr.storedMarks })
}

interface Covered {
  node: TextNode
  path: Path
  from: number
  to: number
}

/**
 * Texts in `range` with the character span the range covers in each (non-empty spans only). With
 * `types`, texts inside opaque elements (unknown types, atoms) are skipped.
 */
function coveredTexts(doc: DeepReadonly<Doc>, range: Range, types?: NodeTypes): Covered[] {
  const out: Covered[] = []
  const entries = types ? editableTextEntries(doc, types, range) : textEntries(doc, range)
  for (const [node, path] of entries) {
    const from = pathEquals(path, range.start.path) ? range.start.offset : 0
    const to = pathEquals(path, range.end.path) ? range.end.offset : node.text.length
    if (to > from) out.push({ node, path, from, to })
  }
  return out
}

/**
 * Marks of the first character `range` covers (what typing over the range keeps), or null when it
 * covers no characters. Unlike the caret rule, a range replacement keeps the replaced content's marks.
 */
export function marksOfRange(doc: DeepReadonly<Doc>, range: Range | Selection, types?: NodeTypes): Mark[] | null {
  return coveredTexts(doc, ordered(range), types)[0]?.node.marks ?? null
}

/**
 * Collapsed (or covering no characters) → `marksAt`; a range → every text with at least one
 * covered character has a matching mark. Pass the editor's `registry` to ignore texts inside
 * unknown elements and atoms (which are not editable).
 */
export function isMarkActive(state: MarkStateView, type: string, data?: Partial<Data>, registry?: NodeTypes): boolean {
  const sel = state.selection
  if (!sel) return false
  const covered = coveredTexts(state.doc, ordered(sel), registry)
  if (covered.length === 0) return marksAt(state).some((m) => matches(m, type, data))
  return covered.every((c) => c.node.marks.some((m) => matches(m, type, data)))
}

function trView(tr: Transaction): MarkStateView {
  return { doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks }
}

/**
 * Applies `change` to the covered span of every text in `range` that `needsChange`, splitting
 * texts at the range edges first. Texts are visited last-to-first so earlier paths stay valid.
 */
function eachCoveredSpan(
  tr: Transaction,
  range: Range,
  needsChange: (node: TextNode) => boolean,
  change: (path: Path, node: TextNode) => void,
): void {
  const covered = coveredTexts(tr.doc, range, tr.registry).filter((c) => needsChange(c.node))
  for (let i = covered.length - 1; i >= 0; i--) {
    const { node, from, to } = covered[i]!
    let path = covered[i]!.path
    if (to < node.text.length) {
      tr.apply({ type: 'split_node', path, position: to, properties: { marks: node.marks } })
    }
    if (from > 0) {
      tr.apply({ type: 'split_node', path, position: from, properties: { marks: node.marks } })
      path = nextPath(path)
    }
    change(path, getNode(tr.doc, path) as TextNode)
  }
}

/** Checks the mark type is registered and validates its data; on failure sets `tr.rejected` and returns null. */
function validated(tr: Transaction, type: string, data: unknown): Mark | null {
  if (!tr.registry.mark(type)) {
    tr.rejected = `Unknown mark type "${type}"`
    return null
  }
  const result = tr.registry.validateData(type, data)
  if (!result.ok) {
    tr.rejected = result.message
    return null
  }
  return { type, data: result.data }
}

/** The range to act on: `range` (ordered), else the selection. Null without either. */
function targetRange(tr: Transaction, range?: Range): Range | null {
  if (range) return ordered(range)
  return tr.selection ? ordered(tr.selection) : null
}

/** Updates stored marks at the caret, starting from `marksAt`. */
function updateStored(tr: Transaction, update: (marks: Mark[]) => Mark[]): void {
  tr.setStoredMarks(sortMarks(update(marksAt(trView(tr))), tr.registry))
}

/**
 * Adds `mark` over the range (default: the selection), replacing a mark of the same type with
 * different data. Without an explicit range, a collapsed selection updates the stored marks.
 */
export function addMark(tr: Transaction, mark: Mark, range?: Range): boolean {
  const valid = validated(tr, mark.type, mark.data)
  if (!valid) return false
  const target = targetRange(tr, range)
  if (!target) return false
  if (isCollapsedRange(target)) {
    if (!range) updateStored(tr, (marks) => [...marks.filter((m) => m.type !== valid.type), valid])
    return true
  }
  eachCoveredSpan(
    tr,
    target,
    (node) => !node.marks.some((m) => m.type === valid.type && deepEqualJson(m.data, valid.data)),
    (path, node) => {
      const existing = node.marks.find((m) => m.type === valid.type)
      if (existing) tr.apply({ type: 'remove_mark', path, mark: existing })
      tr.apply({ type: 'add_mark', path, mark: valid })
    },
  )
  return true
}

/** Removes marks of `type` over the range (default: the selection; collapsed → stored marks). */
export function removeMark(tr: Transaction, type: string, range?: Range): boolean {
  const target = targetRange(tr, range)
  if (!target) return false
  if (isCollapsedRange(target)) {
    if (!range) updateStored(tr, (marks) => marks.filter((m) => m.type !== type))
    return true
  }
  eachCoveredSpan(
    tr,
    target,
    (node) => node.marks.some((m) => m.type === type),
    (path, node) => {
      for (const m of node.marks.filter((x) => x.type === type).reverse()) tr.apply({ type: 'remove_mark', path, mark: m })
    },
  )
  return true
}

/**
 * Removes the mark when it is active on the whole selection, else adds `{ type, data }`.
 * A collapsed selection toggles it in the stored marks.
 */
export function toggleMark(tr: Transaction, type: string, data?: Data): boolean {
  const valid = validated(tr, type, data ?? {})
  if (!valid) return false
  if (!tr.selection) return false
  const active = isMarkActive(trView(tr), type, data, tr.registry)
  return active ? removeMark(tr, type) : addMark(tr, valid)
}
