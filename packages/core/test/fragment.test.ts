import { describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type { DeepReadonly, Doc, ElementNode, Node, Range, Selection } from '../src/model/types'
import { getFragment, isElement, nodeEntries, type Fragment } from '../src/index'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const heading = definePlugin({ name: 'heading', node: { kind: 'block' } })
const link = definePlugin({ name: 'link', node: { kind: 'inline' } })

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

function setup(content: Doc, selection?: Selection) {
  return createTestEditor({ plugins: [testParagraph, testBold, heading, link], doc: content, selection })
}

function range(startPath: number[], startOffset: number, endPath: number[], endOffset: number): Range {
  return { start: { path: startPath, offset: startOffset }, end: { path: endPath, offset: endOffset } }
}

function elementIds(d: DeepReadonly<Doc>): string[] {
  return [...nodeEntries(d)].filter(([n]) => isElement(n)).map(([n]) => (n as ElementNode).id)
}

describe('getFragment', () => {
  it('copies part of a single text', () => {
    expect(getFragment(doc(p('abcd')), range([0, 0], 1, [0, 0], 3))).toEqual([txt('bc')])
  })

  it('copies trimmed blocks across blocks', () => {
    const frag = getFragment(doc(p('ab'), p('cd')), range([0, 0], 1, [1, 0], 1))
    expect(stripIds(frag)).toEqual(stripIds([p('b'), p('c')]))
  })

  it('sorts the range points', () => {
    const frag = getFragment(doc(p('ab'), p('cd')), range([1, 0], 1, [0, 0], 1))
    expect(stripIds(frag)).toEqual(stripIds([p('b'), p('c')]))
  })

  it('returns [] for a collapsed range', () => {
    expect(getFragment(doc(p('ab')), range([0, 0], 1, [0, 0], 1))).toEqual([])
  })

  it('copies inline content across texts, keeping marks and dropping empty edge texts', () => {
    const d = doc(p('a', txt('bc', 'bold'), 'd'))
    expect(getFragment(d, range([0, 0], 1, [0, 2], 1))).toEqual([txt('bc', 'bold'), txt('d')])
  })

  it('keeps the type and data of partial blocks and deep-copies them', () => {
    const h = el('heading', { level: 1, meta: { x: [1] } }, txt('title'))
    const d = doc(h, p('body'))
    const frag = getFragment(d, range([0, 0], 2, [1, 0], 2))
    expect(stripIds(frag)).toEqual(stripIds([el('heading', { level: 1, meta: { x: [1] } }, txt('tle')), p('bo')]))
    ;((frag[0] as ElementNode).data.meta as { x: number[] }).x.push(2)
    expect(h.data).toEqual({ level: 1, meta: { x: [1] } })
  })

  it('copies whole middle blocks', () => {
    const frag = getFragment(doc(p('ab'), p('mid'), p('cd')), range([0, 0], 1, [2, 0], 1))
    expect(stripIds(frag)).toEqual(stripIds([p('b'), p('mid'), p('c')]))
  })

  it('copies inline elements partially', () => {
    const d = doc(p('a', el('link', { href: 'x' }, txt('link')), 'b'))
    const frag = getFragment(d, range([0, 0], 0, [0, 1, 0], 2))
    expect(stripIds(frag)).toEqual(stripIds([txt('a'), el('link', { href: 'x' }, txt('li'))]))
  })
})

describe('insertFragment / insertContent', () => {
  it('merges a two-block fragment around the caret', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    expect(ed.commands.insertContent([p('X'), p('Y')])).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aX'), p('Yb'))))
    expect(ed.state.selection).toEqual(sel([1, 0], 1))
  })

  it('inserts middle blocks whole', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.insertContent([p('X'), el('heading', { level: 2 }, txt('M')), p('Y')])
    expect(stripIds(ed.getJSON())).toEqual(
      stripIds(doc(p('aX'), el('heading', { level: 2 }, txt('M')), p('Yb'))),
    )
    expect(ed.state.selection).toEqual(sel([2, 0], 1))
  })

  it('inserts an inline fragment at the caret with its own marks', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.insertContent([txt('Z', 'bold')])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a'), txt('Z', 'bold'), txt('b')))))
    expect(ed.state.selection).toEqual(sel([0, 1], 1))
  })

  it('does not apply stored marks to pasted content', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.toggleMark('bold')
    ed.commands.insertContent([txt('Z')])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aZb'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
  })

  it('treats a single-block fragment as inline content', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.insertContent([el('heading', txt('X'), txt('Y', 'bold'))])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aX', txt('Y', 'bold'), 'b'))))
    expect(ed.state.selection).toEqual(sel([0, 1], 1))
  })

  it('inserts at the start and end of a text', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 0))
    ed.commands.insertContent([txt('<', 'bold')])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('<', 'bold'), 'ab'))))
    ed.commands.insertContent([p('X'), p('Y')])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('<', 'bold'), 'X'), p('Yab'))))
  })

  it('places the caret after an inserted inline element', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.insertContent([el('link', { href: 'x' }, txt('L'))])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('a', el('link', { href: 'x' }, txt('L')), 'b'))))
    expect(ed.state.selection).toEqual(sel([0, 1, 0], 1))
  })

  it('never places the caret inside a pasted atom (opaque element)', () => {
    const mention = definePlugin({ name: 'mention', node: { kind: 'inline', atom: true } })
    const ed = createTestEditor({
      plugins: [testParagraph, testBold, mention],
      doc: doc(p('ab')),
      selection: sel([0, 0], 1),
    })
    ed.commands.insertContent([txt('X'), el('mention', txt('@m'))])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aX', el('mention', txt('@m')), 'b'))))
    // Right after the atom: the start of the text following it.
    expect(ed.state.selection).toEqual(sel([0, 2], 0))
  })

  it('places the caret at the start of the remainder when the last block is empty', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    ed.commands.insertContent([p('X'), p('')])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aX'), p('b'))))
    expect(ed.state.selection).toEqual(sel([1, 0], 0))
  })

  it('replaces a selection', () => {
    const ed = setup(doc(p('abcd'), p('ef')), sel([1, 0], 1, [0, 0], 1))
    ed.commands.insertContent([p('X'), p('Y')])
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aX'), p('Yf'))))
    expect(ed.state.selection).toEqual(sel([1, 0], 1))
  })

  it('inserts at an explicit range via the transaction', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 0))
    const tr = ed.createTransaction()
    tr.insertFragment([txt('Z')], range([0, 0], 1, [0, 0], 3))
    ed.dispatch(tr)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aZd'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 2))
  })

  it('an empty fragment adds no ops at a caret and only deletes a range', () => {
    const ed = setup(doc(p('abcd')), sel([0, 0], 1))
    const tr = ed.createTransaction()
    tr.insertFragment([])
    expect(tr.ops).toEqual([])
    const tr2 = ed.createTransaction()
    tr2.insertFragment([], range([0, 0], 1, [0, 0], 3))
    ed.dispatch(tr2)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ad'))))
    expect(ed.state.selection).toEqual(sel([0, 0], 1))
  })

  it('does not mutate the fragment', () => {
    const ed = setup(doc(p('ab')), sel([0, 0], 1))
    const frag: Fragment = [p('X'), p('M'), p('Y')]
    const copy = structuredClone(frag)
    ed.commands.insertContent(frag)
    expect(frag).toEqual(copy)
  })
})

describe('Review Focus 3: pasting content copied from the same doc keeps ids unique', () => {
  it('copy p#n1 and paste it into the same doc', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel([1, 0], 2))
    const frag = getFragment(ed.state.doc, range([0, 0], 0, [1, 0], 2))
    ed.commands.insertContent([p(''), ...frag, p('')])
    const ids = [...nodeEntries(ed.state.doc)].filter(([n]) => isElement(n)).map(([n]) => (n as ElementNode).id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('cd'), p('ab'), p('cd'), p(''))))
  })

  it('gives fresh ids to nested elements and to ids duplicated within the fragment', () => {
    const ed = setup(doc(p('a', el('link', txt('L')), 'b')), sel([0, 2], 1))
    const linkId = (ed.state.doc.children[0]!.children![1] as ElementNode).id
    const blockId = ed.state.doc.children[0]!.id
    const dupe = (text: string): ElementNode => ({ ...p(text), id: 'dup' })
    const nested: ElementNode = { ...p('m', { ...el('link', txt('L')), id: linkId }), id: blockId }
    ed.commands.insertContent([p('X'), nested, dupe('1'), dupe('2'), p('Y', { ...el('link', txt('Q')), id: linkId })])
    const ids = elementIds(ed.state.doc)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('dup')
  })

  it('inline paste of an inline element keeps ids unique', () => {
    const ed = setup(doc(p('a', el('link', txt('L')), 'b')), sel([0, 2], 1))
    const frag = getFragment(ed.state.doc, range([0, 0], 0, [0, 2], 1))
    ed.commands.insertContent(frag)
    expect(elementIds(ed.state.doc).length).toBe(3)
    expect(new Set(elementIds(ed.state.doc)).size).toBe(3)
  })
})

describe('insertFragment of existing content under unknown elements', () => {
  it('inserts a copied unknown block whose child has invalid registered data', async () => {
    const { z } = await import('zod')
    const strict = definePlugin({ name: 'strict', node: { kind: 'block' }, data: z.object({ n: z.number().optional() }) })
    const content = doc(p('a'), el('unknownThing', el('strict', { n: 'bad' } as never, txt('y'))), p('b'))
    const ed = createTestEditor({ plugins: [testParagraph, strict], doc: content, selection: sel([2, 0], 0) })
    const frag = getFragment(content, range([1], 0, [1, 0, 0], 1))
    expect(() => ed.dispatch((() => { const tr = ed.createTransaction(); tr.insertFragment(frag); return tr })())).not.toThrow()
    expect(JSON.stringify(ed.getJSON())).toContain('"bad"')
  })
})

describe('insertFragment of opaque blocks', () => {
  const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
  const ed = (content: Doc, selection: Selection) =>
    createTestEditor({ plugins: [testParagraph, testBold, atom], doc: content, selection })
  const insert = (e: ReturnType<typeof ed>, frag: Fragment) => {
    const tr = e.createTransaction()
    tr.insertFragment(frag)
    e.dispatch(tr)
  }

  it('a fragment of one atom block inserts the block itself, splitting the caret block', () => {
    const e = ed(doc(p('abcd')), sel([0, 0], 2))
    insert(e, [el('atom', { k: 1 })])
    expect(stripIds(e.getJSON())).toEqual(stripIds(doc(p('ab'), el('atom', { k: 1 }), p('cd'))))
    expect(e.state.selection).toEqual(sel([2, 0], 0))
  })

  it('a fragment of one atom block replaces an empty block', () => {
    const e = ed(doc(p('ab'), p('')), sel([1, 0], 0))
    insert(e, [el('atom')])
    expect(e.getJSON().children.map((b) => b.type)).toEqual(['paragraph', 'atom', 'paragraph'])
  })

  it('atom blocks at the edges of a block fragment are inserted whole', () => {
    const e = ed(doc(p('abcd')), sel([0, 0], 2))
    insert(e, [el('atom', { k: 1 }), p('x'), el('atom', { k: 2 })])
    expect(stripIds(e.getJSON())).toEqual(
      stripIds(doc(p('ab'), el('atom', { k: 1 }), p('x'), el('atom', { k: 2 }), p('cd'))),
    )
    expect(e.state.selection).toEqual(sel([4, 0], 0))
  })
})
