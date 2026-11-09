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

  it('normalizes an extra style when base has none, and omits a style with no declarations left', () => {
    expect(mergeAttrs({}, { style: 'COLOR:red' })).toEqual({ style: 'color: red;' })
    expect(mergeAttrs({ id: 'a' }, { style: 'top:0;;' })).toEqual({ id: 'a', style: 'top: 0;' })
    expect(mergeAttrs({}, { style: '/* nothing */' })).toEqual({})
    expect(mergeAttrs({ style: 'nonsense' }, { style: ';' })).toEqual({})
  })

  it.each([
    // Comments are dropped, including a `;` inside one.
    [{ style: 'color: red /* ; top: 0 */; margin: 0' }, { style: 'x: 1' }, 'color: red; margin: 0; x: 1;'],
    [{ style: '/* lead */ color: red' }, { style: 'x: 1' }, 'color: red; x: 1;'],
    // An unterminated comment runs to the end.
    [{ style: 'color: red; /* oops top: 0' }, { style: 'x: 1' }, 'color: red; x: 1;'],
    // A quote inside a string, and a `/*` inside a string, are text.
    [{ style: `content: "a'b /* c"` }, { style: 'x: 1' }, `content: "a'b /* c"; x: 1;`],
    // An unterminated string runs to the end in CSS: that declaration (and the rest) is dropped, so it
    // cannot swallow the declarations merged after it.
    [{ style: "color: red; font-family: 'a; top: 1px" }, { style: 'margin: 0' }, 'color: red; margin: 0;'],
    [{ style: 'top: 1px' }, { style: 'font-family: "x; color: blue' }, 'top: 1px;'],
    // Likewise an unclosed parenthesis.
    [{ style: 'background: url(a' }, { style: 'x: 1' }, 'x: 1;'],
  ])('style %j + %j = %j (comments, unbalanced quotes)', (base, extra, style) => {
    expect(mergeAttrs(base, extra)).toEqual({ style })
  })

  it('lowercases attribute names before merging', () => {
    expect(mergeAttrs({ Class: 'a', SRC: 'x' }, { class: 'b', src: 'y' })).toEqual({ class: 'a b', src: 'y' })
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
