// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import type { Doc, ElementNode, Selection } from '../../src/model/types'
import {
  definePlugin,
  isElement,
  isText,
  nodeEntries,
  nodeSelection,
  type AnyPlugin,
  type InputIntent,
  type Editor,
} from '../../src/index'
import { createTestEditor, doc, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: ReturnType<typeof txt>[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const range = (path: number[], offset: number, focusPath: number[], focusOffset: number): Selection => single({
  anchor: { path, offset },
  focus: { path: focusPath, offset: focusOffset },
})
const caret = (path: number[], offset: number): Selection => range(path, offset, path, offset)

const HTE_MIME = 'application/x-penline-fragment'

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

  // Safari may drop the custom JSON flavor: the HTML (and text) flavors alone must round-trip with fresh ids.
  it('pasting only the html flavor of a same-doc copy keeps the blocks and gives fresh, unique ids', () => {
    const editor = setup(doc(p('p1', txt('one')), p('p2', txt('two'))), range([0, 0], 0, [1, 0], 3))
    const root = mount(editor)
    const copy = clipboardEvent('copy')
    root.dispatchEvent(copy.e)
    copy.store.delete(HTE_MIME)
    const tr = editor.createTransaction()
    tr.setSelection(caret([1, 0], 3))
    editor.dispatch(tr)
    root.dispatchEvent(clipboardEvent('paste', Object.fromEntries(copy.store)).e)
    expect(editor.getJSON().children.map((b) => (b.children![0] as { text: string }).text)).toEqual([
      'one',
      'twoone',
      'two',
    ])
    const all = ids(editor.getJSON())
    expect(all).toHaveLength(3)
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
    expect(intents[0]!.range).toEqual(mainRange(caret([0, 0], 1)))
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

  it('paste with a node selection replaces the node in place', () => {
    const { editor, root } = setupNode()
    root.dispatchEvent(clipboardEvent('paste', { 'text/plain': 'zz' }).e)
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p('p1', txt('ab')), p('x', txt('zz')), p('p2', txt('cd')))))
    expect(editor.state.selection).toEqual(caret([1, 0], 2))
  })
})

describe('paste over a node-selected image', () => {
  const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true } })
  const content = () => doc(p('p1', txt('a')), { id: 'img', type: 'image', data: { src: 's' } }, p('p2', txt('b')))
  const texts = (d: Doc) => d.children.map((b) => (b.children ?? []).map((c) => (isText(c) ? c.text : `<${c.type}>`)).join(''))

  function setupImage() {
    const plugins = [testParagraph, testBold, image]
    const editor = setup(content(), caret([0, 0], 0), plugins)
    const tr = editor.createTransaction()
    tr.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
    editor.dispatch(tr)
    const root = mount(editor)
    return { editor, root }
  }

  it('pasting text over a selected image puts the text where the image was', () => {
    const { editor, root } = setupImage()
    root.dispatchEvent(clipboardEvent('paste', { 'text/plain': 'x' }).e)
    expect(editor.getJSON().children.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(texts(editor.getJSON())).toEqual(['a', 'x', 'b'])
    expect(editor.state.selection).toEqual(caret([1, 0], 1))
  })

  it('pasting HTML blocks over a selected image keeps their order in place', () => {
    const { editor, root } = setupImage()
    root.dispatchEvent(clipboardEvent('paste', { 'text/html': '<p>x</p><p>y</p>', 'text/plain': 'x\ny' }).e)
    expect(editor.getJSON().children.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph'])
    expect(texts(editor.getJSON())).toEqual(['a', 'x', 'y', 'b'])
    expect(editor.state.selection).toEqual(caret([2, 0], 1))
  })

  it('pasting a copied atom block over a selected image puts it in place', () => {
    const { editor, root } = setupImage()
    const block = [{ id: 'other', type: 'image', data: { src: 't' } }]
    root.dispatchEvent(clipboardEvent('paste', { [HTE_MIME]: JSON.stringify(block) }).e)
    expect(editor.getJSON().children.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph'])
    expect(editor.getJSON().children[1]!.data).toEqual({ src: 't' })
  })

  it('one undo restores the image', () => {
    const { editor, root } = setupImage()
    const before = editor.getJSON()
    const selected = editor.state.selection
    root.dispatchEvent(clipboardEvent('paste', { 'text/html': '<p>x</p><p>y</p>', 'text/plain': 'x\ny' }).e)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(before)
    expect(editor.state.selection).toEqual(selected)
  })

  it('paste over a node selection matches typing over it', () => {
    const pasted = setupImage()
    pasted.root.dispatchEvent(clipboardEvent('paste', { 'text/plain': 'x' }).e)
    document.body.replaceChildren()
    const typed = setupImage()
    typed.editor.commands.insertText('x')
    expect(stripIds(pasted.editor.getJSON())).toEqual(stripIds(typed.editor.getJSON()))
    expect(pasted.editor.state.selection).toEqual(typed.editor.state.selection)
  })
})
