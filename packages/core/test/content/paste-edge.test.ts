// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../../src/plugin/define'
import type { Doc, ElementNode, Node, Selection } from '../../src/model/types'
import type { AnyPlugin } from '../../src/plugin/types'
import { atomEl, createTestEditor, doc, el, sel, stripIds, txt } from '../../src/testing/index'
import { testBold, testParagraph } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))
const transfer = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer
const paste = (ed: ReturnType<typeof createTestEditor>, data: Record<string, string>) =>
  ed.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: transfer(data), range: null })
const setup = (content: Doc, selection: Selection | null, plugins: AnyPlugin[] = []) =>
  createTestEditor({ plugins: [testParagraph, testBold, ...plugins], doc: content, selection: selection ?? undefined })

afterEach(() => vi.restoreAllMocks())

describe('a throwing transformPasted (4.3)', () => {
  it('does not lose the paste: that transform is skipped, the others run, the error is reported', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = definePlugin({
      name: 'broken',
      priority: 200,
      transformPasted: () => {
        throw new Error('boom')
      },
    })
    const upper = definePlugin({
      name: 'upper',
      priority: 100,
      transformPasted: (fragment) => fragment.map((n) => ('text' in n ? { ...n, text: n.text.toUpperCase() } : n)),
    })
    const ed = setup(doc(p('ab')), sel([0, 0], 1), [broken, upper])
    expect(paste(ed, { 'text/plain': 'xy' })).toBe(true)
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('aXYb'))))
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]![0])).toContain('broken')
  })
})

describe('a paste without a model selection (4.4)', () => {
  const img = definePlugin({ name: 'img', node: { kind: 'block', atom: true } })

  it('goes to the end of the doc when the selection is null', () => {
    const ed = setup(doc(p('ab'), p('cd')), null)
    const tr = ed.createTransaction()
    tr.setSelection(null)
    ed.dispatch(tr)
    expect(ed.state.selection).toBeNull()
    paste(ed, { 'text/plain': 'xy' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(p('ab'), p('cdxy'))))
    expect(ed.state.selection).toEqual(sel([1, 0], 4))
  })

  it('goes into a new block when the doc has no editable text', () => {
    const ed = setup(doc(atomEl('img', {})), null, [img])
    expect(ed.state.selection).toBeNull()
    paste(ed, { 'text/plain': 'xy' })
    expect(stripIds(ed.getJSON())).toEqual(stripIds(doc(atomEl('img', {}), p('xy'))))
  })
})

describe('a paste at several ranges (8.3)', () => {
  it('parses the HTML flavor once, then transforms it per range', () => {
    const seen: (string | null)[] = []
    const spy = definePlugin({
      name: 'spy',
      transformPasted: (fragment, _ctx, info) => {
        seen.push(info.at ? JSON.stringify(info.at.anchor) : null)
        return fragment
      },
    })
    const ed = setup(doc(p('ab'), p('cd'), p('ef')), sel([0, 0], 1), [spy])
    const tr = ed.createTransaction()
    tr.setSelection({
      ranges: [0, 1, 2].map((i) => ({ anchor: { path: [i, 0], offset: 1 }, focus: { path: [i, 0], offset: 1 } })),
      main: 0,
    })
    ed.dispatch(tr)
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    paste(ed, { 'text/html': '<p><b>x</b></p>' })
    expect(parse).toHaveBeenCalledTimes(1)
    // Still once per range, each with its own target.
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(stripIds(ed.getJSON())).toEqual(
      stripIds(doc(p('a', txt('x', 'bold'), 'b'), p('c', txt('x', 'bold'), 'd'), p('e', txt('x', 'bold'), 'f'))),
    )
  })
})
