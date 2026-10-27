// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { ElementNode, Node, Selection } from '../../src/model/types'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: Node[]): ElementNode => ({
  id,
  type: 'paragraph',
  data: {},
  children,
})
const caret = (path: number[], offset: number): Selection => ({ anchor: { path, offset }, focus: { path, offset } })

function mount(children: ElementNode[], selection: Selection = caret([0, 0], 0)) {
  const editor = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(...children), selection })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  return { editor, root, view: editor.view! }
}

/** Lets pending MutationObserver callbacks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('mutation safety net', () => {
  it('reverts a leaf whose DOM text was changed directly; the model is unchanged', async () => {
    const { editor, root, view } = mount([p('p1', txt('hello'))])
    const before = editor.state.doc
    const leaf = view.renderer.leafAt([0, 0])!
    leaf.textContent = 'zzz'
    await flush()
    expect(root.textContent).toBe('hello')
    expect(view.renderer.leafAt([0, 0])!.textContent).toBe('hello')
    expect(editor.state.doc).toBe(before)
  })

  it('reverts a character-data change of the text node', async () => {
    const { root, view } = mount([p('p1', txt('hello'))])
    ;(view.renderer.leafAt([0, 0])!.firstChild as Text).data = 'zzz'
    await flush()
    expect(root.textContent).toBe('hello')
  })

  it('removes foreign nodes inserted into a block and re-adds removed blocks', async () => {
    const { editor, root } = mount([p('p1', txt('one')), p('p2', txt('two'))])
    const first = root.querySelector('p')!
    first.appendChild(document.createTextNode('junk'))
    root.lastElementChild!.remove()
    await flush()
    expect(Array.from(root.querySelectorAll('p')).map((el) => el.textContent)).toEqual(['one', 'two'])
    expect(editor.state.doc.children).toHaveLength(2)
  })

  it('ignores the renderer’s own mutations (no extra render)', async () => {
    const { editor, view } = mount([p('p1', txt('ab'))])
    let renders = 0
    const original = view.renderer.render.bind(view.renderer)
    view.renderer.render = (...args) => {
      renders++
      original(...args)
    }
    editor.dispatch(editor.createTransaction().insertText('x', caret([0, 0], 2)))
    expect(renders).toBe(1)
    await flush()
    expect(renders).toBe(1)
  })

  it('ignores mutations inside the composing leaf while composing', async () => {
    const { root, view } = mount([p('p1', txt('ab'))])
    const leaf = view.renderer.leafAt([0, 0])!
    view.composing = true
    view.composition = { leaf, path: [0, 0] }
    ;(leaf.firstChild as Text).data = 'abê'
    await flush()
    expect(root.textContent).toBe('abê')
  })

  it('still reverts mutations outside the composing leaf while composing, keeping the leaf', async () => {
    const { root, view } = mount([p('p1', txt('ab')), p('p2', txt('cd'))])
    const leaf = view.renderer.leafAt([0, 0])!
    view.composing = true
    view.composition = { leaf, path: [0, 0] }
    ;(leaf.firstChild as Text).data = 'abê'
    ;(view.renderer.leafAt([1, 0])!.firstChild as Text).data = 'zz'
    await flush()
    expect(Array.from(root.querySelectorAll('p')).map((el) => el.textContent)).toEqual(['abê', 'cd'])
    expect(view.renderer.leafAt([0, 0])).toBe(leaf)
  })

  it('stops observing on destroy', async () => {
    const { root, view } = mount([p('p1', txt('hello'))])
    view.destroy()
    view.renderer.leafAt([0, 0])!.textContent = 'zzz'
    await flush()
    expect(root.textContent).toBe('zzz')
  })
})
