import { describe, expect, it } from 'vitest'
import type { Editor } from '../../src/editor'
import { createSelection, single } from '../../src/model/selection'
import type { Doc, ElementNode, Selection, SelectionRange } from '../../src/model/types'
import { normalize } from '../../src/normalize'
import { rebaseOps } from '../../src/ops/rebase'
import { transformSelection, transformSelectionStrict } from '../../src/ops/transform'
import type { Operation } from '../../src/ops/types'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import type { AnyPlugin, PluginContext } from '../../src/plugin/types'
import { doc, el, txt } from '../../src/testing/builders'
import { createTestEditor } from '../../src/testing/index'
import { Transaction } from '../../src/transaction/transaction'
import { testBold, testParagraph } from '../fixtures'

const caret = (path: number[], offset: number): SelectionRange => ({ anchor: { path, offset }, focus: { path, offset } })
const para = (text: string): ElementNode => el('paragraph', txt(text))
const plugins: AnyPlugin[] = [testParagraph, testBold]

function trOn(d: Doc, selection: Selection | null): Transaction {
  return new Transaction({ doc: d, selection, storedMarks: null, pluginStates: new Map() }, new Registry(plugins))
}

const ctx = (plugin: AnyPlugin): PluginContext<any, any> => ({
  editor: {} as Editor,
  name: plugin.name,
  options: plugin.spec.options ?? {},
  getState: () => undefined,
  storage: undefined,
  commands: {},
})

describe('transformSelection with several ranges', () => {
  it('maps every range through an insert before them', () => {
    const sel = createSelection([caret([0, 0], 2), caret([0, 0], 6)], 1)
    const out = transformSelection(sel, { type: 'insert_text', path: [0, 0], offset: 0, text: 'xy' })
    expect(out).toEqual({ ranges: [caret([0, 0], 4), caret([0, 0], 8)], main: 1 })
  })

  it('drops a range that cannot be mapped and keeps the others', () => {
    const sel = createSelection([caret([0, 0], 1), caret([1, 0], 1)], 1)
    const out = transformSelection(sel, { type: 'remove_node', path: [1], node: para('def') })
    expect(out).toEqual({ ranges: [caret([0, 0], 1)], main: 0 })
  })

  it('null only when every range is gone', () => {
    const sel = createSelection([caret([1, 0], 0), caret([1, 0], 2)], 0)
    expect(transformSelection(sel, { type: 'remove_node', path: [1], node: para('def') })).toBeNull()
  })

  it('carets that collide after mapping are merged', () => {
    const sel = createSelection([caret([0, 0], 1), caret([0, 0], 3)], 1)
    const out = transformSelection(sel, { type: 'remove_text', path: [0, 0], offset: 1, text: 'bc' })
    expect(out).toEqual({ ranges: [caret([0, 0], 1)], main: 0 })
  })
})

describe('transformSelectionStrict', () => {
  it('is null as soon as one range cannot be mapped', () => {
    const sel = createSelection([caret([0, 0], 1), caret([1, 0], 1)], 0)
    expect(transformSelectionStrict(sel, { type: 'remove_node', path: [1], node: para('def') })).toBeNull()
  })

  it('maps every range otherwise', () => {
    const sel = createSelection([caret([0, 0], 2), caret([0, 0], 6)], 0)
    expect(transformSelectionStrict(sel, { type: 'insert_text', path: [0, 0], offset: 0, text: 'x' })).toEqual({
      ranges: [caret([0, 0], 3), caret([0, 0], 7)],
      main: 0,
    })
  })
})

describe('rebase keeps the strict rule', () => {
  const removePara: Operation = { type: 'remove_node', path: [1], node: para('def') }

  it('drops an entry when its single range fails', () => {
    const op: Operation = { type: 'set_selection', selection: single(caret([1, 0], 1)), prevSelection: null }
    expect(rebaseOps([op], [removePara])).toBeNull()
  })

  it('drops an entry when any one of several ranges fails', () => {
    const selection = createSelection([caret([0, 0], 1), caret([1, 0], 1)], 0)
    const op: Operation = { type: 'set_selection', selection, prevSelection: null }
    expect(rebaseOps([op], [removePara])).toBeNull()
  })
})

describe('Transaction with several ranges', () => {
  it('a range in a removed text node is rehomed, others kept', () => {
    const tr = trOn(doc(para('abc'), para('def'), para('ghi')), createSelection([caret([0, 0], 1), caret([1, 0], 1)], 1))
    tr.removeNode([1])
    // The second caret moves to the end of the closest editable text before the removed node.
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 1), caret([0, 0], 3)], main: 1 })
  })

  it('a rehomed range merges with a range already there', () => {
    const tr = trOn(doc(para('abc'), para('def')), createSelection([caret([0, 0], 3), caret([1, 0], 1)], 0))
    tr.removeNode([1])
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 3)], main: 0 })
  })

  it('a rehomed range with nothing before goes to the start of the next editable text', () => {
    const tr = trOn(doc(para('abc'), para('def'), para('ghi')), createSelection([caret([0, 0], 1), caret([2, 0], 2)], 1))
    tr.removeNode([0])
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 0), caret([1, 0], 2)], main: 1 })
  })

  it('null when every range is gone (as with a single range)', () => {
    const tr = trOn(doc(para('abc'), para('def')), createSelection([caret([1, 0], 0), caret([1, 0], 2)], 0))
    tr.removeNode([1])
    expect(tr.selection).toBeNull()
    const one = trOn(doc(para('abc'), para('def')), single(caret([1, 0], 1)))
    one.removeNode([1])
    expect(one.selection).toBeNull()
  })

  it('setSelection normalizes: two identical carets give one', () => {
    const tr = trOn(doc(para('abc')), null)
    tr.setSelection({ ranges: [caret([0, 0], 1), caret([0, 0], 1)], main: 1 })
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 1)], main: 0 })
  })

  it('setSelection sorts the ranges and keeps main on the same range', () => {
    const tr = trOn(doc(para('abcdef')), null)
    tr.setSelection({ ranges: [caret([0, 0], 5), caret([0, 0], 1)], main: 0 })
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 1), caret([0, 0], 5)], main: 1 })
  })
})

describe("normalize's empty-text cleanup maps every range", () => {
  it('rehomes every range inside the removed empty text and maps the others', () => {
    // A caret in the empty bold text (removed, nothing before it) and one in the next text.
    const d = doc(el('paragraph', txt('', 'bold'), txt('bc')), para('xyz'))
    const tr = trOn(d, createSelection([caret([0, 0], 0), caret([0, 1], 2), caret([1, 0], 1)], 2))
    normalize(tr, ctx)
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 0), caret([0, 0], 2), caret([1, 0], 1)], main: 2 })
  })

  it('maps every range when the empty text merges into the previous one', () => {
    const d = doc(el('paragraph', txt('a'), txt('', 'bold')), para('xyz'))
    const tr = trOn(d, createSelection([caret([0, 1], 0), caret([1, 0], 2)], 0))
    normalize(tr, ctx)
    expect(tr.selection).toEqual({ ranges: [caret([0, 0], 1), caret([1, 0], 2)], main: 0 })
  })
})

describe('Editor validates every committed range', () => {
  const widget = (): ElementNode => ({ id: 'w', type: 'widget', data: {}, children: [txt('hidden')] })

  it('rehomes a loaded range that is not at an editable point, keeping the others', () => {
    const editor = createTestEditor({
      plugins,
      doc: doc(para('ab'), widget(), para('cd')),
      selection: createSelection([caret([0, 0], 1), caret([1, 0], 0), caret([2, 0], 1)], 2),
    })
    expect(editor.state.selection).toEqual({ ranges: [caret([0, 0], 1), caret([0, 0], 2), caret([2, 0], 1)], main: 2 })
  })

  it('a single invalid loaded range still falls back to the first editable caret', () => {
    const editor = createTestEditor({
      plugins,
      doc: doc(para('ab'), widget(), para('cd')),
      selection: single(caret([1, 0], 0)),
    })
    expect(editor.state.selection).toEqual(single(caret([0, 0], 0)))
  })

  it('rehomes a dispatched range that is not at an editable point', () => {
    const editor = createTestEditor({ plugins, doc: doc(para('ab'), widget(), para('cd')) })
    const tr = editor.createTransaction()
    tr.setSelection(createSelection([caret([1, 0], 3), caret([2, 0], 1)], 0))
    editor.dispatch(tr)
    expect(editor.state.selection).toEqual({ ranges: [caret([0, 0], 2), caret([2, 0], 1)], main: 0 })
  })
})
