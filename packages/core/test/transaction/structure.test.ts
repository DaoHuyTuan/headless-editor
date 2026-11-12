import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import { createSelection, mainRange } from '../../src/model/selection'
import type { Doc, ElementNode, Node, Selection } from '../../src/model/types'
import { isValidDoc } from '../../src/schema/validate'
import { canJoin, canLift, canSetBlockType, canWrap, liftTarget } from '../../src/transaction/structure'
import type { Transaction } from '../../src/transaction/transaction'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { nested } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const quote = (...children: ElementNode[]): ElementNode => el('quote', ...children)
const ul = (...children: ElementNode[]): ElementNode => el('bulletList', ...children)
const li = (...children: ElementNode[]): ElementNode => el('listItem', ...children)
const code = (text: string): ElementNode => el('code', txt(text))
const caret = (path: number[], offset: number) => ({ path, offset })

function setup(content: Doc, selection: Selection) {
  return createTestEditor({ plugins: nested, doc: content, selection })
}

type Editor = ReturnType<typeof setup>

/**
 * Runs `edit` on a fresh tr of `ed` and checks the result is valid, then dispatches it and checks
 * the committed doc is `expected` (normalization added nothing) and that undo restores the doc and
 * the selection.
 */
function expectApplied(ed: Editor, edit: (tr: Transaction) => unknown, expected: Doc): Transaction {
  const before = ed.state
  const tr = ed.createTransaction()
  const out = edit(tr)
  expect(out).not.toBe(false)
  expect(out).not.toBe(null)
  expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
  expect(stripIds(tr.doc)).toEqual(stripIds(expected))
  ed.dispatch(tr)
  expect(stripIds(ed.getJSON())).toEqual(stripIds(expected))
  expect(ed.state.doc).toEqual(tr.doc)
  expect(ed.commands.undo()).toBe(true)
  expect(ed.state.doc).toEqual(before.doc)
  expect(ed.state.selection).toEqual(before.selection)
  return tr
}

/** Runs `edit` on a fresh tr of `ed` and checks it failed with no ops. */
function expectRefused(ed: Editor, edit: (tr: Transaction) => unknown): void {
  const tr = ed.createTransaction()
  const out = edit(tr)
  expect(out === false || out === null).toBe(true)
  expect(tr.ops).toHaveLength(0)
  expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
}

describe('wrap', () => {
  it('wraps sibling paragraphs into a quote, keeping the selection', () => {
    const ed = setup(doc(p('a'), p('b')), sel([0, 0], 0, [1, 0], 1))
    expect(canWrap(ed.createTransaction(), 'quote')).toBe(true)
    const tr = expectApplied(ed, (t) => t.wrap('quote'), doc(quote(p('a'), p('b'))))
    expect(tr.selection).toEqual(sel([0, 0, 0], 0, [0, 1, 0], 1))
  })

  it('adds the inner wrapper findWrapping gives (a list item in a list)', () => {
    const ed = setup(doc(p('a')), sel([0, 0], 1))
    const tr = expectApplied(ed, (t) => t.wrap('bulletList'), doc(ul(li(p('a')))))
    expect(tr.selection).toEqual(sel([0, 0, 0, 0], 1))
  })

  it('wraps at the deepest level where the blocks are siblings', () => {
    const ed = setup(doc(quote(p('a'), p('b')), p('c')), sel([0, 0, 0], 0, [0, 1, 0], 1))
    expectApplied(ed, (t) => t.wrap('quote'), doc(quote(quote(p('a'), p('b'))), p('c')))
  })

  it('refuses a type its parent does not allow (listItem at the root)', () => {
    const ed = setup(doc(p('a')), sel([0, 0], 1))
    expect(canWrap(ed.createTransaction(), 'listItem')).toBe(false)
    expectRefused(ed, (t) => t.wrap('listItem'))
  })

  it("validates the wrapper's data once, before any range is wrapped (invalid data: no ops at any range)", () => {
    let calls = 0
    const box = definePlugin({
      name: 'box',
      node: { kind: 'block', content: 'block+' },
      data: z.object({ tone: z.string().default('plain') }).refine((d) => (calls++, d.tone !== 'bad')),
    })
    const ed = createTestEditor({
      plugins: [...nested, box],
      doc: doc(p('a'), p('b'), p('c')),
      selection: createSelection([
        { anchor: caret([0, 0], 0), focus: caret([0, 0], 0) },
        { anchor: caret([2, 0], 0), focus: caret([2, 0], 0) },
      ]),
    })
    calls = 0
    const tr = ed.createTransaction()
    expect(tr.wrap('box', { tone: 'bad' })).toBe(false)
    expect(tr.ops).toEqual([])
    expect(tr.rejected).not.toBeNull()
    expect(calls).toBe(1)
  })

  it('refuses a textblock or unknown wrapper type', () => {
    const ed = setup(doc(p('a')), sel([0, 0], 1))
    expectRefused(ed, (t) => t.wrap('code'))
    expectRefused(ed, (t) => t.wrap('nope'))
  })

  it('with an explicit range acts only there (the range it replaces becomes the result, as for runStep)', () => {
    const ed = setup(doc(p('a'), p('b')), sel([0, 0], 0))
    const tr = ed.createTransaction()
    expect(tr.wrap('quote', undefined, { anchor: caret([1, 0], 1), focus: caret([1, 0], 1) })).toBe(true)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a'), quote(p('b')))))
    expect(tr.selection).toEqual(sel([1, 0, 0], 1))
  })

  it('inside forEachRange, with the callback range, edits there without setting the selection', () => {
    const ed = setup(doc(p('a'), p('b')), sel([1, 0], 1))
    const tr = ed.createTransaction()
    tr.forEachRange((range, t) => {
      expect(t.wrap('quote', undefined, range)).toBe(true)
    })
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(p('a'), quote(p('b')))))
    expect(tr.selection).toEqual(sel([1, 0, 0], 1))
    // The ranges are mapped through the moves: no set_selection is needed.
    expect(tr.ops.filter((op) => op.type === 'set_selection')).toHaveLength(0)
  })

  it('a call without a range inside forEachRange throws in dev mode', () => {
    const ed = setup(doc(quote(p('a'))), sel([0, 0, 0], 0))
    const tr = ed.createTransaction()
    expect(() => tr.forEachRange((_r, t) => void t.wrap('quote'))).toThrow(/pass the callback range/)
    const tr2 = ed.createTransaction()
    expect(() => tr2.forEachRange((_r, t) => void t.lift())).toThrow(/pass the callback range/)
  })

  it('wraps each range once, even when two carets share a block', () => {
    const ed = setup(
      doc(p('ab'), p('c')),
      createSelection([
        { anchor: caret([0, 0], 0), focus: caret([0, 0], 0) },
        { anchor: caret([0, 0], 2), focus: caret([0, 0], 2) },
        { anchor: caret([1, 0], 1), focus: caret([1, 0], 1) },
      ]),
    )
    const tr = ed.createTransaction()
    expect(tr.wrap('quote')).toBe(true)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(quote(p('ab')), quote(p('c')))))
    expect(tr.selection).toEqual(
      createSelection([
        { anchor: caret([0, 0, 0], 0), focus: caret([0, 0, 0], 0) },
        { anchor: caret([0, 0, 0], 2), focus: caret([0, 0, 0], 2) },
        { anchor: caret([1, 0, 0], 1), focus: caret([1, 0, 0], 1) },
      ]),
    )
    expect(tr.ops.filter((op) => op.type === 'set_selection')).toHaveLength(0)
    expect(isValidDoc(tr.doc, tr.registry)).toBe(true)
  })
})

describe('lift', () => {
  it('lifts a middle paragraph out of its quote, splitting the quote', () => {
    const ed = setup(doc(quote(p('a'), p('b'), p('c'))), sel([0, 1, 0], 1))
    expect(canLift(ed.createTransaction())).toBe(true)
    expect(liftTarget(ed.state.doc, ed.registry, { start: caret([0, 1, 0], 1), end: caret([0, 1, 0], 1) })).toBe(0)
    const tr = expectApplied(ed, (t) => t.lift(), doc(quote(p('a')), p('b'), quote(p('c'))))
    expect(tr.selection).toEqual(sel([1, 0], 1))
  })

  it('lifts the first paragraph of a quote before it', () => {
    const ed = setup(doc(quote(p('a'), p('b'))), sel([0, 0, 0], 0))
    expectApplied(ed, (t) => t.lift(), doc(p('a'), quote(p('b'))))
  })

  it('removes a quote left empty', () => {
    const ed = setup(doc(quote(p('a'), p('b'))), sel([0, 0, 0], 0, [0, 1, 0], 1))
    const tr = expectApplied(ed, (t) => t.lift(), doc(p('a'), p('b')))
    expect(tr.selection).toEqual(sel([0, 0], 0, [1, 0], 1))
  })

  it('refuses a paragraph first in a list item (it cannot go into the list)', () => {
    const ed = setup(doc(ul(li(p('a')))), sel([0, 0, 0, 0], 0))
    expect(liftTarget(ed.state.doc, ed.registry, { start: caret([0, 0, 0, 0], 0), end: caret([0, 0, 0, 0], 0) })).toBe(
      null,
    )
    expect(canLift(ed.createTransaction())).toBe(false)
    expectRefused(ed, (t) => t.lift())
  })

  it('refuses at the root and out of an isolating node', () => {
    expectRefused(setup(doc(p('a')), sel([0, 0], 0)), (t) => t.lift())
    const table = el('table', el('tableRow', el('tableCell', p('a'))))
    expectRefused(setup(doc(table), sel([0, 0, 0, 0, 0], 0)), (t) => t.lift())
  })
})

describe('setBlockType', () => {
  it('turns a paragraph into a code block, removing the marks code does not allow', () => {
    const ed = setup(doc(p(txt('a', 'bold'))), sel([0, 0], 1))
    const oldId = (ed.state.doc.children[0] as ElementNode).id
    expect(canSetBlockType(ed.createTransaction(), 'code')).toBe(true)
    const tr = expectApplied(ed, (t) => t.setBlockType('code'), doc(code('a')))
    const node = tr.doc.children[0] as ElementNode
    expect(node.id).not.toBe(oldId)
    expect(tr.selection).toEqual(sel([0, 0], 1))
  })

  it('merges texts left with the same marks', () => {
    const ed = setup(doc(p(txt('a', 'bold'), txt('b'))), sel([0, 1], 1))
    const tr = expectApplied(ed, (t) => t.setBlockType('code'), doc(code('ab')))
    expect(tr.selection).toEqual(sel([0, 0], 2))
  })

  it('changes every textblock in the range, at any depth', () => {
    const ed = setup(doc(p('a'), quote(p('b')), p('c')), sel([0, 0], 0, [1, 0, 0], 1))
    expectApplied(ed, (t) => t.setBlockType('code'), doc(code('a'), quote(code('b')), p('c')))
  })

  it('refuses a non-textblock type, and a block already of that type', () => {
    const ed = setup(doc(p('a')), sel([0, 0], 0))
    expect(canSetBlockType(ed.createTransaction(), 'quote')).toBe(false)
    expectRefused(ed, (t) => t.setBlockType('quote'))
    expectRefused(ed, (t) => t.setBlockType('paragraph'))
  })

  it('refuses a block whose parent would not allow the new type', () => {
    // A list item must start with a paragraph.
    const ed = setup(doc(ul(li(p('a')))), sel([0, 0, 0, 0], 0))
    expectRefused(ed, (t) => t.setBlockType('code'))
  })

  it('canSetBlockType with data reports a data-only change; invalid data reports false', () => {
    const heading = definePlugin({
      name: 'heading',
      node: { kind: 'block', content: 'inline' },
      data: z.object({ level: z.number().default(1) }),
    })
    const ed = createTestEditor({ plugins: [...nested, heading], doc: doc(el('heading', { level: 1 }, txt('a'))), selection: sel([0, 0], 0) })
    const tr = ed.createTransaction()
    expect(canSetBlockType(tr, 'heading')).toBe(false)
    expect(canSetBlockType(tr, 'heading', { level: 1 })).toBe(false)
    expect(canSetBlockType(tr, 'heading', { level: 2 })).toBe(true)
    expect(canSetBlockType(tr, 'heading', { level: 'x' })).toBe(false)
    expect(canSetBlockType(tr, 'paragraph', undefined, mainRange(tr.selection!))).toBe(true)
    expectApplied(ed, (t) => t.setBlockType('heading', { level: 2 }), doc(el('heading', { level: 2 }, txt('a'))))
  })
})

describe('split', () => {
  it('splits a paragraph and its list item at depth 2', () => {
    const ed = setup(doc(ul(li(p('ab')))), sel([0, 0, 0, 0], 1))
    let point: unknown
    expectApplied(
      ed,
      (t) => (point = t.split(caret([0, 0, 0, 0], 1), 2)),
      doc(ul(li(p('a')), li(p('b')))),
    )
    expect(point).toEqual(caret([0, 1, 0, 0], 0))
  })

  it('splits a textblock at depth 1 by default', () => {
    const ed = setup(doc(quote(p('ab'))), sel([0, 0, 0], 1))
    expectApplied(ed, (t) => t.split(caret([0, 0, 0], 1)), doc(quote(p('a'), p('b'))))
  })

  it('gives the new nodes the types of typesAfter, outermost first', () => {
    const ed = setup(doc(quote(code('ab'))), sel([0, 0, 0], 1))
    expectApplied(
      ed,
      (t) => t.split(caret([0, 0, 0], 1), 2, [null, { type: 'paragraph' }]),
      doc(quote(code('a')), quote(p('b'))),
    )
  })

  it('refuses a split the schema does not allow', () => {
    // A list item cannot be split off at the list level: the right half of the list item would be a
    // paragraph inside the list.
    const ed = setup(doc(ul(li(p('ab')))), sel([0, 0, 0, 0], 1))
    expectRefused(ed, (t) => t.split(caret([0, 0, 0, 0], 1), 2, [{ type: 'paragraph' }, null]))
    // Too deep (the doc cannot be split), and across an isolating cell.
    expectRefused(ed, (t) => t.split(caret([0, 0, 0, 0], 1), 4))
    const table = el('table', el('tableRow', el('tableCell', p('ab'))))
    expectRefused(setup(doc(table), sel([0, 0, 0, 0, 0], 1)), (t) => t.split(caret([0, 0, 0, 0, 0], 1), 2))
  })
})

describe('join', () => {
  it('joins two adjacent lists', () => {
    const ed = setup(doc(ul(li(p('a'))), ul(li(p('b')))), sel([1, 0, 0, 0], 1))
    expect(canJoin(ed.createTransaction(), [1])).toBe(true)
    const tr = expectApplied(ed, (t) => t.join([1]), doc(ul(li(p('a')), li(p('b')))))
    expect(tr.selection).toEqual(sel([0, 1, 0, 0], 1))
  })

  it('refuses a list and a quote', () => {
    const ed = setup(doc(ul(li(p('a'))), quote(p('b'))), sel([0, 0, 0, 0], 0))
    expect(canJoin(ed.createTransaction(), [1])).toBe(false)
    expectRefused(ed, (t) => t.join([1]))
  })

  it('refuses a node with no previous sibling', () => {
    const ed = setup(doc(ul(li(p('a')))), sel([0, 0, 0, 0], 0))
    expectRefused(ed, (t) => t.join([0]))
  })

  it('joins two textblocks, merging the texts at the seam', () => {
    const ed = setup(doc(p('a'), p('b')), sel([1, 0], 1))
    const tr = expectApplied(ed, (t) => t.join([1]), doc(p('ab')))
    expect(tr.selection).toEqual(sel([0, 0], 2))
  })
})

describe('commands', () => {
  it('wrapIn, lift and setBlockType answer can() and apply', () => {
    const ed = setup(doc(p('a')), sel([0, 0], 1))
    expect(ed.can().wrapIn('listItem')).toBe(false)
    expect(ed.can().lift()).toBe(false)
    expect(ed.can().setBlockType('code')).toBe(true)
    expect(ed.can().wrapIn('quote')).toBe(true)
    expect(ed.state.doc.children[0]!.type).toBe('paragraph')
    expect(ed.commands.wrapIn('quote')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(quote(p('a')))))
    expect(ed.can().lift()).toBe(true)
    expect(ed.commands.lift()).toBe(true)
    expect(ed.commands.setBlockType('code')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(code('a'))))
  })
})
