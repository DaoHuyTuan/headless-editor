// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  definePlugin,
  modelToDom,
  readDomSelection,
  writeDomSelection,
  type AnyPlugin,
  type Doc,
  type Editor,
  type ElementNode,
  type Node,
  type NodeViewFactory,
  type NodeViewProps,
  type Selection,
  type TextNode,
} from '../../src/index'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

/** A non-atom block with inline content. */
const box = definePlugin({
  name: 'box',
  node: { kind: 'block', content: 'inline' },
})
/** A non-atom inline node with inline content. */
const chip = definePlugin({
  name: 'chip',
  node: { kind: 'inline', content: 'inline' },
})

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const b = (text: string): ElementNode => el('box', txt(text))

interface Recorded {
  created: { container: HTMLElement; props: NodeViewProps }[]
  updates: NodeViewProps[]
  destroyed: number
}

/** Wraps `contentDOM` in a `<section>` with a non-editable header. */
function boxView(): { factory: NodeViewFactory; rec: Recorded } {
  const rec: Recorded = { created: [], updates: [], destroyed: 0 }
  const factory: NodeViewFactory = (container, props) => {
    rec.created.push({ container, props })
    const section = document.createElement('section')
    const header = document.createElement('div')
    header.className = 'header'
    header.setAttribute('contenteditable', 'false')
    header.textContent = 'Box'
    section.append(header, props.contentDOM!)
    container.append(section)
    return {
      update: (next) => {
        rec.updates.push(next)
      },
      destroy: () => {
        rec.destroyed++
      },
    }
  }
  return { factory, rec }
}

function mount(content: Doc, opts: { selection?: Selection; plugins?: AnyPlugin[]; factory?: NodeViewFactory } = {}) {
  const view = boxView()
  const editor = createTestEditor({
    plugins: opts.plugins ?? [testParagraph, testBold, box, chip],
    doc: content,
    selection: opts.selection,
    nodeViews: { box: opts.factory ?? view.factory },
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  return { editor, root, view: editor.view!, rec: view.rec }
}

const container = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-hte-node-view]')!
const contentOf = (root: HTMLElement) => container(root).querySelector<HTMLElement>('[data-hte-content]')!
const header = (root: HTMLElement) => container(root).querySelector<HTMLElement>('.header')!
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const texts = (editor: Editor) =>
  editor.state.doc.children.map((n) => (n.children ?? []).map((t) => (t as TextNode).text).join(''))

function beforeInput(target: EventTarget, init: InputEventInit): InputEvent {
  const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

function setDomCaret(editor: Editor, path: number[], offset: number): void {
  const pos = modelToDom(editor.view!.renderer, { path, offset })
  document.getSelection()!.setBaseAndExtent(pos.node, pos.offset, pos.node, pos.offset)
}

afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('non-atom node views: rendering', () => {
  it('accepts a node view for a non-atom type', () => {
    expect(() =>
      createTestEditor({ plugins: [testParagraph, box], nodeViews: { box: boxView().factory } }),
    ).not.toThrow()
  })

  it('creates an editable container and a contentDOM holding the children', () => {
    const { editor, root, rec } = mount(doc(p('a'), b('hello'), p('z')))
    expect(rec.created).toHaveLength(1)
    const { container: c, props } = rec.created[0]!
    expect(c).toBe(container(root))
    expect(c.hasAttribute('contenteditable')).toBe(false)
    const content = props.contentDOM!
    expect(content.tagName).toBe('DIV')
    expect(content.getAttribute('data-hte-content')).toBe('')
    expect(content.getAttribute('contenteditable')).toBe('true')
    expect(content.parentElement!.tagName).toBe('SECTION')
    expect(content.textContent).toBe('hello')
    expect(editor.view!.renderer.leafAt([1, 0])!.parentElement).toBe(content)
    expect(header(root).textContent).toBe('Box')
  })

  it('an inline non-atom node view gets a <span> contentDOM', () => {
    let content: HTMLElement | undefined
    const factory: NodeViewFactory = (c, props) => {
      content = props.contentDOM
      c.append(props.contentDOM!)
      return { update: () => {}, destroy: () => {} }
    }
    const editor = createTestEditor({
      plugins: [testParagraph, chip],
      doc: doc(p('a', el('chip', txt('x')), 'b')),
      nodeViews: { chip: factory },
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    expect(content!.tagName).toBe('SPAN')
    expect(content!.textContent).toBe('x')
    expect(root.textContent).toContain('x')
  })

  it('edits patch inside contentDOM: same contentDOM, same container, the view is not updated', () => {
    const { editor, root, rec } = mount(doc(p('a'), b('hello')), { selection: sel([1, 0], 5) })
    const content = contentOf(root)
    const leaf = editor.view!.renderer.leafAt([1, 0])
    editor.commands.insertText('!')
    expect(texts(editor)).toEqual(['a', 'hello!'])
    expect(contentOf(root)).toBe(content)
    expect(content.textContent).toBe('hello!')
    expect(editor.view!.renderer.leafAt([1, 0])).toBe(leaf)
    expect(rec.created).toHaveLength(1)
    expect(rec.updates).toHaveLength(0)
  })

  it('a data change updates the view with the same contentDOM', () => {
    const { editor, root, rec } = mount(doc(p('a'), b('hello')))
    const content = contentOf(root)
    editor.commands.setNodeData([1], { tone: 'warn' })
    expect(rec.updates).toHaveLength(1)
    expect(rec.updates[0]!.contentDOM).toBe(content)
    expect(contentOf(root)).toBe(content)
    expect(content.textContent).toBe('hello')
  })

  it('removing the node destroys the view; undo creates it again with its content', () => {
    const { editor, root, rec } = mount(doc(p('a'), b('hello'), p('z')))
    const tr = editor.createTransaction()
    tr.removeNode([1])
    editor.dispatch(tr)
    expect(rec.destroyed).toBe(1)
    expect(root.querySelector('[data-hte-node-view]')).toBeNull()
    editor.commands.undo()
    expect(rec.created).toHaveLength(2)
    expect(contentOf(root).textContent).toBe('hello')
  })
})

describe('non-atom node views: editing', () => {
  it('typing inside the box edits its text', () => {
    const { editor, root } = mount(doc(p('a'), b('hello')), { selection: sel([0, 0], 1) })
    setDomCaret(editor, [1, 0], 5)
    const e = beforeInput(contentOf(root).firstChild!, { inputType: 'insertText', data: '!' })
    expect(e.defaultPrevented).toBe(true)
    expect(texts(editor)).toEqual(['a', 'hello!'])
    expect(contentOf(root).textContent).toBe('hello!')
  })

  it('stopEvent applies outside contentDOM only: events inside it are editor content', () => {
    const stopping = box.extend({ stopEvent: () => true })
    const { editor, root } = mount(doc(p('a'), b('hello')), {
      selection: sel([1, 0], 5),
      plugins: [testParagraph, stopping],
    })
    const outside = beforeInput(header(root), { inputType: 'insertText', data: 'x' })
    expect(outside.defaultPrevented).toBe(false)
    expect(texts(editor)).toEqual(['a', 'hello'])
    const inside = beforeInput(contentOf(root).firstChild!, { inputType: 'insertText', data: '!' })
    expect(inside.defaultPrevented).toBe(true)
    expect(texts(editor)).toEqual(['a', 'hello!'])
  })

  it('data-editor-ignore around contentDOM does not make its content ignored', () => {
    const factory: NodeViewFactory = (c, props) => {
      const wrap = document.createElement('div')
      wrap.setAttribute('data-editor-ignore', '')
      wrap.append(props.contentDOM!)
      c.append(wrap)
      return { update: () => {}, destroy: () => {} }
    }
    const { editor, root } = mount(doc(p('a'), b('hello')), { selection: sel([1, 0], 5), factory })
    const e = beforeInput(contentOf(root).firstChild!, { inputType: 'insertText', data: '!' })
    expect(e.defaultPrevented).toBe(true)
    expect(texts(editor)).toEqual(['a', 'hello!'])
  })

  it('IME composition inside the box commits into its text', () => {
    const { editor, root, view } = mount(doc(p('a'), b('ab')), { selection: sel([1, 0], 1) })
    const fire = (type: string) => contentOf(root).dispatchEvent(new Event(type, { bubbles: true }))
    fire('compositionstart')
    expect(view.composition?.leaf).toBe(view.renderer.leafAt([1, 0]))
    const leaf = view.renderer.leafAt([1, 0])!
    ;(leaf.firstChild as Text).data = 'aêb'
    fire('compositionend')
    expect(texts(editor)).toEqual(['a', 'aêb'])
    expect(editor.state.selection).toEqual(sel([1, 0], 2))
    expect(contentOf(root).textContent).toBe('aêb')
  })
})

describe('non-atom node views: mutations', () => {
  it('the header is not editable and its mutations are ignored', async () => {
    const { editor, root, rec } = mount(doc(p('a'), b('hello')))
    expect(header(root).getAttribute('contenteditable')).toBe('false')
    const before = editor.state.doc
    header(root).textContent = 'Changed'
    await flush()
    expect(header(root).textContent).toBe('Changed')
    expect(editor.state.doc).toBe(before)
    expect(rec.created).toHaveLength(1)
  })

  it('a foreign mutation inside contentDOM is reverted from the model (no rebuild)', async () => {
    const { editor, root, rec } = mount(doc(p('a'), b('hello')))
    const before = editor.state.doc
    ;(contentOf(root).firstChild!.firstChild as Text).data = 'zzz'
    contentOf(root).append(document.createTextNode('stray'))
    await flush()
    expect(contentOf(root).textContent).toBe('hello')
    expect(editor.state.doc).toBe(before)
    expect(rec.created).toHaveLength(1)
  })

  it('ignoreMutation applies outside contentDOM; moving contentDOM is never reverted', async () => {
    const strict = box.extend({ ignoreMutation: () => false })
    const { root, rec } = mount(doc(p('a'), b('hello')), { plugins: [testParagraph, strict] })
    const content = contentOf(root)
    const holder = document.createElement('div')
    container(root).querySelector('section')!.append(holder)
    await flush()
    // The added holder is the view's own DOM outside contentDOM: ignoreMutation(false) rebuilds.
    expect(rec.created).toHaveLength(2)
    expect(rec.destroyed).toBe(1)
    // The rebuilt view placed its new contentDOM; moving it into another element is the view's business.
    const next = contentOf(root)
    expect(next).not.toBe(content)
    container(root).append(next)
    await flush()
    expect(rec.created).toHaveLength(2)
    expect(contentOf(root)).toBe(next)
    expect(next.parentElement).toBe(container(root))
    expect(next.textContent).toBe('hello')
  })
})

describe('non-atom node views: selection', () => {
  it('a caret inside the box round-trips between the model and the DOM', () => {
    const { editor, root } = mount(doc(p('a'), b('hello')), { selection: sel([1, 0], 3) })
    const domSel = document.getSelection()!
    expect(contentOf(root).contains(domSel.anchorNode)).toBe(true)
    expect(readDomSelection(editor.view!.renderer, domSel)).toEqual(sel([1, 0], 3))
    const range: Selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [1, 0], offset: 4 } }
    writeDomSelection(editor.view!.renderer, range, domSel)
    expect(readDomSelection(editor.view!.renderer, domSel)).toEqual(range)
  })

  it('the sibling-header layout keeps the path to contentDOM editable (no warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { root } = mount(doc(p('a'), b('hello')), { selection: sel([1, 0], 2) })
    for (let cur = contentOf(root).parentElement; cur && cur !== root; cur = cur.parentElement) {
      expect(cur.getAttribute('contenteditable')).not.toBe('false')
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once when contentDOM is placed under a contenteditable="false" ancestor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let later: (() => void) | undefined
    const wrapped: NodeViewFactory = (c, props) => {
      const wrap = document.createElement('div')
      wrap.setAttribute('contenteditable', 'false')
      wrap.append(props.contentDOM!)
      c.append(wrap)
      return { update: () => {}, destroy: () => {} }
    }
    mount(doc(p('a'), b('hello')), { factory: wrapped })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('contenteditable="false"')
    document.body.replaceChildren()
    warn.mockClear()
    // Placed later (after the render): seen by the mutation module.
    const deferred: NodeViewFactory = (c, props) => {
      const wrap = document.createElement('div')
      wrap.setAttribute('contenteditable', 'false')
      c.append(wrap)
      later = () => wrap.append(props.contentDOM!)
      return { update: () => {}, destroy: () => {} }
    }
    mount(doc(p('a'), b('hello')), { factory: deferred })
    expect(warn).not.toHaveBeenCalled()
    later!()
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('syncSelection does not overwrite a selection whose leaves are not placed yet; placing them shows it', async () => {
    let place: (() => void) | undefined
    const deferred: NodeViewFactory = (c, props) => {
      place = () => c.append(props.contentDOM!)
      return { update: () => {}, destroy: () => {} }
    }
    const { editor, root, view } = mount(doc(p('a'), b('hello')), { selection: sel([1, 0], 5), factory: deferred })
    expect(root.contains(view.renderer.leafAt([1, 0]))).toBe(false)
    // A stale DOM caret the browser collapsed into the root.
    document.getSelection()!.setBaseAndExtent(root, 1, root, 1)
    let dispatched = 0
    editor.on('transaction', () => dispatched++)
    view.syncSelection()
    expect(dispatched).toBe(0)
    expect(editor.state.selection).toEqual(sel([1, 0], 5))

    place!()
    await flush()
    const domSel = document.getSelection()!
    expect(contentOf(root).contains(domSel.anchorNode)).toBe(true)
    expect(readDomSelection(view.renderer, domSel)).toEqual(sel([1, 0], 5))
    view.syncSelection()
    expect(dispatched).toBe(0)
  })

  it('the DOM caret left behind when the model moves into an unplaced box is stale; a user move is read', async () => {
    const places: (() => void)[] = []
    const deferred: NodeViewFactory = (c, props) => {
      places.push(() => c.append(props.contentDOM!))
      return { update: () => {}, destroy: () => {} }
    }
    const { editor, root, view } = mount(doc(p('abc')), { selection: sel([0, 0], 3), factory: deferred })
    const domSel = document.getSelection()!
    expect(view.renderer.leafAt([0, 0])!.contains(domSel.anchorNode)).toBe(true)
    // A command inserts a box and puts the caret in it: the DOM caret stays in the paragraph.
    const tr = editor.createTransaction()
    tr.insertNode([1], b('hello'))
    tr.setSelection(sel([1, 0], 5))
    editor.dispatch(tr)
    expect(view.renderer.leafAt([0, 0])!.contains(domSel.anchorNode)).toBe(true)
    let dispatched = 0
    editor.on('transaction', () => dispatched++)
    view.syncSelection()
    expect(dispatched).toBe(0)
    expect(editor.state.selection).toEqual(sel([1, 0], 5))

    // The user moves the caret (another offset in the paragraph): read.
    setDomCaret(editor, [0, 0], 1)
    view.syncSelection()
    expect(dispatched).toBe(1)
    expect(editor.state.selection).toEqual(sel([0, 0], 1))

    // Back into the box, then the box is placed: the selection is written into it.
    const back = editor.createTransaction()
    back.setSelection(sel([1, 0], 2))
    editor.dispatch(back)
    view.syncSelection()
    expect(editor.state.selection).toEqual(sel([1, 0], 2))
    places.at(-1)!()
    await flush()
    expect(contentOf(root).contains(domSel.anchorNode)).toBe(true)
    expect(readDomSelection(view.renderer, domSel)).toEqual(sel([1, 0], 2))
  })

  it('a DOM caret the user put in a placed leaf is still read while another leaf is detached', () => {
    const deferred: NodeViewFactory = () => ({ update: () => {}, destroy: () => {} })
    const { editor, view } = mount(doc(p('abc'), b('hello')), { selection: sel([1, 0], 5), factory: deferred })
    setDomCaret(editor, [0, 0], 2)
    view.syncSelection()
    expect(editor.state.selection).toEqual(sel([0, 0], 2))
  })

  it('a DOM position in the header maps to a boundary of the box text', () => {
    const { editor, root } = mount(doc(p('a'), b('hello')))
    const point = editor.view!.renderer
    const text = header(root).firstChild!
    const domSel = document.getSelection()!
    domSel.setBaseAndExtent(text, 1, text, 1)
    const read = readDomSelection(point, domSel)
    expect(read?.anchor.path).toEqual([1, 0])
  })
})
