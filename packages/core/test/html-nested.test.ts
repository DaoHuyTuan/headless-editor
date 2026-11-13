// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Registry } from '../src/plugin/registry'
import type { ElementNode, Node } from '../src/model/types'
import { nodeText, parseHTML } from '../src/index'
import { corePlugin } from '../src/core-plugin'
import { el, stripIds, txt } from '../src/testing/index'
import { nested, testBulletList, testListItem, testQuote } from './fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

// Local plugins claiming the container tags (the shared fixtures have no parseHTML rules).
const quote = testQuote.extend({ parseHTML: [{ tag: 'blockquote' }] })
const bulletList = testBulletList.extend({ parseHTML: [{ tag: 'ul' }] })
const listItem = testListItem.extend({ parseHTML: [{ tag: 'li' }] })
const claimed = nested.map((pl) => (pl.name === 'quote' ? quote : pl.name === 'bulletList' ? bulletList : pl.name === 'listItem' ? listItem : pl))

const reg = new Registry([corePlugin, ...claimed])
const parse = (html: string) => stripIds(parseHTML(html, reg))

describe('parseHTML with claimed container tags', () => {
  it('keeps the blocks of a claimed blockquote', () => {
    expect(parse('<blockquote><p>a</p><p>b</p></blockquote>')).toEqual(stripIds([el('quote', p('a'), p('b'))]))
  })

  it("wraps a container's inline content into the textblock it expects", () => {
    expect(parse('<blockquote>y</blockquote>')).toEqual(stripIds([el('quote', p('y'))]))
  })

  it('wraps a loose inline run in a list into a list item, losing no text (Review Focus 3)', () => {
    expect(parse('<ul><li><p>a</p></li>text<li>b</li></ul>')).toEqual(
      stripIds([el('bulletList', el('listItem', p('a')), el('listItem', p('text')), el('listItem', p('b')))]),
    )
  })

  it('keeps nested lists inside a list item, after its paragraph', () => {
    expect(parse('<ul><li>a<ul><li>b</li></ul></li></ul>')).toEqual(
      stripIds([el('bulletList', el('listItem', p('a'), el('bulletList', el('listItem', p('b')))))]),
    )
  })

  it('drops whitespace between the blocks of a container', () => {
    expect(parse('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>')).toEqual(
      stripIds([el('bulletList', el('listItem', p('a')), el('listItem', p('b')))]),
    )
  })

  it('fills an empty claimed container', () => {
    expect(parse('<blockquote></blockquote>')).toEqual(stripIds([el('quote', p(''))]))
  })

  it('unclaimed container tags are still unwrapped', () => {
    const flat = new Registry([corePlugin, ...nested])
    expect(stripIds(parseHTML('<blockquote><p>a</p><p>b</p></blockquote>', flat))).toEqual(stripIds([p('a'), p('b')]))
    expect(stripIds(parseHTML('<ul><li>a</li><li>b</li></ul>', flat))).toEqual(stripIds([p('a'), p('b')]))
  })
})

describe('nodeText at depth', () => {
  it('separates the textblocks of a container with newlines', () => {
    expect(nodeText(el('quote', p('a'), p('b')), reg)).toBe('a\nb')
  })

  it('separates textblocks at every depth', () => {
    const list = el('bulletList', el('listItem', p('a'), el('bulletList', el('listItem', p('b')))), el('listItem', p('c')))
    expect(nodeText(el('quote', p('x'), list), reg)).toBe('x\na\nb\nc')
  })

  it('joins the inline content of a textblock without separators', () => {
    expect(nodeText(p('a', txt('b', 'bold')), reg)).toBe('ab')
  })
})
