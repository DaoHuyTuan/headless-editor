/**
 * Mention inline atom (`@penline/mention`); React views in `@penline/mention/react`. The plugin name is
 * `mention`.
 *
 * Stable `data-*` attributes (view): `data-penline-mention` on the root `<span>`, `data-selected` when
 * node-selected. Suggestion popup (a separate view root, portalled to `document.body`):
 * `data-penline-mention-suggestion` and `data-open` on the popup, `data-selected` on the highlighted
 * item. HTML output: `<span data-mention data-id="userId">@label</span>` (`options.HTMLAttributes` is
 * merged first; `data-mention` and `data-id` win). The open trigger range is decorated with the
 * class `penline-mention-query`.
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
  single,
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
} from '@penline/core'

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
   * writes the `label` snapshot). Called when a view renders: an external store it reads is not
   * subscribed, so a change there shows on the chip's next render only (see `useMention`).
   */
  renderUser: ((user: User) => string) | undefined
  /**
   * The text that opens the suggestion popup. Default `'@'`. Meant to be one character; a longer
   * trigger works loosely: the popup opens only once the whole trigger is typed, the nearest
   * occurrence before the caret decides (so a run of the trigger's characters, e.g. `:::` with
   * `'::'`, opens nothing), and the trigger must not contain whitespace (whitespace ends a query).
   */
  trigger: string
  /** Extra attributes merged into the `<span>`; `data-mention` and `data-id` always win. */
  HTMLAttributes: HTMLAttributes
}

/**
 * The suggestion popup's state (plugin state `mention`). It changes only through trs carrying the
 * meta `mention` (`MentionMeta`); between those, doc changes just map `range` and `dismissed`.
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
   * The triggers the user closed (Esc, the caret leaving it, a space typed), each keyed by its
   * position (mapped through doc changes), never by its query. A dismissed trigger never reopens,
   * whichever other triggers the caret visits in between; one typed again (a new trigger, or this one
   * deleted and retyped) does. A trigger whose text is gone drops out.
   */
  dismissed: readonly Range[]
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
  /**
   * The latest user with this id seen in suggestion results (the ones applied to the popup: stale or
   * post-close responses are not), or undefined. Recorded before the `results` tr is dispatched, so a
   * view subscribed to the editor reads the new user on that tr. Kept across closes, per editor.
   */
  user(id: string): User | undefined
}

/** Class of the inline decoration over the open trigger range (`@query`). */
export const MENTION_QUERY_CLASS = 'penline-mention-query'

type Ctx = PluginContext<MentionOptions, MentionState>

const CLOSED: Omit<MentionState, 'requestId' | 'dismissed'> = {
  open: false,
  query: '',
  range: null,
  items: [],
  index: 0,
  pending: false,
}

const initState = (): MentionState => ({ ...CLOSED, requestId: 0, dismissed: [] })

/** Per-editor bookkeeping that is not editor state. */
interface Runtime {
  destroyed: boolean
  /** Users seen in applied results, by id (`MentionStorage.user`). Latest result wins. */
  users: Map<string, User>
}

const runtimes = new WeakMap<Editor, Runtime>()

function runtimeOf(editor: Editor): Runtime {
  let rt = runtimes.get(editor)
  if (!rt) runtimes.set(editor, (rt = { destroyed: false, users: new Map() }))
  return rt
}

function report(error: unknown): void {
  console.error('@penline/mention:', error)
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

const isDismissed = (dismissed: readonly Range[], start: Point) => dismissed.some((d) => pointEquals(d.start, start))

/** `dismissed` plus `range` (when its trigger is still there and not dismissed already). */
function dismiss(dismissed: readonly Range[], range: Range | null): readonly Range[] {
  return range && !isDismissed(dismissed, range.start) ? [...dismissed, range] : dismissed
}

/** Maps every dismissed trigger through `tr`, dropping the gone ones; the same array when none moved. */
function mapDismissed(dismissed: readonly Range[], tr: Transaction, trigger: string): readonly Range[] {
  if (dismissed.length === 0) return dismissed
  const next: Range[] = []
  for (const d of dismissed) {
    const mapped = triggerAt(tr.doc, mapRange(d, tr), trigger)
    if (mapped && !isDismissed(next, mapped.start)) next.push(mapped)
  }
  return next.length === dismissed.length && next.every((r, i) => rangeEquals(r, dismissed[i]!)) ? dismissed : next
}

function applyMeta(tr: Transaction, prev: MentionState, trigger: string): MentionState {
  // Doc changes only move the positions; the popup itself changes through the meta below.
  let state = prev
  if (tr.docChanged) {
    const range = mapRange(prev.range, tr)
    const dismissed = mapDismissed(prev.dismissed, tr, trigger)
    if (!rangeEquals(range, prev.range) || dismissed !== prev.dismissed) state = { ...prev, range, dismissed }
  }
  const meta = tr.meta.mention as MentionMeta | undefined
  if (typeof meta !== 'object' || meta === null) return state
  switch (meta.type) {
    case 'open': {
      // The caret went straight from the open trigger to another one: it left the first one
      // (dismissed), and this is a new popup even with the same query.
      const hop = state.open && state.range !== null && !pointEquals(state.range.start, meta.range.start)
      const changed = !state.open || hop || meta.query !== state.query
      return {
        open: true,
        query: meta.query,
        range: meta.range,
        items: changed ? [] : state.items,
        index: changed ? 0 : state.index,
        requestId: changed ? state.requestId + 1 : state.requestId,
        pending: changed ? true : state.pending,
        dismissed: hop ? dismiss(state.dismissed, triggerAt(tr.doc, state.range, trigger)) : state.dismissed,
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
        dismissed: meta.dismiss ? dismiss(state.dismissed, triggerAt(tr.doc, state.range, trigger)) : state.dismissed,
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

/**
 * Replaces the open trigger at every caret whose text before it is the main caret's trigger plus query
 * (the same `findTrigger` match, in a block taking inline content); the other ranges are untouched.
 * Each copy gets its own id.
 */
function insertAtTriggers(ctx: Ctx, tr: Transaction, user: User, query: string): boolean {
  const label = typeof user.label === 'string' ? user.label : ''
  let inserted = false
  tr.forEachRange((range, t) => {
    // A real state (the tr's start state) with the live doc and this range alone: the same
    // `findTrigger` the popup runs at the main caret, asked at this caret.
    const at: EditorState = { ...t.before, doc: t.doc, selection: single(range) }
    const match = findTrigger(at, { char: ctx.options.trigger, registry: t.registry })
    if (!match || match.query !== query || inTextOnlyBlock(t.doc, t.registry, match.range.start.path)) return
    // The space takes the trigger text's marks, as the single-range path's insertText takes the caret's.
    const lead = getNode(t.doc, match.range.start.path)
    const marks = isText(lead) ? lead.marks.map((m) => ({ ...m, data: JSON.parse(JSON.stringify(m.data)) })) : []
    t.insertFragment(
      [
        { id: createId(), type: ctx.name, data: { userId: user.id, label }, children: [] },
        { text: ' ', marks },
      ],
      match.range,
    )
    inserted = true
  })
  return inserted && tr.rejected === null && tr.docChanged
}

/**
 * Replaces the open trigger range (or the selection) with a mention of `user`, adds a space, closes.
 * With several ranges the popup's trigger is the main caret's: it is replaced at every caret with the
 * same trigger and query, and the other ranges are left alone. Without an open popup the mention goes
 * to every range.
 */
function insertUser(ctx: Ctx, tr: Transaction, user: User): boolean {
  if (!isUser(user)) return false
  const st = ctx.getState()
  if (st.open && st.range && tr.selection && tr.selection.ranges.length > 1) {
    if (!insertAtTriggers(ctx, tr, user, st.query)) return false
    tr.setMeta('mention', { type: 'close' } satisfies MentionMeta)
    return true
  }
  if (st.open && st.range) tr.setSelection(single({ anchor: st.range.start, focus: st.range.end }))
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
        if (!current()) return
        const items = Array.isArray(users) ? users.filter(isUser) : []
        // Recorded before the dispatch, so views re-rendering on this tr read the new users.
        for (const u of items) rt.users.set(u.id, u)
        dispatchMeta(ctx.editor, { type: 'results', requestId, items })
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
      ? findTrigger(state, { char: trigger, registry: editor.registry })
      : null
  if (match && inTextOnlyBlock(state.doc, editor.registry, match.range.start.path)) match = null
  if (match && isDismissed(st.dismissed, match.range.start)) match = null

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
 * with no results they are left to the editor (Enter splits the block, which moves the caret out of
 * the trigger and so closes the popup). Esc closes it. A space, the caret leaving the trigger, Esc, a
 * blur or an unmount close it.
 *
 * The trigger is recomputed on every doc and selection change, not only on typing: putting the caret
 * after an existing plain-text `@foo` (at a line start or after whitespace) opens the popup too
 * (like Tiptap), and ↑ ↓ Enter are then captured (as above) until the caret leaves the trigger or Esc dismisses it.
 *
 * Several ranges: the popup, trigger, query and coordinates follow the main caret. Accepting (or
 * `insertMention`) replaces the trigger at every caret that has the same trigger and query; the other
 * ranges are untouched.
 *
 * Trigger detection (`findTrigger` with the editor's registry) reads the same text input rules do:
 * the caret's run in its block, across inline elements such as links. Limitation: a trigger glued to
 * an inline atom without a space does not open the popup.
 *
 * Contract for popup views: clicking an item must not move focus out of the editor (prevent the
 * default of the item's `mousedown`), because a blur closes the popup.
 */
export const mention = definePlugin({
  name: 'mention',
  // Above the code block (150): with the main caret at an open popup and another caret in a code
  // block, both handle `insertParagraph`; the popup must claim it first, whatever the registration
  // order. It claims it only while open (with items, or results pending), so other plugins see every
  // other Enter. (Keydown needs no priority: DOM event handlers run before every keymap.)
  priority: 160,
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
    return { refresh: () => refresh(ctx, rt), user: (id) => rt.users.get(id) }
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
      // appear). Once the query resolved with no results they are released: Enter splits as usual,
      // which moves the caret out of the trigger, so the refresh after the split closes the popup
      // (and dismisses that trigger).
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
  // appear); with zero results for the current query it splits as usual (closing the popup, as the
  // caret leaves the trigger).
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
