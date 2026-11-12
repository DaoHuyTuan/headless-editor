// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { FRAGMENT_MIME, serializeForClipboard } from '../../src/content/clipboard'
import type { Doc, ElementNode, Node, Path, Selection } from '../../src/model/types'
import type { DOMOutputSpec } from '../../src/plugin/types'
import { isValidDoc } from '../../src/schema/validate'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import type { AnyPlugin } from '../../src/plugin/types'
import { nested, testBold, testBulletList, testListItem, testParagraph, testQuote, testTable, testTableCell, testTableRow } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const ul = (...children: ElementNode[]): ElementNode => el('bulletList', ...children)
const li = (...children: ElementNode[]): ElementNode => el('listItem', ...children)
const range = (sp: Path, so: number, ep: Path, eo: number) => ({ start: { path: sp, offset: so }, end: { path: ep, offset: eo } })

// Local plugins claiming the container tags (and rendering the list ones): the shared fixtures have no HTML rules.
const bulletList = testBulletList.extend({ parseHTML: [{ tag: 'ul' }], renderHTML: (): DOMOutputSpec => ['ul', 0] })
const listItem = testListItem.extend({ parseHTML: [{ tag: 'li' }], renderHTML: (): DOMOutputSpec => ['li', 0] })
const quotePl = testQuote.extend({ parseHTML: [{ tag: 'blockquote' }] })
const tablePl = testTable.extend({ parseHTML: [{ tag: 'table' }] })
const rowPl = testTableRow.extend({ parseHTML: [{ tag: 'tr' }] })
const cellPl = testTableCell.extend({ parseHTML: [{ tag: 'td' }] })
const claimed: Record<string, AnyPlugin> = { bulletList, listItem, quote: quotePl, table: tablePl, tableRow: rowPl, tableCell: cellPl }
const plugins = nested.map((pl) => claimed[pl.name] ?? pl)

const setup = (content: Doc, selection: Selection) => createTestEditor({ plugins, doc: content, selection })
const transfer = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer
const paste = (ed: ReturnType<typeof setup>, data: Record<string, string>) =>
  ed.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: transfer(data), range: null })

/** The clipboard flavors of `ab|c` .. `d|ef` across two list items. */
function copyTwoItems() {
  const ed = setup(doc(ul(li(p('abc')), li(p('def')))), sel([0, 0, 0, 0], 0))
  return serializeForClipboard(ed, range([0, 0, 0, 0], 2, [0, 1, 0, 0], 1))
}

describe('clipboard flavors of a slice', () => {
  it('the HTML of two list items goes out inside their list', () => {
    expect(copyTwoItems().html).toBe('<ul><li><p>c</p></li><li><p>d</p></li></ul>')
  })

  it('HTML is only wrapped as far as the root needs: two paragraphs of one item go out bare', () => {
    const ed = setup(doc(ul(li(p('ab'), p('cd')))), sel([0, 0, 0, 0], 0))
    expect(serializeForClipboard(ed, range([0, 0, 0, 0], 1, [0, 0, 1, 0], 1)).html).toBe('<p>b</p><p>c</p>')
  })

  it('the MIME JSON keeps the open depths, and a penline paste of it is exact', () => {
    const { json, text } = copyTwoItems()
    const parsed = JSON.parse(json) as { content: unknown; openStart: number; openEnd: number }
    expect(stripIds(parsed.content as Node[])).toEqual(stripIds([li(p('c')), li(p('d'))]))
    expect([parsed.openStart, parsed.openEnd]).toEqual([2, 2])
    expect(text).toBe('c\nd')
    const ed = setup(doc(ul(li(p('xy')))), sel([0, 0, 0, 0], 1))
    expect(paste(ed, { [FRAGMENT_MIME]: json })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(ul(li(p('xc')), li(p('dy'))))))
  })

  it('a slice with the open depths of a fragment keeps the old array payload', () => {
    const ed = setup(doc(p('ab'), p('cd')), sel([0, 0], 0))
    const { json } = serializeForClipboard(ed, range([0, 0], 1, [1, 0], 1))
    expect(stripIds(JSON.parse(json) as Node[])).toEqual(stripIds([p('b'), p('c')]))
  })

  it('an old payload without open depths pastes as today', () => {
    const json = JSON.stringify([p('a'), p('b')])
    const flat = createTestEditor({ plugins: [testParagraph, testBold], doc: doc(p('xy')), selection: sel([0, 0], 1) })
    expect(paste(flat, { [FRAGMENT_MIME]: json })).toBe(true)
    expect(stripIds(flat.getJSON())).toEqual(stripIds(doc(p('xa'), p('by'))))
    expect(flat.state.selection).toEqual(sel([1, 0], 1))
  })

  it('an old payload of whole list items pasted into a list item becomes sibling items of that list (closed edges)', () => {
    const json = JSON.stringify([li(p('c')), li(p('d'))])
    const ed = setup(doc(ul(li(p('xy')))), sel([0, 0, 0, 0], 1))
    expect(paste(ed, { [FRAGMENT_MIME]: json })).toBe(true)
    expect(isValidDoc(ed.state.doc, ed.registry)).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(ul(li(p('x')), li(p('c')), li(p('d')), li(p('y'))))))
  })

  it('pasting the HTML of a list into a list item merges with the list around the caret, not nested (open as far as it can be)', () => {
    const ed = setup(doc(ul(li(p('xy')))), sel([0, 0, 0, 0], 1))
    expect(paste(ed, { 'text/html': '<ul><li><p>c</p></li><li><p>d</p></li></ul>' })).toBe(true)
    expect(isValidDoc(ed.state.doc, ed.registry)).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(ul(li(p('xc')), li(p('dy'))))))
  })

  describe('a lone pasted container is kept when the root takes it (open ends that do not line up are closed)', () => {
    const quote = (...children: ElementNode[]): ElementNode => el('quote', ...children)
    const table = (...rows: ElementNode[]): ElementNode => el('table', ...rows)
    const row = (...cells: ElementNode[]): ElementNode => el('tableRow', ...cells)
    const cell = (...children: ElementNode[]): ElementNode => el('tableCell', ...children)
    const pasteAtRoot = (html: string) => {
      const ed = setup(doc(p('xy')), sel([0, 0], 1))
      expect(paste(ed, { 'text/html': html })).toBe(true)
      expect(isValidDoc(ed.state.doc, ed.registry)).toBe(true)
      return stripIds(ed.getJSON())
    }

    it.each([
      ['a one-item list', '<ul><li><p>a</p></li></ul>', ul(li(p('a')))],
      ['a quote of one paragraph', '<blockquote><p>a</p></blockquote>', quote(p('a'))],
      ['a quote of two paragraphs', '<blockquote><p>a</p><p>b</p></blockquote>', quote(p('a'), p('b'))],
      ['a single-cell table', '<table><tr><td><p>a</p></td></tr></table>', table(row(cell(p('a'))))],
      ['a two-item list (control)', '<ul><li><p>a</p></li><li><p>b</p></li></ul>', ul(li(p('a')), li(p('b')))],
    ])('%s goes in whole between the halves', (_name, html, node) => {
      expect(pasteAtRoot(html)).toEqual(stripIds(doc(p('x'), node, p('y'))))
    })

    it('flat paragraphs still merge at both ends (control)', () => {
      expect(pasteAtRoot('<p>a</p><p>b</p>')).toEqual(stripIds(doc(p('xa'), p('by'))))
    })
  })

  it('pasting HTML with a loose run in a list into a root paragraph gives a valid list with all three texts (Review Focus 3)', () => {
    const ed = setup(doc(p('')), sel([0, 0], 0))
    expect(paste(ed, { 'text/html': '<ul><li><p>a</p></li>text<li>b</li></ul>' })).toBe(true)
    expect(isValidDoc(ed.state.doc, ed.registry)).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(ul(li(p('a')), li(p('text')), li(p('b'))))))
  })
})
