// @vitest-environment happy-dom
import { StrictMode, type ComponentType } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeSelection, type Editor, type ElementNode, type NodeViewPropsOf } from '@penline/core'
import { doc, el, sel, txt } from '@penline/core/testing'
import { paragraph } from '@penline/paragraph'
import { EditorContent, useEditor } from '@penline/react'
import { mention, type MentionState, type User } from '../src/index'
import {
  MentionSuggestion,
  MentionView,
  useMention,
  type MentionSuggestionProps,
  type MentionViewProps,
} from '../src/react'

interface Request {
  query: string
  resolve: (users: User[]) => void
}

const ann: User = { id: 'u1', label: 'Ann' }
const bob: User = { id: 'u2', label: 'Bob' }
const COORDS = { left: 40, top: 100, bottom: 118 }
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errors = vi.spyOn(console, 'error')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.getSelection()?.removeAllRanges()
})

type View = ComponentType<NodeViewPropsOf<typeof mention>>

function setup({
  view = MentionView,
  suggestion = {},
  renderUser,
}: {
  view?: View
  suggestion?: Omit<MentionSuggestionProps, 'editor'>
  renderUser?: (u: User) => string
} = {}) {
  const requests: Request[] = []
  const fetchUsers = vi.fn((query: string) => new Promise<User[]>((resolve) => requests.push({ query, resolve })))
  const plugins = [paragraph, mention.configure({ fetchUsers, renderUser })] as const
  let editor!: Editor<typeof plugins>
  function Harness() {
    const e = useEditor({
      plugins,
      content: doc(el('paragraph', txt('hi '), el('mention', { userId: 'u1', label: 'Ann' }), txt(' '))),
      selection: sel([0, 2], 1),
      nodeViews: { mention: view },
    })
    editor = e
    return (
      <>
        <EditorContent editor={e} data-testid="content" />
        <MentionSuggestion editor={e} {...suggestion} />
      </>
    )
  }
  const utils = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  )
  const root = utils.getByTestId('content')
  vi.spyOn(editor, 'coordsAt').mockReturnValue(COORDS)
  act(() => editor.view!.focus())
  const type = (text: string) =>
    act(() => {
      for (const ch of text)
        root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }))
    })
  const resolve = (users: User[]) =>
    act(async () => {
      requests[requests.length - 1]!.resolve(users)
      await flush()
    })
  return {
    editor: () => editor,
    root,
    type,
    resolve,
    mentionEl: () => root.querySelector('[data-penline-mention]') as HTMLElement,
    popup: () => document.body.querySelector('[data-penline-mention-suggestion]') as HTMLElement | null,
    state: () => editor.getPluginState<MentionState>('mention'),
  }
}

describe('MentionView', () => {
  it('renders the label snapshot by default', () => {
    const t = setup()
    expect(t.mentionEl().textContent).toBe('@Ann')
    expect(t.mentionEl().hasAttribute('data-selected')).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it('shows the live label from renderUser; a renamed user updates without a doc change', async () => {
    const t = setup({ renderUser: (u) => `${u.label}!` })
    expect(t.mentionEl().textContent).toBe('@Ann!')
    // The caret is after the mention's trailing space: '@' opens the popup.
    t.type('@')
    const mentionNode = (t.editor().state.doc.children[0] as ElementNode).children![1]
    await t.resolve([{ id: 'u1', label: 'Annie' }, bob])
    // Same node, same snapshot: only the runtime data changed.
    expect((t.editor().state.doc.children[0] as ElementNode).children![1]).toBe(mentionNode)
    expect(t.mentionEl().textContent).toBe('@Annie!')
    // Closing the popup keeps the latest known name.
    act(() => {
      t.editor().commands.closeSuggestion()
    })
    expect(t.mentionEl().textContent).toBe('@Annie!')
    expect(errors).not.toHaveBeenCalled()
  })

  it('a chip re-renders only when its own user changes, not on every popup change', async () => {
    let renders = 0
    const Counting: View = (p) => {
      renders++
      return <span data-penline-mention="">@{useMention(p).label}</span>
    }
    const t = setup({ view: Counting })
    // Typing changes the doc around the chip, not the chip itself.
    t.type('@')
    renders = 0
    t.type('b')
    await t.resolve([bob, { id: 'u9', label: 'Zed' }])
    act(() => {
      t.editor().commands.moveSuggestion(1)
    })
    t.type('o')
    await t.resolve([bob])
    expect(renders).toBe(0)
    expect(t.popup()).not.toBeNull()
    // Its user arriving in the results does re-render it.
    t.type('x')
    await t.resolve([{ id: 'u1', label: 'Annie' }])
    expect(renders).toBeGreaterThan(0)
    expect(t.mentionEl().textContent).toBe('@Annie')
    // An equal user object in a later result does not.
    renders = 0
    t.type('y')
    await t.resolve([{ id: 'u1', label: 'Annie' }])
    expect(renders).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })

  it('carries data-selected when node-selected', () => {
    const t = setup()
    act(() => {
      const e = t.editor()
      e.dispatch(e.createTransaction().setSelection(nodeSelection(e.state.doc, e.registry, [0, 1])))
    })
    expect(t.mentionEl().hasAttribute('data-selected')).toBe(true)
  })

  it('parts: { label: false } hides the label; classNames are applied', () => {
    const t = setup({
      view: (p) => <MentionView {...p} parts={{ label: false }} classNames={{ root: 'm-root' }} />,
    })
    expect(t.mentionEl().textContent).toBe('')
    expect(t.mentionEl().classList.contains('m-root')).toBe(true)
    cleanup()
    const u = setup({ view: (p) => <MentionView {...p} classNames={{ root: 'm-root', label: 'm-label' }} /> })
    expect(u.mentionEl().querySelector('.m-label')?.textContent).toBe('@Ann')
    expect(errors).not.toHaveBeenCalled()
  })

  it('a replacement label part receives its className', () => {
    const Label: MentionViewProps extends { parts?: { label?: infer L } } ? Exclude<L, false | undefined> : never = ({
      className,
    }) => <b className={className}>custom</b>
    const t = setup({ view: (p) => <MentionView {...p} parts={{ label: Label }} classNames={{ label: 'lbl' }} /> })
    expect(t.mentionEl().querySelector('b.lbl')?.textContent).toBe('custom')
  })
})

describe('MentionSuggestion', () => {
  it('is not rendered while closed', () => {
    const t = setup()
    expect(t.popup()).toBeNull()
  })

  it('appears at the stubbed coords with the items, with ARIA roles', async () => {
    const t = setup()
    t.type('@')
    await t.resolve([ann, bob])
    const popup = t.popup()!
    expect(popup).not.toBeNull()
    expect(popup.hasAttribute('data-open')).toBe(true)
    expect(popup.parentElement).toBe(document.body)
    expect(popup.style.position).toBe('fixed')
    expect(popup.style.left).toBe('40px')
    expect(popup.style.top).toBe('118px')
    const list = popup.querySelector('[role="listbox"]')!
    expect(list).not.toBeNull()
    const options = [...list.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent)).toEqual(['Ann', 'Bob'])
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    expect(options[0]!.hasAttribute('data-selected')).toBe(true)
    expect(options[1]!.hasAttribute('data-selected')).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it('follows the highlighted index and closes with the popup state', async () => {
    const t = setup()
    t.type('@')
    await t.resolve([ann, bob])
    act(() => {
      t.editor().commands.moveSuggestion(1)
    })
    const options = () => [...t.popup()!.querySelectorAll('[role="option"]')]
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    act(() => {
      t.editor().commands.closeSuggestion()
    })
    expect(t.popup()).toBeNull()
  })

  it('follows the trigger when the page scrolls or resizes', async () => {
    const t = setup()
    t.type('@')
    await t.resolve([ann, bob])
    expect(t.popup()!.style.top).toBe('118px')
    vi.spyOn(t.editor(), 'coordsAt').mockReturnValue({ left: 40, top: 60, bottom: 78 })
    act(() => {
      document.dispatchEvent(new Event('scroll'))
    })
    expect(t.popup()!.style.top).toBe('78px')
    vi.spyOn(t.editor(), 'coordsAt').mockReturnValue({ left: 10, top: 60, bottom: 90 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(t.popup()!.style.left).toBe('10px')
    expect(t.popup()!.style.top).toBe('90px')
  })

  it('the editor root points at the highlighted option (aria-activedescendant) while open', async () => {
    const t = setup()
    t.type('@')
    await t.resolve([ann, bob])
    const list = t.popup()!.querySelector('[role="listbox"]')!
    const options = [...list.querySelectorAll('[role="option"]')]
    expect(list.id).not.toBe('')
    expect(new Set(options.map((o) => o.id)).size).toBe(2)
    expect(t.root.getAttribute('aria-controls')).toBe(list.id)
    expect(t.root.getAttribute('aria-activedescendant')).toBe(options[0]!.id)
    act(() => {
      t.editor().commands.moveSuggestion(1)
    })
    expect(t.root.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
    act(() => {
      t.editor().commands.closeSuggestion()
    })
    expect(t.root.hasAttribute('aria-activedescendant')).toBe(false)
    expect(t.root.hasAttribute('aria-controls')).toBe(false)
  })

  it('clicking an item inserts the mention and the editor keeps focus', async () => {
    const t = setup()
    t.type('@')
    await t.resolve([ann, bob])
    const bobItem = t.popup()!.querySelectorAll('[role="option"]')[1]!
    let notPrevented!: boolean
    act(() => {
      notPrevented = fireEvent.mouseDown(bobItem)
    })
    expect(notPrevented).toBe(false)
    fireEvent.click(bobItem)
    expect(document.activeElement).toBe(t.root)
    expect(t.state().open).toBe(false)
    expect(t.popup()).toBeNull()
    const kids = (t.editor().state.doc.children[0] as ElementNode).children!
    const mentions = kids.filter((k): k is ElementNode => 'type' in k && k.type === 'mention')
    expect(mentions.map((k) => k.data)).toEqual([
      { userId: 'u1', label: 'Ann' },
      { userId: 'u2', label: 'Bob' },
    ])
    expect(t.root.querySelectorAll('[data-penline-mention]')[1]!.textContent).toBe('@Bob')
    expect(errors).not.toHaveBeenCalled()
  })

  it('a mousedown anywhere on the popup (not only on an item) keeps the focus in the editor', async () => {
    const t = setup()
    t.type('@')
    await t.resolve([ann, bob])
    const popup = t.popup()!
    // The popup itself and its list, outside any item (padding, a scrollbar, a header part).
    for (const target of [popup, popup.querySelector('[role="listbox"]')!]) {
      let notPrevented!: boolean
      act(() => {
        notPrevented = fireEvent.mouseDown(target)
      })
      expect(notPrevented).toBe(false)
    }
    expect(t.state().open).toBe(true)
  })

  it('renderItem, parts and classNames customize the popup', async () => {
    const t = setup({
      suggestion: {
        renderItem: (u, { selected }) => `${u.label}${selected ? ' <' : ''}`,
        classNames: { root: 'p-root', popup: 'p-popup', list: 'p-list', item: 'p-item' },
      },
    })
    t.type('@')
    await t.resolve([ann, bob])
    const popup = t.popup()!
    expect(popup.className).toBe('p-root p-popup')
    expect(popup.querySelector('.p-list')?.getAttribute('role')).toBe('listbox')
    expect([...popup.querySelectorAll('.p-item')].map((o) => o.textContent)).toEqual(['Ann <', 'Bob'])
  })

  it('parts: { popup: false } renders nothing', async () => {
    const t = setup({ suggestion: { parts: { popup: false } } })
    t.type('@')
    await t.resolve([ann])
    expect(t.popup()).toBeNull()
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })
})
