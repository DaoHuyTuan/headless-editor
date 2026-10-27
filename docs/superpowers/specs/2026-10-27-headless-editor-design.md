# Headless Text Editor — Design

Date: 2026-10-27
Status: draft, awaiting approval

Items marked *(spec author's call)* were decided by the spec author, not the project owner, and are open to correction.

## 1. Intent and why

Build a **headless rich-text editor with a self-written engine** (not based on ProseMirror). Usage should feel like Tiptap, but **plugin authoring should be much better**, and **plugins should have strong control** over their own content.

The pain with Tiptap: writing an extension still means learning two layers (Tiptap's API plus ProseMirror's schema/NodeView/Plugin/Transaction), and what an extension can control is bounded by ProseMirror's framework.

The editor only cares about the client side: **take data in → transform it through plugins → display it → export it**. It does not dictate how the backend stores anything.

## 2. Goals, non-goals, anti-goals

### Goals
- Editor users get a familiar Tiptap-like API: create an editor, pass a list of plugins, call commands, read/write content.
- Plugin authors get full control over their part:
  - **Rendering**: with real framework components (React first).
  - **Behavior**: own keys, selection, copy/paste inside their region.
  - **Data**: define the schema of their node/mark `data`.
  - **Document intervention**: block or modify changes anywhere, including changes made by other plugins.
  - **In/out transforms**: decide how content is parsed (paste HTML, imported data) and serialized (HTML/JSON export).
- Two clearly separated data channels (see §5.3).
- Framework-independent core; React is the first adapter, Vue and others later.
- Leave the door open for realtime collaboration later without rewriting the core.

### Non-goals (first version)
- Realtime collaboration (only the groundwork, see §5.10).
- Vue/Svelte adapters (only make sure the API allows them later).
- Tables, callouts, lists, headings, etc. beyond the five v1 plugins.
- Backend, storage, real uploads. The editor only calls callbacks supplied by the app.
- Full mobile browser support (Android IME has many quirks). v1 targets desktop Chrome, Firefox, Safari; mobile is best-effort.
- Vietnamese-specific input method support (e.g. Windows Unikey/EVKey/OpenKey, which send synthetic Backspaces instead of IME composition). This will be a separate plugin later. v1 must only make sure the plugin API is strong enough to build it (see §5.6).

### Anti-goals (failure even if it technically works)
- Built-in plugins using internal APIs that external plugins can't use. Every feature, including paragraph and bold, must be a plugin using only the public API.
- Writing a plugin requires understanding engine internals (how the DOM is patched, how selection is mapped, etc.).
- The core depends on React.
- Standard IME composition breaks (lost characters, caret jumps, doubled characters).

## 3. Constraints

- TypeScript, published as ESM.
- The core has no dependency on any UI framework.
- Node/mark `data` must serialize to plain JSON.

## 4. Approaches considered

| Approach | Description | Gains | Costs |
|---|---|---|---|
| **A. contenteditable + `beforeinput`, core renders text, plugin components are "islands"** (**chosen**) | The browser handles typing/IME/spellcheck/a11y. The core intercepts `beforeinput`, turns it into operations, updates the model, and patches the DOM for text/marks itself. Nodes with a view get a framework component mounted into their own container by the adapter. | Truly framework-independent core; good performance; native IME | Must handle contenteditable differences across browsers, especially during IME composition |
| B. contenteditable, framework renders the whole document (Slate-style) | Everything is a component, including text | Writing plugins in React feels very natural | React and the browser fight over the DOM, causing IME bugs; every adapter must redo selection mapping, so framework independence is hard |
| C. Hidden textarea + self-drawn caret/selection (Monaco-style) | The editor draws everything | Total control | Must build caret, selection, IME positioning, spellcheck, a11y; image/inline layout is very hard |

**Why A:** it is the only approach that keeps the core framework-independent, lets plugins render with real components, and doesn't require reimplementing IME. Accepted trade-off: *text being typed is always managed by the core*. A component that wants an editable text region places a `<NodeContent />` "hole" and the core fills it with text.

## 5. Decided design

### 5.1 Repo layout

pnpm workspaces monorepo:

```
packages/
  core/                 # model, operations, transactions, selection, input, renderer, plugin system, HTML import/export
  react/                # React adapter
  plugins/
    paragraph/          # base plugin (required), also goes through the public API
    text/               # (if needed) base plugin for text
    bold/
    font-size/
    image/
    mention/
    code-block/
apps/
  playground/           # Vite + React
```

npm scope is `@hte/*` for now (placeholder; the builder may change it).

### 5.2 Document model

```ts
type Doc = { type: 'doc'; children: BlockNode[] }

type ElementNode = {
  id: string                 // stable for the node's lifetime: render key, identity for future sync
  type: string               // plugin name, e.g. 'paragraph', 'image', 'mention'
  data: Record<string, Json> // the plugin's own data, validated by the plugin's schema
  children?: (ElementNode | TextNode)[] // absent if the node is an atom
}

type TextNode = {
  text: string
  marks: Mark[]              // stable order by plugin registration order
}

type Mark = { type: string; data: Record<string, Json> }
```

- Each element plugin declares `kind: 'block' | 'inline'` and `atom: boolean`.
  - Image: block, atom. Mention: inline, atom. Code block: block, non-atom, text only without marks. Paragraph: block, contains inline + text.
- **Normalize** (core and plugins both participate): merge adjacent text with identical marks; every block always has at least one empty text so the caret can sit there; plugins add their own rules via a `normalize` hook.
- The `Doc` JSON is the canonical format for storage and exchange.
- **Nested blocks** *(spec author's call)*: model, paths, operations, and selection are designed generally for nested trees, so lists/tables/callouts can be added later without rewriting the core. But v1 only implements and tests editing behavior for flat blocks with inline content. `<NodeContent />` in v1 hosts inline/text only.
- **Content that doesn't match registered plugins** *(spec author's call)*:
  - Node/mark with an unregistered `type`: kept as opaque, rendered as a non-editable block, preserved on JSON export (lossless round-trip). Skipped on HTML export.
  - Only synchronous validators are supported. A validator returning a Promise is an error at plugin registration.
  - The validated output (defaults, coercion applied) replaces the stored `data`.
  - Invalid `data` on load/paste: call the plugin's optional `onInvalidData(raw) → data | null` hook (`null` = drop the node). Default: drop the node and `console.warn`.
  - Invalid `data` in `set_node_data`: the transaction is rejected; throws in dev mode.
  - No schema versioning/migration in v1; `onInvalidData` is the place for manual migration.

### 5.3 Two data channels

| | Node/mark `data` | Plugin `options` |
|---|---|---|
| Lives in | The document | The plugin instance, supplied by the app |
| Saved to DB | Yes (part of the JSON) | No |
| Undo/redo | Yes | No |
| Changed by | `set_node_data` / mark ops | `editor.setPluginOptions(name, partial)` or an adapter prop |
| Examples | mention `{ userId, label }`, image `{ src, alt, width }` | `fetchUsers`, `renderUser`, `upload` |

When `options` change, views of that plugin's nodes re-render; the document does not change.

### 5.4 Operations and transactions

Every change to the document goes through **operations**: small, serializable, invertible.

Minimum operation set:
`insert_text`, `remove_text`, `insert_node`, `remove_node`, `split_node`, `merge_node`, `move_node`, `set_node_data`, `add_mark`, `remove_mark`, `set_selection`.

- Positions use `Point = { path: number[]; offset: number }`, Slate-style. Why: paths are easy to transform under concurrent operations, which suits OT later.
- `apply(doc, op) → doc` is a pure function over an immutable document with structural sharing.
- A **transaction** holds: the operations, selection before/after, and `meta` (e.g. `{ origin: 'input' | 'paste' | 'command' | 'history' | 'plugin', addToHistory?: boolean }`).
- **History** (undo/redo) is a core plugin enabled by default; it stores transactions and inverts operations. Consecutive typing is grouped into one undo step by time and kind of action.

### 5.5 Plugin system

A plugin has a **logic part** (core, framework-independent) and an optional **view part** (per adapter).

```ts
const mention = definePlugin({
  name: 'mention',
  node: { kind: 'inline', atom: true },           // or mark: {...}; a plugin with neither is valid (pure behavior plugin)
  data: z.object({ userId: z.string(), label: z.string() }), // any Standard Schema validator (zod, valibot, arktype…)
  options: {} as { fetchUsers: (q: string) => Promise<User[]> },
  priority: 100,                                   // order for keys/input/filters; higher runs first

  commands: (ctx) => ({ insertMention: (user: User) => (tr) => { /* ... */ } }),
  keymap: (ctx) => ({ 'Mod-b': ..., ArrowDown: ... }), // return true = handled, stop the chain
  inputRules: [/* e.g. typing '@' opens the suggestion */],
  onBeforeInput: (intent, ctx) => boolean,          // intervene at intent level (insertText, deleteContentBackward, insertParagraph, insertFromPaste…)

  filterTransaction: (tr, state) => boolean,        // reject a whole transaction
  appendTransaction: (trs, oldState, newState) => Transaction | null, // fix up / add after apply
  normalize: (entry, ctx) => void,

  parseHTML: [{ tag: 'span[data-mention]', getData: el => ({ userId: el.dataset.id!, label: el.textContent!.slice(1) }) }],
  renderHTML: (node, { options }) => ['span', { 'data-mention': '', 'data-id': node.data.userId }, `@${node.data.label}`],
  transformPasted: (slice, ctx) => slice,
  serializeClipboard: (slice) => ({ html, text }),  // optional

  decorations: (state, ctx) => Decoration[],        // non-persisted decoration: syntax highlight, suggestion query highlight…

  stopEvent: (event, node) => boolean,              // node view owns this event
  ignoreMutation: (mutation) => boolean,

  // plugin's own state (not saved in the doc), e.g. whether the suggestion popup is open
  state: { init: () => ({ open: false, query: '' }), apply: (tr, prev) => next },
})
```

Key points:
- **Every feature is a plugin**, including paragraph. The core only provides the model, operations, selection, input pipeline, renderer, history, and registration.
- **Reuse / configuration**: `mention.configure({ fetchUsers })` returns a new instance; `mention.extend({...})` overrides parts, Tiptap-style.
- **Types**: `data` and `options` types are inferred all the way through `commands`, `editor.commands.*`, and view props.
- **Intervening in other plugins**: via `filterTransaction` / `appendTransaction` / `normalize` / `onBeforeInput` (code block uses these to block marks).
- **Plugin state** is reachable from views via adapter hooks (e.g. `usePluginState(mention)`).
- **Node views owning events** *(spec author's call)*: `stopEvent` and `ignoreMutation` as above. Additionally, any element inside a view with the `data-editor-ignore` attribute is fully ignored by the core (events, selection, mutations), e.g. the image `alt` input or the code block language dropdown. Both ship in v1 to avoid breaking API changes later.
- **Per-node copy**: copy writes `text/html` via `renderHTML` and a JSON slice under a custom MIME type. Plugins may override via the optional `serializeClipboard` hook.
- **`renderHTML` gets context** *(spec author's call)*: signature `renderHTML(node, { options })`, synchronous. Exported HTML reflects only stable data plus whatever `options` return synchronously; no async lookups.

### 5.6 Input pipeline

```
beforeinput / keydown / paste / drop
  → plugin keymaps (by priority)
  → plugin onBeforeInput (by priority)
  → core default handler (by inputType)
  → build transaction
  → filterTransaction (all plugins)
  → apply → appendTransaction → normalize
  → renderer patches DOM → sync DOM selection
```

- The core calls `preventDefault` on every `beforeinput` it can handle from the model.
- **IME / composition**: during composition, let the browser mutate the DOM inside the current text node; the core does not patch that region. On `compositionend` (and for `insertCompositionText`), read back the touched DOM region, diff against the model, and emit the matching operations. A `MutationObserver` is the safety net that detects and reverts unintended DOM mutations.
- Non-composition input methods (Vietnamese Unikey/EVKey style) are out of scope for v1 and will be a plugin later. To make that plugin possible without core changes, plugins must be able to: see raw `keydown`/`beforeinput`/`input` events before the core, read the recent input history, and replace a preceding range of text in one transaction (so "delete N chars then retype" can be merged into a single clean edit and a single undo step).
- **Clipboard**: copy writes `text/html` and a custom MIME with the JSON slice; paste prefers the custom MIME, then HTML (via `parseHTML` + `transformPasted`), then plain text.

### 5.7 Renderer and node views

- The core renders blocks and text/marks to the DOM itself. Marks render via a declaration `render: data => ({ tag, attrs?, style? })`.
- Diff by element `id`, patching only what changed.
- Nodes with a view: the core creates a container (`contenteditable=false` for atoms), then calls the adapter's `mount(container, props)`, `update(props)`, `destroy()`. A non-atom node with a view places `<NodeContent />`, and the core attaches the editable region there.
- Nodes without a view fall back to `renderHTML` as their default DOM.
- **Decorations**: inline (wrap a range with attrs/class) and widget (insert a non-editable element). Decorations never change the document.

### 5.8 Selection

- Model selection `{ anchor: Point, focus: Point }`, plus a "node selection" when an atom block (e.g. an image) is selected.
- Two-way mapping model ↔ DOM selection. Inline atoms behave as a single character: the caret jumps over them, Backspace deletes the whole node.

### 5.9 React adapter

```tsx
const editor = useEditor({
  plugins: [paragraph, bold, fontSize, image.configure({ upload }), mention.configure({ fetchUsers }), codeBlock],
  content: initialJson,
  onChange: ({ doc, tr }) => {},
})

<EditorContent editor={editor} />
<Toolbar>
  <button onClick={() => editor.commands.toggleBold()} data-active={useEditorState(editor, s => s.isActive('bold'))} />
</Toolbar>
```

- View registration: `react.view(image, ImageView)` or `useEditor({ views: { image: ImageView } })`. (Exact form left to the builder, as long as plugin logic never imports React.)
- `NodeViewProps<P>`: `node` (typed `data`), `updateData(partial)`, `selected`, `editor`, the plugin's `options`, `getPos()`.
- Hooks: `useEditorState(editor, selector)` (re-renders only when the selector result changes), `usePluginState(plugin)`, `usePluginOptions(plugin)`.
- Changing `options` via props calls `setPluginOptions` without recreating the editor.
- Plugin popups (mention suggestions) render through a React portal; the core provides range coordinates (`editor.coordsAt(point)`).

### 5.10 Groundwork for realtime collaboration

Not built in v1, but these are mandatory so OT/CRDT (e.g. Yjs) can be plugged in later without rewriting the core:
- Every change goes through serializable operations; no shortcut mutates the document directly.
- Elements have stable `id`s.
- History is separate from core apply, so it can later be replaced by per-user local history.
- `meta.origin` on transactions distinguishes local from remote changes.
- An `editor.applyRemote(ops)` entry point or equivalent (reserve the place in the design; no implementation needed yet).

## 6. v1 plugins

Easy to hard. Each one proves a capability of the plugin system.

1. **Bold**: mark without data. `toggleBold`, `Mod-b`, parses `<strong>`/`<b>`/`font-weight:bold`, renders `<strong>`.
2. **Font size**: mark with data `{ size: string }` (e.g. `"18px"`). `setFontSize(size)`, `unsetFontSize()`, parses `style="font-size"`. Proves plugins defining mark `data`.
3. **Image**: block atom, `data: { src, alt, width? }`, `options: { upload(file) → Promise<url>, onUploadError? }`. Insert by command, paste file, drag-and-drop file. React view allows editing `alt` and drag-resizing `width` via `updateData`. Proves both data channels and node views.
   - **Async upload** *(spec author's call)*:
     - The node is inserted immediately with a temporary blob URL as `src`; this is a normal undo step. Pending uploads (by node `id`) live in *plugin state*, not in `data`.
     - On success: `set_node_data` replaces `src` with `meta: { origin: 'plugin', addToHistory: false }`, and history rewrites `src` inside the existing undo step so undo/redo never returns to the blob URL.
     - On failure: remove the node (outside history) and call `options.onUploadError?`.
     - `getJSON()` while pending still returns the blob URL; apps check `editor.storage.image.isUploading()` or await `editor.storage.image.whenIdle()`.
4. **Mention**: inline atom, `data: { userId, label }`, `options: { fetchUsers(query), renderUser? }`.
   - `label` is a snapshot of the name at insertion time, used for HTML export and as a fallback. The view still prefers the live name from `renderUser`/runtime data.
   - Typing `@` opens a suggestion popup (input rule + plugin state). While the popup is open, the plugin takes ↑ ↓ Enter Esc before the editor.
   - The caret jumps over a mention as a single character; Backspace deletes the whole mention.
   - The view shows name/avatar from runtime data, so a renamed user displays the new name without the document changing.
5. **Code block**: block, non-atom, text only, `data: { language }`.
   - Tab inserts spaces; Enter inserts a newline inside the block; pressing Enter three times at the end of the block exits to a new paragraph.
   - **Blocking other plugins**: no marks (bold, font size…) and no inline nodes (mention) may appear inside, enforced via `filterTransaction`/`normalize`.
   - Paste strips formatting; parses `<pre><code class="language-x">` and exports back to it.
   - Syntax highlighting via decorations (library left to the builder; should be lightweight).
   - React view: language selector + `<NodeContent />`.

Base plugin: **paragraph** (required), plus basic editing behaviors: splitting/merging blocks with Enter/Backspace, history.

## 7. Playground

Vite + React app in `apps/playground`:
- **View** tab: the real editor with all five plugins, a simple toolbar, a fake user list for mentions, and a fake upload returning an object URL.
- **Code** tab: the document JSON updating on every action, plus the exported HTML (`editor.getHTML()`).
- A "scenario" picker that loads sample content per plugin for visual checks.
- Doesn't need to be pretty, just usable for trying things out.

## 8. Testing

- **Vitest (unit)**:
  - Core: `apply` and inversion for each operation (property: `apply(apply(doc, op), invert(op)) == doc`), normalize, history, path mapping, HTML parse/serialize.
  - Each plugin has its own test folder, testing through a **headless editor helper** (create an editor without a DOM, feed it doc + selection, run commands/intents, assert the output doc). This helper is public API so external plugin authors can use it too.
- **Playwright (real browsers)**, running against the playground:
  - Core: typing, deleting, Enter, undo/redo, copy/paste, caret movement.
  - IME: simulate standard composition via CDP `Input.imeSetComposition` on Chromium (e.g. accented and CJK text) and check the doc and caret afterward.
  - Each plugin has its own e2e tests for its specific behavior (mention popup, Tab/Enter in code block, image insert and resize…).
- Runs on Chromium, Firefox, WebKit.

## 9. Milestones *(spec author's call)*

v1 is split into milestones; each must run in the playground and have tests:
1. **M1**: core (model, operations, history, input, renderer, selection) + paragraph + bold + React adapter + playground + headless test helper. Chromium only.
2. **M2**: font size + image (node views, async upload, `data-editor-ignore`).
3. **M3**: mention + code block (plugin state, popup, decorations, blocking other plugins).
4. **M4**: run e2e on Firefox and WebKit, fix cross-browser differences.

No npm publishing in v1, so the API may still change between milestones.

## 10. Left to the builder

- DOM diff algorithm details and the immutable data structure.
- `id` generation (nanoid or equivalent).
- Exact form of view registration in the React adapter (§5.9).
- Syntax highlighting library for code block.
- The exact list of `beforeinput` `inputType`s handled in v1 (at least enough for the five plugins and basic editing).
- Build/lint tooling (tsup/vite lib mode, eslint/biome…).
- Final npm scope name.

## 11. Future plugins (not in v1)

- **Vietnamese input**: handles Windows Unikey/EVKey/OpenKey style input (synthetic Backspace + retype) cleanly, merging it into single edits and undo steps. Decided by the project owner to be a separate plugin later.
- Lists, headings, tables, callouts.
- Realtime collaboration (on top of §5.10).
