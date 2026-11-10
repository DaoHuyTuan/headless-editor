import { describe, expectTypeOf, it } from 'vitest'
import { getNode, getParent, isElement, isText, nodeEntries, textEntries, type DeepReadonly, type Doc, type ElementNode, type Node, type TextNode } from '../src/index'
import { createTestEditor, doc, el, txt } from '../src/testing/index'
import { testParagraph } from './fixtures'

describe('the doc is read-only through every accessor (1.15)', () => {
  const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt('ab'))) })

  it('getNode, getParent, nodeEntries and textEntries return read-only nodes', () => {
    expectTypeOf(getNode(ed.state.doc, [0, 0])).toEqualTypeOf<DeepReadonly<Node>>()
    expectTypeOf(getParent(ed.state.doc, [0, 0])).toEqualTypeOf<DeepReadonly<Doc | ElementNode>>()
    for (const [n] of nodeEntries(ed.state.doc)) expectTypeOf(n).toEqualTypeOf<DeepReadonly<Node>>()
    for (const [t] of textEntries(ed.state.doc)) expectTypeOf(t).toEqualTypeOf<DeepReadonly<TextNode>>()
    const block = getNode(ed.state.doc, [0])
    // @ts-expect-error read-only data
    if (isElement(block)) block.data.x = 1
    const text = getNode(ed.state.doc, [0, 0])
    // @ts-expect-error read-only text
    if (isText(text)) text.text = 'x'
  })

  it('tr.doc is read-only', () => {
    const tr = ed.createTransaction()
    expectTypeOf(tr.doc).toEqualTypeOf<DeepReadonly<Doc>>()
    // @ts-expect-error read-only children
    tr.doc.children.push(el('paragraph'))
  })

  it('isText / isElement narrow read-only and mutable nodes alike', () => {
    const ro = getNode(ed.state.doc, [0, 0])
    if (isText(ro)) expectTypeOf(ro).toEqualTypeOf<DeepReadonly<TextNode>>()
    if (isElement(ro)) expectTypeOf(ro).toEqualTypeOf<DeepReadonly<ElementNode>>()
    const asNode = (n: Node): Node => n
    const mutable = asNode(txt('a'))
    if (isText(mutable)) expectTypeOf(mutable).toEqualTypeOf<TextNode>()
    if (isElement(mutable)) expectTypeOf(mutable).toEqualTypeOf<ElementNode>()
  })
})
