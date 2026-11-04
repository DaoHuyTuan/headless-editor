import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/model/selection'
import type { SelectionRange } from '../../src/model/types'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

/** 100 paragraphs of 40 chars, one caret in the middle of each. */
function setup() {
  const blocks = Array.from({ length: 100 }, () => el('paragraph', txt('x'.repeat(40))))
  const editor = createTestEditor({ plugins: [testParagraph], content: doc(...blocks) })
  const ranges: SelectionRange[] = blocks.map((_, i) => {
    const p = { path: [i, 0], offset: 20 }
    return { anchor: p, focus: p }
  })
  editor.dispatch(editor.createTransaction().setSelection(createSelection(ranges)))
  return editor
}

describe('multi-range performance', () => {
  // Spec target (not a hard requirement): 100 carets typing one character stays interactive, under
  // 16 ms per keystroke (measured about 9 ms when this test was written). A generous bound here, so
  // the suite does not flake on slow machines.
  it('100 carets typing one character', () => {
    const run = () => {
      const editor = setup()
      const start = performance.now()
      const tr = editor.createTransaction()
      tr.insertText('a')
      editor.dispatch(tr)
      const ms = performance.now() - start
      expect(editor.state.selection!.ranges).toHaveLength(100)
      return ms
    }
    run() // warm-up
    const best = Math.min(...Array.from({ length: 5 }, run))
    expect(best).toBeLessThan(100)
  })
})
