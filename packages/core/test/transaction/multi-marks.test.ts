import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import { createSelection } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Path, Selection, SelectionRange } from '../../src/model/types'
import type { EditorState } from '../../src/state'
import { isMarkActive, marksAt } from '../../src/transaction/marks'
import { Transaction } from '../../src/transaction/transaction'
import { createTestEditor, doc, el, stripIds, txt } from '../../src/testing/index'
import { record, registry, scenarios } from './single-range-mark-scenarios'
import recorded from './single-range-mark-ops.json'

const at = (path: Path, offset: number) => ({ path, offset })
const caret = (path: Path, offset: number): SelectionRange => ({ anchor: at(path, offset), focus: at(path, offset) })
const span = (path: Path, from: number, to: number): SelectionRange => ({ anchor: at(path, from), focus: at(path, to) })
const rng = (ap: Path, ao: number, fp: Path, fo: number): SelectionRange => ({ anchor: at(ap, ao), focus: at(fp, fo) })
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const t = (text: string, ...marks: Mark[]): Node => ({ text, marks })
const bold: Mark = { type: 'bold', data: {} }
const ital: Mark = { type: 'italic', data: {} }
const size = (s: string): Mark => ({ type: 'fontSize', data: { size: s } })
const sel = (...ranges: SelectionRange[]): Selection => createSelection(ranges)

function trOf(d: Doc, ranges: SelectionRange[], storedMarks: Mark[] | null = null, dev = false): Transaction {
  const state: EditorState = { doc: d, selection: createSelection(ranges), storedMarks, pluginStates: new Map() }
  return new Transaction(state, registry, { dev })
}
const view = (tr: Transaction) => ({ doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks })
const editor = (d: Doc, ...ranges: SelectionRange[]) =>
  createTestEditor({ plugins: [...registry.plugins], doc: d, selection: createSelection(ranges) })

describe('marks on every range', () => {
  it('toggleMark adds everywhere when one range lacks it', () => {
    // a[b(bold)]cd[e]f
    const tr = trOf(doc(p('a', t('b', bold), 'cdef')), [span([0, 1], 0, 1), span([0, 2], 2, 3)])
    tr.toggleMark('bold')
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a', t('b', bold), 'cd', t('e', bold), 'f'))))
    // As with one range, a focus at a split lands at the start of the next text; the bold range is untouched.
    expect(tr.selection).toEqual(sel(span([0, 1], 0, 1), rng([0, 3], 0, [0, 4], 0)))
    expect(isMarkActive(view(tr), 'bold')).toBe(true)
  })

  it('toggleMark removes everywhere when all have it', () => {
    const tr = trOf(doc(p('a', t('bc', bold), 'd', t('ef', bold))), [span([0, 1], 0, 1), span([0, 3], 1, 2)])
    tr.toggleMark('bold')
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a', 'b', t('c', bold), 'd', t('e', bold), 'f'))))
    expect(isMarkActive(view(tr), 'bold')).toBe(false)
  })

  it('isActive is false when one range lacks the mark', () => {
    const ed = editor(doc(p('a', t('b', bold), 'cdef')), span([0, 1], 0, 1), span([0, 2], 2, 3))
    expect(ed.isActive('bold')).toBe(false)
    ed.commands.toggleMark('bold')
    expect(ed.isActive('bold')).toBe(true)
  })

  it('isActive at carets reads each caret', () => {
    const ed = editor(doc(p('a', t('b', bold), 'cdef')), caret([0, 1], 1), caret([0, 2], 2))
    expect(ed.isActive('bold')).toBe(false)
    const both = editor(doc(p(t('ab', bold), 'c', t('de', bold))), caret([0, 0], 1), caret([0, 2], 1))
    expect(both.isActive('bold')).toBe(true)
  })

  it('toggle at two carets, then type, makes both inserts bold', () => {
    const ed = editor(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
    expect(ed.commands.toggleMark('bold')).toBe(true)
    expect(ed.state.storedMarks).toEqual([bold])
    expect(ed.isActive('bold')).toBe(true)
    ed.commands.insertText('X')
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('a', t('X', bold), 'bc', t('X', bold), 'd'))))
  })

  it('toggle at two carets twice clears the stored mark', () => {
    const ed = editor(doc(p('abcd')), caret([0, 0], 1), caret([0, 0], 3))
    ed.commands.toggleMark('bold')
    ed.commands.toggleMark('bold')
    expect(ed.state.storedMarks).toEqual([])
    expect(ed.isActive('bold')).toBe(false)
  })

  it('stored marks at several carets start from the marks every caret shares', () => {
    // Caret 1 in bold+italic text, caret 2 in bold text: italic is not shared.
    const tr = trOf(doc(p(t('ab', bold, ital), 'c', t('de', bold))), [caret([0, 0], 1), caret([0, 2], 1)])
    expect(marksAt(view(tr))).toEqual([bold])
    tr.toggleMark('fontSize', { size: '12px' })
    expect(tr.storedMarks).toEqual([bold, size('12px')])
  })

  it('addMark/removeMark act on every non-empty range', () => {
    const tr = trOf(doc(p('abcdef'), p('ghij')), [span([0, 0], 1, 2), span([0, 0], 4, 5), span([1, 0], 1, 3)])
    tr.addMark(ital)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a', t('b', ital), 'cd', t('e', ital), 'f'), p('g', t('hi', ital), 'j'))))
    expect(tr.selection).toEqual(sel(rng([0, 1], 0, [0, 2], 0), rng([0, 3], 0, [0, 4], 0), rng([1, 1], 0, [1, 2], 0)))
    expect(tr.storedMarks).toBeNull()
    tr.removeMark('italic')
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a', 'b', 'cd', 'e', 'f'), p('g', 'hi', 'j'))))
  })

  it('addMark with data replaces the data at every range', () => {
    const tr = trOf(doc(p(t('ab', size('12px')), 'c', t('de', size('14px')))), [span([0, 0], 0, 2), span([0, 2], 0, 2)])
    expect(isMarkActive(view(tr), 'fontSize', { size: '12px' })).toBe(false)
    expect(isMarkActive(view(tr), 'fontSize')).toBe(true)
    tr.addMark(size('20px'))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p(t('ab', size('20px')), 'c', t('de', size('20px'))))))
    expect(isMarkActive(view(tr), 'fontSize', { size: '20px' })).toBe(true)
  })

  it('a range and a caret: the range gets the mark, the caret the stored mark; toggling back undoes both', () => {
    const ed = editor(doc(p('abcdef')), span([0, 0], 1, 3), caret([0, 0], 5))
    ed.commands.toggleMark('bold')
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('a', t('bc', bold), 'def'))))
    expect(ed.state.storedMarks).toEqual([bold])
    expect(ed.isActive('bold')).toBe(true)
    ed.commands.toggleMark('bold')
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('abcdef'))))
    expect(ed.state.storedMarks).toEqual([])
    expect(ed.isActive('bold')).toBe(false)
  })

  it('an explicit range acts only there and maps the other ranges', () => {
    const tr = trOf(doc(p('abcdef')), [span([0, 0], 0, 1), caret([0, 0], 5)], [ital])
    tr.addMark(bold, { start: at([0, 0], 2), end: at([0, 0], 3) })
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('ab', t('c', bold), 'def'))))
    expect(tr.selection).toEqual(sel(span([0, 0], 0, 1), caret([0, 2], 2)))
    expect(tr.storedMarks).toEqual([ital])
  })

  it('a no-range call inside forEachRange throws in dev', () => {
    const tr = trOf(doc(p('abcdef')), [span([0, 0], 0, 1), span([0, 0], 3, 4)], null, true)
    expect(() => tr.forEachRange(() => void tr.addMark(bold))).toThrow(/pass the callback range/)
    const ok = trOf(doc(p('abcdef')), [span([0, 0], 0, 1), span([0, 0], 3, 4)], null, true)
    ok.forEachRange((range, tr) => void tr.addMark(bold, { start: range.anchor, end: range.focus }))
    expect(stripIds(ok.doc)).toEqual(stripIds(doc(p(t('a', bold), 'bc', t('d', bold), 'ef'))))
    expect(ok.selection).toEqual(sel(rng([0, 0], 0, [0, 1], 0), rng([0, 2], 0, [0, 3], 0)))
  })

  it('one undo restores the doc and every range', () => {
    const ed = editor(doc(p('abcdef')), span([0, 0], 1, 2), span([0, 0], 4, 5))
    const before = ed.state.selection
    ed.commands.toggleMark('bold')
    ed.commands.undo()
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('abcdef'))))
    expect(ed.state.selection).toEqual(before)
  })

  it('isActive with data is false when the ranges have different data (font-size shows mixed)', () => {
    const ed = editor(doc(p(t('ab', size('12px')), 'c', t('de', size('14px')))), span([0, 0], 0, 2), span([0, 2], 0, 2))
    expect(ed.isActive('fontSize')).toBe(true)
    expect(ed.isActive('fontSize', { size: '12px' })).toBe(false)
    expect(ed.isActive('fontSize', { size: '14px' })).toBe(false)
  })

  it('isActive for an element is true only when every range starts in it', () => {
    const heading = definePlugin({ name: 'heading', data: z.object({ level: z.number() }), node: { kind: 'block', content: 'inline' } })
    const d = doc(el('heading', { level: 1 }, txt('ab')), p('cd'), el('heading', { level: 1 }, txt('ef')))
    const ed = createTestEditor({ plugins: [...registry.plugins, heading], doc: d, selection: createSelection([caret([0, 0], 1), caret([1, 0], 1)]) })
    expect(ed.isActive('heading')).toBe(false)
    const both = createTestEditor({ plugins: [...registry.plugins, heading], doc: d, selection: createSelection([caret([0, 0], 1), caret([2, 0], 1)]) })
    expect(both.isActive('heading')).toBe(true)
    expect(both.isActive('heading', { level: 1 })).toBe(true)
    expect(both.isActive('heading', { level: 2 })).toBe(false)
  })

  it('setMark/unsetMark commands act on every range', () => {
    const ed = editor(doc(p('abcdef')), span([0, 0], 1, 2), span([0, 0], 4, 5))
    expect(ed.commands.setMark('italic')).toBe(true)
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('a', t('b', ital), 'cd', t('e', ital), 'f'))))
    expect(ed.commands.unsetMark('italic')).toBe(true)
    expect(stripIds(ed.state.doc as Doc)).toEqual(stripIds(doc(p('abcdef'))))
  })
})

describe('single-range mark parity with the implementation before multi-range marks', () => {
  const old = recorded as unknown as Record<string, ReturnType<typeof record>>
  for (const s of scenarios) {
    it(s.name, () => {
      expect(record(s)).toEqual(old[s.name])
    })
  }
})
