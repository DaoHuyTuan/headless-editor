import { describe, expect, it } from 'vitest'
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
      stripIds(doc(el('paragraph', txt('a'), el('link', txt('l'))), el('paragraph', txt('p')), el('paragraph', txt('b')))),
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

  it('rule 4 re-homes a caret next to an inline element into the inline’s edge text', () => {
    const after = run(doc(el('paragraph', el('link', txt('ab')), txt('', 'bold'))), base, sel([0, 1], 0))
    expect(stripIds(after.doc)).toEqual(stripIds(doc(el('paragraph', el('link', txt('ab'))))))
    expect(after.selection).toEqual(sel([0, 0, 0], 2))
    const before = run(doc(el('paragraph', txt('', 'bold'), el('link', txt('ab')))), base, sel([0, 0], 0))
    expect(before.selection).toEqual(sel([0, 0, 0], 0))
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
