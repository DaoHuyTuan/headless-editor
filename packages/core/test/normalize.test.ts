import { describe, expect, it } from 'vitest'
import { mainRange } from '../src/model/selection'
import { normalize } from '../src/normalize'
import { definePlugin } from '../src/plugin/define'
import { Registry } from '../src/plugin/registry'
import type { AnyPlugin, PluginContext } from '../src/plugin/types'
import type { Doc, ElementNode, Node, Selection } from '../src/model/types'
import { applyOp } from '../src/ops/apply'
import { invertOp } from '../src/ops/invert'
import type { Editor } from '../src/editor'
import { Transaction } from '../src/transaction/transaction'
import { doc, el, sel, stripIds, txt } from '../src/testing/builders'
import { createTestEditor } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const testItalic = definePlugin({ name: 'italic', mark: { render: () => ({ tag: 'em' }) } })
const testLink = definePlugin({ name: 'link', node: { kind: 'inline' } })
const testHr = definePlugin({ name: 'hr', node: { kind: 'block', atom: true } })
const testCode = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })
const base: AnyPlugin[] = [testParagraph, testBold, testItalic, testLink, testHr, testCode]

const ctx = (plugin: AnyPlugin): PluginContext<any, any> => ({
  editor: {} as Editor,
  name: plugin.name,
  options: plugin.spec.options ?? {},
  getState: () => undefined,
  storage: undefined,
  commands: {},
})

function run(d: Doc, plugins: AnyPlugin[] = base, selection: Selection | null = null): Transaction {
  const tr = new Transaction({ doc: d, selection, storedMarks: null, pluginStates: new Map() }, new Registry(plugins))
  normalize(tr, ctx)
  return tr
}

const normalized = (d: Doc, plugins?: AnyPlugin[]) => stripIds(run(d, plugins).doc)
/** Builds a doc whose root holds arbitrary nodes (texts/inlines), which the Doc type does not allow. */
const rawDoc = (...children: Node[]): Doc => ({ type: 'doc', children: children as ElementNode[] })

describe('normalize: core rules', () => {
  it('rule 1: an empty doc gets an empty default block', () => {
    expect(normalized(doc())).toEqual(stripIds(doc(el('paragraph', txt('')))))
  })

  it('rule 2: consecutive root texts/inlines are wrapped into one default block', () => {
    const d = rawDoc(txt('a'), el('link', txt('l')), el('paragraph', txt('p')), txt('b'))
    expect(normalized(d)).toEqual(
      stripIds(doc(el('paragraph', txt('a'), el('link', txt('l')), txt('')), el('paragraph', txt('p')), el('paragraph', txt('b')))),
    )
  })

  it('rule 3: adjacent texts with the same mark set are merged', () => {
    const d = doc(el('paragraph', txt('a', 'bold'), txt('b', 'bold'), txt('c'), txt('d')))
    const tr = run(d)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('paragraph', txt('ab', 'bold'), txt('cd')))))
    expect(tr.ops[0]).toEqual({
      type: 'merge_node',
      path: [0, 1],
      position: 1,
      properties: { marks: [{ type: 'bold', data: {} }] },
    })
  })

  it('rule 4: empty texts are removed when the block has other children', () => {
    const d = doc(el('paragraph', txt('', 'bold'), txt('a'), txt('', 'italic')))
    expect(normalized(d)).toEqual(stripIds(doc(el('paragraph', txt('a')))))
    // ...but kept when it is the only child
    expect(normalized(doc(el('paragraph', txt(''))))).toEqual(stripIds(doc(el('paragraph', txt('')))))
  })

  it('rule 4 keeps a caret in the removed empty text (i > 0): it moves to the end of the previous text', () => {
    // e.g. after deleting every character of the bold run in `a**b**`
    const tr = run(doc(el('paragraph', txt('a'), txt('', 'bold'))), base, sel([0, 1], 0))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('paragraph', txt('a')))))
    expect(tr.selection).toEqual(sel([0, 0], 1))
    expect(tr.ops).toEqual([
      { type: 'merge_node', path: [0, 1], position: 1, properties: { marks: [{ type: 'bold', data: {} }] } },
    ])
  })

  it('rule 4 keeps a caret in the removed empty text (i === 0): it moves to the start of the next text', () => {
    const tr = run(doc(el('paragraph', txt('', 'bold'), txt('b'))), base, sel([0, 0], 0, [0, 1], 1))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('paragraph', txt('b')))))
    expect(tr.selection).toEqual(sel([0, 0], 0, [0, 0], 1))
  })

  it('rule 4 keeps the empty texts rule 10 needs beside an inline element, with the caret in them', () => {
    const d = doc(el('paragraph', txt('', 'bold'), el('link', txt('ab')), txt('', 'bold')))
    const tr = run(d, base, sel([0, 2], 0))
    expect(tr.ops).toEqual([])
    expect(tr.selection).toEqual(sel([0, 2], 0))
  })

  it('rule 4 keeps the empty text beside an unknown element in inline content (rule 10), and the caret in it', () => {
    // An unknown type in inline content is one opaque character there, like an inline atom: the
    // empty text on its far side is where a caret sits after (or before) it.
    const widget: ElementNode = { id: 'w', type: 'widget', data: {}, children: [txt('hidden')] }
    const after = run(doc(el('paragraph', txt('a'), widget, txt('', 'bold'))), base, sel([0, 2], 0))
    expect(stripIds(after.doc)).toEqual(stripIds(doc(el('paragraph', txt('a'), widget, txt('', 'bold')))))
    expect(after.selection).toEqual(sel([0, 2], 0))
    const before = run(doc(el('paragraph', txt('', 'bold'), widget, txt('b'))), base, sel([0, 0], 0))
    expect(before.selection).toEqual(sel([0, 0], 0))
  })

  it('rule 4 re-homes a caret in a dropped empty text to the nearest editable text', () => {
    const d = doc(el('paragraph', txt('', 'bold'), txt('b')))
    const out = run(d, base, sel([0, 0], 0))
    expect(stripIds(out.doc)).toEqual(stripIds(doc(el('paragraph', txt('b')))))
    expect(out.selection).toEqual(sel([0, 0], 0))
  })

  it('rule 5:a non-atom block with no children gets an empty text; atoms are left alone', () => {
    const hr: ElementNode = { id: 'h', type: 'hr', data: {} }
    const d = doc({ id: 'p', type: 'paragraph', data: {} }, el('paragraph'), hr)
    expect(normalized(d)).toEqual(stripIds(doc(el('paragraph', txt('')), el('paragraph', txt('')), hr)))
  })

  it('rule 6: marks are sorted by registry.markRank (unknown marks last)', () => {
    const d = doc(el('paragraph', txt('a', 'mystery', 'italic', 'bold')))
    const tr = run(d)
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('paragraph', txt('a', 'bold', 'italic', 'mystery')))))
    expect(tr.ops.every((op) => op.type === 'remove_mark' || op.type === 'add_mark')).toBe(true)
  })

  it('rule 7: unknown types are left untouched, including their children', () => {
    const widget: ElementNode = {
      id: 'w',
      type: 'widget',
      data: { x: 1 },
      children: [txt('a', 'italic', 'bold'), txt('b', 'italic', 'bold'), txt(''), { id: 'q', type: 'paragraph', data: {} }],
    }
    const d = doc(el('paragraph', txt('x')), widget)
    const tr = run(d)
    expect(tr.ops).toEqual([])
    expect(tr.doc).toBe(d)
  })

  it('rule 8: a content:"text" block drops marks and unwraps inline elements', () => {
    const d = doc(el('code', txt('a', 'bold'), el('link', txt('b', 'italic')), txt('c')))
    expect(normalized(d)).toEqual(stripIds(doc(el('code', txt('abc')))))
  })

  it('rule 8: an inline atom in a content:"text" block becomes its renderText text (dropped without one)', () => {
    const tag = definePlugin({
      name: 'tag',
      node: { kind: 'inline', atom: true },
      options: { prefix: '#' },
      renderText: (node, { options }) => `${options.prefix}${String(node.data.label)}`,
    })
    const bare = definePlugin({ name: 'bare', node: { kind: 'inline', atom: true } })
    const atom = (type: string): ElementNode => ({ id: type, type, data: { label: 'x' }, children: [] })
    const d = doc(el('code', txt('a'), atom('tag'), txt('b'), atom('bare'), txt('c')))
    // The caret right after `b` stays right after it.
    const tr = run(d, [...base, tag, bare], sel([0, 2], 1))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('code', txt('a#xbc')))))
    expect(tr.selection).toEqual(sel([0, 0], 4))
    expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc)).toEqual(d)
  })

  it('rule 9: blocks nested in an inline-content block are unwrapped, recursively; ops invert back', () => {
    const d = doc(
      el('paragraph', txt('a'), el('paragraph', txt('b', 'bold'), el('paragraph', txt('c'), el('paragraph', txt('d')))), txt('e')),
    )
    const tr = run(d, base, sel([0, 1, 1, 1, 0], 1))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('paragraph', txt('a'), txt('b', 'bold'), txt('cde')))))
    expect(tr.selection).toEqual(sel([0, 2], 2))
    expect(tr.ops.reduce(applyOp, d)).toEqual(tr.doc)
    expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc)).toEqual(d)
    expect(run(tr.doc).ops).toEqual([])
  })

  it('rule 9 also unwraps blocks inside content:"text" blocks; unknown types stay (rule 7)', () => {
    expect(normalized(doc(el('code', txt('a'), el('paragraph', txt('b', 'bold')))))).toEqual(stripIds(doc(el('code', txt('ab')))))
    const widget: ElementNode = { id: 'w', type: 'widget', data: {}, children: [el('paragraph', txt('x'))] }
    const d = doc(el('paragraph', txt('a'), widget))
    // Its subtree is not touched; rule 10 only gives it a text on its far side.
    const out = run(d).doc
    expect(out.children[0]!.children![1]).toBe(widget)
    expect(stripIds(out)).toEqual(stripIds(doc(el('paragraph', txt('a'), widget, txt('')))))
  })

  describe('rule 9 hoists a nested atom block instead of unwrapping it', () => {
    const atomBlock = definePlugin({ name: 'atomBlock', node: { kind: 'block', atom: true } })
    const plugins = [...base, atomBlock]
    const atom = () => el('atomBlock', { src: 'x.png' }, txt('alt'))

    it.each([
      [
        'in the middle (the block is split around it)',
        () => doc(el('paragraph', txt('a'), atom(), txt('b'))),
        sel([0, 2], 1),
        () => doc(el('paragraph', txt('a')), atom(), el('paragraph', txt('b'))),
        sel([2, 0], 1),
      ],
      [
        'at the start (moved before the block)',
        () => doc(el('paragraph', atom(), txt('ab'))),
        sel([0, 1], 1),
        () => doc(atom(), el('paragraph', txt('ab'))),
        sel([1, 0], 1),
      ],
      [
        'at the end (moved after the block)',
        () => doc(el('paragraph', txt('ab'), atom())),
        sel([0, 0], 1),
        () => doc(el('paragraph', txt('ab')), atom()),
        sel([0, 0], 1),
      ],
      [
        'inside a nested block (unwrapped first)',
        () => doc(el('paragraph', txt('a'), el('paragraph', txt('b'), atom(), txt('c')), txt('d'))),
        sel([0, 1, 2], 1),
        () => doc(el('paragraph', txt('ab')), atom(), el('paragraph', txt('cd'))),
        sel([2, 0], 1),
      ],
    ])('%s', (_, input, selection, expected, expectedSel) => {
      const d = input()
      const tr = run(d, plugins, selection)
      expect(stripIds(tr.doc)).toEqual(stripIds(expected()))
      expect(tr.selection).toEqual(expectedSel)
      expect(tr.ops.reduce(applyOp, d)).toEqual(tr.doc)
      expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc)).toEqual(d)
      expect(run(tr.doc, plugins).ops).toEqual([])
    })

    it('keeps the atom node itself (same id and data)', () => {
      const image = atom()
      const tr = run(doc(el('paragraph', txt('a'), image, txt('b'))), plugins)
      expect(tr.doc.children[1]).toEqual(image)
    })
  })

  it('emits every change as ops: replaying them reproduces the result and inverting restores the input', () => {
    const d = rawDoc(
      txt('root'),
      el('paragraph', txt('a', 'italic', 'bold'), txt('b', 'bold', 'italic'), txt('')),
      el('code', txt('x', 'bold')),
    )
    const tr = run(d)
    expect(tr.ops.length).toBeGreaterThan(0)
    expect(tr.ops.reduce(applyOp, d)).toEqual(tr.doc)
    expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc)).toEqual(d)
  })

  it('is idempotent on an already normal doc', () => {
    const d = doc(el('paragraph', txt('a', 'bold', 'italic'), el('link', txt('l')), txt('b')))
    expect(run(d).ops).toEqual([])
  })
})

describe('normalize: plugin hooks', () => {
  it('calls plugin normalize for every entry in priority order, with the plugin context', () => {
    const calls: string[] = []
    const make = (name: string, priority: number) =>
      definePlugin({
        name,
        priority,
        normalize: ([node], _tr, c) => {
          calls.push(`${c.name}:${'text' in node ? node.text : (node as ElementNode).type}`)
        },
      })
    run(doc(el('paragraph', txt('a'))), [testParagraph, make('low', 1), make('high', 200)])
    expect(calls).toEqual(['high:paragraph', 'low:paragraph', 'high:a', 'low:a'])
  })

  it('repeats passes until plugin hooks add no ops, re-running core rules', () => {
    // The hook appends a sibling text; only the next pass's core rule 3 merges it.
    const upper = definePlugin({
      name: 'upper',
      normalize: ([node, path], tr) => {
        if ('text' in node && node.text === 'a') {
          tr.apply({ type: 'remove_text', path, offset: 0, text: 'a' })
          tr.apply({ type: 'insert_text', path, offset: 0, text: 'A' })
          tr.insertNode([...path.slice(0, -1), path[path.length - 1]! + 1], txt('!'))
        }
      },
    })
    const d = doc(el('paragraph', txt('a')), el('paragraph', txt('a')))
    expect(normalized(d, [testParagraph, upper])).toEqual(stripIds(doc(el('paragraph', txt('A!')), el('paragraph', txt('A!')))))
  })

  it('tracks entry paths through ops made by earlier hooks', () => {
    const seen: string[] = []
    const remover = definePlugin({
      name: 'remover',
      priority: 200,
      normalize: ([node, path], tr) => {
        if ('type' in node && node.type === 'paragraph' && (node.data as { kill?: boolean }).kill) tr.removeNode(path)
      },
    })
    const spy = definePlugin({
      name: 'spy',
      normalize: ([node]) => {
        if ('text' in node) seen.push(node.text)
      },
    })
    run(doc(el('paragraph', { kill: true }, txt('x')), el('paragraph', txt('y'))), [testParagraph, remover, spy])
    // 'x' was removed before the spy reached it; 'y' is seen in pass 1 (at its shifted path) and pass 2.
    expect(seen).toEqual(['y', 'y'])
  })

  it('throws when normalization does not converge', () => {
    const flip = definePlugin({
      name: 'flip',
      normalize: ([node, path], tr) => {
        if ('type' in node && node.type === 'paragraph') {
          tr.setNodeData(path, { n: (((node.data as { n?: number }).n ?? 0) + 1) as number })
        }
      },
    })
    expect(() => run(doc(el('paragraph', txt('x'))), [testParagraph, flip])).toThrow('Normalization did not converge')
  })
})

describe('normalize: rule 11 (no newline outside content:"text" blocks)', () => {
  it('splits an inline-content block at each \n into blocks of its type; marks, selection and ids follow', () => {
    const d = doc({ id: 'b', type: 'paragraph', data: {}, children: [txt('a'), txt('b\n\nc', 'bold'), txt('d')] })
    // The caret right after the second newline goes to the start of the last piece.
    const tr = run(d, base, sel([0, 1], 3))
    expect(stripIds(tr.doc)).toEqual(
      stripIds(doc(el('paragraph', txt('a'), txt('b', 'bold')), el('paragraph', txt('', 'bold')), el('paragraph', txt('c', 'bold'), txt('d')))),
    )
    expect(tr.selection).toEqual(sel([2, 0], 0))
    const ids = tr.doc.children.map((b) => b.id)
    expect(ids[0]).toBe('b')
    expect(new Set(ids).size).toBe(3)
    expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc)).toEqual(d)
    expect(run(tr.doc).ops).toEqual([])
  })

  it('a caret right before a newline stays at the end of its line', () => {
    const tr = run(doc(el('paragraph', txt('ab\ncd'))), base, sel([0, 0], 2))
    expect(stripIds(tr.doc)).toEqual(stripIds(doc(el('paragraph', txt('ab')), el('paragraph', txt('cd')))))
    expect(tr.selection).toEqual(sel([0, 0], 2))
  })

  it('splits through a non-atom inline element; content:"text" blocks keep their newlines', () => {
    const d = doc(el('paragraph', txt('a'), el('link', txt('b\nc')), txt('d')), el('code', txt('x\ny')))
    expect(normalized(d)).toEqual(
      stripIds(doc(el('paragraph', txt('a'), el('link', txt('b')), txt('')), el('paragraph', txt(''), el('link', txt('c')), txt('d')), el('code', txt('x\ny')))),
    )
  })
})

describe('normalize: rule 11 on the editing paths that join text with newlines', () => {
  const ed = (content: Doc, selection: Selection) =>
    createTestEditor({ plugins: [testParagraph, testBold, testCode], doc: content, selection })
  const shape = (e: ReturnType<typeof ed>) => stripIds(e.getJSON())

  it('Backspace at the start of a content:"text" block after a paragraph: one paragraph per line, one undo', () => {
    const before = doc(el('paragraph', txt('p')), el('code', txt('a\nb')))
    const e = ed(before, sel([1, 0], 0))
    e.handleIntent({ inputType: 'deleteContentBackward', data: null, range: e.state.selection && mainRange(e.state.selection) })
    expect(shape(e)).toEqual(stripIds(doc(el('paragraph', txt('pa')), el('paragraph', txt('b')))))
    expect(e.state.selection).toEqual(sel([0, 0], 1))
    expect(e.getHTML()).toBe('<p>pa</p><p>b</p>')
    // The split is part of the Backspace tr: one undo restores the code block.
    e.commands.undo()
    expect(shape(e)).toEqual(stripIds(before))
  })

  it('a range delete from mid-paragraph into a content:"text" block', () => {
    const e = ed(doc(el('paragraph', txt('pq')), el('code', txt('a\nb'))), sel([0, 0], 1, [1, 0], 1))
    e.handleIntent({ inputType: 'deleteContentBackward', data: null, range: e.state.selection && mainRange(e.state.selection) })
    expect(shape(e)).toEqual(stripIds(doc(el('paragraph', txt('p')), el('paragraph', txt('b')))))
    expect(e.state.selection).toEqual(sel([0, 0], 1))
    expect(e.getHTML()).toBe('<p>p</p><p>b</p>')
  })

  it('a drop of inline text holding a newline into a paragraph', () => {
    const e = ed(doc(el('paragraph', txt('pq'))), sel([0, 0], 0))
    const json = JSON.stringify([txt('xy\nz')])
    const dataTransfer = { getData: (t: string) => (t === 'application/x-hte-fragment' ? json : '') } as unknown as DataTransfer
    e.handleIntent({ inputType: 'insertFromDrop', data: null, range: mainRange(sel([0, 0], 1)), dataTransfer })
    expect(shape(e)).toEqual(stripIds(doc(el('paragraph', txt('pxy')), el('paragraph', txt('zq')))))
    expect(e.state.selection).toEqual(sel([1, 0], 1))
    expect(e.getHTML()).toBe('<p>pxy</p><p>zq</p>')
  })
})

describe('normalize: rule 11 splits every newline of a block in one pass', () => {
  it('splits newlines spread over several texts and an inline element in one fix, keeping order', () => {
    const d = doc({ id: 'b', type: 'paragraph', data: {}, children: [txt('a\nb'), el('link', txt('c\nd\ne')), txt('f\ng', 'bold')] })
    const tr = run(d)
    expect(stripIds(tr.doc)).toEqual(
      stripIds(
        doc(
          el('paragraph', txt('a')),
          el('paragraph', txt('b'), el('link', txt('c')), txt('')),
          el('paragraph', txt(''), el('link', txt('d')), txt('')),
          el('paragraph', txt(''), el('link', txt('e')), txt('f', 'bold')),
          el('paragraph', txt('g', 'bold')),
        ),
      ),
    )
    expect(tr.doc.children[0]!.id).toBe('b')
    expect(new Set(tr.doc.children.map((b) => b.id)).size).toBe(5)
    expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc)).toEqual(d)
  })

  it('splits a 2000-line paragraph in under 200 ms', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`)
    const content = doc(el('paragraph', txt(lines.join('\n'))))
    const e = createTestEditor({ plugins: [testParagraph, testBold, testCode] })
    e.setContent(content) // warm-up
    let best = Infinity
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      e.setContent(content)
      best = Math.min(best, performance.now() - t0)
    }
    expect(e.state.doc.children).toHaveLength(2000)
    expect(e.state.doc.children[1999]).toMatchObject({ type: 'paragraph', children: [{ text: 'line 1999' }] })
    expect(best).toBeLessThan(200)
  })
})
