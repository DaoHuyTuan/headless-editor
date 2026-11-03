import { comparePoint, pointEquals } from './path'
import type { Path, Point } from './types'

/** One selection range. A node range selects the opaque element at `node`. */
export type SelectionRange = { anchor: Point; focus: Point; node?: Path }

/** Temporary name; Task 2 renames this to `Selection`. */
export type MultiSelection = { ranges: SelectionRange[]; main: number }

export function single(range: SelectionRange): MultiSelection {
  return { ranges: [range], main: 0 }
}

export function isNodeRange(r: SelectionRange): r is SelectionRange & { node: Path } {
  return r.node !== undefined
}

export function mainRange(sel: MultiSelection): SelectionRange {
  return sel.ranges[sel.main]!
}

function pathEquals(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function rangeEquals(a: SelectionRange, b: SelectionRange): boolean {
  if ((a.node === undefined) !== (b.node === undefined)) return false
  if (a.node && b.node && !pathEquals(a.node, b.node)) return false
  return pointEquals(a.anchor, b.anchor) && pointEquals(a.focus, b.focus)
}

export function selectionEquals(a: MultiSelection | null, b: MultiSelection | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.main === b.main && a.ranges.length === b.ranges.length && a.ranges.every((r, i) => rangeEquals(r, b.ranges[i]!))
}

type Entry = { range: SelectionRange; start: Point; end: Point; isMain: boolean }

function bounds(range: SelectionRange): { start: Point; end: Point } {
  return comparePoint(range.anchor, range.focus) <= 0
    ? { start: range.anchor, end: range.focus }
    : { start: range.focus, end: range.anchor }
}

/**
 * Builds a normalized selection: sorted, with overlapping or touching ranges merged,
 * `main` following the merged range that contains it. A node range is always alone.
 * `main` defaults to 0 and is clamped into range. Throws on an empty list.
 */
export function createSelection(ranges: SelectionRange[], main = 0): MultiSelection {
  if (ranges.length === 0) throw new Error('A selection needs at least one range')
  const mainIdx = Math.min(Math.max(main, 0), ranges.length - 1)

  // A node range is the only range (keep the main one if it is a node range).
  const nodeIdx = isNodeRange(ranges[mainIdx]!) ? mainIdx : ranges.findIndex(isNodeRange)
  if (nodeIdx >= 0) return { ranges: [ranges[nodeIdx]!], main: 0 }

  const entries: Entry[] = ranges
    .map((range, i) => ({ range, ...bounds(range), isMain: i === mainIdx }))
    .sort((a, b) => comparePoint(a.start, b.start) || comparePoint(a.end, b.end))

  const out: SelectionRange[] = []
  let newMain = 0
  let group: Entry[] = []
  let groupEnd: Point | null = null

  const flush = () => {
    if (group.length === 0) return
    const mainEntry = group.find((e) => e.isMain)
    if (mainEntry) newMain = out.length
    if (group.length === 1) {
      out.push(group[0]!.range)
    } else {
      const start = group[0]!.start
      const end = groupEnd!
      const backward = mainEntry ? comparePoint(mainEntry.range.anchor, mainEntry.range.focus) > 0 : false
      out.push(backward ? { anchor: end, focus: start } : { anchor: start, focus: end })
    }
    group = []
    groupEnd = null
  }

  for (const e of entries) {
    if (groupEnd && comparePoint(e.start, groupEnd) <= 0) {
      group.push(e)
      if (comparePoint(e.end, groupEnd) > 0) groupEnd = e.end
    } else {
      flush()
      group = [e]
      groupEnd = e.end
    }
  }
  flush()
  return { ranges: out, main: newMain }
}
