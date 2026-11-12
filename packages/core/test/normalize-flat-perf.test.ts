import { describe, expect, it, vi } from 'vitest'
import type { ElementNode } from '../src/model/types'
import { createTestEditor, doc, el, sel, txt } from '../src/testing/index'
import { testBold, testParagraph } from './fixtures'

const N = 5000

/** A flat doc of `N` paragraphs, the caret inside the middle one. */
function setup() {
  const blocks: ElementNode[] = Array.from({ length: N }, (_, i) => el('paragraph', txt(`paragraph number ${i}`)))
  return createTestEditor({ plugins: [testParagraph, testBold], doc: doc(...blocks), selection: sel([N / 2, 0], 5) })
}

// Typing in a large flat document must cost what it cost before nested content: the content rule
// and rules 8 and 11 run on the touched nodes only, and the root placement checks read no siblings.
describe('flat documents: per-keystroke work does not grow with the doc', () => {
  it('a keystroke does not check the root content, nor the marks of every textblock', () => {
    const ed = setup()
    const contentMatch = vi.spyOn(ed.registry, 'contentMatch')
    const allowsMark = vi.spyOn(ed.registry, 'allowsMark')
    const tr = ed.createTransaction()
    tr.insertText('x')
    ed.dispatch(tr)
    expect(contentMatch.mock.calls.filter(([type]) => type === 'doc')).toHaveLength(0)
    expect(allowsMark.mock.calls.length).toBeLessThan(100)
  })

  it('Enter at the root does not read every root block to place the new one', () => {
    const ed = setup()
    const node = vi.spyOn(ed.registry, 'node')
    const tr = ed.createTransaction()
    tr.splitBlock()
    expect(tr.doc.children).toHaveLength(N + 1)
    expect(node.mock.calls.length).toBeLessThan(100)
  })

  // A generous bound (measured about 5 ms per keystroke and 18 ms per Enter + Backspace pair on 5000
  // paragraphs when this was written), so the suite does not flake on slow machines.
  it('typing, Enter and Backspace stay fast in 5000 paragraphs', () => {
    const ed = setup()
    const time = (fn: () => void, n: number) => {
      let best = Infinity
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now()
        for (let k = 0; k < n; k++) fn()
        best = Math.min(best, (performance.now() - t0) / n)
      }
      return best
    }
    const type = () => {
      const tr = ed.createTransaction()
      tr.insertText('x')
      ed.dispatch(tr)
    }
    const enterBack = () => {
      let tr = ed.createTransaction()
      tr.splitBlock()
      ed.dispatch(tr)
      tr = ed.createTransaction()
      tr.deleteBackward()
      ed.dispatch(tr)
    }
    type() // warm-up
    enterBack()
    expect(time(type, 20)).toBeLessThan(60)
    expect(time(enterBack, 10)).toBeLessThan(200)
    expect(ed.state.doc.children).toHaveLength(N)
  })
})
