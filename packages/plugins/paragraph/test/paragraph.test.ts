// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTestEditor, doc, el, sel, stripIds, txt } from '@hte/core/testing'
import { paragraph } from '../src/index'

describe('paragraph plugin', () => {
  it('round-trips HTML paragraphs', () => {
    const ed = createTestEditor({ plugins: [paragraph], content: '<p>a</p><p>b</p>' })
    expect(ed.getHTML()).toBe('<p>a</p><p>b</p>')
  })

  it('insertParagraph at a mid-text caret creates two paragraphs', () => {
    const ed = createTestEditor({
      plugins: [paragraph],
      doc: doc(el('paragraph', txt('abcd'))),
      selection: sel([0, 0], 2),
    })
    expect(ed.handleIntent({ inputType: 'insertParagraph', data: null, range: null })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(
      stripIds(doc(el('paragraph', txt('ab')), el('paragraph', txt('cd')))),
    )
  })
})
