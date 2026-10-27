# M2: Font Size, Image, Node Views — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `@hte/font-size` mark plugin and the `@hte/image` block-atom plugin, with everything they need from the engine: node views rendered by framework components, node selection for atom blocks, plugin storage, option changes that re-render, data-only history rewrites for async upload, and paste/drop through the intent pipeline. This milestone also clears the "Start of M2" items from `docs/superpowers/m1-followups.md`.

**Architecture:** The engine stays framework-independent.
- **Node views.** A node view is a factory the adapter registers per node type. The core creates a container for each instance, calls the factory, and later calls `update` and `destroy` on it. The React adapter turns components into factories and renders them through portals.
- **Node selection.** An optional `node` path is added to `Selection`. `anchor` and `focus` stay valid carets, so code that ignores node selection still works.
- **Image upload.** It is coordinated by plugin state (pending uploads) and plugin storage (an imperative API). History learns to rewrite node data by element id instead of clearing its stacks.

**Tech Stack:** As in M1. pnpm, TypeScript strict ESM, Vitest + happy-dom, Playwright (Chromium), React 19, zod (in plugin packages).

**Spec:** `docs/superpowers/specs/2026-10-27-headless-editor-design.md`. This plan covers milestone **M2** (§9), the plugins in §6.2 and §6.3, and the node-view, node-selection and option parts of §5.3 and §5.5–§5.9. The input list for this plan is `docs/superpowers/m1-followups.md`, section "Start of M2".

## Global Constraints

- Everything from the M1 plan still applies:
  - `@hte/core` has no UI-framework dependency.
  - The only entry points are `@hte/core` and `@hte/core/testing`.
  - Plugins use only the public API.
  - Every document change goes through operations.
  - `data` is plain JSON.
  - Validators are synchronous Standard Schema.
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Plugin logic never imports React** (spec §5.5). Each plugin package splits into two entries:
  - `@hte/<plugin>` holds the logic.
  - `@hte/<plugin>/react` holds the view and lists `react` as a peer dependency.
- Image `data`: `{ src: string, alt: string (default ''), width?: number }` (spec §6.3).
- Image options: `{ upload: (file: File) => Promise<string>, onUploadError?: (error: unknown, file: File) => void }` (spec §6.3).
- Font-size `data`: `{ size: string }`, for example `"18px"` (spec §6.2).
- Async upload (spec §6.3):
  1. The node is inserted immediately with a blob URL `src`, as one normal undo step.
  2. Pending uploads live in plugin state, keyed by node `id`.
  3. On success, `src` is replaced with `addToHistory: false`, and history rewrites the stored payloads so undo and redo never bring back the blob URL.
  4. On failure, the node is removed outside history and `onUploadError` is called.
  5. The app checks progress with `editor.storage.image.isUploading()` or waits on `editor.storage.image.whenIdle()`.
- Elements inside a node view that carry `data-editor-ignore` are fully ignored by the core: events, selection and mutations (spec §5.5).
- M2 e2e runs on Chromium only.
- **Not in M2:**
  - non-atom node views and `<NodeContent />` (M3, code block);
  - `inputRules`, decorations, popups (M3);
  - `appendTransaction` joining history entries (M3, the first plugin that uses it);
  - Firefox and WebKit (M4).

## Review Focus

1. **Upload resolves after the user deleted or undid the image.** No error is thrown, the image does not reappear, and redo restores the image with the uploaded URL if the upload already finished. Otherwise redo restores the blob URL, which is later rewritten when the upload resolves. → Task 9, Task 11.
2. **Typing while an image is node-selected.** The image is replaced by a paragraph holding the typed text. Enter inserts an empty paragraph after the image. Backspace or Delete removes the image. None of these throws or leaves the caret inside the atom. → Task 7.
3. **Editing the image's alt text in the `<input>`.** Keystrokes reach the input. The editor does not intercept them (no `preventDefault`), the model selection does not jump, the mutation observer does not revert anything, and the alt is committed to `data` through `updateData`. → Task 8, Task 13.
4. **Pasting or dropping a non-image file, or a mix of image and text.** Non-image files are ignored and images are uploaded. When at least one image file is present, the text and HTML flavours are ignored; otherwise the text is inserted. Nothing throws, and no stray DOM is left. → Task 10, Task 11.
5. **The React view unmounts when the image node is removed** (delete or undo). The portal is removed and there is no React warning about updating an unmounted component, even if an upload resolves afterwards. → Task 12.

---

## File Structure

```
packages/core/src/
  plugin/types.ts            # + PluginContext.commands, storage, stopEvent, ignoreMutation, NodeView types
  plugin/registry.ts         # (unchanged API) used by node view lookup
  editor.ts                  # + ctx.commands, storage, 'options' event, nodeViews option, getPluginOptions copy
  model/types.ts             # Selection.node?
  model/editable.ts          # + nodeSelection(), selectableAtom helpers
  model/find.ts              # NEW findPathById(doc, id)
  ops/transform.ts           # transformSelection maps `node`
  transaction/transaction.ts # setSelection equality incl. node; insertBlockNode(); insertNode validates
  transaction/text.ts        # node-selection behaviours; deleteRange opaque guard
  transaction/fragment.ts    # getFragment for node selection
  content/sanitize.ts        # NEW sanitizeFragment (moved from view/clipboard.ts)
  normalize.ts               # rule 9 hoists atom blocks
  history.ts                 # data-only addToHistory:false rewrite
  core-plugin.ts             # insertFromPaste / insertFromDrop defaults; insertContent sanitized
  view/renderer.ts           # node view containers, invalidate(type), selected marker
  view/node-view.ts          # NEW NodeViewHost (lifecycle, props)
  view/dom-selection.ts      # node selection read/write
  view/view.ts               # options re-render, event/selection ignore helpers, node-select module
  view/ignore.ts             # NEW isIgnoredTarget(view, node), stopEvent dispatch
  view/node-select.ts        # NEW click-to-select atoms
  view/input.ts, clipboard.ts, mutation.ts, composition.ts  # honour ignore/stopEvent/ignoreMutation
  view/drop.ts               # NEW drop → insertFromDrop intent; internal dragstart prevented
packages/react/src/
  node-views.tsx             # NEW portal store, toNodeViewFactory, ReactNodeViewProps
  use-editor.ts              # + nodeViews, pluginOptions
  editor-content.tsx         # renders portals
packages/plugins/font-size/  # NEW @hte/font-size
packages/plugins/image/      # NEW @hte/image (src/index.ts logic, src/react.tsx view)
apps/playground/             # toolbar, fake upload, scenarios, e2e
```

---

### Task 1: Plugin context gets its own typed commands

**Files:**
- Modify: `packages/core/src/plugin/types.ts`, `packages/core/src/editor.ts`, `packages/plugins/bold/src/index.ts`
- Test: `packages/core/test/editor.test.ts`, `packages/core/test/plugin/types.test-d.ts`, `packages/plugins/bold/test/bold.test-d.ts`

**Interfaces:**
- Produces:
  - `PluginContext<O, S, C extends CommandMap = NoOptions>` gains `readonly commands: BoundCommands<C>` (move `BoundCommands` into `plugin/types.ts` and re-export it from `editor.ts`).
  - In `PluginSpec`, `keymap`, `onBeforeInput`, `handleDOMEvents`, `transformPasted`, `normalize`, `state.apply` and the new hooks of later tasks receive `PluginContext<O, S, C>`.
  - `commands` itself still receives `PluginContext<O, S>`, with no `C`, to avoid circular inference.
  - At runtime, `ctx.commands.x(...)` runs the plugin's own command factory `x` exactly like `editor.commands.x`: a fresh tr with origin `'command'`, dispatched when it applies. This is true even when a higher-priority plugin registered a command with the same name.

- [ ] **Step 1: Write the failing tests.**
  - Runtime: a plugin whose keymap calls `ctx.commands.mine()` dispatches its own command.
  - A name clash test: plugin A (priority 200) and plugin B (default 100) both define `go`. B's `ctx.commands.go()` runs B's factory, while `editor.commands.go()` runs A's.
  - Type test: inside `keymap: (ctx) => …`, `ctx.commands.mine` is `() => boolean`, and `// @ts-expect-error ctx.commands.nope()`.
  - The bold test passes with the cast helper removed from `@hte/bold`: `runKeymap('Ctrl-b')` and the `formatBold` intent still toggle bold.
- [ ] **Step 2:** Run `pnpm vitest run packages/core/test/editor.test.ts` and `pnpm vitest --typecheck run packages/core/test/plugin packages/plugins/bold`. Expected: FAIL.
- [ ] **Step 3:** Implement the change. Remove the cast helper from `@hte/bold`: `keymap: (ctx) => ({ 'Mod-b': () => ctx.commands.toggleBold() })`, and the same in `onBeforeInput`.
- [ ] **Step 4:** Run the same commands plus `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): typed own commands on plugin context`.

---

### Task 2: Plugin option changes re-render

**Files:**
- Modify: `packages/core/src/editor.ts`, `packages/core/src/view/renderer.ts`, `packages/core/src/view/view.ts`
- Test: `packages/core/test/editor.test.ts`, `packages/core/test/view/renderer.test.ts`, `packages/core/test/view/view.test.ts`

**Interfaces:**
- Produces:
  - A separate overload `editor.on('options', fn: (e: { editor: Editor; plugin: string }) => void): () => void`. The existing `EditorEvent` (with `tr: Transaction`) is unchanged.
  - `setPluginOptions(name, partial)` emits `'options'`.
  - `getPluginOptions(name)` now returns a shallow frozen copy (followup).
  - `Renderer.invalidate(type: string): void` marks every rendered element of that type so the next `render` rebuilds its shell. Once Task 8 adds node views, it updates the node view instead.
  - `EditorView` listens to `'options'`, calls `renderer.invalidate(type)` for the node type the plugin registers (if any), then calls `update(state)`.
  - Mark rendering depends on data only (`MarkSpec.render(data)`): document this in the `MarkSpec` JSDoc. Mark plugins have no invalidation.

- [ ] **Step 1: Write the failing tests.**
  - The test node plugin's `renderHTML` uses `ctx.options.className`. After `setPluginOptions('x', { className: 'b' })`, the mounted DOM shows class `b`, and the element's DOM is rebuilt while its children's DOM is reused.
  - Mutating `getPluginOptions()`'s result has no effect on the stored options.
  - An `'options'` listener receives `plugin: 'x'`.
- [ ] **Step 2:** Run the three test files. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): re-render on plugin option changes`.

---

### Task 3: Plugin storage

**Files:**
- Modify: `packages/core/src/plugin/types.ts`, `packages/core/src/editor.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/editor.test.ts`, `packages/core/test/editor.test-d.ts`

**Interfaces:**
- Produces:
  - `PluginSpec` adds the type parameter `T` (storage) with default `undefined`:
    - `storage?: (ctx: PluginContext<O, S, C>) => T`, created once per editor after the commands are bound;
    - `destroy?: (ctx: PluginContext<O, S, C>) => void`, called by `editor.destroy()` in reverse priority order.
  - `StorageOf<P extends readonly AnyPlugin[]>` maps each plugin's name to its `T`, skipping plugins without storage.
  - `Editor.storage: StorageOf<EditorPlugins<P>>` is a plain object keyed by plugin name.
  - `definePlugin` infers `T`. `OptionsOf`, `DataOf`, `StateOf` and `CommandsOfPlugin` keep working; add `StorageOfPlugin<T>`.

- [ ] **Step 1: Write the failing tests.**
  - `editor.storage.counter.count()` reads plugin state through ctx.
  - `destroy` hooks run on `editor.destroy()`.
  - Type test: `editor.storage.counter.count` is typed, and `// @ts-expect-error editor.storage.nope`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests, including `pnpm vitest --typecheck run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): plugin storage and destroy hook`.

---

### Task 4: Sanitize and validate programmatic content

**Files:**
- Create: `packages/core/src/content/sanitize.ts`
- Modify: `packages/core/src/view/clipboard.ts` (import from the new module), `packages/core/src/core-plugin.ts`, `packages/core/src/transaction/transaction.ts`, `packages/core/src/transaction/marks.ts`
- Test: `packages/core/test/content/sanitize.test.ts`, `packages/core/test/transaction/base.test.ts`, `packages/core/test/marks.test.ts`, `packages/core/test/fragment.test.ts`

**Interfaces:**
- Produces:
  - `sanitizeFragment(raw: unknown[], registry: Registry): Fragment`. This is the clipboard's `sanitize` moved as is, so `view/clipboard.ts` imports it and its tests keep passing.
  - The core command `insertContent(fragment)` runs `sanitizeFragment` first.
  - `tr.insertNode(path, node)` validates the data of every element in the subtree through `registry.validateData`. On the first failure it sets `rejected` and emits nothing. Unknown element types pass unchanged, which keeps load lossless.
  - `addMark`, `toggleMark` and `setMark` with an unregistered mark type reject the tr with `Unknown mark type "<type>"`.

- [ ] **Step 1: Write the failing tests.**
  - `insertContent` drops an unknown block and an unknown mark.
  - `tr.insertNode` with invalid data for a registered type sets `rejected` and leaves the doc unchanged.
  - `addMark({ type: 'ghost', … })` is rejected.
  - The existing clipboard tests still pass.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): sanitize and validate programmatic content`.

---

### Task 5: Opaque-edge `deleteRange` guard and atom hoisting in normalize

**Files:**
- Modify: `packages/core/src/transaction/text.ts`, `packages/core/src/normalize.ts`
- Test: `packages/core/test/text.test.ts`, `packages/core/test/normalize.test.ts`

**Interfaces:**
- Produces:
  - `deleteRange(tr, range)` no longer throws when the range's start or end block is opaque (unknown or atom). An opaque edge block counts as fully inside the range: it is removed whole. The caret lands at the nearest editable point, and the function returns true.
  - Normalize rule 9, where an atom block is nested inside an inline-content block: the atom is moved with `move_node` to just after that block, instead of being unwrapped and lost. When it was in the middle of the block's children, the block is split around it first, so the text order is kept.

- [ ] **Step 1: Write the failing tests.**
  - `doc(p('ab'), unknownBlock, p('cd'))` with a range from `[0,0]:1` into the unknown block → `p('a'), p('cd')`, no throw.
  - The same with the range ending inside an atom block.
  - Loading `p('a', imageAtom, 'b')` (a test atom block plugin) gives `p('a'), image, p('b')` and keeps the image.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `fix(core): opaque edges in deleteRange; hoist nested atom blocks`.

---

### Task 6: `@hte/font-size`

**Files:**
- Create: `packages/plugins/font-size/{package.json,tsconfig.json,src/index.ts}` (mirror `@hte/bold`; the dependencies are `@hte/core` and `zod`)
- Test: `packages/plugins/font-size/test/font-size.test.ts`

**Interfaces:**
- Produces:
  ```ts
  fontSize = definePlugin({
    name: 'fontSize',
    data: z.object({ size: z.string().regex(/^\d+(\.\d+)?(px|pt|em|rem|%)$/) }),
    mark: { render: (d) => ({ tag: 'span', style: { fontSize: d.size } }) },
    parseHTML: [{ style: 'font-size', getData: (_, v) => (v && SIZE_RE.test(v) ? { size: v } : false) }],
    commands: () => ({ setFontSize: (size: string) => …, unsetFontSize: () => … }),
  })
  ```
  - `setFontSize` uses `tr.addMark({ type: 'fontSize', data: { size } })`, which replaces an existing size and on a caret updates the stored marks. It returns `tr.rejected === null`.
  - `unsetFontSize` uses `tr.removeMark('fontSize')`.

- [ ] **Step 1: Write the failing tests.**
  - On the range `a[bc]d`, `setFontSize('18px')` → `'bc'` carries `{ type: 'fontSize', data: { size: '18px' } }`.
  - `setFontSize('24px')` over a part that is already 18px → only 24px remains.
  - `setFontSize('huge')` → returns false and the doc is unchanged.
  - With a caret: `setFontSize('12px')`, then `insertText('x')` → `'x'` is 12px.
  - `unsetFontSize` removes the mark.
  - Parse `<span style="font-size:18px">a</span>` (happy-dom).
  - Serialize gives `<span style="font-size: 18px;">a</span>`. Match what `serializeHTML` emits and assert the exact string.
  - Bold and font size on the same text nest by rank.
- [ ] **Step 2:** Run `pnpm vitest run packages/plugins/font-size`. Expected: FAIL.
- [ ] **Step 3:** Implement the plugin, then run `pnpm install`.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(font-size): font size plugin`.

---

### Task 7: Node selection (model and editing)

**Files:**
- Modify: `packages/core/src/model/types.ts`, `packages/core/src/model/editable.ts`, `packages/core/src/ops/transform.ts`, `packages/core/src/transaction/{transaction,text,fragment}.ts`, `packages/core/src/core-plugin.ts`, `packages/core/src/index.ts`
- Create: `packages/core/src/model/find.ts`
- Test: `packages/core/test/selection/node-selection.test.ts`, `packages/core/test/ops/transform.test.ts`

**Interfaces:**
- Produces:
  - `interface Selection { anchor: Point; focus: Point; node?: Path }`. When `node` is set, the opaque element (atom or unknown) at that path is selected. `anchor` and `focus` are a collapsed caret at the nearest editable point before the element (end of the previous editable text), or after it when there is none before.
  - `nodeSelection(doc, types, path): Selection` in `model/editable.ts`, which throws if the element at `path` is not opaque. Also `isNodeSelection(sel): sel is Selection & { node: Path }`.
  - `findPathById(root: ReadableRoot, id: string): Path | null` in `model/find.ts`.
  - `transformSelection` maps `node` through `transformPath`. When it becomes null, the `node` field is dropped and the mapped caret is kept.
  - `Transaction.setSelection` equality compares `node`.
  - `Transaction.insertBlockNode(node: ElementNode): this` (in `text.ts`) inserts a block-level node at the selection:
    - With a node selection, it replaces the selected node.
    - When the current block is empty, it replaces that block.
    - At offset 0 of a block, it inserts before the block.
    - At the end of a block, it inserts after it.
    - Otherwise it splits the block at the caret and inserts between the halves.
    - Afterwards the caret is at the start of the editable text following the node. An empty default block is created after the node when nothing follows.
  - Editing behaviour with a node selection, through the existing functions and intents:
    - `deleteBackward` / `deleteForward` remove the node; the caret goes to the selection's `anchor`, mapped.
    - `insertText(text)` replaces the node with a default block containing `text`, caret after it.
    - `splitBlock` inserts an empty default block after the node and puts the caret in it.
    - `insertFragment` removes the node, then inserts at the caret.
  - `deleteBackward` at offset 0 of a block whose previous sibling is opaque selects that sibling (node selection) instead of doing nothing. `deleteForward` at the end of a block whose next sibling is opaque does the same. Both return true.
  - `getFragment(doc, range, node?)`: with a node selection, the fragment is `[copy of the node]`. Callers pass `sel.node`, and the clipboard uses it in Task 10.
  - `selectAll` clears `node`.

- [ ] **Step 1: Write the failing tests** (`atom` = a test block-atom plugin):
  - `doc(p('a'), atom, p('b'))`: Backspace at `[2,0]:0` → selection `{ node: [1], anchor: [0,0]:1 }`, doc unchanged. A second Backspace removes the atom → `p('a'), p('b')`, caret `[0,0]:1`.
  - Delete at `[0,0]:1` → selects the atom.
  - With the atom node-selected:
    - `insertText('x')` → `p('a'), p('x'), p('b')`, caret after `x`.
    - `splitBlock` → `p('a'), atom, p(''), p('b')`, caret in the new empty paragraph.
    - `deleteForward` → atom removed.
  - `insertBlockNode(atom)`:
    - in `p('ab|cd')` → `p('ab'), atom, p('cd')`, caret `[2,0]:0`;
    - in an empty `p('')` → the block is replaced, followed by `p('')`;
    - at the end of the last block → the atom is appended with an empty paragraph after it.
  - `transformSelection` with `{node: [1]}` through `insert_node [0]` → `node: [2]`; through `remove_node [1]` → `node` dropped.
  - Undoing the removal of a selected atom restores it. The selection restored by history is the stored `selectionBefore`, which includes `node`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the change. Every function that reads `tr.selection` must branch on `isNodeSelection` first. Keep the branches in `text.ts`, in one helper `replaceSelectedNode(tr, mode)`.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): node selection for opaque blocks`.

---

### Task 8: Node views in the renderer, and the view honouring them

**Files:**
- Create: `packages/core/src/view/node-view.ts`, `packages/core/src/view/ignore.ts`, `packages/core/src/view/node-select.ts`
- Modify: `packages/core/src/plugin/types.ts`, `packages/core/src/editor.ts` (option `nodeViews`), `packages/core/src/view/{renderer,view,dom-selection,input,clipboard,mutation,composition}.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/view/node-view.test.ts`, `packages/core/test/view/dom-selection.test.ts`, `packages/core/test/view/input.test.ts`, `packages/core/test/view/mutation.test.ts`

**Interfaces:**
- Produces (plugin types):
  ```ts
  interface NodeViewProps<D = Data, O = unknown> {
    node: DeepReadonly<ElementNode> & { readonly data: DeepReadonly<D> }
    selected: boolean
    editor: Editor
    options: O
    getPos(): Path | null              // findPathById on the current doc
    updateData(partial: Partial<D>): boolean   // tr.setNodeData(getPos(), partial), origin 'command', dispatched; false if rejected/removed
  }
  interface NodeViewInstance { update(props: NodeViewProps): void; destroy(): void }
  type NodeViewFactory = (container: HTMLElement, props: NodeViewProps) => NodeViewInstance
  // PluginSpec additions:
  stopEvent?: (event: Event, node: ElementNode, ctx) => boolean
  ignoreMutation?: (record: MutationRecord, node: ElementNode, ctx) => boolean
  // EditorOptions addition:
  nodeViews?: Record<string, NodeViewFactory>   // keyed by node type; atoms only in M2 (non-atom → throw 'Non-atom node views arrive in M3')
  ```
- **Renderer.** For a registered element whose type has a node view:
  - The renderer creates the container: `<div>` for a block, `<span>` for an inline element, with `data-hte-id`, `data-hte-node-view=""` and `contenteditable="false"`.
  - It calls the factory once per element id. When the node changes (data, `selected`) or after `invalidate(type)`, it calls `instance.update(props)`. When the element leaves the doc, it calls `instance.destroy()`.
  - The DOM is never rebuilt for a data change.
- **Selected marker.**
  - The renderer takes the selected node path in `RenderOptions.selectedNode?: Path`.
  - The selected element's root gets `data-hte-selected=""`, and its node view gets `selected: true`.
  - `view.update` passes `state.selection?.node`.
- **`ignore.ts`.**
  - `isIgnoredTarget(view, target)`: true when the target is inside an element with `data-editor-ignore` within the root, or when it is inside a node-view container whose plugin's `stopEvent(event, node, ctx)` returns true.
  - By default, events inside a node-view container but outside `data-editor-ignore` are not ignored.
  - `input.ts` (keydown, beforeinput, input), `clipboard.ts` (copy, cut, paste) and `composition.ts` return early, without `preventDefault`, for ignored targets.
  - `syncSelection` does nothing while `root.ownerDocument.activeElement` is inside an ignored element.
- **`mutation.ts`.**
  - Records whose target is inside a node-view container are ignored by default. The plugin can override this with `ignoreMutation(record, node, ctx)`: return false to have the record reverted.
  - Records inside a `data-editor-ignore` element are always ignored.
- **`dom-selection.ts`.**
  - `writeDomSelection` with `sel.node` calls `setBaseAndExtent(parent, i, parent, i + 1)` around the element's root.
  - `readDomSelection` maps a DOM range that covers exactly one opaque element root to `nodeSelection(...)`.
- **`node-select.ts`** (a `ViewModule`).
  - On `mousedown` on an opaque element's root, or inside it, that is not an ignored target, it calls `preventDefault`, dispatches a selection tr with `nodeSelection(doc, registry, path)`, and focuses the root.

- [ ] **Step 1: Write the failing tests** (happy-dom; the test factory records calls):
  - Mounting calls the factory once with the correct props.
  - `setNodeData` calls `update` with the new data and keeps the same container element.
  - Removing the node calls `destroy`. An undo that re-inserts it calls the factory again.
  - `setPluginOptions` calls `update` with the new options (relies on Task 2).
  - A node selection sets `data-hte-selected` and `selected: true`.
  - `getPos()` follows the node after an insert before it.
  - `updateData({ alt: 'x' })` changes the doc.
  - A keydown dispatched inside a `data-editor-ignore` input is not prevented and runs no keymap.
  - A mutation inside the container doesn't trigger a re-render.
  - A plugin `ignoreMutation` returning false gets the mutation reverted.
  - `mousedown` on the container selects the node.
  - Write and read round-trip a node selection.
  - Pressing Backspace in the input (an intent dispatched from it) leaves the doc unchanged.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the change. `NodeViewHost` in `node-view.ts` keeps `Map<id, { instance, container, props }>` and is owned by the renderer.
- [ ] **Step 4:** Run the tests and the full suite, plus `pnpm --filter playground e2e` (no regressions). Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): atom node views, selected state, ignored regions`.

---

### Task 9: History rewrites data-only changes made outside history

**Files:**
- Modify: `packages/core/src/history.ts`
- Test: `packages/core/test/history.test.ts`

**Interfaces:**
- A tr with `addToHistory: false` whose doc ops are all `set_node_data` (data-only, so the structure is unchanged) no longer clears the stacks. For each such op:
  1. Take the element id from `tr.before.doc` at `op.path`.
  2. In every undo and redo entry, replace the `data` of that element id:
     - inside `insert_node` and `remove_node` payload subtrees;
     - in `merge_node` and `split_node` `properties` when `properties.id` matches;
     - in `set_node_data` ops. Path-addressed ops can't be matched by id, so for these the history applies the op's `data` as `prevData` and `data`: both become the new data.
- Any other `addToHistory: false` tr with doc ops still clears both stacks, as in M1.
- **When the element is not in the doc** (for example an undone image):
  - `rewriteHistoryData(editor: Editor, id: string, data: Data): void`, exported from `@hte/core`, dispatches a tr with no doc ops and meta `historyRewrite: { id, data }`.
  - History applies the same payload rewrite by id for that meta.

- [ ] **Step 1: Write the failing tests.**
  - The image scenario, headless with a test atom plugin:
    1. Insert the atom with `{ src: 'blob:1' }` (one undo step).
    2. `setNodeData` with `{ src: 'https://x/1.png' }` and `addToHistory: false`.
    3. Undo → the atom is removed. Redo → the atom comes back with `src: 'https://x/1.png'`.
  - The rewrite happens while the atom is already undone, through `rewriteHistoryData`: the redo stack is rewritten, and redo shows the uploaded URL (Review Focus 1).
  - A structural `addToHistory: false` tr still clears both stacks.
- [ ] **Step 2:** Run `pnpm vitest run packages/core/test/history.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): history rewrites data-only changes made outside history`.

---

### Task 10: Paste and drop through the intent pipeline

**Files:**
- Create: `packages/core/src/view/drop.ts`
- Modify: `packages/core/src/view/clipboard.ts`, `packages/core/src/view/input.ts`, `packages/core/src/view/view.ts`, `packages/core/src/core-plugin.ts`
- Test: `packages/core/test/view/clipboard.test.ts`, `packages/core/test/view/drop.test.ts`, `apps/playground/e2e/clipboard.spec.ts`

**Interfaces:**
- **`onPaste`.** It keeps the composing and ignored-target checks, calls `syncSelection`, then `preventDefault`. It then calls `editor.handleIntent({ inputType: 'insertFromPaste', data: null, dataTransfer: e.clipboardData, range: state.selection })`.
- **Core plugin default** for `insertFromPaste` and `insertFromDrop`:
  1. Build the fragment with `parseFromClipboard(editor, { json, html, text })`, reading those flavours from `intent.dataTransfer`.
  2. If the fragment is non-empty, insert it with `insertFragment` on a tr with origin `'paste'` (paste) or `'input'` (drop) and `inputType` set to the intent's.
  3. Return true when `dataTransfer` is present, so a fragment-less paste is still consumed.
- **`drop.ts`** (a `ViewModule`):
  - `dragstart` inside the root: `preventDefault`. Internal drag-move is not supported in M2.
  - `dragover` with files or text: `preventDefault` (allow the drop).
  - `drop`:
    1. Skip ignored targets.
    2. `preventDefault`.
    3. Map the drop point to the model with `caretPositionFromPoint` or `caretRangeFromPoint`, then `domToModel`, and fall back to the selection.
    4. Dispatch a selection tr to that point.
    5. Call `handleIntent({ inputType: 'insertFromDrop', data: null, dataTransfer: e.dataTransfer, range })`.
  - `input.ts`: `insertFromDrop` `beforeinput` keeps `preventDefault` and does nothing else.
- **`onBeforeInput`** now receives paste and drop intents, so a plugin such as image can take files.

- [ ] **Step 1: Write the failing tests.**
  - Unit: a test plugin `onBeforeInput` that claims `insertFromPaste` when `dataTransfer.files.length > 0` gets the intent, and the default doesn't insert text.
  - Unit: text-only paste still inserts text, and all existing clipboard tests pass.
  - Unit: a drop with `text/plain` inserts at the drop point. Stub `caretRangeFromPoint` in happy-dom.
  - Unit: `dragstart` inside the root is prevented.
  - e2e: the existing clipboard specs still pass.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests, the full suite and e2e. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): paste and drop through the intent pipeline`.

---

### Task 11: `@hte/image` logic

**Files:**
- Create: `packages/plugins/image/{package.json,tsconfig.json,src/index.ts,src/src-policy.ts}`
- Test: `packages/plugins/image/test/image.test.ts` (happy-dom)

**Interfaces:**
- `package.json` exports `"."` → `./src/index.ts` and `"./react"` → `./src/react.tsx`. The React entry is added in Task 13. Dependencies: `@hte/core`, `zod`. Peer dependencies: `react` and `react-dom`, both optional, used only by `./react`.
- `safeSrc(src: string): string | null`. Allows `https:`, `http:`, `blob:`, `data:image/(png|jpeg|gif|webp|avif);base64,` and relative URLs. Everything else, including `javascript:`, gives null.
- Plugin:
  ```ts
  image = definePlugin({
    name: 'image',
    node: { kind: 'block', atom: true },
    data: z.object({ src: z.string(), alt: z.string().default(''), width: z.number().int().positive().optional() }),
    options: { upload: undefined as unknown as (file: File) => Promise<string>, onUploadError: undefined as ((e: unknown, file: File) => void) | undefined },
    state: { init: () => ({ pending: new Set<string>() }), apply: (tr, prev) => … },  // meta 'imageUpload': { start?: id; end?: id }
    parseHTML: [{ tag: 'img', getData: (el) => { const src = safeSrc(el.getAttribute('src') ?? ''); return src ? { src, alt: el.getAttribute('alt') ?? '', ...(width) } : false } }],
    renderHTML: (n) => ['img', { src: safeSrc(n.data.src) ?? undefined, alt: n.data.alt, width: n.data.width }],
    commands: () => ({ insertImage: (src: string, alt = '') => ({ tr }) => /* tr.insertBlockNode({ type:'image', data:{src,alt} }) */ … }),
    storage: (ctx) => ({ upload(files: File[]): void, isUploading(): boolean, isPending(id: string): boolean, whenIdle(): Promise<void> }),
    onBeforeInput: (intent, ctx) => …,
  })
  ```
- `onBeforeInput`:
  - For `insertFromPaste` / `insertFromDrop` whose `dataTransfer.files` contains at least one image file: upload the image files and return true. The text and HTML flavours are ignored, so a copied picture isn't inserted twice.
  - Without image files: return false, and the core default inserts the content.
- `upload` uses the storage's own implementation, which `onBeforeInput` reaches through `ctx.editor.storage.image`.
- **Upload algorithm** (`storage.upload(files)`), for each image file:
  1. `id = createId()`, `blob = URL.createObjectURL(file)`.
  2. A tr runs `insertBlockNode({ id, type: 'image', data: { src: blob, alt: '' } })` with meta `imageUpload: { start: id }` and origin `'command'`, then dispatches.
  3. It awaits `options.upload(file)`:
     - **Success:** take `path = findPathById(doc, id)`.
       - If the image is still in the doc, a tr with `addToHistory: false` and origin `'plugin'` runs `setNodeData(path, { src: url })`.
       - Otherwise it calls `rewriteHistoryData(editor, id, { src: url })` from Task 9.
     - **Failure:** remove the node if present, with a tr of `addToHistory: false`, then call `onUploadError(err, file)`.
     - Either way, a tr with meta `imageUpload: { end: id }` and no doc ops is dispatched.
  4. Non-image files (`!file.type.startsWith('image/')`) are skipped.
- `whenIdle()` resolves when `pending` is empty. It listens to `'transaction'` and resolves immediately if nothing is pending.
- Blob URLs are revoked in the plugin's `destroy` hook (Task 3).

- [ ] **Step 1: Write the failing tests.** Use a controllable fake `upload` (deferred promises) and a stubbed `URL.createObjectURL`.
  - `upload([png])` → an image with a `blob:` src is inserted at the caret, `isUploading()` is true. After resolving with `'https://x/a.png'`, src is the URL, `isUploading()` is false, `whenIdle()` resolves, and undo removes the image.
  - Rejecting the upload → the image is removed, `onUploadError` is called, and nothing throws.
  - Review Focus 1: upload, then undo the insertion, then resolve. No throw; redo shows the uploaded URL.
  - Delete the image while it is pending, then resolve: no throw, no reinsertion.
  - Review Focus 4:
    - A paste intent with `[png, pdf]` and `text/plain 'hi'` → one image inserted, the pdf skipped, `'hi'` not inserted.
    - A paste with only `[pdf]` and `text/plain 'hi'` → no image, and `'hi'` inserted by the default.
  - `safeSrc` table: https/http/blob/data:image/relative allowed; `javascript:`, `data:text/html` and `vbscript:` rejected.
  - Parse `<img src="javascript:alert(1)">` gives no image.
  - Serialize gives `<img src="https://x/a.png" alt="" />`. Assert the exact string that `serializeHTML` emits for void tags.
  - `insertImage('https://x/b.png')` command.
- [ ] **Step 2:** Run `pnpm vitest run packages/plugins/image`. Expected: FAIL.
- [ ] **Step 3:** Implement the plugin, then run `pnpm install`.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(image): image plugin with async upload`.

---

### Task 12: React node views

**Files:**
- Create: `packages/react/src/node-views.tsx`
- Modify: `packages/react/src/{use-editor.ts,editor-content.tsx,index.ts}`
- Test: `packages/react/test/node-views.test.tsx`

**Interfaces:**
- `type ReactNodeView<D = Data, O = unknown> = ComponentType<NodeViewProps<D, O>>`.
- The `useEditor` options gain:
  - `nodeViews?: Record<string, ReactNodeView<any, any>>`, read on the first render only, like the other options;
  - `pluginOptions?: Record<string, Record<string, unknown>>`. On every render, each entry is shallow-compared with the last applied value, and `editor.setPluginOptions(name, value)` is called when it differs.
- **Portal store.**
  - `createPortalStore()` returns `{ add(entry), update(id, props), remove(id), subscribe, getSnapshot }`, where an entry is `{ id, container, Component, props }`.
  - `toNodeViewFactory(Component, store)` returns a `NodeViewFactory`. It adds an entry and returns `{ update: (p) => store.update(id, p), destroy: () => store.remove(id) }`.
  - `useEditor` creates the store and passes the factories through `EditorOptions.nodeViews`.
  - It also records the store in a module `WeakMap<Editor, PortalStore>`, so that `EditorContent` can render `createPortal(<Component {...props} />, container)` for each entry through `useSyncExternalStore`.
- `EditorContent` renders the portals next to its `<div>`. Portals target containers that live inside the div.
- JSDoc on `useEditor` covers the `<Activity mode="hidden">` limitation: hiding destroys the editor. This is the followup.

- [ ] **Step 1: Write the failing tests** (`@testing-library/react`, StrictMode):
  - A test atom with a `nodeViews` component renders inside the container, and the component sees `node.data` and `selected`.
  - `updateData` from a button click in the component changes the doc.
  - Removing the node unmounts the component, with no console errors (Review Focus 5).
  - A `pluginOptions` change re-renders the component with the new `options`.
  - StrictMode doesn't double-mount node views: exactly one instance per id.
- [ ] **Step 2:** Run `pnpm vitest run packages/react`. Expected: FAIL.
- [ ] **Step 3:** Implement the change.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(react): node views via portals and plugin option props`.

---

### Task 13: Image React view

**Files:**
- Create: `packages/plugins/image/src/react.tsx`
- Test: `packages/plugins/image/test/react.test.tsx`

**Interfaces:**
- `export function ImageView(props: NodeViewProps<ImageData, ImageOptions>): JSX.Element` renders:
  ```
  <figure data-selected={selected} className="hte-image">
    <img src={safeSrc(src) ?? ''} alt={alt} width={width} draggable={false} />
    <input data-editor-ignore aria-label="Alt text" value={draft} onChange={...} onBlur={commit} onKeyDown={Enter→commit} />
    <span data-editor-ignore className="hte-image-resize" onPointerDown={startResize} />
  </figure>
  ```
  - The alt draft is local state. It is committed with `updateData({ alt })` on blur or Enter, and only when it changed.
  - Resizing: pointer drag on the handle updates the local width live and commits `updateData({ width: Math.round(w) })` on pointerup. The minimum width is 32 and the maximum is the figure's parent width.
  - While `editor.storage.image.isPending(node.id)` is true, a `data-uploading` attribute is set.
- Export `ImageView` and the `ImageData` and `ImageOptions` types from `@hte/image/react` and `@hte/image` respectively.

- [ ] **Step 1: Write the failing tests:**
  - Typing in the alt input and blurring → the doc's alt changes in one undo step.
  - Escape or no change → no tr.
  - Simulated pointerdown, pointermove, pointerup on the handle → width committed.
  - `data-selected` follows the node selection.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the view.
- [ ] **Step 4:** Run the tests and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(image): React image view`.

---

### Task 14: Playground and e2e for font size and image

**Files:**
- Modify: `apps/playground/src/{editor.ts,App.tsx,Toolbar.tsx,scenarios.ts,styles.css}`, `apps/playground/package.json` (add `@hte/font-size` and `@hte/image`)
- Create: `apps/playground/src/fake-upload.ts`, `apps/playground/e2e/{font-size.spec.ts,image.spec.ts}`

**Interfaces:**
- Plugins: `[paragraph, bold, fontSize, image]`. `nodeViews: { image: ImageView }`.
- `pluginOptions: { image: { upload: fakeUpload } }`.
- `fakeUpload(file)` resolves after 300 ms with `URL.createObjectURL(file)` + `#uploaded`, so the src differs from the blob. With `?uploadFail=1` in the URL, it rejects.
- Toolbar:
  - a font-size `<select data-testid="font-size">` with the options default, 12px, 16px, 24px and 32px. `onChange` calls `setFontSize` or `unsetFontSize`, and the value reflects the active size;
  - an "Image" button that opens a hidden `<input type=file accept="image/*" data-testid="image-file">` and calls `editor.storage.image.upload(files)`.
- Scenarios: `fontSizes` (HTML with sizes) and `image` (a doc with one image of `src` `data:image/png;base64,…`, a 1×1 png, between two paragraphs).
- e2e:
  - **Font size:** select 24px on a selection gives the mark in the JSON. Typing after choosing a size at the caret uses it.
  - **Image insert via the file input** (`setInputFiles` with a generated png buffer): the image appears, and after the fake upload the src ends with `#uploaded`. Then undo removes it and redo restores it with `#uploaded` (Review Focus 1).
  - **Paste** of a synthetic `ClipboardEvent` with a `DataTransfer` holding a png `File` and a pdf `File` → one image (Review Focus 4).
  - **Drop** of a synthetic `DragEvent` with a png file onto the second paragraph inserts there.
  - **Click** on the image selects it (`data-hte-selected`).
  - **Backspace** removes it.
  - **Backspace at the start of the following paragraph** selects the image.
  - **Typing while it is selected** replaces it with a paragraph (Review Focus 2).
  - **Alt input:** type `Cat`, then Tab away → alt is `Cat` in the JSON, and the editor's text is unchanged (Review Focus 3).
  - **Resize:** drag the handle by +40px → `width` increases.
  - **Upload failure** (`?uploadFail=1`): the image is gone and nothing throws (listen for `pageerror`).
- [ ] **Step 1:** Write the e2e specs.
- [ ] **Step 2:** Run `pnpm --filter playground e2e`. Expected: FAIL.
- [ ] **Step 3:** Implement the playground changes.
- [ ] **Step 4:** Run e2e (all specs), `pnpm test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(playground): font size and image`.

---

### Task 15: M2 verification

- [ ] **Step 1:** Run `pnpm typecheck && pnpm test && pnpm vitest --typecheck run && pnpm --filter playground e2e`. Expected: all pass.
- [ ] **Step 2:** Run `grep -rE "from ['\"]react" packages/core/src packages/plugins/*/src/index.ts`. Expected: no matches.
- [ ] **Step 3:** Run `grep -rE "@hte/core/src|\.\./\.\./core" packages/plugins packages/react apps`. Expected: no matches.
- [ ] **Step 4:** Update `docs/superpowers/m1-followups.md`: check off the items M2 closed, and move "appendTransaction joining history" to the M3 section.
- [ ] **Step 5: Commit** `chore: M2 verification`.

---

## Deferred (per spec / rulings)
- **M3:**
  - non-atom node views with `<NodeContent />` (code block);
  - `inputRules`, decorations, popups, `coordsAt`, `usePluginState` (mention);
  - `appendTransaction` joining history entries;
  - inline atoms and their caret and Backspace behaviour (mention).
- **M4:** Firefox and WebKit.
- **Not planned:** internal drag-move of editor content (M2 prevents `dragstart`).
