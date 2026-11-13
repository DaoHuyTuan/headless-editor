// @vitest-environment happy-dom
import { StrictMode, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, getNode, type AnyPlugin, type Doc, type Editor, type TextNode } from '@penline/core'
import { modelToDom, readDomSelection } from '@penline/core/internal'
import { doc, el, sel, txt } from '@penline/core/testing'
import { paragraph } from '@penline/paragraph'
import { EditorContent, NodeContent, useEditor, type ReactNodeView, type UseEditorOptions } from '../src/index'

const quote = definePlugin({ name: 'quote', node: { kind: 'block', content: 'block+' } })
const bulletList = definePlugin({ name: 'bulletList', node: { kind: 'block', content: 'listItem+' } })
const listItem = definePlugin({ name: 'listItem', node: { kind: 'block', content: 'paragraph block*', group: [] } })
const table = definePlugin({ name: 'table', node: { kind: 'block', content: 'tableRow+' } })
const tableRow = definePlugin({
  name: 'tableRow',
  node: { kind: 'block', content: 'tableCell+', group: [] },
  renderHTML: () => ['tr', 0],
})
const tableCell = definePlugin({
  name: 'tableCell',
  node: { kind: 'block', content: 'block+', group: [], isolating: true },
  renderHTML: () => ['td', 0],
})
const plugins: AnyPlugin[] = [paragraph, quote, bulletList, listItem, table, tableRow, tableCell]

const p = (text: string) => el('paragraph', txt(text))

function Harness({
  content,
  nodeViews,
  onEditor,
}: {
  content: Doc
  nodeViews: UseEditorOptions<AnyPlugin[]>['nodeViews']
  onEditor?: (e: Editor) => void
}) {
  const editor = useEditor({ plugins, content, nodeViews, dev: true })
  onEditor?.(editor as unknown as Editor)
  return <EditorContent editor={editor} data-testid="content" />
}

const flushAct = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NodeContent in container node views', () => {
  it('<NodeContent as="section" /> renders a section placeholder holding the contentDOM', async () => {
    const QuoteView: ReactNodeView = () => <NodeContent as="section" className="body" />
    const { getByTestId } = render(
      <Harness content={doc(el('quote', p('x')))} nodeViews={{ quote: { component: QuoteView, as: 'blockquote' } }} />,
    )
    await flushAct()
    const container = getByTestId('content').querySelector<HTMLElement>('[data-penline-node-view]')!
    expect(container.tagName).toBe('BLOCKQUOTE')
    const placeholder = container.firstElementChild as HTMLElement
    expect(placeholder.tagName).toBe('SECTION')
    expect(placeholder.className).toBe('body')
    const content = placeholder.firstElementChild as HTMLElement
    expect(content.hasAttribute('data-penline-content')).toBe(true)
    expect(content.textContent).toBe('x')
  })

  it('<NodeContent placeholder={false} /> adopts a tbody contentDOM: table > tbody > tr, editable in a cell', async () => {
    const TableView: ReactNodeView = () => (
      <>
        <caption contentEditable={false} suppressContentEditableWarning>
          T
        </caption>
        <NodeContent placeholder={false} />
      </>
    )
    let editor!: Editor
    const { getByTestId } = render(
      <StrictMode>
        <Harness
          content={doc(el('table', el('tableRow', el('tableCell', p('a1')), el('tableCell', p('b1')))), p('after'))}
          nodeViews={{ table: { component: TableView, as: 'table', contentAs: 'tbody' } }}
          onEditor={(e) => (editor = e)}
        />
      </StrictMode>,
    )
    await flushAct()
    const root = getByTestId('content')
    const tbody = root.querySelector<HTMLElement>('tbody')!
    expect(tbody.parentElement!.tagName).toBe('TABLE')
    expect(tbody.parentElement!.hasAttribute('data-penline-node-view')).toBe(true)
    expect(tbody.hasAttribute('data-penline-content')).toBe(true)
    expect([...tbody.children].map((c) => c.tagName)).toEqual(['TR'])
    expect(tbody.querySelector('div')).toBeNull()
    expect(root.querySelectorAll('[data-penline-content]')).toHaveLength(1)
    expect(root.querySelector('table > tbody > tr > td > p')!.textContent).toBe('a1')
    expect((tbody.parentElement as HTMLTableElement).rows).toHaveLength(1)

    // The DOM selection in a cell maps to its text, and typing there edits that cell.
    const path = [0, 0, 1, 0, 0]
    const pos = modelToDom(editor.view!.renderer, { path, offset: 1 })
    document.getSelection()!.setBaseAndExtent(pos.node, pos.offset, pos.node, pos.offset)
    expect(readDomSelection(editor.view!.renderer, document.getSelection()!)).toEqual(sel(path, 1))
    act(() => {
      editor.view!.renderer.leafAt(path)!.dispatchEvent(
        new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '!' }),
      )
    })
    await flushAct()
    expect(editor.view!.renderer.leafAt(path)!.textContent).toBe('b!1')
    expect(root.querySelector('tbody')).toBe(tbody)

    // Mutations inside the adopted contentDOM are the editor's: a direct text change is reverted and a
    // foreign row is removed, with the model unchanged.
    const leaf = editor.view!.renderer.leafAt([0, 0, 0, 0, 0])!
    act(() => {
      ;(leaf.firstChild as Text).data = 'zzz'
      tbody.appendChild(document.createElement('tr'))
    })
    await flushAct()
    expect((getNode(editor.state.doc, [0, 0, 0, 0, 0]) as TextNode).text).toBe('a1')
    expect(editor.view!.renderer.leafAt([0, 0, 0, 0, 0])!.textContent).toBe('a1')
    expect(tbody.children).toHaveLength(1)
    expect(root.querySelector('tbody')).toBe(tbody)
    expect(tbody.parentElement!.tagName).toBe('TABLE')
  })

  it('an adopting NodeContent detaches the contentDOM on unmount', async () => {
    let show!: (v: boolean) => void
    const TableView: ReactNodeView = () => {
      const [on, setOn] = useState(true)
      show = setOn
      return on ? <NodeContent placeholder={false} /> : null
    }
    const { getByTestId } = render(
      <Harness
        content={doc(el('table', el('tableRow', el('tableCell', p('a1')))))}
        nodeViews={{ table: { component: TableView, as: 'table', contentAs: 'tbody' } }}
      />,
    )
    await flushAct()
    const table = getByTestId('content').querySelector<HTMLElement>('table')!
    expect(table.querySelector('tbody')).not.toBeNull()
    act(() => show(false))
    await flushAct()
    expect(table.querySelector('tbody')).toBeNull()
    act(() => show(true))
    await flushAct()
    expect(table.querySelector(':scope > tbody[data-penline-content] > tr')).not.toBeNull()
  })

  it('passes as and contentAs of a view spec to the core', async () => {
    const QuoteView: ReactNodeView = () => <NodeContent />
    const { getByTestId } = render(
      <Harness
        content={doc(el('quote', p('x')))}
        nodeViews={{ quote: { component: QuoteView, as: 'blockquote', contentAs: 'section' } }}
      />,
    )
    await flushAct()
    const container = getByTestId('content').querySelector<HTMLElement>('[data-penline-node-view]')!
    expect(container.tagName).toBe('BLOCKQUOTE')
    const placeholder = container.firstElementChild as HTMLElement
    expect(placeholder.tagName).toBe('DIV')
    const content = placeholder.firstElementChild as HTMLElement
    expect(content.tagName).toBe('SECTION')
    expect(content.hasAttribute('data-penline-content')).toBe(true)
    expect(content.textContent).toBe('x')
  })

  it('a plain component keeps the div container', async () => {
    const QuoteView: ReactNodeView = () => <NodeContent />
    const { getByTestId } = render(<Harness content={doc(el('quote', p('x')))} nodeViews={{ quote: QuoteView }} />)
    await flushAct()
    const container = getByTestId('content').querySelector<HTMLElement>('[data-penline-node-view]')!
    expect(container.tagName).toBe('DIV')
    expect(container.querySelector('[data-penline-content]')!.tagName).toBe('DIV')
  })

  it('a list view counting its items re-renders when an item is added', async () => {
    const ListView: ReactNodeView = ({ node }) => (
      <>
        <span className="count" contentEditable={false} suppressContentEditableWarning>
          {node.children!.length}
        </span>
        <NodeContent />
      </>
    )
    let editor!: Editor
    const { getByTestId } = render(
      <Harness
        content={doc(el('bulletList', el('listItem', p('one'))))}
        nodeViews={{ bulletList: ListView }}
        onEditor={(e) => (editor = e)}
      />,
    )
    await flushAct()
    const root = getByTestId('content')
    expect(root.querySelector('.count')!.textContent).toBe('1')
    act(() => {
      editor.dispatch(editor.createTransaction().insertNode([0, 1], el('listItem', p('two'))))
    })
    await flushAct()
    expect(root.querySelector('.count')!.textContent).toBe('2')
    expect(root.querySelector('[data-penline-content]')!.textContent).toBe('onetwo')
  })
})
