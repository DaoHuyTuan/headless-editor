// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, Editor, type Decoration, type NodeViewProps } from '@penline/core'
import { doc, el, sel, txt } from '@penline/core/testing'
import { paragraph } from '@penline/paragraph'
import { EditorContent, useEditor, usePluginState } from '../src/index'

afterEach(cleanup)

/** Counts doc-changing transactions. */
const edits = definePlugin({
  name: 'edits',
  state: {
    init: () => ({ n: 0 }),
    apply: (tr, prev: { n: number }) => (tr.docChanged ? { n: prev.n + 1 } : prev),
  },
})

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

  it('a stateless plugin gives undefined and never re-renders', () => {
    const stateless = definePlugin({ name: 'stateless' })
    const editor = new Editor({ plugins: [paragraph, stateless] as const, content: doc(el('paragraph', txt('ab'))) })
    let renders = 0
    const seen: unknown[] = []
    function View() {
      renders++
      seen.push(usePluginState(editor, stateless))
      return null
    }
    render(<View />)
    const before = renders
    act(() => {
      editor.commands.insertText('x')
    })
    expect(renders).toBe(before)
    expect(seen.every((s) => s === undefined)).toBe(true)
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

describe('usePluginState inside a mounted editor (StrictMode)', () => {
  it('typing into a zero-width text beside an inline atom updates the state and the DOM', () => {
    const chip = definePlugin({ name: 'chip', node: { kind: 'inline', atom: true } })
    let editor!: Editor<readonly [typeof paragraph, typeof chip, typeof edits]>
    function Count() {
      return <output>{usePluginState(editor, edits).n}</output>
    }
    function App() {
      editor = useEditor({
        plugins: [paragraph, chip, edits],
        content: doc(el('paragraph', txt(''), el('chip'), txt(''))),
      })
      return (
        <>
          <EditorContent editor={editor} data-testid="content" />
          <Count />
        </>
      )
    }
    const { container, getByTestId } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    expect(getByTestId('content').querySelector('[data-penline-zw]')).not.toBeNull()
    expect(container.querySelector('output')!.textContent).toBe('0')
    act(() => {
      editor.dispatch(editor.createTransaction().insertText('z', { anchor: { path: [0, 2], offset: 0 }, focus: { path: [0, 2], offset: 0 } }))
    })
    expect(container.querySelector('output')!.textContent).toBe('1')
    expect(getByTestId('content').textContent).toContain('z')
  })

  it('an atom node view re-renders from usePluginState; props.state alone stays stale', () => {
    const card = definePlugin({ name: 'card', node: { kind: 'block', atom: true } })
    const Card = ({ editor: ed }: NodeViewProps) => <b className="live">{usePluginState(ed, edits).n}</b>
    // A view rendering `props.state` of a stateful node plugin.
    const counted = definePlugin({
      name: 'counted',
      node: { kind: 'block', atom: true },
      state: {
        init: () => ({ n: 0 }),
        apply: (tr, prev: { n: number }) => (tr.docChanged ? { n: prev.n + 1 } : prev),
      },
    })
    const Counted = (props: NodeViewProps<object, unknown, unknown, { n: number }>) => (
      <em className="stale">{props.state.n}</em>
    )
    let editor!: Editor<readonly [typeof paragraph, typeof card, typeof counted, typeof edits]>
    function App() {
      editor = useEditor({
        plugins: [paragraph, card, counted, edits],
        content: doc(el('paragraph', txt('ab')), el('card'), el('counted')),
        nodeViews: { card: Card, counted: Counted },
      })
      return <EditorContent editor={editor} data-testid="content" />
    }
    const { getByTestId } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    const root = getByTestId('content')
    act(() => {
      editor.dispatch(editor.createTransaction().insertText('x', { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } }))
    })
    expect(root.querySelector('.live')!.textContent).toBe('1')
    expect(editor.getPluginState<{ n: number }>('counted').n).toBe(1)
    // The view was not updated (its data, `selected` and options did not change).
    expect(root.querySelector('.stale')!.textContent).toBe('0')
  })

  it('state that drives decorations: the view and the decorated text update in the same commit', () => {
    const highlight = definePlugin({
      name: 'highlight',
      state: {
        init: () => ({ on: false }),
        apply: (tr, prev: { on: boolean }) => (tr.meta['highlight'] !== undefined ? { on: !!tr.meta['highlight'] } : prev),
      },
      decorations: (_state, ctx): Decoration[] =>
        ctx.getState()!.on
          ? [{ type: 'inline', from: { path: [0, 0], offset: 0 }, to: { path: [0, 0], offset: 2 }, attrs: { class: 'hl' } }]
          : [],
    })
    let editor!: Editor<readonly [typeof paragraph, typeof highlight]>
    const seen: { on: boolean; decorated: boolean }[] = []
    function Status() {
      const { on } = usePluginState(editor, highlight)
      seen.push({ on, decorated: document.querySelector('.hl') !== null })
      return <output>{String(on)}</output>
    }
    function App() {
      editor = useEditor({ plugins: [paragraph, highlight], content: doc(el('paragraph', txt('ab'))) })
      return (
        <>
          <EditorContent editor={editor} data-testid="content" />
          <Status />
        </>
      )
    }
    const { container, getByTestId } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    act(() => {
      editor.dispatch(editor.createTransaction().setMeta('highlight', true))
    })
    expect(container.querySelector('output')!.textContent).toBe('true')
    expect(getByTestId('content').querySelector('.hl')!.textContent).toBe('ab')
    // The view rendered after the core re-rendered the decorations.
    expect(seen.at(-1)).toEqual({ on: true, decorated: true })
  })
})
