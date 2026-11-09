// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import { createSelection } from '../src/model/selection'
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

describe('input rules with several carets', () => {
  const pt = (path: number[], offset: number) => ({ path, offset })
  const at = (path: number[], offset: number) => ({ anchor: pt(path, offset), focus: pt(path, offset) })
  const smiley: InputRule = {
    match: /:\)$/,
    handler: (_ctx, _m, range, tr) => {
      tr.insertText('☺', range)
      return true
    },
  }
  /** Typing as the view sends it: the intent range is the main range. */
  const typeAt = (ed: ReturnType<typeof setup>['ed'], s: string) => {
    for (const ch of s) {
      const sl = ed.state.selection!
      ed.handleIntent({ inputType: 'insertText', data: ch, range: sl.ranges[sl.main]! })
    }
  }
  const blockTexts = (ed: ReturnType<typeof setup>['ed']) =>
    ed.state.doc.children.map((b) => (b.children ?? []).map((n) => ('text' in n ? n.text : `<${n.type}>`)).join(''))

  it('input rule fires at both carets in one rule step; one undo reverts both rules, keeps typed text', () => {
    const { ed } = setup(doc(p(''), p('')), createSelection([at([0, 0], 0), at([1, 0], 0)]))
    const kinds: unknown[] = []
    ed.on('transaction', ({ tr }) => kinds.push(tr.meta.inputRule === true ? 'rule' : tr.meta.inputType))
    typeAt(ed, '-- ')
    expect(blockTexts(ed)).toEqual(['— ', '— '])
    expect(kinds).toEqual(['insertText', 'insertText', 'insertText', 'rule'])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 2), at([1, 0], 2)]))
    ed.commands.undo()
    expect(blockTexts(ed)).toEqual(['-- ', '-- '])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 3), at([1, 0], 3)]))
    ed.commands.undo()
    expect(blockTexts(ed)).toEqual(['', ''])
  })

  it('input rule fires at one caret only; the other caret is untouched', () => {
    const { ed } = setup(doc(p(''), p('x')), createSelection([at([0, 0], 0), at([1, 0], 1)]))
    typeAt(ed, '-- ')
    expect(blockTexts(ed)).toEqual(['— ', 'x-- '])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 2), at([1, 0], 4)]))
    ed.commands.undo()
    expect(blockTexts(ed)).toEqual(['-- ', 'x-- '])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 3), at([1, 0], 4)]))
    ed.commands.undo()
    expect(blockTexts(ed)).toEqual(['', 'x'])
  })

  it('carets in one text: each handler gets its range mapped through the earlier firings', () => {
    const ranges: unknown[] = []
    const spy: InputRule = {
      match: smiley.match,
      handler: (ctx, m, range, tr) => (ranges.push(range), smiley.handler(ctx, m, range, tr)),
    }
    const { ed } = setup(doc(p('a b')), createSelection([at([0, 0], 1), at([0, 0], 3)]), [spy])
    typeAt(ed, ':)')
    expect(blockTexts(ed)).toEqual(['a☺ b☺'])
    expect(ranges).toEqual([
      { start: pt([0, 0], 1), end: pt([0, 0], 3) },
      { start: pt([0, 0], 4), end: pt([0, 0], 6) },
    ])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 2), at([0, 0], 5)]))
    ed.commands.undo()
    expect(blockTexts(ed)).toEqual(['a:) b:)'])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 3), at([0, 0], 7)]))
    ed.commands.undo()
    expect(blockTexts(ed)).toEqual(['a b'])
  })

  it('at each caret the first matching rule wins', () => {
    const calls: string[] = []
    const mk = (name: string, result: boolean): InputRule => ({
      match: /x$/,
      handler: (_ctx, _m, range, tr) => {
        calls.push(name)
        if (result) tr.insertText(name, range)
        else tr.insertText('NO', range)
        return result
      },
    })
    const { ed } = setup(doc(p(''), p('')), createSelection([at([0, 0], 0), at([1, 0], 0)]), [mk('a', false), mk('b', true), mk('c', true)])
    typeAt(ed, 'x')
    expect(calls).toEqual(['a', 'b', 'a', 'b'])
    expect(blockTexts(ed)).toEqual(['b', 'b'])
  })

  it('a setSelection in a rule handler throws in dev with several ranges', () => {
    const bad: InputRule = {
      match: /!$/,
      handler: (_ctx, _m, range, tr) => (tr.setSelection(sel(range.start.path, 0)), true),
    }
    const { ed } = setup(doc(p('a!'), p('b!')), createSelection([at([0, 0], 2), at([1, 0], 2)]), [bad])
    expect(() => ed.runInputRules()).toThrow(/selection/)
    const one = setup(doc(p('a!')), sel([0, 0], 2), [bad])
    expect(one.ed.runInputRules()).toBe(true)
  })

  it('a two-delimiter bold rule at two carets: each caret stays in its own block', () => {
    const boldRule: InputRule = {
      match: /\*\*([^*]+)\*\*$/,
      handler: (_ctx, m, range, tr) => {
        tr.deleteRange({ start: { ...range.end, offset: range.end.offset - 2 }, end: range.end })
        tr.deleteRange({ start: range.start, end: { ...range.start, offset: range.start.offset + 2 } })
        tr.addMark({ type: 'bold', data: {} }, { start: range.start, end: { ...range.start, offset: range.start.offset + m[1]!.length } })
        return true
      },
    }
    const { ed } = setup(doc(p('a'), p('b')), createSelection([at([0, 0], 1), at([1, 0], 1)]), [boldRule])
    typeAt(ed, '**x**')
    expect(blockTexts(ed)).toEqual(['ax', 'bx'])
    const ranges = ed.state.selection!.ranges
    expect(ranges).toHaveLength(2)
    expect(ranges.map((r) => r.focus.path[0])).toEqual([0, 1])
    expect(ed.state.doc.children.map((b) => b.children)).toEqual([
      [txt('a'), txt('x', 'bold')],
      [txt('b'), txt('x', 'bold')],
    ])
  })

  it('a no-range edit in a handler acts only at its own caret', () => {
    const rule: InputRule = {
      match: /-- $/,
      handler: (_ctx, _m, range, tr) => (tr.deleteRange(range), tr.insertText('— '), true),
    }
    const { ed } = setup(doc(p(''), p('')), createSelection([at([0, 0], 0), at([1, 0], 0)]), [rule])
    typeAt(ed, '-- ')
    expect(blockTexts(ed)).toEqual(['— ', '— '])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 2), at([1, 0], 2)]))
  })

  it('forEachRange in a handler sees only its own caret', () => {
    const rule: InputRule = {
      match: /!$/,
      handler: (_ctx, _m, _range, tr) => (tr.forEachRange((r, t) => void t.insertText('?', r)), true),
    }
    const { ed } = setup(doc(p('a!'), p('b!')), createSelection([at([0, 0], 2), at([1, 0], 2)]), [rule])
    expect(ed.runInputRules()).toBe(true)
    expect(blockTexts(ed)).toEqual(['a!?', 'b!?'])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 3), at([1, 0], 3)]))
  })

  it('an earlier caret at a later match start stays before the replacement', () => {
    const dash: InputRule = {
      match: /--$/,
      handler: (_ctx, _m, range, tr) => {
        tr.insertText('—', range)
        return true
      },
    }
    const { ed } = setup(doc(p('a-')), createSelection([at([0, 0], 1), at([0, 0], 2)]), [dash])
    typeAt(ed, '-')
    expect(blockTexts(ed)).toEqual(['a-—'])
    expect(ed.state.selection).toEqual(createSelection([at([0, 0], 2), at([0, 0], 3)]))
  })
})

describe('input rules: the match ends at the caret', () => {
  it('a rule without $ matches the occurrence ending at the caret, not the leftmost one', () => {
    const plain: InputRule = {
      match: /-- /,
      handler: (_ctx, _match, range, tr) => {
        tr.insertText('— ', range)
        return true
      },
    }
    const { type, text } = setup(doc(p('x-- a')), sel([0, 0], 5), [plain])
    type('-- ')
    expect(text()).toEqual(stripIds(doc(p('x-- a— '))))
  })

  it('the handler gets the match with its index and groups', () => {
    const seen: (string | number | undefined)[] = []
    const rule: InputRule = {
      match: /\*(\w+)\*/,
      handler: (_ctx, match) => {
        seen.push(match.index, match[0], match[1])
        return false
      },
    }
    const { type } = setup(doc(p('*a* b ')), sel([0, 0], 6), [rule])
    type('*cd*')
    expect(seen).toEqual([6, '*cd*', 'cd'])
  })
})
