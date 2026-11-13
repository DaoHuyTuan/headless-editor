import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/model/selection'
import type { Doc, ElementNode, Mark, Node, Path, Selection } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import { isValidDoc } from '../../src/schema/validate'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { deleteBackward, deleteForward, insertBlockNode, replaceSelectedNode, splitBlock } from '../../src/transaction/text'
import type { Transaction } from '../../src/transaction/transaction'
import { nested } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const quote = (...children: ElementNode[]): ElementNode => el('quote', ...children)
const ul = (...children: ElementNode[]): ElementNode => el('bulletList', ...children)
const li = (...children: ElementNode[]): ElementNode => el('listItem', ...children)
const table = (...rows: ElementNode[]): ElementNode => el('table', ...rows)
const row = (...cells: ElementNode[]): ElementNode => el('tableRow', ...cells)
const cell = (...children: ElementNode[]): ElementNode => el('tableCell', ...children)

// A container whose content forbids the default block after its first paragraph.
const caption = definePlugin({ name: 'caption', node: { kind: 'block', content: 'inline', group: [] } })
const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true, group: [] } })
const hr = definePlugin({ name: 'hr', node: { kind: 'block', atom: true } })
const figure = definePlugin({ name: 'figure', node: { kind: 'block', content: 'paragraph (caption | image)*' } })
const plugins = [...nested, caption, image, figure, hr]
const cap = (text: string): ElementNode => el('caption', txt(text))
const fig = (...children: ElementNode[]): ElementNode => el('figure', ...children)
const img = (): ElementNode => ({ id: 'img', type: 'image', data: {} })
const rule = (): ElementNode => ({ id: 'hr', type: 'hr', data: {} })
const bold: Mark = { type: 'bold', data: {} }

const at = (path: Path, offset: number) => ({ anchor: { path, offset }, focus: { path, offset } })

function setup(content: Doc, selection: Selection) {
  return createTestEditor({ plugins, doc: content, selection })
}

/**
 * Runs `edit` and checks it did something, the tr's own doc is valid (before normalization), the
 * committed doc is `expected`, the selection is `after`, and undo restores the doc and selection.
 */
function expectEdit(content: Doc, selection: Selection, edit: (tr: Transaction) => boolean, expected: Doc, after: Selection) {
  const ed = setup(content, selection)
  const before = ed.state
  const tr = ed.createTransaction()
  expect(edit(tr)).toBe(true)
  expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
  ed.dispatch(tr)
  expect(stripIds(ed.getJSON())).toEqual(stripIds(expected))
  expect(ed.state.selection).toEqual(after)
  if (tr.ops.some((op) => op.type !== 'set_selection')) {
    expect(ed.commands.undo()).toBe(true)
    expect(ed.getJSON()).toEqual(before.doc)
    expect(ed.state.selection).toEqual(before.selection)
  }
  return { ed, tr }
}

/** Runs `edit` and checks it did nothing: false, no ops. */
function expectNothing(content: Doc, selection: Selection, edit: (tr: Transaction) => boolean) {
  const ed = setup(content, selection)
  const tr = ed.createTransaction()
  expect(edit(tr)).toBe(false)
  expect(tr.ops).toEqual([])
}

const backspace = (tr: Transaction) => deleteBackward(tr)
const del = (tr: Transaction) => deleteForward(tr)
const enter = (tr: Transaction) => splitBlock(tr)

describe('Backspace at a textblock start (spec §5.3)', () => {
  it('rule 1: lifts the first paragraph of a quote out of it', () => {
    expectEdit(doc(quote(p('a'), p('b'))), sel([0, 0, 0], 0), backspace, doc(p('a'), quote(p('b'))), sel([0, 0], 0))
    expectEdit(doc(quote(p('a'))), sel([0, 0, 0], 0), backspace, doc(p('a')), sel([0, 0], 0))
  })

  it('rule 2: joins into the last textblock of the previous container', () => {
    expectEdit(doc(quote(p('ab')), p('c')), sel([1, 0], 0), backspace, doc(quote(p('abc'))), sel([0, 0, 0], 2))
    expectEdit(
      doc(quote(p('x'), quote(p('ab'))), p('c')),
      sel([1, 0], 0),
      backspace,
      doc(quote(p('x'), quote(p('abc')))),
      sel([0, 1, 0, 0], 2),
    )
  })

  it('rule 1 falls through for the first paragraph of a list item: no ops without a previous block', () => {
    expectNothing(doc(ul(li(p('a')))), sel([0, 0, 0, 0], 0), backspace)
  })

  it('rule 1 falls through for the first paragraph of a list item: joins into the block before the list', () => {
    expectEdit(doc(p('x'), ul(li(p('a')))), sel([1, 0, 0, 0], 0), backspace, doc(p('xa')), sel([0, 0], 1))
  })

  it('rule 4: after a table, an empty paragraph is removed and the caret goes to the end of the last cell', () => {
    expectEdit(
      doc(table(row(cell(p('a')), cell(p('b'), p('c')))), p('')),
      sel([1, 0], 0),
      backspace,
      doc(table(row(cell(p('a')), cell(p('b'), p('c'))))),
      sel([0, 0, 1, 1, 0], 1),
    )
  })

  it('rule 4: after a table, a non-empty paragraph only moves the caret to the end of the last cell', () => {
    const { tr } = expectEdit(
      doc(table(row(cell(p('a')), cell(p('b')))), p('x')),
      sel([1, 0], 0),
      backspace,
      doc(table(row(cell(p('a')), cell(p('b')))), p('x')),
      sel([0, 0, 1, 0, 0], 1),
    )
    expect(tr.ops.filter((op) => op.type !== 'set_selection')).toEqual([])
  })

  it('rule 5: at the start of the first paragraph in a cell, nothing', () => {
    const t = doc(table(row(cell(p('a')), cell(p('b')))))
    expectNothing(t, sel([0, 0, 0, 0, 0], 0), backspace)
    expectNothing(t, sel([0, 0, 1, 0, 0], 0), backspace)
  })

  it('rule 2: a join across parents that the textblock before does not allow does nothing', () => {
    // A code block allows no marks: the bold paragraph is not joined into it (no ops, no caret move).
    expectNothing(doc(quote(el('code', txt('ab'))), p(txt('c', bold))), sel([1, 0], 0), backspace)
  })

  it('multi-range: two carets at the starts of two quote-first paragraphs are both lifted in one pass', () => {
    const { tr } = expectEdit(
      doc(quote(p('a')), quote(p('b'))),
      createSelection([at([0, 0, 0], 0), at([1, 0, 0], 0)]),
      backspace,
      doc(p('a'), p('b')),
      createSelection([at([0, 0], 0), at([1, 0], 0)]),
    )
    // One final selection at most (forEachRange): the carets are mapped through the moves, so none is needed.
    expect(tr.ops.filter((op) => op.type === 'set_selection')).toHaveLength(0)
  })
})

describe('Delete at a textblock end (spec §5.3)', () => {
  it('joins the first textblock of the next container in; the emptied quote goes', () => {
    expectEdit(doc(p('ab'), quote(p('cd'))), sel([0, 0], 2), del, doc(p('abcd')), sel([0, 0], 2))
    expectEdit(doc(p('ab'), quote(p('cd'), p('e'))), sel([0, 0], 2), del, doc(p('abcd'), quote(p('e'))), sel([0, 0], 2))
  })

  it('joins the next block into the last paragraph of a container', () => {
    expectEdit(doc(quote(p('ab')), p('c')), sel([0, 0, 0], 2), del, doc(quote(p('abc'))), sel([0, 0, 0], 2))
  })

  it('before a table, an empty paragraph is removed and the caret goes to the start of the first cell', () => {
    expectEdit(
      doc(p(''), table(row(cell(p('a')), cell(p('b'))))),
      sel([0, 0], 0),
      del,
      doc(table(row(cell(p('a')), cell(p('b'))))),
      sel([0, 0, 0, 0, 0], 0),
    )
  })

  it('before a table, a non-empty paragraph only moves the caret to the start of the first cell', () => {
    expectEdit(
      doc(p('x'), table(row(cell(p('a')), cell(p('b'))))),
      sel([0, 0], 1),
      del,
      doc(p('x'), table(row(cell(p('a')), cell(p('b'))))),
      sel([1, 0, 0, 0, 0], 0),
    )
  })

  it('at the end of the last paragraph in a cell, nothing', () => {
    const t = doc(table(row(cell(p('a')), cell(p('b')))), p('z'))
    expectNothing(t, sel([0, 0, 0, 0, 0], 1), del)
    expectNothing(t, sel([0, 0, 1, 0, 0], 1), del)
  })
})

describe('Enter (spec §5.3)', () => {
  it('lifts an empty paragraph out of a quote', () => {
    expectEdit(doc(quote(p('a'), p(''))), sel([0, 1, 0], 0), enter, doc(quote(p('a')), p('')), sel([1, 0], 0))
  })

  it('splits an empty paragraph in a list item (lift is not valid there)', () => {
    expectEdit(doc(ul(li(p('')))), sel([0, 0, 0, 0], 0), enter, doc(ul(li(p(''), p('')))), sel([0, 0, 1, 0], 0))
  })

  it('splits an empty paragraph in a cell (isolating: no lift)', () => {
    expectEdit(
      doc(table(row(cell(p(''))))),
      sel([0, 0, 0, 0, 0], 0),
      enter,
      doc(table(row(cell(p(''), p(''))))),
      sel([0, 0, 0, 1, 0], 0),
    )
  })

  it("the new block takes the position's default type when the parent forbids the default block there", () => {
    expectEdit(doc(fig(p('a'))), sel([0, 0, 0], 1), enter, doc(fig(p('a'), cap(''))), sel([0, 1, 0], 0))
    expectEdit(doc(fig(p('ab'))), sel([0, 0, 0], 1), enter, doc(fig(p('a'), cap('b'))), sel([0, 1, 0], 0))
    expectEdit(doc(fig(p('a'), cap('b'))), sel([0, 1, 0], 1), enter, doc(fig(p('a'), cap('b'), cap(''))), sel([0, 2, 0], 0))
  })
})

describe('placing new blocks (spec §5.3)', () => {
  it('insertBlockNode(table) in a paragraph inside a cell goes after that paragraph in the cell', () => {
    expectEdit(
      doc(table(row(cell(p('a'))))),
      sel([0, 0, 0, 0, 0], 1),
      (tr) => insertBlockNode(tr, table(row(cell(p(''))))),
      doc(table(row(cell(p('a'), table(row(cell(p('')))), p(''))))),
      sel([0, 0, 0, 2, 0], 0),
    )
  })

  it('insertBlockNode(listItem) in a root paragraph is wrapped in a bulletList', () => {
    expectEdit(
      doc(p('a'), p('z')),
      sel([0, 0], 1),
      (tr) => insertBlockNode(tr, li(p('x'))),
      doc(p('a'), ul(li(p('x'))), p('z')),
      sel([2, 0], 0),
    )
    expectEdit(doc(p('')), sel([0, 0], 0), (tr) => insertBlockNode(tr, li(p('x'))), doc(ul(li(p('x'))), p('')), sel([1, 0], 0))
  })

  it('insertBlockNode(listItem) in a list item goes into the list, splitting the item at the caret', () => {
    expectEdit(
      doc(ul(li(p('ab')))),
      sel([0, 0, 0, 0], 1),
      (tr) => insertBlockNode(tr, li(p('x'))),
      doc(ul(li(p('a')), li(p('x')), li(p('b')))),
      sel([0, 2, 0, 0], 0),
    )
  })

  it('insertBlockNode fails with no ops when the node fits nowhere', () => {
    expectNothing(doc(fig(p('a'))), sel([0, 0, 0], 1), (tr) => insertBlockNode(tr, el('tableRow', cell(p('')))))
  })

  it('insertBlockNode over a non-empty range that fits nowhere deletes nothing either', () => {
    expectNothing(doc(fig(p('abc'))), sel([0, 0, 0], 1, [0, 0, 0], 2), (tr) => insertBlockNode(tr, el('tableRow', cell(p('')))))
  })

  it('insertBlockNode over a non-empty range deletes it, then places the node', () => {
    expectEdit(doc(p('abc')), sel([0, 0], 1, [0, 0], 2), (tr) => insertBlockNode(tr, rule()), doc(p('a'), rule(), p('c')), sel([2, 0], 0))
  })

  it('insertBlockNode in an empty paragraph its list item must keep goes after it, inside the item', () => {
    expectEdit(
      doc(ul(li(p('a')), li(p('')), li(p('c')))),
      sel([0, 1, 0, 0], 0),
      (tr) => insertBlockNode(tr, rule()),
      doc(ul(li(p('a')), li(p(''), rule()), li(p('c')))),
      sel([0, 2, 0, 0], 0),
    )
    // Nothing follows: the caret goes into a new default block after the node, in the item.
    expectEdit(
      doc(ul(li(p('')))),
      sel([0, 0, 0, 0], 0),
      (tr) => insertBlockNode(tr, rule()),
      doc(ul(li(p(''), rule(), p('')))),
      sel([0, 0, 2, 0], 0),
    )
  })

  it('replacing a selected node with a node its parent rejects goes to the nearest accepting ancestor', () => {
    const x = () => li(p('x'))
    expectEdit(
      doc(ul(li(p('a'), rule()), li(p('z')))),
      createSelection([{ ...at([0, 0, 0, 0], 1), node: [0, 0, 1] }]),
      (tr) => replaceSelectedNode(tr, { node: x() }),
      doc(ul(li(p('a')), li(p('x')), li(p('z')))),
      sel([0, 2, 0, 0], 0),
    )
    // In the middle of its item: the item is split where the node was.
    expectEdit(
      doc(ul(li(p('a'), rule(), p('b')))),
      createSelection([{ ...at([0, 0, 0, 0], 1), node: [0, 0, 1] }]),
      (tr) => replaceSelectedNode(tr, { node: x() }),
      doc(ul(li(p('a')), li(p('x')), li(p('b')))),
      sel([0, 2, 0, 0], 0),
    )
    // The same placement from insertBlockNode on the node selection.
    expectEdit(
      doc(ul(li(p('a'), rule()), li(p('z')))),
      createSelection([{ ...at([0, 0, 0, 0], 1), node: [0, 0, 1] }]),
      (tr) => insertBlockNode(tr, x()),
      doc(ul(li(p('a')), li(p('x')), li(p('z')))),
      sel([0, 2, 0, 0], 0),
    )
  })

  it('replacing a selected node with a node that fits nowhere does nothing', () => {
    expectNothing(doc(fig(p('a'), img())), createSelection([{ ...at([0, 0, 0], 1), node: [0, 1] }]), (tr) =>
      replaceSelectedNode(tr, { node: el('tableRow', cell(p(''))) }),
    )
  })

  it("replacing a selected node creates the position's default block", () => {
    const content = doc(fig(p('a'), img()))
    const nodeSel = createSelection([{ ...at([0, 0, 0], 1), node: [0, 1] }])
    expectEdit(content, nodeSel, (tr) => replaceSelectedNode(tr, { text: 'x' }), doc(fig(p('a'), cap('x'))), sel([0, 1, 0], 1))
    expectEdit(
      content,
      nodeSel,
      (tr) => replaceSelectedNode(tr, 'split'),
      doc(fig(p('a'), img(), cap(''))),
      sel([0, 2, 0], 0),
    )
  })
})
