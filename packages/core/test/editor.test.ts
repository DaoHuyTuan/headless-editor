import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../src/plugin/define'
import { Editor } from '../src/editor'
import { Transaction } from '../src/transaction/transaction'
import type { Command } from '../src/plugin/types'
import type { Doc, ElementNode } from '../src/model/types'
import { nodeEntries } from '../src/model/node'
import type { EditorState } from '../src/state'
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

  it('getJSON returns a copy: mutating it does not change the editor', () => {
    const ed = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(el('paragraph', txt('ab', 'bold'))) })
    const state = ed.state
    const html = ed.getHTML()
    const snapshot = structuredClone(ed.state.doc)
    const json = ed.getJSON()
    expect(json).toEqual(snapshot)
    json.children[0]!.data.x = 1
    json.children[0]!.children!.push({ text: 'zz', marks: [] })
    ;(json.children[0]!.children![0] as { text: string; marks: unknown[] }).text = 'changed'
    ;(json.children[0]!.children![0] as { text: string; marks: unknown[] }).marks.length = 0
    json.children.push({ id: 'x', type: 'paragraph', data: {}, children: [] })
    expect(ed.state).toBe(state)
    expect(ed.state.doc).toEqual(snapshot)
    expect(ed.getHTML()).toBe(html)
  })

  it('falls back to the first editable text when the initial selection does not resolve to one', () => {
    const widget = { id: 'w', type: 'widget', data: {}, children: [txt('hidden')] } as ElementNode
    const content = doc(el('paragraph', txt('ab')))
    for (const selection of [sel([5, 0], 0), sel([0, 0], 9), sel([0], 0), sel([0, 0], 0, [3, 1], 0)]) {
      const ed = createTestEditor({ plugins: [testParagraph], doc: content, selection })
      expect(ed.state.selection).toEqual(sel([0, 0], 0))
    }
    const withWidget = createTestEditor({
      plugins: [testParagraph],
      doc: doc(widget, el('paragraph', txt('ab'))),
      selection: sel([0, 0], 1),
    })
    expect(withWidget.state.selection).toEqual(sel([1, 0], 0))
  })

  it('setContent places the caret at the first editable text, skipping unknown elements', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))) })
    ed.setContent({
      type: 'doc',
      children: [{ id: 'w', type: 'widget', data: {}, children: [txt('hidden')] }, el('paragraph', txt('cd'))],
    } as Doc)
    expect(ed.state.selection).toEqual(sel([1, 0], 0))
  })

  it('createTestEditor resets ids to a counter', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc() })
    expect(ed.getJSON().children[0]!.id).toBe('n1')
  })

  it('createTestEditor re-ids content deterministically; runtime ids never collide', () => {
    const allIds = (d: Doc): string[] => [...nodeEntries(d)].flatMap(([n]) => ('id' in n ? [n.id] : []))
    const first = createTestEditor({
      plugins: [testParagraph],
      doc: doc(el('paragraph', txt('a')), el('paragraph', txt('b'))),
    })
    expect(allIds(first.getJSON())).toEqual(['n1', 'n2'])
    const second = createTestEditor({
      plugins: [testParagraph],
      doc: doc(el('paragraph', txt('c')), el('paragraph', txt('d')), el('paragraph', txt('e'))),
    })
    expect(allIds(second.getJSON())).toEqual(['n1', 'n2', 'n3'])
    const tr = second.createTransaction()
    tr.insertNode([3], { type: 'paragraph', data: {}, children: [txt('f')] } as unknown as ElementNode)
    second.dispatch(tr)
    const ids = allIds(second.getJSON())
    expect(ids).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(new Set(ids).size).toBe(ids.length)
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

  it('a bound command whose tr filterTransaction vetoes returns false (it did not apply)', () => {
    const veto = definePlugin({ name: 'veto', filterTransaction: (tr) => !tr.ops.some((o) => o.type === 'insert_text') })
    const ed = createTestEditor({ plugins: [testParagraph, testBold, veto], doc: doc(el('paragraph', txt('ab'))), selection: sel([0, 0], 2) })
    expect(ed.commands.insertText('x')).toBe(false)
    expect(ed.state.doc.children[0]!.children).toEqual([txt('ab')])
    // A tr the filter lets through still reports true.
    expect(ed.commands.toggleMark('bold')).toBe(true)
  })

  describe('can() runs filterTransaction', () => {
    const vetoSetup = () => {
      const filter = vi.fn((tr: Transaction) => tr.meta.veto !== true)
      const vetoing = definePlugin({
        name: 'vetoing',
        filterTransaction: filter,
        commands: () => ({
          vetoedInsert:
            (): Command =>
            ({ tr }) => {
              tr.meta.veto = true
              tr.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: 'x' })
              return true
            },
          allowedInsert:
            (): Command =>
            ({ tr }) => {
              tr.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: 'y' })
              return true
            },
        }),
      })
      const ed = createTestEditor({ plugins: [testParagraph, counter, vetoing], doc: doc(el('paragraph', txt('ab'))) })
      const events = vi.fn()
      ed.on('update', events)
      ed.on('transaction', events)
      return { ed, filter, events }
    }

    it('can() answers false when a filterTransaction vetoes the command tr', () => {
      const { ed, filter, events } = vetoSetup()
      const before = ed.state
      expect(ed.can().vetoedInsert()).toBe(false)
      expect(ed.state).toBe(before)
      expect(ed.getPluginState('counter')).toBe(0)
      expect(events).not.toHaveBeenCalled()
      expect(filter).toHaveBeenCalledTimes(1)
      expect(filter.mock.calls[0]![0].meta.veto).toBe(true)
      // The command itself agrees.
      expect(ed.commands.vetoedInsert()).toBe(false)
    })

    it('can() still answers true for an allowed command', () => {
      const { ed, filter, events } = vetoSetup()
      const before = ed.state
      expect(ed.can().allowedInsert()).toBe(true)
      expect(ed.state).toBe(before)
      expect(events).not.toHaveBeenCalled()
      expect(filter).toHaveBeenCalledTimes(1)
      expect(ed.commands.allowedInsert()).toBe(true)
    })
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

  it('emits events only after the tr and all appended trs are committed, in order', () => {
    const append = definePlugin({
      name: 'append',
      appendTransaction: (trs, _old, newState) => {
        if (!trs.some((t) => t.meta.origin !== 'plugin')) return null
        const t = new Transaction(newState, trs[0]!.registry)
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '>' })
        return t
      },
    })
    const ed = createTestEditor({ plugins: [testParagraph, append], doc: doc(el('paragraph', txt('ab'))) })
    const log: [string, Transaction, string][] = []
    const text = () => (ed.state.doc.children[0]!.children![0] as { text: string }).text
    ed.on('transaction', ({ tr }) => log.push(['transaction', tr, text()]))
    ed.on('update', ({ tr }) => log.push(['update', tr, text()]))
    const tr1 = insertTextTr(ed, 'x')
    ed.dispatch(tr1)
    expect(log.map(([e]) => e)).toEqual(['transaction', 'update', 'transaction', 'update'])
    expect(log[0]![1]).toBe(tr1)
    expect(log[2]![1]).not.toBe(tr1)
    expect(log[2]![1].meta.origin).toBe('plugin')
    // Every listener call sees the final state.
    expect(log.every(([, , t]) => t === '>xab')).toBe(true)
  })

  it('allows dispatching from a listener as a nested dispatch', () => {
    const seen: { trs: Transaction[]; old: EditorState; next: EditorState }[] = []
    const spy = definePlugin({
      name: 'spy',
      appendTransaction: (trs, old, next) => {
        seen.push({ trs, old, next })
        return null
      },
    })
    const ed = createTestEditor({ plugins: [testParagraph, spy], doc: doc(el('paragraph', txt('ab'))) })
    let once = false
    ed.on('update', ({ editor }) => {
      if (once) return
      once = true
      const tr = editor.createTransaction()
      tr.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: 'y' })
      editor.dispatch(tr)
    })
    expect(() => ed.dispatch(insertTextTr(ed, 'x'))).not.toThrow()
    expect(ed.state.doc.children[0]!.children).toEqual([txt('yxab')])
    expect(seen).toHaveLength(2)
    for (const { trs, old, next } of seen) {
      expect(trs[0]!.before).toBe(old)
      expect(trs[trs.length - 1]!.doc).toBe(next.doc)
    }
    expect(seen[1]!.old).toBe(seen[0]!.next)
  })

  it('throws when dispatching while the pipeline is computing (dev)', () => {
    let editor: Editor | null = null
    const bad = definePlugin({
      name: 'bad',
      appendTransaction: (_trs, _old, next) => {
        const t = new Transaction(next, _trs[0]!.registry)
        t.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: '!' })
        editor!.dispatch(t)
        return null
      },
    })
    const ed = createTestEditor({ plugins: [testParagraph, bad], doc: doc(el('paragraph', txt('ab'))) })
    editor = ed
    expect(() => ed.dispatch(insertTextTr(ed, 'x'))).toThrow('Cannot dispatch during transaction processing')

    const prod = new Editor({ plugins: [testParagraph, bad], content: doc(el('paragraph', txt('ab'))) })
    editor = prod
    prod.dispatch(insertTextTr(prod, 'x'))
    expect(prod.state.doc.children[0]!.children).toEqual([txt('xab')])
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

  it('getHTML works without a DOM; HTML content needs one', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('a'))) })
    expect(ed.getHTML()).toBe('<p>a</p>')
    expect(() => ed.setContent('<p>a</p>')).toThrow('parseHTML requires a DOM (DOMParser)')
    expect(() => new Editor({ plugins: [testParagraph], content: '<p>a</p>' })).toThrow(
      'parseHTML requires a DOM (DOMParser)',
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

  it('has no view until mounted; destroy stops events', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))) })
    expect(ed.view).toBeNull()
    expect(() => ed.unmount()).not.toThrow()
    const fn = vi.fn()
    ed.on('transaction', fn)
    ed.destroy()
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(fn).not.toHaveBeenCalled()
  })

  it("ctx.commands runs the plugin's own command and dispatches it", () => {
    const mine = definePlugin({
      name: 'mine',
      commands: () => ({
        mine:
          (): Command =>
          ({ tr }) => {
            tr.apply({ type: 'insert_text', path: [0, 0], offset: 0, text: 'M' })
            return true
          },
      }),
      keymap: (ctx) => ({ 'Mod-m': () => ctx.commands.mine() }),
    })
    const ed = createTestEditor({ plugins: [testParagraph, mine], doc: doc(el('paragraph', txt('ab'))) })
    const fn = vi.fn()
    ed.on('transaction', fn)
    expect(ed.runKeymap('Ctrl-m')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(el('paragraph', txt('Mab')))))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0]![0].tr.meta.origin).toBe('command')
  })

  it("ctx.commands uses the plugin's own factory on a name clash; editor.commands uses the winner", () => {
    const calls: string[] = []
    const a = definePlugin({
      name: 'a',
      priority: 200,
      commands: () => ({ go: (): Command => () => (calls.push('a'), true) }),
    })
    const b = definePlugin({
      name: 'b',
      commands: () => ({ go: (): Command => () => (calls.push('b'), true) }),
      keymap: (ctx) => ({ 'Mod-g': () => ctx.commands.go() }),
    })
    const ed = createTestEditor({ plugins: [testParagraph, a, b], doc: doc(el('paragraph', txt('ab'))) })
    expect(ed.runKeymap('Ctrl-g')).toBe(true)
    expect(calls).toEqual(['b'])
    expect(ed.commands.go()).toBe(true)
    expect(calls).toEqual(['b', 'a'])
  })
})

describe('plugin options', () => {
  const mk = () =>
    createTestEditor({ plugins: [testParagraph, counter], doc: doc(el('paragraph', txt('ab'))), selection: sel([0, 0], 2) })

  it('getPluginOptions returns a frozen copy; mutating it does not change the stored options', () => {
    const ed = mk()
    const opts = ed.getPluginOptions<{ label: string }>('counter')
    expect(Object.isFrozen(opts)).toBe(true)
    expect(() => {
      ;(opts as { label: string }).label = 'z'
    }).toThrow()
    expect(ed.getPluginOptions<{ label: string }>('counter').label).toBe('x')
    expect(ed.getPluginOptions('counter')).not.toBe(opts)
  })

  it("emits 'options' with the plugin name on setPluginOptions", () => {
    const ed = mk()
    const fn = vi.fn()
    const off = ed.on('options', fn)
    ed.setPluginOptions('counter', { label: 'y' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ editor: ed, plugin: 'counter' })
    off()
    ed.setPluginOptions('counter', { label: 'z' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('plugin storage', () => {
  const stored = definePlugin({
    name: 'counter',
    node: { kind: 'block' },
    state: { init: () => 0, apply: (tr, n: number) => n + (tr.docChanged ? 1 : 0) },
    commands: () => ({
      typeX:
        (): Command =>
        ({ tr }) => {
          if (!tr.selection) return false
          tr.apply({ type: 'insert_text', path: tr.selection.anchor.path, offset: tr.selection.anchor.offset, text: 'x' })
          return true
        },
    }),
    storage: (ctx) => ({ count: () => ctx.getState(), typeX: () => ctx.commands.typeX() }),
  })

  it('editor.storage.counter.count() reads plugin state through ctx', () => {
    const ed = createTestEditor({ plugins: [testParagraph, stored], doc: doc(el('paragraph', txt('ab'))), selection: sel([0, 0], 1) })
    expect(ed.storage.counter.count()).toBe(0)
    expect(ed.storage.counter.typeX()).toBe(true)
    expect(ed.storage.counter.count()).toBe(1)
    expect(ed.getJSON().children[0]!.children![0]).toMatchObject({ text: 'axb' })
  })

  it('creates storage once per editor; plugins without storage are absent', () => {
    const factory = vi.fn(() => ({ n: 1 }))
    const once = definePlugin({ name: 'once', storage: factory })
    const a = createTestEditor({ plugins: [testParagraph, once] })
    const b = createTestEditor({ plugins: [testParagraph, once] })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(a.storage.once).not.toBe(b.storage.once)
    expect(a.storage.once).toBe(a.storage.once)
    expect('paragraph' in a.storage).toBe(false)
  })

  it('destroy hooks run on editor.destroy() in reverse priority order, once', () => {
    const calls: string[] = []
    const hi = definePlugin({ name: 'hi', priority: 200, destroy: (ctx) => void calls.push(ctx.name) })
    const lo = definePlugin({ name: 'lo', priority: 50, destroy: (ctx) => void calls.push(ctx.name) })
    const ed = createTestEditor({ plugins: [testParagraph, hi, lo] })
    ed.destroy()
    expect(calls).toEqual(['lo', 'hi'])
    ed.destroy()
    expect(calls).toEqual(['lo', 'hi'])
  })

  it('a destroy hook calling editor.destroy() again does not recurse; every hook runs once', () => {
    const calls: string[] = []
    const reentrant = definePlugin({
      name: 'reentrant',
      priority: 200,
      destroy: (ctx) => {
        calls.push(ctx.name)
        ctx.editor.destroy()
      },
    })
    const other = definePlugin({ name: 'other', priority: 50, destroy: (ctx) => void calls.push(ctx.name) })
    const first = definePlugin({ name: 'first', priority: 300, destroy: (ctx) => void calls.push(ctx.name) })
    const ed = createTestEditor({ plugins: [testParagraph, first, reentrant, other] })
    expect(() => ed.destroy()).not.toThrow()
    expect(calls).toEqual(['other', 'reentrant', 'first'])
    ed.destroy()
    expect(calls).toEqual(['other', 'reentrant', 'first'])
  })

  it('a throwing destroy hook does not stop the others; the first error is rethrown', () => {
    const calls: string[] = []
    const a = definePlugin({ name: 'a', priority: 300, destroy: () => void calls.push('a') })
    const b = definePlugin({
      name: 'b',
      priority: 200,
      destroy: () => {
        calls.push('b')
        throw new Error('b failed')
      },
    })
    const c = definePlugin({
      name: 'c',
      priority: 150,
      destroy: () => {
        calls.push('c')
        throw new Error('c failed')
      },
    })
    const ed = createTestEditor({ plugins: [testParagraph, a, b, c] })
    const fn = vi.fn()
    ed.on('transaction', fn)
    expect(() => ed.destroy()).toThrow('c failed')
    expect(calls).toEqual(['c', 'b', 'a'])
    ed.dispatch(insertTextTr(ed, 'x'))
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('keymap factory and storage', () => {
  it('sees ctx.storage eagerly', () => {
    let seen: unknown = 'unset'
    const plug = definePlugin({
      name: 'stor',
      storage: () => ({ n: 1 }),
      keymap: (ctx) => {
        seen = ctx.storage
        return {}
      },
    })
    createTestEditor({ plugins: [testParagraph, plug] })
    expect(seen).toEqual({ n: 1 })
  })
})
