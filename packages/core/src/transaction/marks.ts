import { editableTextEntries, type NodeTypes } from '../model/editable'
import { deepEqualJson, getNode, isText, textEntries } from '../model/node'
import { comparePoint, nextPath, parentPath } from '../model/path'
import { single } from '../model/selection'
import type { Data, DeepReadonly, Doc, Json, Mark, Path, Point, Range, SelectionRange, TextNode } from '../model/types'
import type { Registry } from '../plugin/registry'
import type { EditorState } from '../state'
import { currentRange, inForEachRange, mapSince, ordered } from './ranges'
import type { Transaction } from './transaction'

/**
 * Mark algorithms. Each records its changes as operations on `tr` and returns whether it applied.
 *
 * With several selection ranges (spec §5.4): the edits act on every range, the queries are true only
 * when every range has the mark, and the stored marks are one set for the whole selection.
 */

/** The parts of a state the mark queries read (an `EditorState` or a transaction's current view). */
export type MarkStateView = Pick<EditorState, 'doc' | 'selection' | 'storedMarks'>

function pathEquals(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function isCollapsedRange(r: Range): boolean {
  return comparePoint(r.start, r.end) === 0
}

/**
 * True when `mark` has `type` and every given data entry deep-equals the mark's (`undefined`
 * entries are ignored, like a missing key).
 */
function matches(mark: Mark, type: string, data?: Partial<Data>): boolean {
  if (mark.type !== type) return false
  if (!data) return true
  return Object.entries(data).every(
    ([k, v]) => v === undefined || (k in mark.data && deepEqualJson(mark.data[k]!, v as Json)),
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

/**
 * The marks every range's start caret has (see `marksAtPoint`), in the first range's order. One
 * range: its caret's marks.
 */
function sharedMarks(doc: DeepReadonly<Doc>, ranges: readonly SelectionRange[]): Mark[] {
  const [first = [], ...rest] = ranges.map((r) => marksAtPoint(doc, ordered(r).start))
  return first.filter((m) => rest.every((ms) => ms.some((x) => x.type === m.type && deepEqualJson(x.data, m.data))))
}

/**
 * `storedMarks`, else the marks of the text at the selection start (see `marksAtPoint`). With several
 * ranges, the marks every range's start has (the stored marks are one set for the whole selection,
 * so a mark only some carets have is not carried to the others).
 */
export function marksAt(state: MarkStateView): Mark[] {
  if (state.storedMarks) return state.storedMarks
  if (!state.selection) return []
  return sharedMarks(state.doc, state.selection.ranges)
}

/** Marks for text inserted at `point` in `tr`: stored marks, else `marksAt` that caret. */
export function marksAtTr(tr: Transaction, point: Point): Mark[] {
  return marksAt({ doc: tr.doc, selection: single({ anchor: point, focus: point }), storedMarks: tr.storedMarks })
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
export function marksOfRange(doc: DeepReadonly<Doc>, range: Range | SelectionRange, types?: NodeTypes): Mark[] | null {
  return coveredTexts(doc, ordered(range), types)[0]?.node.marks ?? null
}

/**
 * True when every selection range has the mark. Per range: collapsed (or covering no characters) →
 * the stored marks, else the marks of the text at its start (`marksAtPoint`); otherwise every text
 * with at least one covered character has a matching mark. Pass the editor's `registry` to ignore
 * texts inside unknown elements and atoms (which are not editable).
 *
 * A non-collapsed range covering no characters (a block boundary, only an atom) is left out when
 * another range covers characters or is a caret: a mark edit can't change it (see `allHaveMark`).
 */
export function isMarkActive(state: MarkStateView, type: string, data?: Partial<Data>, registry?: NodeTypes): boolean {
  const sel = state.selection
  if (!sel) return false
  return allHaveMark(state, sel.ranges, type, data, registry)
}

/**
 * Whether every range in `ranges` has the mark (`isMarkActive`, `toggleMark`'s direction). Ranges a
 * mark edit can't change (non-collapsed, covering no characters: the edit is a no-op there) don't
 * count when some range can be changed (covers characters, or is a caret: the stored marks);
 * otherwise toggling would add forever. When every range is such a range, each reads its start
 * caret, as a lone one always has.
 */
function allHaveMark(
  state: MarkStateView,
  ranges: readonly SelectionRange[],
  type: string,
  data: Partial<Data> | undefined,
  registry: NodeTypes | undefined,
): boolean {
  const has = (m: Mark) => matches(m, type, data)
  const checks = ranges.map((range) => {
    const r = ordered(range)
    const covered = coveredTexts(state.doc, r, registry)
    const inert = covered.length === 0 && !isCollapsedRange(r)
    const active =
      covered.length === 0
        ? (state.storedMarks ?? marksAtPoint(state.doc, r.start)).some(has)
        : covered.every((c) => c.node.marks.some(has))
    return { inert, active }
  })
  const deciding = checks.some((c) => !c.inert) ? checks.filter((c) => !c.inert) : checks
  return deciding.every((c) => c.active)
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

/**
 * The selection ranges a no-range mark edit acts on: every range; inside a `forEachRange` callback,
 * the callback's range (a no-range call there throws in dev mode: it would act once per callback).
 * Null when there is none.
 */
function selectionTargets(tr: Transaction): readonly SelectionRange[] | null {
  if (inForEachRange(tr)) {
    if (tr.dev) throw new Error('Inside forEachRange, pass the callback range to tr editing methods')
    const live = currentRange(tr)
    return live ? [live] : null
  }
  return tr.selection ? tr.selection.ranges : null
}

/**
 * Runs a mark edit (spec §5.2, §5.4) and returns whether it had a target:
 * - `range`: `span` there only (nothing when collapsed). The selection ranges are not set, only
 *   mapped through the ops (inside a `forEachRange` callback too);
 * - no `range`: `span` at every non-collapsed selection range (in document order, each mapped
 *   through the earlier ones' ops), and `carets` once with the collapsed ones (the stored marks are
 *   one set for the whole selection). The selection is not set.
 */
function eachTarget(
  tr: Transaction,
  range: SelectionRange | Range | undefined,
  span: (target: Range) => void,
  carets: (ranges: readonly SelectionRange[]) => void,
): boolean {
  if (range) {
    const target = ordered(range)
    if (!isCollapsedRange(target)) span(target)
    return true
  }
  const ranges = selectionTargets(tr)
  if (!ranges) return false
  const collapsed = ranges.filter((r) => isCollapsedRange(ordered(r)))
  if (collapsed.length > 0) carets(collapsed)
  const from = tr.ops.length
  for (const r of ranges) {
    if (isCollapsedRange(ordered(r))) continue
    const mapped = mapSince(tr, r, from)
    if (mapped) span(ordered(mapped))
  }
  return true
}

/**
 * Updates the stored marks for the carets `ranges`, starting from the current stored marks, else the
 * marks every caret shares (`sharedMarks`; one caret: `marksAt` it).
 */
function updateStored(tr: Transaction, ranges: readonly SelectionRange[], update: (marks: Mark[]) => Mark[]): void {
  tr.setStoredMarks(sortMarks(update(tr.storedMarks ?? sharedMarks(tr.doc, ranges)), tr.registry))
}

/**
 * Adds `mark` over the range (default: every selection range), replacing a mark of the same type
 * with different data. Without an explicit range, collapsed selection ranges update the stored
 * marks (once, for all of them).
 */
export function addMark(tr: Transaction, mark: Mark, range?: SelectionRange | Range): boolean {
  const valid = validated(tr, mark.type, mark.data)
  if (!valid) return false
  return eachTarget(
    tr,
    range,
    (target) =>
      eachCoveredSpan(
        tr,
        target,
        (node) => !node.marks.some((m) => m.type === valid.type && deepEqualJson(m.data, valid.data)),
        (path, node) => {
          const existing = node.marks.find((m) => m.type === valid.type)
          if (existing) tr.apply({ type: 'remove_mark', path, mark: existing })
          tr.apply({ type: 'add_mark', path, mark: valid })
        },
      ),
    (carets) => updateStored(tr, carets, (marks) => [...marks.filter((m) => m.type !== valid.type), valid]),
  )
}

/**
 * Removes marks of `type` over the range (default: every selection range; collapsed ones → the
 * stored marks, once).
 */
export function removeMark(tr: Transaction, type: string, range?: SelectionRange | Range): boolean {
  return eachTarget(
    tr,
    range,
    (target) =>
      eachCoveredSpan(
        tr,
        target,
        (node) => node.marks.some((m) => m.type === type),
        (path, node) => {
          for (const m of node.marks.filter((x) => x.type === type).reverse())
            tr.apply({ type: 'remove_mark', path, mark: m })
        },
      ),
    (carets) => updateStored(tr, carets, (marks) => marks.filter((m) => m.type !== type)),
  )
}

/**
 * Removes the mark when it is active on every selection range (`isMarkActive`), else adds
 * `{ type, data }` at every range. The direction is decided once, over all ranges, before any edit
 * (ranges covering no characters don't count when another range can change: see `allHaveMark`);
 * collapsed ranges toggle it in the stored marks.
 *
 * `toggleMark` takes no range: it always acts on the whole selection. Inside a `forEachRange`
 * callback, use `addMark`/`removeMark` with the callback's range instead (a `toggleMark` there throws
 * in dev mode; otherwise it toggles at the callback's range).
 */
export function toggleMark(tr: Transaction, type: string, data?: Data): boolean {
  const valid = validated(tr, type, data ?? {})
  if (!valid) return false
  const ranges = selectionTargets(tr)
  if (!ranges) return false
  const active = allHaveMark(trView(tr), ranges, type, data, tr.registry)
  return active ? removeMark(tr, type) : addMark(tr, valid)
}
