import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../src/plugin/define'
import { Editor } from '../src/editor'
import { Transaction } from '../src/transaction/transaction'
import type { Command } from '../src/plugin/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const counter = definePlugin({
  name: 'counter',
  node: { kind: 'block' },
  state: { init: () => 0, apply: (tr, n: number) => n + (tr.docChanged ? 1 : 0) },
  options: { label: 'x' },
  commands: (ctx) => ({
    readLabel: () => () => ctx.options.label === 'y',
    readState: (): Command => () => ctx.getState() === 1,
    typeText:
      (text: string): Command =>
      ({ tr }) => {
        if (!tr.selection) return false
        tr.apply({ type: 'insert_text', path: tr.selection.anchor.path, offset: tr.selection.anchor.offset, text })
        return true
      },
    noop: (): Command => () => true,
  }),
})

const heading = definePlugin({ name: 'heading', node: { kind: 'block' }, data: z.object({ level: z.number() }) })

function insertTextTr(ed: Editor, text: string): Transaction {
  const tr = ed.createTransaction()
  tr.apply({ type: 'insert_text', path: [0, 0], offset: 0, text })
  return tr
}

describe('Editor', () => {
  it('loads content, normalizes it and places the caret at the first text', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc() })
    expect(stripIds(ed.getJSON())).toEqual({
      type: 'doc',
      children: [{ type: 'paragraph', data: {}, children: [{ text: '', marks: [] }] }],
    })
    expect(ed.state.selection).toEqual(sel([0, 0], 0))
  })

  it('keeps an explicit initial selection', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))), selection: sel([0, 0], 2) })
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
  })

  it('createTestEditor resets ids to a counter', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc() })
    expect(ed.getJSON().children[0]!.id).toBe('n1')
  })

  it('runs commands with options and plugin state; can() never dispatches', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, counter],
      doc: doc(el('paragraph', txt('ab'))),
      selection: sel([0, 0], 2),
    })
    expect(ed.can().readLabel()).toBe(false)
    ed.setPluginOptions('counter', { label: 'y' })
    expect(ed.commands.readLabel()).toBe(true)

    expect(ed.getPluginState<number>('counter')).toBe(0)
    expect(ed.can().typeText('!')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(el('paragraph', txt('ab')))))
    expect(ed.getPluginState('counter')).toBe(0)

    expect(ed.commands.typeText('!')).toBe(true)
    expect(ed.state.doc.children[0]!.children).toEqual([txt('ab!')])
    expect(ed.getPluginState('counter')).toBe(1)
    expect(ed.commands.readState()).toBe(true)
  })

  it('sets meta.origin = command and does not dispatch empty command trs', () => {
    const ed = createTestEditor({ plugins: [testParagraph, counter], doc: doc(el('paragraph', txt('ab'))) })
    const seen: Transaction[] = []
    ed.on('transaction', ({ tr }) => seen.push(tr))
    expect(ed.commands.noop()).toBe(true)
    expect(seen).toHaveLength(0)
    ed.commands.typeText('x')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.meta.origin).toBe('command')
  })

  it('throws on unknown plugin names', () => {
    const ed = createTestEditor({ plugins: [testParagraph] })
    expect(() => ed.setPluginOptions('nope', {})).toThrow()
    expect(() => ed.getPluginState('nope')).toThrow()
  })

  it('emits transaction, update and selectionUpdate; on() returns an unsubscribe', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))) })
    const events: string[] = []
    const off = ed.on('transaction', () => events.push('transaction'))
    ed.on('update', () => events.push('update'))
    ed.on('selectionUpdate', () => events.push('selectionUpdate'))
    ed.dispatch(ed.createTransaction().setSelection(sel([0, 0], 1)))
    expect(events).toEqual(['transaction', 'selectionUpdate'])
    events.length = 0
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(events).toEqual(['transaction', 'update', 'selectionUpdate'])
    events.length = 0
    off()
    const tr = ed.createTransaction()
    tr.apply({ type: 'insert_text', path: [0, 0], offset: 3, text: 'y' })
    ed.dispatch(tr)
    expect(events).toEqual(['update'])
  })

  it('filterTransaction vetoes silently', () => {
    const veto = definePlugin({ name: 'veto', filterTransaction: (tr) => !tr.ops.some((o) => o.type === 'insert_text') })
    const ed = createTestEditor({ plugins: [testParagraph, veto], doc: doc(el('paragraph', txt('ab'))) })
    const update = vi.fn()
    ed.on('update', update)
    ed.on('transaction', update)
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(ed.state.doc.children[0]!.children).toEqual([txt('ab')])
    expect(update).not.toHaveBeenCalled()
  })

  it('normalizes dispatched transactions', () => {
    const ed = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(el('paragraph', txt('ab'))) })
    const tr = ed.createTransaction()
    tr.insertNode([0, 1], txt('cd'))
    ed.dispatch(tr)
    expect(ed.state.doc.children[0]!.children).toEqual([txt('abcd')])
  })

  it('appendTransaction runs once per change and its ops land in state', () => {
    let calls = 0
    const append = definePlugin({
      name: 'append',
      appendTransaction: (trs, _old, newState) => {
        if (!trs.some((t) => t.docChanged && t.meta.origin !== 'plugin')) return null
        calls++
        const t = new Transaction(newState, trs[0]!.registry)
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '>' })
        return t
      },
    })
    const ed = createTestEditor({ plugins: [testParagraph, append], doc: doc(el('paragraph', txt('ab'))) })
    const seen: Transaction[] = []
    ed.on('transaction', ({ tr }) => seen.push(tr))
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(calls).toBe(1)
    expect(ed.state.doc.children[0]!.children).toEqual([txt('>xab')])
    expect(seen).toHaveLength(2)
    expect(seen[1]!.meta.origin).toBe('plugin')
  })

  it('appendTransaction stops after 10 rounds', () => {
    let calls = 0
    const loop = definePlugin({
      name: 'loop',
      appendTransaction: (trs, _old, newState) => {
        calls++
        const t = new Transaction(newState, trs[0]!.registry)
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '.' })
        return t
      },
    })
    const ed = createTestEditor({ plugins: [testParagraph, loop], doc: doc(el('paragraph', txt(''))) })
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(calls).toBe(10)
    expect((ed.state.doc.children[0]!.children![0] as { text: string }).text).toBe('..........x')
  })

  it('throws on rejected transactions in dev, drops them otherwise', () => {
    const ed = createTestEditor({ plugins: [testParagraph, heading], doc: doc(el('heading', { level: 1 }, txt('a'))) })
    const tr = ed.createTransaction().setNodeData([0], { level: 'x' })
    expect(tr.rejected).toBeTruthy()
    expect(() => ed.dispatch(tr)).toThrow()

    const prod = new Editor({ plugins: [testParagraph, heading], content: doc(el('heading', { level: 1 }, txt('a'))) })
    const before = prod.state
    prod.dispatch(prod.createTransaction().setNodeData([0], { level: 'x' }))
    expect(prod.state).toBe(before)
  })

  it('runKeymap normalizes keys per platform and respects priority', () => {
    const order: string[] = []
    const lo = definePlugin({ name: 'lo', priority: 10, keymap: () => ({ 'Mod-k': () => (order.push('lo'), true) }) })
    const hi = definePlugin({
      name: 'hi',
      priority: 200,
      keymap: () => ({ 'Mod-k': () => (order.push('hi'), false), 'Shift-Mod-z': () => true }),
    })
    const ed = createTestEditor({ plugins: [testParagraph, lo, hi] })
    expect(ed.runKeymap('Ctrl-k')).toBe(true)
    expect(order).toEqual(['hi', 'lo'])
    expect(ed.runKeymap('Meta-k')).toBe(false)
    expect(ed.runKeymap('Mod-k')).toBe(true)
    expect(ed.runKeymap('Ctrl-Shift-z')).toBe(true)
    expect(ed.runKeymap('Ctrl-j')).toBe(false)

    const mac = createTestEditor({ plugins: [testParagraph, lo], platform: 'mac' })
    expect(mac.runKeymap('Meta-k')).toBe(true)
    expect(mac.runKeymap('Ctrl-k')).toBe(false)
  })

  it('handleIntent asks plugins by priority', () => {
    const calls: string[] = []
    const italic = definePlugin({
      name: 'italic',
      onBeforeInput: (intent) => (calls.push('italic'), intent.inputType === 'formatItalic'),
    })
    const first = definePlugin({ name: 'first', priority: 500, onBeforeInput: () => (calls.push('first'), false) })
    const ed = createTestEditor({ plugins: [testParagraph, italic, first] })
    expect(ed.handleIntent({ inputType: 'formatItalic', data: null, range: null })).toBe(true)
    expect(calls).toEqual(['first', 'italic'])
    expect(ed.handleIntent({ inputType: 'formatUnderline', data: null, range: null })).toBe(false)
  })

  it('setContent replaces the document', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))) })
    const update = vi.fn()
    ed.on('update', update)
    ed.setContent(doc(el('paragraph', txt('x')), el('paragraph', txt('y'))))
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(el('paragraph', txt('x')), el('paragraph', txt('y')))))
    expect(ed.state.selection).toEqual(sel([0, 0], 0))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0].tr.meta).toMatchObject({ origin: 'load', addToHistory: false })
  })

  it('HTML is not available yet', () => {
    const ed = createTestEditor({ plugins: [testParagraph] })
    expect(() => ed.getHTML()).toThrow('HTML import/export is not available yet')
    expect(() => ed.setContent('<p>a</p>')).toThrow('HTML import/export is not available yet')
    expect(() => new Editor({ plugins: [testParagraph], content: '<p>a</p>' })).toThrow(
      'HTML import/export is not available yet',
    )
  })

  it('isActive checks the block at the selection start', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, testBold, heading],
      doc: doc(el('paragraph', txt('a')), el('heading', { level: 2 }, txt('b'))),
      selection: sel([1, 0], 1, [0, 0], 0),
    })
    expect(ed.isActive('paragraph')).toBe(true)
    expect(ed.isActive('heading')).toBe(false)
    ed.dispatch(ed.createTransaction().setSelection(sel([1, 0], 0)))
    expect(ed.isActive('heading')).toBe(true)
    expect(ed.isActive('heading', { level: 2 })).toBe(true)
    expect(ed.isActive('heading', { level: 3 })).toBe(false)
    expect(ed.isActive('bold')).toBe(false)
  })

  it('prepends core and history plugins (history optional)', () => {
    const ed = createTestEditor({ plugins: [testParagraph] })
    expect(ed.registry.plugins.map((p) => p.name)).toEqual(['paragraph', 'core', 'history'])
    const noHistory = createTestEditor({ plugins: [testParagraph], history: false })
    expect(noHistory.registry.plugins.map((p) => p.name)).toEqual(['paragraph', 'core'])
  })

  it('has no view yet; destroy stops events', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))) })
    expect(ed.view).toBeNull()
    expect(() => ed.mount({} as HTMLElement)).toThrow('View is not available yet')
    expect(() => ed.unmount()).toThrow('View is not available yet')
    const fn = vi.fn()
    ed.on('transaction', fn)
    ed.destroy()
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(fn).not.toHaveBeenCalled()
  })
})
