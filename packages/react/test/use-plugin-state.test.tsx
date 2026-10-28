// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, Editor } from '@hte/core'
import { doc, el, sel, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { usePluginState } from '../src/index'

afterEach(cleanup)

const counter = definePlugin({
  name: 'counter',
  state: {
    init: () => ({ count: 0 }),
    apply: (tr, prev: { count: number }) => (tr.meta['bump'] ? { count: prev.count + 1 } : prev),
  },
})

function setup() {
  const editor = new Editor({
    plugins: [paragraph, counter] as const,
    content: doc(el('paragraph', txt('ab'))),
    selection: sel([0, 0], 1),
  })
  let renders = 0
  let last: { count: number } | undefined
  function View() {
    renders++
    const s = usePluginState(editor, counter)
    // Type check: s is { count: number }.
    last = s
    return <span>{s.count}</span>
  }
  const utils = render(<View />)
  return { editor, utils, renders: () => renders, last: () => last }
}

describe('usePluginState', () => {
  it('updates when the plugin state changes', () => {
    const { editor, utils } = setup()
    expect(utils.container.textContent).toBe('0')
    act(() => {
      const tr = editor.createTransaction()
      tr.setMeta('bump', true)
      editor.dispatch(tr)
    })
    expect(utils.container.textContent).toBe('1')
  })

  it('does not re-render on unrelated transactions', () => {
    const { editor, renders } = setup()
    const before = renders()
    act(() => {
      editor.dispatch(editor.createTransaction().setSelection(sel([0, 0], 2)))
      editor.dispatch(editor.createTransaction().insertText('x'))
    })
    expect(renders()).toBe(before)
  })
})
