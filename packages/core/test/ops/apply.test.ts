import { describe, expect, it } from 'vitest'
import { type Doc, type ElementNode, type Operation } from '../../src/index'
import { applyOp, invertOp } from '../../src/internal'
import { doc, el, sel, txt } from '../../src/testing/builders'

const d: Doc = doc(el('paragraph', {}, txt('abcd')), el('paragraph', txt('ef', 'bold')))
const p0 = d.children[0]!
const p1 = d.children[1]!
const bold = { type: 'bold', data: {} }

const cases: { name: string; op: Operation; expected: () => Doc }[] = [
  {
    name: 'insert_text',
    op: { type: 'insert_text', path: [0, 0], offset: 2, text: 'XY' },
    expected: () => ({ ...d, children: [{ ...p0, children: [txt('abXYcd')] }, p1] }),
  },
  {
    name: 'remove_text',
    op: { type: 'remove_text', path: [0, 0], offset: 1, text: 'bc' },
    expected: () => ({ ...d, children: [{ ...p0, children: [txt('ad')] }, p1] }),
  },
  {
    name: 'insert_node',
    op: { type: 'insert_node', path: [0, 1], node: txt('Z', 'bold') },
    expected: () => ({ ...d, children: [{ ...p0, children: [txt('abcd'), txt('Z', 'bold')] }, p1] }),
  },
  {
    name: 'remove_node',
    op: { type: 'remove_node', path: [1], node: p1 },
    expected: () => ({ ...d, children: [p0] }),
  },
  {
    name: 'split_node (text)',
    op: { type: 'split_node', path: [0, 0], position: 2, properties: { marks: [] } },
    expected: () => ({ ...d, children: [{ ...p0, children: [txt('ab'), txt('cd')] }, p1] }),
  },
  {
    name: 'merge_node (block)',
    op: { type: 'merge_node', path: [1], position: 1, properties: { id: p1.id, type: 'paragraph', data: {} } },
    expected: () => ({ ...d, children: [{ ...p0, children: [txt('abcd'), txt('ef', 'bold')] }] }),
  },
  {
    name: 'move_node (siblings)',
    op: { type: 'move_node', path: [0], newPath: [1] },
    expected: () => ({ ...d, children: [p1, p0] }),
  },
  {
    name: 'move_node (into later block)',
    op: { type: 'move_node', path: [0], newPath: [1, 0] },
    expected: () => ({ ...d, children: [{ ...p1, children: [p0, txt('ef', 'bold')] }] }),
  },
  {
    name: 'set_node_data',
    op: { type: 'set_node_data', path: [0], data: { align: 'center' }, prevData: {} },
    expected: () => ({ ...d, children: [{ ...p0, data: { align: 'center' } }, p1] }),
  },
  {
    name: 'add_mark',
    op: { type: 'add_mark', path: [0, 0], mark: bold },
    expected: () => ({ ...d, children: [{ ...p0, children: [txt('abcd', 'bold')] }, p1] }),
  },
  {
    name: 'remove_mark',
    op: { type: 'remove_mark', path: [1, 0], mark: bold },
    expected: () => ({ ...d, children: [p0, { ...p1, children: [txt('ef')] }] }),
  },
  {
    name: 'set_selection',
    op: { type: 'set_selection', selection: sel([0, 0], 1), prevSelection: null },
    expected: () => d,
  },
]

describe('applyOp / invertOp', () => {
  it.each(cases)('$name: result, inversion, purity', ({ op, expected }) => {
    const before = structuredClone(d)
    const out = applyOp(d, op)
    expect(out).toEqual(expected())
    expect(applyOp(out, invertOp(op))).toEqual(d)
    expect(d).toEqual(before)
  })

  it('shares untouched siblings by reference', () => {
    const out = applyOp(d, { type: 'insert_text', path: [0, 0], offset: 0, text: 'x' })
    expect(out.children[1]).toBe(d.children[1])
    expect(out.children[0]).not.toBe(d.children[0])
  })

  it('splits an element at a child index and round-trips', () => {
    const base = doc(el('paragraph', {}, txt('ab'), txt('cd')), el('paragraph', txt('ef', 'bold')))
    const op: Operation = {
      type: 'split_node',
      path: [0],
      position: 1,
      properties: { id: 'n2', type: 'paragraph', data: {} },
    }
    const out = applyOp(base, op)
    expect(out.children.map((c) => c.children)).toEqual([[txt('ab')], [txt('cd')], [txt('ef', 'bold')]])
    expect(out.children[1]!.id).toBe('n2')
    expect(applyOp(out, invertOp(op))).toEqual(base)
  })

  it('split text uses properties.marks when given', () => {
    const base = doc(el('paragraph', txt('abcd', 'bold')))
    const out = applyOp(base, { type: 'split_node', path: [0, 0], position: 2, properties: { marks: [] } })
    expect(out.children[0]!.children).toEqual([txt('ab', 'bold'), txt('cd')])
  })

  it('works on nested elements', () => {
    const base = doc(el('list', el('item', txt('abc'))))
    const out = applyOp(base, { type: 'insert_text', path: [0, 0, 0], offset: 3, text: 'd' })
    const item = out.children[0]!.children![0] as ElementNode
    expect(item.children![0]).toEqual(txt('abcd'))
  })

  it('round-trips move_node across levels', () => {
    const base = doc(el('a', el('x', txt('1')), el('y', txt('2'))), el('b', txt('3')), el('c', txt('4')))
    const moves: [number[], number[]][] = [
      [[0, 1], [2]],
      [[2], [0, 1]],
      [[0], [2, 0]],
      [[2, 0], [0]],
      [[0, 0], [1, 0]],
      [[1], [2]],
      [[2], [0]],
    ]
    for (const [path, newPath] of moves) {
      const op: Operation = { type: 'move_node', path, newPath }
      expect(applyOp(applyOp(base, op), invertOp(op))).toEqual(base)
    }
  })

  describe('errors', () => {
    it('add_mark when present', () => {
      expect(() => applyOp(d, { type: 'add_mark', path: [1, 0], mark: bold })).toThrow(
        'Mark "bold" already present at [1,0]',
      )
    })
    it('remove_mark when missing', () => {
      expect(() => applyOp(d, { type: 'remove_mark', path: [0, 0], mark: bold })).toThrow(/not present/)
    })
    it('insert_text beyond length', () => {
      expect(() => applyOp(d, { type: 'insert_text', path: [0, 0], offset: 5, text: 'x' })).toThrow(/out of range/)
    })
    it('remove_text mismatch', () => {
      expect(() => applyOp(d, { type: 'remove_text', path: [0, 0], offset: 0, text: 'zz' })).toThrow(/mismatch/)
    })
    it('bad path', () => {
      expect(() => applyOp(d, { type: 'insert_text', path: [9, 0], offset: 0, text: 'x' })).toThrow(/Invalid path/)
    })
    it('merge of different kinds', () => {
      const base = doc(el('p', txt('a'), el('q')))
      expect(() => applyOp(base, { type: 'merge_node', path: [0, 1], position: 1, properties: {} })).toThrow(
        /different kinds/,
      )
    })
    it('move into own descendant', () => {
      expect(() => applyOp(d, { type: 'move_node', path: [0], newPath: [0, 0] })).toThrow()
    })
  })
})
