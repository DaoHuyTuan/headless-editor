import { describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import { findTrigger } from '../src/index'
import type { Doc, ElementNode, Node, Selection } from '../src/model/types'
import { createTestEditor, doc, el, sel, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
const code = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })
const c = (): ElementNode => ({ id: 'c', type: 'chip', data: {}, children: [] })

function state(content: Doc, selection: Selection) {
  return createTestEditor({ plugins: [testParagraph, testBold, chip, code], doc: content, selection }).state
}

describe('findTrigger', () => {
  it("'hi @jo|' gives the query jo and the range from the trigger to the caret", () => {
    expect(findTrigger(state(doc(p('hi @jo')), sel([0, 0], 6)), { char: '@' })).toEqual({
      range: { start: { path: [0, 0], offset: 3 }, end: { path: [0, 0], offset: 6 } },
      query: 'jo',
    })
  })

  it('finds a trigger at the start of the line, with an empty query', () => {
    expect(findTrigger(state(doc(p('@')), sel([0, 0], 1)), { char: '@' })?.query).toBe('')
    expect(findTrigger(state(doc(p('@jo')), sel([0, 0], 3)), { char: '@' })?.query).toBe('jo')
  })

  it("'mail@x|' gives null (no space before the trigger)", () => {
    expect(findTrigger(state(doc(p('mail@x')), sel([0, 0], 6)), { char: '@' })).toBeNull()
  })

  it("'@jo hn|' gives null; with allowSpaces it gives 'jo hn'", () => {
    const s = state(doc(p('@jo hn')), sel([0, 0], 6))
    expect(findTrigger(s, { char: '@' })).toBeNull()
    expect(findTrigger(s, { char: '@', allowSpaces: true })?.query).toBe('jo hn')
  })

  it('a caret not collapsed gives null', () => {
    expect(findTrigger(state(doc(p('hi @jo')), sel([0, 0], 4, [0, 0], 6)), { char: '@' })).toBeNull()
  })

  it('a trigger inside a code block is still found', () => {
    const s = state(doc(el('code', txt('x\n@ab'))), sel([0, 0], 5))
    expect(findTrigger(s, { char: '@' })?.query).toBe('ab')
  })

  it('spans texts with different marks', () => {
    const s = state(doc(p('hi @', txt('jo', 'bold'))), sel([0, 1], 2))
    expect(findTrigger(s, { char: '@' })).toEqual({
      range: { start: { path: [0, 0], offset: 3 }, end: { path: [0, 1], offset: 2 } },
      query: 'jo',
    })
  })

  it('stops at an inline atom: a trigger before it is not found, and right after it is not a line start', () => {
    expect(findTrigger(state(doc(p('@a', c(), 'b')), sel([0, 2], 1)), { char: '@' })).toBeNull()
    expect(findTrigger(state(doc(p('x', c(), '@b')), sel([0, 2], 2)), { char: '@' })).toBeNull()
    expect(findTrigger(state(doc(p('x', c(), ' @b')), sel([0, 2], 3)), { char: '@' })?.query).toBe('b')
  })

  it('null without a selection or with the caret before the trigger', () => {
    expect(findTrigger(state(doc(p('hi @jo')), sel([0, 0], 2)), { char: '@' })).toBeNull()
  })
})
