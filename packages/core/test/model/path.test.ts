import { describe, expect, it } from 'vitest'
import { sel } from '../../src/testing/builders'
import {
  comparePath,
  comparePoint,
  isAncestorPath,
  isCollapsed,
  nextPath,
  parentPath,
  pointEquals,
  previousPath,
  toRange,
} from '../../src/model/path'

describe('path helpers', () => {
  it('comparePath', () => {
    expect(comparePath([0, 1], [0, 2])).toBe(-1)
    expect(comparePath([1], [0, 9])).toBe(1)
    expect(comparePath([0], [0, 1])).toBe(0)
    expect(comparePath([0, 1], [0, 1])).toBe(0)
  })
  it('ancestor / parent / next / previous', () => {
    expect(isAncestorPath([0], [0, 1])).toBe(true)
    expect(isAncestorPath([0, 1], [0, 1])).toBe(false)
    expect(isAncestorPath([1], [0, 1])).toBe(false)
    expect(parentPath([0, 2])).toEqual([0])
    expect(nextPath([0, 2])).toEqual([0, 3])
    expect(previousPath([0, 2])).toEqual([0, 1])
  })
  it('points and selections', () => {
    expect(comparePoint({ path: [0, 0], offset: 2 }, { path: [0, 1], offset: 0 })).toBe(-1)
    expect(comparePoint({ path: [0, 0], offset: 2 }, { path: [0, 0], offset: 1 })).toBe(1)
    expect(pointEquals({ path: [0, 0], offset: 2 }, { path: [0, 0], offset: 2 })).toBe(true)
    expect(isCollapsed(sel([0, 0], 1))).toBe(true)
    expect(isCollapsed(sel([0, 0], 1, [0, 0], 2))).toBe(false)
    expect(toRange(sel([0, 1], 0, [0, 0], 1))).toEqual({
      start: { path: [0, 0], offset: 1 },
      end: { path: [0, 1], offset: 0 },
    })
  })
})
