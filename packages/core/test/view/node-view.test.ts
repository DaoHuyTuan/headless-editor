// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  definePlugin,
  findPathById,
  nodeSelection,
  type AnyPlugin,
  type Doc,
  type ElementNode,
  type Node,
  type NodeViewFactory,
  type NodeViewProps,
  type Selection,
} from '../../src/index'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const image = definePlugin({
  name: 'image',
  node: { kind: 'block', atom: true },
  options: { label: 'first' },
})
const emoji = definePlugin({
  name: 'emoji',
  node: { kind: 'inline', atom: true },
})

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const img = (data: Record<string, string> = { src: 'a.png', alt: '' }): ElementNode => el('image', data)
const caret = (path: number[], offset: number): Selection => sel(path, offset)

interface Recorded {
  created: { container: HTMLElement; props: NodeViewProps }[]
  updates: NodeViewProps[]
  destroyed: number
}

/** A node view that records its calls and renders an alt `<input data-editor-ignore>`. */
function recordingView(): { factory: NodeViewFactory; rec: Recorded } {
  const rec: Recorded = { created: [], updates: [], destroyed: 0 }
  const factory: NodeViewFactory = (container, props) => {
    rec.created.push({ container, props })
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = 'view'
    const input = document.createElement('input')
    input.setAttribute('data-editor-ignore', '')
    container.append(label, input)
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

function mount(
  content: Doc,
  opts: {
    selection?: Selection
    plugins?: AnyPlugin[]
    factory?: NodeViewFactory
  } = {},
) {
  const view = recordingView()
  const factory = opts.factory ?? view.factory
  const editor = createTestEditor({
    plugins: opts.plugins ?? [testParagraph, testBold, image, emoji],
    doc: content,
    selection: opts.selection,
    nodeViews: { image: factory },
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  return { editor, root, view: editor.view!, rec: view.rec }
}

const container = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-hte-node-view]')!
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('node views: registration', () => {
  it('throws for a non-atom node type', () => {
    expect(() =>
      createTestEditor({
        plugins: [testParagraph],
        nodeViews: { paragraph: recordingView().factory },
      }),
    ).toThrow('Non-atom node views arrive in M3')
  })
})

describe('node views: renderer', () => {
  it('mounting creates the container and calls the factory once with the props', () => {
    const { editor, root, rec } = mount(doc(p('a'), img(), p('b')))
    expect(rec.created).toHaveLength(1)
    const { container: c, props } = rec.created[0]!
    expect(c).toBe(container(root))
    expect(c.tagName).toBe('DIV')
    expect(c.getAttribute('data-hte-id')).toBe(editor.state.doc.children[1]!.id)
    expect(c.getAttribute('data-hte-node-view')).toBe('')
    expect(c.getAttribute('contenteditable')).toBe('false')
    expect(props.node).toBe(editor.state.doc.children[1])
    expect(props.node.data).toEqual({ src: 'a.png', alt: '' })
    expect(props.selected).toBe(false)
    expect(props.editor).toBe(editor)
    expect(props.options).toEqual({ label: 'first' })
    expect(props.getPos()).toEqual([1])
    expect(c.querySelector('.label')!.textContent).toBe('view')
  })

  it('setNodeData calls update with the new data and keeps the same container', () => {
    const { editor, root, rec } = mount(doc(p('a'), img()))
    const before = container(root)
    editor.commands.setNodeData([1], { alt: 'cat' })
    expect(rec.created).toHaveLength(1)
    expect(rec.updates).toHaveLength(1)
    expect(rec.updates[0]!.node.data).toEqual({ src: 'a.png', alt: 'cat' })
    expect(rec.updates[0]!.node).toBe(editor.state.doc.children[1])
    expect(container(root)).toBe(before)
    expect(before.querySelector('.label')!.textContent).toBe('view')
  })

  it('an unrelated edit does not update the view', () => {
    const { editor, rec } = mount(doc(p('a'), img()), {
      selection: caret([0, 0], 1),
    })
    editor.commands.insertText('x')
    expect(rec.updates).toHaveLength(0)
  })

  it('removing the node destroys the view; an undo that re-inserts it creates it again', () => {
    const { editor, root, rec } = mount(doc(p('a'), img(), p('b')))
    const tr = editor.createTransaction()
    tr.removeNode([1])
    editor.dispatch(tr)
    expect(rec.destroyed).toBe(1)
    expect(root.querySelector('[data-hte-node-view]')).toBeNull()
    editor.commands.undo()
    expect(rec.created).toHaveLength(2)
    expect(container(root)).toBe(rec.created[1]!.container)
  })

  it('setPluginOptions calls update with the new options (same container)', () => {
    const { editor, root, rec } = mount(doc(p('a'), img()))
    const before = container(root)
    editor.setPluginOptions('image', { label: 'second' })
    expect(rec.updates.at(-1)!.options).toEqual({ label: 'second' })
    expect(container(root)).toBe(before)
    expect(rec.created).toHaveLength(1)
  })

  it('a node selection sets data-hte-selected and selected: true; leaving it clears both', () => {
    const { editor, root, rec } = mount(doc(p('a'), img(), p('b')))
    const tr = editor.createTransaction()
    tr.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
    editor.dispatch(tr)
    expect(container(root).hasAttribute('data-hte-selected')).toBe(true)
    expect(rec.updates.at(-1)!.selected).toBe(true)
    const back = editor.createTransaction()
    back.setSelection(caret([0, 0], 0))
    editor.dispatch(back)
    expect(container(root).hasAttribute('data-hte-selected')).toBe(false)
    expect(rec.updates.at(-1)!.selected).toBe(false)
  })

  it('marks a selected atom without a node view and an unknown block too', () => {
    const editor = createTestEditor({
      plugins: [testParagraph, image],
      doc: doc(p('a'), img(), el('mystery', txt('x'))),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    const tr = editor.createTransaction()
    tr.setSelection(nodeSelection(editor.state.doc, editor.registry, [2]))
    editor.dispatch(tr)
    expect(root.querySelector('[data-hte-unknown]')!.hasAttribute('data-hte-selected')).toBe(true)
    const tr2 = editor.createTransaction()
    tr2.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
    editor.dispatch(tr2)
    expect(root.querySelector('[data-hte-unknown]')!.hasAttribute('data-hte-selected')).toBe(false)
    expect(root.querySelectorAll('[data-hte-selected]')).toHaveLength(1)
  })

  it('getPos() follows the node after an insert before it', () => {
    const { editor, rec } = mount(doc(p('a'), img()))
    const tr = editor.createTransaction()
    tr.insertNode([0], p('new'))
    editor.dispatch(tr)
    expect(rec.created[0]!.props.getPos()).toEqual([2])
  })

  it('updateData changes the doc (origin command, one undo step) and returns false once removed', () => {
    const { editor, rec } = mount(doc(p('a'), img()))
    const origins: unknown[] = []
    editor.on('transaction', ({ tr }) => origins.push(tr.meta.origin))
    expect(rec.created[0]!.props.updateData({ alt: 'x' })).toBe(true)
    expect(editor.state.doc.children[1]!.data).toEqual({
      src: 'a.png',
      alt: 'x',
    })
    expect(origins).toEqual(['command'])
    const tr = editor.createTransaction()
    tr.removeNode([1])
    editor.dispatch(tr)
    expect(rec.created[0]!.props.getPos()).toBeNull()
    expect(rec.created[0]!.props.updateData({ alt: 'y' })).toBe(false)
  })

  it('unmounting the editor destroys the node views', () => {
    const { editor, rec } = mount(doc(p('a'), img()))
    editor.unmount()
    expect(rec.destroyed).toBe(1)
  })
})

describe('node views: ignored regions', () => {
  it('a keydown inside a data-editor-ignore input is not prevented and runs no keymap', () => {
    const { editor, root } = mount(doc(p('a'), img()), {
      selection: caret([0, 0], 1),
    })
    editor.view!.focus()
    const input = container(root).querySelector('input')!
    const before = editor.state
    const e = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.state).toBe(before)
  })

  it('Backspace in the input (beforeinput from it) leaves the doc unchanged and is not prevented', () => {
    const { editor, root } = mount(doc(p('a'), img()), {
      selection: caret([0, 0], 1),
    })
    const input = container(root).querySelector('input')!
    const before = editor.state.doc
    const e = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.state.doc).toBe(before)
  })

  it('clipboard events from the input are left to the browser', () => {
    const { root } = mount(doc(p('a'), img()))
    const input = container(root).querySelector('input')!
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    input.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(false)
  })

  it('stopEvent lets a plugin claim events inside its node view', () => {
    const stopping = image.extend({
      stopEvent: (event: Event) => event.type === 'keydown',
    })
    const { editor, root } = mount(doc(p('a'), img()), {
      selection: caret([0, 0], 1),
      plugins: [testParagraph, testBold, stopping, emoji],
    })
    const label = container(root).querySelector('.label')!
    const before = editor.state
    const e = new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    label.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.state).toBe(before)
  })

  it('a focused data-editor-ignore input keeps the focus and the model selection across updates', () => {
    const { editor, root, rec } = mount(doc(p('a'), img()), {
      selection: caret([0, 0], 1),
    })
    const input = container(root).querySelector('input')!
    input.focus()
    expect(document.activeElement).toBe(input)
    const selBefore = editor.state.selection
    document.dispatchEvent(new Event('selectionchange'))
    expect(editor.state.selection).toBe(selBefore)
    rec.created[0]!.props.updateData({ alt: 'typed' })
    expect(document.activeElement).toBe(input)
    expect(editor.state.selection).toEqual(selBefore)
  })
})

describe('node views: mutations', () => {
  it('a mutation inside the container does not re-render', async () => {
    const { root, view } = mount(doc(p('a'), img()))
    let renders = 0
    view.renderer.onRendered(() => renders++)
    const label = container(root).querySelector('.label')!
    label.textContent = 'changed by the view'
    container(root).setAttribute('data-x', '1')
    container(root).appendChild(document.createElement('b'))
    await flush()
    expect(renders).toBe(0)
    expect(label.textContent).toBe('changed by the view')
  })

  it('a plugin ignoreMutation returning false gets the mutation reverted', async () => {
    const strict = image.extend({ ignoreMutation: () => false })
    const { root, rec } = mount(doc(p('a'), img()), {
      plugins: [testParagraph, testBold, strict, emoji],
    })
    container(root).querySelector('.label')!.textContent = 'tampered'
    await flush()
    expect(container(root).querySelector('.label')!.textContent).toBe('view')
    expect(container(root).textContent).toBe('view')
    expect(rec.destroyed).toBe(1)
    expect(rec.created).toHaveLength(2)
  })

  it('mutations inside data-editor-ignore are always ignored', async () => {
    const strict = image.extend({ ignoreMutation: () => false })
    const { root, view } = mount(doc(p('a'), img()), {
      plugins: [testParagraph, testBold, strict, emoji],
    })
    let renders = 0
    view.renderer.onRendered(() => renders++)
    container(root).querySelector('input')!.appendChild(document.createTextNode('x'))
    await flush()
    expect(renders).toBe(0)
  })
})

describe('node views: click to select', () => {
  it('mousedown on the container selects the node, is prevented and focuses the root', () => {
    const { editor, root } = mount(doc(p('a'), img(), p('b')))
    const e = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    container(root).querySelector('.label')!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(editor.state.selection).toEqual({ ...caret([0, 0], 1), node: [1] })
    expect(document.activeElement).toBe(root)
    expect(container(root).hasAttribute('data-hte-selected')).toBe(true)
  })

  it('mousedown on the ignored input is left alone', () => {
    const { editor, root } = mount(doc(p('a'), img(), p('b')))
    const before = editor.state.selection
    const e = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    container(root).querySelector('input')!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(editor.state.selection).toBe(before)
  })

  it('mousedown on an unknown block selects it; on an inline atom it does not', () => {
    const editor = createTestEditor({
      plugins: [testParagraph, emoji],
      doc: doc(p('a', el('emoji'), 'b'), el('mystery', txt('x'))),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    const inline = root.querySelector('p [data-hte-id]')!
    const e1 = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    inline.dispatchEvent(e1)
    expect(e1.defaultPrevented).toBe(false)
    expect(editor.state.selection?.node).toBeUndefined()
    const e2 = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    root.querySelector('[data-hte-unknown]')!.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(true)
    expect(editor.state.selection?.node).toEqual([1])
  })
})

describe('node views: composition over a node selection', () => {
  it('replaces the selected node with an empty default block and composes into it', () => {
    const { editor, root, view } = mount(doc(p('a'), img(), p('b')))
    const tr = editor.createTransaction()
    tr.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
    editor.dispatch(tr)
    view.focus()
    root.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    expect(editor.state.doc.children.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(findPathById(editor.state.doc, 'n2')).toBeNull()
    expect(editor.state.selection).toEqual(caret([1, 0], 0))
    expect(view.composing).toBe(true)
    expect(view.composition).toEqual({
      leaf: view.renderer.leafAt([1, 0]),
      path: [1, 0],
    })
    // The IME writes into the new block; compositionend commits it there.
    const leaf = view.renderer.leafAt([1, 0])!
    leaf.replaceChildren(document.createTextNode('ế'))
    root.dispatchEvent(new Event('compositionend', { bubbles: true }))
    expect(editor.state.doc.children.map((b) => (b.children![0] as { text: string }).text)).toEqual(['a', 'ế', 'b'])
  })
})
