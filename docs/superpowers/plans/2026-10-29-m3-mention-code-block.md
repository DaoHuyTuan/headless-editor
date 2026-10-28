# M3: Plugin Guidelines, Mention, Code Block — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Implement the plugin authoring guidelines (spec §5.11): lifecycle hooks, `extend(parent)`, typed own storage/state, `HTMLAttributes`, parts/hooks views.
- Implement the core features Mention and Code block need: inline atoms, input rules, decorations, `coordsAt`, `usePluginState`, non-atom node views with `<NodeContent />`, and history joining for `appendTransaction`.
- Ship `@hte/mention` and `@hte/code-block` written to the guidelines.
- Rework `@hte/image` to the guidelines.

**Architecture:** The core grows its plugin surface while staying framework-free.
- **Lifecycle hooks** run from the Editor and the EditorView. `onMount` returns a cleanup function, like `useEffect`.
- **Decorations** are computed per render from plugin `decorations(state, ctx)` and drawn by the renderer inside leaf spans (inline) or between nodes (widgets). They never touch the doc.
- **Non-atom node views:** the core creates a `contentDOM` element and renders the node's children into it. The React `<NodeContent />` only moves that element into place.
- **Plugin views** are split into headless hooks, parts and a default view that takes `parts` / `classNames`.

**Tech Stack:** as in M2. Syntax highlighting uses `highlight.js` core with a small language set, behind an adapter so it can be swapped.

**Spec:** `docs/superpowers/specs/2026-10-27-headless-editor-design.md`, specifically §5.11 (guidelines), §6.4 (Mention), §6.5 (Code block), §5.7 (decorations, `<NodeContent />`) and §5.9 (`usePluginState`, `coordsAt`). Inputs: `docs/superpowers/m2-followups.md`, section "Start of M3".

## Global Constraints

- All M1 and M2 global constraints still hold:
  - core is framework-free;
  - the public API is the only entry point;
  - document changes go through operations;
  - `data` is JSON;
  - validators are synchronous;
  - plugin logic never imports React;
  - commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **§5.11 is binding:**
  - Every built-in plugin that renders DOM accepts `options.HTMLAttributes` and merges it with `mergeAttrs`.
  - The state attributes `data-selected`, `data-uploading`, `data-active`, `data-open` are present when true and absent otherwise. Each view root carries `data-hte-<plugin>`.
  - React views ship as hooks, then parts, then a default view taking `parts` and `classNames`.
  - Levels 3 and 4 APIs (`parts`, the hooks) are marked `@experimental` in JSDoc.
- Mention `data`: `{ userId: string, label: string }`. Options: `{ fetchUsers: (query: string) => Promise<User[]>, renderUser?, trigger: '@' }`. Here `User = { id: string; label: string; avatar?: string }`.
- Code block `data`: `{ language: string }` (default `'plaintext'`). Content is text only; `\n` is a newline inside the block.
- Code block behaviour (spec §6.5):
  - Tab inserts 2 spaces.
  - Enter inserts `\n`.
  - Pressing Enter three times at the end exits to a new paragraph: the two trailing `\n` are removed.
  - Marks and inline nodes are blocked inside.
  - Paste strips formatting.
  - `<pre><code class="language-x">` round-trips through HTML.
- Mention behaviour (spec §6.4):
  - `@` opens a suggestion popup.
  - While the popup is open, ↑ ↓ Enter Esc go to the popup.
  - The caret jumps over a mention as one character.
  - Backspace or Delete next to a mention deletes it whole.
- E2e runs on Chromium only, on the playground's dedicated port (5174).

## Review Focus

1. **IME composition next to a mention and inside a code block** (Vietnamese, CJK). Text lands where the caret is, never inside the atom. Newlines in the code block are kept and the caret doesn't jump. → Task 5, Task 13, Task 17.
2. **Suggestion races.**
   - Late `fetchUsers` results never reopen a closed popup.
   - Out-of-order responses never show a stale list.
   - Typing a space or moving the caret out of the trigger closes the popup.
   - With the popup closed, ↑ ↓ Enter Esc behave normally.
   → Task 6, Task 11.
3. **Selections that span or touch a mention.**
   - Typing over a selection that includes a mention replaces it.
   - Copy and paste keeps the mention, with a fresh id.
   - Undo restores it.
   - Arrow keys never place the caret inside it.
   → Task 5, Task 17.
4. **Rich content pasted into a code block** becomes plain text with its newlines. Toggling bold or inserting a mention inside a code block does nothing (the command returns false, no mark persists). Copying multi-line code and pasting it into a paragraph keeps the lines. → Task 13.
5. **Customization levels.**
   - Hiding a part, replacing a part, and a custom view built only from hooks all keep correct behaviour: `data-editor-ignore` is applied, resize and alt still work.
   - `extend(parent)` keeps the parent behaviour.
   - `onMount` cleanups run exactly once under StrictMode.
   → Task 1, Task 2, Task 15, Task 17.

---

## File Structure

```
packages/core/src/
  plugin/types.ts, plugin/define.ts   # lifecycle hooks, extend(parent), typed ctx.storage, NodeViewProps storage/state/contentDOM, Decoration, InputRule
  plugin/attrs.ts                     # NEW mergeAttrs
  editor.ts                           # lifecycle dispatch, ctx.storage
  history.ts                          # appended trs join the triggering entry
  view/view.ts                        # onMount/onFocus/onBlur, coordsAt
  view/renderer.ts, view/node-view.ts # contentDOM node views, decorations, mark options invalidation
  view/decorations.ts                 # NEW collect + slice decorations per leaf
  view/dom-selection.ts, view/composition.ts, view/mutation.ts  # contentDOM + inline atoms + decorations
  input-rules.ts                      # NEW input rule runner (in core plugin)
  suggestion.ts                       # NEW findTrigger() helper
  transaction/text.ts, normalize.ts   # inline atoms
packages/react/src/
  node-content.tsx                    # NEW <NodeContent />
  use-plugin-state.ts                 # NEW usePluginState
  customization.ts                    # NEW ViewCustomization<Parts> type + helpers
packages/plugins/image/src/{index.ts,react.tsx → react/*.tsx}
packages/plugins/mention/             # NEW @hte/mention (+ /react)
packages/plugins/code-block/          # NEW @hte/code-block (+ /react, highlight adapter)
apps/playground/                      # toolbar, scenarios, custom-view demo, e2e
```

---

### Task 1: Lifecycle hooks

**Files:**
- Modify: `packages/core/src/plugin/types.ts`, `packages/core/src/editor.ts`, `packages/core/src/view/view.ts`
- Test: `packages/core/test/lifecycle.test.ts`, `packages/core/test/view/lifecycle-view.test.ts`, `packages/react/test/react.test.tsx`

**Interfaces:**
- `PluginSpec` adds the following hooks, all with `ctx: PluginContext<O, S, C>`:
  - `onCreate?(ctx): void`
  - `onMount?(ctx, view: EditorView): void | (() => void)`
  - `onUpdate?(ctx, e: { tr }): void`
  - `onSelectionUpdate?(ctx, e: { tr }): void`
  - `onFocus?(ctx, e: FocusEvent): void`
  - `onBlur?(ctx, e: FocusEvent): void`
- When each hook runs:
  - `onCreate` runs at the end of the Editor constructor, after storage is created, in priority order.
  - `onUpdate` and `onSelectionUpdate` run in priority order, right after the editor emits `update` / `selectionUpdate` for that tr. Listeners attached with `editor.on` run first.
  - The view calls `onMount` for every plugin at the end of its constructor and keeps the returned cleanups. `destroy()` runs them in reverse order.
  - The view adds `focusin` / `focusout` listeners on the root that call `onFocus` / `onBlur`. A focus move between elements inside the root is not a blur.
- A throwing hook does not stop the others: errors are collected and the first is rethrown after all have run, the same pattern as `destroy`.

- [ ] **Step 1: Write the failing tests:**
  - Call order and arguments of every hook.
  - `onMount` cleanup on unmount, and on `mount(other)`.
  - StrictMode in `@hte/react`: exactly one active mount after mount, unmount, mount (count mounts minus cleanups).
  - Focus moving inside the root (into a node view's `data-editor-ignore` input) does not fire `onBlur`.
  - A throwing hook doesn't stop the others.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): plugin lifecycle hooks`.

---

### Task 2: `extend(parent)` and typed own storage/state

**Files:**
- Modify: `packages/core/src/plugin/{types,define}.ts`, `packages/core/src/editor.ts`, `packages/core/src/view/node-view.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/plugin/extend.test.ts`, `packages/core/test/plugin/types.test-d.ts`

**Interfaces:**
- `Plugin.extend` accepts an object, as today, or a function `(parent: Spec) => Partial<Omit<AnyPluginSpec, 'name'>>`. The function form receives the parent spec, so overrides can call `parent.renderHTML!(node, ctx)`, `parent.keymap?.(ctx)` and so on.
  - The result's types must still infer `C`, `S` and `T` from the merged spec.
  - Chained extends see the previous extend as their parent.
- `PluginContext<O, S, C, T>` adds `readonly storage: T`, which is this plugin's own storage. It is `undefined` until the storage factory has run, and that is documented. `storage` and `destroy` receive `C` and `T`; `T` is inferred from `storage`'s return type.
- `NodeViewProps<D, O, T = unknown, S = unknown>` adds `storage: T` and `state: S` (the plugin's current state).
- `NodeViewPropsOf<typeof plugin>` derives the full props type from a plugin.

- [ ] **Step 1: Write the failing tests:**
  - `image.extend((p) => ({ renderHTML: (n, c) => wrap(p.renderHTML!(n, c)) }))` renders the wrapped output.
  - A keymap extend keeps the parent bindings.
  - Chaining twice works.
  - Type tests: `ctx.storage.upload` is typed inside `onBeforeInput`. `NodeViewPropsOf<typeof image>['storage']['isPending']` is typed. The object form of `extend` still compiles.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Remove the casts in `@hte/image` (`storageOf` and `react.tsx`) by using `ctx.storage` and `props.storage`.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): extend(parent) and typed own storage/state`.

---

### Task 3: `HTMLAttributes` convention and mark options

**Files:**
- Create: `packages/core/src/plugin/attrs.ts`
- Modify: `packages/core/src/plugin/types.ts` (`MarkSpec.render(data, ctx: { options })`), `packages/core/src/view/renderer.ts` (mark invalidation on options change), `packages/core/src/html/serialize.ts`, `packages/core/src/view/view.ts`, and plugins `paragraph`, `bold`, `font-size`, `image` (renderHTML / mark.render)
- Test: `packages/core/test/plugin/attrs.test.ts`, plugin tests, `packages/core/test/view/renderer.test.ts`

**Interfaces:**
- `mergeAttrs(base: Attrs, extra?: Attrs): Attrs`, where `Attrs = Record<string, string | number | undefined>`.
  - `class` values are joined with a space and de-duplicated.
  - `style` is merged as CSS declarations, with `extra` winning per property.
  - For any other key, `extra` wins.
  - `undefined` in `extra` removes the key.
  - Exported from `@hte/core`, together with `type HTMLAttributes = Attrs`.
- `MarkSpec.render(data, { options })`.
- After an options change, the renderer re-renders the leaves that carry a mark of that plugin's type (`Renderer.invalidateMark(type)`).
- Built-in plugins add `options.HTMLAttributes: {}` and merge it:
  - paragraph: on `<p>`;
  - bold: on `<strong>`;
  - fontSize: on `<span>`;
  - image: on `<img>`.

- [ ] **Step 1: Write the failing tests:**
  - A `mergeAttrs` table (class join and dedupe, style merge, override, removal).
  - `bold.configure({ HTMLAttributes: { class: 'b' } })` gives `<strong class="b">` in both `getHTML()` and the live DOM.
  - `setPluginOptions('bold', { HTMLAttributes: { class: 'c' } })` updates already-rendered leaves.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): HTMLAttributes convention and mark options`.

---

### Task 4: `appendTransaction` trs join the triggering history entry

**Files:**
- Modify: `packages/core/src/editor.ts` (mark appended trs), `packages/core/src/history.ts`
- Test: `packages/core/test/history.test.ts`

**Interfaces:**
- **Marking.** The Editor marks every appended tr with `meta.appendedTo = 'history' | 'record'`.
  - `'history'` means the root tr of the dispatch was an undo or redo.
  - `'record'` means the root tr was recorded in history.
  - Appended trs whose root was not recorded (`addToHistory: false`) inherit that same handling.
- **History handling:**
  - **`'record'`:** the appended tr's doc ops are concatenated onto the entry just recorded (the top of the undo stack), and that entry's `selectionAfter` becomes the appended tr's selection.
  - **`'history'`:** the appended ops are folded into the entry that just moved between the stacks, so that undo then redo reproduces the same doc. The redo stack must not be cleared.
- **Undo** of a joined entry inverts all of its ops, appended ones included.

- [ ] **Step 1: Write the failing tests:**
  - A test plugin whose `appendTransaction` uppercases the last typed character. Type `a`: the doc shows `A`. One undo leaves an empty doc, with no intermediate `a`. Redo gives `A`.
  - An append fired by undo doesn't clear the redo stack.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): appendTransaction joins history entries`.

---

### Task 5: Inline atoms

**Files:**
- Modify: `packages/core/src/normalize.ts`, `packages/core/src/transaction/{text,fragment}.ts`, `packages/core/src/view/{dom-selection,renderer,composition}.ts`, `packages/core/src/model/editable.ts`
- Test: `packages/core/test/inline-atom.test.ts`, `packages/core/test/view/dom-selection.test.ts`

**Interfaces:**
- **Normalize rule 10:** every inline element in a block with inline content has a text sibling on each side, adding empty texts where needed. Rule 4 must keep those texts.
- **Caret:**
  - A caret never points inside an inline atom.
  - DOM positions inside an inline atom map to the boundary before it, or after it when the DOM offset is past its middle.
  - `writeDomSelection` places the caret in the adjacent text leaves.
- **Deletion:**
  - `deleteBackward` at offset 0 of a text whose previous sibling is an inline atom removes the atom.
  - `deleteForward` at the end of a text whose next sibling is an inline atom removes it.
  - Grapheme and word deletion never cross into an atom.
- **Fragments:** `getFragment` and `insertFragment` keep inline atoms. Their ids are refreshed through the existing unique-id logic.
- **Composition next to an inline atom:** the composing leaf is the text leaf next to the atom. Add a unit test that drives the existing composition module.
- **Commands:** `tr.insertInlineNode(node)` inserts at the caret, replacing the selection, and leaves the caret right after the node. Expose it as the Transaction method `insertInlineNode`.

- [ ] **Step 1: Write the failing tests** (test inline atom `{ name: 'chip', node: { kind: 'inline', atom: true } }`):
  - Loading `p(chip)` gives `p('', chip, '')`.
  - Backspace right after the chip removes it; Delete right before it removes it.
  - A cross-node selection containing the chip is replaced by typing.
  - Copy and paste of a range containing the chip gives a fresh id.
  - DOM↔model mapping round-trips around the chip.
  - Composition after the chip commits into the next text.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, the full suite and e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): inline atoms`.

---

### Task 6: Input rules and trigger helper

**Files:**
- Create: `packages/core/src/input-rules.ts`, `packages/core/src/suggestion.ts`
- Modify: `packages/core/src/plugin/types.ts`, `packages/core/src/core-plugin.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/input-rules.test.ts`, `packages/core/test/suggestion.test.ts`

**Interfaces:**
- **`InputRule`:** `{ match: RegExp; handler: (ctx, match: RegExpMatchArray, range: Range, tr: Transaction) => boolean }`.
  - After the core inserts text from an `insertText` intent (not composition, not paste), the input rules of all plugins run in priority order.
  - Each rule is matched against the text of the current block from its start to the caret. The regex must be anchored with `$`.
  - The first handler that returns true has its changes applied in the same tr.
  - Undo right after a rule fired reverts the rule's change first, leaving the typed text. Implement this by recording the rule application as a separate history entry with `kind: 'other'`.
- **`findTrigger(state, { char, allowSpaces = false }): { range: Range; query: string } | null`:**
  - Finds the trigger character before a collapsed caret within the same text run, at the start of a line or after whitespace.
  - The query is the text between the trigger and the caret. With `allowSpaces` false, a space ends the match.

- [ ] **Step 1: Write the failing tests:**
  - A rule `/^-- $/` replaces `-- ` with `— ` (em dash). After it fires, one undo shows `-- `.
  - Rules don't fire on paste or during composition.
  - `findTrigger` cases: `'hi @jo|'` gives the query `jo`; `'mail@x|'` gives null (no space before); `'@jo hn|'` gives null; a caret not collapsed gives null; a trigger inside a code block is still found, since plugins decide.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): input rules and trigger helper`.

---

### Task 7: Decorations

**Files:**
- Create: `packages/core/src/view/decorations.ts`
- Modify: `packages/core/src/plugin/types.ts`, `packages/core/src/view/{renderer,dom-selection,composition,mutation,view}.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/view/decorations.test.ts`

**Interfaces:**
- **Types:**
  - `type Decoration = InlineDecoration | WidgetDecoration`.
  - `InlineDecoration = { type: 'inline'; from: Point; to: Point; attrs: { class?: string; [k: string]: string | undefined } }`.
  - `WidgetDecoration = { type: 'widget'; at: Point; key: string; render: (doc: Document) => HTMLElement }`.
- **Plugin hook:** `decorations?(state: EditorState, ctx): Decoration[]`, computed on every view update.
- **Inline decorations:**
  - Each leaf's text is split into segments at decoration boundaries. Each segment that a decoration covers is wrapped in `<span data-hte-deco …attrs>`, nested *inside* the mark wrappers.
  - The renderer's leaf reuse check includes the leaf's decoration signature.
  - DOM↔model mapping must count text across the segments; the existing "sum texts in the leaf" logic should already hold, so verify it.
- **Widget decorations:** inserted as `contenteditable="false"` elements before the leaf position. They are keyed by `key`, so a widget is reused across renders. They are never part of the model, and the mutation observer ignores changes inside them.
- **Composition:** while composing, the composing leaf keeps its DOM as it is; decorations apply on the next render.

- [ ] **Step 1: Write the failing tests:**
  - An inline decoration over `b–d` in `abcde` gives `a<span data-hte-deco class="x">bcd</span>e` inside the leaf.
  - Bold plus a decoration nest correctly.
  - The caret round-trips inside a decorated segment.
  - Changing decorations doesn't rebuild an unchanged leaf.
  - A widget renders at its position, is reused by key, and is absent from `getJSON()` / `getHTML()`.
  - A mutation inside a widget is ignored.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, the full suite and e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): decorations`.

---

### Task 8: `coordsAt` and `usePluginState`

**Files:**
- Modify: `packages/core/src/view/view.ts`, `packages/core/src/editor.ts`
- Create: `packages/react/src/use-plugin-state.ts`
- Modify: `packages/react/src/index.ts`
- Test: `packages/core/test/view/coords.test.ts`, `packages/react/test/use-plugin-state.test.tsx`

**Interfaces:**
- `EditorView.coordsAt(point: Point): { left; top; bottom } | null`. It uses a DOM Range at `modelToDom(point)` and takes `getBoundingClientRect` (the first client rect for a collapsed range). The result is in viewport coordinates.
- `editor.coordsAt(point)` delegates to the view and returns null when unmounted.
- `usePluginState<P extends AnyPlugin>(editor, plugin: P): StateOf<P>` is typed and re-renders only when that plugin's state object changes identity. Use `useEditorState` with `Object.is`.

- [ ] **Step 1: Write the failing tests:**
  - `coordsAt` with a stubbed `Range.getBoundingClientRect` in happy-dom.
  - `coordsAt` returns null when unmounted.
  - `usePluginState` updates when the plugin state changes and not on unrelated transactions.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: coordsAt and usePluginState`.

---

### Task 9: Non-atom node views with `contentDOM` and `<NodeContent />`

**Files:**
- Modify: `packages/core/src/plugin/types.ts` (`NodeViewProps.contentDOM?: HTMLElement`), `packages/core/src/editor.ts` (drop the M3 throw), `packages/core/src/view/{renderer,node-view,dom-selection,composition,mutation,ignore}.ts`
- Create: `packages/react/src/node-content.tsx`
- Modify: `packages/react/src/index.ts`
- Test: `packages/core/test/view/content-dom.test.ts`, `packages/react/test/node-content.test.tsx`

**Interfaces:**
- **Core side.** For a non-atom node with a node view:
  - The renderer creates the container as before, but without `contenteditable="false"` on it.
  - It also creates `contentDOM = <div data-hte-content contenteditable="true">` (a `<span>` for inline nodes) and passes it in the props.
  - It renders the node's children into `contentDOM` as a normal holder.
  - The view is responsible for placing `contentDOM` inside its own DOM.
  - Every element the view renders outside `contentDOM` must be marked `contenteditable="false"`, or `data-editor-ignore` for controls.
- **Event and mutation handling:**
  - Events and mutations inside `contentDOM` are editor content, handled as usual.
  - Everything else inside the container follows the atom node-view rules (ignored by default; `stopEvent` / `ignoreMutation` apply).
- **React side.** `<NodeContent as?: 'div' | 'span' className? />` renders a placeholder element and, in a layout effect, appends `props.contentDOM` into it.
  - It must be rendered exactly once per node view.
  - In dev mode it warns if the view rendered without `<NodeContent />` after the first commit.
- **Selection and composition** inside `contentDOM` work exactly as in a normal block.

- [ ] **Step 1: Write the failing tests:**
  - **Core** (test plugin `box`, a non-atom block, with a factory that wraps `contentDOM` in a `<section>` with a header `<div contenteditable=false>`):
    - Typing inside `box` edits its text.
    - The header is not editable and its mutations are ignored.
    - The selection round-trips inside it.
    - Removing the node destroys the view.
  - **React:** a `NodeContent`-based view under StrictMode has no console errors, moves `contentDOM` exactly once, and keeps typed content across re-renders.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, the full suite and e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat: non-atom node views with NodeContent`.

---

### Task 10: View customization helpers (React)

**Files:**
- Create: `packages/react/src/customization.ts`
- Modify: `packages/react/src/index.ts`
- Test: `packages/react/test/customization.test.tsx`

**Interfaces:**
- **Types** (both marked `@experimental`):
  - `type PartsOverride<Parts extends Record<string, ComponentType<any>>> = { [K in keyof Parts]?: Parts[K] | false }`.
  - `interface ViewCustomization<Parts> { parts?: PartsOverride<Parts>; classNames?: { [K in keyof Parts | 'root']?: string } }`.
- **`resolveParts(defaults, overrides)`** returns the component for each part, or null when the part is hidden.
- **`dataAttrs(flags: Record<string, boolean | undefined>)`** maps `{ selected: true, open: false }` to `{ 'data-selected': '' }`, so absent flags stay absent.

- [ ] **Step 1: Write the failing tests** (type tests and runtime):
  - `parts: { x: false }` hides the part.
  - A replacement component receives the part's `className`.
  - `dataAttrs` drops false flags.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(react): view customization helpers`.

---

### Task 11: `@hte/mention` logic

**Files:**
- Create: `packages/plugins/mention/{package.json,tsconfig.json,src/index.ts}` (mirror `@hte/image`: deps `@hte/core`, `zod`)
- Test: `packages/plugins/mention/test/mention.test.ts`

**Interfaces:**
- The plugin:
  ```ts
  mention = definePlugin({
    name: 'mention', priority: 150,
    node: { kind: 'inline', atom: true },
    data: z.object({ userId: z.string().min(1), label: z.string() }),
    options: { fetchUsers: (q: string) => Promise<User[]>, renderUser: undefined as ((u: User) => string) | undefined,
               trigger: '@', HTMLAttributes: {} },
    state: { init: () => ({ open: false, query: '', range: null, items: [], index: 0, requestId: 0 }), apply: … },
    commands: () => ({ insertMention: (user: User) => …, closeSuggestion: () => …, moveSuggestion: (delta: 1|-1) => …,
                       acceptSuggestion: () => … }),
    handleDOMEvents: { keydown: (e, ctx) => /* when open: ArrowUp/ArrowDown/Enter/Escape → commands, preventDefault, return true */ },
    storage: (ctx) => ({ /* fetch coordination */ }),
    onUpdate / onSelectionUpdate: (ctx) => /* recompute trigger via findTrigger; when query changed → fetch */,
    parseHTML: [{ tag: 'span[data-mention]', getData: (el) => ({ userId: el.dataset.id ?? '', label: (el.textContent ?? '').replace(/^@/, '') }) }],
    renderHTML: (node, { options }) => ['span', mergeAttrs({ 'data-mention': '', 'data-id': node.data.userId }, options.HTMLAttributes), `@${node.data.label}`],
    decorations: (state, ctx) => /* inline decoration class 'hte-mention-query' over the open trigger range */,
  })
  ```
- **Suggestion state** changes only through trs that carry meta `mention`, with these actions: `open` (range, query), `results` (requestId, items), `move`, `close`.
- **Fetch coordination:**
  - Each query change increments `requestId` and calls `fetchUsers`.
  - Results are applied only if `requestId` still matches and the popup is still open.
  - Rejections close the popup quietly.
- **`acceptSuggestion` / `insertMention(user)`:**
  1. Replace the trigger range (`@query`) with the mention node.
  2. Insert a space after it.
  3. Close the popup.
- **Closing rules:** Esc closes, and so does the caret leaving the trigger range. A closed trigger stays closed until the user types `@` again: track a `dismissedAt` range.

- [ ] **Step 1: Write the failing tests** (fake `fetchUsers` with controllable deferreds):
  - Typing `@jo` opens the popup with `query: 'jo'` and calls fetch with `'jo'`.
  - Results fill `items`.
  - ArrowDown moves `index`, Enter inserts the mention as `@Label`, adds the space and closes the popup.
  - Esc closes, and typing more doesn't reopen until a new `@`.
  - Review Focus 2:
    - Out-of-order results: the response to `j` arriving after the response to `jo` is ignored.
    - Results arriving after Esc: the popup stays closed.
    - Space closes the popup.
    - With the popup closed, Enter splits the block normally.
  - Parse and render round-trip; `HTMLAttributes` merge.
  - `renderUser` is not used for HTML export (the label snapshot is used).
- [ ] **Step 2:** Run `pnpm vitest run packages/plugins/mention`. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `pnpm install`.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mention): mention plugin logic`.

---

### Task 12: `@hte/mention/react`

**Files:**
- Create: `packages/plugins/mention/src/react.tsx` (or `src/react/*.tsx`), exported as `"./react"` with the same optional peers as image
- Test: `packages/plugins/mention/test/react.test.tsx`

**Interfaces:**
- **Hooks** (`@experimental`):
  - `useMention(props) → { label, user }`. `user` comes from the `renderUser` / fetch cache when available, and `label` falls back to `data.label`.
  - `useSuggestion(editor) → { open, items, index, coords, select(i), close(), listProps, itemProps(i) }`. `coords` come from `editor.coordsAt(range.from)`, and the hook re-renders through `usePluginState`. `listProps` includes `role="listbox"`; `itemProps` includes `role="option"`, `aria-selected`, and `onMouseDown` that selects and prevents focus loss.
- **Parts:**
  - `Mention.Root` (`<span data-hte-mention data-selected?>`) and `Mention.Label`.
  - `Suggestion.Popup` (positioned with `position: fixed` at `coords`, rendered through a portal to `document.body`), `Suggestion.List`, `Suggestion.Item`.
- **Default views:**
  - `MentionView(props & ViewCustomization<{ label }>)`.
  - `<MentionSuggestion editor renderItem? {...ViewCustomization<{ popup, list, item }>} />`, which the app renders once next to `EditorContent`.

- [ ] **Step 1: Write the failing tests** (StrictMode, no `console.error`):
  - The view shows the live label from `renderUser`; a renamed user updates without a doc change.
  - The popup appears at the stubbed coords with the items.
  - Clicking an item inserts the mention and the editor keeps focus.
  - `parts: { label: false }` hides the label; `classNames` are applied.
  - ARIA roles are present.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mention): React mention view and suggestion popup`.

---

### Task 13: `@hte/code-block` logic

**Files:**
- Create: `packages/plugins/code-block/{package.json,tsconfig.json,src/index.ts,src/highlight.ts}` (deps `@hte/core`, `zod`, `highlight.js`)
- Test: `packages/plugins/code-block/test/code-block.test.ts`

**Interfaces:**
- **Highlight adapter:**
  - `highlight.ts` exports `type Highlighter = (code: string, language: string) => { from: number; to: number; className: string }[]`.
  - `defaultHighlighter` uses `highlight.js/lib/core` with `javascript`, `typescript`, `json`, `css`, `xml`, `python` and `bash` registered. Unknown languages produce no tokens.
  - Token offsets are UTF-16 offsets into the block's text.
- **The plugin:**
  ```ts
  codeBlock = definePlugin({
    name: 'codeBlock', priority: 150,
    node: { kind: 'block', content: 'text' },
    data: z.object({ language: z.string().regex(/^[a-z0-9+#-]*$/i).default('plaintext') }),
    options: { highlighter: defaultHighlighter as Highlighter, languages: ['plaintext','javascript','typescript','json','css','html','python','bash'], HTMLAttributes: {} },
    commands: () => ({ setCodeBlock: (language?) => …, setLanguage: (language) => …, exitCodeBlock: () => … }),
    keymap: (ctx) => ({ Tab: …, 'Shift-Tab': …, Enter: …, 'Mod-Enter': () => ctx.commands.exitCodeBlock(), Backspace: … }),
    filterTransaction: (tr) => /* reject trs that add_mark on a text inside a code block, or insert an inline element into one */,
    transformPasted: (fragment, ctx) => /* caret inside a code block → one plain text node, blocks joined by '\n' */,
    parseHTML: [{ tag: 'pre', getData: (el) => ({ language: /language-([\w+#-]+)/.exec(el.querySelector('code')?.className ?? '')?.[1] ?? 'plaintext' }) }],
    renderHTML: (node, { options }) => ['pre', mergeAttrs({}, options.HTMLAttributes), ['code', { class: `language-${node.data.language}` }, 0]],
    decorations: (state, ctx) => /* per code block: highlighter(text, language) → inline decorations with class `hljs-*` */,
  })
  ```
- **Keymap behaviour, only when the caret is in a code block:**
  - **Tab** inserts two spaces at the caret. With a selection spanning lines, it indents each line.
  - **Shift-Tab** removes up to two leading spaces from each selected line.
  - **Enter** inserts `\n`. When the block's text ends with `\n\n` and the caret is at the end, it removes those two newlines and inserts a paragraph after the block (exit).
  - **Backspace** at offset 0 of an empty code block turns it into a paragraph.
- **`setCodeBlock`:** a paragraph type change needs a type-changing op, which doesn't exist. Instead, implement it by replacing the block: insert a code block with the paragraph's text after it, remove the paragraph, and keep the caret offset. Document this.
- **Bold inside a code block:** `toggleBold` returns false because `filterTransaction` rejects the tr, and no mark persists.
- **`isActive('bold')`** is false inside a code block.
- **IME inside a code block** works like in any text block. Add a unit test through the composition module.

- [ ] **Step 1: Write the failing tests:**
  - Tab, Shift-Tab, Enter, triple Enter exit, Backspace on an empty block, `Mod-Enter`.
  - Review Focus 4:
    - Pasting HTML `<p>a<b>b</b></p><p>c</p>` inside a code block gives the text `ab\nc`, with no marks.
    - `toggleBold` inside returns false.
    - `insertMention` inside is rejected.
    - Copying `x\ny` from a code block and pasting it into a paragraph gives two paragraphs.
  - HTML round-trip with the language.
  - Unsafe language string rejected by the schema.
  - Decorations for `const a = 1` in javascript include a keyword token over `const`; `plaintext` has none.
  - `setCodeBlock` from a paragraph keeps the text and the caret.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `pnpm install`.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(code-block): code block plugin logic`.

---

### Task 14: `@hte/code-block/react`

**Files:**
- Create: `packages/plugins/code-block/src/react.tsx`, plus a `"./react"` export with optional peers
- Test: `packages/plugins/code-block/test/react.test.tsx`

**Interfaces:**
- Hook (`@experimental`): `useCodeBlock(props) → { language, languages, setLanguage(l), selectProps }`. `selectProps` includes `data-editor-ignore`, `value` and `onChange`, which calls `updateData`.
- Parts:
  - `CodeBlock.Root` (`<div data-hte-code-block>`);
  - `CodeBlock.Toolbar` (`contenteditable=false`);
  - `CodeBlock.LanguageSelect`;
  - `CodeBlock.Content`, which renders `<pre><code><NodeContent as="span"/></code></pre>` or an equivalent that keeps whitespace.
- Default view: `CodeBlockView(props & ViewCustomization<{ toolbar, languageSelect, content }>)`.

- [ ] **Step 1: Write the failing tests** (StrictMode, no `console.error`):
  - Typing inside the content edits the text.
  - Changing the select updates `language` in one undo step, and the editor's caret doesn't jump.
  - Highlight classes appear in the DOM.
  - `parts: { toolbar: false }` hides the toolbar.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(code-block): React code block view`.

---

### Task 15: Rework `@hte/image` to the guidelines

**Files:**
- Modify: `packages/plugins/image/src/react.tsx` → `src/react/{index.tsx,hooks.ts,parts.tsx}`, and `packages/plugins/image/src/index.ts` (`HTMLAttributes` done in Task 3; casts removed in Task 2)
- Test: `packages/plugins/image/test/react.test.tsx` (keep every existing test passing; add customization tests)

**Interfaces:**
- **Hooks** (`@experimental`):
  - `useImageResize(props) → { width, handleProps }`. `handleProps` includes `data-editor-ignore` and `touchAction: 'none'`.
  - `useAltDraft(props) → { inputProps }`. `inputProps` includes `data-editor-ignore` and `aria-label`.
  - `useImageState(props) → { selected, uploading }`.
- **Parts:** `Image.Root` (`<figure data-hte-image data-selected? data-uploading?>`, which provides the context the resize hook needs to measure), `Image.Img`, `Image.AltInput` and `Image.ResizeHandle`.
- **Default view:** `ImageView(props & ViewCustomization<{ img, altInput, resizeHandle }>)`.
- **Breaking change:** the old classes `hte-image` and `hte-image-resize` are replaced by `data-*` attributes plus `classNames`. Update the playground CSS.

- [ ] **Step 1: Write the failing tests:**
  - `parts: { altInput: false }` has no input, while resize still works.
  - A replacement `resizeHandle` built with `Image.ResizeHandle` still resizes.
  - A custom view built only from the three hooks supports alt edit, resize and the uploading flag, and its controls carry `data-editor-ignore` without the author adding it (Review Focus 5).
  - `classNames` are applied.
  - `extend((p) => ({ renderHTML: … p.renderHTML … }))` keeps the src policy.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `refactor(image): hooks, parts and customizable view`.

---

### Task 16: Plugin authoring docs

**Files:**
- Create: `docs/plugin-authoring.md` (English). It is a guide built around worked examples:
  - customization levels 0–5, using Image;
  - writing a new plugin with logic, hooks, parts and a view (a small `callout` example, documentation only);
  - the lifecycle hook table;
  - `extend(parent)`;
  - the stable `data-*` attributes of every built-in plugin.
- Modify: each plugin's `src/index.ts` header JSDoc, to list its `data-*` attributes and its parts.

- [ ] **Step 1:** Write the doc. The code samples must compile: add `packages/core/test/docs-examples.test-d.ts`, which imports the snippets as functions.
- [ ] **Step 2:** Run `pnpm vitest --typecheck run`. Expected: PASS.
- [ ] **Step 3:** Commit `docs: plugin authoring guide`.

---

### Task 17: Playground and e2e

**Files:**
- Modify: `apps/playground/src/*`, `apps/playground/package.json`
- Create: `apps/playground/e2e/{mention.spec.ts,code-block.spec.ts,customization.spec.ts}`

**Interfaces:**
- **Plugins:** `[paragraph, bold, fontSize, image, mention, codeBlock]`. `nodeViews` hold image, mention and codeBlock. `<MentionSuggestion>` is rendered next to `EditorContent`. `fetchUsers` is a fake over 6 users with a 150 ms delay; with `?slowUsers=1` the delay is randomised between 50 and 400 ms, for the race test.
- **Toolbar:** a "Code" button (`setCodeBlock` / `exitCodeBlock`).
- **Scenarios:** `mention` (text with two mentions), `codeBlock` (a JS snippet), `customImage` (the same image doc rendered with a custom view: a scenario toggle swaps `nodeViews.image` to a hooks-only view).
- **e2e specs:**
  - **mention:**
    - Type `@an`, ArrowDown, Enter → a mention in the JSON, the caret after the space.
    - Esc closes.
    - Backspace after a mention removes it whole.
    - ArrowLeft and ArrowRight jump over it.
    - A selection spanning it is replaced by typing.
    - IME composition right after it (CDP).
    - `?slowUsers=1`: typing `@a` then `@an` quickly never shows the stale list.
  - **code block:**
    - Toggle the code block, type two lines with Enter, Tab indents, triple Enter exits.
    - Bold does nothing inside.
    - Paste rich HTML gives plain text.
    - Highlight classes appear.
    - IME inside (CDP).
  - **customization:** the `customImage` scenario has a working alt edit and resize, and no `pageerror`.
  - All existing specs keep passing.
- [ ] **Step 1:** Write the specs and see them fail.
- [ ] **Step 2:** Implement the playground changes.
- [ ] **Step 3:** Run `pnpm --filter playground e2e` (also with `--repeat-each=3` on the new specs), `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 4:** Commit `feat(playground): mention, code block, customization demo`.

---

### Task 18: M3 verification

- [ ] **Step 1:** Run `pnpm typecheck && pnpm test && pnpm vitest --typecheck run && pnpm --filter playground e2e`. Expected: all pass.
- [ ] **Step 2:** Run `grep -rE "from ['\"]react" packages/core/src packages/plugins/*/src/index.ts`. Expected: no matches. Run the deep-import grep from M2. Expected: no matches.
- [ ] **Step 3:** In `docs/superpowers/m2-followups.md`, check off the items M3 closed. Move anything still open to an M4 section.
- [ ] **Step 4:** Commit `chore: M3 verification`.

---

## Deferred

- **M4:** Firefox and WebKit.
- **After M3** (spec §5.11): decide whether the levels 3–4 (`parts`, hooks) APIs graduate from `@experimental`.
- **Kept open from `m2-followups.md` "Start of M3"** (planner's call: no M3 plugin needs them, and each is a separate core change):
  - mapping the history stacks through outside-history structural changes instead of clearing them;
  - moving clipboard parse/serialize into `content/`;
  - making text pasted over a node selection behave like typing over it.

  They move to the M4 section of the follow-ups in Task 18.
- **Not planned:**
  - a generic mechanism for one plugin to intercept another plugin's hooks (spec §5.11);
  - internal drag-move of content.
