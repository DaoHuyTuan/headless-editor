import { describe, expect, it } from 'vitest'
import { doc, el, txt } from '../../src/testing/builders'
import {
  deepEqualJson,
  getNode,
  getParent,
  isElement,
  isText,
  nodeEntries,
  sameMarkSet,
  textEntries,
} from '../../src/model/node'
import { createId, setIdGenerator } from '../../src/model/id'

const d = doc(el('paragraph', txt('ab'), txt('cd', 'bold')))

describe('node helpers', () => {
  it('getNode / getParent', () => {
    expect(getNode(d, [0, 1])).toEqual({ text: 'cd', marks: [{ type: 'bold', data: {} }] })
    expect(() => getNode(d, [0, 5])).toThrow('Invalid path [0,5]')
    expect(getParent(d, [0, 1])).toBe(d.children[0])
    expect(getParent(d, [0])).toBe(d)
  })
  it('type guards', () => {
    expect(isText(txt('a'))).toBe(true)
    expect(isElement(el('paragraph'))).toBe(true)
    expect(isElement(txt('a'))).toBe(false)
  })
  it('nodeEntries is pre-order', () => {
    expect([...nodeEntries(d)].map(([, p]) => p)).toEqual([[0], [0, 0], [0, 1]])
  })
  it('textEntries with range', () => {
    expect([...textEntries(d)].map(([, p]) => p)).toEqual([[0, 0], [0, 1]])
    const r = { start: { path: [0, 1], offset: 0 }, end: { path: [0, 1], offset: 1 } }
    expect([...textEntries(d, r)].map(([, p]) => p)).toEqual([[0, 1]])
  })
  it('sameMarkSet', () => {
    expect(sameMarkSet([{ type: 'fs', data: { size: '12px' } }], [{ type: 'fs', data: { size: '14px' } }])).toBe(false)
    expect(
      sameMarkSet([{ type: 'a', data: {} }, { type: 'b', data: {} }], [{ type: 'b', data: {} }, { type: 'a', data: {} }]),
    ).toBe(true)
    expect(sameMarkSet([{ type: 'a', data: {} }], [])).toBe(false)
  })
  it('deepEqualJson', () => {
    expect(deepEqualJson({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true)
    expect(deepEqualJson({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqualJson([1], { 0: 1 })).toBe(false)
  })
})

describe('ids', () => {
  it('createId is 10 url-safe chars; generator overridable', () => {
    expect(createId()).toMatch(/^[A-Za-z0-9_-]{10}$/)
    let n = 0
    setIdGenerator(() => `id${++n}`)
    expect(createId()).toBe('id1')
    setIdGenerator(null)
    expect(createId()).toMatch(/^[A-Za-z0-9_-]{10}$/)
  })
  it('builders assign ids', () => {
    expect(typeof d.children[0]!.id).toBe('string')
  })
})
