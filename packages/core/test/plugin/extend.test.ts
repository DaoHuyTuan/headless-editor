// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type AnyPlugin, type Command, type DOMOutputSpec, type NodeViewProps } from '../../src/index'
import { createTestEditor, doc, el, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

/** An image-like atom with commands, a keymap, state and storage. */
const image = definePlugin({
  name: 'image',
  node: { kind: 'block', atom: true },
  options: { prefix: '' },
  state: { init: () => ({ count: 0 }), apply: (tr, prev: { count: number }) => (tr.docChanged ? { count: prev.count + 1 } : prev) },
  renderHTML: (node, { options }) => ['img', { src: `${options.prefix}${String(node.data.src)}` }],
  commands: () => ({ ping: (): Command => () => true }),
  keymap: (ctx) => ({ 'Mod-i': () => ctx.commands.ping() }),
  storage: () => ({ uploads: [] as string[], isPending: (id: string) => id === 'pending' }),
})

const wrap = (spec: DOMOutputSpec): DOMOutputSpec => ['figure', {}, spec]

const editors: { destroy(): void }[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
  document.body.innerHTML = ''
})

function setup(plugin: AnyPlugin, opts: { nodeViews?: Record<string, never> } = {}) {
  const editor = createTestEditor({
    plugins: [testParagraph, plugin],
    doc: doc(el('image', { src: 'a.png' }), el('paragraph', txt('x'))),
    ...opts,
  })
  editors.push(editor)
  return editor
}

describe('extend(parent)', () => {
  it('passes the parent spec so an override can wrap renderHTML', () => {
    const wrapped = image.extend((p) => ({ renderHTML: (n, c) => wrap(p.renderHTML!(n, c)) }))
    expect(setup(wrapped).getHTML()).toBe('<figure><img src="a.png"></figure><p>x</p>')
    // The parent is unchanged.
    expect(setup(image).getHTML()).toBe('<img src="a.png"><p>x</p>')
  })

  it('keeps the parent keymap bindings when a keymap override spreads them', () => {
    const calls: string[] = []
    const extended = image.extend((parent) => ({
      keymap: (ctx) => ({
        ...parent.keymap?.(ctx),
        'Mod-j': () => {
          calls.push('j')
          return true
        },
      }),
    }))
    const editor = setup(extended)
    expect(editor.runKeymap('Mod-i')).toBe(true)
    expect(editor.runKeymap('Mod-j')).toBe(true)
    expect(calls).toEqual(['j'])
  })

  it('chains: each extend sees the previous one as its parent', () => {
    const once = image.extend((p) => ({ renderHTML: (n, c) => wrap(p.renderHTML!(n, c)) }))
    const twice = once.extend((p) => ({ renderHTML: (n, c) => ['div', {}, p.renderHTML!(n, c)] }))
    expect(setup(twice).getHTML()).toBe('<div><figure><img src="a.png"></figure></div><p>x</p>')
    // Mixed with the object form and configure.
    const configured = twice.extend({ priority: 50 }).configure({ prefix: '/img/' })
    expect(setup(configured).getHTML()).toBe('<div><figure><img src="/img/a.png"></figure></div><p>x</p>')
  })

  it('keeps the object form', () => {
    const e = image.extend({ renderHTML: (): DOMOutputSpec => ['hr'], priority: 50 })
    expect(setup(e).getHTML()).toBe('<hr><p>x</p>')
  })
})

describe('ctx.storage', () => {
  it("is the plugin's own storage once its factory ran, undefined before", () => {
    const seen: unknown[] = []
    const probe = definePlugin({
      name: 'probe',
      storage: (ctx) => {
        seen.push(ctx.storage)
        return { n: 1 }
      },
      onCreate: (ctx) => {
        seen.push(ctx.storage)
      },
    })
    const editor = createTestEditor({ plugins: [testParagraph, probe] })
    editors.push(editor)
    expect(seen).toEqual([undefined, { n: 1 }])
    expect(seen[1]).toBe(editor.storage.probe)
  })
})

describe('node view props', () => {
  it('carry the plugin storage and its current state', () => {
    const got: NodeViewProps<any, any, any, any>[] = []
    const editor = createTestEditor({
      plugins: [testParagraph, image],
      doc: doc(el('image', { src: 'a.png' }), el('paragraph', txt('x'))),
      nodeViews: {
        image: (_container, props) => {
          got.push(props)
          return { update: (p) => got.push(p), destroy: () => {} }
        },
      },
    })
    editors.push(editor)
    const root = document.createElement('div')
    document.body.appendChild(root)
    editor.mount(root)
    expect(got).toHaveLength(1)
    const props = got[0]!
    expect(props.storage).toBe(editor.storage.image)
    expect(props.state).toBe(editor.getPluginState('image'))
    // A doc change replaces the state object; the props read the current one.
    const tr = editor.createTransaction()
    tr.insertText('y')
    editor.dispatch(tr)
    expect(editor.getPluginState<{ count: number }>('image').count).toBe(1)
    expect(props.state).toBe(editor.getPluginState('image'))
  })
})
