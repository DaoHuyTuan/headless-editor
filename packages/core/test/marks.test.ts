import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../src/plugin/define'
import type { Doc, ElementNode, Node, Selection } from '../src/model/types'
import { isMarkActive, marksAt } from '../src/internal'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const italic = definePlugin({ name: 'italic', mark: { render: () => ({ tag: 'em' }) } })
const fontSize = definePlugin({
  name: 'fontSize',
  mark: { render: () => ({ tag: 'span' }) },
  data: z.object({ size: z.string().regex(/^\d+px$/) }),
})

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

function setup(content: Doc, selection?: Selection) {
  return createTestEditor({ plugins: [testParagraph, testBold, italic, fontSize], doc: content, selection })
}

const bold = { type: 'bold', data: {} }
const ital = { type: 'italic', data: {} }

describe('toggleMark on a range', () => {
  it('a[bc]d → a, bc(bold), d; toggling again restores a single text', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 1, [0, 0], 3))
    expect(ed.commands.toggleMark('bold')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('bc', 'bold'), 'd'))))
    expect(ed.isActive('bold')).toBe(true)
    expect(ed.commands.toggleMark('bold')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('abcd'))))
    expect(ed.isActive('bold')).toBe(false)
  })

  it('makes a partially bold range fully bold', () => {
    // a[b(bold) c]d
    const ed = setup(doc(p('a', txt('b', 'bold'), 'cd')), sel([0, 1], 0, [0, 2], 1))
    ed.commands.toggleMark('bold')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('bc', 'bold'), 'd'))))
  })

  it('accepts a backward selection', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 3, [0, 0], 1))
    ed.commands.toggleMark('bold')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('bc', 'bold'), 'd'))))
  })

  it('spans several blocks', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel([0, 0], 1, [1, 0], 1))
    ed.commands.toggleMark('bold')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('b', 'bold')), p(txt('c', 'bold'), 'd'))))
  })
})

describe('stored marks', () => {
  it('collapsed toggle stores the mark, typing uses it, moving clears it', () => {
    const ed = setup(doc(p('abc')), sel([0, 0], 1))
    expect(ed.commands.toggleMark('bold')).toBe(true)
    expect(ed.state.storedMarks).toEqual([bold])
    expect(ed.isActive('bold')).toBe(true)
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('x', 'bold'), 'bc'))))
    expect(ed.state.storedMarks).toBeNull()
    ed.commands.toggleMark('bold')
    expect(ed.state.storedMarks).toEqual([])
    const tr = ed.createTransaction()
    tr.setSelection(sel([0, 0], 0))
    ed.dispatch(tr)
    expect(ed.state.storedMarks).toBeNull()
  })

  it('collapsed toggle off removes the inherited mark from stored marks', () => {
    const ed = setup(doc(p(txt('ab', 'bold'))), sel([0, 0], 2))
    ed.commands.toggleMark('bold')
    expect(ed.state.storedMarks).toEqual([])
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('ab', 'bold'), 'x'))))
  })

  it('typing at the end of bold text inherits bold', () => {
    const ed = setup(doc(p(txt('ab', 'bold'), 'cd')), sel([0, 1], 0))
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('abx', 'bold'), 'cd'))))
  })

  it('typing over a selected bold run after plain text keeps bold', () => {
    const ed = setup(doc(p('a', txt('bc', 'bold'))), sel([0, 1], 0, [0, 1], 2))
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('x', 'bold')))))
  })

  it('the equivalent selection starting at the end of the plain text keeps bold too', () => {
    const ed = setup(doc(p('a', txt('bc', 'bold'))), sel([0, 0], 1, [0, 1], 2))
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', txt('x', 'bold')))))
  })

  it('typing over a range starting in plain text gives plain text', () => {
    const ed = setup(doc(p('ab', txt('cd', 'bold'))), sel([0, 0], 1, [0, 1], 1))
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ax', txt('d', 'bold')))))
  })

  it('setMark / unsetMark on a caret change stored marks', () => {
    const ed = setup(doc(p(txt('ab', 'italic'))), sel([0, 0], 1))
    ed.commands.setMark('bold')
    expect(ed.state.storedMarks).toEqual([bold, ital])
    ed.commands.unsetMark('italic')
    expect(ed.state.storedMarks).toEqual([bold])
  })
})

describe('marksAt', () => {
  it('uses stored marks when set', () => {
    const ed = setup(doc(p(txt('ab', 'bold'))), sel([0, 0], 1))
    expect(marksAt({ ...ed.state, storedMarks: [ital] })).toEqual([ital])
  })

  it('at a boundary the caret belongs to the previous text', () => {
    const ed = setup(doc(p(txt('ab', 'bold'), 'cd')), sel([0, 1], 0))
    expect(marksAt(ed.state)).toEqual([bold])
  })

  it('at offset 0 of the first text uses that text', () => {
    const ed = setup(doc(p(txt('ab', 'bold'), 'cd')), sel([0, 0], 0))
    expect(marksAt(ed.state)).toEqual([bold])
  })
})

describe('setMark with data', () => {
  it('replaces a mark of the same type with different data', () => {
    const ed = setup(doc(p(txt('abc', { type: 'fontSize', data: { size: '12px' } }))), sel([0, 0], 0, [0, 0], 3))
    expect(ed.commands.setMark('fontSize', { size: '18px' })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(
      stripIds(doc(p(txt('abc', { type: 'fontSize', data: { size: '18px' } })))),
    )
    expect(ed.isActive('fontSize', { size: '18px' })).toBe(true)
    expect(ed.isActive('fontSize', { size: '12px' })).toBe(false)
  })

  it('replaces only inside the range', () => {
    const ed = setup(doc(p(txt('abc', { type: 'fontSize', data: { size: '12px' } }))), sel([0, 0], 1, [0, 0], 2))
    ed.commands.setMark('fontSize', { size: '18px' })
    const fs = (size: string) => ({ type: 'fontSize', data: { size } })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a', fs('12px')), txt('b', fs('18px')), txt('c', fs('12px'))))))
  })

  it('unsetMark removes the type over the range', () => {
    const ed = setup(doc(p(txt('abc', { type: 'fontSize', data: { size: '12px' } }))), sel([0, 0], 0, [0, 0], 3))
    ed.commands.unsetMark('fontSize')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('abc'))))
  })
})

describe('isActive for marks', () => {
  it('is true for a fully bold range and false for a partial one', () => {
    const ed = setup(doc(p(txt('ab', 'bold'), 'cd')), sel([0, 0], 0, [0, 0], 2))
    expect(ed.isActive('bold')).toBe(true)
    const tr = ed.createTransaction()
    tr.setSelection(sel([0, 0], 0, [0, 1], 1))
    ed.dispatch(tr)
    expect(ed.isActive('bold')).toBe(false)
  })

  it('ignores texts the range touches only at an edge', () => {
    // Range ends at offset 0 of the plain text: covers only bold chars.
    const ed = setup(doc(p(txt('ab', 'bold'), 'cd')), sel([0, 0], 1, [0, 1], 0))
    expect(ed.isActive('bold')).toBe(true)
    expect(isMarkActive(ed.state, 'bold')).toBe(true)
  })

  it('a range covering no characters behaves like a caret', () => {
    const ed = setup(doc(p(txt('ab', 'bold'), 'cd')), sel([0, 0], 2, [0, 1], 0))
    expect(ed.isActive('bold')).toBe(true)
  })
})

describe('mark order and validation', () => {
  it('orders marks by registry rank regardless of application order', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 0, [0, 0], 2))
    ed.commands.toggleMark('italic')
    ed.commands.toggleMark('bold')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('ab', 'bold', 'italic')))))
  })

  it('invalid mark data in dev → dispatch throws', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 0, [0, 0], 2))
    const tr = ed.createTransaction()
    tr.addMark({ type: 'fontSize', data: { size: 'huge' } })
    expect(tr.rejected).not.toBeNull()
    expect(tr.ops).toHaveLength(0)
    expect(() => ed.dispatch(tr)).toThrow()
    expect(ed.commands.setMark('fontSize', { size: 'huge' })).toBe(false)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'))))
  })

  it('unregistered mark types are rejected', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 0, [0, 0], 2))
    const t1 = ed.createTransaction()
    t1.addMark({ type: 'ghost', data: {} })
    expect(t1.rejected).toBe('Unknown mark type "ghost"')
    expect(t1.ops).toHaveLength(0)
    const t2 = ed.createTransaction()
    t2.toggleMark('ghost')
    expect(t2.rejected).toBe('Unknown mark type "ghost"')
    expect(t2.ops).toHaveLength(0)
    expect(ed.commands.setMark('ghost')).toBe(false)
    expect(ed.commands.toggleMark('ghost')).toBe(false)
  })

  it('invalid data on a collapsed toggle is rejected too', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    const tr = ed.createTransaction()
    tr.toggleMark('fontSize', { size: 'huge' })
    expect(tr.rejected).not.toBeNull()
    expect(tr.storedMarks).toBeNull()
  })
})
