// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { FRAGMENT_MIME } from '../../src/content/clipboard'
import { setIdGenerator } from '../../src/model/id'
import type { Doc, ElementNode, Node, Path, Selection } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import type { AnyPlugin } from '../../src/plugin/types'
import { isValidDoc } from '../../src/schema/validate'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import type { Slice } from '../../src/index'
import type { Transaction } from '../../src/transaction/transaction'
import { nested, testBold, testParagraph } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const ul = (...children: ElementNode[]): ElementNode => el('bulletList', ...children)
const li = (...children: ElementNode[]): ElementNode => el('listItem', ...children)
const quote = (...children: ElementNode[]): ElementNode => el('quote', ...children)
const table = (...rows: ElementNode[]): ElementNode => el('table', ...rows)
const row = (...cells: ElementNode[]): ElementNode => el('tableRow', ...cells)
const cell = (...children: ElementNode[]): ElementNode => el('tableCell', ...children)
const caption = definePlugin({ name: 'caption', node: { kind: 'block', content: 'inline', group: [] } })
const range = (sp: Path, so: number, ep: Path, eo: number) => ({ start: { path: sp, offset: so }, end: { path: ep, offset: eo } })

function setup(content: Doc, selection: Selection, extra: AnyPlugin[] = []) {
  return createTestEditor({ plugins: [...nested, caption, ...extra], doc: content, selection })
}

/** Two list items, `abc` and `def`, cut at `ab|c` and `d|ef`. */
const twoItems = () => doc(ul(li(p('abc')), li(p('def'))))
const twoItemsRange = range([0, 0, 0, 0], 2, [0, 1, 0, 0], 1)

function sliceOfTwoItems(): Slice {
  const ed = setup(twoItems(), sel([0, 0, 0, 0], 0))
  return ed.createTransaction().getSlice(twoItemsRange)
}

/**
 * Runs `edit` and checks it did something, the tr's own doc is valid (before normalization), the
 * committed doc is `expected`, the selection is `after`, and undo restores the doc.
 */
function expectEdit(content: Doc, selection: Selection, edit: (tr: Transaction) => boolean, expected: Doc, after?: Selection) {
  const ed = setup(content, selection)
  const before = ed.state
  const tr = ed.createTransaction()
  expect(edit(tr)).toBe(true)
  expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
  ed.dispatch(tr)
  expect(stripIds(ed.getJSON())).toEqual(stripIds(expected))
  if (after) expect(ed.state.selection).toEqual(after)
  expect(ed.commands.undo()).toBe(true)
  expect(ed.getJSON()).toEqual(before.doc)
  return ed
}

afterEach(() => setIdGenerator(null))

describe('tr.getSlice', () => {
  it('a range across two list items gives both items, open at depth 2 at each end', () => {
    const slice = sliceOfTwoItems()
    expect(stripIds(slice.content)).toEqual(stripIds([li(p('c')), li(p('d'))]))
    expect(slice.openStart).toBe(2)
    expect(slice.openEnd).toBe(2)
  })

  it('a range across two flat paragraphs is open at depth 1; inside one text, at depth 0', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel([0, 0], 0))
    const tr = ed.createTransaction()
    const blocks = tr.getSlice(range([0, 0], 1, [1, 0], 1))
    expect(stripIds(blocks.content)).toEqual(stripIds([p('b'), p('c')]))
    expect([blocks.openStart, blocks.openEnd]).toEqual([1, 1])
    const inline = tr.getSlice(range([0, 0], 0, [0, 0], 1))
    expect(inline).toEqual({ content: [txt('a')], openStart: 0, openEnd: 0 })
  })

  it('the open depths count each end on its own', () => {
    const ed = setup(doc(ul(li(p('abc'))), p('de')), sel([0, 0], 0))
    const slice = ed.createTransaction().getSlice(range([0, 0, 0, 0], 1, [1, 0], 1))
    expect(stripIds(slice.content)).toEqual(stripIds([ul(li(p('bc'))), p('d')]))
    expect([slice.openStart, slice.openEnd]).toEqual([3, 1])
  })

  it('defaults to the main selection range; a collapsed one gives an empty slice', () => {
    const ed = setup(twoItems(), sel([0, 0, 0, 0], 2, [0, 1, 0, 0], 1))
    expect(ed.createTransaction().getSlice().openStart).toBe(2)
    const caret = setup(twoItems(), sel([0, 0, 0, 0], 2))
    expect(caret.createTransaction().getSlice()).toEqual({ content: [], openStart: 0, openEnd: 0 })
  })
})

describe('tr.insertSlice (spec §5.4)', () => {
  it('two list items pasted into a paragraph of another list item merge with it, in that list', () => {
    const slice = sliceOfTwoItems()
    expectEdit(
      doc(ul(li(p('xy')))),
      sel([0, 0, 0, 0], 1),
      (tr) => tr.insertSlice(slice),
      doc(ul(li(p('xc')), li(p('dy')))),
      sel([0, 1, 0, 0], 1),
    )
  })

  it('two list items pasted into a root paragraph create a list', () => {
    const slice = sliceOfTwoItems()
    expectEdit(
      doc(p('xy')),
      sel([0, 0], 1),
      (tr) => tr.insertSlice(slice),
      doc(p('x'), ul(li(p('c')), li(p('d'))), p('y')),
      sel([1, 1, 0, 0], 1),
    )
  })

  it('a table slice pasted into a cell nests the table in the cell', () => {
    const slice: Slice = { content: [table(row(cell(p('a')), cell(p('b'))))], openStart: 0, openEnd: 0 }
    expectEdit(
      doc(table(row(cell(p('xy'))))),
      sel([0, 0, 0, 0, 0], 1),
      (tr) => tr.insertSlice(slice),
      doc(table(row(cell(p('x'), table(row(cell(p('a')), cell(p('b')))), p('y'))))),
    )
  })

  it('cells cut from a row and pasted into a root paragraph are wrapped into a table', () => {
    const ed = setup(doc(table(row(cell(p('ab')), cell(p('cd'))))), sel([0, 0, 0, 0, 0], 0))
    const slice = ed.createTransaction().getSlice(range([0, 0, 0, 0, 0], 1, [0, 0, 1, 0, 0], 1))
    expect(stripIds(slice.content)).toEqual(stripIds([cell(p('b')), cell(p('c'))]))
    expectEdit(
      doc(p('xy')),
      sel([0, 0], 1),
      (tr) => tr.insertSlice(slice),
      doc(p('x'), table(row(cell(p('b')), cell(p('c')))), p('y')),
    )
  })

  it('an end open into a root textblock merges there while the start goes in whole', () => {
    const ed = setup(doc(ul(li(p('abc'))), p('de')), sel([0, 0], 0))
    const slice = ed.createTransaction().getSlice(range([0, 0, 0, 0], 1, [1, 0], 1))
    expectEdit(doc(p('xy')), sel([0, 0], 1), (tr) => tr.insertSlice(slice), doc(p('x'), ul(li(p('bc'))), p('dy')))
  })

  it('a slice of one item open at both ends goes into the caret textblock', () => {
    const slice: Slice = { content: [li(p('c'))], openStart: 2, openEnd: 2 }
    expectEdit(doc(ul(li(p('xy')))), sel([0, 0, 0, 0], 1), (tr) => tr.insertSlice(slice), doc(ul(li(p('xcy')))))
  })

  it('a quote pasted at the start of a list item paragraph keeps the paragraph the item needs first', () => {
    const slice: Slice = { content: [quote(p('q'))], openStart: 0, openEnd: 0 }
    expectEdit(doc(ul(li(p('xy')))), sel([0, 0, 0, 0], 0), (tr) => tr.insertSlice(slice), doc(ul(li(p(''), quote(p('q')), p('xy')))))
  })

  it('pastes at every selection range', () => {
    const slice = sliceOfTwoItems()
    const ed = setup(doc(ul(li(p('xy'))), ul(li(p('zw')))), sel([0, 0, 0, 0], 1))
    const tr = ed.createTransaction()
    tr.setSelection({
      ranges: [
        { anchor: { path: [0, 0, 0, 0], offset: 1 }, focus: { path: [0, 0, 0, 0], offset: 1 } },
        { anchor: { path: [1, 0, 0, 0], offset: 1 }, focus: { path: [1, 0, 0, 0], offset: 1 } },
      ],
      main: 0,
    })
    expect(tr.insertSlice(slice)).toBe(true)
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(
      stripIds(doc(ul(li(p('xc')), li(p('dy'))), ul(li(p('zc')), li(p('dw'))))),
    )
    expect(ed.state.selection!.ranges).toHaveLength(2)
  })

  it('valid result or no ops: a slice that fits nowhere changes nothing, not even the range', () => {
    const slice: Slice = { content: [el('caption', txt('z'))], openStart: 0, openEnd: 0 }
    const ed = setup(doc(p('abc')), sel([0, 0], 1, [0, 0], 2))
    const tr = ed.createTransaction()
    expect(tr.insertSlice(slice)).toBe(false)
    expect(tr.ops).toEqual([])
  })

  it('open depths larger than the content supports are clamped (no throw)', () => {
    const slice: Slice = { content: [p('c')], openStart: 5, openEnd: 5 }
    expectEdit(doc(p('xy')), sel([0, 0], 1), (tr) => tr.insertSlice(slice), doc(p('xcy')))
  })
})

describe('insertFragment is insertSlice with the open depths of a fragment', () => {
  const ids = () => {
    let n = 0
    setIdGenerator(() => `id${++n}`)
  }
  const flatEditor = () =>
    createTestEditor({ plugins: [testParagraph, testBold], doc: doc(p('ab'), p('cd')), selection: sel([0, 0], 1, [1, 0], 1) })
  const fragments: Node[][] = [[txt('z')], [p('1')], [p('1'), p('2')], [p('1'), p('2'), p('3')]]

  it.each(fragments.map((f, i) => [i, f] as const))('flat fragment %i: the same ops', (_i, fragment) => {
    ids()
    const a = flatEditor()
    const t1 = a.createTransaction()
    t1.insertFragment(fragment)
    ids()
    const b = flatEditor()
    const t2 = b.createTransaction()
    const first = fragment[0]!
    const depth = 'type' in first ? 1 : 0
    t2.insertSlice({ content: fragment, openStart: depth, openEnd: depth })
    expect(t2.ops).toEqual(t1.ops)
  })
})

describe('the paste path uses slices', () => {
  const transfer = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer
  const paste = (ed: ReturnType<typeof setup>, data: Record<string, string>) =>
    ed.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: transfer(data), range: null })

  it('transformPasted gets the slice content; returning fewer nodes clamps the open depths', () => {
    const seen: unknown[] = []
    const shrink = definePlugin({
      name: 'shrink',
      transformPasted: (fragment) => {
        seen.push(stripIds(fragment))
        return [(fragment[0] as ElementNode).children![0]!]
      },
    })
    const json = JSON.stringify(sliceOfTwoItems())
    const ed = setup(doc(p('xy')), sel([0, 0], 1), [shrink])
    expect(paste(ed, { [FRAGMENT_MIME]: json })).toBe(true)
    expect(seen).toEqual([stripIds([li(p('c')), li(p('d'))])])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('xcy'))))
  })
})
