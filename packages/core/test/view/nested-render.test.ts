// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type AnyPlugin, type Doc, type ElementNode, type Node, type NodeViewFactory, type NodeViewProps, type NodeViewSpec } from '../../src/index'
import { domToModel, modelToDom, readDomSelection } from '../../src/internal'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { nested, testParagraph } from '../fixtures'

const p = (...children: (Node | string)[]): ElementNode =>
  el('paragraph', ...children.map((c) => (typeof c === 'string' ? txt(c) : c)))

// Table rows and cells rendered by the core as `tr` / `td`; the table itself gets a node view.
const row = definePlugin({
  name: 'tableRow',
  node: { kind: 'block', content: 'tableCell+', group: [] },
  renderHTML: () => ['tr', 0],
})
const cell = definePlugin({
  name: 'tableCell',
  node: { kind: 'block', content: 'block+', group: [], isolating: true },
  renderHTML: () => ['td', 0],
})
const tablePlugins: AnyPlugin[] = [...nested.filter((pl) => pl.name !== 'tableRow' && pl.name !== 'tableCell'), row, cell]

interface Recorded {
  created: NodeViewProps[]
  updates: NodeViewProps[]
}

/** A view that only places `contentDOM` and records its calls. */
function recordingView(): { factory: NodeViewFactory; rec: Recorded } {
  const rec: Recorded = { created: [], updates: [] }
  const factory: NodeViewFactory = (container, props) => {
    rec.created.push(props)
    container.append(props.contentDOM!)
    return { update: (next) => void rec.updates.push(next), destroy: () => {} }
  }
  return { factory, rec }
}

function mount(content: Doc, plugins: AnyPlugin[], nodeViews: Record<string, NodeViewFactory | NodeViewSpec>, selection = sel([0, 0], 0)) {
  const editor = createTestEditor({ plugins, doc: content, selection, nodeViews })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  return { editor, root, renderer: editor.view!.renderer }
}

const tableDoc = () =>
  doc(
    el('table', el('tableRow', el('tableCell', p('a1')), el('tableCell', p('b1'))), el('tableRow', el('tableCell', p('a2')))),
    p('after'),
  )

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('node views: container and content tags', () => {
  it('a table view with as: table and contentAs: tbody renders table > tbody > tr > td > p', () => {
    const { factory } = recordingView()
    const { root } = mount(tableDoc(), tablePlugins, { table: { factory, as: 'table', contentAs: 'tbody' } })
    const table = root.querySelector<HTMLElement>('[data-penline-node-view]')!
    expect(table.tagName).toBe('TABLE')
    const tbody = table.firstElementChild as HTMLElement
    expect(tbody.tagName).toBe('TBODY')
    expect(tbody.hasAttribute('data-penline-content')).toBe(true)
    expect(tbody.getAttribute('contenteditable')).toBe('true')
    expect([...tbody.children].map((c) => c.tagName)).toEqual(['TR', 'TR'])
    expect(tbody.querySelector('div')).toBeNull()
    const firstRow = tbody.firstElementChild!
    expect([...firstRow.children].map((c) => c.tagName)).toEqual(['TD', 'TD'])
    expect(firstRow.firstElementChild!.firstElementChild!.tagName).toBe('P')
    expect(root.querySelector('table > tbody > tr > td > p')!.textContent).toBe('a1')
  })

  it('a plain factory keeps the div container and div contentDOM', () => {
    const { factory, rec } = recordingView()
    const { root } = mount(doc(el('quote', p('x'))), [...nested], { quote: factory })
    const container = root.querySelector<HTMLElement>('[data-penline-node-view]')!
    expect(container.tagName).toBe('DIV')
    expect(rec.created[0]!.contentDOM!.tagName).toBe('DIV')
  })

  it('a spec without tags keeps the defaults', () => {
    const { factory, rec } = recordingView()
    const { root } = mount(doc(el('quote', p('x'))), [...nested], { quote: { factory } })
    expect(root.querySelector<HTMLElement>('[data-penline-node-view]')!.tagName).toBe('DIV')
    expect(rec.created[0]!.contentDOM!.tagName).toBe('DIV')
  })

  it('an invalid tag throws at editor creation', () => {
    const { factory } = recordingView()
    expect(() =>
      createTestEditor({ plugins: [...nested], nodeViews: { quote: { factory, as: 'bad tag' } } }),
    ).toThrow('Invalid HTML tag name "bad tag"')
    expect(() =>
      createTestEditor({ plugins: [...nested], nodeViews: { quote: { factory, contentAs: '<x>' } } }),
    ).toThrow('Invalid HTML tag name "<x>"')
  })

  it('the DOM selection in a cell maps to the cell text', () => {
    const { factory } = recordingView()
    const { editor, renderer } = mount(tableDoc(), tablePlugins, { table: { factory, as: 'table', contentAs: 'tbody' } })
    const leaf = renderer.leafAt([0, 0, 1, 0, 0])!
    expect(leaf.textContent).toBe('b1')
    const textNode = leaf.nodeType === 3 ? leaf : leaf.firstChild!
    document.getSelection()!.setBaseAndExtent(textNode, 1, textNode, 1)
    expect(readDomSelection(renderer, document.getSelection()!)).toEqual(sel([0, 0, 1, 0, 0], 1))
    // Typing there edits that cell.
    editor.dispatch(editor.createTransaction().setSelection(sel([0, 0, 1, 0, 0], 1)))
    editor.commands.insertText('!')
    expect(renderer.leafAt([0, 0, 1, 0, 0])!.textContent).toBe('b!1')
  })
})

describe('node views: updates of containers', () => {
  it('a bulletList view is updated with the new node when an item is added', () => {
    const counts: number[] = []
    const factory: NodeViewFactory = (container, props) => {
      counts.push(props.node.children!.length)
      container.append(props.contentDOM!)
      return { update: (next) => void counts.push(next.node.children!.length), destroy: () => {} }
    }
    const list = doc(el('bulletList', el('listItem', p('one'))))
    const { editor } = mount(list, [...nested], { bulletList: factory }, sel([0, 0, 0, 0], 3))
    editor.dispatch(editor.createTransaction().insertNode([0, 1], el('listItem', p('two'))))
    expect(editor.state.doc.children[0]!.children).toHaveLength(2)
    expect(counts).toEqual([1, 2])
  })

  it('a container view is updated when a nested text changes', () => {
    const { factory, rec } = recordingView()
    const { editor } = mount(doc(el('quote', p('x'))), [...nested], { quote: factory }, sel([0, 0, 0], 1))
    editor.commands.insertText('y')
    expect(rec.updates).toHaveLength(1)
    expect(rec.updates[0]!.node).toBe(editor.state.doc.children[0])
    expect(rec.updates[0]!.contentDOM).toBe(rec.created[0]!.contentDOM)
  })

  it('a container view is not updated when only a sibling changes', () => {
    const { factory, rec } = recordingView()
    const { editor } = mount(doc(el('quote', p('x')), p('z')), [...nested], { quote: factory }, sel([1, 0], 1))
    editor.commands.insertText('!')
    expect(rec.updates).toHaveLength(0)
  })

  it('a paragraph view is not updated by a sibling change, nor by its own text (today\'s rule)', () => {
    const { factory, rec } = recordingView()
    const { editor } = mount(doc(p('a'), p('b')), [testParagraph], { paragraph: factory }, sel([1, 0], 1))
    editor.commands.insertText('!')
    expect(editor.state.doc.children.map((n) => (n.children![0] as { text: string }).text)).toEqual(['a', 'b!'])
    expect(rec.updates).toHaveLength(0)
    editor.commands.splitBlock()
    expect(editor.state.doc.children).toHaveLength(3)
    expect(rec.updates).toHaveLength(0)
  })
})

describe('deep nesting', () => {
  it('a 200-deep quote renders and round-trips a caret in the innermost paragraph', () => {
    let node: ElementNode = p('deep')
    for (let i = 0; i < 200; i++) node = el('quote', node)
    const path = [...Array(201).fill(0), 0]
    const { renderer } = mount(doc(node), [...nested], {}, sel(path, 2))
    expect(renderer.leafAt(path)!.textContent).toBe('deep')
    const dom = modelToDom(renderer, { path, offset: 2 })
    expect(domToModel(renderer, dom.node, dom.offset)).toEqual({ path, offset: 2 })
  })
})
