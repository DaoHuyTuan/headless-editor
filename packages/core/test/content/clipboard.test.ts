// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import type { Doc, ElementNode, Node, Selection } from '../../src/model/types'
import { definePlugin, isText, parseFromClipboard, serializeForClipboard, type AnyPlugin, type Fragment } from '../../src/index'
import { createTestEditor, doc, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: ReturnType<typeof txt>[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const range = (path: number[], offset: number, focusPath: number[], focusOffset: number): Selection => single({
  anchor: { path, offset },
  focus: { path: focusPath, offset: focusOffset },
})
const caret = (path: number[], offset: number): Selection => range(path, offset, path, offset)

function setup(content: Doc, selection: Selection, plugins: AnyPlugin[] = [testParagraph, testBold]) {
  return createTestEditor({ plugins, doc: content, selection })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('serializeForClipboard / parseFromClipboard', () => {
  it('round-trips a range with bold through the json flavor', () => {
    const editor = setup(doc(p('p1', txt('ab'), txt('cd', 'bold'), txt('ef'))), caret([0, 0], 0))
    const r = { start: { path: [0, 0], offset: 1 }, end: { path: [0, 2], offset: 1 } }
    const out = serializeForClipboard(editor, r)
    expect(JSON.parse(out.json)).toEqual([txt('b'), txt('cd', 'bold'), txt('e')])
    expect(out.text).toBe('bcde')
    expect(out.html).toBe('<p>b<strong>cd</strong>e</p>')
    expect(parseFromClipboard(editor, { json: out.json })).toEqual(JSON.parse(out.json))
  })

  it('serializes several blocks: text joined by newlines, html with one element per block', () => {
    const editor = setup(doc(p('p1', txt('one')), p('p2', txt('two', 'bold')), p('p3', txt('three'))), caret([0, 0], 0))
    const out = serializeForClipboard(editor, { start: { path: [0, 0], offset: 1 }, end: { path: [2, 0], offset: 2 } })
    expect(out.text).toBe('ne\ntwo\nth')
    expect(out.html).toBe('<p>ne</p><p><strong>two</strong></p><p>th</p>')
    expect(stripIds(parseFromClipboard(editor, { json: out.json }))).toEqual(
      stripIds([p('a', txt('ne')), p('b', txt('two', 'bold')), p('c', txt('th'))]),
    )
  })

  it("the text flavor uses an inline atom's renderText (with the editor's current options)", () => {
    const tag = definePlugin({
      name: 'tag',
      node: { kind: 'inline', atom: true },
      options: { prefix: '#' },
      renderText: (node, { options }) => `${options.prefix}${String(node.data.label)}`,
    })
    const bare = definePlugin({ name: 'bare', node: { kind: 'inline', atom: true } })
    const atom = (type: string): ElementNode => ({ id: type, type, data: { label: 'x' }, children: [] })
    const content = doc({ id: 'p1', type: 'paragraph', data: {}, children: [txt('hi '), atom('tag'), txt(' '), atom('bare'), txt(' yo')] })
    const editor = setup(content, caret([0, 0], 0), [testParagraph, testBold, tag, bare])
    const all = { start: { path: [0, 0], offset: 0 }, end: { path: [0, 4], offset: 3 } }
    expect(serializeForClipboard(editor, all).text).toBe('hi #x  yo')
    editor.setPluginOptions('tag', { prefix: '+' })
    expect(serializeForClipboard(editor, all).text).toBe('hi +x  yo')
  })

  it('parses html when there is no json', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    const frag = parseFromClipboard(editor, { html: '<p>a<b>b</b></p>', text: 'ab' })
    expect(stripIds(frag)).toEqual([{ type: 'paragraph', data: {}, children: [txt('a'), txt('b', 'bold')] }])
  })

  it('falls through to html when the json is malformed or not an array', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    for (const json of ['{not json', '{"text":"x"}', '"x"']) {
      const frag = parseFromClipboard(editor, { json, html: '<p>h</p>', text: 't' })
      expect(stripIds(frag)).toEqual([{ type: 'paragraph', data: {}, children: [txt('h')] }])
    }
  })

  it('falls through to text: several lines become default blocks', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    expect(stripIds(parseFromClipboard(editor, { text: 'x\ny' }))).toEqual([
      { type: 'paragraph', data: {}, children: [txt('x')] },
      { type: 'paragraph', data: {}, children: [txt('y')] },
    ])
    expect(parseFromClipboard(editor, { text: 'a\r\nb\rc' })).toHaveLength(3)
  })

  it('a single line of text is inline text without marks', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    expect(parseFromClipboard(editor, { text: 'Tiếng Việt 👍🏽' })).toEqual([txt('Tiếng Việt 👍🏽')])
    expect(parseFromClipboard(editor, {})).toEqual([])
  })

  it("applies each plugin's transformPasted, in priority order", () => {
    const calls: string[] = []
    const upper = definePlugin({
      name: 'upper',
      priority: 200,
      transformPasted: (frag: Fragment) => {
        calls.push('upper')
        const up = (n: Node): Node =>
          isText(n) ? { ...n, text: n.text.toUpperCase() } : { ...n, children: n.children?.map(up) }
        return frag.map(up)
      },
    })
    const suffix = definePlugin({
      name: 'suffix',
      priority: 150,
      transformPasted: (frag: Fragment) => {
        calls.push('suffix')
        return [...frag, txt('!')]
      },
    })
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0), [testParagraph, testBold, suffix, upper])
    expect(parseFromClipboard(editor, { text: 'abc' })).toEqual([txt('ABC'), txt('!')])
    expect(calls).toEqual(['upper', 'suffix'])
  })

  it('transformPasted gets the insertion target: the drop point for a drop, the selection for a paste', () => {
    const seen: unknown[] = []
    const spy = definePlugin({
      name: 'spy',
      transformPasted: (frag: Fragment, _ctx, info) => {
        seen.push(info.at)
        return frag
      },
    })
    const editor = setup(doc(p('p1', txt('abcd'))), caret([0, 0], 1), [testParagraph, testBold, spy])
    const transfer = { getData: (t: string) => (t === 'text/plain' ? 'x' : '') } as unknown as DataTransfer
    const dropAt = mainRange(caret([0, 0], 3))
    editor.handleIntent({ inputType: 'insertFromDrop', data: null, range: dropAt, dataTransfer: transfer })
    expect(seen).toEqual([dropAt])
    expect(parseFromClipboard(editor, { text: 'y' })).toEqual([txt('y')])
    expect(seen[1]).toBeNull()
    expect(parseFromClipboard(editor, { text: 'y' }, { at: mainRange(caret([0, 0], 2)) })).toEqual([txt('y')])
    expect(seen[2]).toEqual(mainRange(caret([0, 0], 2)))
  })

  it('validates pasted json data: invalid data is repaired by onInvalidData or the node is dropped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) =>
          typeof (v as { href?: unknown })?.href === 'string'
            ? { value: v as { href: string } }
            : { issues: [{ message: 'href must be a string' }] },
      },
    }
    const link = definePlugin({
      name: 'link',
      mark: { render: (d: { href: string }) => ({ tag: 'a', attrs: { href: d.href } }) },
      data: schema,
      onInvalidData: () => ({ href: '#' }),
    })
    const strict = definePlugin({ name: 'strict', node: { kind: 'block' }, data: schema })
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0), [testParagraph, testBold, link, strict])
    const json = JSON.stringify([
      { id: 'a', type: 'paragraph', data: {}, children: [{ text: 'x', marks: [{ type: 'link', data: { href: 1 } }] }] },
      { id: 'b', type: 'strict', data: { href: 2 }, children: [{ text: 'gone', marks: [] }] },
      { id: 'c', type: 'paragraph', data: {}, children: [{ text: 'y', marks: [] }] },
    ])
    expect(stripIds(parseFromClipboard(editor, { json }))).toEqual([
      { type: 'paragraph', data: {}, children: [txt('x', { type: 'link', data: { href: '#' } })] },
      { type: 'paragraph', data: {}, children: [txt('y')] },
    ])
  })

  it('drops unknown element types and unknown marks from pasted json', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    const json = JSON.stringify([
      { id: 'a', type: 'paragraph', data: {}, children: [{ text: 'x', marks: [{ type: 'evil', data: {} }] }] },
      { id: 'b', type: 'mystery', data: { on: 'x' }, children: [{ text: 'hidden', marks: [] }] },
      { id: 'c', type: 'paragraph', data: {}, children: [{ text: 'y', marks: [] }] },
    ])
    expect(stripIds(parseFromClipboard(editor, { json }))).toEqual([
      { type: 'paragraph', data: {}, children: [txt('x')] },
      { type: 'paragraph', data: {}, children: [txt('y')] },
    ])
  })

  it('gives pasted json a normalize-compatible shape: inline runs beside blocks are wrapped', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    const json = JSON.stringify([{ text: 'loose' }, { id: 'c', type: 'paragraph', children: [] }])
    expect(stripIds(parseFromClipboard(editor, { json }))).toEqual([
      { type: 'paragraph', data: {}, children: [txt('loose')] },
      { type: 'paragraph', data: {}, children: [txt('')] },
    ])
  })

  it('json that sanitizes to nothing falls through to html, then text', () => {
    const editor = setup(doc(p('p1', txt(''))), caret([0, 0], 0))
    const json = JSON.stringify([{ id: 'b', type: 'mystery', data: {} }])
    expect(parseFromClipboard(editor, { json, text: 'plain' })).toEqual([txt('plain')])
  })
})
