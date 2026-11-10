// @vitest-environment happy-dom
import { StrictMode, type ComponentType } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc, Editor, ElementNode, NodeViewPropsOf, Selection, TextNode } from '@penline/core'
import { doc, el, sel, txt } from '@penline/core/testing'
import { paragraph } from '@penline/paragraph'
import { EditorContent, useEditor } from '@penline/react'
import { codeBlock } from '../src/index'
import { CodeBlockView, useCodeBlock, type CodeBlockApi, type CodeBlockViewProps } from '../src/react'

let errors: ReturnType<typeof vi.spyOn>
let warns: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error')
  warns = vi.spyOn(console, 'warn')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
})

type View = ComponentType<NodeViewPropsOf<typeof codeBlock>>
const plugins = [paragraph, codeBlock] as const
type TestEditor = Editor<typeof plugins>

function setup({
  view = CodeBlockView,
  content = doc(el('codeBlock', { language: 'javascript' }, txt('const x = 1'))),
  selection = sel([0, 0], 2),
}: { view?: View; content?: Doc; selection?: Selection } = {}) {
  let editor!: TestEditor
  function Harness() {
    const e = useEditor({ plugins, content, selection, nodeViews: { codeBlock: view } })
    editor = e
    return <EditorContent editor={e} data-testid="content" />
  }
  const utils = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  )
  const root = utils.getByTestId('content')
  act(() => editor.view!.focus())
  const type = (text: string) =>
    act(() => {
      for (const ch of text)
        root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }))
    })
  return {
    editor: () => editor,
    root,
    type,
    block: () => root.querySelector('[data-penline-code-block]') as HTMLElement | null,
    select: () => root.querySelector('[data-penline-code-block] select') as HTMLSelectElement | null,
    node: () => editor.state.doc.children[0] as ElementNode,
    text: () => ((editor.state.doc.children[0] as ElementNode).children![0] as TextNode).text,
  }
}

describe('CodeBlockView', () => {
  it('renders the root, a non-editable toolbar with an ignored select, and editable content in <pre><code>', () => {
    const t = setup()
    const block = t.block()!
    expect(block).not.toBeNull()
    const toolbar = block.querySelector('[contenteditable="false"]') as HTMLElement
    expect(toolbar).not.toBeNull()
    expect(toolbar.contains(t.select())).toBe(true)
    expect(t.select()!.hasAttribute('data-editor-ignore')).toBe(true)
    expect(t.select()!.value).toBe('javascript')
    const content = block.querySelector('pre code [data-penline-content]') as HTMLElement
    expect(content).not.toBeNull()
    expect(content.textContent).toBe('const x = 1')
    // No non-editable ancestor between the content and the editor root.
    for (let n = content.parentElement; n && n !== t.root; n = n.parentElement)
      expect(n.getAttribute('contenteditable')).not.toBe('false')
    // Neither NodeContent nor the core warns (content placed once, not under a non-editable element).
    expect(warns).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('typing inside the content edits the text', () => {
    const t = setup()
    t.type('!')
    expect(t.text()).toBe('co!nst x = 1')
    expect(t.block()!.querySelector('pre code')!.textContent).toBe('co!nst x = 1')
    expect(errors).not.toHaveBeenCalled()
  })

  it('changing the select sets the language in one undo step without moving the caret', () => {
    const t = setup()
    const before = t.editor().state.selection
    const depth = () => t.editor().getPluginState<{ undo: unknown[] }>('history').undo.length
    const undoBefore = depth()
    act(() => {
      fireEvent.change(t.select()!, { target: { value: 'python' } })
    })
    expect(t.node().data.language).toBe('python')
    expect(t.select()!.value).toBe('python')
    expect(t.editor().state.selection).toEqual(before)
    expect(depth()).toBe(undoBefore + 1)
    act(() => {
      t.editor().commands.undo()
    })
    expect(t.node().data.language).toBe('javascript')
    expect(t.select()!.value).toBe('javascript')
    expect(t.text()).toBe('const x = 1')
    expect(errors).not.toHaveBeenCalled()
  })

  it('offers the configured languages plus the current one', () => {
    const t = setup({ content: doc(el('codeBlock', { language: 'rust' }, txt('fn'))) })
    const values = Array.from(t.select()!.options).map((o) => o.value)
    expect(values).toEqual([...codeBlock.spec.options!.languages, 'rust'])
    expect(t.select()!.value).toBe('rust')
    expect(warns).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('the select is labelled "Language" by default, or by the languageLabel option', () => {
    expect(setup().select()!.getAttribute('aria-label')).toBe('Language')
    cleanup()
    const t = setup({ view: (p) => <CodeBlockView {...p} options={{ ...p.options, languageLabel: 'Langue' }} /> })
    expect(t.select()!.getAttribute('aria-label')).toBe('Langue')
    expect(errors).not.toHaveBeenCalled()
  })

  it('setLanguage with an unsafe name is rejected: false, the data and the select unchanged', () => {
    let api!: CodeBlockApi
    const t = setup({
      view: (p) => {
        api = useCodeBlock(p)
        return <CodeBlockView {...p} />
      },
    })
    let result: boolean | undefined
    act(() => {
      result = api.setLanguage('x"><script>')
    })
    expect(result).toBe(false)
    expect(t.node().data.language).toBe('javascript')
    expect(t.select()!.value).toBe('javascript')
    act(() => {
      result = api.setLanguage('python')
    })
    expect(result).toBe(true)
    expect(t.node().data.language).toBe('python')
    expect(errors).not.toHaveBeenCalled()
  })

  it('shows the highlight classes', () => {
    const t = setup()
    expect(t.block()!.querySelector('pre code .hljs-keyword')?.textContent).toBe('const')
    expect(errors).not.toHaveBeenCalled()
  })

  it('parts: { toolbar: false } hides the toolbar; classNames are applied', () => {
    const t = setup({
      view: (p) => <CodeBlockView {...p} parts={{ toolbar: false }} classNames={{ root: 'cb-root', content: 'cb-content' }} />,
    })
    expect(t.select()).toBeNull()
    expect(t.block()!.querySelector('[contenteditable="false"]')).toBeNull()
    expect(t.block()!.classList.contains('cb-root')).toBe(true)
    expect(t.block()!.querySelector('pre.cb-content code [data-penline-content]')).not.toBeNull()
    t.type('!')
    expect(t.text()).toBe('co!nst x = 1')
    expect(errors).not.toHaveBeenCalled()
  })

  it('parts: { languageSelect } replaces the select inside the toolbar', () => {
    const Select: CodeBlockViewProps extends { parts?: { languageSelect?: infer L } } ? Exclude<L, false | undefined> : never = ({
      className,
    }) => <b className={className}>lang</b>
    const t = setup({
      view: (p) => (
        <CodeBlockView {...p} parts={{ languageSelect: Select }} classNames={{ toolbar: 'tb', languageSelect: 'ls' }} />
      ),
    })
    expect(t.select()).toBeNull()
    expect(t.block()!.querySelector('.tb b.ls')?.textContent).toBe('lang')
    expect(warns).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('a paragraph turned into a code block keeps the caret and typing continues', () => {
    const t = setup({ content: doc(el('paragraph', txt('ab'))), selection: sel([0, 0], 1) })
    act(() => {
      t.editor().commands.setCodeBlock('javascript')
    })
    expect(t.node().type).toBe('codeBlock')
    expect(t.block()).not.toBeNull()
    t.type('x')
    expect(t.text()).toBe('axb')
    expect(warns).not.toHaveBeenCalled()
    expect(t.block()!.querySelector('pre code')!.textContent).toBe('axb')
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('useCodeBlock', () => {
  const props = (language: string, updateData = vi.fn(() => true), options = codeBlock.spec.options!) =>
    ({ node: { data: { language } }, options, updateData }) as unknown as NodeViewPropsOf<typeof codeBlock>

  it('returns the same api (and the same select props) while the language, options and updateData stay', () => {
    const updateData = vi.fn(() => true)
    const { result, rerender } = renderHook((p) => useCodeBlock(p), { initialProps: props('rust', updateData) })
    const first = result.current
    rerender(props('rust', updateData))
    expect(result.current).toBe(first)
    expect(result.current.selectProps).toBe(first.selectProps)
    expect(result.current.languages).toBe(first.languages)
    rerender(props('python', updateData))
    expect(result.current).not.toBe(first)
    expect(result.current.language).toBe('python')
    expect(result.current.setLanguage).toBe(first.setLanguage)
    result.current.setLanguage('css')
    expect(updateData).toHaveBeenCalledWith({ language: 'css' })
  })
})
