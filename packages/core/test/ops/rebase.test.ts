import { describe, expect, it } from 'vitest'
import { applyOp, getNode, invertOp, type Doc, type ElementNode, type Operation, type Path, type TextNode } from '../../src/index'
import { rebaseBoth, rebaseOps } from '../../src/ops/rebase'
import { doc, el, txt } from '../../src/testing/builders'

const para = (text: string): ElementNode => el('paragraph', txt(text))
const applyAll = (d: Doc, ops: Operation[]) => ops.reduce(applyOp, d)

/** `ops` and `over` both start from `d`: applying `over` then the rebased ops equals `ops` then the rebased `over`. */
function expectConverges(d: Doc, ops: Operation[], over: Operation[]) {
  const a = rebaseOps(ops, over)
  const b = rebaseOps(over, ops)
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  expect(applyAll(applyAll(d, over), a!)).toEqual(applyAll(applyAll(d, ops), b!))
}

describe('rebaseOps', () => {
  it('insert_node before an op path shifts its index by +1', () => {
    const op: Operation = { type: 'insert_text', path: [0, 0], offset: 0, text: 'a' }
    expect(rebaseOps([op], [{ type: 'insert_node', path: [0], node: para('x') }])).toEqual([{ ...op, path: [1, 0] }])
  })

  it('remove_node before an op path shifts its index by -1', () => {
    const op: Operation = { type: 'remove_text', path: [2, 0], offset: 0, text: 'a' }
    expect(rebaseOps([op], [{ type: 'remove_node', path: [0], node: para('x') }])).toEqual([{ ...op, path: [1, 0] }])
  })

  it('insert_text earlier in the same text shifts the offset', () => {
    const op: Operation = { type: 'remove_text', path: [0, 0], offset: 3, text: 'd' }
    expect(rebaseOps([op], [{ type: 'insert_text', path: [0, 0], offset: 1, text: 'xy' }])).toEqual([{ ...op, offset: 5 }])
  })

  it('remove_text earlier in the same text shifts the offset back', () => {
    const op: Operation = { type: 'insert_text', path: [0, 0], offset: 4, text: 'z' }
    expect(rebaseOps([op], [{ type: 'remove_text', path: [0, 0], offset: 0, text: 'ab' }])).toEqual([{ ...op, offset: 2 }])
  })

  it('an op inside a removed node returns null', () => {
    const op: Operation = { type: 'insert_text', path: [1, 0], offset: 0, text: 'a' }
    expect(rebaseOps([op], [{ type: 'remove_node', path: [1], node: para('x') }])).toBeNull()
  })

  it('an op on a removed text range returns null', () => {
    const op: Operation = { type: 'remove_text', path: [0, 0], offset: 1, text: 'bc' }
    expect(rebaseOps([op], [{ type: 'remove_text', path: [0, 0], offset: 2, text: 'cd' }])).toBeNull()
    expect(rebaseOps([op], [{ type: 'insert_text', path: [0, 0], offset: 2, text: 'q' }])).toBeNull()
  })

  it('removing a node that over edited inside returns null (stale payload)', () => {
    const op: Operation = { type: 'remove_node', path: [0], node: para('ab') }
    expect(rebaseOps([op], [{ type: 'insert_text', path: [0, 0], offset: 0, text: 'x' }])).toBeNull()
  })

  it('two inserts at the same place are a tie and return null', () => {
    expect(
      rebaseOps([{ type: 'insert_node', path: [1], node: para('a') }], [{ type: 'insert_node', path: [1], node: para('b') }]),
    ).toBeNull()
    expect(
      rebaseOps([{ type: 'insert_text', path: [0, 0], offset: 1, text: 'a' }], [{ type: 'insert_text', path: [0, 0], offset: 1, text: 'b' }]),
    ).toBeNull()
  })

  it('maps split_node and merge_node paths over unrelated blocks', () => {
    const d = doc(para('ab'), para('cd'), para('ef'))
    expectConverges(d, [{ type: 'split_node', path: [1, 0], position: 1, properties: { marks: [] } }], [
      { type: 'insert_node', path: [0], node: para('x') },
    ])
    expectConverges(d, [{ type: 'merge_node', path: [2], position: 1, properties: { type: 'paragraph', data: {} } }], [
      { type: 'remove_node', path: [0], node: para('ab') },
    ])
  })

  it('returns null for a split of a node the other side edits inside', () => {
    const op: Operation = { type: 'split_node', path: [0, 0], position: 1, properties: { marks: [] } }
    expect(rebaseOps([op], [{ type: 'insert_text', path: [0, 0], offset: 0, text: 'x' }])).toBeNull()
  })

  it('returns null for an insert between the two nodes of a merge', () => {
    const op: Operation = { type: 'merge_node', path: [1], position: 1, properties: { type: 'paragraph', data: {} } }
    expect(rebaseOps([op], [{ type: 'insert_node', path: [1], node: para('x') }])).toBeNull()
  })

  it('returns null for move_node', () => {
    const op: Operation = { type: 'insert_text', path: [0, 0], offset: 0, text: 'a' }
    expect(rebaseOps([op], [{ type: 'move_node', path: [1], newPath: [3] }])).toBeNull()
    expect(rebaseOps([{ type: 'move_node', path: [1], newPath: [3] }], [op])).toBeNull()
  })

  it('set_node_data, marks and text ops on other nodes only move', () => {
    const over: Operation[] = [{ type: 'insert_node', path: [0], node: para('x') }]
    expect(rebaseOps([{ type: 'set_node_data', path: [0], data: { a: 1 }, prevData: {} }], over)).toEqual([
      { type: 'set_node_data', path: [1], data: { a: 1 }, prevData: {} },
    ])
    expect(rebaseOps([{ type: 'add_mark', path: [0, 0], mark: { type: 'bold', data: {} } }], over)).toEqual([
      { type: 'add_mark', path: [1, 0], mark: { type: 'bold', data: {} } },
    ])
  })

  it('a mark op and a text op on the same text commute', () => {
    const d = doc(para('ab'))
    expectConverges(d, [{ type: 'add_mark', path: [0, 0], mark: { type: 'bold', data: {} } }], [
      { type: 'insert_text', path: [0, 0], offset: 1, text: 'x' },
    ])
  })

  it('data ops on the same element, and mark ops on the same text, return null', () => {
    expect(
      rebaseOps([{ type: 'set_node_data', path: [0], data: { a: 1 }, prevData: {} }], [
        { type: 'set_node_data', path: [0], data: { b: 1 }, prevData: {} },
      ]),
    ).toBeNull()
    const m: Operation = { type: 'add_mark', path: [0, 0], mark: { type: 'bold', data: {} } }
    expect(rebaseOps([m], [{ ...m, mark: { type: 'italic', data: {} } }])).toBeNull()
  })

  it('maps set_selection through the ops', () => {
    const s = { anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } }
    expect(
      rebaseOps([{ type: 'set_selection', selection: s, prevSelection: null }], [{ type: 'insert_node', path: [0], node: para('x') }]),
    ).toEqual([
      { type: 'set_selection', selection: { anchor: { path: [1, 0], offset: 1 }, focus: { path: [1, 0], offset: 1 } }, prevSelection: null },
    ])
  })

  it('rebases sequences against sequences', () => {
    const d = doc(para('ab'), para('cd'))
    const ops: Operation[] = [
      { type: 'insert_text', path: [1, 0], offset: 2, text: 'e' },
      { type: 'insert_node', path: [2], node: para('new') },
      { type: 'remove_text', path: [0, 0], offset: 0, text: 'a' },
    ]
    const over: Operation[] = [
      { type: 'insert_node', path: [0], node: para('x') },
      { type: 'insert_text', path: [2, 0], offset: 0, text: 'z' },
      { type: 'remove_node', path: [0], node: para('x') },
      { type: 'insert_node', path: [0], node: para('y') },
    ]
    expectConverges(d, ops, over)
  })
})

describe('rebaseOps fuzz', () => {
  // Small seeded PRNG (mulberry32) so failures reproduce.
  function rng(seed: number) {
    return () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomOp(d: Doc, r: () => number): Operation {
    const int = (n: number) => Math.floor(r() * n)
    const blocks = d.children as ElementNode[]
    const texts: [Path, TextNode][] = []
    blocks.forEach((b, i) => b.children!.forEach((t, j) => texts.push([[i, j], t as TextNode])))
    const kind = int(12)
    const t = texts.length > 0 ? texts[int(texts.length)]! : undefined
    const bi = int(blocks.length)
    switch (kind) {
      case 0:
        if (t) return { type: 'insert_text', path: t[0], offset: int(t[1].text.length + 1), text: 'xy'.slice(0, 1 + int(2)) }
        break
      case 1:
        if (t && t[1].text.length > 0) {
          const s = int(t[1].text.length)
          return { type: 'remove_text', path: t[0], offset: s, text: t[1].text.slice(s, s + 1 + int(t[1].text.length - s)) }
        }
        break
      case 2:
        if (blocks.length > 1) return { type: 'remove_node', path: [bi], node: blocks[bi]! }
        break
      case 3:
        if (t) return { type: 'remove_node', path: t[0], node: t[1] }
        break
      case 4:
        if (blocks.length > 0) return { type: 'insert_node', path: [bi, int(blocks[bi]!.children!.length + 1)], node: txt('q') }
        break
      case 5:
        if (t) return { type: 'split_node', path: t[0], position: int(t[1].text.length + 1), properties: { marks: [] } }
        break
      case 6:
        if (blocks.length > 0)
          return {
            type: 'split_node',
            path: [bi],
            position: int(blocks[bi]!.children!.length + 1),
            properties: { id: `s${int(1e9)}`, type: 'paragraph', data: {} },
          }
        break
      case 7:
        if (bi >= 1) {
          const n = blocks[bi]!
          return { type: 'merge_node', path: [bi], position: blocks[bi - 1]!.children!.length, properties: { id: n.id, type: n.type, data: n.data } }
        }
        break
      case 8:
        if (t && t[0][1]! >= 1) {
          const left = getNode(d, [t[0][0]!, t[0][1]! - 1]) as TextNode
          return { type: 'merge_node', path: t[0], position: left.text.length, properties: { marks: t[1].marks } }
        }
        break
      case 9:
        if (blocks.length > 0) return { type: 'set_node_data', path: [bi], data: { k: int(5) }, prevData: blocks[bi]!.data }
        break
      case 10:
        if (t) {
          const bold = t[1].marks.find((m) => m.type === 'bold')
          return bold ? { type: 'remove_mark', path: t[0], mark: bold } : { type: 'add_mark', path: t[0], mark: { type: 'bold', data: {} } }
        }
        break
    }
    return { type: 'insert_node', path: [int(blocks.length + 1)], node: el('paragraph', txt('n')) }
  }

  /** applyOp, plus checks that payloads applyOp doesn't verify match the doc (they matter for undo). */
  function applyChecked(d: Doc, op: Operation): Doc {
    if (op.type === 'remove_node') expect(getNode(d, op.path)).toEqual(op.node)
    if (op.type === 'set_node_data') expect((getNode(d, op.path) as ElementNode).data).toEqual(op.prevData)
    if (op.type === 'merge_node') {
      const n = getNode(d, op.path)
      const left = getNode(d, [...op.path.slice(0, -1), op.path[op.path.length - 1]! - 1])
      if ('text' in n) {
        expect((left as TextNode).text.length).toBe(op.position)
        expect({ marks: n.marks }).toEqual(op.properties)
      } else {
        expect((left as ElementNode).children!.length).toBe(op.position)
        expect({ id: n.id, type: n.type, data: n.data }).toEqual(op.properties)
      }
    }
    return applyOp(d, op)
  }

  function seq(d: Doc, r: () => number): Operation[] {
    const ops: Operation[] = []
    const n = 1 + Math.floor(r() * 3)
    for (let i = 0; i < n; i++) {
      const op = randomOp(d, r)
      ops.push(op)
      d = applyOp(d, op)
    }
    return ops
  }

  it('converges, with valid payloads and inverses, whenever it does not return null', () => {
    let rebased = 0
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed)
      const d = doc(
        { ...el('paragraph', txt('abc'), txt('de', 'bold')), id: 'p0' },
        { ...el('paragraph', txt('fgh')), id: 'p1' },
        { ...el('paragraph', txt('ij'), txt('kl')), id: 'p2' },
      )
      const ops = seq(d, r)
      const over = seq(d, r)
      const res = rebaseBoth(ops, over)
      if (!res) continue
      rebased++
      const afterOver = over.reduce(applyChecked, d)
      const left = res.ops.reduce(applyChecked, afterOver)
      const right = res.over.reduce(applyChecked, ops.reduce(applyChecked, d))
      expect(left, `seed ${seed}`).toEqual(right)
      // Undo of the rebased ops lands back on the doc after `over` (what history relies on).
      const undone = res.ops.map(invertOp).reverse().reduce(applyChecked, left)
      expect(undone, `seed ${seed}`).toEqual(afterOver)
    }
    expect(rebased).toBeGreaterThan(600)
  })
})
