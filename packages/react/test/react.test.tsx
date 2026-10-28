// @vitest-environment happy-dom
import { StrictMode, useState, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, Editor, textEntries, type EditorEventName } from '@hte/core'
import { doc, el, sel, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { bold } from '@hte/bold'
import { EditorContent, useEditor, useEditorState } from '../src/index'

const plugins = [paragraph, bold] as const
type TestEditor = Editor<typeof plugins>

/** Live (subscribed, not yet unsubscribed) listener counts per editor instance and event. */
let live: Map<Editor<any>, Map<EditorEventName, number>>
const liveCount = (ed: Editor<any>, event: EditorEventName) => live.get(ed)?.get(event) ?? 0

beforeEach(() => {
  live = new Map()
  const original = Editor.prototype.on
  vi.spyOn(Editor.prototype, 'on').mockImplementation(function (this: Editor<any>, event, fn) {
    const counts = live.get(this) ?? new Map<EditorEventName, number>()
    live.set(this, counts)
    counts.set(event, (counts.get(event) ?? 0) + 1)
    const off = original.call(this, event, fn)
    let done = false
    return () => {
      if (!done) {
        done = true
        counts.set(event, counts.get(event)! - 1)
      }
      off()
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const content = () => doc(el('paragraph', txt('abcd')))
const countX = (s: string | null) => (s ?? '').split('x').length - 1
const docText = (ed: Editor<any>) => [...textEntries(ed.getJSON())].map(([n]) => n.text).join('')

function Harness({
  onEditor,
  onUpdate,
  children,
}: {
  onEditor: (e: TestEditor) => void
  onUpdate?: (e: { editor: TestEditor }) => void
  children?: (e: TestEditor) => ReactNode
}) {
  const editor = useEditor({ plugins, content: content(), selection: sel([0, 0], 1, [0, 0], 3), onUpdate })
  onEditor(editor)
  return (
    <>
      <EditorContent editor={editor} data-testid="content" className="ed" />
      {children?.(editor)}
    </>
  )
}

describe('useEditor + EditorContent', () => {
  it('renders the paragraph text under StrictMode and forwards div props', () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    expect(root.textContent).toBe('abcd')
    expect(root.className).toBe('ed')
    expect(editor.view?.root).toBe(root)
  })

  it('StrictMode double mount: typing inserts each character once (Review Focus 5)', () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    // Exactly one view subscription and one onUpdate subscription survive the double mount.
    expect(liveCount(editor, 'transaction')).toBe(1)
    expect(liveCount(editor, 'update')).toBe(1)

    act(() => {
      editor.commands.insertText('x')
    })
    expect(countX(getByTestId('content').textContent)).toBe(1)
    expect(countX(docText(editor))).toBe(1)

    // The intent path the input module will use (Task 20) also inserts once.
    act(() => {
      editor.view!.editor.handleIntent({ inputType: 'insertText', data: 'x', range: null })
    })
    expect(countX(getByTestId('content').textContent)).toBe(2)
    expect(countX(docText(editor))).toBe(2)
  })

  it('does not destroy the editor across the StrictMode remount', () => {
    vi.useFakeTimers()
    const destroy = vi.spyOn(Editor.prototype, 'destroy')
    let editor!: TestEditor
    render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    act(() => {
      vi.runAllTimers()
    })
    expect(destroy).not.toHaveBeenCalled()
    expect(editor.view).not.toBeNull()
    act(() => {
      editor.commands.insertText('x')
    })
    expect(countX(docText(editor))).toBe(1)
  })

  it('destroys the editor (after a tick) on a real unmount', () => {
    vi.useFakeTimers()
    const destroy = vi.spyOn(Editor.prototype, 'destroy')
    let editor!: TestEditor
    const { unmount } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    unmount()
    expect(editor.view).toBeNull()
    expect(destroy).not.toHaveBeenCalled()
    act(() => {
      vi.runAllTimers()
    })
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy.mock.contexts[0]).toBe(editor)
    expect(() => editor.mount(document.createElement('div'))).toThrow()
  })

  it('keeps the editor when onUpdate changes identity and calls the latest callback', () => {
    const calls: string[] = []
    let editor!: TestEditor
    const editors = new Set<TestEditor>()
    function App() {
      const [tag, setTag] = useState('a')
      return (
        <>
          <button onClick={() => setTag('b')}>switch</button>
          <Harness
            onEditor={(e) => {
              editor = e
              editors.add(e)
            }}
            onUpdate={({ editor: ed }) => calls.push(`${tag}:${ed.getJSON().children.length}`)}
          />
        </>
      )
    }
    const { getByText } = render(<App />)
    act(() => {
      editor.commands.insertText('x')
    })
    act(() => {
      getByText('switch').click()
    })
    act(() => {
      editor.commands.insertText('y')
    })
    expect(editors.size).toBe(1)
    expect(calls).toEqual(['a:1', 'b:1'])
  })

  it('StrictMode mount → unmount → mount leaves exactly one active onMount (Review Focus 5)', () => {
    vi.useFakeTimers()
    let mounts = 0
    let cleanups = 0
    const roots: HTMLElement[] = []
    const tracker = definePlugin({
      name: 'tracker',
      onMount: (_ctx, view) => {
        mounts++
        roots.push(view.root)
        return () => void cleanups++
      },
    })
    let editor!: Editor<any>
    function App() {
      editor = useEditor({ plugins: [paragraph, tracker], content: content() })
      return <EditorContent editor={editor} data-testid="content" />
    }
    const { getByTestId, unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    act(() => {
      vi.runAllTimers()
    })
    expect(mounts).toBe(2)
    expect(mounts - cleanups).toBe(1)
    expect(roots.at(-1)).toBe(getByTestId('content'))
    expect(editor.view?.root).toBe(getByTestId('content'))
    unmount()
    act(() => {
      vi.runAllTimers()
    })
    expect(mounts - cleanups).toBe(0)
    expect(cleanups).toBe(mounts)
  })
})

describe('useEditorState', () => {
  it('re-renders when the selected value changes', () => {
    let editor!: TestEditor
    const seen: boolean[] = []
    function BoldState({ editor: ed }: { editor: TestEditor }) {
      const active = useEditorState(ed, (_, e) => e.isActive('bold'))
      seen.push(active)
      return <span data-testid="bold">{String(active)}</span>
    }
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)}>{(e) => <BoldState editor={e} />}</Harness>
      </StrictMode>,
    )
    expect(getByTestId('bold').textContent).toBe('false')
    act(() => {
      editor.commands.toggleBold()
    })
    expect(getByTestId('bold').textContent).toBe('true')
    expect(seen.at(-1)).toBe(true)
  })

  it('does not re-render when the selected value is unchanged', () => {
    let editor!: TestEditor
    let renders = 0
    function BlockCount({ editor: ed }: { editor: TestEditor }) {
      const count = useEditorState(ed, (s) => s.doc.children.length)
      renders++
      return <span data-testid="count">{count}</span>
    }
    const { getByTestId } = render(
      <Harness onEditor={(e) => (editor = e)}>{(e) => <BlockCount editor={e} />}</Harness>,
    )
    const before = renders
    act(() => {
      editor.commands.insertText('x')
    })
    act(() => {
      editor.commands.toggleBold()
    })
    expect(renders).toBe(before)
    expect(getByTestId('count').textContent).toBe('1')
  })

  it('supports a custom isEqual', () => {
    let editor!: TestEditor
    let renders = 0
    function Text({ editor: ed }: { editor: TestEditor }) {
      const value = useEditorState(
        ed,
        (s) => ({ len: JSON.stringify(s.doc).length }),
        () => true,
      )
      renders++
      return <span>{value.len}</span>
    }
    render(<Harness onEditor={(e) => (editor = e)}>{(e) => <Text editor={e} />}</Harness>)
    const before = renders
    act(() => {
      editor.commands.insertText('x')
    })
    expect(renders).toBe(before)
  })

  it('an inline object-returning selector with the default isEqual is stable (no loop, no warning)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let editor!: TestEditor
    function Toolbar({ editor: ed }: { editor: TestEditor }) {
      const state = useEditorState(ed, (_, e) => ({ bold: e.isActive('bold') }))
      return <span data-testid="tb">{String(state.bold)}</span>
    }
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)}>{(e) => <Toolbar editor={e} />}</Harness>
      </StrictMode>,
    )
    expect(getByTestId('tb').textContent).toBe('false')
    act(() => {
      editor.commands.toggleBold()
    })
    expect(getByTestId('tb').textContent).toBe('true')
    expect(errors).not.toHaveBeenCalled()
  })

  it('re-renders on a selection-only transaction that changes isActive', () => {
    let editor!: TestEditor
    function BoldState({ editor: ed }: { editor: TestEditor }) {
      const active = useEditorState(ed, (_, e) => e.isActive('bold'))
      return <span data-testid="bold">{String(active)}</span>
    }
    const { getByTestId } = render(
      <Harness onEditor={(e) => (editor = e)}>{(e) => <BoldState editor={e} />}</Harness>,
    )
    act(() => {
      editor.commands.toggleBold() // doc: a | bc(bold) | d
    })
    expect(getByTestId('bold').textContent).toBe('true')
    const select = (s: ReturnType<typeof sel>) =>
      act(() => {
        const tr = editor.createTransaction()
        tr.setSelection(s)
        editor.dispatch(tr)
      })
    select(sel([0, 0], 0, [0, 0], 1))
    expect(editor.getJSON().children[0]).toMatchObject({ children: [{ text: 'a' }, { text: 'bc' }, { text: 'd' }] })
    expect(getByTestId('bold').textContent).toBe('false')
    select(sel([0, 1], 0, [0, 1], 2))
    expect(getByTestId('bold').textContent).toBe('true')
  })
})
