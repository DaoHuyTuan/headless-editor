// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSelection, definePlugin, serializeForClipboard, type Doc, type ElementNode, type Node, type Transaction } from '@hte/core'
import { createTestEditor, doc, el, sel, stripIds, txt } from '@hte/core/testing'
import { paragraph } from '@hte/paragraph'
import { mention, type MentionState, type User } from '../src/index'

interface Request {
  query: string
  resolve: (users: User[]) => void
  reject: (e: unknown) => void
}

const code = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })
const p = (...children: Node[]) => el('paragraph', ...children)
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

const ann: User = { id: 'u1', label: 'Ann' }
const bob: User = { id: 'u2', label: 'Bob' }
const joe: User = { id: 'u3', label: 'Joe' }

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function setup(content: Doc = doc(p(txt(''))), opts: Partial<Parameters<typeof mention.configure>[0]> = {}, extra: (typeof code)[] = []) {
  const requests: Request[] = []
  const fetchUsers = vi.fn(
    (query: string) =>
      new Promise<User[]>((resolve, reject) => {
        requests.push({ query, resolve, reject })
      }),
  )
  const editor = createTestEditor({
    plugins: [paragraph, code, ...extra, mention.configure({ fetchUsers, ...opts })],
    doc: content,
    selection: sel([0, 0], 0),
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  editor.mount(root)
  editor.view!.focus()
  const state = () => editor.getPluginState<MentionState>('mention')
  const type = (text: string) => {
    for (const ch of text)
      root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }))
  }
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k, ...init })
    root.dispatchEvent(e)
    return e
  }
  const last = () => requests[requests.length - 1]!
  return { editor, root, state, type, key, requests, last, fetchUsers }
}

const blockKids = (d: Doc, i = 0) => (d.children[i] as ElementNode).children ?? []

describe('mention suggestion: opening and fetching', () => {
  it('typing @jo opens the popup with query jo and fetches each query', () => {
    const { state, type, fetchUsers } = setup()
    type('@jo')
    expect(state()).toMatchObject({ open: true, query: 'jo', items: [], index: 0 })
    expect(state().range).toEqual({ start: { path: [0, 0], offset: 0 }, end: { path: [0, 0], offset: 3 } })
    expect(fetchUsers.mock.calls.map((c) => c[0])).toEqual(['', 'j', 'jo'])
  })

  it('results of the current query fill items', async () => {
    const { state, type, last } = setup()
    type('@jo')
    last().resolve([joe, bob])
    await flush()
    expect(state().items).toEqual([joe, bob])
  })

  it('does not open in the middle of a word', () => {
    const { state, type, fetchUsers } = setup()
    type('a@jo')
    expect(state().open).toBe(false)
    expect(fetchUsers).not.toHaveBeenCalled()
  })

  it('does not open inside a text-only block (code block)', () => {
    const { state, type, fetchUsers } = setup(doc(el('code', txt(''))))
    type('@jo')
    expect(state().open).toBe(false)
    expect(fetchUsers).not.toHaveBeenCalled()
  })

  it('decorates the open trigger range with hte-mention-query', () => {
    const { root, type } = setup(doc(p(txt('hi '))))
    type('@jo')
    // The caret starts at 0: '@jo' is typed before 'hi '.
    const deco = root.querySelector('.hte-mention-query')
    expect(deco?.textContent).toBe('@jo')
  })

  it('a custom trigger works', () => {
    const { state, type } = setup(undefined, { trigger: '#' })
    type('@a #b')
    expect(state()).toMatchObject({ open: true, query: 'b' })
  })
})

describe('mention suggestion: keyboard', () => {
  it('ArrowDown/ArrowUp move the index; Enter inserts @Label plus a space and closes', async () => {
    const { editor, state, type, key, last } = setup()
    type('@jo')
    last().resolve([joe, bob, ann])
    await flush()
    expect(key('ArrowDown').defaultPrevented).toBe(true)
    expect(state().index).toBe(1)
    key('ArrowDown')
    key('ArrowDown')
    expect(state().index).toBe(0) // wraps
    key('ArrowUp')
    expect(state().index).toBe(2)
    key('ArrowUp')
    expect(state().index).toBe(1)
    expect(key('Enter').defaultPrevented).toBe(true)
    const kids = blockKids(editor.getJSON())
    expect(kids).toHaveLength(3)
    expect(kids[1]).toMatchObject({ type: 'mention', data: { userId: 'u2', label: 'Bob' } })
    expect(kids[2]).toMatchObject({ text: ' ' })
    expect(editor.state.selection).toEqual(sel([0, 2], 1))
    expect(state()).toMatchObject({ open: false, items: [], range: null })
    expect(editor.getHTML()).toBe('<p><span data-mention="" data-id="u2">@Bob</span> </p>')
  })

  it('Esc closes; typing more does not reopen until a new @', async () => {
    const { state, type, key, last, fetchUsers } = setup()
    type('@jo')
    last().resolve([joe])
    await flush()
    expect(key('Escape').defaultPrevented).toBe(true)
    expect(state()).toMatchObject({ open: false, items: [] })
    const calls = fetchUsers.mock.calls.length
    type('e')
    expect(state().open).toBe(false)
    expect(fetchUsers).toHaveBeenCalledTimes(calls)
    type(' @b')
    expect(state()).toMatchObject({ open: true, query: 'b' })
  })

  it('with the popup closed, arrows, Enter and Esc are left alone and Enter splits the block', () => {
    const { editor, root, type, key } = setup()
    type('hi')
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) expect(key(k).defaultPrevented).toBe(false)
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }))
    expect(editor.getJSON().children).toHaveLength(2)
  })

  it('while open without items (results pending), arrows and Enter are captured as no-ops', () => {
    const { editor, state, type, key } = setup()
    type('@jo')
    expect(state()).toMatchObject({ open: true, items: [] })
    const docBefore = editor.state.doc
    const selBefore = editor.state.selection
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter']) expect(key(k).defaultPrevented).toBe(true)
    expect(editor.state.doc).toBe(docBefore)
    expect(editor.state.selection).toEqual(selBefore)
    expect(state()).toMatchObject({ open: true, index: 0 })
    expect(key('Escape').defaultPrevented).toBe(true)
    expect(state().open).toBe(false)
  })

  it('Enter while results are pending does not split the block', () => {
    const { editor, root, state, type, key } = setup()
    type('@jo')
    expect(key('Enter').defaultPrevented).toBe(true)
    // A browser that still sent the intent (no keydown): captured as well.
    const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' })
    root.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(editor.getJSON().children).toHaveLength(1)
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p(txt('@jo')))))
    expect(state().open).toBe(true)
  })

  it('once the current query resolved with no results, ↑ ↓ Enter are released: Enter splits, the popup stays open', async () => {
    const { state, type, key, last } = setup()
    type('@zz')
    expect(state().pending).toBe(true)
    last().resolve([])
    await flush()
    expect(state()).toMatchObject({ open: true, items: [], pending: false })
    expect(key('ArrowDown').defaultPrevented).toBe(false)
    expect(key('ArrowUp').defaultPrevented).toBe(false)
    expect(key('Enter').defaultPrevented).toBe(false)
    expect(state().open).toBe(true)
    // Esc still closes.
    expect(key('Escape').defaultPrevented).toBe(true)
    expect(state().open).toBe(false)
  })

  it('an insertParagraph intent with zero resolved results splits the block', async () => {
    const { editor, root, type, last } = setup()
    type('@zz')
    last().resolve([])
    await flush()
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }))
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p(txt('@zz')), p(txt('')))))
  })

  it('a new query after zero results captures the keys again until its own results arrive', async () => {
    const { state, type, key, last } = setup()
    type('@zz')
    last().resolve([])
    await flush()
    type('z')
    expect(state()).toMatchObject({ open: true, query: 'zzz', pending: true })
    expect(key('Enter').defaultPrevented).toBe(true)
    last().resolve([])
    await flush()
    expect(key('Enter').defaultPrevented).toBe(false)
  })

  it('a space after zero results still closes the popup', async () => {
    const { state, type, last } = setup()
    type('@zz')
    last().resolve([])
    await flush()
    type(' ')
    expect(state().open).toBe(false)
  })

  it('ArrowDown while open and empty does not move the caret', () => {
    const { editor, type, key } = setup(doc(p(txt(''))))
    type('@jo')
    const before = editor.state.selection
    expect(key('ArrowDown').defaultPrevented).toBe(true)
    expect(key('ArrowUp').defaultPrevented).toBe(true)
    expect(editor.state.selection).toEqual(before)
  })

  it('keys during an IME composition and modified keys are not taken', async () => {
    const { state, type, key, last } = setup()
    type('@jo')
    last().resolve([joe])
    await flush()
    expect(key('Enter', { isComposing: true }).defaultPrevented).toBe(false)
    expect(key('Enter', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(state().open).toBe(true)
  })

  it('an insertParagraph intent while open with items accepts (keyboards without keydown)', async () => {
    const { editor, root, state, type, last } = setup()
    type('@jo')
    last().resolve([joe])
    await flush()
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' }))
    expect(editor.getJSON().children).toHaveLength(1)
    expect(blockKids(editor.getJSON())[1]).toMatchObject({ type: 'mention', data: { userId: 'u3' } })
    expect(state().open).toBe(false)
  })
})

describe('mention suggestion: races (Review Focus 2)', () => {
  it('a response to j arriving after the response to jo is ignored', async () => {
    const { state, type, requests } = setup()
    type('@jo')
    const [, j, jo] = requests
    jo!.resolve([joe])
    await flush()
    j!.resolve([ann, bob, joe])
    await flush()
    expect(state().items).toEqual([joe])
  })

  it('a stale response arriving before the current one is ignored too', async () => {
    const { state, type, requests } = setup()
    type('@jo')
    requests[1]!.resolve([ann])
    await flush()
    expect(state().items).toEqual([])
  })

  it('results arriving after Esc keep the popup closed', async () => {
    const { state, type, key, last } = setup()
    type('@jo')
    key('Escape')
    last().resolve([joe])
    await flush()
    expect(state()).toMatchObject({ open: false, items: [] })
  })

  it('typing a space closes the popup and its late results are ignored', async () => {
    const { state, type, last } = setup()
    type('@jo')
    const pending = last()
    type(' ')
    expect(state().open).toBe(false)
    pending.resolve([joe])
    await flush()
    expect(state()).toMatchObject({ open: false, items: [] })
  })

  it('moving the caret out of the trigger closes; coming back does not reopen', () => {
    const { editor, state, type } = setup(doc(p(txt('x '))))
    editor.commands.selectAll()
    const tr = editor.createTransaction()
    tr.setSelection(sel([0, 0], 2))
    editor.dispatch(tr)
    type('@jo')
    expect(state().open).toBe(true)
    const out = editor.createTransaction()
    out.setSelection(sel([0, 0], 0))
    editor.dispatch(out)
    expect(state().open).toBe(false)
    const back = editor.createTransaction()
    back.setSelection(sel([0, 0], 5))
    editor.dispatch(back)
    expect(state().open).toBe(false)
  })

  it('a rejected fetch closes the popup quietly', async () => {
    const { state, type, last } = setup()
    type('@jo')
    last().reject(new Error('network'))
    await flush()
    expect(state()).toMatchObject({ open: false, items: [] })
  })

  it('a throwing fetchUsers closes the popup quietly', async () => {
    const { state, root } = setup(undefined, {
      fetchUsers: () => {
        throw new Error('sync')
      },
    })
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '@' }))
    await flush()
    expect(state().open).toBe(false)
  })

  it('deleting the dismissed @ and typing it again reopens', () => {
    const { root, state, type, key } = setup()
    type('@')
    key('Escape')
    root.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }))
    type('@')
    expect(state().open).toBe(true)
  })

  describe('hopping between triggers with the same query', () => {
    /** Two `@jo` triggers: A ends at offset 3, B at offset 9. */
    function twoTriggers() {
      const ctx = setup(doc(p(txt('@jo x @jo'))))
      const caret = (offset: number) => {
        const tr = ctx.editor.createTransaction()
        tr.setSelection(sel([0, 0], offset))
        ctx.editor.dispatch(tr)
      }
      return { ...ctx, caret }
    }

    it('an Esc-dismissed trigger stays closed after the caret visits another one', () => {
      const { state, key, caret } = twoTriggers()
      caret(3)
      expect(state()).toMatchObject({ open: true, query: 'jo' })
      key('Escape')
      caret(9)
      expect(state()).toMatchObject({ open: true, query: 'jo' })
      expect(state().range!.start).toEqual({ path: [0, 0], offset: 6 })
      caret(3)
      expect(state().open).toBe(false)
    })

    it('the caret hopping straight from an open trigger to another one dismisses the first', () => {
      const { state, caret } = twoTriggers()
      caret(3)
      caret(9)
      expect(state()).toMatchObject({ open: true, query: 'jo' })
      caret(3)
      expect(state().open).toBe(false)
    })

    it('every dismissed trigger stays closed, not only the last one', () => {
      const { state, key, caret } = twoTriggers()
      caret(3)
      key('Escape')
      caret(9)
      key('Escape')
      caret(3)
      expect(state().open).toBe(false)
      caret(9)
      expect(state().open).toBe(false)
    })

    it("a dismissal belongs to its trigger: it is not reused for another trigger's same query", () => {
      const { state, key, caret } = twoTriggers()
      caret(9)
      key('Escape')
      caret(3)
      expect(state()).toMatchObject({ open: true, query: 'jo' })
      expect(state().range!.start).toEqual({ path: [0, 0], offset: 0 })
    })

    it("another trigger is a new popup: the first one's items and index are not reused", async () => {
      const { state, key, caret, last, fetchUsers } = twoTriggers()
      caret(3)
      last().resolve([joe, bob])
      await flush()
      key('ArrowDown')
      expect(state().index).toBe(1)
      const calls = fetchUsers.mock.calls.length
      caret(9)
      expect(state()).toMatchObject({ open: true, query: 'jo', items: [], index: 0, pending: true })
      expect(fetchUsers).toHaveBeenCalledTimes(calls + 1)
    })
  })

  it('blur closes the popup; unmount closes it too', () => {
    const { editor, root, state, type } = setup()
    type('@jo')
    root.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    expect(state().open).toBe(false)
    editor.view!.focus()
    type('x')
    expect(state()).toMatchObject({ open: true, query: 'jox' })
    editor.unmount()
    expect(state().open).toBe(false)
  })

  it('results arriving after unmount are ignored', async () => {
    const { editor, state, type, last } = setup()
    type('@jo')
    const pending = last()
    editor.unmount()
    pending.resolve([joe])
    await flush()
    expect(state()).toMatchObject({ open: false, items: [] })
  })
})

describe('mention suggestion: bookkeeping trs and history', () => {
  it('suggestion trs carry no doc ops, stay out of history and keep typing grouped', async () => {
    const { editor, type, last } = setup()
    const meta: Transaction[] = []
    editor.on('transaction', ({ tr }) => {
      if (tr.meta.mention !== undefined && !tr.docChanged) meta.push(tr)
    })
    type('@jo')
    last().resolve([joe])
    await flush()
    expect(meta.length).toBeGreaterThan(0)
    for (const tr of meta) {
      expect(tr.meta.addToHistory).toBe(false)
      expect(tr.ops.every((op) => op.type === 'set_selection')).toBe(true)
    }
    const history = editor.getPluginState<{ undo: unknown[] }>('history')
    expect(history.undo).toHaveLength(1)
    editor.commands.undo()
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p(txt('')))))
  })

  it('inserting a mention is one undo step', async () => {
    const { editor, type, key, last } = setup()
    type('@jo')
    last().resolve([joe])
    await flush()
    key('Enter')
    editor.commands.undo()
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p(txt('@jo')))))
  })

  it('moveSuggestion / closeSuggestion command trs add no undo entry and keep typing grouped', async () => {
    const { editor, state, type, key, last } = setup()
    const depth = () => editor.getPluginState<{ undo: unknown[] }>('history').undo.length
    type('@j')
    last().resolve([joe, bob])
    await flush()
    expect(depth()).toBe(1)
    expect(key('ArrowDown').defaultPrevented).toBe(true)
    expect(state().index).toBe(1)
    expect(depth()).toBe(1)
    type('o')
    expect(key('Escape').defaultPrevented).toBe(true)
    expect(state().open).toBe(false)
    expect(depth()).toBe(1)
    type('e')
    expect(depth()).toBe(1)
    editor.commands.undo()
    expect(stripIds(editor.getJSON())).toEqual(stripIds(doc(p(txt('')))))
  })
})

describe('mention commands', () => {
  it('insertMention without an open popup inserts at the caret', () => {
    const { editor } = setup(doc(p(txt('ab'))))
    const tr = editor.createTransaction()
    tr.setSelection(sel([0, 0], 1))
    editor.dispatch(tr)
    expect(editor.commands.insertMention(ann)).toBe(true)
    const kids = blockKids(editor.getJSON())
    expect(kids.map((n) => ('text' in n ? n.text : `[${(n as ElementNode).data.label}]`))).toEqual(['a', '[Ann]', ' b'])
  })

  it('insertMention returns false in a text-only block and inserts nothing', () => {
    const { editor } = setup(doc(el('code', txt('ab'))))
    expect(editor.commands.insertMention(ann)).toBe(false)
    expect(blockKids(editor.getJSON())).toEqual([{ text: 'ab', marks: [] }])
  })

  it('closeSuggestion / moveSuggestion / acceptSuggestion are false when closed', () => {
    const { editor } = setup()
    expect(editor.commands.closeSuggestion()).toBe(false)
    expect(editor.commands.moveSuggestion(1)).toBe(false)
    expect(editor.commands.acceptSuggestion()).toBe(false)
  })

  it('can() does not change the suggestion state', async () => {
    const { editor, state, type, last } = setup()
    type('@jo')
    last().resolve([joe, bob])
    await flush()
    expect(editor.can().moveSuggestion(1)).toBe(true)
    expect(editor.can().closeSuggestion()).toBe(true)
    expect(state()).toMatchObject({ open: true, index: 0 })
    expect(editor.commands.moveSuggestion(-1)).toBe(true)
    expect(state().index).toBe(1)
  })
})

describe('mention storage: users seen in results', () => {
  it('storage.user returns the latest result for an id, written before views see the results', async () => {
    const { editor, type, last } = setup()
    const storage = () => editor.storage.mention
    expect(storage().user('u1')).toBeUndefined()
    let seen: User | undefined
    editor.on('transaction', ({ tr }) => {
      if ((tr.meta.mention as { type?: string } | undefined)?.type === 'results') seen = storage().user('u1')
    })
    type('@a')
    const annie = { id: 'u1', label: 'Annie' }
    last().resolve([ann, bob])
    await flush()
    expect(seen).toBe(ann)
    expect(storage().user('u2')).toBe(bob)
    type('n')
    last().resolve([annie])
    await flush()
    expect(storage().user('u1')).toBe(annie)
    // Closing keeps what was seen.
    editor.commands.closeSuggestion()
    expect(storage().user('u1')).toBe(annie)
  })

  it('stale or post-close results are not recorded', async () => {
    const { editor, type, key, last } = setup()
    type('@a')
    const stale = last()
    type('n')
    stale.resolve([ann])
    await flush()
    expect(editor.storage.mention.user('u1')).toBeUndefined()
    const current = last()
    key('Escape')
    current.resolve([bob])
    await flush()
    expect(editor.storage.mention.user('u2')).toBeUndefined()
  })
})

describe('mention HTML', () => {
  const html = '<p>hi <span data-mention="" data-id="u1">@Ann</span> there</p>'

  it('parses and renders round-trip', () => {
    const { editor } = setup()
    editor.setContent(html)
    const kids = blockKids(editor.getJSON())
    expect(kids[1]).toMatchObject({ type: 'mention', data: { userId: 'u1', label: 'Ann' } })
    expect(editor.getHTML()).toBe(html)
  })

  it('a span without data-id is dropped as invalid data, keeping no mention', () => {
    const { editor } = setup()
    editor.setContent('<p><span data-mention="">@x</span></p>')
    expect(blockKids(editor.getJSON()).some((n) => 'type' in n && n.type === 'mention')).toBe(false)
  })

  it('merges HTMLAttributes; data-driven attributes win', () => {
    const { editor } = setup(undefined, { HTMLAttributes: { class: 'chip', 'data-id': 'evil', title: 't' } })
    editor.setContent(html)
    expect(editor.getHTML()).toBe(
      '<p>hi <span class="chip" data-id="u1" title="t" data-mention="">@Ann</span> there</p>',
    )
  })

  it('renderText is the trigger plus the label snapshot', () => {
    const node: ElementNode = { id: 'm', type: 'mention', data: { userId: 'u1', label: 'Ann' }, children: [] }
    const defaults = mention.spec.options!
    const options = { ...defaults, trigger: '+' }
    expect(mention.spec.renderText!(node, { options: defaults })).toBe('@Ann')
    expect(mention.spec.renderText!(node, { options })).toBe('+Ann')
  })

  it('the text/plain clipboard flavor keeps a mention as @label', () => {
    const { editor } = setup()
    editor.setContent('<p>hi <span data-mention="" data-id="u1">@Ann</span> yo</p>')
    const kids = blockKids(editor.getJSON())
    const end = { path: [0, kids.length - 1], offset: 3 }
    const flavors = serializeForClipboard(editor, { start: { path: [0, 0], offset: 0 }, end })
    expect(flavors.text).toBe('hi @Ann yo')
  })

  it('renderUser is not used for HTML export: the label snapshot is', () => {
    const renderUser = vi.fn((u: User) => `Renamed ${u.label}`)
    const { editor } = setup(undefined, { renderUser })
    editor.setContent(html)
    expect(editor.getHTML()).toContain('>@Ann</span>')
    expect(renderUser).not.toHaveBeenCalled()
  })
})

describe('mention with several ranges', () => {
  const at = (path: number[], offset: number) => ({ anchor: { path, offset }, focus: { path, offset } })
  const labels = (d: Doc, i: number) =>
    blockKids(d, i).map((n) => ('text' in n ? n.text : `[${(n as ElementNode).data.label}]`))

  /** @jo at the end of the first two paragraphs, @ab in the third, plain text in the fourth. */
  function open(mainIndex = 0) {
    const ctx = setup(doc(p(txt('@jo')), p(txt('@jo')), p(txt('@ab')), p(txt('hi'))))
    const tr = ctx.editor.createTransaction()
    tr.setSelection(createSelection([at([0, 0], 3), at([1, 0], 3), at([2, 0], 3), at([3, 0], 2)], mainIndex))
    ctx.editor.dispatch(tr)
    return ctx
  }

  it('accept inserts at every caret with the same @query', async () => {
    const { editor, state, last } = open()
    expect(state()).toMatchObject({ open: true, query: 'jo' })
    last().resolve([ann])
    await flush()
    expect(editor.commands.acceptSuggestion()).toBe(true)
    expect(labels(editor.getJSON(), 0)).toEqual(['', '[Ann]', ' '])
    expect(labels(editor.getJSON(), 1)).toEqual(['', '[Ann]', ' '])
    expect(state()).toMatchObject({ open: false, range: null })
    expect(editor.state.selection).toEqual(
      createSelection([at([0, 2], 1), at([1, 2], 1), at([2, 0], 3), at([3, 0], 2)], 0),
    )
  })

  it('accept leaves a caret without the trigger untouched', async () => {
    const { editor, last } = open()
    last().resolve([ann])
    await flush()
    editor.commands.acceptSuggestion()
    expect(labels(editor.getJSON(), 2)).toEqual(['@ab'])
    expect(labels(editor.getJSON(), 3)).toEqual(['hi'])
  })

  it('accepting is one undo step that restores every caret', async () => {
    const { editor, last } = open()
    const before = stripIds(editor.getJSON())
    last().resolve([ann])
    await flush()
    editor.commands.acceptSuggestion()
    editor.commands.undo()
    expect(stripIds(editor.getJSON())).toEqual(before)
  })

  it('insertMention with the popup open replaces the trigger at every matching caret', async () => {
    const { editor, last } = open()
    last().resolve([ann])
    await flush()
    expect(editor.commands.insertMention(bob)).toBe(true)
    expect(labels(editor.getJSON(), 0)).toEqual(['', '[Bob]', ' '])
    expect(labels(editor.getJSON(), 1)).toEqual(['', '[Bob]', ' '])
    expect(labels(editor.getJSON(), 2)).toEqual(['@ab'])
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push((blockKids(editor.getJSON(), i)[1] as ElementNode).id)
    expect(new Set(ids).size).toBe(2)
  })

  it('the space after a bold trigger is bold at every caret, and so is the next typed text', async () => {
    const bold = definePlugin({ name: 'bold', mark: { render: () => ({ tag: 'strong' }) } })
    const { editor, last, type } = setup(doc(p(txt('@jo', 'bold')), p(txt('@jo', 'bold'))), {}, [bold as unknown as typeof code])
    const tr = editor.createTransaction()
    tr.setSelection(createSelection([at([0, 0], 3), at([1, 0], 3)], 0))
    editor.dispatch(tr)
    last().resolve([ann])
    await flush()
    editor.commands.acceptSuggestion()
    type('x')
    for (const i of [0, 1]) {
      const kids = blockKids(editor.getJSON(), i) as { text?: string; marks?: { type: string }[] }[]
      const tail = kids.filter((n) => 'text' in n && n.text).map((n) => [n.text, n.marks!.map((m) => m.type)])
      expect(tail).toEqual([[' x', ['bold']]])
    }
  })

  it('popup state follows the main caret', () => {
    const { state } = open(1)
    expect(state()).toMatchObject({ open: true, query: 'jo' })
    expect(state().range!.start).toEqual({ path: [1, 0], offset: 0 })
  })

  it('the popup closes when main is not at a trigger, whatever the other carets hold', () => {
    const { state } = open(3)
    expect(state().open).toBe(false)
  })

  it('range maps through an edit at another caret', () => {
    const { editor, state } = setup(doc(p(txt('ab @jo'))))
    const tr = editor.createTransaction()
    tr.setSelection(createSelection([at([0, 0], 2), at([0, 0], 6)], 1))
    editor.dispatch(tr)
    expect(state().range).toEqual({ start: { path: [0, 0], offset: 3 }, end: { path: [0, 0], offset: 6 } })
    const edit = editor.createTransaction()
    edit.insertText('QQ', at([0, 0], 2))
    editor.dispatch(edit)
    expect(state().open).toBe(true)
    expect(state().range).toEqual({ start: { path: [0, 0], offset: 5 }, end: { path: [0, 0], offset: 8 } })
  })

  it('insertMention without an open popup inserts at every caret', () => {
    const { editor } = setup(doc(p(txt('ab')), p(txt('cd'))))
    const tr = editor.createTransaction()
    tr.setSelection(createSelection([at([0, 0], 1), at([1, 0], 1)]))
    editor.dispatch(tr)
    expect(editor.commands.insertMention(ann)).toBe(true)
    expect(labels(editor.getJSON(), 0)).toEqual(['a', '[Ann]', ' b'])
    expect(labels(editor.getJSON(), 1)).toEqual(['c', '[Ann]', ' d'])
  })
})

describe('mention suggestion: triggers next to links (6.10 follow-up)', () => {
  const link = definePlugin({ name: 'link', node: { kind: 'inline' } }) as unknown as typeof code
  const caretAt = (editor: ReturnType<typeof setup>['editor'], path: number[], offset: number) => {
    const tr = editor.createTransaction()
    tr.setSelection(sel(path, offset))
    editor.dispatch(tr)
  }

  it('an @ inside a link glued to the word before it is no trigger', () => {
    const { editor, state } = setup(doc(p(txt('abc'), el('link', {}, txt('@x')), txt(''))), {}, [link])
    caretAt(editor, [0, 1, 0], 2)
    expect(state().open).toBe(false)
  })

  it('a trigger before a link reads the query across it', () => {
    const { editor, state } = setup(doc(p(txt('hi @'), el('link', {}, txt('jo')), txt(''))), {}, [link])
    caretAt(editor, [0, 1, 0], 2)
    expect(state()).toMatchObject({ open: true, query: 'jo' })
  })
})
