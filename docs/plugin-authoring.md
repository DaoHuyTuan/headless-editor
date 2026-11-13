# Plugin authoring guide

This guide shows how the built-in plugins are customized and how to write a plugin that can be customized the same way. The rules come from spec §5.11 (`docs/superpowers/specs/2026-10-27-headless-editor-design.md`); this document agrees with it and adds the practical details.

For a field-by-field reference of the object passed to `definePlugin`, see [plugin-api.md](plugin-api.md).

Every code sample here is typechecked: they live in `packages/plugins/image/test/docs-examples.test-d.tsx` (run `pnpm exec vitest --typecheck run`). Keep the two in sync.

Contents: [layers](#layers-of-a-plugin) · [customization levels](#customization-levels-using-image) · [writing a plugin](#writing-a-plugin-callout) · [lifecycle hooks](#lifecycle-hooks) · [extend](#extendparent--overrides) · [pitfalls](#pitfalls) · [built-in attributes](#stable-data-attributes-of-the-built-in-plugins)

## Layers of a plugin

Each plugin with a view is built in four layers; users can stop at any of them.

1. **Logic** (`@penline/<plugin>`): a `definePlugin` spec only (schema, commands, keymap, input handling, HTML in/out, storage, lifecycle). No framework imports.
2. **Headless hooks** (`@penline/<plugin>/react`): behaviour without markup, for example `useImageResize(props)`. The props they return include `data-editor-ignore` where it is needed, so you cannot forget it.
3. **Parts**: small components that each wire one hook to one element and accept `className` (`Image.Root`, `Image.Img`, `Image.AltInput`, `Image.ResizeHandle`). Parts share state through a context that `Root` provides.
4. **Default view**: the parts assembled, plus the standard customization props `parts` and `classNames` (`ViewCustomization` from `@penline/react`).

Naming: part keys are camelCase (`altInput`, `resizeHandle`, `languageSelect`) and the `classNames` key for the root element is always `root`.

## Customization levels (using Image)

| Level | How | Stability |
|---|---|---|
| 0 | Use the default view | stable |
| 1 | CSS on the stable `data-*` attributes | stable |
| 2 | `HTMLAttributes` option (HTML output) and `classNames` (view parts) | stable |
| 3 | `parts`: hide or replace single parts | `@experimental` |
| 4 | Your own view from the headless hooks | `@experimental` |
| 5 | Change behaviour with `extend(parent => ...)` | stable |

"Experimental" means marked `@experimental` in JSDoc: it may change in a minor release, without a deprecation cycle, until it is marked stable. Levels 3 and 4 stay experimental in 1.0 (decided 2026-11-10): they are validated on Image, Mention and Code block only, and will graduate from users' feedback. Pin a minor version (`~`) if you build on them.

### Level 0: the default view

```tsx
const editor = useEditor({
  plugins: [paragraph, image.configure({ upload })],
  nodeViews: { image: ImageView },
})
return <EditorContent editor={editor} />
```

`nodeViews` maps a node type to a React component. It is read once, on the first render: changing the object later has no effect. To switch a view at runtime, keep one component in `nodeViews` and let it choose what to render, from its props (`props.options`, `props.node.data`) or from React context, as the playground's image story does (`apps/playground/src/image-views.tsx`).

### Level 1: CSS on `data-*`

Every view root carries `data-penline-<plugin>`, and state is exposed as attributes that are **present when true and absent otherwise**. The names in use are `data-selected`, `data-uploading` and `data-open`; `data-active` is reserved by the spec but no built-in plugin emits it today. The [per-plugin table](#stable-data-attributes-of-the-built-in-plugins) is the authority on what each plugin emits.

```css
[data-penline-image] { margin: 1rem 0; }
[data-penline-image][data-selected] { outline: 2px solid royalblue; }
[data-penline-image][data-uploading] img { opacity: 0.5; }
```

The attribute names are API: renaming one is a breaking change. Secondary view roots (for example the mention popup) carry `data-penline-<plugin>-<view>`, such as `data-penline-mention-suggestion`, so that `[data-penline-mention]` matches only the node views. The full list per plugin is [below](#stable-data-attributes-of-the-built-in-plugins).

### Level 2: `HTMLAttributes` and `classNames`

`HTMLAttributes` changes the **HTML output** (`getHTML()`, clipboard); `classNames` changes the **view**.

```tsx
const levelTwoImage = image.configure({ upload, HTMLAttributes: { class: 'article-img', loading: 'lazy' } })

function LevelTwoImageView(props: ImageViewProps) {
  return <ImageView {...props} classNames={{ root: 'figure', img: 'figure-img', resizeHandle: 'figure-handle' }} />
}

function LevelTwoEditor() {
  const editor = useEditor({
    plugins: [paragraph, levelTwoImage],
    nodeViews: { image: LevelTwoImageView },
  })
  return <EditorContent editor={editor} />
}
```

How `HTMLAttributes` is applied (the same in every plugin, through the core helper `mergeAttrs(base, extra)`):

- `class` values are concatenated, `style` declarations are merged, any other attribute in `extra` overrides `base`. Attribute names are **lowercased** (`SRC` and `src` are one key).
- A plugin merges `HTMLAttributes` **first** and its data-driven attributes **last**: `mergeAttrs(options.HTMLAttributes, { ...dataAttrs })`. The data-driven attributes win, so `HTMLAttributes` can add `class`, `style` and other attributes but never override what the node's data controls (the image `src`, which stays behind `safeSrc`; the mention `data-mention` and `data-id`).
- `HTMLAttributes` is trusted application-author input. It is **not sanitized**: do not feed it user content.
- Mark plugins get their options through `mark.render(data, { options })`.

### Level 3: `parts`

`parts` replaces a part with your component, or hides it with `false`. A replacement receives the part's props (`className`) and reads shared state from the plugin's context hook.

```tsx
function AltCaption({ className }: ImagePartProps) {
  const { alt } = useImageContext()
  return <figcaption className={className}>{alt}</figcaption>
}

function LevelThreeImageView(props: ImageViewProps) {
  return <ImageView {...props} parts={{ altInput: AltCaption, resizeHandle: false }} classNames={{ root: 'card' }} />
}
```

You can also arrange the exported parts yourself; `useImage(props)` builds the value `Image.Root` provides:

```tsx
function ImageWithoutHandle(props: ImageProps) {
  const api = useImage(props)
  return (
    <Image.Root value={api} className="plain">
      <Image.Img />
      <Image.AltInput className="plain-alt" />
    </Image.Root>
  )
}
```

Image parts: `img`, `altInput`, `resizeHandle` (`root` for classes). Mention: `label`, plus the suggestion parts `popup`, `list`, `item`. Code block: `toolbar`, `languageSelect`, `content`.

### Level 4: hooks only

Skip the parts and build the markup yourself from the hooks. Spread the props the hooks return: they already include `data-editor-ignore`.

```tsx
function LevelFourImageView(props: ImageProps) {
  const { selected, uploading } = useImageState(props)
  const { width, resizing, handleProps } = useImageResize(props)
  const { inputProps } = useAltDraft(props)
  // Hooks-only views must put the src behind safeSrc themselves.
  const src = safeSrc(props.node.data.src) ?? undefined
  return (
    <figure data-penline-image="" {...dataAttrs({ selected, uploading })}>
      <img src={src} alt={props.node.data.alt} width={width} draggable={false} />
      <input {...inputProps} />
      <span {...handleProps} hidden={!selected && !resizing} />
    </figure>
  )
}
```

Image specifics for hooks-only views:

- `safeSrc` is exported from `@penline/image`. The default parts call it; the hooks do not, so use it for the `src` or you lose the image's URL policy (`javascript:` and similar schemes).
- `useImageResize` measures the **first `<img>` inside the node-view container** (`[data-penline-node-view]`) at `pointerdown`. Keep the picture as the first `<img>` of the view.
- `dataAttrs({ selected, uploading })` (from `@penline/react`) gives `data-selected` / `data-uploading` present-when-true.

Other hooks: `useMention(props)`, `useSuggestion(editor)` (mention); `useCodeBlock(props)` (code block); all three are `@experimental`. Your own view keeps the same attribute contract (`data-penline-<plugin>` plus the state attributes) so users' level 1 CSS keeps working.

### Level 5: `extend(parent => ...)`

`extend` accepts an object (shallow override) or a function that receives the parent spec, so a hook can wrap the original instead of copying it.

```ts
const roundedImage = image.extend((parent) => ({
  renderHTML: (node, ctx) => {
    const [tag, attrs] = parent.renderHTML!(node, ctx) as [string, Attrs]
    return [tag, mergeAttrs(attrs, { class: 'rounded' })]
  },
  keymap: (ctx) => ({
    ...parent.keymap?.(ctx),
    'Mod-Shift-i': () => ctx.commands.insertImage('/placeholder.png'),
  }),
}))
```

- `extend` never renames the plugin. Extending an extended plugin passes the previous result as `parent`.
- **The plugin name matters.** The headless hooks read plugin state by the plugin's registered name (`image`, `mention`): `usePluginState(editor, image)` looks up `editor.getPluginState('image')`. If you copy a spec under a **new** name (`definePlugin({ ...image.spec, name: 'myImage' })`), its state lives under `myImage` and `useImageState`, `useSuggestion` and the other hooks no longer find it. Extend instead of renaming, or write your own hooks.
- Cross-plugin interception (plugin A wrapping plugin B's hooks) is intentionally not provided. Use `priority`, returning `true` to stop a handler chain, `filterTransaction`, `appendTransaction` and `normalize`.

## Writing a plugin: callout

A small `callout` block (an `<aside>` with a tone) with every layer: logic, hooks, parts and a default view.

### Logic

```ts
type Tone = 'info' | 'warn'

interface CalloutOptions {
  /** Extra attributes merged into the `<aside>`. */
  HTMLAttributes: HTMLAttributes
}

interface CalloutState {
  /** How many callouts were inserted by `insertCallout` in this editor. */
  inserted: number
}

export const callout = definePlugin({
  name: 'callout',
  node: { kind: 'block', content: 'inline' },
  data: z.object({ tone: z.enum(['info', 'warn']).default('info') }),
  options: { HTMLAttributes: {} } as CalloutOptions,
  // `commands` and `storage` come before every hook that takes `ctx`.
  commands: () => ({
    insertCallout:
      (tone: Tone = 'info'): Command =>
      ({ tr }) => {
        tr.insertBlockNode({ id: createId(), type: 'callout', data: { tone }, children: [{ text: '', marks: [] }] })
        tr.setMeta('calloutInserted', true)
        return tr.rejected === null && tr.docChanged
      },
  }),
  storage: (ctx) => ({
    count: () => [...nodeEntries(ctx.editor.state.doc)].filter(([n]) => isElement(n) && n.type === ctx.name).length,
  }),
  state: {
    init: (): CalloutState => ({ inserted: 0 }),
    apply: (tr, prev: CalloutState): CalloutState => (tr.meta.calloutInserted ? { inserted: prev.inserted + 1 } : prev),
  },
  keymap: (ctx) => ({ 'Mod-Alt-c': () => ctx.commands.insertCallout('info') }),
  parseHTML: [
    {
      tag: 'aside',
      getData: (el) => ({ tone: el.getAttribute('data-tone') === 'warn' ? 'warn' : 'info' }),
    },
  ],
  renderHTML: (node, { options }) => [
    'aside',
    // HTMLAttributes first, data-driven attributes last: the node's data always wins.
    mergeAttrs(options.HTMLAttributes, { 'data-tone': node.data.tone === 'warn' ? 'warn' : 'info' }),
    0,
  ],
  onCreate: (ctx) => {
    // Side-effect free: no subscriptions or timers (there is no cleanup; start them in onMount).
    void ctx.storage.count()
  },
  onMount: (_ctx, view) => {
    // `view` is the argument; `editor.view` is still null here.
    view.root.classList.add('has-callouts')
    // Unmount fires no onBlur: undo per-view state (and close popups) in this cleanup.
    return () => view.root.classList.remove('has-callouts')
  },
})
```

Rules this sample follows:

- **Declare `commands` and `storage` before any hook that takes `ctx`** (`keymap`, `state.apply`, `onCreate`, ...). TypeScript types the spec's members in order:
  - `storage` declared after such a hook fails with a confusing TS2322 (`T` was already fixed to `undefined`).
  - `commands` that take `ctx` declared after such a hook **silently lose their command types**: the plugin contributes no commands to `editor.commands`, and `ctx.commands` inside the earlier hook is untyped for them.
  - Both cases are pinned by `@ts-expect-error` / type assertions in `docs-examples.test-d.tsx`, so a future improvement of the inference is noticed.
- `ctx.commands` is empty during the initial normalize, and `editor.storage` is `undefined` while the storage factories run (so a factory must not read other plugins' storage eagerly; the functions it returns run later and see everything).

### Hooks

Headless behaviour, no markup. Read plugin state with `usePluginState`; do not rely on `props.state`, which is read when accessed and does not re-render the view.

```tsx
type CalloutProps = NodeViewPropsOf<typeof callout>

export function useCallout(props: CalloutProps) {
  // Plugin state is read with usePluginState (props.state does not re-render the view).
  const { inserted } = usePluginState(props.editor, callout)
  const { tone } = props.node.data
  return {
    tone,
    selected: props.selected,
    inserted,
    selectProps: {
      'data-editor-ignore': '' as const,
      'aria-label': 'Tone',
      value: tone,
      onChange: (e: ChangeEvent<HTMLSelectElement>) => {
        props.updateData({ tone: e.target.value === 'warn' ? 'warn' : 'info' })
      },
    },
  }
}
```

### Parts

```tsx
type CalloutApi = ReturnType<typeof useCallout>

const CalloutContext = createContext<CalloutApi | null>(null)

function useCalloutContext(): CalloutApi {
  const value = useContext(CalloutContext)
  if (!value) throw new Error('Callout parts must be rendered inside <Callout.Root>')
  return value
}

interface CalloutPartProps {
  className?: string
  children?: ReactNode
}

export const Callout = {
  Root({ value, className, children }: CalloutPartProps & { value: CalloutApi }) {
    return (
      <CalloutContext.Provider value={value}>
        <aside data-penline-callout="" data-tone={value.tone} {...dataAttrs({ selected: value.selected })} className={className}>
          {children}
        </aside>
      </CalloutContext.Provider>
    )
  },
  Toolbar({ className, children }: CalloutPartProps) {
    // A sibling of the content, never its ancestor.
    return (
      <div contentEditable={false} suppressContentEditableWarning className={className}>
        {children}
      </div>
    )
  },
  ToneSelect({ className }: CalloutPartProps) {
    const { selectProps } = useCalloutContext()
    return (
      <select {...selectProps} className={className}>
        <option value="info">Info</option>
        <option value="warn">Warning</option>
      </select>
    )
  },
  Body({ className }: CalloutPartProps) {
    return <NodeContent className={className} />
  },
}
```

### Default view

```tsx
type CalloutParts = {
  toolbar: ComponentType<CalloutPartProps>
  toneSelect: ComponentType<CalloutPartProps>
  body: ComponentType<CalloutPartProps>
}

export type CalloutViewProps = CalloutProps & ViewCustomization<CalloutParts>

export function CalloutView({ parts, classNames, ...props }: CalloutViewProps) {
  const api = useCallout(props)
  const P = resolveParts<CalloutParts>(
    { toolbar: Callout.Toolbar, toneSelect: Callout.ToneSelect, body: Callout.Body },
    parts,
  )
  return (
    <Callout.Root value={api} className={classNames?.root}>
      {P.toolbar && (
        <P.toolbar className={classNames?.toolbar}>
          {P.toneSelect && <P.toneSelect className={classNames?.toneSelect} />}
        </P.toolbar>
      )}
      {P.body && <P.body className={classNames?.body} />}
    </Callout.Root>
  )
}

function CalloutEditor() {
  const editor = useEditor({
    plugins: [paragraph, callout],
    nodeViews: { callout: CalloutView },
  })
  editor.commands.insertCallout('warn')
  return <EditorContent editor={editor} />
}
```

Checklist for a new plugin's view:

- Root element: `data-penline-<plugin>` (kebab-case of the plugin name: `codeBlock` gives `data-penline-code-block`). A secondary view root gets `data-penline-<plugin>-<view>`.
- State attributes present when true, absent otherwise; use `dataAttrs`.
- 2 to 4 meaningful parts (not one per tag), camelCase keys, each accepting `className`; `classNames.root` for the root.
- Mark the part, hook and context APIs `@experimental` in JSDoc until validated.
- Hooks return every prop an element needs, including `data-editor-ignore` on focusable controls.

### Node views

- Read plugin state with `usePluginState(props.editor, plugin)`, **not** `props.state`. A change of plugin state alone does not call the view's `update`, so a view rendering `props.state` shows the state of its last re-render (a change of its data, `selected` or options) until something else re-renders it. `props.state` is fine in event handlers, where it is read when accessed.
- For an **atom** view the whole container is `contenteditable="false"`. Mark interactive controls `data-editor-ignore` so the editor leaves their events and mutations alone (the hooks' props already do).
- For a **non-atom** view (one that renders `<NodeContent />`):
  - The elements on the path from the container down to the content must stay editable. Never render `NodeContent` inside a `contentEditable={false}` element: that makes a separate editing host (the core warns).
  - Only **siblings** of that path (headers, toolbars, labels) are marked `contenteditable="false"`; their focusable controls need `data-editor-ignore`.
  - No nested editing hosts: do not put another `contenteditable`, or a second editor, around or inside the content.
  - Render `<NodeContent />` exactly once.

### Container node views

A container is a non-atom block whose `content` holds blocks (a quote, a list, a table; see [`node`](plugin-api.md#node)). Its view differs from a textblock's in two ways.

**Tags.** A view's container and its `contentDOM` are `div`s (`span`s for an inline node) unless the view sets them. Markup with a strict content model needs that: a table view must not put a `div` between `table`, `tbody` and `tr`.
- In the core, `EditorOptions.nodeViews` takes a `NodeViewSpec` (`{ factory, as?, contentAs? }`) as well as a bare factory. `as` is the container's tag, `contentAs` the `contentDOM`'s.
- In React (`@experimental`), `useEditor`'s `nodeViews` takes a `ReactNodeViewSpec` (`{ component, as?, contentAs? }`) as well as a bare component.
- `<NodeContent as="section" />` gives its placeholder any tag.
- `<NodeContent placeholder={false} />` renders no placeholder: it renders an empty `<template>` marker and places the `contentDOM` itself right after it. Use it when no wrapper element is allowed:

```tsx
function TableView() {
  return <NodeContent placeholder={false} /> // table > tbody[data-penline-content] > tr
}
const editor = useEditor({
  plugins: [paragraph, table, tableRow, tableCell],
  nodeViews: { table: { component: TableView, as: 'table', contentAs: 'tbody' } },
})
```

Caveats of `placeholder={false}`:
- `className` goes on the `<template>` marker, where it has no effect. Style the content through its tag (`contentAs`) or `[data-penline-content]`.
- Elements the view renders after `<NodeContent>` land after the content element (a `tfoot` rendered after it follows the `tbody`).
- The content element is placed once, next to the marker. If the view later re-orders its children so the marker moves, the content element stays where it was.

**Updates.** A container view gets `update` on any change of its node, its children included, so it can show an item count or a column count. That means every keystroke inside it, and every IME composition step, re-renders the view (a React container view re-renders on each). Keep container views cheap: render the frame and `<NodeContent>`, and memoize anything derived from the children. Textblock and atom views are updated as before (data, `selected` or options).

Structure-specific editing (Tab in a list, Enter that splits a list item, Tab between cells) belongs to the container's plugin, on top of the core transforms (`tr.wrap`, `tr.lift`, `tr.split(point, depth, typesAfter)`, `tr.join`; see [Structure and slices](plugin-api.md#structure-and-slices)). Bind those keys at a higher priority than the core's generic Backspace and Enter.

## Lifecycle hooks

In addition to the data-flow hooks (`state`, `storage`, `parseHTML` / `renderHTML`, `renderText`, `handleDOMEvents`, `keymap`, `onBeforeInput`, `filterTransaction`, `appendTransaction`, `normalize`, `transformPasted`, `stopEvent`, `ignoreMutation`, `decorations`), a plugin may declare:

| Hook | When | Cleanup |
|---|---|---|
| `onCreate(ctx)` | once, after the editor is constructed (headless, no DOM) | none |
| `onMount(ctx, view)` | each time a view is attached to a DOM root | return a function: called on unmount |
| `onUpdate(ctx, { tr })` | after a committed transaction that changed the doc | none |
| `onSelectionUpdate(ctx, { tr })` | after a committed transaction that changed the selection | none |
| `onFocus(ctx, event)` / `onBlur(ctx, event)` | focus enters / leaves the editor root | none |
| `destroy(ctx)` | editor destroyed | none |

`renderText(node, { options })` (on a node plugin, usually an inline atom) returns the node's plain text wherever content becomes plain text: the `text/plain` clipboard flavor, an inline atom normalized into a `content: 'text'` block (it becomes that text; an atom without `renderText` is dropped there), and plugins that flatten content to text (the code block's paste and `setCodeBlock`). `options` are the editor's current plugin options. Without it an element's text is its children's text, so a childless atom has none. Core exports `nodeText(node, registry, options?)` to compute it in your own plugins.

`transformPasted(fragment, ctx, { at })` rewrites a pasted or dropped fragment. `at` is where the fragment will be inserted:
- for a drop, the drop point;
- for a paste, the target range. With several selection ranges the hook runs once per range, with `at` set to that range.

`at` is null only when the fragment goes to the main range. A hook that depends on the insertion position reads `at ?? mainRange(ctx.editor.state.selection)`. It never reads the selection alone: a drop lands where the pointer is, not at the caret. See [plugin-api.md: Selections and multiple ranges](plugin-api.md#selections-and-multiple-ranges).

Plugins are called by priority. For each committed transaction the editor emits `transaction`, then (doc changed) `update` followed by the `onUpdate` hooks, then (selection changed) `selectionUpdate` followed by the `onSelectionUpdate` hooks: each hook runs right after its matching event's listeners (`editor.on`, and `EditorOptions.listeners`). `onFocus` / `onBlur` have no matching editor event. `onMount` cleanups run in reverse order. Under React StrictMode `useEditor` builds one editor (`onCreate` runs once) and `EditorContent` mounts it, unmounts it and mounts it again: `onMount` runs twice and its cleanup once, leaving exactly one active mount. A throwing hook does not stop the others: the first error is rethrown after all ran.

Asymmetries to design around:

- **Unmount fires no `onBlur`.** Close popups and reset per-view state in the `onMount` cleanup, not in `onBlur`.
- **Mounting on an already-focused root fires no `onFocus`.** Check `document.activeElement` in `onMount` if you need the initial focus state.
- **`editor.view` is `null` during `onMount`.** Use the `view` argument.
- **`onCreate` has no cleanup.** Keep it side-effect free: no subscriptions, timers or network calls. Start those in `onMount` (with a cleanup) instead. `useEditor` builds its editor once, StrictMode included, but an editor built during a render React discards (a suspended first mount) is never destroyed.
- **What `onCreate` dispatches is reported only to listeners given at construction** (`EditorOptions.listeners`; `useEditor`'s `onUpdate` uses them), since `editor.on` cannot be called before the constructor returns.
- **`ctx.commands` is empty during the initial normalize**, and `editor.storage` is `undefined` while storage factories run.
- `onUpdate` / `onSelectionUpdate` run outside the transaction pipeline: dispatching from them is a nested dispatch. It is committed (and its events and hooks run) before `dispatch` returns, so the hooks of the outer transaction that run later see `editor.state` already past it: read what the outer transaction changed from `tr`, not by comparing with `editor.state`.

## `extend(parent => overrides)`

See [level 5](#level-5-extendparent--overrides). In short: `extend` takes an object or a function of the parent spec; it keeps the plugin name; `configure(options)` returns a new plugin with merged options.

## Pitfalls

### Options in React

`useEditor({ pluginOptions })` shallow-compares each entry with the last applied value on every render and calls `editor.setPluginOptions` when it differs. **Memoize what you pass**: an inline object, or an inline function inside it, changes identity on every render and re-renders every node view of that type.

```tsx
const fetchUsers = async (query: string): Promise<User[]> => [{ id: '1', label: query }]
const renderUser = (user: User) => user.label

const mentionOptions = { mention: { fetchUsers, renderUser } }

function MentionEditor() {
  const editor = useEditor({
    plugins: [paragraph, mention],
    pluginOptions: mentionOptions, // module-level: same identity on every render
  })
  return (
    <>
      <EditorContent editor={editor} />
      <MentionSuggestion editor={editor} classNames={{ popup: 'mention-popup', item: 'mention-item' }} />
    </>
  )
}

function InlineOptionsEditor({ token }: { token: string }) {
  // Values that depend on props: memoize the object (a fresh object or function per render
  // re-renders every node view of the type).
  const pluginOptions = useMemo(() => ({ mention: { fetchUsers: async (q: string) => [{ id: token, label: q }] } }), [token])
  const editor = useEditor({ plugins: [paragraph, mention], pluginOptions })
  return <EditorContent editor={editor} />
}
```

Options merge: a key dropped from a later value keeps its last applied value.

### Mention

```tsx
function ShoutingMention(props: NodeViewPropsOf<typeof mention>) {
  const { label } = useMention(props)
  return <span data-penline-mention="">@{label.toUpperCase()}</span>
}
```

- `data.label` is a snapshot taken at insertion time (used for HTML export). The view prefers the live name.
- A **renamed user** shows up when a `fetchUsers` call returns the new label: views read a per-editor cache of users seen in suggestion results. Nothing else updates it.
- A `renderUser` that reads an **external store is not subscribed**: the view re-renders on mention plugin state and option changes only. If the name comes from a store, re-render through your own subscription (or pass a new memoized `renderUser` when the store changes).
- The mention's `renderText` is `${trigger}${label}` (`@Ann`): copying a mention gives `@Ann` in `text/plain`, and a mention that ends up in a code block (paste, `setCodeBlock`, Backspace joining a paragraph into one) becomes the text `@Ann` instead of disappearing.
- Placing the caret right after an existing plain `@foo` in the text **opens the popup** (the trigger is recomputed after every selection change).
- The suggestion popup is a separate root (`data-penline-mention-suggestion`), rendered with `<MentionSuggestion editor={editor} />` next to `EditorContent`; it is portalled to `document.body`. Closing is done by the mention plugin, not the component: its `onBlur` hook and its `onMount` cleanup (unmount fires no blur) close the popup. `MentionSuggestion` only renders the plugin state.

### Code block

```tsx
function HighlightedCodeBlockView(props: CodeBlockViewProps) {
  return <CodeBlockView {...props} classNames={{ content: 'hljs', toolbar: 'code-toolbar' }} />
}

function CodeEditor() {
  const editor = useEditor({
    plugins: [paragraph, codeBlock],
    nodeViews: { codeBlock: HighlightedCodeBlockView },
  })
  return <EditorContent editor={editor} />
}
```

- The node type (and `nodeViews` key) is `codeBlock`; the data attribute is `data-penline-code-block`.
- `<code>` gets only `language-x`, **no `hljs` class**. highlight.js themes expect it, so add it with `classNames`: `classNames.content` classes the `<pre>`. To class the `<code>` itself, replace the `content` part.
- **Tab and Shift-Tab are consumed** inside a code block (indent / dedent), so they cannot move focus out of the editor from there. Enter inserts a newline; three Enters at the end exit the block; `Mod-Enter` exits.
- Marks and inline nodes (bold, mention, ...) are blocked inside a code block via `filterTransaction` / `normalize`; pasted content is flattened to text (a mention keeps its `@label` text through its `renderText`).

### The spec ordering rule, demonstrated

Pinned in `docs-examples.test-d.tsx`:

```ts
// Correct: commands before the hook that uses ctx.commands
definePlugin({
  name: 'ordered',
  node: { kind: 'block' },
  options: { x: 1 },
  commands: (ctx) => ({ ping: (n: number): Command => () => ctx.options.x > n }),
  keymap: (ctx) => ({ A: () => ctx.commands.ping(0) }),
})

// Wrong: commands (that use ctx) after a hook. CommandsOfPlugin is `{}` and no error says so.
definePlugin({
  name: 'late',
  node: { kind: 'block' },
  options: { x: 1 },
  keymap: (ctx) => ({ A: () => ctx.options.x > 0 }),
  commands: (ctx) => ({ ping: (n: number): Command => () => ctx.options.x > n }),
})
```

## Stable `data-*` attributes of the built-in plugins

State attributes are present (as `""`) when true and absent otherwise. These names are API.

| Plugin (name) | Element | Attributes |
|---|---|---|
| `bold`, `fontSize`, `paragraph` | none (no React view) | none |
| `image` | view root `<figure>` | `data-penline-image`, `data-selected` (node-selected), `data-uploading` (upload pending) |
| `mention` | view root `<span>` | `data-penline-mention`, `data-selected` |
| `mention` | suggestion popup root `<div>` | `data-penline-mention-suggestion`, `data-open` |
| `mention` | suggestion item `<li>` | `data-selected` (highlighted) |
| `codeBlock` | view root `<div>` | `data-penline-code-block`, `data-selected` |

HTML output (not the view): `mention` writes `<span data-mention data-id="…">@label</span>`; `codeBlock` writes `<pre><code class="language-x">`; `image` writes `<img src alt width>`.

Parts and `classNames` keys (`root` is always available for the node-view root):

| Plugin | Keys |
|---|---|
| `image` | `img`, `altInput`, `resizeHandle` |
| `mention` view | `label` |
| `mention` suggestion | `popup`, `list`, `item` (`root` and `popup` both class the popup) |
| `codeBlock` | `toolbar`, `languageSelect`, `content` (`content` classes the `<pre>`) |
