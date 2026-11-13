import { describe, expect, it } from 'vitest'
import { createTestEditor, doc, el, sel, txt } from '../src/testing/index'
import { nested, testBold, testParagraph } from './fixtures'

const p = (s: string) => el('paragraph', txt(s))

describe('isActive inside containers', () => {
  const list = () =>
    createTestEditor({
      plugins: nested,
      doc: doc(el('bulletList', el('listItem', p('a'))), el('quote', p('b'))),
      selection: sel([0, 0, 0, 0], 1),
    })

  it('is true for every ancestor of the caret and the textblock', () => {
    const ed = list()
    expect(ed.isActive('bulletList')).toBe(true)
    expect(ed.isActive('listItem')).toBe(true)
    expect(ed.isActive('paragraph')).toBe(true)
    expect(ed.isActive('quote')).toBe(false)
    expect(ed.isActive('table')).toBe(false)
  })

  it('follows the caret into another container', () => {
    const ed = list()
    ed.dispatch(ed.createTransaction().setSelection(sel([1, 0, 0], 0)))
    expect(ed.isActive('quote')).toBe(true)
    expect(ed.isActive('bulletList')).toBe(false)
  })

  it('matches data against the ancestor', () => {
    const ed = createTestEditor({
      plugins: nested,
      doc: doc(el('quote', { tone: 'a' }, p('x'))),
      selection: sel([0, 0, 0], 0),
    })
    expect(ed.isActive('quote', { tone: 'a' })).toBe(true)
    expect(ed.isActive('quote', { tone: 'b' })).toBe(false)
  })

  it('needs every range to be inside the type', () => {
    const ed = list()
    const tr = ed.createTransaction()
    tr.setSelection({
      ranges: [
        { anchor: { path: [0, 0, 0, 0], offset: 0 }, focus: { path: [0, 0, 0, 0], offset: 1 } },
        { anchor: { path: [1, 0, 0], offset: 0 }, focus: { path: [1, 0, 0], offset: 1 } },
      ],
      main: 0,
    })
    ed.dispatch(tr)
    expect(ed.isActive('paragraph')).toBe(true)
    expect(ed.isActive('bulletList')).toBe(false)
    expect(ed.isActive('quote')).toBe(false)
  })

  it('keeps flat behaviour and marks', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, testBold],
      doc: doc(p('a')),
      selection: sel([0, 0], 0),
    })
    expect(ed.isActive('paragraph')).toBe(true)
    expect(ed.isActive('bold')).toBe(false)
  })
})
