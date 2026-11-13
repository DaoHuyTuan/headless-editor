# `definePlugin` API reference

This page describes the object passed to `definePlugin({...})`. It covers each field: what it is for, when the editor calls it, and what it must return.

For a guided walkthrough (customization levels, writing a plugin with hooks, parts and a view), read [plugin-authoring.md](plugin-authoring.md). The source of truth is `PluginSpec` in `packages/core/src/plugin/types.ts`. Every sample on this page is typechecked in `packages/plugins/image/test/docs-examples.test-d.tsx`, marked `doc: api`.

```ts
import { definePlugin, mergeAttrs, type Command, type Data, type HTMLAttributes } from '@penline/core'
import { z } from 'zod'

export const highlight = definePlugin({
  name: 'highlight',                                         // identity
  options: { color: 'yellow', HTMLAttributes: {} as HTMLAttributes }, // runtime config
  data: z.object({ color: z.string().optional() }),          // stored per mark/node
  mark: {
    render: (data, { options }) => ({
      tag: 'mark',
      attrs: mergeAttrs(options.HTMLAttributes, {}),
      style: { background: data.color ?? options.color },
    }),
  },
  parseHTML: [{ tag: 'mark', getData: (el): Data => (el.style.background ? { color: el.style.background } : {}) }],
  commands: () => ({
    toggleHighlight: (color?: string): Command => ({ tr }) => tr.toggleMark('highlight', color ? { color } : {}).rejected === null,
  }),
  keymap: (ctx) => ({ 'Mod-Shift-h': () => ctx.commands.toggleHighlight() }),
})
```

## Contents

1. [How the spec is typed](#how-the-spec-is-typed): read this first.
2. [Identity](#identity): `name`, `priority`.
3. [Schema](#schema): `node` (content expressions, `group`, `marks`, `isolating`), `mark`, `data`, `onInvalidData`.
4. [Configuration](#configuration): `options`.
5. [Commands and input](#commands-and-input): `commands`, `keymap`, `onBeforeInput`, `inputRules`, `handleDOMEvents`.
   - [Selections and multiple ranges](#selections-and-multiple-ranges): what every command must know.
   - [Structure and slices](#structure-and-slices): `wrap`, `lift`, `setBlockType`, `split`, `join`, `Slice`.
6. [Transactions](#transactions): `filterTransaction`, `appendTransaction`, `normalize`.
7. [HTML and clipboard](#html-and-clipboard): `parseHTML`, `renderHTML`, `renderText`, `transformPasted`.
8. [View integration](#view-integration): `decorations`, `stopEvent`, `ignoreMutation`, and the editor methods behind the view (`handleDOMEvent`, `transformPasted`).
9. [Plugin state and storage](#plugin-state-and-storage): `state`, `storage`.
10. [Lifecycle](#lifecycle): `onCreate`, `onMount`, `onUpdate`, `onSelectionUpdate`, `onFocus`, `onBlur`, `destroy`.
11. [The `ctx` object](#the-ctx-object)
12. [The returned plugin](#the-returned-plugin): `configure`, `extend`.
13. [Field summary table](#field-summary)

---

## How the spec is typed

`definePlugin` infers six type parameters from the object you pass. You never write them yourself.

| Parameter | Inferred from | Used as |
|---|---|---|
| `Name` | `name` (a literal) | key in `editor.storage`, `editor.getPluginState(name)` |
| `D` | the `data` schema's output | `node.data` / mark data in hooks, `NodeViewProps.node.data` |
| `O` | `options` | `ctx.options`, `renderHTML`'s `{ options }`, `configure()` |
| `C` | the return of `commands` | `ctx.commands`, `editor.commands` |
| `S` | `state.init()` | `ctx.getState()`, `usePluginState` |
| `T` | the return of `storage` | `ctx.storage`, `editor.storage[name]` |

**Ordering rule.** TypeScript infers these types in the order the keys appear in the object.
- Put `commands` and `storage` before any hook whose `ctx` parameter you use.
- If `commands: (ctx) => …` comes after such a hook, its command types are lost silently (`C` becomes `{}`).
- If `storage` comes after such a hook, you get a confusing `TS2322`.
- A `commands: () => …` that takes no parameter can go anywhere.
- [plugin-authoring.md](plugin-authoring.md#the-spec-ordering-rule-demonstrated) shows this rule in action.

Recommended key order: `name`, `priority`, `node`/`mark`, `data`, `options`, `commands`, `storage`, `state`, then the hooks.

---

## Identity

### `name` (required)
`string`, written as a literal. It is the plugin's identity:
- It is the node or mark `type` in the document (`{ type: 'highlight' }`).
- It is the key in `editor.storage` and `getPluginState`.
- It is the key in `pluginOptions` and `nodeViews` (React).

`extend` never renames a plugin. Hooks that read plugin state by name, such as the image and mention React hooks, break if you re-create the plugin under another name.

### `priority`
`number`, default `100`. A higher number runs first. Priority decides the order of:
- keymaps;
- `handleDOMEvents`;
- `onBeforeInput`;
- input rules;
- filters;
- normalize hooks;
- decorations;
- lifecycle hooks;
- `parseHTML` ties.

`destroy` runs in reverse order. Raise the priority when your plugin must see a key before another plugin does. Example: code block uses 150 so that its `Enter` wins over the core's split.

---

## Schema

A plugin declares at most one of `node` and `mark`. A plugin with neither is a behaviour-only plugin, for example history or a word counter.

### `node`
```ts
{
  kind: 'block' | 'inline'
  atom?: boolean
  default?: boolean
  content?: string            // a content expression; 'inline' and 'text' are aliases
  group?: string | string[]
  marks?: string
  isolating?: boolean
}
```
- `kind: 'block'` is an element that stands at block level (paragraph, image, code block, quote, list). `kind: 'inline'` is an element inside text (mention, link).
- `atom: true` means the node has no editable children. It is rendered by a node view or by `renderHTML`, the caret jumps over it, and Backspace deletes it whole. Examples: image, mention.
- `content` applies to non-atom nodes. It is a **content expression**, compiled once when the editor is created:
  - Names: a node type (`paragraph`, `listItem`), a group (`block`, `inline`, or one a plugin declares), or `text`.
  - Sequence by spaces, alternation with `|`, parentheses, and the quantifiers `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`.
  - Examples: `'block+'` (a quote), `'listItem+'` (a list), `'paragraph block*'` (a list item: a paragraph first, then any blocks), `'tableRow+'`, `'(tableCell | tableHeader)+'`.
  - `'inline'` means `inline*`: text, marks and inline nodes. It is the default: **an omitted `content` on a non-atom block means a textblock**, so a block that holds other blocks must declare it (`content: 'block+'` or narrower).
  - `'text'` means `text*` with `marks: ''`: plain text only. Marks and inline atoms are stripped by normalization, and `\n` is a real newline. Example: code block.
  - Only the alias sets `marks: ''`. An explicit `'text*'` (or `'text+'`) is text-only too (no inline nodes, `\n` a real newline) but keeps the default `marks: '_'`, so its text may carry marks; add `marks: ''` to get the alias's plain text.
  - A **textblock** is a node whose content holds only inline content; text only lives in textblocks and inline elements. `tr.registry.isTextblock(type)` tells which, and `tr.registry.isTextOnly(type)` whether its expression names only `text`.
  - An unknown name in an expression, or a node that can never be created (its required content cannot be filled), throws when the editor is created and names the plugin.
  - The doc's content is `block+`. An unregistered type in a document is a wildcard: it fits any one slot of an expression and normalization never changes it.
- `group`: the groups the node belongs to, usable in other nodes' expressions. Default: `block` for a block, `inline` for an inline node. A node that sets `group` is only in the groups it lists, so a `listItem` sets `group: []` (or a group of its own) to stay out of `block` and only appear where a list asks for it.
- `marks`: the marks allowed in the node's inline content. `'_'` allows all (the default), `''` none (the default for `content: 'text'`), or a space-separated list of mark names (`'bold italic'`). Normalization removes the others. The names are not checked against the registered marks: a misspelt name is accepted and the mark it meant is removed.
- `isolating: true`: edits do not cross the node's boundary. Backspace and Delete never join it with a neighbour, and a range delete that only partly covers it never merges or removes it (it empties the covered text instead). Example: a table cell.
- `default: true` makes this the block the editor creates when it needs one, for example an empty doc or Enter. Exactly one plugin should set it. The paragraph plugin does. Inside a container, the core creates the type that container's expression expects at that position instead (`registry.createAndFill`), so a block created after a split in a list item is still a paragraph, and a default block whose `data` schema has defaults gets them.

The registry exposes the compiled schema through `tr.registry` (and `editor.registry`):
- `isTextblock(type)`: whether the type holds only inline content.
- `contentMatch(type)`: the compiled match of the type's content (`'doc'` for the root). Its shape lives in `@penline/core/internal` (no semver guarantee); use it to ask what fits, not to build documents.
- `createAndFill(type, data?)`: a new node of `type` with fresh ids, data parsed from `data ?? {}`, and its required content filled in (a list gets a list item holding an empty paragraph). `null` for an unknown type, invalid data, or content that cannot be filled.

Normalization follows the schema at every depth, on the nodes a transaction touched (the whole doc on load). Children that do not fit their parent are fixed in order: an inline run where blocks are expected is wrapped into the textblock the position expects, missing nodes are filled in, a node is wrapped into the containers it needs (a paragraph in a list becomes a list item), a block that fits nowhere is unwrapped, an atom block in a textblock is hoisted out. An empty container is filled, never given a bare text.

Example: a quote and a two-level list.
```ts
const quote = definePlugin({ name: 'quote', node: { kind: 'block', content: 'block+' } })
const bulletList = definePlugin({ name: 'bulletList', node: { kind: 'block', content: 'listItem+' } })
const listItem = definePlugin({ name: 'listItem', node: { kind: 'block', content: 'paragraph block*', group: [] } })
const tableCell = definePlugin({ name: 'tableCell', node: { kind: 'block', content: 'block+', group: [], isolating: true } })
```

### `mark`
```ts
{ render: (data: D, ctx: { options: O }) => { tag: string; attrs?: Record<string, string | number | undefined>; style?: Record<string, string> } }
```
This describes how a mark wraps its text in the view and in `getHTML()`. `render` gets the mark's validated `data` and the plugin's current `options`. When the options change (`setPluginOptions`), the text carrying the mark is re-rendered. Merge `options.HTMLAttributes` with `mergeAttrs(options.HTMLAttributes, dataDrivenAttrs)`: HTMLAttributes go first and data-driven attributes win.

### `data`
A [Standard Schema](https://standardschema.dev) such as a zod object. It validates and types the JSON `data` stored on every node or mark of this type.
- The schema must be synchronous.
- Data is JSON: no `undefined` values, functions or class instances. Omit a key instead of setting it to `undefined`, as in `color ? { color } : {}` in the sample at the top. A `getData` or command building data inline may need a `: Data` annotation.
- Its output type becomes `D`.
- Use `.default()` for optional fields that need a value.
- Every insert, paste and load is validated. Invalid data is rejected, or repaired by `onInvalidData`.

### `onInvalidData(raw) => Data | null`
Called when loaded or pasted data fails the `data` schema. Return repaired data to keep the node, or `null` to drop it. Example: code block maps an unsafe language to `{ language: 'plaintext' }` instead of losing the code.

---

## Configuration

### `options`
`O`, a plain object of runtime configuration that is not stored in the document. Typical contents: callbacks (`upload`, `fetchUsers`), defaults, and `HTMLAttributes`. The object's type is the options type, so cast or annotate wide fields (`{ HTMLAttributes: {} as HTMLAttributes }`).

There are three ways to change options:
- `plugin.configure({...})` returns a new plugin with options shallow-merged in. Use it at setup.
- `editor.setPluginOptions(name, partial)` changes them at runtime. Marks and node views using the options re-render.
- In React, `useEditor({ pluginOptions: { name: {...} } })`. Keep that object stable with a module constant or `useMemo`: a new object on every render re-renders every node view of the type.

Read options in hooks through `ctx.options`, which is always current.

---

## Commands and input

### `commands(ctx) => Record<string, (...args) => Command>`
This declares the plugin's commands. Each entry is a factory: it takes the user's arguments and returns a `Command`.
```ts
type Command = (props: { tr: Transaction; state: EditorState; editor: Editor }) => boolean
```
- The command edits the fresh `tr` it is given and returns whether it applies. Return `false` without touching `tr` when it does not apply.
- The editor dispatches `tr` when the command returned true and changed something.
- `editor.commands.x()` returns false when the pipeline dropped the tr, for example after a `filterTransaction` veto or a rejected op.
- `editor.can().x()` runs the same command and the filters without dispatching. Use it for toolbar enabled states.
- The selection can hold several ranges. Read [Selections and multiple ranges](#selections-and-multiple-ranges) before writing a command that edits at the selection.
- Check `tr.rejected === null` after an edit to know whether it was valid.
- `ctx` here has no typed `commands` or `storage` yet, to avoid circular inference. The functions you return run later, so they may use the editor freely.

### `keymap(ctx) => Record<string, () => boolean>`
Key bindings. Names look like `'Mod-b'`, `'Shift-Enter'`, `'Mod-Shift-z'` and `'Backspace'`:
- `Mod` is Ctrl on Windows and Linux, and Cmd on Mac.
- Modifier order does not matter.
- Single letters are case-insensitive.

Return `true` to claim the key; the event is then prevented and no other plugin sees it. Return `false` to let the next plugin, and then the browser, handle it. The keymap runs after `handleDOMEvents.keydown`.

### `onBeforeInput(intent, ctx) => boolean`
Handles a `beforeinput` intent before the core's default handling.
```ts
interface InputIntent { inputType: string; data: string | null; range: Selection | null; dataTransfer?: DataTransfer | null }
```
Return `true` when the plugin handled the intent. Use this for input that does not come as a keydown: mobile keyboards (`insertParagraph` without an Enter keydown), `formatBold` from the OS menu, and `insertLineBreak` (Shift+Enter in some browsers).

### `inputRules: { match: RegExp; handler(ctx, match, range, tr) => boolean }[]`
These run after the core inserts typed text. They do not run for paste or for IME composition.
- `match` is tested against the block's text up to the caret. Anchor it with `$`.
- `range` covers the matched text.
- If `handler` changes `tr` and returns `true`, that change is dispatched as its own undo step, so one Ctrl+Z reverts the rule but keeps the typed text. Returning `false` discards `tr`.

Example: `**text**` becomes bold.

### `handleDOMEvents: { keydown?, beforeinput?, input? }`
Raw DOM handlers `(event, ctx) => boolean`. They run first, before keymaps and intents. Return `true` to claim the event: no other plugin sees it, and a claimed `keydown` or `beforeinput` is also prevented (`preventDefault()`), so the browser never edits the DOM itself. Claiming `input` only stops the other handlers (it has no default action). Use them when you need the raw event; a mention popup, for example, captures arrow keys while it is open. Prefer `keymap` and `onBeforeInput` when they are enough.

---

### Selections and multiple ranges

The selection can hold **several ranges** (multiple cursors). No UI in the document view creates them yet, but the API, history and every built-in plugin support them.

```ts
interface SelectionRange { anchor: Point; focus: Point; node?: Path } // node: node selection of that element
interface Selection { ranges: SelectionRange[]; main: number }        // never empty, sorted, non-overlapping
```

- **Reading the selection.**
  - Read the primary range with `mainRange(sel)`.
  - Build selections with `single(range)` or `createSelection(ranges, main)`. `createSelection` sorts the ranges and merges any that overlap or touch.
  - A node range is always the only range. `isNodeSelection(sel)` returns a plain boolean, not a type guard. To narrow a range, use `isNodeRange(range)`.
- **`tr` editing methods act on every range by default.** This covers `insertText`, `deleteRange`, `deleteBackward`/`deleteForward`, `splitBlock`, `insertBlockNode`, `insertInlineNode`, `insertFragment`, `insertSlice`, `wrap`, `lift`, `setBlockType`, `addMark`, `removeMark` and `toggleMark`.
  - Called with no range, a method edits at every range in one transaction and one undo step. A plugin that calls `tr.toggleMark('bold')` is multi-range-correct with no extra work.
  - Called with an explicit range, it edits only there and maps the other ranges. These methods take one (a `SelectionRange` or a `Range`): `insertText(text, at)`, `deleteRange(range)`, `deleteBackward(unit, at)`, `deleteForward(unit, at)`, `splitBlock(at)`, `insertBlockNode(node, at)`, `insertFragment(fragment, at)`, `insertSlice(slice, range)`, `wrap(type, data, range)`, `lift(range)`, `setBlockType(type, data, range)`, `addMark(mark, range)` and `removeMark(type, range)`. For a single position, pass a collapsed range; no method takes a bare point.
  - `insertInlineNode` and `toggleMark` take no range: they always act at every range, and throw inside a `forEachRange` callback in dev mode.
- **Mark state across ranges.**
  - `toggleMark` and `isActive` look at all ranges. If every range already has the mark, toggling removes it everywhere; otherwise it adds it everywhere. Ranges that cover no characters do not count.
  - Stored marks are one set for the whole selection.
- **Custom per-range logic.** Use `tr.forEachRange((range, tr, index) => SelectionRange | null | void)`.
  - It runs once per range, in document order, on the same tr. Each range is first mapped through the edits made at earlier ranges.
  - Return the range's new position. Return `null` to drop the range, or nothing to keep its mapped position.
  - Inside the callback, pass `range` explicitly to the editing methods. A call with no range throws in dev mode, because it would edit every range again.
  - `toggleMark` takes no range, so inside a callback use `addMark`/`removeMark` with the callback's range.
  - A range that an earlier step's removal swallowed is skipped and merged.
- **Acting on the main range on purpose.** Some behaviour belongs to one place:
  - a popup's position;
  - IME composition;
  - a targeted `beforeinput` intent such as autocorrect.

  Such code reads `mainRange` and says so in its JSDoc. Typing, IME and targeted intents collapse a multi-range selection where needed, and so does a user click away from the main caret.
- **Undo** restores every range and `main`.
- **`tr.dev`** is true when the editor was created with `dev: true`. It enables the dev-mode checks above.

```ts
// Insert "TODO" at every caret and leave each caret in front of it (custom per-range logic).
const insertTodo = (): Command => ({ tr }) => {
  tr.forEachRange((range, t) => {
    t.insertText('TODO', range) // explicit range inside the callback
    return { anchor: range.anchor, focus: range.anchor } // this range's new position
  })
  return tr.rejected === null
}
```

### Structure and slices

Containers (nodes whose `content` holds blocks) are edited through `tr` methods that check the schema first: each produces a valid document or changes nothing. The core never relies on normalization to repair what they produce.

| Method | Does | Fails (no ops) when |
|---|---|---|
| `tr.wrap(type, data?, range?) => boolean` | wraps the blocks of each range (at the deepest level where they are siblings) into `type`, adding the inner wrappers the schema needs (a paragraph wrapped in `bulletList` gets a `listItem`) | the schema does not allow `type` there, or its data is invalid (then `tr.rejected` is set) |
| `tr.lift(range?) => boolean` | moves the blocks of each range out of their container into the container's parent, splitting the container around them and removing it when left empty | the container's parent does not accept the blocks there (a list item's first paragraph cannot be lifted alone into its list); it never carries blocks past that parent |
| `tr.setBlockType(type, data?, range?) => boolean` | changes the textblocks of each range to the textblock `type`, keeping their children; marks `type` does not allow are removed | no textblock changed |
| `tr.split(point, depth = 1, typesAfter?) => Point \| null` | splits the textblock at `point` and its `depth - 1` nearest ancestors; `typesAfter` (outermost first, `null` keeps the split node's type) gives the new nodes' types. Returns the start of the new innermost block. Ranges are mapped; the selection is not set | the result would not be valid |
| `tr.join(path) => boolean` | joins the node at `path` into its previous sibling (two lists of the same type) | the two nodes are not compatible, or either is isolating |
| `tr.getSlice(range?) => Slice` | the slice of `range` (default: the main range, on purpose) | — |
| `tr.insertSlice(slice, range?) => boolean` | deletes each range and fits `slice` there | the slice fits nowhere at that range |

`wrap`, `lift`, `setBlockType` and `insertSlice` follow the multi-range rules above; their explicit range is a `SelectionRange`. A range whose blocks an earlier range already wrapped or lifted does nothing (two carets in one paragraph wrap it once). The core commands `wrapIn(type, data?)`, `lift()` and `setBlockType(type, data?)` call them at every range and answer `editor.can()`.

```ts
interface Slice { content: Fragment; openStart: number; openEnd: number }
```
A `Slice` is the content of a range below the deepest node that holds both ends, plus how many block levels are cut open at each end. A range from the middle of one list item to the middle of the next gives the two items with `openStart: 2` and `openEnd: 2`. `insertSlice` fits it with the schema:
- An open end merges into the textblock at the caret when its open nodes line up with the caret's ancestors: two list items pasted into a list item's paragraph give two items of that list.
- An open end that does not line up is closed, so a lone container (a quote, a list, a table) pasted into a root paragraph goes in whole.
- Whole nodes go where the content match accepts them, wrapped when needed (list items pasted into a root paragraph become a list, table cells a table) or unwrapped one level.

`Fragment` is unchanged. `insertFragment(fragment)` is `insertSlice` with a fragment's open depths (an edge textblock merges, other edges go in whole), so flat documents behave as before.

The generic keys follow the schema too (spec §5.3): Backspace at the start of a container's first textblock lifts it out when the lift is valid, else joins into the textblock before; Delete mirrors it; Enter in an empty textblock inside a container lifts it out when valid; a range delete across depths joins the end textblock into the start one. None of them crosses an isolating node. Structure-specific behaviour (sinking a list item, Tab between cells) belongs to the container's plugin, bound at a higher priority.

## Transactions

### `filterTransaction(tr, state) => boolean`
Called for every transaction before it is applied. Return `false` to veto it: the doc does not change, and the command that made it returns false. `can()` runs filters too.
- Keep filters cheap: they run on every keystroke. Return early when `tr` cannot concern you.
- Never veto history (`tr.meta.origin === 'history'`). Undo has to be able to restore any earlier state.

Example: code block vetoes trs that add a mark inside a code block.

### `appendTransaction(trs, oldState, newState) => Transaction | null`
Called after transactions are applied. Return a follow-up tr, created from `newState`, to fix things up, or `null`.
- Appended trs join the undo step of the tr that triggered them.
- They inherit `addToHistory: false` from that tr.

Avoid loops: return `null` when there is nothing to do.

### `normalize([node, path], tr, ctx) => void`
Called for each node during normalization, which runs after every change and on load. Edit `tr` to repair your node type's invariants, for example "a figure always has a caption". The editor repeats normalization until nothing changes, so each fix must converge. The core already enforces its own rules, such as merging adjacent texts and stripping marks in text-only blocks; do not duplicate them.

---

## HTML and clipboard

### `parseHTML: { tag?, style?, priority?, getData?(el, styleValue) }[]`
Rules for turning HTML from `setContent(html)` or a paste into your node or mark.
- `tag` matches an element by tag name, for example `'mark'` or `'pre'`. It is not a CSS selector. To match on an attribute, use `getData`.
- `style` matches a CSS property. `getData` then gets its value as `styleValue`.
- `getData(el)` returns the node or mark data, or `false` to say the rule doesn't match after all. Example: `getData: (el) => el.hasAttribute('data-mention') ? {...} : false`.
- `priority` defaults to 50. Higher priorities are tried first, with ties broken by plugin priority.

Parsed content is placed through the schema. An element claimed by a container plugin (a quote, a list) keeps its nested blocks, and its inline runs go into the textblock its content expects (`<li>text</li>` becomes a list item holding a paragraph). Unclaimed `ul`, `ol`, `li`, `blockquote` and table tags are unwrapped, as before.

### `renderHTML(node, { options }) => DOMOutputSpec`
How a node is serialized to HTML for `getHTML()` and the clipboard. It is also the view for nodes without a node view.
```ts
type DOMOutputSpec = string | 0 | [tag, attrs?, ...children]
// ['pre', attrs, ['code', { class: 'language-js' }, 0]]   — 0 marks where the children go
```
Only the first `0` gets the children, in the view and in `getHTML()` alike; later ones stay empty. A `0` inside a void tag (`img`, `hr`, `br`, …) throws, since such a tag cannot have content.
Merge `options.HTMLAttributes` first, with `mergeAttrs(options.HTMLAttributes, { ...dataDriven })`. Data-driven attributes come last, so they win.

### `renderText(node, { options }) => string`
The plain text of your node wherever content turns into text:
- the `text/plain` clipboard flavor;
- moving an inline atom into a text-only block;
- code-block conversion and paste.

Without it, a childless atom has no text and disappears in those places. Example: mention returns `@label`.

`nodeText` and the `text/plain` flavor put `\n` between adjacent textblocks at every depth, so a list or a quote reads as lines. The clipboard HTML wraps blocks the root does not accept in their ancestors (two copied list items go out inside their `<ul>`), and the `application/x-penline-fragment` JSON carries the slice with its open depths (`{ content, openStart, openEnd }`, or a bare array when they are a fragment's, as before). An older penline reader given the object form falls back to the HTML flavor.

### `transformPasted(fragment, ctx, info) => Fragment`
Rewrites pasted or dropped content before it is inserted. `info.at` says where the fragment goes:
- for a drop, the drop point;
- for a paste at a single range, that range;
- for a paste at several ranges, each range in turn, because the hook runs **once per range** and the fragment it returns is inserted at that range only.

When `info.at` is `null`, the fragment goes at the main range. Decide by `info.at ?? mainRange(state.selection)`.

A hook that throws is skipped (the fragment goes on unchanged by it) and the error is logged with `console.error`: the browser's paste is already prevented by then, so it is not lost. With no selection at all, a paste goes to the end of the document.

Example: code block flattens rich content to plain text for the ranges inside a code block, and leaves it rich at the others.

---

## View integration

### `decorations(state, ctx) => Decoration[]`
Visual-only styling that is never stored. It is called on every view update, so keep it fast; cache by node identity when you can.
```ts
{ type: 'inline', from: Point, to: Point, attrs: { class?: string; ... } }     // styles a text range
{ type: 'widget', at: Point, key: string, render: (doc) => HTMLElement }      // inserts a non-editable element
```
Example uses: syntax highlighting, a search-match highlight, the active mention trigger.

A widget's `key` is its identity. While a widget with the same key is decorated, the view keeps the element the first `render` returned: `render` is not called again, even if it would now build something else, and the element moves with `at`. To show new content, use a new key (or update the kept element yourself). Two widgets with the same key in one render: the second gets its own, unkeyed element.

The view marks what it renders for decorations: every widget element gets `data-penline-widget` and every inline decoration span gets `data-penline-deco`. The names are exported as `WIDGET_ATTR` and `DECO_ATTR` from `@penline/core`, to style or find them (in CSS, tests, or a `stopEvent` hook). Never set them yourself.

### `stopEvent(event, node, ctx) => boolean`
For an event inside one of your node views, outside its `contentDOM`. Return `true` to make the editor ignore the event entirely, without handling it or calling `preventDefault`.

For focusable controls (inputs, textareas, buttons) don't use this hook: mark the element `data-editor-ignore` (`IGNORE_ATTR`). That attribute also leaves the element's mutations, focus and selection to it, which `stopEvent` does not.

### `ignoreMutation(record, node, ctx) => boolean`
For a DOM mutation inside one of your node views, outside its `contentDOM`. Without the hook, such mutations are ignored. Return `false` to have the mutation reverted, which rebuilds the node view (a new container and a new instance).

Return `false` only for changes your view did not make itself. A rebuilt view that renders asynchronously (a React portal commits after the rebuild) mutates its new container; if the hook returns `false` for those mutations too, each one rebuilds the view again, which renders again, in an endless loop.

### Editor methods behind the view
The DOM view drives two plugin hooks through public editor methods. A custom view, or a test, calls them the same way:
- `editor.handleDOMEvent(type, event) => boolean` runs the plugins' [`handleDOMEvents`](#handledomevents-keydown-beforeinput-input)`[type]` by priority, and returns `true` when one claimed the event. The view calls it for `keydown`, `beforeinput` and `input` on the root (not for events inside `data-editor-ignore`), and then prevents a claimed `keydown` or `beforeinput`; the method itself never calls `preventDefault`.
- `editor.transformPasted(fragment, at?) => Fragment` runs every plugin's [`transformPasted`](#transformpastedfragment-ctx-info--fragment) by priority with `info.at = at ?? null`, skipping (and logging) one that throws. The core paste and drop intents (`insertFromPaste`, `insertFromDrop` in the core plugin) call it through `parseSliceFromClipboard` once per target range (the drop point for a drop). Call it on any fragment you insert as pasted content.

A headless editor (never mounted) gets no DOM events, so `handleDOMEvents` runs only through `handleDOMEvent`. `transformPasted` runs through `transformPasted`, which the core paste intent (`insertFromPaste` through `editor.handleIntent`) also calls; `insertFragment` and `insertSlice` do not transform their content. The core paste works on a `Slice` (`tr.getSlice`, `tr.insertSlice`): `transformPasted` gets and returns the slice's `content`, and the open depths are clamped to what the returned content supports.

---

## Plugin state and storage

There are two places to keep data that is not in the document:

| | `state` | `storage` |
|---|---|---|
| What | derived from transactions, immutable | an ordinary mutable object you own |
| Changes | `apply(tr, prev, ctx)` returns the next value | you mutate it whenever you like |
| Re-renders React | yes, through `usePluginState` | no |
| Typical | "is the mention popup open, which items" | caches, timers, pending uploads, blob URLs |

### `state: { init(): S; apply(tr, prev, ctx): S }`
- `init` runs once.
- `apply` runs for every committed tr, with the final (normalized) tr, and returns the new state. Return `prev` unchanged when nothing changed. Inside `apply`, `ctx.getState()` still returns `prev`.
- To drive state from a command, set a meta value on the tr (`tr.setMeta('myPlugin', {...})`) and read it in `apply`.

### `storage(ctx) => T`
Creates the plugin's storage once per editor, after all commands are bound. It is available as `ctx.storage` in every other hook and as `editor.storage[name]`. Inside the factory itself `ctx.storage` is still `undefined`. Clean up anything it holds, such as timers or URLs, in `destroy`.

---

## Lifecycle

All lifecycle hooks run in priority order with the same `ctx`. If one throws, the others still run; the first error is rethrown afterwards.

| Hook | When | Notes |
|---|---|---|
| `onCreate(ctx)` | once, at the end of the editor constructor, before any DOM | keep it side-effect-free: an editor can be built and never mounted (a render React discards) |
| `onMount(ctx, view) => cleanup?` | each time a view attaches to a DOM root | use the `view` argument, because `editor.view` is still null here; the cleanup runs on unmount, remount or destroy |
| `onUpdate(ctx, { tr })` | after a committed tr that changed the doc | outside the pipeline, so dispatching here is a normal nested dispatch |
| `onSelectionUpdate(ctx, { tr })` | after a committed tr that changed the selection | same as `onUpdate` |
| `onFocus(ctx, e)` / `onBlur(ctx, e)` | focus enters or leaves the editor root | moves inside the root are not blurs |
| `destroy(ctx)` | on `editor.destroy()`, in reverse priority order | release timers, URLs and listeners |

Two asymmetries:
- Unmounting fires no `onBlur`. Close popups in the `onMount` cleanup as well.
- Mounting on an already-focused root fires no `onFocus`.

---

## The `ctx` object

Most hooks get `ctx: PluginContext`:

| Member | Type | |
|---|---|---|
| `ctx.editor` | `Editor` | the editor: `state`, `commands`, `can()`, `dispatch`, `createTransaction()`, `getJSON()`… |
| `ctx.name` | `string` | this plugin's name |
| `ctx.options` | `O` | current options, read live |
| `ctx.getState()` | `S` | this plugin's state |
| `ctx.storage` | `T` | this plugin's storage; `undefined` before the `storage` factory has run |
| `ctx.commands` | bound `C` | this plugin's own commands, typed and callable: `ctx.commands.toggleHighlight()` |

`ctx.commands` always calls *this* plugin's command, even if a higher-priority plugin registered a command with the same name.

---

## The returned plugin

`definePlugin` returns `{ name, spec, configure, extend }`.

### `plugin.configure(partialOptions)`
Returns a new plugin with the options shallow-merged in.
```ts
const myImage = image.configure({ upload: uploadToS3 })
```

### `plugin.extend(overrides | (parent) => overrides)`
Returns a new plugin whose spec is shallow-merged with your overrides.
- You can override any field except `name`.
- The function form gets the parent spec, so you can wrap the original instead of replacing it.
- Overriding `data`, `commands`, `state` or `storage` changes the corresponding type.

```ts
const myBold = bold.extend((parent) => ({
  keymap: (ctx) => ({ ...parent.keymap?.(ctx), 'Mod-Shift-b': () => ctx.commands.toggleBold() }),
}))
```

---

## Field summary

| Field | Signature (short) | Purpose |
|---|---|---|
| `name` | `string` | identity, document type |
| `priority` | `number` (100) | run order |
| `node` | `{ kind, atom?, default?, content?, group?, marks?, isolating? }` | this plugin is a node |
| `mark` | `{ render(data, { options }) }` | this plugin is a mark |
| `data` | Standard Schema | validates and types stored data |
| `onInvalidData` | `(raw) => Data \| null` | repairs invalid data |
| `options` | `O` | runtime config |
| `commands` | `(ctx) => { name: (...a) => Command }` | API: `editor.commands.x()` |
| `keymap` | `(ctx) => { key: () => boolean }` | keyboard shortcuts |
| `onBeforeInput` | `(intent, ctx) => boolean` | `beforeinput` intents |
| `inputRules` | `{ match, handler }[]` | markdown-like shortcuts while typing |
| `handleDOMEvents` | `{ keydown?, beforeinput?, input? }` | raw events, run first |
| `filterTransaction` | `(tr, state) => boolean` | veto changes |
| `appendTransaction` | `(trs, old, new) => tr \| null` | follow-up changes |
| `normalize` | `([node, path], tr, ctx) => void` | keep invariants |
| `parseHTML` | `ParseRule[]` | HTML → model |
| `renderHTML` | `(node, { options }) => DOMOutputSpec` | model → HTML |
| `renderText` | `(node, { options }) => string` | model → plain text |
| `transformPasted` | `(fragment, ctx, info) => Fragment` | rewrite pasted content |
| `decorations` | `(state, ctx) => Decoration[]` | visual-only highlights and widgets |
| `stopEvent` | `(event, node, ctx) => boolean` | node-view events the editor ignores |
| `ignoreMutation` | `(record, node, ctx) => boolean` | node-view DOM mutations |
| `state` | `{ init, apply }` | derived, reactive plugin state |
| `storage` | `(ctx) => T` | mutable plugin-owned object |
| `onCreate` … `onBlur` | see Lifecycle | lifecycle |
| `destroy` | `(ctx) => void` | cleanup |

For React node views (`nodeViews`, `NodeViewProps`, hooks, parts, `classNames`), see [plugin-authoring.md](plugin-authoring.md).
