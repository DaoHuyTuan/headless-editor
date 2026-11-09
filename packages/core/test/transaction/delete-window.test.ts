import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/model/selection'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

/** The deletion target by segmenting the whole text: the rule Backspace/Delete must keep (8.2). */
function expectedTarget(text: string, offset: number, unit: 'character' | 'word', backward: boolean): number {
  const granularity = unit === 'character' ? 'grapheme' : 'word'
  const segs = [...new Intl.Segmenter(undefined, { granularity }).segment(text)]
  let target = offset
  if (backward) {
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]!
      if (seg.index >= offset) continue
      target = seg.index
      if (unit === 'character' || seg.isWordLike) break
    }
    return target
  }
  for (const seg of segs) {
    const end = seg.index + seg.segment.length
    if (end <= offset) continue
    target = end
    if (unit === 'character' || seg.isWordLike) break
  }
  return target
}

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = ['word', ' ', '  ', '.', 'é', 'é', '👍🏽', '👨‍👩‍👧', '中文字', 'x'.repeat(300), ' '.repeat(300), 'ab-cd', 'क्ष']

describe('Backspace/Delete on long blocks keep the whole-text segmentation result (8.2)', () => {
  it('matches the whole-text rule at random offsets, for characters and words, both directions', () => {
    const random = rng(42)
    for (let round = 0; round < 40; round++) {
      let text = ''
      while (text.length < 1500) text += PIECES[Math.floor(random() * PIECES.length)]
      for (let k = 0; k < 6; k++) {
        // A grapheme boundary: offsets inside a cluster are not caret positions.
        const bounds = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.index)
        const offset = bounds[Math.floor(random() * bounds.length)]!
        for (const unit of ['character', 'word'] as const) {
          for (const backward of [true, false]) {
            const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt(text))) })
            const tr = ed.createTransaction()
            tr.setSelection(createSelection([{ anchor: { path: [0, 0], offset }, focus: { path: [0, 0], offset } }], 0))
            if (backward) tr.deleteBackward(unit)
            else tr.deleteForward(unit)
            const target = expectedTarget(text, offset, unit, backward)
            const [from, to] = backward ? [target, offset] : [offset, target]
            const want = text.slice(0, from) + text.slice(to)
            const got = (tr.doc.children[0]!.children![0] as { text: string }).text
            expect({ round, offset, unit, backward, same: got === want }).toEqual({ round, offset, unit, backward, same: true })
          }
        }
      }
    }
  }, 60_000)
})

describe('Backspace/Delete segment only a window around the caret (8.2)', () => {
  it('a long block is not segmented whole for one character or one word', () => {
    const lengths: number[] = []
    const original = Intl.Segmenter.prototype.segment
    Intl.Segmenter.prototype.segment = function (this: Intl.Segmenter, input: string) {
      lengths.push(input.length)
      return original.call(this, input)
    }
    try {
      const text = 'word '.repeat(10_000)
      const ed = createTestEditor({ plugins: [testParagraph], doc: doc(el('paragraph', txt(text))) })
      for (const unit of ['character', 'word'] as const) {
        const tr = ed.createTransaction()
        tr.setSelection(createSelection([{ anchor: { path: [0, 0], offset: 25_000 }, focus: { path: [0, 0], offset: 25_000 } }], 0))
        tr.deleteBackward(unit)
        tr.deleteForward(unit)
      }
    } finally {
      Intl.Segmenter.prototype.segment = original
    }
    expect(lengths.length).toBeGreaterThan(0)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1024)
  })
})
