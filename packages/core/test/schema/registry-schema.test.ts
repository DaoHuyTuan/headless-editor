import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ElementNode, Node } from '../../src/model/types'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'
import { el, stripIds, txt } from '../../src/testing/index'
import { nested, testBold, testParagraph } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

const mention = definePlugin({ name: 'mention', node: { kind: 'inline', atom: true } })
const edgeTypes = (r: Registry, type: string): string[] => r.contentMatch(type)!.edges.map((e) => e.type)

describe('Registry schema', () => {
  const r = new Registry([...nested, mention])

  it('tells textblocks from containers', () => {
    expect(r.isTextblock('paragraph')).toBe(true)
    expect(r.isTextblock('code')).toBe(true)
    expect(r.isTextblock('quote')).toBe(false)
    expect(r.isTextblock('listItem')).toBe(false)
    expect(r.isTextblock('mention')).toBe(false)
    expect(r.isTextblock('nope')).toBe(false)
  })

  it('reads an omitted content on a non-atom block as inline content', () => {
    const bare = definePlugin({ name: 'bare', node: { kind: 'block' } })
    const r2 = new Registry([testParagraph, bare, mention])
    expect(r2.isTextblock('bare')).toBe(true)
    expect(r2.allowsInline('bare', 'mention')).toBe(true)
    expect(r2.contentMatch('bare')!.matchType('paragraph')).toBeNull()
    expect(r2.contentMatch('bare')!.validEnd).toBe(true)
  })

  it("treats 'inline' as 'inline*' and 'text' as 'text*' with no marks", () => {
    const star = definePlugin({ name: 'star', node: { kind: 'block', content: 'inline*' } })
    const textStar = definePlugin({ name: 'textStar', node: { kind: 'block', content: 'text*' } })
    const r2 = new Registry([...nested, mention, star, textStar])
    expect(edgeTypes(r2, 'paragraph')).toEqual(edgeTypes(r2, 'star'))
    expect(edgeTypes(r2, 'paragraph')).toEqual(['text', 'mention'])
    expect(r2.contentMatch('paragraph')!.validEnd).toBe(true)
    expect(edgeTypes(r2, 'code')).toEqual(['text'])
    expect(edgeTypes(r2, 'code')).toEqual(edgeTypes(r2, 'textStar'))
    expect(r2.contentMatch('code')!.validEnd).toBe(true)
    expect(r2.allowsMark('code', 'bold')).toBe(false)
    expect(r2.allowsMark('textStar', 'bold')).toBe(true)
    expect(r2.allowsMark('paragraph', 'bold')).toBe(true)
    expect(r2.allowsInline('code', 'mention')).toBe(false)
    expect(r2.allowsInline('paragraph', 'mention')).toBe(true)
    expect(r2.allowsInline('quote', 'mention')).toBe(false)
  })

  it("reads 'marks': '_' all, '' none, or names", () => {
    const italic = definePlugin({ name: 'italic', mark: { render: () => ({ tag: 'em' }) } })
    const none = definePlugin({ name: 'none', node: { kind: 'block', marks: '' } })
    const some = definePlugin({ name: 'some', node: { kind: 'block', marks: 'italic' } })
    const all = definePlugin({ name: 'all', node: { kind: 'block', content: 'text', marks: '_' } })
    const r2 = new Registry([testParagraph, testBold, italic, none, some, all])
    expect(r2.allowsMark('none', 'bold')).toBe(false)
    expect(r2.allowsMark('some', 'bold')).toBe(false)
    expect(r2.allowsMark('some', 'italic')).toBe(true)
    expect(r2.allowsMark('all', 'bold')).toBe(true)
  })

  it('creates nodes with their required content filled', () => {
    expect(stripIds(r.createAndFill('bulletList')!)).toEqual(stripIds(el('bulletList', el('listItem', p('')))))
    expect(stripIds(r.createAndFill('table')!)).toEqual(
      stripIds(el('table', el('tableRow', el('tableCell', p(''))))),
    )
    expect(stripIds(r.createAndFill('code')!)).toEqual(stripIds(el('code', txt(''))))
    expect(stripIds(r.createAndFill('mention')!)).toEqual({ type: 'mention', data: {} })
    expect(r.createAndFill('nope')).toBeNull()
    expect(typeof r.createAndFill('quote')!.id).toBe('string')
  })

  it('parses the given data and returns null when it is invalid', () => {
    const heading = definePlugin({
      name: 'heading',
      node: { kind: 'block', content: 'inline' },
      data: z.object({ level: z.number().default(1) }),
    })
    const r2 = new Registry([testParagraph, heading])
    expect(r2.createAndFill('heading')!.data).toEqual({ level: 1 })
    expect(r2.createAndFill('heading', { level: 3 })!.data).toEqual({ level: 3 })
    expect(r2.createAndFill('heading', { level: 'x' })).toBeNull()
  })

  it('keeps types with a group of their own out of block', () => {
    const doc = r.contentMatch('doc')!
    expect(doc.matchType('listItem')).toBeNull()
    expect(doc.matchType('tableCell')).toBeNull()
    expect(doc.matchType('paragraph')).not.toBeNull()
    expect(doc.matchType('quote')).not.toBeNull()
    expect(doc.validEnd).toBe(false)
    expect(doc.defaultType).toBe('paragraph')
    expect(r.contentMatch('nope')).toBeUndefined()
    expect(r.contentMatch('mention')).toBeUndefined()
  })

  it('reports isolating nodes', () => {
    expect(r.isIsolating('tableCell')).toBe(true)
    expect(r.isIsolating('quote')).toBe(false)
    expect(r.isIsolating('nope')).toBe(false)
  })

  it('accepts groups in expressions', () => {
    const callout = definePlugin({
      name: 'callout',
      node: { kind: 'block', content: 'heading block*', group: ['block', 'box'] },
    })
    const heading = definePlugin({ name: 'heading', node: { kind: 'block', content: 'inline', group: 'title' } })
    const shelf = definePlugin({ name: 'shelf', node: { kind: 'block', content: 'box+' } })
    const r2 = new Registry([testParagraph, callout, heading, shelf])
    expect(r2.contentMatch('doc')!.matchType('callout')).not.toBeNull()
    expect(r2.contentMatch('doc')!.matchType('heading')).toBeNull()
    expect(edgeTypes(r2, 'shelf')).toEqual(['callout'])
    expect(stripIds(r2.createAndFill('shelf')!)).toEqual(stripIds(el('shelf', el('callout', el('heading', txt(''))))))
  })
})

describe('Registry schema errors', () => {
  it('names the plugin for an unknown node or group', () => {
    const x = definePlugin({ name: 'x', node: { kind: 'block', content: 'nope+' } })
    expect(() => new Registry([testParagraph, x])).toThrow(/plugin "x".*unknown node or group "nope"/)
  })

  it('names the plugin for a syntax error', () => {
    const x = definePlugin({ name: 'x', node: { kind: 'block', content: 'paragraph(' } })
    expect(() => new Registry([testParagraph, x])).toThrow(/plugin "x"/)
  })

  it('throws for types that can never be created', { timeout: 2000 }, () => {
    const a = definePlugin({ name: 'a', node: { kind: 'block', content: 'b+' } })
    const b = definePlugin({ name: 'b', node: { kind: 'block', content: 'a+' } })
    expect(() => new Registry([testParagraph, a, b])).toThrow(/cannot be created/)
  })

  it('creates a type through a cycle that has a way out', () => {
    const a = definePlugin({ name: 'a', node: { kind: 'block', content: 'b', group: [] } })
    const b = definePlugin({ name: 'b', node: { kind: 'block', content: 'a | paragraph', group: [] } })
    const r = new Registry([testParagraph, a, b])
    expect(stripIds(r.createAndFill('b')!)).toEqual(stripIds(el('b', p(''))))
    expect(stripIds(r.createAndFill('a')!)).toEqual(stripIds(el('a', el('b', p('')))))
  })

  it('a required type whose data rejects {} makes its parent not auto-creatable', () => {
    const strict = definePlugin({
      name: 'strict',
      node: { kind: 'block', content: 'inline', group: [] },
      data: z.object({ n: z.number() }),
    })
    const wrap = definePlugin({ name: 'wrap', node: { kind: 'block', content: 'strict+' } })
    const r = new Registry([testParagraph, strict, wrap])
    expect(r.createAndFill('strict')).toBeNull()
    expect(stripIds(r.createAndFill('strict', { n: 1 })!)).toEqual(stripIds(el('strict', { n: 1 }, txt(''))))
    expect(r.createAndFill('wrap')).toBeNull()
    expect(r.contentMatch('doc')!.defaultType).toBe('paragraph')
  })

  it('throws when the doc content has no auto-creatable start', () => {
    const strict = definePlugin({
      name: 'strict',
      node: { kind: 'block', content: 'inline', group: [] },
      data: z.object({ n: z.number() }),
    })
    const wrap = definePlugin({ name: 'wrap', node: { kind: 'block', default: true, content: 'strict+' } })
    expect(() => new Registry([strict, wrap])).toThrow(/cannot be created/)
  })
})
