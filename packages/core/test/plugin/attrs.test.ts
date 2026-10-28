import { describe, expect, it } from 'vitest'
import { mergeAttrs } from '../../src/plugin/attrs'

describe('mergeAttrs', () => {
  it.each([
    [{ class: 'a' }, { class: 'b' }, { class: 'a b' }],
    [{ class: 'a b' }, { class: 'b  c' }, { class: 'a b c' }],
    [{}, { class: 'x' }, { class: 'x' }],
    [{ style: 'color: red;' }, { style: 'color: blue; margin: 0' }, { style: 'color: blue; margin: 0;' }],
    [{ style: 'Color:red; top:1px' }, { style: 'COLOR: blue' }, { style: 'color: blue; top: 1px;' }],
    [{ style: 'background: url(a;b.png)' }, { style: 'x: 1' }, { style: 'background: url(a;b.png); x: 1;' }],
    [{ id: 'a', title: 't' }, { id: 'b' }, { id: 'b', title: 't' }],
    [{ id: 'a', title: 't' }, { id: undefined }, { title: 't' }],
    [{ width: 1 }, { width: 2 }, { width: 2 }],
  ])('%j + %j = %j', (base, extra, expected) => {
    expect(mergeAttrs(base, extra)).toEqual(expected)
  })

  it('returns a copy of base without extra and does not mutate inputs', () => {
    const base = { class: 'a' }
    const extra = { class: 'b' }
    expect(mergeAttrs(base)).toEqual({ class: 'a' })
    expect(mergeAttrs(base)).not.toBe(base)
    mergeAttrs(base, extra)
    expect(base).toEqual({ class: 'a' })
    expect(extra).toEqual({ class: 'b' })
  })

  it('throws on invalid attribute names', () => {
    expect(() => mergeAttrs({}, { 'on click': 'x' })).toThrow('Invalid HTML attribute name "on click"')
    expect(() => mergeAttrs({ '"><x': 'x' })).toThrow('Invalid HTML attribute name')
  })
})
