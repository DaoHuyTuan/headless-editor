import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/model/selection'
import type { DeepReadonly, Doc, ElementNode, Node, Path, Selection, SelectionRange } from '../../src/model/types'
import { transformRange } from '../../src/ops/transform'
import { isValidDoc } from '../../src/schema/validate'
import type { EditorState } from '../../src/state'
import type { Slice } from '../../src/transaction/slice'
import { Transaction } from '../../src/transaction/transaction'
import { createTestEditor, doc, el, stripIds, txt } from '../../src/testing/index'
import { nested } from '../fixtures'

// Multi-range parity on nested documents (spec §8): running a command once with several ranges
// gives what running it on each range alone gives, one range after the other in document order,
// each range mapped through the edits before it (as `single-range-*` pins for flat documents).

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const quote = (...children: ElementNode[]): ElementNode => el('quote', ...children)
const ul = (...children: ElementNode[]): ElementNode => el('bulletList', ...children)
const li = (...children: ElementNode[]): ElementNode => el('listItem', ...children)
const table = (...rows: ElementNode[][]): ElementNode =>
  el('table', ...rows.map((cells) => el('tableRow', ...cells.map((c) => el('tableCell', c)))))

const at = (path: Path, offset: number) => ({ path, offset })
const caret = (path: Path, offset: number): SelectionRange => ({ anchor: at(path, offset), focus: at(path, offset) })
const span = (from: Path, a: number, to: Path, b: number): SelectionRange => ({ anchor: at(from, a), focus: at(to, b) })

type Command = (tr: Transaction) => unknown

/** `d` as an editor loading it holds it (normalized: adjacent texts merged), without ids. */
const committed = (d: DeepReadonly<Doc>) => stripIds(createTestEditor({ plugins: nested, doc: d as Doc }).getJSON())

const registry = createTestEditor({ plugins: nested }).registry

/** A dev-mode tr on `content` as it is (no load normalization: the raw docs of earlier runs stay raw). */
function trOf(content: DeepReadonly<Doc>, selection: Selection): Transaction {
  const state: EditorState = { doc: content, selection, storedMarks: null, pluginStates: new Map() }
  return new Transaction(state, registry, { dev: true })
}

/** `command` once with every range on one tr. */
function multi(content: Doc, ranges: SelectionRange[], command: Command): Transaction {
  const tr = trOf(content, createSelection(ranges))
  command(tr)
  expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
  return tr
}

/**
 * `command` on each range alone, in document order, each on a fresh tr of the doc the previous run
 * left. A range still to run is mapped forward through every run's ops; a result already collected
 * is mapped backward (as `forEachRange` maps them).
 */
function sequential(content: Doc, ranges: SelectionRange[], command: Command): { doc: DeepReadonly<Doc>; selection: Selection } {
  let current: DeepReadonly<Doc> = content
  const pending: (SelectionRange | null)[] = [...ranges]
  const results: SelectionRange[] = []
  for (let i = 0; i < pending.length; i++) {
    const range = pending[i]
    expect(range).not.toBeNull()
    const tr = trOf(current, createSelection([range!]))
    command(tr)
    expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
    const docOps = tr.ops.filter((op) => op.type !== 'set_selection')
    for (const op of docOps) {
      for (let k = 0; k < results.length; k++) {
        const mapped = transformRange(results[k]!, op, 'backward')
        expect(mapped).not.toBeNull()
        results[k] = mapped!
      }
      for (let k = i + 1; k < pending.length; k++) pending[k] = pending[k] && transformRange(pending[k]!, op, 'forward')
    }
    expect(tr.selection!.ranges).toHaveLength(1)
    results.push(tr.selection!.ranges[0]!)
    current = tr.doc
  }
  return { doc: current, selection: createSelection(results) }
}

function expectParity(content: Doc, ranges: SelectionRange[], command: Command, expected: Doc): Transaction {
  const m = multi(content, ranges, command)
  const s = sequential(content, ranges, command)
  // The raw docs (before the commit's normalization merges adjacent texts) are the same.
  expect(stripIds(m.doc)).toEqual(stripIds(s.doc))
  expect(m.selection).toEqual(s.selection)
  expect(committed(m.doc)).toEqual(stripIds(expected))
  return m
}

describe('nested multi-range parity', () => {
  it('deleteRange: across list items and across quote paragraphs', () => {
    const d = doc(ul(li(p('ab')), li(p('cd'))), p('mid'), quote(p('ef'), p('gh')))
    expectParity(
      d,
      [span([0, 0, 0, 0], 1, [0, 1, 0, 0], 1), span([2, 0, 0], 1, [2, 1, 0], 1)],
      (tr) => tr.deleteRange(),
      doc(ul(li(p('ad'))), p('mid'), quote(p('eh'))),
    )
  })

  it('deleteRange: across two table cells and from a quote into a root paragraph', () => {
    const d = doc(table([p('ab'), p('cd')]), quote(p('ef')), p('gh'))
    expectParity(
      d,
      [span([0, 0, 0, 0, 0], 1, [0, 0, 1, 0, 0], 1), span([1, 0, 0], 1, [2, 0], 1)],
      (tr) => tr.deleteRange(),
      doc(table([p('a'), p('d')]), quote(p('eh'))),
    )
  })

  it('deleteBackward: lifts out of a quote, joins list items, does nothing at a cell start', () => {
    const d = doc(quote(p('ab')), ul(li(p('cd')), li(p('ef'))), table([p('gh')]))
    expectParity(
      d,
      [caret([0, 0, 0], 0), caret([1, 1, 0, 0], 0), caret([2, 0, 0, 0, 0], 0)],
      (tr) => tr.deleteBackward(),
      doc(p('ab'), ul(li(p('cdef'))), table([p('gh')])),
    )
  })

  it('deleteBackward: deletes a character in two containers', () => {
    const d = doc(quote(p('ab')), ul(li(p('cd'))))
    expectParity(
      d,
      [caret([0, 0, 0], 2), caret([1, 0, 0, 0], 1)],
      (tr) => tr.deleteBackward(),
      doc(quote(p('a')), ul(li(p('d')))),
    )
  })

  it('deleteForward: joins out of a quote and across list items', () => {
    const d = doc(quote(p('ab')), p('cd'), ul(li(p('ef')), li(p('gh'))))
    expectParity(
      d,
      [caret([0, 0, 0], 2), caret([2, 0, 0, 0], 2)],
      (tr) => tr.deleteForward(),
      doc(quote(p('abcd')), ul(li(p('efgh')))),
    )
  })

  it('splitBlock: splits in a list item and a quote, lifts an empty paragraph out of a quote', () => {
    const d = doc(ul(li(p('abcd'))), quote(p('efgh')), quote(p('x'), p('')))
    expectParity(
      d,
      [caret([0, 0, 0, 0], 2), caret([1, 0, 0], 2), caret([2, 1, 0], 0)],
      (tr) => tr.splitBlock(),
      doc(ul(li(p('ab'), p('cd'))), quote(p('ef'), p('gh')), quote(p('x')), p('')),
    )
  })

  it('wrap: wraps paragraphs at the root and inside a quote', () => {
    const d = doc(p('a'), p('b'), quote(p('c'), p('d')))
    expectParity(
      d,
      [caret([0, 0], 0), caret([2, 1, 0], 1)],
      (tr) => tr.wrap('bulletList'),
      doc(ul(li(p('a'))), p('b'), quote(p('c'), ul(li(p('d'))))),
    )
  })

  it('wrap: two ranges in one block wrap it once (by design, not as two sequential wraps)', () => {
    // `wrap` wraps each block once per call: the second range's block was already wrapped by the
    // first range, so it does nothing. Run alone after the first, the second range would sit in the
    // new quote and wrap it again (quote(quote(p))).
    const d = doc(p('abcd'))
    const tr = multi(d, [caret([0, 0], 1), caret([0, 0], 3)], (t) => t.wrap('quote'))
    expect(committed(tr.doc)).toEqual(stripIds(doc(quote(p('abcd')))))
    expect(tr.selection).toEqual(createSelection([caret([0, 0, 0], 1), caret([0, 0, 0], 3)]))
    const s = sequential(d, [caret([0, 0], 1), caret([0, 0], 3)], (t) => t.wrap('quote'))
    expect(committed(s.doc)).toEqual(stripIds(doc(quote(quote(p('abcd'))))))
  })

  it('lift: lifts paragraphs out of two quotes, splitting one', () => {
    const d = doc(quote(p('a')), quote(p('b'), p('c'), p('d')))
    expectParity(
      d,
      [caret([0, 0, 0], 1), caret([1, 1, 0], 0)],
      (tr) => tr.lift(),
      doc(p('a'), quote(p('b')), p('c'), quote(p('d'))),
    )
  })

  it('insertSlice: list items merge into a list item and go in whole (a list) in a root paragraph', () => {
    const slice: Slice = { content: [li(p('x')), li(p('y'))], openStart: 2, openEnd: 2 }
    const d = doc(ul(li(p('ab'))), p('cd'))
    const tr = expectParity(
      d,
      [caret([0, 0, 0, 0], 1), caret([1, 0], 1)],
      (t) => t.insertSlice(slice),
      doc(ul(li(p('ax')), li(p('yb'))), p('c'), ul(li(p('x')), li(p('y'))), p('d')),
    )
    expect(tr.selection!.ranges).toHaveLength(2)
  })

  it('insertSlice: a closed quote pasted at carets in a list item and in a table cell', () => {
    const slice: Slice = { content: [quote(p('q'))], openStart: 0, openEnd: 0 }
    const d = doc(ul(li(p('ab'))), table([p('cd')]))
    expectParity(
      d,
      [caret([0, 0, 0, 0], 2), caret([1, 0, 0, 0, 0], 2)],
      (t) => t.insertSlice(slice),
      doc(ul(li(p('ab'), quote(p('q')))), el('table', el('tableRow', el('tableCell', p('cd'), quote(p('q')))))),
    )
  })
})
