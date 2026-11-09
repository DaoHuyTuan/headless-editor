import { describe, expect, it } from 'vitest'
import { definePlugin, textEntries, type DeepReadonly, type Doc } from '@hte/core'
import { createTestEditor, doc, el, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'

// Pins what docs/plugin-authoring.md ("Lifecycle hooks") says about nested dispatch and the order of
// hooks and editor events. (StrictMode mount counts are pinned in react.test.tsx.)

const text = (d: DeepReadonly<Doc>) => [...textEntries(d as Doc)].map(([n]) => n.text).join('')

describe('docs claims: lifecycle hooks', () => {
  it('per committed tr: transaction, update, onUpdate hooks, selectionUpdate, onSelectionUpdate hooks', () => {
    const log: string[] = []
    const hooks = definePlugin({
      name: 'hooks',
      onUpdate: () => void log.push('hook:onUpdate'),
      onSelectionUpdate: () => void log.push('hook:onSelectionUpdate'),
    })
    const editor = createTestEditor({ plugins: [paragraph, hooks], doc: doc(el('paragraph', txt('ab'))) })
    for (const event of ['transaction', 'update', 'selectionUpdate'] as const) {
      editor.on(event, () => void log.push(`event:${event}`))
    }
    editor.commands.insertText('x')
    expect(log).toEqual([
      'event:transaction',
      'event:update',
      'hook:onUpdate',
      'event:selectionUpdate',
      'hook:onSelectionUpdate',
    ])
  })

  it('a dispatch from onUpdate is nested: committed at once, so later hooks see the state past it (read e.tr)', () => {
    const seen: { state: string; tr: string }[] = []
    const first = definePlugin({
      name: 'first',
      priority: 200,
      onUpdate: (ctx, { tr }) => {
        if (tr.meta['nested']) return
        const next = ctx.editor.createTransaction().insertText('!')
        next.setMeta('nested', true)
        ctx.editor.dispatch(next)
        // Committed before dispatch returns.
        expect(text(ctx.editor.state.doc)).toContain('!')
      },
    })
    const later = definePlugin({
      name: 'later',
      priority: 100,
      onUpdate: (ctx, { tr }) => void seen.push({ state: text(ctx.editor.state.doc), tr: text(tr.doc) }),
    })
    const editor = createTestEditor({ plugins: [paragraph, first, later], doc: doc(el('paragraph', txt('ab'))) })
    editor.commands.insertText('x')
    // The nested tr's hooks run first (inside the outer hook), then the outer tr's later hook, which
    // sees the state already past the nested tr while its `tr` still describes the outer change.
    expect(seen).toEqual([
      { state: 'x!ab', tr: 'x!ab' },
      { state: 'x!ab', tr: 'xab' },
    ])
  })
})
