import { describe, expect, it } from 'vitest'
import { mainRange } from '../src/model/selection'
import { definePlugin, type EditorEvent, type OptionsEvent } from '../src/index'
import { createTestEditor, doc, el, sel, txt } from '../src/testing/index'
import { testParagraph } from './fixtures'

const content = () => doc(el('paragraph', txt('abcd')))

describe('EditorOptions.listeners', () => {
  it('are registered before onCreate runs, so they see its dispatches', () => {
    const seen: string[] = []
    let updateEvent: EditorEvent | null = null
    const inserter = definePlugin({
      name: 'inserter',
      options: { n: 0 },
      onCreate: (ctx) => {
        ctx.editor.setPluginOptions('inserter', { n: 1 })
        ctx.editor.dispatch(ctx.editor.createTransaction().insertText('X', mainRange(sel([0, 0], 4))))
      },
    })
    const editor = createTestEditor({
      plugins: [testParagraph, inserter],
      doc: content(),
      listeners: {
        transaction: () => void seen.push('transaction'),
        update: (e) => {
          seen.push('update')
          updateEvent = e
        },
        options: (e: OptionsEvent) => void seen.push(`options:${e.plugin}`),
      },
    })
    expect(seen).toEqual(['options:inserter', 'transaction', 'update'])
    expect(updateEvent!.editor).toBe(editor)
    expect(JSON.stringify(editor.state.doc)).toContain('abcdX')
  })

  it('behave like `on` listeners afterwards (once per dispatch, after `on` listeners added earlier)', () => {
    const seen: string[] = []
    const editor = createTestEditor({
      plugins: [testParagraph],
      doc: content(),
      listeners: { update: () => void seen.push('option') },
    })
    editor.on('update', () => void seen.push('on'))
    editor.commands.insertText('y')
    expect(seen).toEqual(['option', 'on'])
  })
})
