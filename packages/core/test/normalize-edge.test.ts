import { describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type { Doc, ElementNode, Node } from '../src/model/types'
import type { AnyPlugin } from '../src/plugin/types'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { testParagraph } from './fixtures'

const img = definePlugin({ name: 'img', node: { kind: 'block', atom: true } })
const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const load = (d: Doc, extra: AnyPlugin[] = [img]) => createTestEditor({ plugins: [testParagraph, ...extra], doc: d })
const shape = (d: Doc) => stripIds(d)

describe('normalize: a hoisted atom block next to empty texts (3.2b)', () => {
  it('leaves no stray empty paragraph before it', () => {
    expect(shape(load(doc(p('', el('img', {}), ''))).getJSON())).toEqual(shape(doc(el('img', {}), p(''))))
    expect(shape(load(doc(p('', el('img', {}), 'b'))).getJSON())).toEqual(shape(doc(el('img', {}), p('b'))))
  })

  it('leaves no stray empty paragraph after it', () => {
    expect(shape(load(doc(p('a', el('img', {}), ''))).getJSON())).toEqual(shape(doc(p('a'), el('img', {}))))
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
    const content = doc(p('a'), el('img', {}), el('weird', {}, p('inner')))
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
