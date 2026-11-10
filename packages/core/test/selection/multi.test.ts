import { describe, expect, it } from 'vitest'
import {
  createSelection,
  isNodeRange,
  mainRange,
  rangeEquals,
  selectionEquals,
  single,
  type SelectionRange,
} from '../../src/model/selection'

const p = (offset: number, path: number[] = [0, 0]) => ({ path, offset })
const caret = (offset: number, path: number[] = [0, 0]): SelectionRange => ({ anchor: p(offset, path), focus: p(offset, path) })
const range = (a: number, f: number, path: number[] = [0, 0]): SelectionRange => ({ anchor: p(a, path), focus: p(f, path) })

describe('createSelection', () => {
  it('sorts ranges by document position and keeps main on the same range', () => {
    const sel = createSelection([caret(5), caret(1)], 0)
    expect(sel.ranges[0]!.anchor.offset).toBe(1)
    expect(sel.ranges[1]!.anchor.offset).toBe(5)
    expect(sel.main).toBe(1)
  })

  it('merges overlapping ranges', () => {
    const sel = createSelection([range(1, 4), range(3, 6)], 0)
    expect(sel.ranges).toHaveLength(1)
    expect(sel.ranges[0]).toEqual(range(1, 6))
  })

  it('merges touching ranges', () => {
    const sel = createSelection([range(1, 3), range(3, 5)], 0)
    expect(sel.ranges).toEqual([range(1, 5)])
    const carets = createSelection([caret(2), caret(2)], 1)
    expect(carets.ranges).toHaveLength(1)
    expect(carets.main).toBe(0)
  })

  it('a caret inside a range is absorbed', () => {
    const sel = createSelection([range(1, 6), caret(3)], 0)
    expect(sel.ranges).toEqual([range(1, 6)])
  })

  it('main follows the merged range that contains the old main', () => {
    const sel = createSelection([caret(0), range(3, 5), range(5, 8), caret(10)], 2)
    expect(sel.ranges).toHaveLength(3)
    expect(sel.main).toBe(1)
    expect(mainRange(sel)).toEqual(range(3, 8))
  })

  it('a node range drops the other ranges', () => {
    const node: SelectionRange = { anchor: p(0, [1]), focus: p(0, [1]), node: [1] }
    const sel = createSelection([caret(1), node, caret(4)], 0)
    expect(sel.ranges).toHaveLength(1)
    expect(isNodeRange(sel.ranges[0]!)).toBe(true)
    expect(sel.main).toBe(0)
  })

  it('a non-main node range still wins: it is kept exactly, alone, as main (3.16)', () => {
    const node: SelectionRange = { anchor: p(2, [0, 0]), focus: p(0, [2, 0]), node: [1] }
    expect(createSelection([caret(1), range(3, 5, [3, 0]), node], 1)).toEqual({ ranges: [node], main: 0 })
    // With two node ranges, the main one is kept.
    const other: SelectionRange = { anchor: p(0, [4, 0]), focus: p(0, [4, 0]), node: [3] }
    expect(createSelection([node, other], 1)).toEqual({ ranges: [other], main: 0 })
    expect(createSelection([node, other], 0)).toEqual({ ranges: [node], main: 0 })
  })

  it('merges ranges that overlap or touch across blocks (3.16)', () => {
    const across = (a: number, aPath: number[], f: number, fPath: number[]): SelectionRange => ({
      anchor: p(a, aPath),
      focus: p(f, fPath),
    })
    // Overlapping: [0,0]:2 → [1,0]:3 and [1,0]:1 → [2,0]:4 (backward, holding main).
    const sel = createSelection([across(2, [0, 0], 3, [1, 0]), across(4, [2, 0], 1, [1, 0]), caret(0, [3, 0])], 1)
    expect(sel).toEqual({ ranges: [across(4, [2, 0], 2, [0, 0]), caret(0, [3, 0])], main: 0 })
    // Touching at a point in another block, and a caret at the shared point.
    const touch = createSelection([across(1, [0, 0], 2, [1, 0]), caret(2, [1, 0]), across(2, [1, 0], 0, [2, 0])], 2)
    expect(touch).toEqual({ ranges: [across(1, [0, 0], 0, [2, 0])], main: 0 })
  })

  it('keeps anchor/focus direction of a backward range when not merged', () => {
    const sel = createSelection([range(5, 2), caret(8)], 0)
    expect(sel.ranges[0]).toEqual(range(5, 2))
  })

  it('merged range takes the direction of the range holding main, else forward', () => {
    expect(createSelection([range(1, 4), range(6, 3)], 1).ranges[0]).toEqual(range(6, 1))
    expect(createSelection([range(4, 1), range(3, 6)], 1).ranges[0]).toEqual(range(1, 6))
  })

  it('orders across different paths', () => {
    const sel = createSelection([caret(0, [1, 0]), caret(9, [0, 0])], 0)
    expect(sel.ranges[0]!.anchor.path).toEqual([0, 0])
    expect(sel.main).toBe(1)
  })

  it('throws on an empty list', () => {
    expect(() => createSelection([])).toThrow()
  })

  it('defaults main to 0 and clamps an out-of-range main', () => {
    expect(createSelection([caret(1), caret(3)]).main).toBe(0)
    expect(createSelection([caret(1), caret(3)], 9).main).toBe(1)
  })
})

describe('helpers', () => {
  it('single wraps one range', () => {
    expect(single(caret(2))).toEqual({ ranges: [caret(2)], main: 0 })
  })

  it('rangeEquals / selectionEquals', () => {
    expect(rangeEquals(range(1, 2), range(1, 2))).toBe(true)
    expect(rangeEquals(range(1, 2), range(2, 1))).toBe(false)
    expect(rangeEquals({ ...caret(1), node: [0] }, caret(1))).toBe(false)
    const a = createSelection([caret(1), caret(3)], 0)
    expect(selectionEquals(a, createSelection([caret(1), caret(3)], 0))).toBe(true)
    expect(selectionEquals(a, createSelection([caret(1), caret(3)], 1))).toBe(false)
    expect(selectionEquals(a, null)).toBe(false)
    expect(selectionEquals(null, null)).toBe(true)
  })
})

describe('public selection exports', () => {
  it('the package index exports rangeEquals and selectionEquals', async () => {
    const api = await import('../../src/index')
    const r = { anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } }
    expect(api.rangeEquals(r, { ...r })).toBe(true)
    expect(api.selectionEquals(api.single(r), api.single({ ...r }))).toBe(true)
  })
})
