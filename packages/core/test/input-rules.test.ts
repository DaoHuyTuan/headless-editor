// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type { InputRule } from '../src/index'
import type { Doc, ElementNode, Node, Selection, TextNode } from '../src/model/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
const c = (): ElementNode => ({ id: 'c', type: 'chip', data: {}, children: [] })

const emDash: InputRule = {
  match: /^-- $/,
  handler: (_ctx, _match, range, tr) => {
    tr.insertText('— ', range)
    return true
  },
}

function setup(content: Doc = doc(p('')), selection: Selection = sel([0, 0], 0), rules: InputRule[] = [emDash]) {
  const dashes = definePlugin({ name: 'dashes', inputRules: rules })
  const ed = createTestEditor({ plugins: [testParagraph, testBold, chip, dashes], doc: content, selection })
  const type = (s: string) => {
    for (const ch of s) ed.handleIntent({ inputType: 'insertText', data: ch, range: null })
  }
  const text = () => stripIds(ed.getJSON())
  return { ed, type, text }
}

/** The first block's texts, joined. */
const ed2text = (json: unknown): string =>
  ((json as Doc).children[0]!.children ?? []).map((n) => ('text' in n ? n.text : '')).join('')

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('input rules', () => {
  it('replaces "-- " with an em dash; one undo restores the typed "-- "', () => {
    const { ed, type, text } = setup()
    type('-- ')
    expect(text()).toEqual(stripIds(doc(p('— '))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p('-- '))))
    expect(ed.state.selection).toEqual(sel([0, 0], 3))
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p(''))))
    ed.commands.redo()
    ed.commands.redo()
    expect(text()).toEqual(stripIds(doc(p('— '))))
  })

  it('matches against the block text from its start to the caret only', () => {
    const { type, text } = setup(doc(p('a')), sel([0, 0], 1))
    type('-- ')
    expect(text()).toEqual(stripIds(doc(p('a-- '))))
  })

  it('spans texts with different marks but stops at an inline atom', () => {
    const rule: InputRule = {
      match: /(\w+)!$/,
      handler: (_ctx, match, range, tr) => {
        tr.insertText(match[1]!.toUpperCase(), range)
        return true
      },
    }
    const { type, text } = setup(doc(p(txt('a', 'bold'), 'b')), sel([0, 1], 1), [rule])
    type('!')
    const block = ed2text(text())
    expect(block).toBe('AB')
    const atom = setup(doc(p('ab', c(), 'cd')), sel([0, 2], 2), [{ match: /^(\w+)!$/, handler: rule.handler }])
    atom.type('!')
    expect(atom.text()).toEqual(stripIds(doc(p('ab', c(), 'CD'))))
  })

  it('runs plugins by priority and stops at the first handler returning true', () => {
    const calls: string[] = []
    const mk = (name: string, priority: number, result: boolean) =>
      definePlugin({
        name,
        priority,
        inputRules: [
          {
            match: /x$/,
            handler: (ctx, _m, range, tr) => {
              calls.push(ctx.name)
              if (result) tr.insertText(name, range)
              return result
            },
          },
        ],
      })
    const ed = createTestEditor({
      plugins: [testParagraph, mk('low', 50, true), mk('high', 200, false), mk('mid', 100, true)],
      doc: doc(p('')),
      selection: sel([0, 0], 0),
    })
    ed.handleIntent({ inputType: 'insertText', data: 'x', range: null })
    expect(calls).toEqual(['high', 'mid'])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('mid'))))
  })

  it('a rule that does not fire keeps the typing grouped in one undo step', () => {
    const { ed, type, text } = setup()
    type('ab- c')
    ed.commands.undo()
    expect(text()).toEqual(stripIds(doc(p(''))))
  })

  it('records the rule as its own history entry of kind "other"', () => {
    const { ed, type } = setup()
    type('-- ')
    const { undo } = ed.getPluginState<{ undo: { kind: string }[] }>('history')
    expect(undo.map((e) => e.kind)).toEqual(['insert', 'other'])
  })

  it('does not fire on paste', () => {
    const { ed, text } = setup()
    const dt = { getData: (t: string) => (t === 'text/plain' ? '-- ' : '') } as unknown as DataTransfer
    ed.handleIntent({ inputType: 'insertFromPaste', data: null, range: null, dataTransfer: dt })
    expect(text()).toEqual(stripIds(doc(p('-- '))))
  })

  it('does not fire during composition', async () => {
    const { ed, type, text } = setup()
    type('--')
    const root = document.createElement('div')
    document.body.appendChild(root)
    ed.mount(root)
    ed.view!.focus()
    ed.view!.syncSelection()
    root.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    const leaf = ed.view!.renderer.leafAt([0, 0])!
    const node = leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text
    node.data = '-- '
    await new Promise<void>((r) => setTimeout(r, 0))
    root.dispatchEvent(new Event('compositionend', { bubbles: true }))
    expect((ed.state.doc.children[0]!.children![0] as TextNode).text).toBe('-- ')
    expect(text()).toEqual(stripIds(doc(p('-- '))))
  })

  it('a handler returning false leaves no change', () => {
    const { type, text } = setup(doc(p('')), sel([0, 0], 0), [
      {
        match: /a$/,
        handler: (_ctx, _m, range, tr) => {
          tr.insertText('zzz', range)
          return false
        },
      },
    ])
    type('a')
    expect(text()).toEqual(stripIds(doc(p('a'))))
  })
})
