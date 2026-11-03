import { nearestEditablePoint } from '../model/editable'
import { pointEquals } from '../model/path'
import { createSelection } from '../model/selection'
import type { Mark, Point, SelectionRange } from '../model/types'
import { transformPoint, transformRange } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { Transaction } from './transaction'

/**
 * One step of `forEachRange`: the range (mapped to the current doc) in, the range after this step out
 * (null drops it). Returning nothing keeps the range the `tr` editing methods called with an explicit
 * range left (each records its result), else the input range mapped through the step's ops. `index`
 * is the range's index in the selection the run started with.
 */
export type RangeStep = (range: SelectionRange, tr: Transaction, index: number) => SelectionRange | null | void

/** The state of a running `forEachRange`: one slot per original range, kept in current-doc coordinates. */
interface RangeRun {
  /** Results for the steps already run (index < current), originals for those still to run (index > current). */
  slots: (SelectionRange | null)[]
  /** The index whose callback is running; its slot is not mapped (the callback returns post-edit coordinates). */
  current: number
  /**
   * The running callback's range as the `tr` methods leave it: its input range, mapped through the
   * callback's ops, and replaced by the result of each editing method called in it.
   */
  live: SelectionRange | null
  /**
   * Per slot still to run: whether a point of it fell strictly inside content an earlier step removed
   * (not at the removal's edge). Such a slot that is now collapsed was swallowed: its step is skipped
   * and it merges with the earlier result at normalization (its own step would delete past it).
   */
  swallowed: boolean[]
}

/** Whether `point` lies strictly inside the content `op` removes (its edges excluded). */
function removedBy(point: Point, op: Operation): boolean {
  if (op.type === 'remove_text')
    return (
      op.path.length === point.path.length &&
      op.path.every((v, i) => v === point.path[i]) &&
      op.offset < point.offset &&
      point.offset < op.offset + op.text.length
    )
  return op.type === 'remove_node' && transformPoint(point, op) === null
}

const runs = new WeakMap<Transaction, RangeRun>()

/** True while a `forEachRange` callback of `tr` runs. */
export function inForEachRange(tr: Transaction): boolean {
  return runs.has(tr)
}

/** The running callback's current range (see `RangeRun.live`); null outside a run or when it was lost. */
export function currentRange(tr: Transaction): SelectionRange | null {
  return runs.get(tr)?.live ?? null
}

/** Records the result of an editing method called inside a callback (see `RangeRun.live`). */
export function setCurrentRange(tr: Transaction, range: SelectionRange | null): void {
  const run = runs.get(tr)
  if (run) run.live = range
}

/**
 * Called by `Transaction.apply` after a doc op: maps every slot of the running `forEachRange` except
 * the current one. Ranges still to run map with **forward** affinity (an insert exactly at a later
 * caret leaves that caret after the inserted text, as in VS Code and CodeMirror); results already
 * collected map **backward** (an insert at an earlier result's caret leaves it before the text). A
 * slot whose text was removed is re-homed to a caret at the nearest editable point (as
 * `Transaction.mapSelection` does), and dropped only when there is none.
 */
export function mapRun(tr: Transaction, op: Operation): void {
  const run = runs.get(tr)
  if (!run) return
  let target: Point | null | undefined
  const rehome = (): Point | null => {
    if (target === undefined)
      target = op.type === 'remove_node' ? nearestEditablePoint(tr.doc, tr.registry, op.path) : null
    return target
  }
  // In place: `forEachRange` holds the array while a callback runs.
  run.slots.forEach((range, i) => {
    if (!range || i === run.current) return
    if (i > run.current && (removedBy(range.anchor, op) || removedBy(range.focus, op))) run.swallowed[i] = true
    const mapped = transformRange(range, op, i < run.current ? 'backward' : 'forward')
    if (mapped) {
      run.slots[i] = mapped
      return
    }
    const at = rehome()
    run.slots[i] = at && { anchor: at, focus: at }
  })
  if (run.live) {
    const live = transformRange(run.live, op)
    const at = live ? null : rehome()
    run.live = live ?? (at && { anchor: at, focus: at })
  }
}

/**
 * Runs `fn` once per selection range, in document order, on the same `tr` (spec §5.2). Before each
 * call the range is mapped through the ops added since the run started, and results already
 * collected are mapped through later ops too. A range still to run that an earlier step's removal
 * swallowed (a point strictly inside the removed content, and now collapsed) is not run: it stays
 * where it was mapped and merges at normalization. Inside `fn`, the `tr` editing methods must be given the
 * range explicitly (a call without one throws in dev mode, and otherwise acts at the callback's
 * range): they then edit there without setting the selection, and a callback that returns nothing
 * keeps the range they leave. The selection then becomes the collected results,
 * normalized, with `main` on the result of the old main range (or, if that was dropped, the closest
 * result before it, else the first). Every result null: the selection becomes null.
 *
 * Stored marks: every callback starts with the stored marks the run started with, so a caret move
 * (or an insert that consumes them) in one step does not take them from the next. After the run they
 * do not depend on the order of the steps:
 * - if any step cleared or consumed them (left them null), they are null;
 * - else if a step set other marks, they are those (the last such step's);
 * - else they are the marks the run started with.
 *
 * "The selection moved for another reason than this edit" (spec §5.2) reads as: the run changed
 * nothing in the doc. A run with any doc change keeps the marks above through its final selection
 * change; a pure selection move clears them, as a plain `setSelection` would.
 *
 * With one range this adds exactly the callback's ops, plus a `set_selection` only when its result
 * differs from `tr.selection`. Calls do not nest.
 */
export function forEachRange(tr: Transaction, fn: RangeStep): void {
  if (runs.has(tr)) throw new Error('forEachRange: nested calls are not supported')
  const sel = tr.selection
  if (!sel) return
  const run: RangeRun = { slots: [...sel.ranges], current: -1, live: null, swallowed: sel.ranges.map(() => false) }
  const opsBefore = tr.ops.length
  const stored: Mark[] | null = tr.storedMarks
  let consumed = false
  let changed: Mark[] | undefined
  runs.set(tr, run)
  try {
    for (let i = 0; i < run.slots.length; i++) {
      const range = run.slots[i]
      if (!range) continue
      // Swallowed by an earlier step: kept as mapped (it merges with that step's result).
      if (run.swallowed[i] && pointEquals(range.anchor, range.focus)) continue
      run.current = i
      run.live = range
      tr.setStoredMarks(stored)
      const result = fn(range, tr, i)
      run.slots[i] = result === undefined ? run.live : result
      const after = tr.storedMarks
      if (after === stored) continue
      if (after === null) consumed = true
      else changed = after
    }
  } finally {
    runs.delete(tr)
  }
  tr.setStoredMarks(consumed ? null : (changed ?? stored))

  const out: SelectionRange[] = []
  let main = 0
  run.slots.forEach((range, i) => {
    if (!range) return
    if (i <= sel.main) main = out.length
    out.push(range)
  })
  const docChanged = tr.ops.slice(opsBefore).some((op) => op.type !== 'set_selection')
  const marks = tr.storedMarks
  tr.setSelection(out.length === 0 ? null : createSelection(out, main))
  if (docChanged) tr.setStoredMarks(marks)
}
