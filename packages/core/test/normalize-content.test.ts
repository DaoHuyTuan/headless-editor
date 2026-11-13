import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '../src/editor'
import type { DeepReadonly, Doc, ElementNode, Node } from '../src/model/types'
import { applyOp } from '../src/ops/apply'
import { invertOp } from '../src/ops/invert'
import { normalize } from '../src/normalize'
import { Registry } from '../src/plugin/registry'
import type { AnyPlugin, PluginContext } from '../src/plugin/types'
import { isValidDoc } from '../src/schema/validate'
import { createTestEditor, doc, el, sel, stripIds, txt } from '../src/testing/index'
import { Transaction } from '../src/transaction/transaction'
import { nested } from './fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

const ctx = (plugin: AnyPlugin): PluginContext<any, any> => ({
  editor: {} as Editor,
  name: plugin.name,
  options: plugin.spec.options ?? {},
  getState: () => undefined,
  storage: undefined,
  commands: {},
})

const registry = new Registry(nested)

/** Normalizes `d` in a fresh tr (no edits yet: the whole doc is checked, as on load). */
function run(d: DeepReadonly<Doc>): Transaction {
  const tr = new Transaction({ doc: d as Doc, selection: null, storedMarks: null, pluginStates: new Map() }, registry)
  normalize(tr, ctx)
  return tr
}

/** The doc after loading `d` into an editor with the nested fixtures. */
const loaded = (d: Doc) => stripIds(createTestEditor({ plugins: nested, doc: d }).getJSON())

afterEach(() => vi.restoreAllMocks())

describe('normalize: content rule at every depth', () => {
  it('wraps a paragraph in a bullet list into a list item (findWrapping)', () => {
    expect(loaded(doc(el('bulletList', p('a'))))).toEqual(stripIds(doc(el('bulletList', el('listItem', p('a'))))))
  })

  it('fills an empty bullet list with a list item holding an empty paragraph (no text leaf in containers)', () => {
    expect(loaded(doc(el('bulletList')))).toEqual(stripIds(doc(el('bulletList', el('listItem', p(''))))))
  })

  it('wraps an inline run inside a quote into a paragraph', () => {
    expect(loaded(doc(el('quote', txt('a'))))).toEqual(stripIds(doc(el('quote', p('a')))))
  })

  it('wraps a list item at the root into a bullet list', () => {
    expect(loaded(doc(el('listItem', p('a'))))).toEqual(stripIds(doc(el('bulletList', el('listItem', p('a'))))))
  })

  it('wraps a table row at the root into a table', () => {
    expect(loaded(doc(el('tableRow', el('tableCell', p('a')))))).toEqual(
      stripIds(doc(el('table', el('tableRow', el('tableCell', p('a')))))),
    )
  })

  it('unwraps a quote nested in a paragraph (rule 9, as today)', () => {
    expect(loaded(doc(p('a', el('quote', p('b')))))).toEqual(stripIds(doc(p('ab'))))
  })

  it('unwraps a list item inside a code block: its text ends up in the code block, nothing is logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loaded(doc(el('code', txt('a'), el('listItem', p('b')))))).toEqual(stripIds(doc(el('code', txt('ab')))))
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves an unknown type in a list untouched (a wildcard), with no normalize ops', () => {
    const d = doc(el('bulletList', el('mystery', {}, p('x'))))
    const tr = run(d)
    expect(tr.ops).toEqual([])
    expect(tr.doc).toBe(d)
  })

  it('removes marks a code block does not allow (rule 8 via marks)', () => {
    expect(loaded(doc(el('code', txt('a', 'bold'), txt('b'))))).toEqual(stripIds(doc(el('code', txt('ab')))))
  })

  it('fills an empty table row with a cell holding a paragraph', () => {
    expect(loaded(doc(el('table', el('tableRow'))))).toEqual(stripIds(doc(el('table', el('tableRow', el('tableCell', p('')))))))
  })

  it('emits invertible ops for nested fixes', () => {
    const d = doc(el('bulletList', p('a'), txt('b')), el('tableRow', el('tableCell')), el('quote'))
    const tr = run(d)
    expect(isValidDoc(tr.doc, registry)).toBe(true)
    expect(tr.ops.reduce(applyOp, d)).toEqual(tr.doc)
    expect([...tr.ops].reverse().map(invertOp).reduce(applyOp, tr.doc as Doc)).toEqual(d)
    expect(run(tr.doc).ops).toEqual([])
  })

  it('checks content touched by an edit: removing the only list item refills the list', () => {
    const e = createTestEditor({ plugins: nested, doc: doc(el('bulletList', el('listItem', p('a')))), selection: sel([0, 0, 0, 0], 0) })
    const tr = e.createTransaction()
    tr.removeNode([0, 0])
    e.dispatch(tr)
    expect(stripIds(e.getJSON())).toEqual(stripIds(doc(el('bulletList', el('listItem', p(''))))))
  })
})

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES = ['paragraph', 'quote', 'bulletList', 'listItem', 'table', 'tableRow', 'tableCell', 'code']

function randomNode(rand: () => number, depth: number): Node {
  if (depth >= 4 || rand() < 0.3) return rand() < 0.3 ? txt('t', 'bold') : txt('t')
  const type = TYPES[Math.floor(rand() * TYPES.length)]!
  const count = Math.floor(rand() * 4)
  const children = Array.from({ length: count }, () => randomNode(rand, depth + 1))
  return el(type, ...children)
}

describe('normalize: schema validity', () => {
  it('200 seeded random trees all end valid, each in under 500 ops', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = prng(seed)
      const children = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => randomNode(rand, 0))
      const d = { type: 'doc', children } as Doc
      const tr = run(d)
      expect(isValidDoc(tr.doc, registry), `seed ${seed}`).toBe(true)
      expect(tr.ops.length, `seed ${seed}`).toBeLessThan(500)
      expect(run(tr.doc).ops, `seed ${seed} is idempotent`).toEqual([])
    }
  })

  it('a 200-deep quote nest normalizes to a valid doc', () => {
    let node: ElementNode = p('deep')
    for (let i = 0; i < 200; i++) node = el('quote', node)
    const tr = run(doc(node))
    expect(isValidDoc(tr.doc, registry)).toBe(true)
    expect(tr.ops).toEqual([])
    let empty: ElementNode = el('quote')
    for (let i = 0; i < 200; i++) empty = el('quote', empty)
    expect(isValidDoc(run(doc(empty)).doc, registry)).toBe(true)
  })

  it('isValidDoc rejects content that does not match', () => {
    expect(isValidDoc(doc(el('bulletList', p('a'))), registry)).toBe(false)
    expect(isValidDoc(doc(el('quote', txt('a'))), registry)).toBe(false)
    expect(isValidDoc(doc(el('code', txt('a', 'bold'))), registry)).toBe(false)
    expect(isValidDoc(doc(), registry)).toBe(false)
    expect(isValidDoc(doc(el('bulletList', el('listItem', p('a')))), registry)).toBe(true)
  })
})
