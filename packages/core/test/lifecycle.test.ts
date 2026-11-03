import { describe, expect, it } from 'vitest'
import { mainRange } from '../src/model/selection'
import { definePlugin, type PluginContext, type Transaction } from '../src/index'
import { createTestEditor, doc, el, sel, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const content = () => doc(el('paragraph', txt('abcd')))

describe('lifecycle hooks: onCreate', () => {
  it('runs once per plugin at the end of construction, by priority, after storage exists', () => {
    const calls: string[] = []
    let seenStorage: unknown
    let seenCtx: PluginContext<{ n: number }, undefined> | null = null
    const a = definePlugin({
      name: 'a',
      priority: 50,
      options: { n: 1 },
      storage: () => ({ ready: true }),
      onCreate: (ctx) => {
        calls.push('a')
        seenCtx = ctx
        seenStorage = (ctx.editor.storage as Record<string, unknown>)['b']
      },
    })
    const b = definePlugin({
      name: 'b',
      priority: 200,
      storage: () => ({ fromB: 1 }),
      onCreate: (ctx) => {
        calls.push(`b:${ctx.name}`)
      },
    })
    const editor = createTestEditor({ plugins: [testParagraph, a, b], doc: content() })
    expect(calls).toEqual(['b:b', 'a'])
    expect(seenStorage).toEqual({ fromB: 1 })
    expect(seenCtx!.editor).toBe(editor)
    expect(seenCtx!.options).toEqual({ n: 1 })
    // Same cached context as the other hooks.
    let keymapCtx: unknown
    const c = definePlugin({
      name: 'c',
      keymap: (ctx) => {
        keymapCtx = ctx
        return {}
      },
      onCreate: (ctx) => {
        expect(ctx).toBe(keymapCtx)
        calls.push('c')
      },
    })
    createTestEditor({ plugins: [testParagraph, c], doc: content() })
    expect(calls).toContain('c')
  })

  it('a throwing onCreate does not stop the others; the first error is rethrown', () => {
    const calls: string[] = []
    const first = new Error('first')
    const p1 = definePlugin({
      name: 'p1',
      priority: 300,
      onCreate: () => {
        calls.push('p1')
        throw first
      },
    })
    const p2 = definePlugin({
      name: 'p2',
      priority: 200,
      onCreate: () => {
        calls.push('p2')
        throw new Error('second')
      },
    })
    const p3 = definePlugin({ name: 'p3', priority: 100, onCreate: () => void calls.push('p3') })
    expect(() => createTestEditor({ plugins: [testParagraph, p3, p2, p1], doc: content() })).toThrow(first)
    expect(calls).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('lifecycle hooks: onUpdate / onSelectionUpdate', () => {
  function setup() {
    const log: string[] = []
    const trs: Transaction[] = []
    const make = (name: string, priority: number) =>
      definePlugin({
        name,
        priority,
        onUpdate: (ctx, { tr }) => {
          log.push(`${ctx.name}:update`)
          trs.push(tr)
        },
        onSelectionUpdate: (ctx, { tr }) => {
          log.push(`${ctx.name}:selection`)
          trs.push(tr)
        },
      })
    const editor = createTestEditor({
      plugins: [testParagraph, testBold, make('low', 10), make('high', 500)],
      doc: content(),
      selection: sel([0, 0], 1),
    })
    editor.on('transaction', () => log.push('on:transaction'))
    editor.on('update', () => log.push('on:update'))
    editor.on('selectionUpdate', () => log.push('on:selectionUpdate'))
    return { editor, log, trs }
  }

  it('run by priority right after the matching editor event, listeners first', () => {
    const { editor, log, trs } = setup()
    const tr = editor.createTransaction().insertText('x', mainRange(sel([0, 0], 1)))
    editor.dispatch(tr)
    expect(log).toEqual([
      'on:transaction',
      'on:update',
      'high:update',
      'low:update',
      'on:selectionUpdate',
      'high:selection',
      'low:selection',
    ])
    expect(trs.every((t) => t === tr)).toBe(true)
  })

  it('a selection-only tr calls onSelectionUpdate only', () => {
    const { editor, log } = setup()
    editor.dispatch(editor.createTransaction().setSelection(sel([0, 0], 3)))
    expect(log).toEqual(['on:transaction', 'on:selectionUpdate', 'high:selection', 'low:selection'])
  })

  it('a tr that changes neither calls no hook', () => {
    const { editor, log } = setup()
    editor.dispatch(editor.createTransaction())
    expect(log).toEqual(['on:transaction'])
  })

  it('a hook may dispatch a follow-up tr (nested dispatch); a guard stops the recursion', () => {
    let calls = 0
    const follow = definePlugin({
      name: 'follow',
      onUpdate: (ctx, { tr }) => {
        calls++
        if (tr.meta.followUp) return
        const next = ctx.editor.createTransaction().insertText('!', mainRange(sel([0, 0], 0)))
        next.setMeta('followUp', true)
        ctx.editor.dispatch(next)
      },
    })
    const editor = createTestEditor({ plugins: [testParagraph, follow], doc: content(), selection: sel([0, 0], 4) })
    editor.commands.insertText('x')
    expect(calls).toBe(2)
    expect(editor.getHTML()).toBe('<p>!abcdx</p>')
  })

  it('a throwing hook does not stop the others or later trs; the first error is rethrown', () => {
    const calls: string[] = []
    const boom = new Error('boom')
    const thrower = definePlugin({
      name: 'thrower',
      priority: 500,
      onUpdate: () => {
        calls.push('thrower:update')
        throw boom
      },
      onSelectionUpdate: () => {
        calls.push('thrower:selection')
        throw new Error('later')
      },
    })
    const other = definePlugin({
      name: 'other',
      priority: 10,
      onUpdate: () => void calls.push('other:update'),
      onSelectionUpdate: () => void calls.push('other:selection'),
    })
    const editor = createTestEditor({
      plugins: [testParagraph, other, thrower],
      doc: content(),
      selection: sel([0, 0], 1),
    })
    expect(() => editor.dispatch(editor.createTransaction().insertText('x', mainRange(sel([0, 0], 1))))).toThrow(boom)
    expect(calls).toEqual(['thrower:update', 'other:update', 'thrower:selection', 'other:selection'])
    expect(editor.getHTML()).toBe('<p>axbcd</p>')
  })

  it('no hook runs once the editor is destroyed by an earlier hook', () => {
    const calls: string[] = []
    const destroyer = definePlugin({
      name: 'destroyer',
      priority: 500,
      onUpdate: (ctx) => {
        calls.push('destroyer')
        ctx.editor.destroy()
      },
    })
    const after = definePlugin({ name: 'after', priority: 10, onUpdate: () => void calls.push('after') })
    const editor = createTestEditor({ plugins: [testParagraph, after, destroyer], doc: content(), selection: sel([0, 0], 1) })
    editor.commands.insertText('x')
    expect(calls).toEqual(['destroyer'])
  })
})
