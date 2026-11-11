import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../src/plugin/define'
import { nodeSelection } from '../src/model/editable'
import { testBold as testBoldPlugin } from './fixtures'
import type { Doc, ElementNode, Node } from '../src/model/types'
import type { AnyPlugin } from '../src/plugin/types'
import { atomEl, createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testParagraph } from './fixtures'

const img = definePlugin({ name: 'img', node: { kind: 'block', atom: true } })
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const load = (d: Doc, extra: AnyPlugin[] = [img]) => createTestEditor({ plugins: [testParagraph, ...extra], doc: d })
const shape = (d: Doc) => stripIds(d)

describe('normalize: a hoisted atom block next to empty texts (3.2b)', () => {
  it('leaves no stray empty paragraph before it', () => {
    expect(shape(load(doc(p('', atomEl('img', {}), ''))).getJSON())).toEqual(shape(doc(atomEl('img', {}), p(''))))
    expect(shape(load(doc(p('', atomEl('img', {}), 'b'))).getJSON())).toEqual(shape(doc(atomEl('img', {}), p('b'))))
  })

  it('leaves no stray empty paragraph after it', () => {
    expect(shape(load(doc(p('a', atomEl('img', {}), ''))).getJSON())).toEqual(shape(doc(p('a'), atomEl('img', {}))))
  })
})

describe('normalize: unknown elements in inline content (3.6)', () => {
  it('keep a text leaf on each side, like inline atoms', () => {
    const weird = el('weird', {}, txt('q'))
    expect(shape(load(doc(p('', weird))).getJSON())).toEqual(shape(doc(p('', weird, ''))))
    expect(shape(load(doc(p(weird))).getJSON())).toEqual(shape(doc(p('', weird, ''))))
  })

  it('a caret can be placed in such a block', () => {
    const ed = load(doc(p(el('weird', {}, txt('q')))))
    expect(ed.state.selection).toEqual(sel([0, 0], 0))
  })
})

describe('plugin normalize hooks (3.7)', () => {
  it('visit opaque elements but not their descendants', () => {
    const seen: string[] = []
    const spy = definePlugin({
      name: 'spy',
      normalize: ([node]) => {
        seen.push('type' in node ? node.type : `text:${node.text}`)
      },
    })
    const content = doc(p('a'), atomEl('img', {}), el('weird', {}, p('inner')))
    load(content, [img, spy])
    expect(seen).toContain('img')
    expect(seen).toContain('weird')
    expect(seen).not.toContain('text:inner')
    expect(seen.filter((t) => t === 'paragraph')).toHaveLength(1)
  })
})

describe('range delete edges (3.11)', () => {
  it('an unknown inline element is no edge block: the paragraphs still merge', () => {
    const ed = load(doc(p('ab', el('weird', {}, txt('q')), 'cd'), p('ef')))
    const tr = ed.createTransaction()
    // From the text right after the unknown element to inside the next paragraph.
    tr.deleteRange({ anchor: { path: [0, 2], offset: 1 }, focus: { path: [1, 0], offset: 1 } })
    ed.dispatch(tr)
    expect(shape(ed.getJSON())).toEqual(shape(doc(p('ab', el('weird', {}, txt('q')), 'cf'))))
  })

  it('a range starting inside an unknown inline element removes it whole and merges', () => {
    const ed = load(doc(p('ab', el('weird', {}, txt('q')), 'cd'), p('ef')))
    const tr = ed.createTransaction()
    tr.deleteRange({ anchor: { path: [0, 1, 0], offset: 0 }, focus: { path: [1, 0], offset: 1 } })
    ed.dispatch(tr)
    expect(shape(ed.getJSON())).toEqual(shape(doc(p('abf'))))
  })
})

describe('selection when its node goes away (3.9, 3.13)', () => {
  const code = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })
  const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
  const bold = { type: 'bold', data: {} }

  it('a caret in an empty text that rule 4 drops, with no text beside it, moves to the nearest editable text', () => {
    // The code block holds an empty text and an unknown element: no sibling has a text to re-home to.
    // (A container no longer holds texts: one put there is wrapped into a paragraph, not dropped.)
    const ed = createTestEditor({ plugins: [testParagraph, img, code], doc: doc(p('ab'), el('code', el('weird', {}, txt('q')))) })
    const tr = ed.createTransaction()
    tr.apply({ type: 'insert_node', path: [1, 0], node: txt('') })
    tr.setSelection(sel([1, 0], 0))
    ed.dispatch(tr)
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
  })

  it('a node selection survives an op that removes its anchor text while the node stays', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, img],
      doc: doc(p('ab'), atomEl('img', {}), p('cd')),
    })
    const tr = ed.createTransaction()
    tr.setSelection(nodeSelection(tr.doc, ed.registry, [1]))
    // The anchor (end of "ab") goes with its paragraph; the image stays.
    tr.removeNode([0])
    expect(tr.selection?.ranges[0]?.node).toEqual([0])
    expect(tr.selection?.ranges[0]?.anchor).toEqual({ path: [1, 0], offset: 0 })
  })

  it('isMarkActive is false while a node is selected, unless the stored marks have the mark', () => {
    const content = doc(p({ text: 'ab', marks: [bold] }, atomEl('chip'), { text: 'cd', marks: [bold] }))
    const ed = createTestEditor({ plugins: [testParagraph, testBoldPlugin, chip], doc: content })
    const tr = ed.createTransaction()
    tr.setSelection(nodeSelection(tr.doc, ed.registry, [0, 1]))
    ed.dispatch(tr)
    expect(ed.isActive('bold')).toBe(false)
    const t2 = ed.createTransaction()
    t2.setStoredMarks([bold])
    ed.dispatch(t2)
    expect(ed.isActive('bold')).toBe(true)
  })

  it('a block node inserted right before another atom block gets an empty block after it for the caret', () => {
    const ed = createTestEditor({ plugins: [testParagraph, img], doc: doc(atomEl('img', { n: 1 }), p(''), atomEl('img', { n: 2 }), p('x')) })
    const tr = ed.createTransaction()
    tr.setSelection(sel([1, 0], 0))
    tr.insertBlockNode(atomEl('img', { n: 3 }))
    ed.dispatch(tr)
    expect(shape(ed.getJSON())).toEqual(shape(doc(atomEl('img', { n: 1 }), atomEl('img', { n: 3 }), p(''), atomEl('img', { n: 2 }), p('x'))))
    expect(ed.state.selection).toEqual(sel([2, 0], 0))
  })
})

describe('rule 11: selection mapping across several newlines (3.16)', () => {
  // "a\nbc\nd\nef": a 0, \n 1, b 2, c 3, \n 4, d 5, \n 6, e 7, f 8; lines a | bc | d | ef.
  const pt = (path: number[], offset: number) => ({ path, offset })
  const lines = doc(el('paragraph', txt('a\nbc\nd\nef')))
  const split = doc(p('a'), p('bc'), p('d'), p('ef'))

  it('maps every range of a multi-range selection to its own line, keeping direction and main', () => {
    const ed = createTestEditor({
      plugins: [testParagraph],
      doc: lines,
      selection: {
        ranges: [
          { anchor: pt([0, 0], 3), focus: pt([0, 0], 3) },
          { anchor: pt([0, 0], 8), focus: pt([0, 0], 5) },
        ],
        main: 1,
      },
    })
    expect(shape(ed.getJSON())).toEqual(shape(split))
    expect(ed.state.selection).toEqual({
      ranges: [
        { anchor: pt([1, 0], 1), focus: pt([1, 0], 1) },
        { anchor: pt([3, 0], 1), focus: pt([2, 0], 0) },
      ],
      main: 1,
    })
  })

  it('a range spanning several newlines: before a newline stays on its line, after one starts the next', () => {
    const ed = createTestEditor({ plugins: [testParagraph], doc: lines, selection: sel([0, 0], 1, [0, 0], 7) })
    expect(shape(ed.getJSON())).toEqual(shape(split))
    expect(ed.state.selection).toEqual(sel([0, 0], 1, [3, 0], 0))
  })
})

describe('a default block with a data schema (3.12)', () => {
  const para = (data: z.ZodType) =>
    definePlugin({ name: 'paragraph', node: { kind: 'block', default: true, content: 'inline' }, data })

  it('new default blocks get the schema output for `{}` (its defaults)', () => {
    const ed = createTestEditor({ plugins: [para(z.object({ align: z.string().default('left') }))], doc: doc() })
    expect(shape(ed.getJSON())).toEqual(shape(doc(el('paragraph', { align: 'left' }, txt('')))))
    const tr = ed.createTransaction()
    tr.splitBlock()
    ed.dispatch(tr)
    expect(shape(ed.getJSON())).toEqual(shape(doc(el('paragraph', { align: 'left' }, txt('')), el('paragraph', { align: 'left' }, txt('')))))
  })

  it('throws a clear error at construction when the default block rejects empty data', () => {
    const strict = para(z.object({ align: z.string() }))
    const content = doc(el('paragraph', { align: 'left' }, txt('a')))
    expect(() => createTestEditor({ plugins: [strict], doc: content })).toThrow(
      /default block "paragraph" cannot be created with empty data/i,
    )
    expect(() => createTestEditor({ plugins: [strict], doc: content, dev: false })).toThrow(/default block "paragraph"/i)
  })
})
