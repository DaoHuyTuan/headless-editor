import { describe, expect, it } from 'vitest'
import { getNode, transformPoint, transformSelection, type Doc, type Node, type Operation, type Path, type TextNode } from '../../src/index'
import { applyOp, transformPath } from '../../src/internal'
import { single } from '../../src/model/selection'
import { doc, el, txt } from '../../src/testing/builders'

const P = (path: Path, offset: number) => ({ path, offset })
const anyNode: Node = el('paragraph', txt(''))

describe('transformSelection with a node selection', () => {
  const s = single({ anchor: P([0, 0], 1), focus: P([0, 0], 1), node: [1] })
  it('maps node through transformPath', () => {
    expect(transformSelection(s, { type: 'insert_node', path: [0], node: anyNode })).toEqual(
      single({
        anchor: P([1, 0], 1),
        focus: P([1, 0], 1),
        node: [2],
      }),
    )
  })
  it('drops node when it is removed, keeping the mapped caret', () => {
    const out = transformSelection(s, { type: 'remove_node', path: [1], node: anyNode })
    expect(out).toEqual(single({ anchor: P([0, 0], 1), focus: P([0, 0], 1) }))
    expect(out!.ranges[0]).not.toHaveProperty('node')
  })
})

describe('transformPath', () => {
  it('insert_node', () => {
    expect(transformPath([0, 1], { type: 'insert_node', path: [0], node: anyNode })).toEqual([1, 1])
    expect(transformPath([0, 1], { type: 'insert_node', path: [1], node: anyNode })).toEqual([0, 1])
    expect(transformPath([0, 1], { type: 'insert_node', path: [0, 2], node: anyNode })).toEqual([0, 1])
  })
  it('remove_node', () => {
    expect(transformPath([0, 1], { type: 'remove_node', path: [0], node: anyNode })).toBeNull()
    expect(transformPath([0], { type: 'remove_node', path: [0], node: anyNode })).toBeNull()
    expect(transformPath([1, 0], { type: 'remove_node', path: [0], node: anyNode })).toEqual([0, 0])
    expect(transformPath([0, 0], { type: 'remove_node', path: [1], node: anyNode })).toEqual([0, 0])
  })
  it('move_node follows applyOp semantics', () => {
    expect(transformPath([0], { type: 'move_node', path: [0], newPath: [2] })).toEqual([2])
    expect(transformPath([1], { type: 'move_node', path: [0], newPath: [2] })).toEqual([0])
    expect(transformPath([0, 0], { type: 'move_node', path: [0], newPath: [2] })).toEqual([2, 0])
  })
})

describe('transformPoint', () => {
  it('split_node', () => {
    expect(transformPoint(P([0, 0], 3), { type: 'split_node', path: [0, 0], position: 2, properties: {} })).toEqual(P([0, 1], 1))
    expect(transformPoint(P([0, 1], 4), { type: 'split_node', path: [0], position: 1, properties: {} })).toEqual(P([1, 0], 4))
  })
  it('merge_node', () => {
    expect(transformPoint(P([0, 1], 1), { type: 'merge_node', path: [0, 1], position: 2, properties: {} })).toEqual(P([0, 0], 3))
    expect(transformPoint(P([1, 0], 1), { type: 'merge_node', path: [1], position: 1, properties: {} })).toEqual(P([0, 1], 1))
  })
  it('insert_text and affinity', () => {
    const op: Operation = { type: 'insert_text', path: [0, 0], offset: 1, text: 'xy' }
    expect(transformPoint(P([0, 0], 1), op)).toEqual(P([0, 0], 3))
    expect(transformPoint(P([0, 0], 1), op, 'backward')).toEqual(P([0, 0], 1))
    expect(transformPoint(P([0, 0], 0), op)).toEqual(P([0, 0], 0))
  })
  it('remove_text', () => {
    const op: Operation = { type: 'remove_text', path: [0, 0], offset: 1, text: 'abc' }
    expect(transformPoint(P([0, 0], 3), op)).toEqual(P([0, 0], 1))
    expect(transformPoint(P([0, 0], 5), op)).toEqual(P([0, 0], 2))
    expect(transformPoint(P([0, 0], 0), op)).toEqual(P([0, 0], 0))
  })
  it('remove_node returns null when inside', () => {
    expect(transformPoint(P([0, 0], 1), { type: 'remove_node', path: [0], node: anyNode })).toBeNull()
  })
  it('identity ops', () => {
    const pt = P([0, 0], 2)
    const ops: Operation[] = [
      { type: 'set_node_data', path: [0], data: {}, prevData: {} },
      { type: 'add_mark', path: [0, 0], mark: { type: 'bold', data: {} } },
      { type: 'remove_mark', path: [0, 0], mark: { type: 'bold', data: {} } },
      { type: 'set_selection', selection: null, prevSelection: null },
    ]
    for (const op of ops) expect(transformPoint(pt, op)).toEqual(pt)
  })
})

describe('transformSelection', () => {
  it('maps both ends, null when either is removed', () => {
    const s = single({ anchor: P([0, 0], 1), focus: P([1, 0], 2) })
    expect(transformSelection(s, { type: 'insert_node', path: [0], node: anyNode })).toEqual(
      single({
        anchor: P([1, 0], 1),
        focus: P([2, 0], 2),
      }),
    )
    expect(transformSelection(s, { type: 'remove_node', path: [1], node: anyNode })).toBeNull()
  })
})

describe('consistency with applyOp', () => {
  const d: Doc = doc(el('paragraph', txt('abcdef')), el('paragraph', txt('ghij')), el('paragraph', txt('klm')))
  const charAt = (dd: Doc, pt: { path: Path; offset: number }) =>
    (getNode(dd, pt.path) as TextNode).text[pt.offset]
  const ops: Operation[] = [
    { type: 'insert_text', path: [0, 0], offset: 2, text: 'XY' },
    { type: 'remove_text', path: [0, 0], offset: 1, text: 'bcd' },
    { type: 'insert_node', path: [0], node: el('paragraph', txt('new')) },
    { type: 'remove_node', path: [0] , node: d.children[0]! },
    { type: 'split_node', path: [0, 0], position: 3, properties: { marks: [] } },
    { type: 'split_node', path: [1], position: 0, properties: { id: 'n', type: 'paragraph', data: {} } },
    { type: 'merge_node', path: [1], position: 1, properties: {} },
    { type: 'move_node', path: [0], newPath: [2] },
    { type: 'move_node', path: [2], newPath: [0] },
    { type: 'move_node', path: [0], newPath: [1, 0] },
    { type: 'move_node', path: [1, 0], newPath: [0, 1] },
  ]
  for (const op of ops) {
    it(`${op.type} ${JSON.stringify('path' in op ? op.path : '')}`, () => {
      const after = applyOp(d, op)
      let checked = 0
      for (let b = 0; b < d.children.length; b++) {
        const t = (d.children[b] as { children: TextNode[] }).children[0]!
        for (let o = 0; o < t.text.length; o++) {
          const pt = P([b, 0], o)
          const mapped = transformPoint(pt, op)
          if (!mapped) continue
          // a point whose char was removed collapses onto a neighbour; only check surviving chars
          if (op.type === 'remove_text' && b === 0 && o >= op.offset && o < op.offset + op.text.length) continue
          expect(charAt(after, mapped)).toBe(t.text[o])
          checked++
        }
      }
      expect(checked).toBeGreaterThan(0)
    })
  }
})
