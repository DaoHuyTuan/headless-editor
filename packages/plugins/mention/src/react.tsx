import { createContext, useContext, useEffect, useId, useReducer, type ComponentType, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AnyPlugin, Editor, NodeViewPropsOf } from '@hte/core'
import { dataAttrs, resolveParts, useEditorState, usePluginState, type ViewCustomization } from '@hte/react'
import { mention, type MentionState, type User } from './index'

type AnyEditor = Editor<readonly AnyPlugin[]>
/** The mention commands, reached on an editor typed with any plugin list (the plugin name is `mention`). */
type MentionEditor = Editor<readonly [typeof mention]>

/** Same own keys with `Object.is`-equal values: a re-fetched, unchanged user. */
function sameUser(a: User | undefined, b: User | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k as keyof User], b[k as keyof User]))
}

// ---------------------------------------------------------------------------------------------
// Mention view
// ---------------------------------------------------------------------------------------------

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface MentionInfo {
  /** The display name: `renderUser` of the known user (or of the snapshot), else the user's label, else `data.label`. */
  label: string
  /** The user from the suggestion results cache, when one was seen for this `userId`. */
  user: User | undefined
}

/**
 * The live display data of a mention node view. Subscribes only to its own user among the users seen
 * in suggestion results (`MentionStorage.user`): a user returned renamed by `fetchUsers` updates every
 * view of that user, and other popup changes (opening, typing a query, other users' results, the
 * highlighted item) do not re-render it. A result carrying an equal user (same own keys and values)
 * keeps the previous `user` object and does not re-render either. `renderUser` is called on render
 * only: an external store it reads is not subscribed.
 * @experimental Level 4 customization API; may change after M3 without a deprecation cycle.
 */
export function useMention(props: NodeViewPropsOf<typeof mention>): MentionInfo {
  const { userId, label: snapshot } = props.node.data
  const storage = props.storage
  const user = useEditorState(props.editor, () => storage?.user(userId), sameUser)
  const renderUser = props.options.renderUser
  let label = user?.label ?? snapshot
  if (typeof renderUser === 'function') {
    const rendered = renderUser(user ?? { id: userId, label: snapshot })
    if (typeof rendered === 'string') label = rendered
  }
  return { label, user }
}

const MentionContext = createContext<MentionInfo | null>(null)

/**
 * The `MentionInfo` provided by `Mention.Root`, for replacement parts.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function useMentionContext(): MentionInfo {
  const value = useContext(MentionContext)
  if (!value) throw new Error('@hte/mention: Mention parts must be rendered inside <Mention.Root>')
  return value
}

/** @experimental */
export interface MentionRootProps {
  value: MentionInfo
  selected?: boolean
  className?: string
  children?: ReactNode
}

/** @experimental */
export interface MentionLabelProps {
  className?: string
}

/**
 * The parts of the mention view. `Root` is `<span data-hte-mention data-selected?>` and provides
 * the `MentionInfo` to the other parts; `Label` shows `@label`.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export const Mention = {
  Root({ value, selected, className, children }: MentionRootProps) {
    return (
      <MentionContext.Provider value={value}>
        <span data-hte-mention="" {...dataAttrs({ selected })} className={className}>
          {children}
        </span>
      </MentionContext.Provider>
    )
  },
  Label({ className }: MentionLabelProps) {
    return <span className={className}>@{useMentionContext().label}</span>
  },
}

type MentionParts = { label: ComponentType<MentionLabelProps> }

export type MentionViewProps = NodeViewPropsOf<typeof mention> & ViewCustomization<MentionParts>

/**
 * Default React node view of the mention plugin. Stable attributes: `data-hte-mention` on the root,
 * `data-selected` when node-selected. `parts` / `classNames` keys: `root`, `label`.
 */
export function MentionView({ parts, classNames, ...props }: MentionViewProps) {
  const info = useMention(props)
  const P = resolveParts<MentionParts>({ label: Mention.Label }, parts)
  return (
    <Mention.Root value={info} selected={props.selected} className={classNames?.root}>
      {P.label && <P.label className={classNames?.label} />}
    </Mention.Root>
  )
}

// ---------------------------------------------------------------------------------------------
// Suggestion popup
// ---------------------------------------------------------------------------------------------

/** @experimental Level 4 customization API; may change after M3 without a deprecation cycle. */
export interface SuggestionApi {
  open: boolean
  items: readonly User[]
  index: number
  /** Viewport coords of the trigger (`editor.coordsAt(range.start)`); null while closed or unmounted. */
  coords: { left: number; top: number; bottom: number } | null
  /** Inserts the mention of `items[i]` (no-op for an out-of-range index). */
  select(i: number): void
  /** Closes the popup; its trigger stays closed. */
  close(): void
  listProps: { role: 'listbox'; id: string }
  itemProps(i: number): {
    role: 'option'
    id: string
    'aria-selected': boolean
    'data-selected'?: ''
    onMouseDown(e: MouseEvent): void
  }
}

/**
 * The suggestion popup's behaviour for an editor that has the mention plugin. Re-renders on mention
 * plugin state changes, and while open on any scroll (of the page or a scrolling ancestor) or window
 * resize, so `coords` follow the trigger. While open, the editor root gets `aria-controls` (the list)
 * and `aria-activedescendant` (the highlighted option). Item `mousedown` selects and prevents its
 * default, so the editor keeps the focus (a blur would close the popup).
 * @experimental Level 4 customization API; may change after M3 without a deprecation cycle.
 */
export function useSuggestion(editor: AnyEditor): SuggestionApi {
  const st: MentionState = usePluginState(editor, mention)
  const [, reposition] = useReducer((n: number) => n + 1, 0)
  const listId = useId()
  const optionId = (i: number) => `${listId}-option-${i}`
  const active = st.open && st.items.length > 0 ? optionId(st.index) : null
  useEffect(() => {
    if (!st.open || typeof window === 'undefined') return
    // Capture: scroll events don't bubble, and a scrolling ancestor of the editor moves it too.
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [st.open])
  useEffect(() => {
    const root = editor.view?.root
    if (!root || !active) return
    root.setAttribute('aria-controls', listId)
    root.setAttribute('aria-activedescendant', active)
    return () => {
      root.removeAttribute('aria-controls')
      root.removeAttribute('aria-activedescendant')
    }
  }, [editor, listId, active])
  const commands = (editor as unknown as MentionEditor).commands
  const select = (i: number) => {
    const user = st.items[i]
    if (user) commands.insertMention(user)
  }
  return {
    open: st.open,
    items: st.items,
    index: st.index,
    coords: st.open && st.range ? editor.coordsAt(st.range.start) : null,
    select,
    close: () => {
      commands.closeSuggestion()
    },
    listProps: { role: 'listbox', id: listId },
    itemProps: (i) => ({
      role: 'option',
      id: optionId(i),
      'aria-selected': i === st.index,
      ...dataAttrs({ selected: i === st.index }),
      onMouseDown: (e) => {
        e.preventDefault()
        select(i)
      },
    }),
  }
}

const SuggestionContext = createContext<SuggestionApi | null>(null)

/**
 * The `SuggestionApi` provided by `Suggestion.Popup`, for replacement parts.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function useSuggestionContext(): SuggestionApi {
  const value = useContext(SuggestionContext)
  if (!value) throw new Error('@hte/mention: Suggestion parts must be rendered inside <Suggestion.Popup>')
  return value
}

/** @experimental */
export interface SuggestionPartProps {
  className?: string
  children?: ReactNode
}

/** @experimental */
export interface SuggestionItemProps extends SuggestionPartProps {
  index: number
}

/**
 * The parts of the suggestion popup. `Popup` renders (while open and positioned) a
 * `<div data-hte-mention-suggestion data-open>` with `position: fixed` below the trigger (its `mousedown`
 * default is prevented, so pressing anywhere on it keeps the focus in the editor), through a
 * portal to `document.body`, and provides the `SuggestionApi` to `List` (`role="listbox"`) and
 * `Item` (`role="option"`, `aria-selected`, `data-selected`).
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export const Suggestion = {
  Popup({ value, className, children }: SuggestionPartProps & { value: SuggestionApi }) {
    if (!value.open || !value.coords || typeof document === 'undefined') return null
    return createPortal(
      <SuggestionContext.Provider value={value}>
        <div
          data-hte-mention-suggestion=""
          {...dataAttrs({ open: value.open })}
          className={className}
          style={{ position: 'fixed', left: value.coords.left, top: value.coords.bottom }}
          // A press anywhere on the popup (padding, scrollbar, not only an item) must not blur the
          // editor: a blur closes the popup.
          onMouseDown={(e) => e.preventDefault()}
        >
          {children}
        </div>
      </SuggestionContext.Provider>,
      document.body,
    )
  },
  List({ className, children }: SuggestionPartProps) {
    return (
      <ul {...useSuggestionContext().listProps} className={className}>
        {children}
      </ul>
    )
  },
  Item({ index, className, children }: SuggestionItemProps) {
    return (
      <li {...useSuggestionContext().itemProps(index)} className={className}>
        {children}
      </li>
    )
  },
}

type SuggestionParts = {
  popup: ComponentType<SuggestionPartProps & { value: SuggestionApi }>
  list: ComponentType<SuggestionPartProps>
  item: ComponentType<SuggestionItemProps>
}

export interface MentionSuggestionProps extends ViewCustomization<SuggestionParts> {
  editor: AnyEditor
  /** The content of an item; default the user's label. */
  renderItem?: (user: User, state: { index: number; selected: boolean }) => ReactNode
}

const joinClass = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ') || undefined

/**
 * Default suggestion popup of the mention plugin; render it once next to `EditorContent`. Stable
 * attributes: `data-hte-mention-suggestion` and `data-open` on the popup, `data-selected` on the
 * highlighted item. `classNames.root` and `classNames.popup` both apply to the popup. Hiding the
 * popup part (`parts: { popup: false }`) renders nothing.
 */
export function MentionSuggestion({ editor, renderItem, parts, classNames }: MentionSuggestionProps) {
  const api = useSuggestion(editor)
  const P = resolveParts<SuggestionParts>(
    { popup: Suggestion.Popup, list: Suggestion.List, item: Suggestion.Item },
    parts,
  )
  if (!P.popup) return null
  const items = api.items.map((user, index) => {
    const content = renderItem ? renderItem(user, { index, selected: index === api.index }) : user.label
    return P.item ? (
      <P.item key={user.id} index={index} className={classNames?.item}>
        {content}
      </P.item>
    ) : null
  })
  return (
    <P.popup value={api} className={joinClass(classNames?.root, classNames?.popup)}>
      {P.list ? <P.list className={classNames?.list}>{items}</P.list> : null}
    </P.popup>
  )
}
