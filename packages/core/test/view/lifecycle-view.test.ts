// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, EditorView, type AnyPlugin, type NodeViewFactory } from '../../src/index'
import { createTestEditor, doc, el, sel, txt } from '../../src/testing/index'
import { testParagraph } from '../fixtures'

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

const content = () => doc(el('paragraph', txt('ab')), el('image', { src: 'a.png' }))

const image = definePlugin({ name: 'image', node: { kind: 'block', atom: true } })

/** A node view with a `data-editor-ignore` input. */
const imageView: NodeViewFactory = (container) => {
  const input = document.createElement('input')
  input.setAttribute('data-editor-ignore', '')
  container.append(input)
  return { update: () => {}, destroy: () => {} }
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

function setup(plugins: AnyPlugin[]) {
  const editor = createTestEditor({
    plugins: [testParagraph, image, ...plugins],
    doc: content(),
    selection: sel([0, 0], 1),
    nodeViews: { image: imageView },
  })
  return editor
}

describe('lifecycle hooks: onMount', () => {
  it('runs for every plugin by priority at the end of the view constructor, with the view', () => {
    const calls: string[] = []
    let seenView: EditorView | null = null
    const a = definePlugin({
      name: 'a',
      priority: 10,
      onMount: (ctx, view) => {
        calls.push(`a:${ctx.name}`)
        seenView = view
        // The view is fully set up: rendered content is in place.
        expect(view.root.textContent).toContain('ab')
      },
    })
    const b = definePlugin({ name: 'b', priority: 500, onMount: () => void calls.push('b') })
    const editor = setup([a, b])
    expect(calls).toEqual([])
    const root = makeRoot()
    editor.mount(root)
    expect(calls).toEqual(['b', 'a:a'])
    expect(seenView).toBe(editor.view)
    expect(seenView!.root).toBe(root)
  })

  it('cleanups run in reverse order on unmount, once', () => {
    const calls: string[] = []
    const make = (name: string, priority: number) =>
      definePlugin({
        name,
        priority,
        onMount: () => {
          calls.push(`mount:${name}`)
          return () => void calls.push(`cleanup:${name}`)
        },
      })
    const editor = setup([make('low', 10), make('high', 500)])
    editor.mount(makeRoot())
    calls.length = 0
    editor.unmount()
    expect(calls).toEqual(['cleanup:low', 'cleanup:high'])
    editor.unmount()
    editor.destroy()
    expect(calls).toEqual(['cleanup:low', 'cleanup:high'])
  })

  it('mount(other) cleans up the old view before mounting the new one', () => {
    const calls: string[] = []
    const roots: HTMLElement[] = []
    const p = definePlugin({
      name: 'p',
      onMount: (_ctx, view) => {
        calls.push('mount')
        roots.push(view.root)
        return () => void calls.push('cleanup')
      },
    })
    const editor = setup([p])
    const first = makeRoot()
    const second = makeRoot()
    editor.mount(first)
    editor.mount(first)
    expect(calls).toEqual(['mount'])
    editor.mount(second)
    expect(calls).toEqual(['mount', 'cleanup', 'mount'])
    expect(roots).toEqual([first, second])
  })

  it('destroy() runs the cleanups', () => {
    let cleanups = 0
    const p = definePlugin({ name: 'p', onMount: () => () => void cleanups++ })
    const editor = setup([p])
    editor.mount(makeRoot())
    editor.destroy()
    expect(cleanups).toBe(1)
  })

  it('a throwing onMount does not stop the others; the view is torn down and the first error rethrown', () => {
    const calls: string[] = []
    const boom = new Error('boom')
    const ok1 = definePlugin({
      name: 'ok1',
      priority: 500,
      onMount: () => {
        calls.push('mount:ok1')
        return () => void calls.push('cleanup:ok1')
      },
    })
    const bad = definePlugin({
      name: 'bad',
      priority: 300,
      onMount: () => {
        calls.push('mount:bad')
        throw boom
      },
    })
    const ok2 = definePlugin({
      name: 'ok2',
      priority: 100,
      onMount: () => {
        calls.push('mount:ok2')
        return () => void calls.push('cleanup:ok2')
      },
    })
    const editor = setup([ok1, bad, ok2])
    expect(() => editor.mount(makeRoot())).toThrow(boom)
    expect(calls).toEqual(['mount:ok1', 'mount:bad', 'mount:ok2', 'cleanup:ok2', 'cleanup:ok1'])
    expect(editor.view).toBeNull()
  })

  it('a throwing cleanup does not stop the others; the first error is rethrown after unmounting', () => {
    const calls: string[] = []
    const boom = new Error('boom')
    const a = definePlugin({
      name: 'a',
      priority: 500,
      onMount: () => () => {
        calls.push('a')
        throw new Error('later')
      },
    })
    const b = definePlugin({
      name: 'b',
      priority: 100,
      onMount: () => () => {
        calls.push('b')
        throw boom
      },
    })
    const editor = setup([a, b])
    editor.mount(makeRoot())
    expect(() => editor.unmount()).toThrow(boom)
    expect(calls).toEqual(['b', 'a'])
    expect(editor.view).toBeNull()
  })

  it('editor.destroy() still runs the destroy hooks when a cleanup throws', () => {
    const calls: string[] = []
    const boom = new Error('boom')
    const p = definePlugin({
      name: 'p',
      onMount: () => () => {
        throw boom
      },
      destroy: () => void calls.push('destroy'),
    })
    const editor = setup([p])
    editor.mount(makeRoot())
    expect(() => editor.destroy()).toThrow(boom)
    expect(calls).toEqual(['destroy'])
  })
})

describe('mount on a destroyed editor', () => {
  it('throws, runs no onMount and leaves the root untouched', () => {
    const calls: string[] = []
    const p = definePlugin({ name: 'p', onMount: () => void calls.push('mount') })
    const editor = setup([p])
    editor.destroy()
    const root = makeRoot()
    root.innerHTML = '<p>own</p>'
    expect(() => editor.mount(root)).toThrow('Cannot mount a destroyed editor')
    expect(editor.view).toBeNull()
    expect(calls).toEqual([])
    expect(root.innerHTML).toBe('<p>own</p>')
    expect(root.hasAttribute('contenteditable')).toBe(false)
  })

  it('after destroy while mounted: the old root is given back and a remount throws', () => {
    const editor = setup([])
    const root = makeRoot()
    editor.mount(root)
    const rendered = root.innerHTML
    editor.destroy()
    expect(root.hasAttribute('contenteditable')).toBe(false)
    expect(() => editor.mount(root)).toThrow('Cannot mount a destroyed editor')
    expect(root.innerHTML).toBe(rendered)
    expect(root.hasAttribute('contenteditable')).toBe(false)
  })
})

describe('lifecycle hooks: onFocus / onBlur', () => {
  function focusSetup() {
    const log: string[] = []
    const events: FocusEvent[] = []
    const make = (name: string, priority: number) =>
      definePlugin({
        name,
        priority,
        onFocus: (ctx, e) => {
          log.push(`${ctx.name}:focus`)
          events.push(e)
        },
        onBlur: (ctx, e) => {
          log.push(`${ctx.name}:blur`)
          events.push(e)
        },
      })
    const editor = setup([make('low', 10), make('high', 500)])
    const root = makeRoot()
    editor.mount(root)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const input = root.querySelector<HTMLInputElement>('input[data-editor-ignore]')!
    return { editor, root, outside, input, log, events }
  }

  it('focus entering the root calls onFocus by priority; leaving it calls onBlur', () => {
    const { root, outside, log, events } = focusSetup()
    root.focus()
    expect(log).toEqual(['high:focus', 'low:focus'])
    expect(events[0]).toBeInstanceOf(FocusEvent)
    outside.focus()
    expect(log).toEqual(['high:focus', 'low:focus', 'high:blur', 'low:blur'])
  })

  it('focus moving into a node view input inside the root is not a blur (nor a second focus)', () => {
    const { root, outside, input, log } = focusSetup()
    root.focus()
    log.length = 0
    input.focus()
    expect(document.activeElement).toBe(input)
    expect(log).toEqual([])
    root.focus()
    expect(log).toEqual([])
    input.focus()
    outside.focus()
    expect(log).toEqual(['high:blur', 'low:blur'])
  })

  it('focusout without a relatedTarget (window blur) is a blur', () => {
    const { root, log } = focusSetup()
    root.focus()
    log.length = 0
    root.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    expect(log).toEqual(['high:blur', 'low:blur'])
  })

  it('a throwing onFocus does not stop the others; the first error is rethrown', () => {
    const calls: string[] = []
    const boom = new Error('boom')
    const bad = definePlugin({
      name: 'bad',
      priority: 500,
      onFocus: () => {
        calls.push('bad')
        throw boom
      },
    })
    const ok = definePlugin({ name: 'ok', priority: 10, onFocus: () => void calls.push('ok') })
    const editor = setup([bad, ok])
    const root = makeRoot()
    editor.mount(root)
    let caught: unknown
    // Dispatched directly so the rethrow reaches the test (not the browser's error reporting).
    try {
      editor.handleFocus(new FocusEvent('focusin', { relatedTarget: null }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(boom)
    expect(calls).toEqual(['bad', 'ok'])
  })

  it('a view mounted on an already-focused root calls onBlur when focus leaves it', () => {
    const { editor, root, outside, log } = focusSetup()
    root.focus()
    editor.unmount()
    editor.mount(root)
    log.length = 0
    outside.focus()
    expect(log).toEqual(['high:blur', 'low:blur'])
  })

  it('no hook runs after unmount', () => {
    const { editor, root, outside, log } = focusSetup()
    editor.unmount()
    root.focus()
    outside.focus()
    expect(log).toEqual([])
  })
})
