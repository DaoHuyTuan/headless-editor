import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import { Registry } from '../../src/plugin/registry'

const p = definePlugin({ name: 'paragraph', node: { kind: 'block', default: true } })
const fs = definePlugin({
  name: 'fontSize',
  mark: { render: (d) => ({ tag: 'span', style: { fontSize: d.size } }) },
  data: z.object({ size: z.string().default('16px') }),
})

describe('Registry', () => {
  it('finds the default block and validates data', () => {
    const r = new Registry([p, fs])
    expect(r.defaultBlock).toBe('paragraph')
    expect(r.validateData('fontSize', {})).toEqual({ ok: true, data: { size: '16px' } })
    expect(r.validateData('fontSize', { size: 3 }).ok).toBe(false)
    expect(r.validateData('paragraph', { anything: 1 })).toEqual({ ok: true, data: { anything: 1 } })
  })

  it('reports a message for invalid data', () => {
    const res = new Registry([p, fs]).validateData('fontSize', { size: 3 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toBeTypeOf('string')
  })

  it('treats undefined data as {} and rejects non-objects without a schema', () => {
    const r = new Registry([p, fs])
    expect(r.validateData('paragraph', undefined)).toEqual({ ok: true, data: {} })
    expect(r.validateData('paragraph', [1]).ok).toBe(false)
    expect(r.validateData('paragraph', 'x').ok).toBe(false)
    expect(r.validateData('fontSize', undefined)).toEqual({ ok: true, data: { size: '16px' } })
  })

  it('passes plain objects through for unknown types', () => {
    const r = new Registry([p])
    expect(r.validateData('mystery', { a: 1 })).toEqual({ ok: true, data: { a: 1 } })
    expect(r.validateData('mystery', null).ok).toBe(false)
    expect(r.validateData('mystery', 5).ok).toBe(false)
  })

  it('rejects duplicates, missing default block and async validators', () => {
    expect(() => new Registry([p, p])).toThrow('Duplicate plugin "paragraph"')
    expect(() => new Registry([fs])).toThrow('No default block plugin registered')
    const asyncSchema = {
      '~standard': { version: 1 as const, vendor: 't', validate: async () => ({ value: {} }) },
    }
    expect(
      () => new Registry([p, definePlugin({ name: 'x', node: { kind: 'block' }, data: asyncSchema })]),
    ).toThrow('Async validators are not supported (plugin "x")')
  })

  it('sorts by priority desc, stable for ties', () => {
    const a = definePlugin({ name: 'a', priority: 50 })
    const b = definePlugin({ name: 'b', priority: 200 })
    expect(new Registry([p, a, b]).plugins.map((x) => x.name)).toEqual(['b', 'paragraph', 'a'])
    const c = definePlugin({ name: 'c' })
    const d = definePlugin({ name: 'd', priority: 100 })
    expect(new Registry([c, p, d]).plugins.map((x) => x.name)).toEqual(['c', 'paragraph', 'd'])
  })

  it('looks up nodes and marks, and ranks marks by registration order', () => {
    const bold = definePlugin({ name: 'bold', priority: 500, mark: { render: () => ({ tag: 'strong' }) } })
    const r = new Registry([p, fs, bold])
    expect(r.node('paragraph')).toMatchObject({ kind: 'block', default: true, plugin: p })
    expect(r.node('fontSize')).toBeUndefined()
    expect(r.node('nope')).toBeUndefined()
    expect(r.mark('bold')?.plugin).toBe(bold)
    expect(r.mark('bold')?.render({}, { options: {} })).toEqual({ tag: 'strong' })
    expect(r.mark('paragraph')).toBeUndefined()
    expect(r.markRank('fontSize')).toBeLessThan(r.markRank('bold'))
    expect(r.markRank('bold')).toBeLessThan(r.markRank('unknown'))
  })
})

describe('definePlugin', () => {
  it('configure merges options into a new plugin', () => {
    const m = definePlugin({ name: 'm', options: { n: 1, s: 'x' } })
    const m2 = m.configure({ n: 2 })
    expect(m2.spec.options).toEqual({ n: 2, s: 'x' })
    expect(m2.name).toBe('m')
    expect(m2).not.toBe(m)
    expect(m.spec.options).toEqual({ n: 1, s: 'x' })
  })

  it('extend merges spec fields into a new plugin', () => {
    const m = definePlugin({ name: 'm', options: { n: 1, s: 'x' } })
    const e = m.extend({ priority: 7 })
    expect(e.spec.priority).toBe(7)
    expect(e.spec.options).toEqual({ n: 1, s: 'x' })
    expect(m.spec.priority).toBeUndefined()
    expect(e.configure({ s: 'y' }).spec).toMatchObject({ priority: 7, options: { n: 1, s: 'y' } })
  })
})
