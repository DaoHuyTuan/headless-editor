// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createTestEditor, doc, el, sel, stripIds, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { bold } from '../src/index'

const p = (...children: ReturnType<typeof txt>[]) => el('paragraph', ...children)
const setup = (content: ReturnType<typeof doc>, selection?: ReturnType<typeof sel>) =>
  createTestEditor({ plugins: [paragraph, bold], doc: content, selection })

describe('bold plugin', () => {
  it('toggleBold on a range bolds then unbolds', () => {
    const ed = setup(doc(p(txt('abcd'))), sel([0, 0], 1, [0, 0], 3))
    expect(ed.commands.toggleBold()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('a'), txt('bc', 'bold'), txt('d')))))
    expect(ed.commands.toggleBold()).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p(txt('abcd')))))
  })

  it('setBold and unsetBold', () => {
    const ed = setup(doc(p(txt('abcd'))), sel([0, 0], 1, [0, 0], 3))
    ed.commands.setBold()
    expect(ed.isActive('bold')).toBe(true)
    ed.commands.unsetBold()
    expect(ed.isActive('bold')).toBe(false)
  })

  it('Ctrl-b toggles bold', () => {
    const ed = setup(doc(p(txt('abcd'))), sel([0, 0], 0, [0, 0], 4))
    expect(ed.runKeymap('Ctrl-b')).toBe(true)
    expect(ed.getHTML()).toBe('<p><strong>abcd</strong></p>')
  })

  it('formatBold input intent toggles bold', () => {
    const ed = setup(doc(p(txt('abcd'))), sel([0, 0], 0, [0, 0], 2))
    expect(ed.handleIntent({ inputType: 'formatBold', data: null, range: null })).toBe(true)
    expect(ed.getHTML()).toBe('<p><strong>ab</strong>cd</p>')
  })

  it('serializes to <strong>', () => {
    const ed = createTestEditor({ plugins: [paragraph, bold], doc: doc(p(txt('x', 'bold'))) })
    expect(ed.getHTML()).toBe('<p><strong>x</strong></p>')
  })

  it('parses <strong>, <b>, and bold font-weight spans', () => {
    const html = '<p><strong>a</strong><b>b</b><span style="font-weight:700">c</span><span style="font-weight:bold">d</span></p>'
    const ed = createTestEditor({ plugins: [paragraph, bold], content: html })
    expect(ed.getHTML()).toBe('<p><strong>abcd</strong></p>')
  })

  it('does not treat <b style="font-weight:normal"> or weight 400 as bold', () => {
    const ed = createTestEditor({
      plugins: [paragraph, bold],
      content: '<p><b style="font-weight:normal">a</b><span style="font-weight:400">b</span></p>',
    })
    expect(ed.getHTML()).toBe('<p>ab</p>')
  })
})

describe('bold HTMLAttributes', () => {
  const html = '<p>a<strong>b</strong>c</p>'

  it('configure() adds attributes to <strong> in getHTML and in the live DOM', () => {
    const ed = createTestEditor({ plugins: [paragraph, bold.configure({ HTMLAttributes: { class: 'b' } })], content: html })
    expect(ed.getHTML()).toBe('<p>a<strong class="b">b</strong>c</p>')
    const root = document.createElement('div')
    ed.mount(root)
    expect(root.querySelector('strong')?.getAttribute('class')).toBe('b')
  })

  it('setPluginOptions updates already-rendered leaves', () => {
    const ed = createTestEditor({ plugins: [paragraph, bold], content: html })
    const root = document.createElement('div')
    ed.mount(root)
    expect(root.querySelector('strong')?.hasAttribute('class')).toBe(false)
    ed.setPluginOptions('bold', { HTMLAttributes: { class: 'c' } })
    expect(root.querySelector('strong')?.getAttribute('class')).toBe('c')
    expect(ed.getHTML()).toBe('<p>a<strong class="c">b</strong>c</p>')
  })
})
