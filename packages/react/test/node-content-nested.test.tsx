// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definePlugin, type AnyPlugin, type Doc, type Editor } from '@penline/core'
import { doc, el, txt } from '@penline/core/testing'
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
  it('<NodeContent as="tbody" /> renders a tbody placeholder holding the contentDOM', async () => {
    const TableView: ReactNodeView = () => <NodeContent as="tbody" className="rows" />
    const { getByTestId } = render(
      <Harness
        content={doc(el('table', el('tableRow', el('tableCell', p('a1')))))}
        nodeViews={{ table: { component: TableView, as: 'table' } }}
      />,
    )
    await flushAct()
    const root = getByTestId('content')
    const container = root.querySelector<HTMLElement>('[data-penline-node-view]')!
    expect(container.tagName).toBe('TABLE')
    const placeholder = container.firstElementChild as HTMLElement
    expect(placeholder.tagName).toBe('TBODY')
    expect(placeholder.className).toBe('rows')
    const content = placeholder.firstElementChild as HTMLElement
    expect(content.hasAttribute('data-penline-content')).toBe(true)
    expect(content.querySelector('tr > td > p')!.textContent).toBe('a1')
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
