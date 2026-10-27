# M1: Core Engine, Paragraph, Bold, React Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working headless editor engine (model, operations, transactions, normalization, history, HTML import/export, contenteditable view with input/IME/clipboard), the `paragraph` and `bold` plugins, a React adapter, a playground, and a headless test helper, all running on Chromium.

**Architecture:** A framework-independent TypeScript core holds an immutable document tree, changed only by invertible operations grouped into transactions. Everything goes through plugins that use only the public API: core editing commands and history are plugins too. A contenteditable view intercepts `beforeinput` and keys, turns them into headless "intents" and key names that the `Editor` handles without a DOM, then patches the DOM keyed by element id. The React adapter is a thin layer over `Editor`.

**Tech Stack:** pnpm workspaces, TypeScript (strict, ESM), Vitest (+ happy-dom for DOM tests), Playwright (Chromium), Vite + React 19, zod (tests/plugins only, via Standard Schema).

**Spec:** `docs/superpowers/specs/2026-10-27-headless-editor-design.md` — this plan covers milestone **M1** (§9). M2–M4 get their own plans after M1 lands.

## Global Constraints

- Node ≥ 20 (dev machine has 24); pnpm via `corepack enable`.
- TypeScript `strict: true`, ESM only (`"type": "module"`). No build step in M1: every package's `exports` point at `./src/*.ts`.
- `packages/core` has **no** dependency on any UI framework. Its only runtime-adjacent dependency is `@standard-schema/spec` (types).
- `@hte/core` exposes exactly two entry points: `@hte/core` and `@hte/core/testing`. Plugins and the React adapter import only from these — never deep paths (spec anti-goal: built-in plugins must not use internals).
- Node/mark `data` must be plain JSON.
- Every feature is a plugin, including core editing commands and history (spec §5.5).
- Data validators are synchronous Standard Schema validators; async is an error at registration (spec §5.2).
- Positions are `Point = { path: number[]; offset: number }`, path always pointing at a `TextNode` (spec §5.4).
- M1 e2e runs on Chromium only (spec §9).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Grapheme clusters:** Backspace after `👍🏽`, a ZWJ family emoji, or a decomposed Vietnamese `ệ` deletes the whole visible character, never half of it. → Task 9.
2. **Select all, then type or delete across several blocks:** leaves exactly one block containing the typed text (or one empty block), never zero blocks or a crash. → Task 9 (unit) and Task 20 (e2e).
3. **Pasting content copied from the same document:** pasted elements get fresh ids; every element id in the doc stays unique. → Task 11.
4. **Malformed content on load** (missing `children`/`marks`/`data`/`id`, text at doc root, unknown types, invalid `data`, empty doc): it is coerced to a valid doc and nothing throws. → Task 7.
5. **React StrictMode** double mount/unmount: the editor still works and typing inserts each character once (no duplicate listeners). → Task 19.

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, tsconfig.json, vitest.config.ts, .gitignore
packages/core/
  package.json                # exports "." and "./testing"
  src/index.ts                # public API barrel
  src/model/types.ts          # Json, Data, Mark, TextNode, ElementNode, Node, Doc, Path, Point, Selection
  src/model/node.ts           # node/tree helpers
  src/model/path.ts           # path/point/range helpers
  src/model/id.ts             # createId, setIdGenerator
  src/ops/types.ts            # Operation union
  src/ops/apply.ts            # applyOp
  src/ops/invert.ts           # invertOp
  src/ops/transform.ts        # transformPath, transformPoint
  src/plugin/types.ts         # PluginSpec, Plugin, contexts, Command, InputIntent, ParseRule, DOMOutputSpec
  src/plugin/define.ts        # definePlugin, configure, extend
  src/plugin/registry.ts      # Registry
  src/state.ts                # EditorState
  src/transaction/transaction.ts  # Transaction class (base ops, selection mapping, setNodeData)
  src/transaction/text.ts     # insertText, deleteRange, deleteBackward/Forward, splitBlock
  src/transaction/marks.ts    # addMark, removeMark, toggleMark, marksAt, isMarkActive
  src/transaction/fragment.ts # Fragment, getFragment, insertFragment
  src/normalize.ts            # core normalization + plugin hook loop
  src/load.ts                 # coerceDoc
  src/keymap.ts               # normalizeKeyName, eventToKeyName
  src/editor.ts               # Editor
  src/core-plugin.ts          # built-in "core" plugin: editing commands + default intents
  src/history.ts              # built-in "history" plugin
  src/html/serialize.ts       # serializeHTML, renderSpecToString
  src/html/parse.ts           # parseHTML
  src/view/renderer.ts        # Renderer (doc → DOM, keyed patch)
  src/view/dom-selection.ts   # model ↔ DOM point/selection mapping
  src/view/view.ts            # EditorView (mount, render, selection sync, listeners)
  src/view/input.ts           # keydown/beforeinput → editor
  src/view/composition.ts     # IME composition handling
  src/view/mutation.ts        # MutationObserver safety net
  src/view/clipboard.ts       # copy/cut/paste
  src/testing/index.ts        # createTestEditor, builders, stripIds
  src/testing/builders.ts     # doc, el, txt, sel
  test/fixtures.ts            # testParagraph, testBold plugins for core tests
  test/**/*.test.ts
packages/react/src/{index.ts,use-editor.ts,editor-content.tsx,use-editor-state.ts}, test/
packages/plugins/paragraph/src/index.ts, test/
packages/plugins/bold/src/index.ts, test/
apps/playground/{index.html,vite.config.ts,playwright.config.ts}
apps/playground/src/{main.tsx,App.tsx,Toolbar.tsx,CodePanel.tsx,scenarios.ts}
apps/playground/e2e/{helpers.ts,*.spec.ts}
```

DOM tests start with the comment `// @vitest-environment happy-dom`.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`

**Interfaces:**
- Produces: root scripts `test` (`vitest run`), `typecheck` (`tsc -b`), `e2e` (`pnpm --filter playground e2e`); package `@hte/core` with `exports: { ".": "./src/index.ts", "./testing": "./src/testing/index.ts" }`.

- [ ] **Step 1:** `git init`, `corepack enable`, write `.gitignore` (`node_modules`, `dist`, `test-results`, `playwright-report`).
- [ ] **Step 2:** Root `package.json` (`private`, `type: module`, `packageManager: pnpm@<current>`), `pnpm-workspace.yaml` (`packages/*`, `packages/plugins/*`, `apps/*`), `tsconfig.base.json` (`strict`, `module: ESNext`, `moduleResolution: Bundler`, `target: ES2022`, `lib: [ES2022, DOM, DOM.Iterable]`, `jsx: react-jsx`, `noEmit`, `verbatimModuleSyntax`), `vitest.config.ts` using `test.projects: ['packages/*', 'packages/plugins/*']`. Dev deps at root: `typescript`, `vitest`, `happy-dom`, `zod`, `@standard-schema/spec`.
- [ ] **Step 3: Write the smoke test** `packages/core/test/smoke.test.ts`: `import * as core from '../src/index'; expect(core).toBeTypeOf('object')`.
- [ ] **Step 4:** Run `pnpm install && pnpm test && pnpm typecheck` → all pass.
- [ ] **Step 5: Commit** `chore: scaffold pnpm workspace`.

---

### Task 2: Model types, helpers, ids, test builders

**Files:**
- Create: `packages/core/src/model/{types,node,path,id}.ts`, `packages/core/src/testing/builders.ts`
- Test: `packages/core/test/model/node.test.ts`, `packages/core/test/model/path.test.ts`

**Interfaces:**
- Produces (types, spec §5.2):
  ```ts
  type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
  type Data = Record<string, Json>
  interface Mark { type: string; data: Data }
  interface TextNode { text: string; marks: Mark[] }
  interface ElementNode { id: string; type: string; data: Data; children?: Node[] }
  type Node = ElementNode | TextNode
  interface Doc { type: 'doc'; children: ElementNode[] }
  type Path = number[]
  interface Point { path: Path; offset: number }
  interface Selection { anchor: Point; focus: Point }
  interface Range { start: Point; end: Point }   // ordered
  ```
- `node.ts`: `isText(n): n is TextNode`, `isElement(n): n is ElementNode`, `getNode(root: Doc | ElementNode, path: Path): Node` (throws `Error('Invalid path [0,5]')`), `getParent(root, path): Doc | ElementNode`, `nodeEntries(doc): Generator<[Node, Path]>` (pre-order), `textEntries(doc, range?): Generator<[TextNode, Path]>`, `sameMarkSet(a: Mark[], b: Mark[]): boolean` (order-insensitive, deep data equality), `deepEqualJson(a: Json, b: Json): boolean`.
- `path.ts`: `comparePath(a, b): -1 | 0 | 1` (ancestor/descendant compare as 0), `isAncestorPath(a, b)`, `parentPath`, `nextPath`, `previousPath`, `comparePoint(a, b): -1 | 0 | 1`, `pointEquals`, `isCollapsed(sel)`, `toRange(sel): Range`.
- `id.ts`: `createId(): string` (10-char URL-safe random, no dependency), `setIdGenerator(fn: (() => string) | null): void` (null restores default).
- `builders.ts` (exported later from `@hte/core/testing`): `doc(...blocks: ElementNode[]): Doc`, `el(type: string, data?: Data, ...children: Node[]): ElementNode` (also accepts children without data: `el('paragraph', txt('a'))`), `txt(text: string, ...marks: (string | Mark)[]): TextNode` (a string `'bold'` means `{ type: 'bold', data: {} }`), `sel(path: Path, offset: number, focusPath?: Path, focusOffset?: number): Selection`.

- [ ] **Step 1: Write failing tests**

```ts
const d = doc(el('paragraph', txt('ab'), txt('cd', 'bold')))
expect(getNode(d, [0, 1])).toEqual({ text: 'cd', marks: [{ type: 'bold', data: {} }] })
expect(() => getNode(d, [0, 5])).toThrow('Invalid path [0,5]')
expect([...nodeEntries(d)].map(([, p]) => p)).toEqual([[0], [0, 0], [0, 1]])
expect(sameMarkSet([{ type: 'fs', data: { size: '12px' } }], [{ type: 'fs', data: { size: '14px' } }])).toBe(false)
expect(sameMarkSet([{ type: 'a', data: {} }, { type: 'b', data: {} }], [{ type: 'b', data: {} }, { type: 'a', data: {} }])).toBe(true)

expect(comparePath([0, 1], [0, 2])).toBe(-1)
expect(comparePath([1], [0, 9])).toBe(1)
expect(comparePath([0], [0, 1])).toBe(0)
expect(isAncestorPath([0], [0, 1])).toBe(true)
expect(comparePoint({ path: [0, 0], offset: 2 }, { path: [0, 1], offset: 0 })).toBe(-1)
expect(toRange(sel([0, 1], 0, [0, 0], 1))).toEqual({ start: { path: [0, 0], offset: 1 }, end: { path: [0, 1], offset: 0 } })
```

- [ ] **Step 2:** `pnpm vitest run packages/core/test/model` → FAIL (modules missing).
- [ ] **Step 3:** Implement the files above.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `feat(core): document model types and helpers`.

---

### Task 3: Operations — apply and invert

**Files:**
- Create: `packages/core/src/ops/types.ts`, `packages/core/src/ops/apply.ts`, `packages/core/src/ops/invert.ts`
- Test: `packages/core/test/ops/apply.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Operation =
    | { type: 'insert_text'; path: Path; offset: number; text: string }
    | { type: 'remove_text'; path: Path; offset: number; text: string }
    | { type: 'insert_node'; path: Path; node: Node }
    | { type: 'remove_node'; path: Path; node: Node }
    // text: splits at char `position`; element: splits at child index `position`.
    // `properties` = what the new right-hand node gets (text: { marks }; element: { id, type, data }).
    | { type: 'split_node'; path: Path; position: number; properties: Partial<ElementNode> | Partial<TextNode> }
    // merges node at `path` into its previous sibling; `position` = previous sibling's length before merge;
    // `properties` = the removed node's own properties (for inversion).
    | { type: 'merge_node'; path: Path; position: number; properties: Partial<ElementNode> | Partial<TextNode> }
    | { type: 'move_node'; path: Path; newPath: Path }
    | { type: 'set_node_data'; path: Path; data: Data; prevData: Data }       // full replacement
    | { type: 'add_mark'; path: Path; mark: Mark }                             // whole text node; type must be absent
    | { type: 'remove_mark'; path: Path; mark: Mark }                          // exact mark present
    | { type: 'set_selection'; selection: Selection | null; prevSelection: Selection | null }
  applyOp(doc: Doc, op: Operation): Doc   // pure; structural sharing; set_selection returns doc unchanged
  invertOp(op: Operation): Operation
  ```
  `move_node.newPath` uses Slate semantics (path in the tree *before* the move).

- [ ] **Step 1: Write failing tests** — one table-driven case per op type, each asserting (a) the expected result doc, (b) `applyOp(applyOp(d, op), invertOp(op))` deep-equals `d`, (c) the input `d` is unchanged (`structuredClone` before, compare after) and an untouched sibling block keeps reference identity. Key cases:

```ts
const d = doc(el('paragraph', { }, txt('abcd')), el('paragraph', txt('ef', 'bold')))
// split text
applyOp(d, { type: 'split_node', path: [0, 0], position: 2, properties: { marks: [] } })
  // → p(txt('ab'), txt('cd')), p(...)
// split element at child index 1 (after a text split), new node id 'n2'
{ type: 'split_node', path: [0], position: 1, properties: { id: 'n2', type: 'paragraph', data: {} } }
  // → p('ab'), p#n2('cd'), p('ef')
// merge block [1] into [0]
{ type: 'merge_node', path: [1], position: 1, properties: { id: d.children[1].id, type: 'paragraph', data: {} } }
// add_mark when mark already present → throws Error('Mark "bold" already present at [1,0]')
// insert_text offset beyond length → throws
```

- [ ] **Step 2:** `pnpm vitest run packages/core/test/ops` → FAIL.
- [ ] **Step 3:** Implement. Copy only nodes along the changed path; everything else is shared.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `feat(core): invertible operations`.

---

### Task 4: Path and point transforms

**Files:**
- Create: `packages/core/src/ops/transform.ts`
- Test: `packages/core/test/ops/transform.test.ts`

**Interfaces:**
- Produces: `transformPath(path: Path, op: Operation): Path | null` (null = node removed), `transformPoint(point: Point, op: Operation, affinity: 'forward' | 'backward' = 'forward'): Point | null`, `transformSelection(sel: Selection, op: Operation): Selection | null`. Used for selection mapping now and OT later (spec §5.10).

- [ ] **Step 1: Write failing tests**

```ts
const P = (path: Path, offset: number) => ({ path, offset })
expect(transformPath([0, 1], { type: 'insert_node', path: [0], node: el('paragraph', txt('')) })).toEqual([1, 1])
expect(transformPath([0, 1], { type: 'remove_node', path: [0], node: anyNode })).toBeNull()
expect(transformPath([1, 0], { type: 'remove_node', path: [0], node: anyNode })).toEqual([0, 0])
expect(transformPoint(P([0, 0], 3), { type: 'split_node', path: [0, 0], position: 2, properties: {} })).toEqual(P([0, 1], 1))
expect(transformPoint(P([0, 1], 4), { type: 'split_node', path: [0], position: 1, properties: {} })).toEqual(P([1, 0], 4))
expect(transformPoint(P([0, 1], 1), { type: 'merge_node', path: [0, 1], position: 2, properties: {} })).toEqual(P([0, 0], 3))
expect(transformPoint(P([0, 0], 1), { type: 'insert_text', path: [0, 0], offset: 1, text: 'xy' })).toEqual(P([0, 0], 3))
expect(transformPoint(P([0, 0], 1), { type: 'insert_text', path: [0, 0], offset: 1, text: 'xy' }, 'backward')).toEqual(P([0, 0], 1))
expect(transformPoint(P([0, 0], 3), { type: 'remove_text', path: [0, 0], offset: 1, text: 'abc' })).toEqual(P([0, 0], 1))
expect(transformPoint(P([0, 0], 5), { type: 'remove_text', path: [0, 0], offset: 1, text: 'abc' })).toEqual(P([0, 0], 2))
expect(transformPath([0], { type: 'move_node', path: [0], newPath: [2] })).toEqual([1])
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (Slate's `Path.transform` semantics). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): path and point transforms`.

---

### Task 5: Plugin definition and registry

**Files:**
- Create: `packages/core/src/plugin/{types,define,registry}.ts`
- Test: `packages/core/test/plugin/registry.test.ts`, `packages/core/test/plugin/types.test-d.ts`

**Interfaces:**
- Produces (M1 subset of spec §5.5; `inputRules`, `decorations`, `stopEvent`, `ignoreMutation`, `serializeClipboard`, and node views come in M2/M3):
  ```ts
  type DOMOutputSpec = string | 0 | [tag: string, attrs?: Record<string, string | number | undefined> | DOMOutputSpec, ...children: DOMOutputSpec[]]  // 0 = content hole
  interface MarkDOM { tag: string; attrs?: Record<string, string>; style?: Record<string, string> }
  interface ParseRule { tag?: string; style?: string; priority?: number; getData?: (el: HTMLElement, styleValue?: string) => Data | false }
  interface InputIntent { inputType: string; data: string | null; range: Selection | null; dataTransfer?: DataTransfer | null }
  type Command = (props: { tr: Transaction; state: EditorState; editor: Editor }) => boolean
  interface PluginContext<O, S> { editor: Editor; name: string; readonly options: O; getState(): S }

  interface PluginSpec<Name extends string, D, O, C extends Record<string, (...a: any[]) => Command>, S> {
    name: Name
    priority?: number                                   // default 100; higher runs first
    node?: { kind: 'block' | 'inline'; atom?: boolean; default?: boolean; content?: 'inline' | 'text' }
    mark?: { render: (data: D) => MarkDOM }
    data?: StandardSchemaV1<unknown, D>
    options?: O
    commands?: (ctx: PluginContext<O, S>) => C
    keymap?: (ctx: PluginContext<O, S>) => Record<string, () => boolean>
    onBeforeInput?: (intent: InputIntent, ctx: PluginContext<O, S>) => boolean
    handleDOMEvents?: Partial<Record<'keydown' | 'beforeinput' | 'input', (event: Event, ctx: PluginContext<O, S>) => boolean>>
    filterTransaction?: (tr: Transaction, state: EditorState) => boolean
    appendTransaction?: (trs: Transaction[], oldState: EditorState, newState: EditorState) => Transaction | null
    normalize?: (entry: [Node, Path], tr: Transaction, ctx: PluginContext<O, S>) => void
    parseHTML?: ParseRule[]
    renderHTML?: (node: ElementNode, ctx: { options: O }) => DOMOutputSpec
    transformPasted?: (fragment: Fragment, ctx: PluginContext<O, S>) => Fragment
    onInvalidData?: (raw: unknown) => Data | null
    state?: { init: () => S; apply: (tr: Transaction, prev: S) => S }
  }
  interface Plugin<Spec> { readonly name: Spec['name']; readonly spec: Spec; configure(options: Partial<OptionsOf<Spec>>): Plugin<Spec>; extend<E>(overrides: E): Plugin<Spec & E> }
  definePlugin<const Spec extends PluginSpec<...>>(spec: Spec): Plugin<Spec>

  class Registry {
    constructor(plugins: AnyPlugin[])
    readonly plugins: AnyPlugin[]            // sorted by priority desc, stable
    readonly defaultBlock: string
    node(type: string): (NonNullable<PluginSpec['node']> & { plugin: AnyPlugin }) | undefined
    mark(type: string): (NonNullable<PluginSpec['mark']> & { plugin: AnyPlugin }) | undefined
    markRank(type: string): number           // registration order; unknown marks sort last
    validateData(type: string, raw: unknown): { ok: true; data: Data } | { ok: false; message: string }
  }
  ```
  `Fragment`, `Transaction`, `EditorState`, `Editor` are forward type imports from Tasks 6, 8 and 11; declare them `import type` to avoid cycles.

- [ ] **Step 1: Write failing tests**

```ts
const p = definePlugin({ name: 'paragraph', node: { kind: 'block', default: true } })
const fs = definePlugin({ name: 'fontSize', mark: { render: d => ({ tag: 'span', style: { fontSize: d.size } }) },
  data: z.object({ size: z.string().default('16px') }) })
const r = new Registry([p, fs])
expect(r.defaultBlock).toBe('paragraph')
expect(r.validateData('fontSize', {})).toEqual({ ok: true, data: { size: '16px' } })
expect(r.validateData('fontSize', { size: 3 }).ok).toBe(false)
expect(r.validateData('paragraph', { anything: 1 })).toEqual({ ok: true, data: { anything: 1 } }) // no schema → passthrough
expect(() => new Registry([p, p])).toThrow('Duplicate plugin "paragraph"')
expect(() => new Registry([fs])).toThrow('No default block plugin registered')
const asyncSchema = { '~standard': { version: 1, vendor: 't', validate: async () => ({ value: {} }) } }
expect(() => new Registry([p, definePlugin({ name: 'x', node: { kind: 'block' }, data: asyncSchema })]))
  .toThrow('Async validators are not supported (plugin "x")')
// priority ordering
const a = definePlugin({ name: 'a', priority: 50 }), b = definePlugin({ name: 'b', priority: 200 })
expect(new Registry([p, a, b]).plugins.map(x => x.name)).toEqual(['b', 'paragraph', 'a'])
// configure / extend
const m = definePlugin({ name: 'm', options: { n: 1, s: 'x' } })
expect(m.configure({ n: 2 }).spec.options).toEqual({ n: 2, s: 'x' })
expect(m.spec.options).toEqual({ n: 1, s: 'x' })
expect(m.extend({ priority: 7 }).spec.priority).toBe(7)
```

Type test (`types.test-d.ts`, run by `vitest --typecheck`): `expectTypeOf(fs).toMatchTypeOf<Plugin<any>>()`; the `render` callback's `d` is typed `{ size: string }`.

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Detect async validators at registration by calling `validate({})` once and checking for a thenable. **Step 4:** Run (also `pnpm vitest --typecheck run packages/core/test/plugin`) → PASS.
- [ ] **Step 5: Commit** `feat(core): plugin definition and registry`.

---

### Task 6: EditorState and Transaction base

**Files:**
- Create: `packages/core/src/state.ts`, `packages/core/src/transaction/transaction.ts`
- Test: `packages/core/test/transaction/base.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface EditorState { readonly doc: Doc; readonly selection: Selection | null; readonly storedMarks: Mark[] | null; readonly pluginStates: ReadonlyMap<string, unknown> }
  interface TransactionMeta { origin?: 'input' | 'paste' | 'command' | 'history' | 'plugin' | 'selection' | 'load'; addToHistory?: boolean; inputType?: string; [k: string]: unknown }
  class Transaction {
    constructor(state: EditorState, registry: Registry)
    readonly before: EditorState; readonly registry: Registry
    get doc(): Doc; get selection(): Selection | null; get storedMarks(): Mark[] | null
    readonly ops: Operation[]; readonly meta: TransactionMeta
    get docChanged(): boolean
    rejected: string | null                     // set when the tr must be dropped (e.g. invalid data)
    apply(op: Operation): this                  // applies op; maps selection via transformSelection
    setSelection(sel: Selection | null): this   // emits set_selection; clears storedMarks
    setStoredMarks(marks: Mark[] | null): this
    setMeta(key: string, value: unknown): this
    insertNode(path: Path, node: ElementNode | TextNode): this   // assigns id if missing
    removeNode(path: Path): this
    setNodeData(path: Path, partial: Data): this  // merge + validate; invalid → rejected = message
  }
  ```

- [ ] **Step 1: Write failing tests** — `apply(insert_text)` moves a caret placed after the insert point; `setNodeData` merges `{ a: 1 }` into `{ b: 2 }` and emits one `set_node_data` op with full `prevData`; `setNodeData` with invalid data sets `rejected` to the validator message and does not change the doc; `setSelection` clears `storedMarks`; `docChanged` is false after only `setSelection`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): editor state and transaction base`.

---

### Task 7: Normalization and content loading

**Files:**
- Create: `packages/core/src/normalize.ts`, `packages/core/src/load.ts`, `packages/core/test/fixtures.ts`
- Test: `packages/core/test/normalize.test.ts`, `packages/core/test/load.test.ts`

**Interfaces:**
- Consumes: `Transaction`, `Registry`.
- Produces:
  - `normalize(tr: Transaction): void`: runs core rules, then each plugin's `normalize` on every dirty entry, repeating until no ops are added. More than 100 passes → `Error('Normalization did not converge')`.
  - Core rules:
    1. `doc.children` is non-empty, otherwise insert an empty default block.
    2. A text/inline at the doc root is wrapped into a default block.
    3. Adjacent texts with `sameMarkSet` are merged.
    4. Empty texts are removed when the block has other children.
    5. A non-atom block with no children gets `txt('')`.
    6. Marks on each text are sorted by `registry.markRank`.
    7. Unknown types are left untouched, including their children.
    8. A block `content: 'text'` drops marks and inline elements (needed in M3; implement and test now since it's a single rule).
  - `coerceDoc(raw: unknown, registry: Registry): Doc`: never throws.
    - It fills missing `id` / `data` / `marks` / `children`.
    - It validates `data` via `registry.validateData`; on failure it calls the plugin's `onInvalidData(raw)`. `null` or no hook drops the node with `console.warn`.
    - Anything that isn't an object becomes `{ type: 'doc', children: [] }`.
    - The caller runs `normalize` afterwards (spec §5.2).
  - `test/fixtures.ts`:
    ```ts
    testParagraph = definePlugin({ name: 'paragraph', node: { kind: 'block', default: true, content: 'inline' }, parseHTML: [{ tag: 'p' }], renderHTML: () => ['p', 0] })
    testBold = definePlugin({ name: 'bold', mark: { render: () => ({ tag: 'strong' }) }, parseHTML: [{ tag: 'strong' }, { tag: 'b' }] })
    ```

- [ ] **Step 1: Write failing tests** — one per core rule, using a helper `normalized(d) = stripIds(...)`. Also cover Review Focus 4:

```ts
const r = new Registry([testParagraph, testBold])
expect(stripIds(load(r, null))).toEqual(stripIds(doc(el('paragraph', txt('')))))
expect(stripIds(load(r, { type: 'doc', children: [{ text: 'hi' }] }))).toEqual(stripIds(doc(el('paragraph', txt('hi')))))
expect(stripIds(load(r, { type: 'doc', children: [{ type: 'paragraph' }] }))).toEqual(stripIds(doc(el('paragraph', txt('')))))
const unknown = { id: 'u1', type: 'widget', data: { x: 1 }, children: [{ text: 'keep', marks: [] }] }
expect(load(r, { type: 'doc', children: [unknown] }).children[0]).toEqual(unknown)   // lossless
// invalid data with and without onInvalidData; warn spy called once when dropped
```
Here `load(r, raw)` is a test-local helper: `coerceDoc` → Transaction → `normalize` → doc.

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): normalization and content coercion`.

---

### Task 8: Editor, commands, keymap and intents (headless), test helper

**Files:**
- Create: `packages/core/src/editor.ts`, `packages/core/src/keymap.ts`, `packages/core/src/testing/index.ts`, update `packages/core/src/index.ts`
- Test: `packages/core/test/editor.test.ts`, `packages/core/test/keymap.test.ts`, `packages/core/test/editor.test-d.ts`

**Interfaces:**
- Produces:
  ```ts
  interface EditorOptions<P extends readonly AnyPlugin[]> { plugins: P; content?: Doc | string; selection?: Selection; history?: boolean /* default true */; dev?: boolean; platform?: 'mac' | 'other' }
  class Editor<P extends readonly AnyPlugin[] = AnyPlugin[]> {
    constructor(options: EditorOptions<P>)       // auto-prepends corePlugin (Task 9) and, unless history:false, historyPlugin (Task 12)
    readonly registry: Registry; get state(): EditorState
    createTransaction(): Transaction
    dispatch(tr: Transaction): void
    readonly commands: CommandsOf<P>             // each call: new tr (meta.origin 'command'), run, dispatch if true; returns boolean
    can(): CommandsOf<P>                         // runs on a throwaway tr, never dispatches
    runKeymap(keyName: string): boolean          // plugins by priority; first handler returning true wins
    handleIntent(intent: InputIntent): boolean   // plugin onBeforeInput by priority, then corePlugin defaults
    on(event: 'transaction' | 'update' | 'selectionUpdate', fn: (e: { editor: Editor; tr: Transaction }) => void): () => void
    getJSON(): Doc; getHTML(): string; setContent(content: Doc | string): void   // HTML string parse comes in Task 13
    isActive(type: string, data?: Partial<Data>): boolean   // marks: Task 10; elements: block at selection start has type
    getPluginState<S = unknown>(name: string): S
    setPluginOptions(name: string, partial: Record<string, unknown>): void
    readonly view: EditorView | null; mount(el: HTMLElement): void; unmount(): void   // Task 18
    destroy(): void
  }
  ```
  - **Dispatch pipeline:**
    1. Drop the tr if `tr.rejected`; with `dev: true`, throw `Error(tr.rejected)` instead.
    2. Call each plugin's `filterTransaction`; drop the tr if any returns false.
    3. `normalize(tr)`.
    4. Build the new state, including each plugin's `state.apply`.
    5. Emit `transaction`, then `update` if `docChanged`, then `selectionUpdate` if the selection changed.
    6. Call `appendTransaction` for all plugins. Each returned tr goes through the same pipeline, up to 10 rounds.
  - **Content** that is a `Doc` goes through `coerceDoc` + `normalize`. The initial load uses `meta.origin = 'load'` and `addToHistory: false`.
  - `keymap.ts`:
    - `normalizeKeyName(name: string, platform: 'mac' | 'other'): string` turns `'Mod-b'` into `'Ctrl-b'` (other) or `'Meta-b'` (mac). Modifier order is always `Ctrl-Alt-Shift-Meta`.
    - `eventToKeyName(e: KeyboardEvent): string`.
    - `runKeymap` normalizes each plugin's keymap keys once, at construction.
  - `testing/index.ts` re-exports the builders and adds:
    - `createTestEditor(opts: EditorOptions & { doc?: Doc; selection?: Selection })`. It sets `dev: true` and `platform: 'other'`, and resets the id generator to a counter (`n1`, `n2`, …).
    - `stripIds(doc: Doc): unknown`.

- [ ] **Step 1: Write failing tests**

```ts
const counter = definePlugin({ name: 'counter', node: { kind: 'block' },
  state: { init: () => 0, apply: (tr, n: number) => n + (tr.docChanged ? 1 : 0) },
  options: { label: 'x' },
  commands: ctx => ({ readLabel: () => () => ctx.options.label === 'y' }) })
const ed = createTestEditor({ plugins: [testParagraph, counter], doc: doc(el('paragraph', txt('ab'))), selection: sel([0, 0], 2) })
expect(ed.can().readLabel()).toBe(false)
ed.setPluginOptions('counter', { label: 'y' })
expect(ed.commands.readLabel()).toBe(true)
// filterTransaction veto
const veto = definePlugin({ name: 'veto', filterTransaction: tr => !tr.ops.some(o => o.type === 'insert_text') })
// → editor with veto: dispatching an insert_text tr leaves doc unchanged, 'update' not emitted
// appendTransaction runs once per change and its ops land in state
// runKeymap: plugin keymap { 'Mod-k': () => true } → runKeymap('Ctrl-k') === true, runKeymap('Meta-k') === false (platform other)
// handleIntent: plugin onBeforeInput returning true for inputType 'formatItalic' → handleIntent({inputType:'formatItalic', data:null, range:null}) === true
// rejected tr: setNodeData invalid in dev → dispatch throws
expect(normalizeKeyName('Shift-Mod-z', 'mac')).toBe('Shift-Meta-z')
```
Type test: `createTestEditor({ plugins: [testParagraph, counter] }).commands.readLabel` is callable; `.commands.nope` is a type error (`// @ts-expect-error`).

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (the `corePlugin`/`historyPlugin` imports can be stubs that Tasks 9/12 fill). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): headless editor, commands, keymap, test helper`.

---

### Task 9: Text editing — core plugin

**Files:**
- Create: `packages/core/src/transaction/text.ts`, `packages/core/src/core-plugin.ts`
- Modify: `packages/core/src/transaction/transaction.ts` (add methods delegating to `text.ts`)
- Test: `packages/core/test/text.test.ts`

**Interfaces:**
- Produces (Transaction methods):
  - `insertText(text: string, at?: Selection | Range): this`:
    - Deletes the range first.
    - Uses `storedMarks ?? marksAt(point)` (Task 10; until then, the marks of the text at the point).
    - Leaves the caret after the text.
  - `deleteRange(range: Range): this`: works across blocks. It merges the end block's remainder into the start block and removes the blocks in between.
  - `deleteBackward(unit: 'character' | 'word' | 'line' = 'character'): this` and `deleteForward(unit)`:
    - A non-collapsed selection deletes the selection.
    - `character` uses `Intl.Segmenter` grapheme boundaries.
    - `word` uses `Intl.Segmenter` word boundaries.
    - `line` deletes to the block start/end (headless approximation, a spec author's call).
    - At a block boundary, `deleteBackward` merges the block into the previous one and `deleteForward` merges the next block in. Nothing to delete → no ops.
  - `splitBlock(): this`:
    - Deletes the selection first.
    - Splits the block at the caret. The new block gets a fresh id and the same `type` and `data`.
    - At the very end of a non-default block, the new block is the default block with `data {}`.
    - The caret ends at the start of the new block.
- `corePlugin` (name `'core'`, priority 0):
  - **Commands:** `insertText(text)`, `deleteBackward(unit?)`, `deleteForward(unit?)`, `splitBlock()`, `selectAll()`, `setNodeData(path, partial)`.
  - **`onBeforeInput` defaults:**

    | `inputType` | Action |
    |---|---|
    | `insertText`, `insertReplacementText` | insertText into `intent.range` |
    | `deleteContentBackward` | deleteBackward character |
    | `deleteWordBackward` | deleteBackward word |
    | `deleteSoftLineBackward`, `deleteHardLineBackward` | deleteBackward line |
    | `deleteContentForward` | deleteForward character |
    | `deleteWordForward` | deleteForward word |
    | `insertParagraph`, `insertLineBreak` | splitBlock |

    Default trs carry `meta.origin = 'input'` and `meta.inputType`.
  - **Keymap:** `Mod-a` → selectAll.

- [ ] **Step 1: Write failing tests** (via `createTestEditor`, compare with `stripIds`):

```ts
// caret insert
p('ab|')  insertText('c') → p('abc'), caret [0,0]:3
// cross-block range replace
doc(p('ab'), p('cd')) sel([0,0],1,[1,0],1) insertText('X') → doc(p('aXd')), caret [0,0]:2
// merge on backspace at block start
doc(p('ab'), p('cd')) caret [1,0]:0 deleteBackward() → doc(p('abcd')), caret [0,0]:2
// nothing before first block → commands.deleteBackward() returns false, doc unchanged
// Review Focus 1: graphemes
p('a👍🏽') caret end deleteBackward() → p('a')
p('a👨‍👩‍👧') caret end → p('a')
p('xệ') caret end → p('x')
// word
p('hello world') caret end deleteBackward('word') → p('hello ')
// split
p('ab|cd') splitBlock() → doc(p('ab'), p('cd')), second id !== first id, caret [1,0]:0
// Review Focus 2: select all across 3 blocks then type / delete
doc(p('a'), p('b'), p('c')) selectAll() then insertText('X') → doc(p('X'))
doc(p('a'), p('b'), p('c')) selectAll() then deleteBackward() → doc(p('')), caret [0,0]:0
// intents
handleIntent({ inputType: 'insertParagraph', data: null, range: null }) splits the block
```
(`p(...)` is a test-local shorthand for `el('paragraph', ...)`; `|` shows where the selection is set.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): text editing commands and default intents`.

---

### Task 10: Marks

**Files:**
- Create: `packages/core/src/transaction/marks.ts`
- Modify: `transaction.ts` (methods), `core-plugin.ts` (commands), `editor.ts` (`isActive` for marks)
- Test: `packages/core/test/marks.test.ts`

**Interfaces:**
- Produces:
  - **Transaction methods:**
    - `addMark(mark: Mark, range?: Range)`: splits texts at the range edges. A mark of the same type with different data is replaced, so remove + add.
    - `removeMark(type: string, range?: Range)`.
    - `toggleMark(type: string, data?: Data)`: if the mark is active on the whole range, remove it; otherwise add it. On a collapsed selection, it toggles it in `storedMarks`.
    - All three validate `data` through the registry. Invalid data → `rejected`.
  - **Functions:**
    - `marksAt(state: EditorState): Mark[]`: `storedMarks`, else the marks of the text at the caret. At a boundary between two texts, the caret belongs to the end of the previous text (spec author's call).
    - `isMarkActive(state, type, data?): boolean`: a collapsed selection uses `marksAt`; a range needs every non-empty text in it to have the mark.
  - **Core commands:** `toggleMark(type, data?)`, `setMark(type, data?)`, `unsetMark(type)`.

- [ ] **Step 1: Write failing tests**

```ts
// a[bc]d toggle bold → texts 'a', 'bc'(bold), 'd'; toggle again → single 'abcd'
// a[b(bold) c]d partially bold → toggle → 'a', 'bc'(bold), 'd'
// collapsed: toggleMark('bold') → storedMarks [bold], insertText('x') → bold 'x'; then setSelection elsewhere → storedMarks null
// typing at end of bold text inherits bold
// setMark('fontSize', { size: '18px' }) over existing fontSize 12px → only 18px present
// isActive('bold') true/false for full/partial ranges
// marks ordered by registry rank regardless of application order
// invalid mark data in dev → dispatch throws
```
(fontSize here is a test-local mark plugin with a zod schema.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): marks and stored marks`.

---

### Task 11: Fragments (copy/paste model)

**Files:**
- Create: `packages/core/src/transaction/fragment.ts`
- Modify: `transaction.ts`, `core-plugin.ts` (command `insertContent(fragment: Fragment)`)
- Test: `packages/core/test/fragment.test.ts`

**Interfaces:**
- Produces:
  - `type Fragment = Node[]`. If the first node is a block element, it's a block fragment; otherwise it's inline (texts/inline elements).
  - `getFragment(doc: Doc, range: Range): Fragment`: deep-copies the selected content. Partial blocks are trimmed but keep their type and data.
  - `tr.insertFragment(fragment: Fragment, at?: Range): this`:
    - Deletes the range first.
    - **Inline fragment:** inserted at the caret.
    - **Block fragment:** the first block's children are merged into the current block at the caret. The middle blocks are inserted whole. The last block's children are merged with the remainder after the caret.
    - Every inserted element whose id already exists in the doc gets a fresh id (Review Focus 3).
    - The caret ends after the inserted content.

- [ ] **Step 1: Write failing tests**

```ts
getFragment(doc(p('abcd')), range [0,0]:1–[0,0]:3) → [txt('bc')]
getFragment(doc(p('ab'), p('cd')), [0,0]:1–[1,0]:1) → [p('b'), p('c')]   (fresh structure, same ids allowed)
insertFragment([p('X'), p('Y')]) at p('a|b') → doc(p('aX'), p('Yb')), caret [1,0]:1
insertFragment([p('X'), p('M'), p('Y')]) at p('a|b') → doc(p('aX'), p('M'), p('Yb'))
insertFragment([txt('Z', 'bold')]) at p('a|b') → p(txt('a'), txt('Z','bold'), txt('b'))
// Review Focus 3: copy p#n1 and paste it into the same doc → all ids unique
const ids = [...nodeEntries(ed.state.doc)].filter(([n]) => isElement(n)).map(([n]) => (n as ElementNode).id)
expect(new Set(ids).size).toBe(ids.length)
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): fragments and content insertion`.

---

### Task 12: History plugin

**Files:**
- Create: `packages/core/src/history.ts`
- Test: `packages/core/test/history.test.ts`

**Interfaces:**
- Produces: `historyPlugin` (name `'history'`, priority 0). Its `options` are `{ groupDelay: 500, now: () => Date.now() }`.
  - **State:** `{ undo: Entry[]; redo: Entry[] }` with `Entry = { ops: Operation[]; selectionBefore: Selection | null; selectionAfter: Selection | null; time: number; kind: string }`.
  - **Commands:** `undo()`, `redo()`.
  - **Keymap:** `Mod-z` → undo, `Shift-Mod-z` → redo, `Mod-y` → redo.
  - **`onBeforeInput`:** `historyUndo` / `historyRedo`.
  - **Grouping:** a tr merges into the previous entry when both have `origin: 'input'`, the same `kind`, and the time gap is ≤ `groupDelay`. The `kind` comes from `meta.inputType`: insert* → `'insert'`, delete* → `'delete'`, anything else is never grouped.
  - **Trs that only change the selection** are ignored.
  - **Trs with `addToHistory: false` and doc ops** clear both stacks. This is the safe M1 fallback; M2 replaces it with mapping for async image upload.
  - **Undo** dispatches the inverted ops in reverse order, with `origin: 'history'`, and restores `selectionBefore`.
  - **A new non-history change** clears redo.

- [ ] **Step 1: Write failing tests** — use a fake clock via `configure({ now })`:
  - Typing `a`, `b`, `c` within 500 ms, then one undo → empty.
  - Typing `a`, waiting 600 ms, typing `b`, then one undo → `a`.
  - Undo restores the caret.
  - Redo re-applies.
  - An edit after undo clears redo.
  - Selection-only trs don't create entries.
  - A tr with `addToHistory: false` that has doc ops empties the stacks.
  - `runKeymap('Ctrl-z')` undoes.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): history plugin`.

---

### Task 13: HTML parse and serialize

**Files:**
- Create: `packages/core/src/html/serialize.ts`, `packages/core/src/html/parse.ts`
- Modify: `editor.ts` (`getHTML`, string `content`/`setContent`)
- Test: `packages/core/test/html.test.ts` (`// @vitest-environment happy-dom`)

**Interfaces:**
- Produces:
  - `serializeHTML(doc: Doc, registry: Registry, pluginOptions: (name: string) => unknown): string`:
    - Elements go through `renderHTML(node, { options })`.
    - Marks are nested in rank order (lowest rank outermost) using `mark.render`.
    - Text is HTML-escaped.
    - Unknown nodes are skipped (spec §5.2).
  - `parseHTML(html: string, registry: Registry): Fragment`:
    - Uses `DOMParser`.
    - Element rules are tried by `priority` desc, then plugin priority. Mark rules match by `tag` or by `style` (CSS property name, with `getData(el, value)`). `getData` returning `false` means the rule doesn't match.
    - Unknown inline tags are unwrapped. Unknown block-level tags (`div`, `section`, `article`, `li`, `h1`–`h6`, `blockquote`, `pre`) become default blocks, or are unwrapped when they contain blocks.
    - Whitespace-only text between blocks is dropped. Runs of whitespace inside text collapse to one space.
    - The result goes through `coerceDoc` + `normalize` when loading content, or through `insertFragment` when pasting.

- [ ] **Step 1: Write failing tests**

```ts
serialize(doc(p(txt('a'), txt('b', 'bold')))) === '<p>a<strong>b</strong></p>'
serialize(doc(p(txt('<&>')))) === '<p>&lt;&amp;&gt;</p>'
serialize(doc(p(txt('')))) === '<p></p>'
serialize(doc with unknown 'widget' block + p('x')) === '<p>x</p>'
parse('<p>a<b>b</b></p>') → [p(txt('a'), txt('b','bold'))]
parse('<div>x</div>') → [p('x')]
parse('hello') → [p('hello')]   // bare text → default block when loading
parse('<section><p>a</p><p>b</p></section>') → [p('a'), p('b')]
parse('<p>a</p>\n   <p>b</p>') → [p('a'), p('b')]
parse('<p>a   b</p>') → [p('a b')]
editor.setContent('<p>x</p>'); editor.getHTML() === '<p>x</p>'
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): HTML import and export`.

---

### Task 14: `@hte/paragraph` plugin

**Files:**
- Create: `packages/plugins/paragraph/{package.json,tsconfig.json,src/index.ts}`
- Test: `packages/plugins/paragraph/test/paragraph.test.ts`

**Interfaces:**
- Consumes: `definePlugin` from `@hte/core`, test helpers from `@hte/core/testing`.
- Produces: `paragraph = definePlugin({ name: 'paragraph', node: { kind: 'block', default: true, content: 'inline' }, parseHTML: [{ tag: 'p' }], renderHTML: () => ['p', 0], commands: () => ({ setParagraph: () => ... }) })`. `setParagraph()` converts the block at the selection to a paragraph with `data {}`. In M1 it only proves element commands work; the next type-changing block plugin needs it.

- [ ] **Step 1: Write failing tests** — HTML round-trip `<p>a</p><p>b</p>`; `handleIntent(insertParagraph)` at a caret in the middle creates two paragraphs; `setParagraph()` on a test-local `heading` block makes it a paragraph.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(paragraph): paragraph plugin`.

---

### Task 15: `@hte/bold` plugin

**Files:**
- Create: `packages/plugins/bold/{package.json,tsconfig.json,src/index.ts}`
- Test: `packages/plugins/bold/test/bold.test.ts` (happy-dom for the parse cases)

**Interfaces:**
- Produces: `bold = definePlugin({ name: 'bold', ... })` with:
  - `mark: { render: () => ({ tag: 'strong' }) }`.
  - `parseHTML`: `{ tag: 'strong' }`, `{ tag: 'b', getData: el => el.style.fontWeight === 'normal' ? false : {} }`, `{ style: 'font-weight', getData: (_, v) => /^(bold|bolder|[6-9]00)$/.test(v!) ? {} : false }`.
  - Commands `toggleBold()`, `setBold()`, `unsetBold()`.
  - Keymap `{ 'Mod-b': toggleBold }`.
  - `onBeforeInput`: `formatBold` → toggleBold (spec §6.1).

- [ ] **Step 1: Write failing tests** — `toggleBold` on a range; `runKeymap('Ctrl-b')` toggles; `handleIntent({ inputType: 'formatBold', ... })` toggles; parse `<b>`, `<span style="font-weight:700">`, and `<b style="font-weight:normal">` (not bold); serialize to `<strong>`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(bold): bold plugin`.

---

### Task 16: Renderer

**Files:**
- Create: `packages/core/src/view/renderer.ts`
- Test: `packages/core/test/view/renderer.test.ts` (happy-dom)

**Interfaces:**
- Produces:
  ```ts
  class Renderer {
    constructor(root: HTMLElement, editor: Editor)
    render(doc: Doc, opts?: { skipLeaf?: HTMLElement }): void   // keyed patch by element id; skipLeaf is left untouched (composition)
    leafAt(path: Path): HTMLElement | null                      // the <span data-hte-leaf> for a text path
    pathOfLeaf(leaf: Element): Path | null
    elementAt(path: Path): HTMLElement | null
  }
  ```
  **DOM contract:**
  - **Element root:** the first element produced by `renderHTML`, with `data-hte-id="<id>"` added.
  - **Content hole:** where the children go.
  - **Each TextNode:** `<span data-hte-leaf>` containing the mark elements nested in rank order, then the DOM text.
  - **Empty text:** `<span data-hte-leaf><br data-hte-break></span>`.
  - **Unknown element:** `<div data-hte-id data-hte-unknown="<type>" contenteditable="false"></div>`.
  - **Root:** `contenteditable="true"`, `role="textbox"`, `aria-multiline="true"`, `style.whiteSpace = 'pre-wrap'`.

- [ ] **Step 1: Write failing tests**

```ts
render(doc(p#p1(txt('a'), txt('b','bold'))))
root.innerHTML === '<p data-hte-id="p1"><span data-hte-leaf="">a</span><span data-hte-leaf=""><strong>b</strong></span></p>'
render(doc(p#p1(txt('')))) → '<p data-hte-id="p1"><span data-hte-leaf=""><br data-hte-break=""></span></p>'
// keyed: render doc(p#p1('a'), p#p2('b')) then doc(p#p1('a'), p#p2('bc')) → p1's DOM element is the same object
// reorder: swapping p1/p2 reuses both DOM elements
// skipLeaf: leaf text changed in model but leaf passed as skipLeaf keeps old DOM text
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): DOM renderer`.

---

### Task 17: DOM selection mapping

**Files:**
- Create: `packages/core/src/view/dom-selection.ts`
- Test: `packages/core/test/view/dom-selection.test.ts` (happy-dom)

**Interfaces:**
- Produces:
  - `modelToDom(r: Renderer, p: Point): { node: globalThis.Node; offset: number }`. An empty leaf maps to `(leaf, 0)`.
  - `domToModel(r: Renderer, node: globalThis.Node, offset: number): Point | null`:
    - Handles DOM text nodes inside mark wrappers.
    - Handles element containers: a child index is mapped to the nearest leaf boundary.
    - Handles `<br data-hte-break>`.
    - Returns `null` outside the root.
  - `readDomSelection(r, domSel: globalThis.Selection): Selection | null`.
  - `writeDomSelection(r, sel: Selection | null, domSel: globalThis.Selection): void`. It does nothing if the DOM already matches.

- [ ] **Step 1: Write failing tests**
  - `modelToDom({[0,1],1})` → (Text `'b'` inside `<strong>`, 1).
  - `domToModel` on that same node → `{[0,1],1}`.
  - `domToModel(<p>, 1)` → `{[0,1],0}`.
  - `domToModel(br, 0)` → `{[0,0],0}`.
  - `domToModel(outsideNode, 0)` → `null`.
  - `writeDomSelection` then `readDomSelection` round-trips a cross-block selection.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): model/DOM selection mapping`.

---

### Task 18: EditorView glue

**Files:**
- Create: `packages/core/src/view/view.ts`
- Modify: `editor.ts` (`mount`/`unmount`/`view`)
- Test: `packages/core/test/view/view.test.ts` (happy-dom)

**Interfaces:**
- Produces:
  ```ts
  class EditorView {
    constructor(editor: Editor, root: HTMLElement)
    readonly root: HTMLElement; readonly renderer: Renderer
    readonly composing: boolean
    readonly recentInput: ReadonlyArray<{ inputType: string; data: string | null; time: number }>   // ring buffer of 20 (spec §5.6 future Vietnamese plugin)
    update(state: EditorState): void      // render + writeDomSelection when focused
    focus(): void
    destroy(): void                        // removes every listener it added; idempotent
  }
  ```
  - `editor.mount(el)` creates the view. Calling it again on the same element is a no-op; calling it on a different element unmounts first.
  - The view subscribes to `transaction`.
  - On `document` `selectionchange` while the root contains the selection, the view dispatches `setSelection` with `origin: 'selection'` and `addToHistory: false`.
  - Input listeners are attached in Tasks 20–22 through `input.ts`, `composition.ts`, `mutation.ts` and `clipboard.ts`, which `view.ts` wires in.

- [ ] **Step 1: Write failing tests**
  - Mounting renders the doc.
  - `editor.commands.insertText('x')` updates the DOM.
  - Setting the DOM selection and dispatching `selectionchange` updates `editor.state.selection`.
  - `unmount()` empties the listeners: count them with a spy on `addEventListener`/`removeEventListener`.
  - Mounting twice on the same element still renders once.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): editor view`.

---

### Task 19: React adapter

**Files:**
- Create: `packages/react/{package.json,tsconfig.json,src/index.ts,src/use-editor.ts,src/editor-content.tsx,src/use-editor-state.ts}`
- Test: `packages/react/test/react.test.tsx` (happy-dom, `@testing-library/react`)

**Interfaces:**
- Consumes: `Editor`, `EditorOptions`, `AnyPlugin` from `@hte/core`.
- Produces:
  - `useEditor<P>(options: EditorOptions<P> & { onUpdate?: (e: { editor: Editor<P> }) => void }): Editor<P>`:
    - Creates the editor once, in a lazy `useState`.
    - `onUpdate` is held in a ref, so a new callback identity never recreates the editor.
    - It never destroys the editor in effect cleanup (StrictMode-safe). It destroys it only on the final unmount, detected through a ref-counted effect.
  - `EditorContent({ editor, ...divProps }: { editor: Editor } & HTMLAttributes<HTMLDivElement>)`: renders `<div ref>`. A layout effect calls `editor.mount(el)`; its cleanup calls `editor.unmount()`.
  - `useEditorState<T>(editor: Editor, selector: (s: EditorState, editor: Editor) => T, isEqual?: (a: T, b: T) => boolean): T`: uses `useSyncExternalStore` on the `transaction` event.
  - The React package depends on `@hte/core` and has `react` / `react-dom` as peer dependencies.

- [ ] **Step 1: Write failing tests**
  - Rendering `<StrictMode>` with `useEditor` + `EditorContent` puts the paragraph text in the DOM.
  - Dispatching a `beforeinput` `insertText` `'x'` (or calling `handleIntent` through the view) adds exactly one `'x'` (Review Focus 5).
  - `useEditorState(editor, (_, ed) => ed.isActive('bold'))` re-renders from `false` to `true` after `toggleBold` on a range.
  - A component whose selector result doesn't change does not re-render; count renders.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(react): React adapter`.

---

### Task 20: Playground, Playwright, keyboard and beforeinput

**Files:**
- Create: `apps/playground/{package.json,index.html,vite.config.ts,playwright.config.ts,src/main.tsx,src/App.tsx,src/Toolbar.tsx,src/CodePanel.tsx,src/scenarios.ts}`, `apps/playground/e2e/{helpers.ts,typing.spec.ts}`, `packages/core/src/view/input.ts`
- Modify: `packages/core/src/view/view.ts` (wire input)
- Test: `packages/core/test/view/input.test.ts` (happy-dom) + e2e

**Interfaces:**
- `input.ts` attaches these listeners:
  - **`keydown`:**
    1. Plugin `handleDOMEvents.keydown` by priority.
    2. `editor.runKeymap(eventToKeyName(e))`.
    3. If handled → `preventDefault`.
  - **`beforeinput`:**
    1. Record the event in `recentInput`.
    2. Plugin `handleDOMEvents.beforeinput`.
    3. Skip while `composing` or when `inputType === 'insertCompositionText'`.
    4. Build `InputIntent`, with the range from `getTargetRanges()[0]` mapped through `domToModel`, falling back to the current selection.
    5. Call `editor.handleIntent`.
    6. If handled, or if the event is cancelable, call `preventDefault`. This keeps the DOM in sync with the model.
    7. `insertFromPaste`, `deleteByCut` and `insertFromDrop` are handled by Task 22 or prevented (drop comes in M2).
- **Playground:**
  - The `View` and `Code` tabs. `Code` shows `JSON.stringify(editor.getJSON(), null, 2)` and `editor.getHTML()`, updated on every transaction.
  - `Toolbar`: Bold (with `data-active` from `useEditorState`), Undo, Redo.
  - `scenarios.ts`: `empty`, `paragraphs`, `bold`, `pastedHtml` (as HTML content). The picker reloads with `setContent`.
  - `window.editor` is set in dev.
  - Plugins: `paragraph`, `bold`.
- **Playwright:** `playwright.config.ts` uses `webServer: { command: 'pnpm dev --port 5173 --strictPort', port: 5173 }` and the project `chromium` only.
- `e2e/helpers.ts` provides:
  - `getDoc(page)`: `page.evaluate(() => window.editor.getJSON())`.
  - `getText(page)`: the blocks' text joined by `\n`.
  - `focusEnd(page)`.

- [ ] **Step 1: Write failing tests**
  - **Unit:** a cancelable `beforeinput` `insertText` on a mounted view is `defaultPrevented` and inserts into the model. A keydown `Ctrl+b` toggles bold through `runKeymap`. `recentInput` keeps the last 20 entries.
  - **e2e `typing.spec.ts`:**
    - Type `Hello` → text `Hello`.
    - `Enter`, type `World` → two blocks.
    - `Backspace` × 5 at the start of block 2 merges correctly.
    - Select all (`ControlOrMeta+a`), type `X` → single block `X` (Review Focus 2).
    - `ControlOrMeta+b`, type `B` → the last text is bold in the JSON.
    - `ControlOrMeta+z` → undo works.
    - Arrow keys move the caret: type at a moved caret, then check the inserted position.
    - The Bold toolbar button's `data-active` follows the selection.
- [ ] **Step 2:** Run `pnpm vitest run packages/core/test/view/input.test.ts` and `pnpm e2e` → FAIL.
- [ ] **Step 3:** Implement. Install Chromium with `pnpm --filter playground exec playwright install chromium`.
- [ ] **Step 4:** Run both → PASS.
- [ ] **Step 5: Commit** `feat: playground, input handling, e2e typing tests`.

---

### Task 21: IME composition and mutation safety net

**Files:**
- Create: `packages/core/src/view/composition.ts`, `packages/core/src/view/mutation.ts`, `apps/playground/e2e/composition.spec.ts`
- Modify: `view.ts`
- Test: `packages/core/test/view/mutation.test.ts` (happy-dom) + e2e

**Interfaces:**
- `composition.ts`:
  - **`compositionstart`:** set `composing = true` and remember the leaf under the caret. Renders during composition pass `skipLeaf` for that leaf.
  - **`compositionend`:**
    1. Read the leaf's DOM text and diff it with the model text: common prefix/suffix gives one `remove_text` + `insert_text`.
    2. Dispatch with `origin: 'input'`, `inputType: 'insertCompositionText'`.
    3. Set `composing = false`, then re-render normally.
  - If the composition started on an empty leaf (`<br>` replaced by text), it reads the whole leaf text.
- `mutation.ts`: a `MutationObserver` on the root (`characterData`, `childList`, `subtree`).
  - Mutations caused by the renderer are ignored: the renderer sets a flag while it patches.
  - Mutations in the composing leaf during composition are ignored.
  - Any other mutation → re-render the affected blocks from the model (revert), then restore the selection.

- [ ] **Step 1: Write failing tests**
  - **Unit:** mount, set a leaf's DOM text to `'zzz'` directly, `await` a microtask flush → the DOM text equals the model text again, and the model is unchanged.
  - **e2e:**

```ts
const cdp = await page.context().newCDPSession(page)
await focusEnd(page)
await cdp.send('Input.imeSetComposition', { text: 'ê', selectionStart: 1, selectionEnd: 1 })
await cdp.send('Input.imeSetComposition', { text: 'ế', selectionStart: 1, selectionEnd: 1 })
await cdp.send('Input.insertText', { text: 'ế' })
expect(await getText(page)).toBe('ế')
// same flow mid-word in 'ab|c' → 'abếc', caret after ế (type 'x' → 'abếxc')
// composition with CJK '你好' → text '你好'; one undo removes it
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): IME composition and DOM mutation safety net`.

---

### Task 22: Clipboard

**Files:**
- Create: `packages/core/src/view/clipboard.ts`, `apps/playground/e2e/clipboard.spec.ts`
- Modify: `view.ts`
- Test: `packages/core/test/view/clipboard.test.ts` (happy-dom) + e2e

**Interfaces:**
- Produces:
  - `serializeForClipboard(editor: Editor, range: Range): { html: string; text: string; json: string }`:
    - `json` is `JSON.stringify(getFragment(...))`.
    - `html` uses `serializeHTML` on the fragment wrapped as a doc.
    - `text` joins the blocks with `\n`.
  - `parseFromClipboard(editor: Editor, data: { json?: string; html?: string; text?: string }): Fragment`:
    - Tries `json` first (MIME `application/x-hte-fragment`). If parsing fails, it falls through.
    - Then `html` via `parseHTML`.
    - Then `text`: lines become default blocks, a single line becomes an inline text.
    - Finally each plugin's `transformPasted` runs, in priority order.
  - **View listeners:**
    - `copy` / `cut`: set the three MIME types. `cut` also deletes the selection (`origin: 'input'`).
    - `paste`: `preventDefault`, then `insertFragment` with `origin: 'paste'`.

- [ ] **Step 1: Write failing tests**
  - **Unit:**
    - Round-trip: serialize a range with bold, parse the `json` → the same fragment.
    - HTML only `<p>a<b>b</b></p>` → fragment with bold.
    - Text `'x\ny'` → two blocks.
    - A plugin `transformPasted` that uppercases text is applied.
  - **e2e:**
    - Type `abc`, select `bc`, `ControlOrMeta+c`, `End`, `ControlOrMeta+v` → `abcbc`. The context needs clipboard permissions: `permissions: ['clipboard-read', 'clipboard-write']`.
    - Copy across two blocks and paste → block structure preserved, ids unique.
    - Dispatch a synthetic `paste` `ClipboardEvent` whose `DataTransfer` holds `text/html` `<p>x<strong>y</strong></p>` → bold `y` in the JSON.
    - Cut removes the selection.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(core): clipboard`.

---

### Task 23: M1 verification

- [ ] **Step 1:** `pnpm typecheck && pnpm test && pnpm e2e` → all pass.
- [ ] **Step 2:** Run `grep -rE "from ['\"]@hte/core/src|from ['\"]\.\./\.\./core" packages/plugins packages/react` → no matches (the public-API constraint holds).
- [ ] **Step 3:** Run `grep -rE "from ['\"]react" packages/core/src` → no matches.
- [ ] **Step 4:** Open the playground (`pnpm --filter playground dev`) and check by hand:
  - Typing with an OS Vietnamese/Japanese IME on Chromium works (composition path; Unikey is out of scope per the spec).
  - The scenarios load.
  - The Code tab updates live.
- [ ] **Step 5: Commit** any fixes: `chore: M1 verification fixes`.

---

## Deferred to later milestone plans (per spec)

- **M2** (font size, image):
  - Node views in the core and the React adapter: `mount` / `update` / `destroy`, `NodeViewProps`, `<NodeContent />`, view registration.
  - `stopEvent`, `ignoreMutation`, `data-editor-ignore`.
  - Node selection for atom blocks.
  - `insertFromDrop` and file paste.
  - History mapping for `addToHistory: false` doc changes, needed for async upload.
  - Option props in the React adapter.
- **M3** (mention, code block): `inputRules`, decorations, popups and `coordsAt`, `usePluginState`, `serializeClipboard`, and the inline-atom normalization rule (text around inline atoms).
- **M4**: Firefox and WebKit e2e, cross-browser fixes.
- **Not planned yet**: `editor.applyRemote` (spec §5.10 only reserves the place).
