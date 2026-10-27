import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { z } from 'zod'
import { coerceDoc } from '../src/load'
import { normalize } from '../src/normalize'
import { definePlugin } from '../src/plugin/define'
import { Registry } from '../src/plugin/registry'
import type { AnyPlugin, PluginContext } from '../src/plugin/types'
import type { Doc } from '../src/model/types'
import { Editor } from '../src/editor'
import { Transaction } from '../src/transaction/transaction'
import { doc, el, stripIds, txt } from '../src/testing/builders'
import { testBold, testParagraph } from './fixtures'

const ctx = (plugin: AnyPlugin): PluginContext<any, any> => ({
  editor: new Editor(),
  name: plugin.name,
  options: plugin.spec.options ?? {},
  getState: () => undefined,
})

function load(r: Registry, raw: unknown): Doc {
  const tr = new Transaction({ doc: coerceDoc(raw, r), selection: null, storedMarks: null, pluginStates: new Map() }, r)
  normalize(tr, ctx)
  return tr.doc
}

let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

const r = new Registry([testParagraph, testBold])

describe('load (coerceDoc + normalize)', () => {
  it('coerces malformed content into a valid doc (Review Focus 4)', () => {
    expect(stripIds(load(r, null))).toEqual(stripIds(doc(el('paragraph', txt('')))))
    expect(stripIds(load(r, { type: 'doc', children: [{ text: 'hi' }] }))).toEqual(stripIds(doc(el('paragraph', txt('hi')))))
    expect(stripIds(load(r, { type: 'doc', children: [{ type: 'paragraph' }] }))).toEqual(
      stripIds(doc(el('paragraph', txt('')))),
    )
    const unknown = { id: 'u1', type: 'widget', data: { x: 1 }, children: [{ text: 'keep', marks: [] }] }
    expect(load(r, { type: 'doc', children: [unknown] }).children[0]).toEqual(unknown) // lossless
    expect(warn).not.toHaveBeenCalled()
  })

  it('turns any non-object into an empty doc, and never throws', () => {
    for (const raw of [undefined, 42, 'doc', true, [1, 2], () => 1]) {
      expect(coerceDoc(raw, r)).toEqual({ type: 'doc', children: [] })
    }
    expect(coerceDoc({ type: 'doc', children: 'nope' }, r)).toEqual({ type: 'doc', children: [] })
    expect(() => load(r, { children: [null, 3, { text: 5 }, { type: 7 }, { marks: 'x', text: 'a' }] })).not.toThrow()
  })

  it('fills missing id/data/marks/children', () => {
    const d = coerceDoc({ type: 'doc', children: [{ type: 'paragraph', children: [{ text: 'a', marks: [{ type: 'bold' }] }] }] }, r)
    const p = d.children[0]!
    expect(typeof p.id).toBe('string')
    expect(p.id.length).toBeGreaterThan(0)
    expect(p.data).toEqual({})
    expect(p.children).toEqual([{ text: 'a', marks: [{ type: 'bold', data: {} }] }])
  })

  it('keeps unknown mark types on text as given', () => {
    const d = load(r, { children: [{ type: 'paragraph', children: [{ text: 'a', marks: [{ type: 'glow', data: { c: 'red' } }] }] }] })
    expect(stripIds(d)).toEqual(stripIds(doc(el('paragraph', txt('a', { type: 'glow', data: { c: 'red' } })))))
  })

  it('does not mutate its input', () => {
    const raw = { type: 'doc', children: [{ type: 'paragraph', children: [{ text: 'a' }] }, { text: 'root' }] }
    const copy = structuredClone(raw)
    load(r, raw)
    expect(raw).toEqual(copy)
  })

  describe('invalid data', () => {
    const schema = z.object({ level: z.number() })

    it('drops the node with one console.warn when there is no onInvalidData hook', () => {
      const heading = definePlugin({ name: 'heading', node: { kind: 'block' }, data: schema })
      const r2 = new Registry([testParagraph, heading])
      const d = load(r2, {
        children: [
          { type: 'heading', data: { level: 'x' }, children: [{ text: 'bad' }] },
          { type: 'heading', data: { level: 2 }, children: [{ text: 'ok' }] },
        ],
      })
      expect(stripIds(d)).toEqual(stripIds(doc(el('heading', { level: 2 }, txt('ok')))))
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('uses onInvalidData(raw) to repair the data', () => {
      const seen: unknown[] = []
      const heading = definePlugin({
        name: 'heading',
        node: { kind: 'block' },
        data: schema,
        onInvalidData: (raw) => {
          seen.push(raw)
          return { level: 1 }
        },
      })
      const d = load(new Registry([testParagraph, heading]), {
        children: [{ type: 'heading', data: { level: 'x' }, children: [{ text: 'h' }] }],
      })
      expect(seen).toEqual([{ level: 'x' }])
      expect(stripIds(d)).toEqual(stripIds(doc(el('heading', { level: 1 }, txt('h')))))
      expect(warn).not.toHaveBeenCalled()
    })

    it('drops the node with one console.warn when onInvalidData returns null', () => {
      const heading = definePlugin({ name: 'heading', node: { kind: 'block' }, data: schema, onInvalidData: () => null })
      const d = load(new Registry([testParagraph, heading]), {
        children: [{ type: 'heading', data: { level: 'x' }, children: [{ text: 'h' }] }],
      })
      expect(stripIds(d)).toEqual(stripIds(doc(el('paragraph', txt('')))))
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('validates mark data the same way', () => {
      const size = definePlugin({ name: 'size', mark: { render: () => ({ tag: 'span' }) }, data: z.object({ px: z.number() }) })
      const d = load(new Registry([testParagraph, size]), {
        children: [{ type: 'paragraph', children: [{ text: 'a', marks: [{ type: 'size', data: { px: 'big' } }] }] }],
      })
      expect(stripIds(d)).toEqual(stripIds(doc(el('paragraph', txt('a')))))
      expect(warn).toHaveBeenCalledTimes(1)
    })

    it('does not validate data inside unknown elements', () => {
      const heading = definePlugin({ name: 'heading', node: { kind: 'block' }, data: schema })
      const inner = { id: 'h', type: 'heading', data: { level: 'x' }, children: [{ text: 'h', marks: [] }] }
      const widget = { id: 'w', type: 'widget', data: {}, children: [inner] }
      const d = load(new Registry([testParagraph, heading]), { children: [widget] })
      expect(d.children[0]).toEqual(widget)
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
