import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import type { EditorState } from '../../src/state'
import { Transaction } from '../../src/transaction/transaction'
import { doc, el, sel, txt } from '../../src/testing/builders'
import type { ElementNode } from '../../src/model/types'

const para = definePlugin({ name: 'paragraph', node: { kind: 'block', default: true } })
const strict = definePlugin({
  name: 'strict',
  node: { kind: 'block' },
  data: z.object({ n: z.number().optional() }),
})
const registry = new Registry([para, strict])

function stateOf(d: ReturnType<typeof doc>, selection = null as EditorState['selection']): EditorState {
  return { doc: d, selection, storedMarks: null, pluginStates: new Map() }
}

describe('Transaction base', () => {
  it('apply(insert_text) moves a caret after the insert point', () => {
    const d = doc(el('paragraph', txt('abcd')))
    const tr = new Transaction(stateOf(d, sel([0, 0], 3)), registry)
    tr.apply({ type: 'insert_text', path: [0, 0], offset: 1, text: 'XY' })
    expect((tr.doc.children[0].children![0] as { text: string }).text).toBe('aXYbcd')
    expect(tr.selection).toEqual(sel([0, 0], 5))
    expect(tr.docChanged).toBe(true)
    expect(tr.before.doc).toBe(d)
  })

  it('setNodeData merges and emits one op with full prevData', () => {
    const p = el('strict', { b: 2 } as never, txt('x'))
    const tr = new Transaction(stateOf(doc(p)), new Registry([para, definePlugin({ name: 'strict', node: { kind: 'block' } })]))
    tr.setNodeData([0], { a: 1 })
    expect(tr.ops).toEqual([{ type: 'set_node_data', path: [0], data: { b: 2, a: 1 }, prevData: { b: 2 } }])
    expect(tr.doc.children[0].data).toEqual({ b: 2, a: 1 })
    expect(tr.rejected).toBeNull()
  })

  it('setNodeData with invalid data sets rejected and leaves doc alone', () => {
    const d = doc(el('strict', txt('x')))
    const tr = new Transaction(stateOf(d), registry)
    tr.setNodeData([0], { n: 'bad' })
    expect(tr.rejected).toBeTypeOf('string')
    expect(tr.ops).toEqual([])
    expect(tr.doc).toBe(d)
  })

  it('setSelection clears storedMarks and docChanged stays false', () => {
    const d = doc(el('paragraph', txt('ab')))
    const tr = new Transaction(stateOf(d, sel([0, 0], 0)), registry)
    tr.setStoredMarks([{ type: 'bold', data: {} }])
    expect(tr.storedMarks).toHaveLength(1)
    tr.setSelection(sel([0, 0], 2))
    expect(tr.storedMarks).toBeNull()
    expect(tr.selection).toEqual(sel([0, 0], 2))
    expect(tr.ops).toHaveLength(1)
    expect(tr.docChanged).toBe(false)
  })

  it('setSelection to an equal selection is a no-op', () => {
    const tr = new Transaction(stateOf(doc(el('paragraph', txt('ab'))), sel([0, 0], 1)), registry)
    tr.setStoredMarks([{ type: 'bold', data: {} }]).setSelection(sel([0, 0], 1))
    expect(tr.ops).toEqual([])
    expect(tr.storedMarks).toHaveLength(1)
  })

  it('insertNode fills id/data/marks; removeNode records the actual node', () => {
    const tr = new Transaction(stateOf(doc(el('paragraph', txt('a')))), registry)
    tr.insertNode([1], { type: 'paragraph', children: [{ text: 'b' }] } as unknown as ElementNode)
    const inserted = tr.doc.children[1]
    expect(inserted.id).toBeTypeOf('string')
    expect(inserted.data).toEqual({})
    tr.removeNode([1])
    const last = tr.ops[1]
    expect(last.type).toBe('remove_node')
    if (last.type === 'remove_node') expect(last.node).toEqual(inserted)
    expect(tr.doc.children).toHaveLength(1)
  })

  it('setMeta stores values', () => {
    const tr = new Transaction(stateOf(doc(el('paragraph', txt('a')))), registry).setMeta('origin', 'input')
    expect(tr.meta.origin).toBe('input')
  })
})
