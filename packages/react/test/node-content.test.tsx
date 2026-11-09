// @vitest-environment happy-dom
import { StrictMode, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, modelToDom, type Editor, type TextNode } from '@hte/core'
import { doc, el, sel, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { EditorContent, NodeContent, useEditor, type ReactNodeView } from '../src/index'

const box = definePlugin({
  name: 'box',
  node: { kind: 'block', content: 'inline' },
})
const plugins = [paragraph, box] as const
type TestEditor = Editor<typeof plugins>

const BoxView: ReactNodeView<{ tone?: string }> = ({ node }) => (
  <section className="box-view" data-tone={node.data.tone ?? ''}>
    <div className="box-header" contentEditable={false} suppressContentEditableWarning>
      Box
    </div>
    <NodeContent className="box-body" />
  </section>
)

const NoContentView: ReactNodeView = () => (
  <section className="bad-view" contentEditable={false} suppressContentEditableWarning>
    nothing
  </section>
)

function Harness({
  onEditor,
  view,
  tick,
  dev = true,
}: {
  onEditor: (e: TestEditor) => void
  view: ReactNodeView<any>
  tick: number
  dev?: boolean
}) {
  const editor = useEditor({
    plugins,
    content: doc(el('paragraph', txt('ab')), el('box', txt('hello'))),
    selection: sel([0, 0], 1),
    nodeViews: { box: view },
    dev,
  })
  onEditor(editor)
  return <EditorContent editor={editor} data-testid="content" data-tick={tick} />
}

/** Re-renders the harness on demand (a parent state change). */
function App({
  onEditor,
  view,
  onBump,
  dev,
}: {
  onEditor: (e: TestEditor) => void
  view: ReactNodeView<any>
  onBump: (bump: () => void) => void
  dev?: boolean
}) {
  const [tick, setTick] = useState(0)
  onBump(() => setTick((t) => t + 1))
  return <Harness onEditor={onEditor} view={view} tick={tick} dev={dev} />
}

const flushAct = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

let errors: ReturnType<typeof vi.spyOn>
let warns: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errors = vi.spyOn(console, 'error')
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
})

const texts = (editor: TestEditor) =>
  editor.state.doc.children.map((n) => (n.children ?? []).map((t) => (t as TextNode).text).join(''))

describe('NodeContent', () => {
  it('places contentDOM once under StrictMode and keeps typed content across re-renders', async () => {
    const moves: Node[] = []
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n.nodeType === 1 && (n as Element).hasAttribute('data-hte-content')) moves.push(n)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    let editor!: TestEditor
    let bump!: () => void
    const { getByTestId } = render(
      <StrictMode>
        <App onEditor={(e) => (editor = e)} view={BoxView} onBump={(b) => (bump = b)} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    observer.disconnect()

    const content = root.querySelector<HTMLElement>('[data-hte-content]')!
    expect(content).not.toBeNull()
    expect(content.parentElement!.className).toBe('box-body')
    expect(content.parentElement!.parentElement!.className).toBe('box-view')
    expect(content.textContent).toBe('hello')
    expect(moves).toEqual([content])

    // Type inside the box.
    const pos = modelToDom(editor.view!.renderer, { path: [1, 0], offset: 5 })
    document.getSelection()!.setBaseAndExtent(pos.node, pos.offset, pos.node, pos.offset)
    act(() => {
      content.firstChild!.dispatchEvent(
        new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '!' }),
      )
    })
    expect(texts(editor)).toEqual(['ab', 'hello!'])
    expect(content.textContent).toBe('hello!')

    // Parent re-render and a data change re-render the view: contentDOM stays in place.
    act(() => bump())
    act(() => {
      editor.commands.setNodeData([1], { tone: 'warn' })
    })
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(root.querySelector('.box-view')!.getAttribute('data-tone')).toBe('warn')
    expect(root.querySelector('[data-hte-content]')).toBe(content)
    expect(content.parentElement!.className).toBe('box-body')
    expect(content.textContent).toBe('hello!')
    expect(texts(editor)).toEqual(['ab', 'hello!'])
    expect(errors).not.toHaveBeenCalled()
    expect(warns).not.toHaveBeenCalled()
  })

  it('removing the node unmounts the view without console errors; undo brings its content back', async () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <App onEditor={(e) => (editor = e)} view={BoxView} onBump={() => {}} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    act(() => {
      const tr = editor.createTransaction()
      tr.removeNode([1])
      editor.dispatch(tr)
    })
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(root.querySelector('.box-view')).toBeNull()
    act(() => {
      editor.commands.undo()
    })
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(root.querySelector('[data-hte-content]')!.textContent).toBe('hello')
    expect(texts(editor)).toEqual(['ab', 'hello'])
    expect(errors).not.toHaveBeenCalled()
  })

  it('a caret in a newly inserted box survives the portal commit and is shown in its contentDOM', async () => {
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <App onEditor={(e) => (editor = e)} view={BoxView} onBump={() => {}} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    act(() => editor.view!.focus())
    act(() => {
      const tr = editor.createTransaction()
      tr.insertNode([1], el('box', txt('world')))
      tr.setSelection(sel([1, 0], 5))
      editor.dispatch(tr)
    })
    // The portal commit placed contentDOM; then the observer, a stale selectionchange and a sync.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
      editor.view!.syncSelection()
    })
    expect(editor.state.selection).toEqual(sel([1, 0], 5))
    const content = root.querySelectorAll<HTMLElement>('[data-hte-content]')[0]!
    expect(content.textContent).toBe('world')
    const domSel = document.getSelection()!
    expect(content.contains(domSel.anchorNode)).toBe(true)
    expect(domSel.anchorOffset).toBe(5)
    expect(errors).not.toHaveBeenCalled()
  })

  it('changing `as` moves contentDOM into the new placeholder', async () => {
    const SwitchView: ReactNodeView<{ inline?: boolean }> = ({ node }) => (
      <section className="switch-view">
        <NodeContent as={node.data.inline ? 'span' : 'div'} className="body" />
      </section>
    )
    let editor!: TestEditor
    const { getByTestId } = render(
      <StrictMode>
        <App onEditor={(e) => (editor = e)} view={SwitchView} onBump={() => {}} />
      </StrictMode>,
    )
    const root = getByTestId('content')
    const content = root.querySelector<HTMLElement>('[data-hte-content]')!
    expect(content.parentElement!.tagName).toBe('DIV')
    act(() => {
      editor.commands.setNodeData([1], { inline: true })
    })
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(root.querySelector('[data-hte-content]')).toBe(content)
    expect(content.parentElement!.tagName).toBe('SPAN')
    expect(content.parentElement!.className).toBe('body')
    expect(root.contains(content)).toBe(true)
    expect(errors).not.toHaveBeenCalled()
  })

  it('warns in dev when a non-atom view renders without NodeContent', async () => {
    render(
      <StrictMode>
        <App onEditor={() => {}} view={NoContentView} onBump={() => {}} />
      </StrictMode>,
    )
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    expect(warns).toHaveBeenCalledTimes(1)
    expect(String(warns.mock.calls[0]![0])).toContain('<NodeContent />')
  })

  it('follows the editor dev flag, not NODE_ENV: no warning outside dev mode', async () => {
    const Twice: ReactNodeView = () => (
      <section>
        <NodeContent />
        <NodeContent />
      </section>
    )
    expect(process.env.NODE_ENV).not.toBe('production')
    render(<App onEditor={() => {}} view={NoContentView} onBump={() => {}} dev={false} />)
    render(<App onEditor={() => {}} view={Twice} onBump={() => {}} dev={false} />)
    await flushAct()
    expect(warns).not.toHaveBeenCalled()
  })

  it('warns in dev when NodeContent is rendered more than once', async () => {
    const Twice: ReactNodeView = () => (
      <section>
        <NodeContent />
        <NodeContent />
      </section>
    )
    render(<App onEditor={() => {}} view={Twice} onBump={() => {}} />)
    await flushAct()
    expect(warns).toHaveBeenCalledTimes(1)
    expect(String(warns.mock.calls[0]![0])).toContain('more than once')
  })

  it('warns in dev when NodeContent is rendered in an atom node view', async () => {
    const atom = definePlugin({ name: 'atomBox', node: { kind: 'block', atom: true } })
    const AtomView: ReactNodeView = () => (
      <section>
        <NodeContent />
      </section>
    )
    function AtomHarness({ dev }: { dev: boolean }) {
      const editor = useEditor({
        plugins: [paragraph, atom] as const,
        content: doc(el('paragraph', txt('ab')), el('atomBox')),
        nodeViews: { atomBox: AtomView },
        dev,
      })
      return <EditorContent editor={editor} />
    }
    render(
      <StrictMode>
        <AtomHarness dev={false} />
      </StrictMode>,
    )
    await flushAct()
    expect(warns).not.toHaveBeenCalled()
    render(
      <StrictMode>
        <AtomHarness dev />
      </StrictMode>,
    )
    await flushAct()
    expect(warns).toHaveBeenCalledTimes(1)
    expect(String(warns.mock.calls[0]![0])).toContain('"atomBox"')
    expect(String(warns.mock.calls[0]![0])).toContain('atom')
  })

  it('warns when NodeContent is rendered outside a node view, unless NODE_ENV is production or there is no process', () => {
    render(
      <StrictMode>
        <NodeContent />
      </StrictMode>,
    )
    expect(warns).toHaveBeenCalledTimes(1)
    expect(String(warns.mock.calls[0]![0])).toContain('outside a node view')
    cleanup()

    vi.stubEnv('NODE_ENV', 'production')
    try {
      render(<NodeContent />)
    } finally {
      vi.unstubAllEnvs()
    }
    cleanup()

    // A browser bundle without a `process` define.
    const saved = globalThis.process
    ;(globalThis as { process?: unknown }).process = undefined
    try {
      render(<NodeContent />)
    } finally {
      globalThis.process = saved
    }
    expect(warns).toHaveBeenCalledTimes(1)
  })
})
