import { describe, expect, it } from 'vitest'
import type { ElementNode, Node } from '../src/model/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testParagraph } from './fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

describe('forward line deletion intents (5.5b)', () => {
  for (const inputType of ['deleteSoftLineForward', 'deleteHardLineForward']) {
    it(`${inputType} deletes to the end of the line`, () => {
      const ed = createTestEditor({ plugins: [testParagraph], doc: doc(p('abcd')), selection: sel([0, 0], 1) })
      expect(ed.handleIntent({ inputType, data: null, range: null })).toBe(true)
      expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a'))))
      expect(ed.state.selection).toEqual(sel([0, 0], 1))
    })
  }
})
