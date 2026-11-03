/**
 * Mention inline atom (`@hte/mention`); React views in `@hte/mention/react`. The plugin name is
 * `mention`.
 *
 * Stable `data-*` attributes (view): `data-hte-mention` on the root `<span>`, `data-selected` when
 * node-selected. Suggestion popup (a separate view root, portalled to `document.body`):
 * `data-hte-mention-suggestion` and `data-open` on the popup, `data-selected` on the highlighted
 * item. HTML output: `<span data-mention data-id="userId">@label</span>` (`options.HTMLAttributes` is
 * merged first; `data-mention` and `data-id` win). The open trigger range is decorated with the
 * class `hte-mention-query`.
 *
 * Parts: mention view `label`; suggestion `popup`, `list`, `item` (`classNames.root` and
 * `classNames.popup` both class the popup). Parts and hooks are @experimental. See
 * docs/plugin-authoring.md.
 */
import { z } from 'zod'
import {
  createId,
  definePlugin,
  findTrigger,
  getNode,
  isElement,
  isText,
  mergeAttrs,
  pointEquals,
  transformPoint,
  type Command,
  type Decoration,
  type DeepReadonly,
  type Doc,
  type Editor,
  type EditorState,
  type HTMLAttributes,
  type Point,
  type PluginContext,
  type Range,
  type Registry,
  type Transaction,
} from '@hte/core'

/** A user offered by the suggestion popup. */
export interface User {
  id: string
  label: string
  avatar?: string
}

/** The `data` of a mention node: `label` is a snapshot of the user's name at insertion time. */
export interface MentionData {
  userId: string
  label: string
}

export interface MentionOptions {
  /**
   * Returns the users matching `query` (the text typed after the trigger, possibly empty). Called on
   * every query change; only the response to the latest query is shown. A rejection (or a throw)
   * closes the popup quietly. Without it, typing the trigger opens nothing.
   */
  fetchUsers: (query: string) => Promise<User[]>
  /**
   * The live display name of a user, for views (not used by the logic, nor by HTML export, which
   * writes the `label` snapshot).
   */
  renderUser: ((user: User) => string) | undefined
  /** The character that opens the suggestion popup. Default `'@'`. */
  trigger: string
  /** Extra attributes merged into the `<span>`; `data-mention` and `data-id` always win. */
  HTMLAttributes: HTMLAttributes
}

/**
 * The suggestion popup's state (plugin state `mention`). It changes only through trs carrying the
 * meta `mention` (`MentionMeta`); between those, doc changes just map `range` and `dismissedAt`.
 */
export interface MentionState {
  open: boolean
  /** The text between the trigger and the caret. */
  query: string
  /** From the trigger to the caret while open, else null. */
  range: Range | null
  /** The users fetched for `query` (empty until its response arrives). */
  items: User[]
  /** The highlighted item. */
  index: number
  /** Incremented on every query change; a response is applied only while it still matches. */
  requestId: number
  /** Whether the response to the current query (`requestId`) is still awaited. False when closed. */
  pending: boolean
  /**
   * The trigger the user closed (Esc, caret left, space typed). The same trigger never reopens; one
   * typed again (a new trigger, or this one deleted and retyped) does.
   */
  dismissedAt: Range | null
}

/** Meta (key `mention`) of the trs that change `MentionState`. */
export type MentionMeta =
  | { type: 'open'; range: Range; query: string }
  | { type: 'results'; requestId: number; items: User[] }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'close'; dismiss?: boolean }

export interface MentionStorage {
  /**
   * Recomputes the trigger before the caret and opens, updates or closes the popup accordingly,
   * fetching when the query changed. Called after every committed doc or selection change.
   */
  refresh(): void
}

/** Class of the inline decoration over the open trigger range (`@query`). */
export const MENTION_QUERY_CLASS = 'hte-mention-query'

type Ctx = PluginContext<MentionOptions, MentionState>

const CLOSED: Omit<MentionState, 'requestId' | 'dismissedAt'> = {
  open: false,
  query: '',
  range: null,
  items: [],
  index: 0,
  pending: false,
}

const initState = (): MentionState => ({ ...CLOSED, requestId: 0, dismissedAt: null })

/** Per-editor bookkeeping that is not editor state. */
interface Runtime {
  destroyed: boolean
}

const runtimes = new WeakMap<Editor, Runtime>()

function runtimeOf(editor: Editor): Runtime {
  let rt = runtimes.get(editor)
  if (!rt) runtimes.set(editor, (rt = { destroyed: false }))
  return rt
}

function report(error: unknown): void {
  console.error('@hte/mention:', error)
}

function rangeEquals(a: Range | null, b: Range | null): boolean {
  if (a === null || b === null) return a === b
  return pointEquals(a.start, b.start) && pointEquals(a.end, b.end)
}

function mapPoint(point: Point, tr: Transaction): Point | null {
  let p: Point | null = point
  for (const op of tr.ops) {
    if (!p) return null
    if (op.type !== 'set_selection') p = transformPoint(p, op)
  }
  return p
}

function mapRange(range: Range | null, tr: Transaction): Range | null {
  if (!range || !tr.docChanged) return range
  const start = mapPoint(range.start, tr)
  const end = mapPoint(range.end, tr)
  return start && end ? { start, end } : null
}

/** Whether the text at `range.start` still begins with the trigger (else the dismissed trigger is gone). */
function triggerAt(doc: DeepReadonly<Doc>, range: Range | null, trigger: string): Range | null {
  if (!range) return null
  try {
    const node = getNode(doc as Doc, range.start.path)
    return isText(node) && node.text.startsWith(trigger, range.start.offset) ? range : null
  } catch {
    return null
  }
}

/** Whether the nearest block around `path` takes text only (a code block): no mentions there. */
function inTextOnlyBlock(doc: DeepReadonly<Doc>, registry: Registry, path: readonly number[]): boolean {
  for (let depth = path.length - 1; depth >= 1; depth--) {
    let node
    try {
      node = getNode(doc as Doc, path.slice(0, depth))
    } catch {
      return false
    }
    if (!isElement(node)) continue
    const spec = registry.node(node.type)
    if (spec?.kind === 'inline') continue
    return spec?.content === 'text'
  }
  return false
}

function applyMeta(tr: Transaction, prev: MentionState, trigger: string): MentionState {
  // Doc changes only move the positions; the popup itself changes through the meta below.
  let state = prev
  if (tr.docChanged) {
    const range = mapRange(prev.range, tr)
    const dismissedAt = triggerAt(tr.doc, mapRange(prev.dismissedAt, tr), trigger)
    if (!rangeEquals(range, prev.range) || !rangeEquals(dismissedAt, prev.dismissedAt))
      state = { ...prev, range, dismissedAt }
  }
  const meta = tr.meta.mention as MentionMeta | undefined
  if (typeof meta !== 'object' || meta === null) return state
  switch (meta.type) {
    case 'open': {
      const changed = !state.open || meta.query !== state.query
      return {
        open: true,
        query: meta.query,
        range: meta.range,
        items: changed ? [] : state.items,
        index: changed ? 0 : state.index,
        requestId: changed ? state.requestId + 1 : state.requestId,
        pending: changed ? true : state.pending,
        dismissedAt: null,
      }
    }
    case 'results':
      if (!state.open || meta.requestId !== state.requestId) return state
      return { ...state, items: meta.items, index: 0, pending: false }
    case 'move': {
      const n = state.items.length
      if (!state.open || n === 0) return state
      return { ...state, index: (((state.index + meta.delta) % n) + n) % n }
    }
    case 'close':
      return {
        ...CLOSED,
        requestId: state.requestId,
        dismissedAt: meta.dismiss ? (triggerAt(tr.doc, state.range, trigger) ?? state.dismissedAt) : state.dismissedAt,
      }
    default:
      return state
  }
}

/** Dispatches a bookkeeping tr: meta only (no ops), outside history. */
function dispatchMeta(editor: Editor, meta: MentionMeta): void {
  const tr = editor.createTransaction()
  tr.meta.origin = 'plugin'
  tr.meta.addToHistory = false
  tr.setMeta('mention', meta)
  editor.dispatch(tr)
}

/**
 * Marks a command's tr as a bookkeeping tr. A bound command dispatches its tr only when it has ops,
 * so a no-op `set_selection` (same selection, no doc change, selection unchanged) is added; history
 * ignores trs without doc ops, so typing grouping is unaffected.
 */
function metaCommand(tr: Transaction, meta: MentionMeta): true {
  tr.meta.addToHistory = false
  tr.setMeta('mention', meta)
  tr.apply({ type: 'set_selection', selection: tr.selection, prevSelection: tr.selection })
  return true
}

const isUser = (u: unknown): u is User =>
  typeof u === 'object' && u !== null && typeof (u as User).id === 'string' && (u as User).id.length > 0

/** Replaces the open trigger range (or the selection) with a mention of `user`, adds a space, closes. */
function insertUser(ctx: Ctx, tr: Transaction, user: User): boolean {
  if (!isUser(user)) return false
  const st = ctx.getState()
  if (st.open && st.range) tr.setSelection({ anchor: st.range.start, focus: st.range.end })
  tr.insertInlineNode({
    id: createId(),
    type: ctx.name,
    data: { userId: user.id, label: typeof user.label === 'string' ? user.label : '' },
    children: [],
  })
  // Not inserted (text-only block, no selection) or invalid data: nothing to do.
  if (tr.rejected !== null || !tr.docChanged) return false
  tr.insertText(' ')
  tr.setMeta('mention', { type: 'close' } satisfies MentionMeta)
  return tr.rejected === null
}

function fetchFor(ctx: Ctx, rt: Runtime, query: string, requestId: number): void {
  let request: Promise<User[]>
  try {
    request = Promise.resolve(ctx.options.fetchUsers(query))
  } catch (error) {
    request = Promise.reject(error)
  }
  // Applied only while the popup is open and this is still the latest request: a late or
  // out-of-order response never reopens the popup nor shows a stale list.
  const current = () => {
    if (rt.destroyed) return false
    const st = ctx.getState()
    return st.open && st.requestId === requestId
  }
  void request
    .then(
      (users) => {
        if (current())
          dispatchMeta(ctx.editor, { type: 'results', requestId, items: Array.isArray(users) ? users.filter(isUser) : [] })
      },
      () => {
        if (current()) dispatchMeta(ctx.editor, { type: 'close' })
      },
    )
    .catch(report)
}

function refresh(ctx: Ctx, rt: Runtime): void {
  if (rt.destroyed) return
  const editor = ctx.editor
  const state = editor.state
  const st = ctx.getState()
  const trigger = ctx.options.trigger
  let match =
    editor.view && typeof ctx.options.fetchUsers === 'function' && typeof trigger === 'string' && trigger.length > 0
      ? findTrigger(state, { char: trigger })
      : null
  if (match && inTextOnlyBlock(state.doc, editor.registry, match.range.start.path)) match = null
  if (match && st.dismissedAt && pointEquals(st.dismissedAt.start, match.range.start)) match = null

  if (!match) {
    // The caret left the trigger (or a space ended it): this trigger stays closed.
    if (st.open) dispatchMeta(editor, { type: 'close', dismiss: true })
    return
  }
  if (st.open && st.query === match.query && rangeEquals(st.range, match.range)) return
  dispatchMeta(editor, { type: 'open', range: match.range, query: match.query })
  const next = ctx.getState()
  if (next.open && next.requestId !== st.requestId) fetchFor(ctx, rt, match.query, next.requestId)
}

/** Closes the popup without dismissing its trigger (blur, unmount). */
function closeQuietly(ctx: Ctx): void {
  if (runtimeOf(ctx.editor).destroyed || !ctx.getState().open) return
  dispatchMeta(ctx.editor, { type: 'close' })
}

/**
 * Mention: an inline atom `{ userId, label }` and an `@` suggestion popup (plugin state, see
 * `MentionState`). Typing the trigger at a line start or after whitespace opens the popup (not in a
 * text-only block such as a code block); while it is open, ArrowUp / ArrowDown / Enter go to the popup
 * while it has items or the current query's results are pending (no-ops then); once the query resolved
 * with no results they are left to the editor (Enter splits, the popup stays open). Esc closes it. A space,
 * the caret leaving the trigger, Esc, a blur or an unmount close it.
 *
 * The trigger is recomputed on every doc and selection change, not only on typing: putting the caret
 * after an existing plain-text `@foo` (at a line start or after whitespace) opens the popup too
 * (like Tiptap), and ↑ ↓ Enter are then captured (as above) until the caret leaves the trigger or Esc dismisses it.
 *
 * Limitations of the trigger detection (`findTrigger`): inside a link only the link's text is
 * searched, and a trigger glued to an inline atom without a space does not open the popup.
 *
 * Contract for popup views: clicking an item must not move focus out of the editor (prevent the
 * default of the item's `mousedown`), because a blur closes the popup.
 */
export const mention = definePlugin({
  name: 'mention',
  priority: 150,
  node: { kind: 'inline', atom: true },
  data: z.object({ userId: z.string().min(1), label: z.string() }),
  options: {
    fetchUsers: undefined as unknown as MentionOptions['fetchUsers'],
    renderUser: undefined,
    trigger: '@',
    HTMLAttributes: {},
  } as MentionOptions,
  // `commands` and `storage` come before every hook taking `ctx`: TypeScript types those hooks in
  // order, and one typed first would fix the storage type to `undefined`.
  commands: (ctx) => ({
    /** Inserts a mention of `user` (replacing the open trigger, else the selection) plus a space; closes the popup. */
    insertMention:
      (user: User): Command =>
      ({ tr }) =>
        insertUser(ctx, tr, user),
    /** Closes the open popup; its trigger stays closed. */
    closeSuggestion:
      (): Command =>
      ({ tr }) =>
        ctx.getState().open && metaCommand(tr, { type: 'close', dismiss: true }),
    /** Moves the highlighted item (wrapping). False when closed or without items. */
    moveSuggestion:
      (delta: 1 | -1): Command =>
      ({ tr }) => {
        const st = ctx.getState()
        return st.open && st.items.length > 0 && metaCommand(tr, { type: 'move', delta: delta < 0 ? -1 : 1 })
      },
    /** Inserts the highlighted item. False when closed or without items. */
    acceptSuggestion:
      (): Command =>
      ({ tr }) => {
        const st = ctx.getState()
        const user = st.open ? st.items[st.index] : undefined
        return !!user && insertUser(ctx, tr, user)
      },
  }),
  storage: (ctx): MentionStorage => {
    const rt = runtimeOf(ctx.editor)
    return { refresh: () => refresh(ctx, rt) }
  },
  state: {
    init: initState,
    apply: (tr, prev: MentionState, ctx) => applyMeta(tr, prev, ctx.options.trigger),
  },
  handleDOMEvents: {
    keydown: (event, ctx) => {
      const e = event as KeyboardEvent
      const st = ctx.getState()
      // Closed, composing (the IME owns Enter) or modified: the editor handles the key.
      if (!st.open || e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
        return false
      // While open, ↑ ↓ Enter belong to the popup while it has items or the current query's results are
      // still pending (then they are no-ops, so Enter never splits the block under a list about to
      // appear). Once the query resolved with no results they are released: Enter splits as usual and
      // the popup stays open (Esc, a space or the caret leaving still close it).
      const hasItems = st.items.length > 0
      if (!hasItems && !st.pending && e.key !== 'Escape') return false
      if (e.key === 'ArrowDown') {
        if (hasItems) ctx.commands.moveSuggestion(1)
      } else if (e.key === 'ArrowUp') {
        if (hasItems) ctx.commands.moveSuggestion(-1)
      } else if (e.key === 'Enter') {
        if (hasItems) ctx.commands.acceptSuggestion()
      } else if (e.key === 'Escape') {
        ctx.commands.closeSuggestion()
      } else return false
      e.preventDefault()
      return true
    },
  },
  // Keyboards that send no usable keydown (e.g. Android): Enter while open accepts the highlighted
  // item, or is swallowed while results are pending (the block is not split under a list about to
  // appear); with zero results for the current query it splits as usual.
  onBeforeInput: (intent, ctx) => {
    if (intent.inputType !== 'insertParagraph') return false
    const st = ctx.getState()
    if (!st.open) return false
    if (st.items.length > 0) {
      ctx.commands.acceptSuggestion()
      return true
    }
    return st.pending
  },
  onUpdate: (ctx) => ctx.storage.refresh(),
  onSelectionUpdate: (ctx) => ctx.storage.refresh(),
  /**
   * Focus leaving the editor closes the popup (without dismissing the trigger). A popup must keep
   * the focus in the editor when clicked (prevent its items' `mousedown` default), or this closes it.
   */
  onBlur: (ctx) => closeQuietly(ctx),
  // Unmounting fires no blur: the popup is closed when the view goes away as well.
  onMount: (ctx, _view) => () => closeQuietly(ctx),
  destroy: (ctx) => {
    runtimeOf(ctx.editor).destroyed = true
  },
  // `span[data-mention]`: core parse rules match tag names only (no selectors), so the attribute is
  // checked here and other spans are left to the other rules.
  parseHTML: [
    {
      tag: 'span',
      getData: (el) =>
        el.hasAttribute('data-mention')
          ? { userId: el.dataset.id ?? '', label: (el.textContent ?? '').replace(/^@/, '') }
          : false,
    },
  ],
  // The label snapshot is exported (never `renderUser`). Data-driven attributes last, so
  // HTMLAttributes cannot override them.
  renderHTML: (node, { options }) => [
    'span',
    mergeAttrs(options.HTMLAttributes, {
      'data-mention': '',
      'data-id': typeof node.data.userId === 'string' ? node.data.userId : '',
    }),
    `@${typeof node.data.label === 'string' ? node.data.label : ''}`,
  ],
  // Where content becomes plain text (text/plain clipboard flavor, a code block): `@label`.
  renderText: (node, { options }) =>
    `${typeof options.trigger === 'string' ? options.trigger : '@'}${typeof node.data.label === 'string' ? node.data.label : ''}`,
  decorations: (state: EditorState, ctx): Decoration[] => {
    const st = state.pluginStates.get(ctx.name) as MentionState | undefined
    if (!st?.open || !st.range) return []
    return [{ type: 'inline', from: st.range.start, to: st.range.end, attrs: { class: MENTION_QUERY_CLASS } }]
  },
})
