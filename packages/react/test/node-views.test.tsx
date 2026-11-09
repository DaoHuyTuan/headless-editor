// @vitest-environment happy-dom
import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, nodeSelection, type Editor } from '@hte/core'
import { doc, el, sel, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { EditorContent, useEditor, type ReactNodeView } from '../src/index'

const atom = definePlugin({
  name: 'atom',
  node: { kind: 'block', atom: true },
  options: { label: 'first' },
})
const plugins = [paragraph, atom] as const
type TestEditor = Editor<typeof plugins>
type AtomData = { title: string }

/** Ids of the mounted view components (per mount effect), to check StrictMode keeps one per node. */
let live: Map<string, number>
/** `options.label` of every render of `AtomView`, in order. */
let renderedLabels: string[]

const AtomView: ReactNodeView<AtomData, { label: string }> = ({ node, selected, options, updateData }) => {
  renderedLabels.push(options.label)
  useEffect(() => {
    live.set(node.id, (live.get(node.id) ?? 0) + 1)
    return () => {
      live.set(node.id, live.get(node.id)! - 1)
    }
  }, [node.id])
  return (
    <span className="atom-view" data-selected={String(selected)}>
      <span className="title">{node.data.title}</span>
      <span className="label">{options.label}</span>
      <button data-editor-ignore="" onClick={() => updateData({ title: 'clicked' })}>
        go
      </button>
    </span>
  )
}

function Harness({
  onEditor,
  label,
}: {
  onEditor: (e: TestEditor) => void
  label?: string
}) {
  const editor = useEditor({
    plugins,
    content: doc(el('paragraph', txt('ab')), el('atom', { title: 'hello' }), el('paragraph', txt('cd'))),
    selection: sel([0, 0], 1),
    nodeViews: { atom: AtomView },
    pluginOptions: label === undefined ? undefined : { atom: { label } },
  })
  onEditor(editor)
  return <EditorContent editor={editor} data-testid="content" />
}

let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  live = new Map()
  renderedLabels = []
  errors = vi.spyOn(console, 'error')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const views = (root: HTMLElement) => root.querySelectorAll('.atom-view')

describe('React node views', () => {
  it('renders the component inside the node container with node.data and selected', () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    expect(views(root)).toHaveLength(1)
    const view = views(root)[0]!
    expect(root.children[1]!.contains(view)).toBe(true)
    expect(view.querySelector('.title')!.textContent).toBe('hello')
    expect(view.getAttribute('data-selected')).toBe('false')

    act(() => {
      const tr = editor.createTransaction()
      tr.setSelection(nodeSelection(editor.state.doc, editor.registry, [1]))
      editor.dispatch(tr)
    })
    expect(views(root)[0]!.getAttribute('data-selected')).toBe('true')
    expect(errors).not.toHaveBeenCalled()
  })

  it('updateData from a click in the component changes the doc and re-renders the view', () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    fireEvent.click(root.querySelector('button')!)
    expect((editor.state.doc.children[1] as unknown as { data: AtomData }).data.title).toBe('clicked')
    expect(root.querySelector('.title')!.textContent).toBe('clicked')
    expect(errors).not.toHaveBeenCalled()
  })

  it('removing the node (delete, then undo, then delete) unmounts the component without console errors', async () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    act(() => {
      const tr = editor.createTransaction()
      tr.removeNode([1])
      editor.dispatch(tr)
    })
    expect(views(root)).toHaveLength(0)
    expect([...live.values()].reduce((a, b) => a + b, 0)).toBe(0)

    act(() => {
      editor.commands.undo()
    })
    expect(views(root)).toHaveLength(1)
    expect(root.querySelector('.title')!.textContent).toBe('hello')

    act(() => {
      const tr = editor.createTransaction()
      tr.removeNode([1])
      editor.dispatch(tr)
    })
    expect(views(root)).toHaveLength(0)
    // Let the mutation observer see React's portal removal.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(Array.from(root.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['ab', 'cd'])
    expect(errors).not.toHaveBeenCalled()
  })

  it('a pluginOptions change re-renders the component with the new options', () => {
    let editor!: TestEditor
    const { getByTestId, rerender } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} label="one" />
      </StrictMode>,
    )
    const root = getByTestId('content')
    expect(root.querySelector('.label')!.textContent).toBe('one')
    const spy = vi.spyOn(editor, 'setPluginOptions')
    rerender(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} label="one" />
      </StrictMode>,
    )
    expect(spy).not.toHaveBeenCalled()
    rerender(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} label="two" />
      </StrictMode>,
    )
    expect(spy).toHaveBeenCalledWith('atom', { label: 'two' })
    expect(root.querySelector('.label')!.textContent).toBe('two')
    expect(errors).not.toHaveBeenCalled()
  })

  it('no render after a pluginOptions change sees the old options', () => {
    let editor!: TestEditor
    const { getByTestId, rerender } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} label="one" />
      </StrictMode>,
    )
    expect(renderedLabels.at(-1)).toBe('one')
    renderedLabels = []
    rerender(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} label="two" />
      </StrictMode>,
    )
    expect(renderedLabels.length).toBeGreaterThan(0)
    expect(renderedLabels.every((l) => l === 'two')).toBe(true)
    expect(getByTestId('content').querySelector('.label')!.textContent).toBe('two')

    // Once applied, a direct setPluginOptions call is not masked by the value the hook last saw.
    act(() => editor.setPluginOptions('atom', { label: 'three' }))
    expect(getByTestId('content').querySelector('.label')!.textContent).toBe('three')
    expect(errors).not.toHaveBeenCalled()
  })

  it('StrictMode does not double-mount node views: exactly one instance per id', () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <Harness onEditor={(e) => (editor = e)} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    expect(views(root)).toHaveLength(1)
    const id = editor.state.doc.children[1]!.id
    expect(live.get(id)).toBe(1)
    expect([...live.values()].reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('removes the portals when the editor is unmounted and destroyed', async () => {
    vi.useFakeTimers()
    const { getByTestId, unmount } = render(
      <StrictMode>
        <Harness onEditor={() => {}} />
      </StrictMode>,
    )
    expect(views(getByTestId('content'))).toHaveLength(1)
    unmount()
    act(() => {
      vi.runAllTimers()
    })
    vi.useRealTimers()
    expect([...live.values()].reduce((a, b) => a + b, 0)).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })
})

