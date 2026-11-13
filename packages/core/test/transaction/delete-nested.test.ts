import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import type { Doc, ElementNode, Mark, Node, Path, SelectionRange } from '../../src/model/types'
import { isValidDoc } from '../../src/schema/validate'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { nested } from '../fixtures'

const bold: Mark = { type: 'bold', data: {} }
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const quote = (...children: ElementNode[]): ElementNode => el('quote', ...children)
const ul = (...children: ElementNode[]): ElementNode => el('bulletList', ...children)
const li = (...children: ElementNode[]): ElementNode => el('listItem', ...children)
const table = (...rows: ElementNode[]): ElementNode => el('table', ...rows)
const row = (...cells: ElementNode[]): ElementNode => el('tableRow', ...cells)
const cell = (...children: ElementNode[]): ElementNode => el('tableCell', ...children)
const code = (text: string): ElementNode => el('code', txt(text))

const range = (a: Path, ao: number, f: Path, fo: number): SelectionRange => ({
  anchor: { path: a, offset: ao },
  focus: { path: f, offset: fo },
})

/**
 * Deletes `r` in `content` and checks the tr's own result is valid against the schema (before
 * normalization, which only merges the texts meeting at a join), the committed doc is `expected`,
 * the caret lands at `caretAt`, and undo restores the doc (ids included) and the selection.
 */
function expectDeleted(content: Doc, r: SelectionRange, expected: Doc, caretAt: [Path, number]) {
  const ed = createTestEditor({ plugins: nested, doc: content, selection: { ranges: [r], main: 0 } })
  const before = ed.state
  const tr = ed.createTransaction()
  tr.deleteRange()
  expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
  ed.dispatch(tr)
  expect(stripIds(ed.getJSON())).toEqual(stripIds(expected))
  expect(ed.state.selection).toEqual(sel(caretAt[0], caretAt[1]))
  expect(ed.commands.undo()).toBe(true)
  expect(ed.getJSON()).toEqual(before.doc)
  expect(ed.state.selection).toEqual(before.selection)
  return ed
}

describe('deleteRange across nested blocks (spec §5.3)', () => {
  it('joins a top-level paragraph into a paragraph inside a quote', () => {
    expectDeleted(doc(quote(p('ab')), p('cd')), range([0, 0, 0], 1, [1, 0], 1), doc(quote(p('ad'))), [[0, 0, 0], 1])
  })

  it('joins the end of a list into a paragraph before it; the emptied list goes', () => {
    expectDeleted(
      doc(p('ab'), ul(li(p('cd')), li(p('ef')))),
      range([0, 0], 1, [1, 1, 0, 0], 1),
      doc(p('af')),
      [[0, 0], 1],
    )
  })

  it('keeps the start block id and the blocks after the end', () => {
    const ed = createTestEditor({
      plugins: nested,
      doc: doc(p('ab'), ul(li(p('cd')), li(p('ef'), p('g'))), p('z')),
      selection: { ranges: [range([0, 0], 1, [1, 1, 0, 0], 1)], main: 0 },
    })
    const id = (ed.getJSON().children[0] as ElementNode).id
    const tr = ed.createTransaction()
    tr.deleteRange()
    expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('af'), ul(li(p('g'))), p('z'))))
    expect((ed.getJSON().children[0] as ElementNode).id).toBe(id)
  })

  it('removes a list item covered whole in the middle of a list and keeps the list', () => {
    expectDeleted(
      doc(ul(li(p('ab')), li(p('cd')), li(p('ef')))),
      range([0, 0, 0, 0], 1, [0, 2, 0, 0], 1),
      doc(ul(li(p('af')))),
      [[0, 0, 0, 0], 1],
    )
    expectDeleted(
      doc(ul(li(p('ab')), li(p('cd')), li(p('ef'), p('g')), li(p('h')))),
      range([0, 0, 0, 0], 1, [0, 2, 0, 0], 1),
      doc(ul(li(p('af')), li(p('g')), li(p('h')))),
      [[0, 0, 0, 0], 1],
    )
  })

  it('deletes across a quote and a list, and undo restores the doc with its ids and the selection', () => {
    expectDeleted(
      doc(quote(p('ab'), p('cd')), ul(li(p('ef')), li(p('gh')))),
      range([0, 0, 0], 1, [1, 1, 0, 0], 1),
      doc(quote(p('ah'))),
      [[0, 0, 0], 1],
    )
  })

  it('refills what the content rule needs in front of the rest of the end container', () => {
    // The list item would start with the quote: it gets an empty paragraph first.
    expectDeleted(
      doc(p('ab'), ul(li(p('cd'), quote(p('ef'), p('g')), p('h')))),
      range([0, 0], 1, [1, 0, 1, 0, 0], 1),
      doc(p('af'), ul(li(p(''), quote(p('g')), p('h')))),
      [[0, 0], 1],
    )
  })

  it('does not join a textblock whose content the start textblock does not allow', () => {
    // A code block allows no marks: the bold text stays in its own paragraph.
    expectDeleted(
      doc(code('ab'), quote(p(txt('cd', bold)))),
      range([0, 0], 1, [1, 0, 0], 1),
      doc(code('a'), quote(p(txt('d', bold)))),
      [[0, 0], 1],
    )
  })
})

describe('deleteRange across isolating nodes (spec §5.3)', () => {
  it('a range across two cells of one row empties the covered text in each and keeps both cells', () => {
    expectDeleted(
      doc(table(row(cell(p('ab')), cell(p('cd'))))),
      range([0, 0, 0, 0, 0], 1, [0, 0, 1, 0, 0], 1),
      doc(table(row(cell(p('a')), cell(p('d'))))),
      [[0, 0, 0, 0, 0], 1],
    )
  })

  it('a cell covered whole between them is emptied, not removed', () => {
    expectDeleted(
      doc(table(row(cell(p('ab')), cell(p('x'), p('y')), cell(p('cd'))))),
      range([0, 0, 0, 0, 0], 1, [0, 0, 2, 0, 0], 1),
      doc(table(row(cell(p('a')), cell(p('')), cell(p('d'))))),
      [[0, 0, 0, 0, 0], 1],
    )
  })

  it('a range across rows keeps every row and cell', () => {
    expectDeleted(
      doc(table(row(cell(p('ab')), cell(p('cd'))), row(cell(p('ef')), cell(p('gh'))))),
      range([0, 0, 0, 0, 0], 1, [0, 1, 1, 0, 0], 1),
      doc(table(row(cell(p('a')), cell(p(''))), row(cell(p('')), cell(p('h'))))),
      [[0, 0, 0, 0, 0], 1],
    )
  })

  it('a range from before a table into a cell keeps the table; the blocks covered whole go', () => {
    expectDeleted(
      doc(p('ab'), p('zz'), table(row(cell(p('cd')), cell(p('x'), p('ef'))))),
      range([0, 0], 1, [2, 0, 1, 1, 0], 1),
      doc(p('a'), table(row(cell(p('')), cell(p('f'))))),
      [[0, 0], 1],
    )
  })

  it('a table covered whole is removed', () => {
    expectDeleted(
      doc(p('ab'), table(row(cell(p('cd')))), p('ef')),
      range([0, 0], 1, [2, 0], 1),
      doc(p('af')),
      [[0, 0], 1],
    )
  })
})

describe('deleteRange in containers: emptied containers and several ranges', () => {
  it('two opaque siblings removed from a quote take the emptied quote with them', () => {
    const ed = createTestEditor({ plugins: nested, doc: doc(p('x'), quote(el('weird', txt('aa')), el('weird', txt('bb'))), p('y')) })
    const tr = ed.createTransaction()
    // Unknown blocks (opaque): a raw range from inside one to inside the other.
    tr.deleteRange(range([1, 0, 0], 1, [1, 1, 0], 1))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('x'), p('y'))))
    expect(tr.selection).toEqual(sel([1, 0], 0))
  })

  it('each selection range deletes across depths as it would alone', () => {
    const ed = createTestEditor({
      plugins: nested,
      doc: doc(quote(p('ab')), p('cd'), quote(p('ef')), p('gh')),
      selection: { ranges: [range([0, 0, 0], 1, [1, 0], 1), range([2, 0, 0], 1, [3, 0], 1)], main: 0 },
    })
    const tr = ed.createTransaction()
    tr.deleteRange()
    expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(quote(p('ad')), quote(p('eh')))))
    expect(ed.state.selection?.ranges).toEqual([sel([0, 0, 0], 1).ranges[0], sel([1, 0, 0], 1).ranges[0]])
  })
})

describe('deleteRange fallback when no replace is valid', () => {
  // `frame` needs its `box` and `box` needs a second block, which nothing can create (`key` has no default).
  const frame = definePlugin({ name: 'frame', node: { kind: 'block', content: 'paragraph box' } })
  const box = definePlugin({ name: 'box', node: { kind: 'block', content: 'paragraph secret', group: [] } })
  const secret = definePlugin({
    name: 'secret',
    node: { kind: 'block', content: 'inline', group: [] },
    data: z.object({ key: z.string() }),
  })

  it('keeps an opaque edge whose removal would leave its container invalid; only the text goes', () => {
    const ed = createTestEditor({
      plugins: [...nested, frame, box, secret],
      doc: doc(el('frame', p('ab'), el('box', p('cd'), el('weird', txt('zz'))))),
    })
    const tr = ed.createTransaction()
    // From inside "ab" to inside the unknown block, which stands for the box's `secret`.
    tr.deleteRange(range([0, 0, 0], 1, [0, 1, 1, 0], 1))
    expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('frame', p('a'), el('box', p(''), el('weird', txt('zz')))))))
    expect(tr.selection).toEqual(sel([0, 0, 0], 1))
  })
})

describe('deleteRange between sibling blocks inside a strict container (final review, finding 6)', () => {
  const card = definePlugin({ name: 'card', node: { kind: 'block', content: 'heading paragraph' } })
  const heading = definePlugin({ name: 'heading', node: { kind: 'block', content: 'inline', group: [] } })
  const h = (text: string): ElementNode => el('heading', txt(text))

  it('does not merge the paragraph into the heading the card needs before it: only the text goes', () => {
    const ed = createTestEditor({ plugins: [...nested, card, heading], doc: doc(el('card', h('ab'), p('cd'))) })
    const tr = ed.createTransaction()
    tr.deleteRange(range([0, 0, 0], 1, [0, 1, 0], 1))
    expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('card', h('a'), p('d')))))
    expect(tr.selection).toEqual(sel([0, 0, 0], 1))
  })

  it('still merges sibling paragraphs in a quote (control)', () => {
    expectDeleted(doc(quote(p('ab'), p('cd'))), range([0, 0, 0], 1, [0, 1, 0], 1), doc(quote(p('ad'))), [[0, 0, 0], 1])
  })
})
