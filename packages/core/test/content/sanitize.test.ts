import { describe, expect, it } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import { sanitizeFragment } from '../../src/content/sanitize'
import { doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { createTestEditor } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

describe('sanitizeFragment', () => {
  it('drops unknown blocks and unknown marks', () => {
    const registry = new Registry([testParagraph, testBold])
    const out = sanitizeFragment(
      [el('ghost', txt('x')), el('paragraph', txt('a', 'bold', 'spooky'))],
      registry,
    )
    expect(stripIds(doc(...(out as never[])))).toEqual(stripIds(doc(el('paragraph', txt('a', 'bold')))))
  })
})

describe('insertContent sanitizes', () => {
  it('drops an unknown block and an unknown mark', () => {
    const ed = createTestEditor({
      plugins: [testParagraph, testBold],
      doc: doc(el('paragraph', txt('ab'))),
      selection: sel([0, 0], 1),
    })
    ed.commands.insertContent([el('paragraph', txt('X', 'ghost')), el('ghost', txt('no'))])
    expect(JSON.stringify(ed.getJSON())).not.toContain('ghost')
    expect(JSON.stringify(ed.getJSON())).toContain('X')
  })
})
