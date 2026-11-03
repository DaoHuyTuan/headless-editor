// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTestEditor, doc, el, sel, stripIds, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { bold } from '@hte/bold'
import { fontSize } from '../src/index'

const p = (...children: ReturnType<typeof txt>[]) => el('paragraph', ...children)
const fs = (size: string) => ({ type: 'fontSize', data: { size } })
const setup = (content: ReturnType<typeof doc>, selection?: ReturnType<typeof sel>) =>
  createTestEditor({ plugins: [paragraph, bold, fontSize], doc: content, selection })

describe('fontSize plugin', () => {
  it('setFontSize marks the selected range', () => {
    const ed = setup(doc(p(txt('abcd'))), sel([0, 0], 1, [0, 0], 3))
    expect(ed.commands.setFontSize('18px')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a'), txt('bc', fs('18px')), txt('d')))))
  })

  it('replaces an existing size', () => {
    const ed = setup(doc(p(txt('ab', fs('18px')), txt('cd'))), sel([0, 0], 1, [0, 1], 1))
    expect(ed.commands.setFontSize('24px')).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(
      stripIds(doc(p(txt('a', fs('18px')), txt('bc', fs('24px')), txt('d')))),
    )
  })

  it('rejects an invalid size and leaves the doc unchanged', () => {
    const ed = setup(doc(p(txt('abcd'))), sel([0, 0], 1, [0, 0], 3))
    expect(ed.commands.setFontSize('huge')).toBe(false)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('abcd')))))
  })

  it('applies to typed text from a caret via stored marks', () => {
    const ed = setup(doc(p(txt('ab'))), sel([0, 0], 1, [0, 0], 1))
    expect(ed.commands.setFontSize('12px')).toBe(true)
    ed.commands.insertText('x')
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a'), txt('x', fs('12px')), txt('b')))))
  })

  it('unsetFontSize removes the mark', () => {
    const ed = setup(doc(p(txt('abcd', fs('18px')))), sel([0, 0], 0, [0, 0], 4))
    expect(ed.commands.unsetFontSize()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('abcd')))))
  })

  it('parses a font-size style', () => {
    const ed = createTestEditor({
      plugins: [paragraph, fontSize],
      content: '<p><span style="font-size:18px">a</span><span style="font-size:bogus">b</span></p>',
    })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a', fs('18px')), txt('b')))))
  })

  it('serializes to a styled span', () => {
    const ed = createTestEditor({ plugins: [paragraph, fontSize], doc: doc(p(txt('a', fs('18px')))) })
    expect(ed.getHTML()).toBe('<p><span style="font-size: 18px;">a</span></p>')
  })

  it('nests with bold by rank', () => {
    const ed = createTestEditor({
      plugins: [paragraph, bold, fontSize],
      doc: doc(p(txt('a', 'bold', fs('18px')))),
    })
    expect(ed.getHTML()).toBe('<p><strong><span style="font-size: 18px;">a</span></strong></p>')
  })
})

describe('fontSize HTMLAttributes', () => {
  it('merges style and class into the <span>', () => {
    const ed = createTestEditor({
      plugins: [
        paragraph,
        fontSize.configure({ HTMLAttributes: { class: 'fs', style: 'color: red; font-size: 1px' } }),
      ],
      content: '<p><span style="font-size:20px">a</span></p>',
    })
    expect(ed.getHTML()).toBe('<p><span class="fs" style="color: red; font-size: 20px;">a</span></p>')
  })
})
