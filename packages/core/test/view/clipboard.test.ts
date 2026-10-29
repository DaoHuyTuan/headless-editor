// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Doc, ElementNode, Node, Selection } from '../../src/model/types'
import {
  definePlugin,
  isElement,
  isText,
  nodeEntries,
  parseFromClipboard,
  serializeForClipboard,
  nodeSelection,
  type AnyPlugin,
  type InputIntent,
  type Editor,
  type Fragment,
} from '../../src/index'
import { createTestEditor, doc, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: ReturnType<typeof txt>[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const range = (path: number[], offset: number, focusPath: number[], focusOffset: number): Selection => ({
  anchor: { path, offset },
  focus: { path: focusPath, offset: focusOffset },
})
const caret = (path: number[], offset: number): Selection => range(path, offset, path, offset)

const HTE_MIME = 'application/x-hte-fragment'

function setup(content: Doc, selection: Selection, plugins: AnyPlugin[] = [testParagraph, testBold]) {
  const editor = createTestEditor({ plugins, doc: content, selection })
  return editor
}

function mount(editor: Editor) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  return root
}

/** A clipboard event carrying a plain map-backed `clipboardData` (works whether or not the DOM has DataTransfer). */
function clipboardEvent(type: 'copy' | 'cut' | 'paste', data: Record<string, string> = {}) {
  const store = new Map(Object.entries(data))
  const clipboardData = {
    getData: (t: string) => store.get(t) ?? '',
    setData: (t: string, v: string) => void store.set(t, v),
  }
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'clipboardData', { value: clipboardData })
  return { e, store }
}

function ids(d: Doc): string[] {
  const out: string[] = []
  for (const [n] of nodeEntries(d)) if (isElement(n)) out.push(n.id)
  return out
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
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

describe('clipboard view module', () => {
  it('copy sets the three flavors and prevents the default', () => {
    const editor = setup(doc(p('p1', txt('ab'), txt('cd', 'bold'))), range([0, 0], 1, [0, 1], 1))
    const root = mount(editor)
    const { e, store } = clipboardEvent('copy')
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(store.get('text/plain')).toBe('bc')
    expect(store.get('text/html')).toBe('<p>b<strong>c</strong></p>')
    expect(JSON.parse(store.get(HTE_MIME)!)).toEqual([txt('b'), txt('c', 'bold')])
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p('p1', txt('ab'), txt('cd', 'bold')))))
  })

  it('copy with a collapsed selection is left to the browser', () => {
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1))
    const root = mount(editor)
    const { e, store } = clipboardEvent('copy')
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(store.size).toBe(0)
  })

  it('copy is left to the browser when the DOM selection is outside the root', () => {
    const editor = setup(doc(p('p1', txt('ab'))), range([0, 0], 0, [0, 0], 2))
    const root = mount(editor)
    const outside = document.createElement('span')
    outside.textContent = 'zz'
    document.body.appendChild(outside)
    document.getSelection()!.setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 2)
    const { e, store } = clipboardEvent('copy')
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(store.size).toBe(0)
  })

  it('cut copies, then deletes the selection with origin input / deleteByCut', () => {
    const editor = setup(doc(p('p1', txt('one')), p('p2', txt('two'))), range([0, 0], 1, [1, 0], 1))
    const root = mount(editor)
    const metas: unknown[] = []
    editor.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    const { e, store } = clipboardEvent('cut')
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(store.get('text/plain')).toBe('ne\nt')
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p('x', txt('owo')))))
    expect(metas).toContainEqual(expect.objectContaining({ origin: 'input', inputType: 'deleteByCut' }))
    expect(root.textContent).toBe('owo')
  })

  it('paste prevents the default and inserts the fragment with origin paste', () => {
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1))
    const root = mount(editor)
    const metas: unknown[] = []
    editor.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    const { e } = clipboardEvent('paste', { 'text/html': '<p>x<strong>y</strong></p>', 'text/plain': 'xy' })
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(editor.getJSON().children[0]!.children).toEqual([txt('ax'), txt('y', 'bold'), txt('b')])
    expect(metas).toContainEqual(expect.objectContaining({ origin: 'paste', inputType: 'insertFromPaste' }))
  })

  it('pasting content copied from the same doc gives fresh, unique ids', () => {
    const editor = setup(doc(p('p1', txt('one')), p('p2', txt('two'))), range([0, 0], 0, [1, 0], 3))
    const root = mount(editor)
    const copy = clipboardEvent('copy')
    root.dispatchEvent(copy.e)
    const tr = editor.createTransaction()
    tr.setSelection(caret([1, 0], 3))
    editor.dispatch(tr)
    const paste = clipboardEvent('paste', Object.fromEntries(copy.store))
    root.dispatchEvent(paste.e)
    expect(editor.getJSON().children.map((b) => (b.children![0] as { text: string }).text)).toEqual([
      'one',
      'twoone',
      'two',
    ])
    const all = ids(editor.getJSON())
    expect(new Set(all).size).toBe(all.length)
  })

  it('pasted json cannot nest blocks inside a paragraph', () => {
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1))
    const root = mount(editor)
    const nested = (depth: number, text: string): unknown =>
      depth === 0 ? { text, marks: [] } : { id: `x${depth}`, type: 'paragraph', data: {}, children: [nested(depth - 1, text)] }
    const json = JSON.stringify([
      { id: 'o1', type: 'paragraph', data: {}, children: [{ text: 'x', marks: [] }, nested(3, 'deep')] },
      { id: 'o2', type: 'paragraph', data: {}, children: [nested(2, 'y')] },
    ])
    root.dispatchEvent(clipboardEvent('paste', { [HTE_MIME]: json }).e)
    const result = editor.getJSON()
    for (const block of result.children) {
      expect(block.type).toBe('paragraph')
      expect(block.children!.every(isText)).toBe(true)
    }
    expect(result.children.map((b) => b.children!.map((c) => (c as { text: string }).text).join(''))).toEqual([
      'axdeep',
      'yb',
    ])
  })

  it('an empty paste does nothing', () => {
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1))
    const root = mount(editor)
    const before = editor.state
    root.dispatchEvent(clipboardEvent('paste', {}).e)
    expect(editor.state).toBe(before)
  })

  it('paste while composing is ignored', () => {
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1))
    const root = mount(editor)
    editor.view!.composing = true
    const { e } = clipboardEvent('paste', { 'text/plain': 'zz' })
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.getJSON().children[0]!.children).toEqual([txt('ab')])
  })

  it('removes its listeners on unmount', () => {
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1))
    const root = mount(editor)
    editor.unmount()
    const { e } = clipboardEvent('paste', { 'text/plain': 'zz' })
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.getJSON().children[0]!.children).toEqual([txt('ab')])
  })
})

/** A paste event whose `clipboardData` also carries `files` (a plain stand-in for a FileList). */
function pasteWithFiles(data: Record<string, string>, files: File[]) {
  const { e } = clipboardEvent('paste', data)
  Object.defineProperty((e as unknown as { clipboardData: object }).clipboardData, 'files', { value: files })
  return e
}

describe('paste through the intent pipeline', () => {
  it('a plugin onBeforeInput claiming insertFromPaste with files gets the intent; the default does not insert', () => {
    const intents: InputIntent[] = []
    const files = definePlugin({
      name: 'files',
      onBeforeInput: (intent) => {
        if (intent.inputType !== 'insertFromPaste' || !intent.dataTransfer?.files.length) return false
        intents.push(intent)
        return true
      },
    })
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1), [testParagraph, testBold, files])
    const root = mount(editor)
    const e = pasteWithFiles({ 'text/plain': 'zz' }, [new File(['x'], 'a.png', { type: 'image/png' })])
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(intents).toHaveLength(1)
    expect(intents[0]!.data).toBeNull()
    expect(intents[0]!.dataTransfer!.files[0]!.name).toBe('a.png')
    expect(intents[0]!.range).toEqual(caret([0, 0], 1))
    expect(editor.getJSON().children[0]!.children).toEqual([txt('ab')])
  })

  it('without a claiming plugin, a text paste is inserted by the core default', () => {
    const seen: string[] = []
    const spy = definePlugin({
      name: 'spy',
      onBeforeInput: (intent) => {
        seen.push(intent.inputType)
        return false
      },
    })
    const editor = setup(doc(p('p1', txt('ab'))), caret([0, 0], 1), [testParagraph, testBold, spy])
    const root = mount(editor)
    root.dispatchEvent(pasteWithFiles({ 'text/plain': 'zz' }, []))
    expect(seen).toEqual(['insertFromPaste'])
    expect(editor.getJSON().children[0]!.children).toEqual([txt('azzb')])
  })
})

describe('clipboard with a node selection', () => {
  const atom = definePlugin({ name: 'atom', node: { kind: 'block', atom: true } })
  const content = () => doc(p('p1', txt('ab')), { id: 'a1', type: 'atom', data: { k: 1 } }, p('p2', txt('cd')))

  function setupNode() {
    const editor = setup(content(), caret([0, 0], 0), [testParagraph, testBold, atom])
    const tr = editor.createTransaction()
    tr.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
    editor.dispatch(tr)
    const root = mount(editor)
    return { editor, root }
  }

  it('copy puts the selected node in the json flavor', () => {
    const { editor, root } = setupNode()
    const { e, store } = clipboardEvent('copy')
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(JSON.parse(store.get(HTE_MIME)!)).toEqual([editor.state.doc.children[1]])
    expect(editor.state.doc.children[1]).toMatchObject({ type: 'atom', data: { k: 1 } })
    expect(store.has('text/plain')).toBe(true)
    expect(store.has('text/html')).toBe(true)
    expect(stripIds(editor.getJSON())).toEqual(stripIds(content()))
  })

  it('cut removes the node (origin input / deleteByCut); pasting it elsewhere inserts it with a fresh id', () => {
    const { editor, root } = setupNode()
    const metas: unknown[] = []
    editor.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    const cut = clipboardEvent('cut')
    root.dispatchEvent(cut.e)
    expect(cut.e.defaultPrevented).toBe(true)
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p('p1', txt('ab')), p('p2', txt('cd')))))
    expect(editor.state.selection).toEqual(caret([0, 0], 2))
    expect(metas).toContainEqual(expect.objectContaining({ origin: 'input', inputType: 'deleteByCut' }))

    // Paste it twice: the second copy must get a fresh id.
    for (let i = 0; i < 2; i++) root.dispatchEvent(clipboardEvent('paste', Object.fromEntries(cut.store)).e)
    const blocks = editor.getJSON().children
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'atom', 'atom', 'paragraph'])
    expect(blocks[1]!.data).toEqual({ k: 1 })
    const all = ids(editor.getJSON())
    expect(new Set(all).size).toBe(all.length)
  })

  it('paste with a node selection replaces the node', () => {
    const { editor, root } = setupNode()
    root.dispatchEvent(clipboardEvent('paste', { 'text/plain': 'zz' }).e)
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p('p1', txt('abzz')), p('p2', txt('cd')))))
    expect(editor.state.selection).toEqual(caret([0, 0], 4))
  })
})
