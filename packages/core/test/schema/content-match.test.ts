import { describe, expect, it } from 'vitest'
import { parseContentExpr } from '../../src/schema/content-expr'
import {
  compileContent,
  type ContentMatch,
  type SchemaLookup,
} from '../../src/schema/content-match'

const groups: Record<string, string[]> = {
  block: ['paragraph', 'quote', 'bulletList', 'table'],
  inline: ['text', 'mention'],
}
const nodes = new Set([
  'paragraph', 'quote', 'bulletList', 'listItem', 'table', 'tableRow',
  'tableCell', 'text', 'mention', 'a', 'b', 'unknownX',
])
const notCreatable = new Set(['b', 'text'])
const contents: Record<string, string> = {
  listItem: 'paragraph block*',
  bulletList: 'listItem+',
  quote: 'block+',
  table: 'tableRow+',
  tableRow: 'tableCell+',
  tableCell: 'block+',
}

const compiled = new Map<string, ContentMatch | null>()
const lookup: SchemaLookup = {
  expand: (name) => groups[name] ?? (nodes.has(name) ? [name] : undefined),
  autoCreatable: (t) => !notCreatable.has(t),
  contentOf: (t) => {
    if (!(t in contents)) return null
    if (!compiled.has(t)) {
      compiled.set(t, null) // guards cyclic compilation
      compiled.set(t, compileContent(parseContentExpr(contents[t]!), lookup))
    }
    return compiled.get(t) ?? null
  },
}
const compile = (src: string) => compileContent(parseContentExpr(src), lookup)
const known = (t: string) => nodes.has(t) && t !== 'unknownX'

describe('parseContentExpr', () => {
  it('parses a sequence with a repeat', () => {
    expect(parseContentExpr('paragraph block*')).toEqual({
      kind: 'seq',
      items: [
        { kind: 'name', name: 'paragraph' },
        { kind: 'repeat', expr: { kind: 'name', name: 'block' }, min: 0, max: Infinity },
      ],
    })
  })
  it('parses quantifiers and groups', () => {
    expect(parseContentExpr('(a | b){2,3}')).toEqual({
      kind: 'repeat',
      expr: { kind: 'choice', items: [{ kind: 'name', name: 'a' }, { kind: 'name', name: 'b' }] },
      min: 2,
      max: 3,
    })
    expect(parseContentExpr('a?')).toMatchObject({ kind: 'repeat', min: 0, max: 1 })
    expect(parseContentExpr('a+')).toMatchObject({ kind: 'repeat', min: 1, max: Infinity })
    expect(parseContentExpr('a{2,}')).toMatchObject({ kind: 'repeat', min: 2, max: Infinity })
    expect(parseContentExpr('a{2}')).toMatchObject({ kind: 'repeat', min: 2, max: 2 })
  })
  it.each(['a (', 'a{3,1}', '|a', 'a |', ')', 'a{', '', 'a $'])(
    'throws SyntaxError mentioning the source for %j',
    (src) => {
      expect(() => parseContentExpr(src)).toThrow(SyntaxError)
      expect(() => parseContentExpr(src)).toThrow(src === "" ? 'column' : src)
    },
  )
  it('reports the column', () => {
    expect(() => parseContentExpr('a )')).toThrow(/column 3/)
  })
})

describe('compileContent', () => {
  it('matches types in order', () => {
    const m = compile('paragraph block*')
    expect(m.validEnd).toBe(false)
    expect(m.matchType('quote')).toBeNull()
    const p = m.matchType('paragraph')!
    expect(p.validEnd).toBe(true)
    expect(p.matchType('quote')).not.toBeNull()
    expect(m.edges.map((e) => e.type)).toEqual(['paragraph'])
  })
  it('lists edges in expression order', () => {
    expect(compile('block').edges.map((e) => e.type)).toEqual(['paragraph', 'quote', 'bulletList', 'table'])
  })
  it('handles ambiguity with a DFA', () => {
    const m = compile('a* a')
    expect(m.matchTypes(['a'], known)!.validEnd).toBe(true)
    expect(m.matchTypes(['a', 'a'], known)!.validEnd).toBe(true)
    expect(m.matchTypes([], known)!.validEnd).toBe(false)
  })
  it('honours counted repeats', () => {
    const m = compile('a{2,3}')
    expect(m.matchTypes(['a'], known)!.validEnd).toBe(false)
    expect(m.matchTypes(['a', 'a', 'a'], known)!.validEnd).toBe(true)
    expect(m.matchTypes(['a', 'a', 'a', 'a'], known)).toBeNull()
  })
  it('treats unknown types as wildcards', () => {
    const m = compile('paragraph block*')
    const r = m.matchTypes(['unknownX'], known)!
    expect(r.validEnd).toBe(true)
    expect(m.matchTypes(['unknownX', 'quote'], known)).not.toBeNull()
  })
  it('throws on unknown names', () => {
    expect(() => compile('nope')).toThrow(/nope/)
  })
  it('exposes defaultType', () => {
    expect(compile('block+').defaultType).toBe('paragraph')
    expect(compile('b a').defaultType).toBeNull()
    expect(compile('b | a').defaultType).toBe('a')
  })
})

describe('fillBefore', () => {
  it('fills a required child', () => {
    expect(compile('listItem+').fillBefore([], true, known)).toEqual(['listItem'])
  })
  it('fills before existing content', () => {
    expect(compile('paragraph block*').fillBefore(['quote'], true, known)).toEqual(['paragraph'])
  })
  it('returns [] when nothing is needed', () => {
    expect(compile('block*').fillBefore([], true, known)).toEqual([])
  })
  it('returns null when a needed type is not auto-creatable', () => {
    expect(compile('a b').fillBefore([], true, known)).toBeNull()
  })
  it('terminates on cyclic expressions', () => {
    expect(compile('(a b)*').fillBefore(['b', 'b'], true, known)).toBeNull()
  })
})

describe('findWrapping', () => {
  it('wraps a paragraph in a listItem', () => {
    expect(compile('listItem+').findWrapping('paragraph')).toEqual(['listItem'])
  })
  it('returns [] when the type fits directly', () => {
    expect(compile('block+').findWrapping('paragraph')).toEqual([])
  })
  it('wraps a listItem in a bulletList', () => {
    expect(compile('block+').findWrapping('listItem')).toEqual(['bulletList'])
  })
  it('finds multi-level wrapping', () => {
    expect(compile('block+').findWrapping('tableCell')).toEqual(['table', 'tableRow'])
  })
  it('returns null when impossible', () => {
    expect(compile('listItem+').findWrapping('tableRow')).toBeNull()
  })
  it('terminates on cyclic schemas', () => {
    expect(compile('block+').findWrapping('unknownX')).toBeNull()
  })
})

describe('findWrapping completability', () => {
  it('skips a wrapper whose content cannot be completed', () => {
    contents.badWrap = 'tableCell b'
    contents.goodWrap = 'tableCell'
    groups.wrappers = ['badWrap', 'goodWrap']
    nodes.add('badWrap').add('goodWrap')
    try {
      expect(compile('wrappers').findWrapping('tableCell')).toEqual(['goodWrap'])
      expect(compile('badWrap').findWrapping('tableCell')).toBeNull()
    } finally {
      delete contents.badWrap
      delete contents.goodWrap
      delete groups.wrappers
      nodes.delete('badWrap')
      nodes.delete('goodWrap')
      compiled.clear()
    }
  })
  it('works from a mid-state', () => {
    const mid = compile('paragraph block*').matchType('paragraph')!
    expect(mid.findWrapping('listItem')).toEqual(['bulletList'])
  })
})
