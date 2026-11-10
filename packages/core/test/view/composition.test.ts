// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mainRange, single } from '../../src/model/selection'
import type { ElementNode, Node, Selection, TextNode } from '../../src/model/types'
import { definePlugin, modelToDom } from '../../src/index'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: Node[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const caret = (path: number[], offset: number): Selection => single({ anchor: { path, offset }, focus: { path, offset } })
const range = (path: number[], from: number, to: number): Selection => single({
  anchor: { path, offset: from },
  focus: { path, offset: to },
})

function mount(children: ElementNode[], selection: Selection) {
  const editor = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(...children), selection })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  return { editor, root, view: editor.view! }
}

const fire = (root: HTMLElement, type: string) => root.dispatchEvent(new Event(type, { bubbles: true }))
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const texts = (editor: ReturnType<typeof mount>['editor']) =>
  editor.state.doc.children.map((b) => (b.children ?? []).map((t) => (t as TextNode).text).join(''))

/** What an IME does to the DOM: sets the text of the leaf at `path` in place. */
function imeWrite(view: ReturnType<typeof mount>['view'], path: number[], text: string) {
  const leaf = view.renderer.leafAt(path)!
  const textNode = leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text | null
  if (textNode) textNode.data = text
  else leaf.replaceChildren(leaf.ownerDocument.createTextNode(text))
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('composition', () => {
  it('compositionstart sets composing and remembers the leaf under the caret', () => {
    const { root, view } = mount([p('p1', txt('ab'))], caret([0, 0], 1))
    fire(root, 'compositionstart')
    expect(view.composing).toBe(true)
    expect(view.composition).toEqual({ leaf: view.renderer.leafAt([0, 0]), path: [0, 0] })
  })

  it('compositionend diffs the leaf text into one input tr with the caret after the inserted text', async () => {
    const { editor, root, view } = mount([p('p1', txt('abc'))], caret([0, 0], 2))
    const trs: { origin: unknown; inputType: unknown; ops: string[] }[] = []
    editor.on('transaction', ({ tr }) =>
      trs.push({ origin: tr.meta.origin, inputType: tr.meta.inputType, ops: tr.ops.map((o) => o.type).filter((t) => t !== 'set_selection') }),
    )
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'abêc')
    await flush()
    imeWrite(view, [0, 0], 'abếc')
    await flush()
    expect(texts(editor)).toEqual(['abc'])
    fire(root, 'compositionend')
    expect(view.composing).toBe(false)
    expect(view.composition).toBeNull()
    expect(texts(editor)).toEqual(['abếc'])
    expect(trs).toEqual([{ origin: 'input', inputType: 'insertCompositionText', ops: ['insert_text'] }])
    expect(editor.state.selection).toEqual(caret([0, 0], 3))
    expect(root.textContent).toBe('abếc')
  })

  it('replaces changed text with one remove_text + one insert_text', () => {
    const { editor, root, view } = mount([p('p1', txt('abXYc'))], caret([0, 0], 4))
    const ops: unknown[] = []
    editor.on('transaction', ({ tr }) => ops.push(...tr.ops.filter((o) => o.type !== 'set_selection')))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'ab你c')
    fire(root, 'compositionend')
    expect(ops).toEqual([
      { type: 'remove_text', path: [0, 0], offset: 2, text: 'XY' },
      { type: 'insert_text', path: [0, 0], offset: 2, text: '你' },
    ])
    expect(editor.state.selection).toEqual(caret([0, 0], 3))
  })

  it('reads the whole text of an empty leaf whose <br> the IME replaced', () => {
    const { editor, root, view } = mount([p('p1', txt(''))], caret([0, 0], 0))
    fire(root, 'compositionstart')
    view.renderer.leafAt([0, 0])!.replaceChildren(document.createTextNode('你好'))
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['你好'])
    expect(editor.state.selection).toEqual(caret([0, 0], 2))
  })

  it('keeps text the IME wrote next to the composing leaf instead of inside it', () => {
    const { editor, root, view } = mount([p('p1', txt('ab'))], caret([0, 0], 2))
    fire(root, 'compositionstart')
    const leaf = view.renderer.leafAt([0, 0])!
    leaf.after(leaf.ownerDocument.createTextNode('xy'))
    leaf.before(leaf.ownerDocument.createTextNode('<'))
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['<abxy'])
    expect(root.querySelectorAll('p > :not([data-hte-leaf])').length + [...root.querySelector('p')!.childNodes].filter((n) => n.nodeType === 3).length).toBe(0)
  })

  it('does not take a static text of the block renderHTML beside the leaf as IME text', () => {
    const label = definePlugin({ name: 'label', node: { kind: 'block', content: 'inline' }, renderHTML: () => ['p', 'L:', 0] })
    const editor = createTestEditor({
      plugins: [testParagraph, testBold, label],
      doc: doc({ id: 'l1', type: 'label', data: {}, children: [txt('ab')] }),
      selection: caret([0, 0], 2),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    editor.view!.focus()
    fire(root, 'compositionstart')
    imeWrite(editor.view!, [0, 0], 'abc')
    fire(root, 'compositionend')
    expect(editor.state.doc.children[0]!.children).toEqual([txt('abc')])
    expect(root.textContent).toBe('L:abc')
  })

  it('treats a leaf left with only its <br> as empty', () => {
    const { editor, root } = mount([p('p1', txt(''))], caret([0, 0], 0))
    let count = 0
    editor.on('transaction', () => count++)
    fire(root, 'compositionstart')
    fire(root, 'compositionend')
    expect(count).toBe(0)
    expect(texts(editor)).toEqual([''])
    expect(root.querySelector('br[data-hte-break]')).not.toBeNull()
  })

  it('keeps marks of the composing text', () => {
    const { editor, root, view } = mount([p('p1', txt('a'), txt('bc', 'bold'))], caret([0, 1], 1))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 1], 'b好c')
    fire(root, 'compositionend')
    expect(editor.state.doc.children[0]!.children).toEqual([txt('a'), txt('b好c', 'bold')])
    expect(root.querySelector('strong')!.textContent).toBe('b好c')
  })

  it('applies stored marks like typing: Mod-b at a caret, then compose → bold', () => {
    const { editor, root, view } = mount([p('p1', txt('ab'))], caret([0, 0], 1))
    editor.commands.toggleMark('bold')
    expect(editor.state.storedMarks).toEqual([{ type: 'bold', data: {} }])
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'aXb')
    fire(root, 'compositionend')
    expect(editor.state.doc.children[0]!.children).toEqual([txt('a'), txt('X', 'bold'), txt('b')])
    expect(editor.state.selection).toEqual(caret([0, 1], 1))
    expect(root.querySelector('strong')!.textContent).toBe('X')
    expect(root.textContent).toBe('aXb')
  })

  it('composing at offset 0 of a bold text after plain text follows the typing rule', () => {
    const typed = mount([p('p1', txt('a'), txt('bc', 'bold'))], caret([0, 1], 0))
    typed.editor.commands.insertText('X')
    const expected = typed.editor.state.doc.children[0]!.children
    document.body.replaceChildren()

    const { editor, root, view } = mount([p('p1', txt('a'), txt('bc', 'bold'))], caret([0, 1], 0))
    fire(root, 'compositionstart')
    expect(view.composition?.path).toEqual([0, 1])
    imeWrite(view, [0, 1], 'Xbc')
    fire(root, 'compositionend')
    expect(editor.state.doc.children[0]!.children).toEqual(expected)
    expect(editor.state.doc.children[0]!.children).toEqual([txt('aX'), txt('bc', 'bold')])
    expect(root.textContent).toBe('aXbc')
  })

  it('renders during composition leave the composing leaf alone and track its path', () => {
    const { editor, root, view } = mount([p('p1', txt('ab')), p('p2', txt('cd'))], caret([1, 0], 2))
    fire(root, 'compositionstart')
    const leaf = view.renderer.leafAt([1, 0])!
    imeWrite(view, [1, 0], 'cdê')
    // A remote-like edit before the composing text: a new block at the top.
    const tr = editor.createTransaction()
    tr.insertNode([0], p('p0', txt('zero')))
    editor.dispatch(tr)
    expect(view.composition).toEqual({ leaf, path: [2, 0] })
    expect(view.renderer.leafAt([2, 0])).toBe(leaf)
    expect(leaf.textContent).toBe('cdê')
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['zero', 'ab', 'cdê'])
    expect(editor.state.selection).toEqual(caret([2, 0], 3))
  })

  it('drops tracking when the composing text is removed', () => {
    const { editor, root, view } = mount([p('p1', txt('ab')), p('p2', txt('cd'))], caret([1, 0], 2))
    fire(root, 'compositionstart')
    editor.dispatch(editor.createTransaction().removeNode([1]))
    expect(view.composition).toBeNull()
    fire(root, 'compositionend')
    expect(view.composing).toBe(false)
    expect(texts(editor)).toEqual(['ab'])
    expect(root.querySelectorAll('p')).toHaveLength(1)
  })

  it('a merge into the composing text ends the composition without deleting the merged text', () => {
    const { editor, root, view } = mount([p('p1', txt('ab'), txt('X', 'bold'), txt('cd'))], caret([0, 0], 2))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'abê')
    const ops: string[] = []
    editor.on('transaction', ({ tr }) => ops.push(...tr.ops.map((o) => o.type)))
    // Removing the bold text lets normalize merge 'cd' into the composing 'ab'.
    editor.dispatch(editor.createTransaction().removeNode([0, 1]))
    expect(ops).toContain('merge_node')
    expect(view.composition).toBeNull()
    expect(view.composing).toBe(false)
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['abcd'])
    expect(root.textContent).toBe('abcd')
  })

  it('an insert_text into the composing text ends the composition without deleting anything', () => {
    const { editor, root, view } = mount([p('p1', txt('abc'))], caret([0, 0], 3))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'abcê')
    editor.dispatch(editor.createTransaction().insertText('Z', mainRange(caret([0, 0], 0))))
    expect(view.composition).toBeNull()
    expect(view.composing).toBe(false)
    expect(root.textContent).toBe('Zabc')
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['Zabc'])
  })

  it('edits elsewhere keep tracking the composing text', () => {
    const { editor, root, view } = mount([p('p1', txt('ab')), p('p2', txt('cd'))], caret([1, 0], 2))
    fire(root, 'compositionstart')
    imeWrite(view, [1, 0], 'cdê')
    editor.dispatch(editor.createTransaction().insertText('Z', mainRange(caret([0, 0], 0))))
    expect(view.composing).toBe(true)
    expect(view.composition?.path).toEqual([1, 0])
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['Zab', 'cdê'])
  })

  it('deletes a non-collapsed selection at compositionstart', () => {
    const { editor, root, view } = mount([p('p1', txt('abcd'))], range([0, 0], 1, 3))
    fire(root, 'compositionstart')
    expect(texts(editor)).toEqual(['ad'])
    expect(view.composing).toBe(true)
    expect(view.composition?.path).toEqual([0, 0])
    expect(root.textContent).toBe('ad')
    imeWrite(view, [0, 0], 'aXd')
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['aXd'])
  })

  it('blur ends the composition like compositionend', () => {
    const { editor, root, view } = mount([p('p1', txt('ab'))], caret([0, 0], 2))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'abc')
    fire(root, 'blur')
    expect(view.composing).toBe(false)
    expect(texts(editor)).toEqual(['abc'])
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['abc'])
  })

  it('a composition is one undo step, including the replaced selection', () => {
    const { editor, root, view } = mount([p('p1', txt('abcd'))], range([0, 0], 1, 3))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'a你好d')
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['a你好d'])
    editor.commands.undo()
    expect(texts(editor)).toEqual(['abcd'])
  })

  it('rebuilds extra structure the browser left in the leaf', () => {
    const { editor, root, view } = mount([p('p1', txt('ab'))], caret([0, 0], 2))
    fire(root, 'compositionstart')
    const leaf = view.renderer.leafAt([0, 0])!
    leaf.appendChild(document.createElement('span')).textContent = 'c'
    leaf.appendChild(document.createElement('br'))
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['abc'])
    expect(leaf.innerHTML).toBe('abc')
    expect(modelToDom(view.renderer, mainRange(editor.state.selection!).focus)).toEqual({ node: leaf.firstChild, offset: 3 })
  })

  it('forwards input events to plugin handleDOMEvents.input', () => {
    const { root, editor } = mount([p('p1', txt('ab'))], caret([0, 0], 0))
    const seen: string[] = []
    const orig = editor.handleDOMEvent.bind(editor)
    editor.handleDOMEvent = (type, e) => {
      seen.push(type)
      return orig(type, e)
    }
    fire(root, 'input')
    expect(seen).toEqual(['input'])
  })
})

describe('composition and newline splitting (normalize rule 11)', () => {
  it('nothing is split while composing; a committed newline splits the block once, at compositionend', async () => {
    const { editor, root, view } = mount([p('p1', txt('ab'))], caret([0, 0], 1))
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'ax\nyb')
    await flush()
    // The IME owns the leaf: no tr (so no normalization) until the composition ends.
    expect(texts(editor)).toEqual(['ab'])
    expect(view.renderer.leafAt([0, 0])!.textContent).toBe('ax\nyb')
    fire(root, 'compositionend')
    expect(texts(editor)).toEqual(['ax', 'yb'])
    expect(editor.state.selection).toEqual(caret([1, 0], 1))
    expect(editor.getHTML()).toBe('<p>ax</p><p>yb</p>')
  })
})

describe('composition in a zero-width leaf (5.15)', () => {
  const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })

  it('drops only the placeholder, keeping a real U+200B the IME wrote', () => {
    const chipNode: ElementNode = { id: 'c1', type: 'chip', data: {} }
    const editor = createTestEditor({
      plugins: [testParagraph, chip],
      doc: doc(p('p1', txt('x'), chipNode, txt(''))),
      selection: caret([0, 2], 0),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    const view = editor.view!
    view.focus()
    expect(view.renderer.leafAt([0, 2])!.hasAttribute('data-hte-zw')).toBe(true)
    fire(root, 'compositionstart')
    // The placeholder, then the composed text with a genuine zero-width space in it.
    imeWrite(view, [0, 2], '\u200ba\u200bb')
    fire(root, 'compositionend')
    expect((editor.state.doc.children[0]!.children![2] as TextNode).text).toBe('a\u200bb')
  })
})

describe('zero-width leaves', () => {
  const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
  const chipNode = (id: string): ElementNode => ({ id, type: 'chip', data: {} })

  function mountChips(children: Node[], selection: Selection) {
    const editor = createTestEditor({ plugins: [testParagraph, chip], doc: doc(p('p1', ...children)), selection })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    editor.view!.focus()
    return { editor, root, view: editor.view! }
  }
  const textAt = (editor: ReturnType<typeof mountChips>['editor'], i: number) =>
    ((editor.state.doc.children[0] as ElementNode).children![i] as TextNode).text

  it('typing into a zero-width leaf inserts the text without the placeholder and shows it as a plain leaf', () => {
    const { editor, root, view } = mountChips([txt('x'), chipNode('c1'), txt('')], caret([0, 2], 0))
    expect(view.renderer.leafAt([0, 2])!.hasAttribute('data-hte-zw')).toBe(true)
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'a' }))
    expect(textAt(editor, 2)).toBe('a')
    expect(editor.state.selection).toEqual(caret([0, 2], 1))
    const leaf = view.renderer.leafAt([0, 2])!
    expect(leaf.hasAttribute('data-hte-zw')).toBe(false)
    expect(leaf.textContent).toBe('a')
  })

  it('a DOM caret in a zero-width leaf, on either side of its placeholder, is offset 0', () => {
    const { editor, root, view } = mountChips([txt('x'), chipNode('c1'), txt('')], caret([0, 0], 1))
    const leaf = view.renderer.leafAt([0, 2])!
    const text = leaf.ownerDocument.createTreeWalker(leaf, 4).nextNode() as Text
    expect(text.data).toBe('\u200b')
    // The browser left the caret after the placeholder: typing still goes to offset 0.
    document.getSelection()!.setBaseAndExtent(text, 1, text, 1)
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'a' }))
    expect(textAt(editor, 2)).toBe('a')
    expect(textAt(editor, 0)).toBe('x')
  })

  it('IME before a chip: a composition in the leading zero-width leaf commits there, the chip stays', () => {
    const { editor, root, view } = mountChips([txt(''), chipNode('c1'), txt('y')], caret([0, 0], 0))
    expect(view.renderer.leafAt([0, 0])!.hasAttribute('data-hte-zw')).toBe(true)
    fire(root, 'compositionstart')
    expect(view.composition?.leaf).toBe(view.renderer.leafAt([0, 0]))
    imeWrite(view, [0, 0], '\u200b\u00ea')
    fire(root, 'compositionend')
    expect(textAt(editor, 0)).toBe('\u00ea')
    expect((editor.state.doc.children[0] as ElementNode).children![1]).toMatchObject({ type: 'chip' })
    expect(textAt(editor, 2)).toBe('y')
    expect(editor.state.selection).toEqual(caret([0, 0], 1))
    expect(view.renderer.leafAt([0, 0])!.hasAttribute('data-hte-zw')).toBe(false)
    expect(view.renderer.leafAt([0, 0])!.textContent).toBe('\u00ea')
  })

  it('IME in the text before a chip leaves the zero-width leaf after it alone', () => {
    const { editor, root, view } = mountChips([txt('ab'), chipNode('c1'), txt('')], caret([0, 0], 2))
    const zw = view.renderer.leafAt([0, 2])!
    fire(root, 'compositionstart')
    imeWrite(view, [0, 0], 'ab\u00ea')
    fire(root, 'compositionend')
    expect(textAt(editor, 0)).toBe('ab\u00ea')
    expect(textAt(editor, 2)).toBe('')
    expect(view.renderer.leafAt([0, 2])).toBe(zw)
    expect(zw.hasAttribute('data-hte-zw')).toBe(true)
  })

  it('removing the last chip turns the zero-width leaves into one empty leaf with a <br>', () => {
    const { editor, view } = mountChips([txt(''), chipNode('c1'), txt('')], caret([0, 2], 0))
    expect(view.renderer.leafAt([0, 0])!.hasAttribute('data-hte-zw')).toBe(true)
    expect(view.renderer.leafAt([0, 2])!.hasAttribute('data-hte-zw')).toBe(true)
    editor.dispatch(editor.createTransaction().removeNode([0, 1]))
    expect((editor.state.doc.children[0] as ElementNode).children).toEqual([expect.objectContaining({ text: '' })])
    const leaf = view.renderer.leafAt([0, 0])!
    expect(leaf.hasAttribute('data-hte-zw')).toBe(false)
    expect(leaf.innerHTML).toBe('<br data-hte-break="">')
    expect(leaf.textContent).not.toContain('\u200b')
    expect(view.renderer.leafAt([0, 1])).toBeNull()
  })

  it('a Backspace that removes the last chip leaves the caret in the <br> leaf', () => {
    const { editor, root, view } = mountChips([txt(''), chipNode('c1'), txt('')], caret([0, 2], 0))
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }))
    expect((editor.state.doc.children[0] as ElementNode).children).toEqual([expect.objectContaining({ text: '' })])
    expect(editor.state.selection).toEqual(caret([0, 0], 0))
    expect(view.renderer.leafAt([0, 0])!.innerHTML).toBe('<br data-hte-break="">')
  })
})
