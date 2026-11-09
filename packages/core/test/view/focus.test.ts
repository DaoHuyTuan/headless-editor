// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { single } from '../../src/model/selection'
import type { ElementNode } from '../../src/model/types'
import * as core from '../../src/index'
import { hasEditorFocus } from '../../src/view/focus'
import { createTestEditor, doc, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

const p = (id: string, text: string): ElementNode => ({ id, type: 'paragraph', data: {}, children: [txt(text)] })

function setup() {
  const editor = createTestEditor({
    plugins: [testParagraph],
    doc: doc(p('p1', 'abc')),
    selection: single({ anchor: { path: [0, 0], offset: 1 }, focus: { path: [0, 0], offset: 1 } }),
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  return { editor, root }
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('editor focus (internal)', () => {
  it('is not part of the EditorView API, nor exported from the core index', () => {
    const { editor } = setup()
    expect('hasFocus' in editor.view!).toBe(false)
    expect('hasEditorFocus' in core).toBe(false)
  })

  it('counts the focus inside the root, or failing that a DOM selection inside it', () => {
    const { editor, root } = setup()
    const view = editor.view!
    expect(hasEditorFocus(view)).toBe(false)
    view.focus()
    expect(hasEditorFocus(view)).toBe(true)
    ;(document.activeElement as HTMLElement).blur()
    // The DOM selection is still in the root.
    expect(hasEditorFocus(view)).toBe(true)
    document.getSelection()!.removeAllRanges()
    expect(hasEditorFocus(view)).toBe(false)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    expect(hasEditorFocus(view)).toBe(false)
    expect(root.contains(document.activeElement)).toBe(false)
  })
})
