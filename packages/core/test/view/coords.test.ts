// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

afterEach(() => {
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function setup(content = doc(el('paragraph', txt('abcd')))) {
  const editor = createTestEditor({ plugins: [testParagraph], doc: content, selection: sel([0, 0], 1) })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  return { editor, root }
}

/** A zero-width rect at `left` from `top` to `bottom`. */
function rect(left: number, top: number, bottom: number): DOMRect {
  return { left, top, bottom, right: left, width: 0, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

describe('coordsAt', () => {
  it('returns the range rect at the DOM position of the point', () => {
    const { editor } = setup()
    const seen: { node: Node; offset: number }[] = []
    vi.spyOn(Range.prototype, 'setStart').mockImplementation(function (node: Node, offset: number) {
      seen.push({ node, offset })
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, bottom: 36, right: 10, width: 0, height: 16, x: 10, y: 20, toJSON: () => ({}),
    } as DOMRect)
    expect(editor.coordsAt({ path: [0, 0], offset: 2 })).toEqual({ left: 10, top: 20, bottom: 36 })
    expect(seen[0]!.offset).toBe(2)
  })

  it('falls back to the first client rect when the bounding rect is empty', () => {
    const { editor } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      { left: 5, top: 6, bottom: 22, right: 5, width: 0, height: 16 },
    ] as unknown as DOMRectList)
    expect(editor.view!.coordsAt({ path: [0, 0], offset: 0 })).toEqual({ left: 5, top: 6, bottom: 22 })
  })

  it('falls back to the leaf element rect when the range has no rects', () => {
    const { editor, root } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    const leaf = root.querySelector('[data-hte-leaf]') as HTMLElement
    vi.spyOn(leaf, 'getBoundingClientRect').mockReturnValue({
      left: 7, top: 8, bottom: 24, right: 50, width: 43, height: 16, x: 7, y: 8, toJSON: () => ({}),
    } as DOMRect)
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toEqual({ left: 7, top: 8, bottom: 24 })
  })

  it('skips a zero-height range rect and falls back to the client rects', () => {
    const { editor } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 20))
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([rect(10, 20, 20), rect(5, 6, 22)] as unknown as DOMRectList)
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toEqual({ left: 5, top: 6, bottom: 22 })
  })

  it('measures the character at the offset when the caret range has no rect', () => {
    const { editor } = setup()
    const measured: { start: number; end: number; collapsed: boolean }[] = []
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      measured.push({ start: this.startOffset, end: this.endOffset, collapsed: this.collapsed })
      if (this.collapsed) return rect(0, 0, 0)
      // The character after the offset on the second line of a wrapped leaf.
      return { ...rect(30, 40, 56), right: 38 } as DOMRect
    })
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    expect(editor.coordsAt({ path: [0, 0], offset: 2 })).toEqual({ left: 30, top: 40, bottom: 56 })
    expect(measured.at(-1)).toEqual({ start: 2, end: 3, collapsed: false })
  })

  it('at the end of the text, measures the character before the offset and takes its right edge', () => {
    const { editor } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      if (this.collapsed) return rect(0, 0, 0)
      expect([this.startOffset, this.endOffset]).toEqual([3, 4])
      return { ...rect(30, 40, 56), right: 38 } as DOMRect
    })
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    expect(editor.coordsAt({ path: [0, 0], offset: 4 })).toEqual({ left: 38, top: 40, bottom: 56 })
  })

  it('the leaf fallback takes its first line box, not the whole leaf', () => {
    const { editor, root } = setup()
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0))
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
    const leaf = root.querySelector('[data-hte-leaf]') as HTMLElement
    // Two line boxes: the bounding rect spans both.
    vi.spyOn(leaf, 'getBoundingClientRect').mockReturnValue(rect(7, 8, 40))
    vi.spyOn(leaf, 'getClientRects').mockReturnValue([rect(7, 8, 24), rect(0, 24, 40)] as unknown as DOMRectList)
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toEqual({ left: 7, top: 8, bottom: 24 })
  })

  it('returns null when nothing has a height (e.g. not laid out)', () => {
    const { editor } = setup()
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toBeNull()
  })

  it('returns null for a leaf not placed in the root yet (contentDOM not mounted)', () => {
    const { editor, root } = setup()
    const leaf = root.querySelector('[data-hte-leaf]') as HTMLElement
    const parked = document.createElement('div')
    parked.appendChild(leaf)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 36))
    vi.spyOn(leaf, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 36))
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toBeNull()
  })

  it('returns null when unmounted', () => {
    const { editor } = setup()
    editor.unmount()
    expect(editor.coordsAt({ path: [0, 0], offset: 1 })).toBeNull()
  })

  it('returns null for a point with no rendered leaf', () => {
    const { editor } = setup()
    expect(editor.coordsAt({ path: [5, 0], offset: 0 })).toBeNull()
  })
})
