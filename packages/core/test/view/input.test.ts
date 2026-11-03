// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { ElementNode, Selection } from '../../src/model/types'
import { definePlugin, modelToDom, type AnyPlugin, type Editor } from '../../src/index'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (id: string, ...children: ReturnType<typeof txt>[]): ElementNode => ({ id, type: 'paragraph', data: {}, children })
const caret = (path: number[], offset: number): Selection => ({ anchor: { path, offset }, focus: { path, offset } })

const boldWithKeymap = testBold.extend({
  keymap: (ctx) => ({ 'Mod-b': () => (ctx.editor.commands as unknown as { toggleMark(t: string): boolean }).toggleMark('bold') }),
})

function setup(text = 'ab', selection: Selection = caret([0, 0], 2), plugins: AnyPlugin[] = [testParagraph, boldWithKeymap]) {
  const editor = createTestEditor({ plugins, doc: doc(p('p1', txt(text))), selection })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  return { editor, root }
}

function beforeInput(root: HTMLElement, init: InputEventInit): InputEvent {
  const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...init })
  root.dispatchEvent(e)
  return e
}

function keydown(root: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  root.dispatchEvent(e)
  return e
}

/** Puts the DOM selection at a model caret without telling the model. */
function setDomCaret(editor: Editor, path: number[], offset: number): void {
  const pos = modelToDom(editor.view!.renderer, { path, offset })
  document.getSelection()!.setBaseAndExtent(pos.node, pos.offset, pos.node, pos.offset)
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('input module', () => {
  it('a cancelable beforeinput insertText is prevented and inserts into the model', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    const e = beforeInput(root, { inputType: 'insertText', data: 'x' })
    expect(e.defaultPrevented).toBe(true)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'abx' }] })
    expect(root.textContent).toBe('abx')
  })

  it('reads the DOM selection before handling beforeinput (selectionchange may be pending)', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    setDomCaret(editor, [0, 0], 0)
    beforeInput(root, { inputType: 'insertText', data: 'x' })
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'xab' }] })
  })

  it('records beforeinput events in recentInput, keeping the last 20', () => {
    const { editor, root } = setup('', caret([0, 0], 0))
    for (let i = 0; i < 25; i++) beforeInput(root, { inputType: 'insertText', data: String(i % 10) })
    const recent = editor.view!.recentInput
    expect(recent).toHaveLength(20)
    expect(recent[0]).toMatchObject({ inputType: 'insertText', data: '5' })
    expect(recent[19]).toMatchObject({ inputType: 'insertText', data: '4' })
    expect(typeof recent[0]!.time).toBe('number')
  })

  it('skips beforeinput while composing and for insertCompositionText', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    const e1 = beforeInput(root, { inputType: 'insertCompositionText', data: 'x' })
    editor.view!.composing = true
    const e2 = beforeInput(root, { inputType: 'insertText', data: 'y' })
    expect(e1.defaultPrevented).toBe(false)
    expect(e2.defaultPrevented).toBe(false)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab' }] })
    expect(editor.view!.recentInput).toHaveLength(2)
  })

  it('leaves paste and cut to the clipboard module and prevents drop', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    expect(beforeInput(root, { inputType: 'insertFromPaste', data: 'x' }).defaultPrevented).toBe(false)
    expect(beforeInput(root, { inputType: 'deleteByCut' }).defaultPrevented).toBe(false)
    expect(beforeInput(root, { inputType: 'insertFromDrop', data: 'x' }).defaultPrevented).toBe(true)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab' }] })
  })

  it('prevents an unhandled but cancelable beforeinput, and not an uncancelable one', () => {
    const { root } = setup()
    expect(beforeInput(root, { inputType: 'formatUnderline' }).defaultPrevented).toBe(true)
    expect(beforeInput(root, { inputType: 'formatUnderline', cancelable: false }).defaultPrevented).toBe(false)
  })

  it('handles deleteContentBackward and insertParagraph', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    beforeInput(root, { inputType: 'deleteContentBackward' })
    beforeInput(root, { inputType: 'insertParagraph' })
    beforeInput(root, { inputType: 'insertText', data: 'c' })
    expect(editor.getJSON().children).toMatchObject([{ children: [{ text: 'a' }] }, { children: [{ text: 'c' }] }])
  })

  it('a keydown Ctrl+b toggles bold through runKeymap and is prevented', () => {
    const { editor, root } = setup('ab', { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 2 } })
    const e = keydown(root, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab', marks: [{ type: 'bold' }] }] })
  })

  it('does not prevent an unbound keydown', () => {
    const { root } = setup()
    expect(keydown(root, { key: 'q', code: 'KeyQ' }).defaultPrevented).toBe(false)
  })

  it('plugin handleDOMEvents run first by priority; true stops the default handling', () => {
    const calls: string[] = []
    const low = definePlugin({
      name: 'low',
      priority: 10,
      handleDOMEvents: { keydown: () => (calls.push('low'), false), beforeinput: () => (calls.push('low-bi'), false) },
    })
    const high = definePlugin({
      name: 'high',
      priority: 500,
      handleDOMEvents: {
        keydown: (e, ctx) => (calls.push(`high:${ctx.name}`), (e as KeyboardEvent).key === 'b'),
        beforeinput: (e) => (calls.push('high-bi'), (e as InputEvent).data === 'z'),
      },
    })
    const { editor, root } = setup('ab', caret([0, 0], 2), [testParagraph, boldWithKeymap, low, high])
    const k = keydown(root, { key: 'b', code: 'KeyB', ctrlKey: true })
    expect(k.defaultPrevented).toBe(true)
    expect(editor.state.storedMarks).toBeNull()
    expect(calls).toEqual(['high:high'])
    calls.length = 0
    const b = beforeInput(root, { inputType: 'insertText', data: 'z' })
    expect(b.defaultPrevented).toBe(false)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab' }] })
    expect(editor.view!.recentInput.at(-1)).toMatchObject({ inputType: 'insertText', data: 'z' })
    calls.length = 0
    beforeInput(root, { inputType: 'insertText', data: 'y' })
    expect(calls).toEqual(['high-bi', 'low-bi'])
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'aby' }] })
  })

  it('removes its listeners on unmount', () => {
    const { editor, root } = setup('ab', caret([0, 0], 2))
    editor.unmount()
    expect(beforeInput(root, { inputType: 'insertText', data: 'x' }).defaultPrevented).toBe(false)
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab' }] })
  })
})

/**
 * WebKit fires no `beforeinput` (and no `input`) for Backspace/Delete when the only thing to delete is an
 * empty non-editable block (an unknown block renders as an empty `contenteditable=false` div): neither for
 * the caret right after it nor for a node selection covering it. The keydown is then the only event.
 */
describe('input module: deletion keys without a beforeinput (WebKit)', () => {
  const unknown: ElementNode = { id: 'u', type: 'mystery', data: {}, children: [txt('Title')] }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  function setupUnknown(selection: Selection = caret([1, 0], 0)) {
    const editor = createTestEditor({ plugins: [testParagraph], doc: doc(unknown, p('p1', txt('Body'))), selection })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    editor.view!.focus()
    return { editor, root, block: () => root.querySelector('[data-hte-unknown=mystery]') }
  }

  it('Backspace at the start of the block after an unknown block node-selects it; a second one removes it', async () => {
    const { editor, root, block } = setupUnknown()
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    await tick()
    expect(editor.state.selection?.node).toEqual([0])
    expect(block()!.hasAttribute('data-hte-selected')).toBe(true)
    expect(editor.getJSON().children[0]).toMatchObject({ type: 'mystery', children: [{ text: 'Title' }] })

    keydown(root, { key: 'Backspace', code: 'Backspace' })
    await tick()
    expect(block()).toBeNull()
    expect(editor.getJSON().children).toMatchObject([{ type: 'paragraph', children: [{ text: 'Body' }] }])
  })

  it('Delete at the end of the block before an unknown block node-selects it', async () => {
    const editor = createTestEditor({
      plugins: [testParagraph],
      doc: doc(p('p1', txt('Body')), unknown),
      selection: caret([0, 0], 4),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    editor.view!.focus()
    keydown(root, { key: 'Delete', code: 'Delete' })
    await tick()
    expect(editor.state.selection?.node).toEqual([1])
  })

  it('the deletion runs once when the browser does fire beforeinput after the keydown (Chromium)', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    beforeInput(root, { inputType: 'deleteContentBackward' })
    await tick()
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'ab' }] })
  })

  it('no fallback for a keydown a plugin handled, with modifiers, or while composing', async () => {
    const handled = definePlugin({
      name: 'eatsBackspace',
      priority: 500,
      handleDOMEvents: { keydown: (e) => (e as KeyboardEvent).key === 'Backspace' && (e as KeyboardEvent).shiftKey },
    })
    const { editor, root } = setup('abc', caret([0, 0], 3), [testParagraph, handled])
    keydown(root, { key: 'Backspace', code: 'Backspace', shiftKey: true })
    keydown(root, { key: 'Backspace', code: 'Backspace', altKey: true })
    keydown(root, { key: 'Backspace', code: 'Backspace', ctrlKey: true })
    keydown(root, { key: 'Backspace', code: 'Backspace', metaKey: true })
    editor.view!.composing = true
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    await tick()
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('no fallback after unmount', async () => {
    const { editor, root } = setupUnknown()
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    editor.unmount()
    await tick()
    expect(editor.state.selection?.node).toBeUndefined()
  })
})

/** Guards of the deletion-key fallback: it runs only when nothing else answered the keydown. */
describe('input module: deletion-key fallback guards', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const textOf = (editor: Editor): unknown => editor.getJSON().children[0]

  it('Shift+Delete with a selection is a cut: only the selection is removed', async () => {
    const { editor, root } = setup('abcd', { anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 2 } })
    keydown(root, { key: 'Delete', code: 'Delete', shiftKey: true })
    root.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }))
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'acd' }] })
  })

  it('no fallback when the state changed after the keydown (another handler acted)', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    editor.commands.insertText('x')
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abcx' }] })
  })

  it('no fallback for a paste after the keydown (even one that changes nothing)', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }))
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('no fallback for a composition started after the keydown', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('no fallback for a keydown prevented after the core listener (by a page listener)', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('no fallback for a keydown with keyCode 229 or isComposing set', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    keydown(root, { key: 'Backspace', code: 'Backspace', keyCode: 229 } as KeyboardEventInit)
    keydown(root, { key: 'Backspace', code: 'Backspace', isComposing: true })
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('no fallback for a keydown right after compositionend (Safari ends a composition with a keydown)', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('a beforeinput on an ignored target still cancels the fallback', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    const ignored = document.createElement('span')
    ignored.setAttribute('data-editor-ignore', '')
    root.appendChild(ignored)
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    ignored.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }))
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })

  it('no fallback when the editor lost focus before it runs', async () => {
    const { editor, root } = setup('abc', caret([0, 0], 3))
    keydown(root, { key: 'Backspace', code: 'Backspace' })
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.getSelection()?.removeAllRanges()
    await tick()
    expect(textOf(editor)).toMatchObject({ children: [{ text: 'abc' }] })
  })
})
