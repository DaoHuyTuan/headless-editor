import { nearestEditablePoint } from '../model/editable'
import { createSelection } from '../model/selection'
import type { Mark, Point, SelectionRange } from '../model/types'
import { transformRange } from '../ops/transform'
import type { Operation } from '../ops/types'
import type { Transaction } from './transaction'

/** One step of `forEachRange`: the range (mapped to the current doc) in, the range after this step out (null drops it). */
export type RangeStep = (range: SelectionRange, tr: Transaction) => SelectionRange | null

/** The state of a running `forEachRange`: one slot per original range, kept in current-doc coordinates. */
interface RangeRun {
  /** Results for the steps already run (index < current), originals for those still to run (index > current). */
  slots: (SelectionRange | null)[]
  /** The index whose callback is running; its slot is not mapped (the callback returns post-edit coordinates). */
  current: number
}

const runs = new WeakMap<Transaction, RangeRun>()

/** True while a `forEachRange` callback of `tr` runs. */
export function inForEachRange(tr: Transaction): boolean {
  return runs.has(tr)
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
    const mapped = transformRange(range, op, i < run.current ? 'backward' : 'forward')
    if (mapped) {
      run.slots[i] = mapped
      return
    }
    const at = rehome()
    run.slots[i] = at && { anchor: at, focus: at }
  })
}

/**
 * Runs `fn` once per selection range, in document order, on the same `tr` (spec §5.2). Before each
 * call the range is mapped through the ops added since the run started, and results already
 * collected are mapped through later ops too. The selection then becomes the collected results,
 * normalized, with `main` on the result of the old main range (or, if that was dropped, the closest
 * result before it, else the first). Every result null: the selection becomes null.
 *
 * Stored marks: every callback starts with the stored marks the run started with, so a caret move
 * (or an insert that consumes them) in one step does not take them from the next; after the run they
 * are what the last callback left. The final selection change clears them only when the run changed
 * nothing in the doc (a pure selection move), as a plain `setSelection` would.
 *
 * With one range this adds exactly the callback's ops, plus a `set_selection` only when its result
 * differs from `tr.selection`. Calls do not nest.
 */
export function forEachRange(tr: Transaction, fn: RangeStep): void {
  if (runs.has(tr)) throw new Error('forEachRange: nested calls are not supported')
  const sel = tr.selection
  if (!sel) return
  const run: RangeRun = { slots: [...sel.ranges], current: -1 }
  const opsBefore = tr.ops.length
  const stored: Mark[] | null = tr.storedMarks
  runs.set(tr, run)
  try {
    for (let i = 0; i < run.slots.length; i++) {
      const range = run.slots[i]
      if (!range) continue
      run.current = i
      tr.setStoredMarks(stored)
      run.slots[i] = fn(range, tr)
    }
  } finally {
    runs.delete(tr)
  }

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
