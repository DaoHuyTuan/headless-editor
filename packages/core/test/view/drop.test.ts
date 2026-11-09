// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mainRange } from '../../src/model/selection'
import { definePlugin, type AnyPlugin, type Editor, type InputIntent, type Selection } from '../../src/index'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (...texts: string[]) => el('paragraph', ...texts.map((t) => txt(t)))

function mount(editor: Editor) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  return root
}

/** A DataTransfer stand-in backed by a map, with `types` and `files`. */
function transfer(data: Record<string, string>, files: File[] = []) {
  const store = new Map(Object.entries(data))
  return {
    getData: (t: string) => store.get(t) ?? '',
    setData: (t: string, v: string) => void store.set(t, v),
    get types() {
      return [...store.keys(), ...(files.length > 0 ? ['Files'] : [])]
    },
    files,
  }
}

function dragEvent(type: string, dataTransfer: unknown, x = 0, y = 0) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(e, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: x },
    clientY: { value: y },
  })
  return e
}

/** Makes `document.caretRangeFromPoint` return `(node, offset)` (happy-dom has neither caret API). */
function stubCaretRange(node: globalThis.Node, offset: number) {
  const calls: [number, number][] = []
  Object.defineProperty(document, 'caretRangeFromPoint', {
    configurable: true,
    value: (x: number, y: number) => {
      calls.push([x, y])
      const r = document.createRange()
      r.setStart(node, offset)
      return r
    },
  })
  return calls
}

function textNodeOf(root: HTMLElement, text: string): globalThis.Node {
  const walker = document.createTreeWalker(root, 4)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data === text) return n
  throw new Error(`no text ${text}`)
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).caretRangeFromPoint
  delete (document as unknown as Record<string, unknown>).caretPositionFromPoint
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function setup(selection: Selection, plugins: AnyPlugin[] = [testParagraph, testBold]) {
  return createTestEditor({ plugins, doc: doc(p('ab'), p('cdef')), selection })
}

describe('drop module', () => {
  it('a text/plain drop inserts at the drop point (origin input / insertFromDrop)', () => {
    const editor = setup(sel([0, 0], 0))
    const root = mount(editor)
    const calls = stubCaretRange(textNodeOf(root, 'cdef'), 2)
    const metas: unknown[] = []
    editor.on('transaction', ({ tr }) => metas.push({ ...tr.meta }))
    const e = dragEvent('drop', transfer({ 'text/plain': 'XY' }), 11, 22)
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(calls).toEqual([[11, 22]])
    expect(editor.getJSON().children.map((b) => (b.children![0] as { text: string }).text)).toEqual(['ab', 'cdXYef'])
    expect(editor.state.selection).toEqual(sel([1, 0], 4))
    expect(metas).toContainEqual(expect.objectContaining({ origin: 'input', inputType: 'insertFromDrop' }))
  })

  it('a drop with nothing to insert leaves the selection alone', () => {
    const editor = setup(sel([0, 0], 1))
    const root = mount(editor)
    stubCaretRange(textNodeOf(root, 'cdef'), 2)
    const trs: unknown[] = []
    editor.on('transaction', ({ tr }) => trs.push(tr))
    root.dispatchEvent(dragEvent('drop', transfer({ 'application/x-other': 'x' })))
    expect(editor.state.selection).toEqual(sel([0, 0], 1))
    expect(trs).toHaveLength(0)
  })

  it('uses caretPositionFromPoint when available', () => {
    const editor = setup(sel([0, 0], 0))
    const root = mount(editor)
    const node = textNodeOf(root, 'ab')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: node, offset: 1 }),
    })
    stubCaretRange(textNodeOf(root, 'cdef'), 2)
    root.dispatchEvent(dragEvent('drop', transfer({ 'text/plain': 'Z' })))
    expect(editor.getJSON().children.map((b) => (b.children![0] as { text: string }).text)).toEqual(['aZb', 'cdef'])
  })

  it('falls back to the selection when the point cannot be mapped', () => {
    const editor = setup(sel([0, 0], 1))
    const root = mount(editor)
    root.dispatchEvent(dragEvent('drop', transfer({ 'text/plain': 'Z' })))
    expect(editor.getJSON().children.map((b) => (b.children![0] as { text: string }).text)).toEqual(['aZb', 'cdef'])
  })

  it('a plugin onBeforeInput gets the drop intent with the drop point as range', () => {
    const intents: InputIntent[] = []
    const files = definePlugin({
      name: 'files',
      onBeforeInput: (intent) => {
        if (intent.inputType !== 'insertFromDrop' || !intent.dataTransfer?.files.length) return false
        intents.push(intent)
        return true
      },
    })
    const editor = setup(sel([0, 0], 0), [testParagraph, testBold, files])
    const root = mount(editor)
    stubCaretRange(textNodeOf(root, 'cdef'), 3)
    root.dispatchEvent(dragEvent('drop', transfer({ 'text/plain': 'Z' }, [new File(['x'], 'a.png')])))
    expect(intents).toHaveLength(1)
    expect(intents[0]!.range).toEqual(mainRange(sel([1, 0], 3)))
    expect(intents[0]!.data).toBeNull()
    expect(editor.getJSON().children.map((b) => (b.children![0] as { text: string }).text)).toEqual(['ab', 'cdef'])
  })

  it('dragstart inside the root is prevented', () => {
    const editor = setup(sel([0, 0], 0))
    const root = mount(editor)
    const e = dragEvent('dragstart', transfer({}))
    textNodeOf(root, 'ab').parentNode!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('dragover with text or files is allowed (prevented); other content is not', () => {
    const editor = setup(sel([0, 0], 0))
    const root = mount(editor)
    const text = dragEvent('dragover', transfer({ 'text/plain': 'x' }))
    const file = dragEvent('dragover', transfer({}, [new File(['x'], 'a.png')]))
    const other = dragEvent('dragover', transfer({ 'application/x-other': 'x' }))
    root.dispatchEvent(text)
    root.dispatchEvent(file)
    root.dispatchEvent(other)
    expect([text.defaultPrevented, file.defaultPrevented, other.defaultPrevented]).toEqual([true, true, false])
  })

  it('leaves drops and drags in ignored regions (of a node view) alone', () => {
    const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true } })
    const editor = createTestEditor({
      plugins: [testParagraph, testBold, image],
      doc: doc(p('ab'), p('cdef'), el('image', { src: 'a.png' })),
      selection: sel([0, 0], 0),
      nodeViews: {
        image: (container) => {
          const ignored = document.createElement('span')
          ignored.setAttribute('data-editor-ignore', '')
          container.append(ignored)
          return { update: () => {}, destroy: () => {} }
        },
      },
    })
    const root = mount(editor)
    const ignored = root.querySelector('[data-editor-ignore]')!
    const drop = dragEvent('drop', transfer({ 'text/plain': 'Z' }))
    const start = dragEvent('dragstart', transfer({}))
    ignored.dispatchEvent(drop)
    ignored.dispatchEvent(start)
    expect([drop.defaultPrevented, start.defaultPrevented]).toEqual([false, false])
    expect(editor.getJSON().children.slice(0, 2).map((b) => (b.children![0] as { text: string }).text)).toEqual(['ab', 'cdef'])
  })

  it('removes its listeners on unmount', () => {
    const editor = setup(sel([0, 0], 0))
    const root = mount(editor)
    editor.unmount()
    const e = dragEvent('drop', transfer({ 'text/plain': 'Z' }))
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
