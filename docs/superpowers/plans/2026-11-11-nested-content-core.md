# Nested Content (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `@penline/core` hold and edit blocks inside blocks, driven by ProseMirror-style content expressions, without changing any behaviour on flat documents.

**Architecture:** A new `src/schema/` layer parses each `NodeSpec.content` expression and compiles it to a deterministic content-match automaton held by the `Registry`. Normalization, the `Transaction` transforms (`wrap`, `lift`, `setBlockType`, `split`, `join`), the editing commands (range delete, Backspace/Delete joins, Enter), slices and paste, and HTML parsing all ask that automaton what is allowed instead of assuming flat blocks. The view gains configurable container tags and children-driven node-view updates.

**Tech Stack:** TypeScript, pnpm monorepo, vitest (happy-dom), Playwright (Chromium + WebKit), zod in tests, React 18 in `@penline/react`.

**Spec:** `docs/superpowers/specs/2026-11-11-nested-content-design.md` (read it before any task; section numbers below refer to it).

This plan covers the core only. The container plugins (blockquote, list, toggle, table) and the simpler plugins get their own plans once this lands (§ Next plans).

## Global Constraints

- Every document change is an invertible op; `data` is JSON; validators are synchronous; core never imports React.
- Selection invariants and the per-range step pattern (`forEachRange`, `RangeStep`) apply to every new command and transform; a no-range call inside a `forEachRange` callback throws in dev.
- Flat documents behave byte-identically: `packages/core/test/transaction/single-range-*` and every existing test pass unchanged, except the tests listed in spec §8.
- Core transforms never rely on normalization to repair what they produce: valid result or no ops (spec §5.3).
- An omitted `content` on a non-atom block means `inline*` (breaking in 0.x).
- Unknown types are wildcards in content matching and are never changed by normalization (rule 7).
- `Fragment` and the signatures of `getFragment`, `insertFragment`, `transformPasted` stay unchanged; `Slice` is new.
- Public: `Slice`, `NodeSpec.content/group/marks/isolating`, `registry.isTextblock`, `registry.contentMatch`, `registry.createAndFill`, the new `tr` methods. Automaton internals go to `@penline/core/internal`, and `test/public-api.test.ts` is updated in the same task that adds a name.
- The normalize perf test (`test/normalize*.test.ts` perf case) keeps passing; content checks cost per touched node.
- TDD: a failing test first; never weaken an assertion. Commits are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files explicitly.
- One changeset (`.changeset/nested-content.md`, `@penline/core: minor`) is created in Task 2 and extended by later tasks that change public behaviour.
- Iterate with `pnpm exec vitest run <path>`; run `pnpm typecheck` and `pnpm test` before each commit.

## Review Focus

1. **Termination on hostile trees.** Random invalid nestings (lists in paragraphs in cells in lists) must normalize to a valid doc in bounded passes, never oscillate between wrap and unwrap. Test in Task 3.
2. **Unsatisfiable or cyclic schemas.** `a: 'b+'`, `b: 'a+'`, or a required type whose data schema rejects `{}`, must throw at editor creation with the plugin names, not hang in `createAndFill`. Test in Task 2.
3. **Real-world pasted HTML.** Google Docs / Word lists (`<ul><li><p>a</p></li>text<li>b</li></ul>`, stray text between `<li>`) become a valid list, not lost text. Test in Task 4 (parse) and Task 9 (paste).
4. **Undo exactness after cross-depth edits.** Range delete across a quote and a list, then undo, restores the doc with the same ids and selection. Test in Task 6.
5. **Deep nesting.** 200 nested containers parse, normalize, render and map selections without stack overflow (parse already falls back at `MAX_DEPTH` 256). Test in Task 3 (normalize) and Task 10 (render, DOM mapping).

---

## Test fixtures used by every task

Task 2 adds these to `packages/core/test/fixtures.ts` (alongside `testParagraph`, `testBold`), each a `definePlugin` with no view:

| name | node spec |
|---|---|
| `testQuote` (`quote`) | `{ kind: 'block', content: 'block+' }` |
| `testBulletList` (`bulletList`) | `{ kind: 'block', content: 'listItem+' }` |
| `testListItem` (`listItem`) | `{ kind: 'block', content: 'paragraph block*', group: [] }` |
| `testTable` (`table`) | `{ kind: 'block', content: 'tableRow+' }` |
| `testTableRow` (`tableRow`) | `{ kind: 'block', content: 'tableCell+', group: [] }` |
| `testTableCell` (`tableCell`) | `{ kind: 'block', content: 'block+', group: [], isolating: true }` |
| `testCode` (`code`) | `{ kind: 'block', content: 'text' }` |

`nested = [testParagraph, testBold, testQuote, testBulletList, testListItem, testTable, testTableRow, testTableCell, testCode]`. Tests build docs with `doc`, `el`, `txt`, `sel`, `stripIds` from `src/testing` and a local `p(...)` helper as in `test/transaction/edge-cases.test.ts:11-12`.

---

### Task 1: Content expressions and the automaton

**Files:**
- Create: `packages/core/src/schema/content-expr.ts` (tokenizer + parser to an AST)
- Create: `packages/core/src/schema/content-match.ts` (NFA → DFA, `ContentMatch`)
- Test: `packages/core/test/schema/content-match.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ContentExpr =
    | { kind: 'name'; name: string }
    | { kind: 'seq'; items: ContentExpr[] }
    | { kind: 'choice'; items: ContentExpr[] }
    | { kind: 'repeat'; expr: ContentExpr; min: number; max: number } // max = Infinity for * + {n,}
  function parseContentExpr(source: string): ContentExpr // throws SyntaxError with the source and column

  interface SchemaLookup {
    /** Types a name stands for: [name] for a node type or 'text', the members for a group; undefined if unknown. */
    expand(name: string): readonly string[] | undefined
    /** Whether the core may create this type on its own (data parses from {}, its own content can be filled). */
    autoCreatable(type: string): boolean
    /** The compiled match of a type's own content, for findWrapping. Null for textblocks and atoms. */
    contentOf(type: string): ContentMatch | null
  }
  class ContentMatch {
    readonly validEnd: boolean
    readonly edges: readonly { type: string; next: ContentMatch }[] // in expression order
    matchType(type: string): ContentMatch | null
    /** Matches node types in order; an unknown type (not in `known`) takes this state's first edge. */
    matchTypes(types: readonly string[], known: (type: string) => boolean): ContentMatch | null
    /** Types to insert before `after` so the content matches (and ends validly when toEnd). Null if impossible. */
    fillBefore(after: readonly string[], toEnd: boolean, known: (t: string) => boolean): string[] | null
    /** Wrapper types, outermost first, so `type` fits here (['listItem'] for a paragraph at the start of 'listItem+'). Null if none. */
    findWrapping(type: string): string[] | null
    /** First auto-creatable edge type, or null. */
    readonly defaultType: string | null
  }
  function compileContent(expr: ContentExpr, lookup: SchemaLookup): ContentMatch
  ```

- [ ] **Step 1: Write failing tests** in `test/schema/content-match.test.ts`, with a hand-made `SchemaLookup` (groups `block: [paragraph, quote, bulletList]`, `inline: [text, mention]`):
  - `parseContentExpr('paragraph block*')` gives `seq[name paragraph, repeat(name block,0,∞)]`; `'(a | b){2,3}'`, `'a?'`, `'a+'`, `'a{2,}'` parse; `'a ('`, `'a{3,1}'`, `'|a'` throw `SyntaxError` whose message contains the source.
  - `compileContent(parse('paragraph block*'))`: `matchType('paragraph')!.validEnd === true`; `matchType('quote') === null` at the start; after paragraph, `matchType('quote')` non-null.
  - `fillBefore([], true)` on `'listItem+'` gives `['listItem']`; on `'paragraph block*'` with `after = ['quote']` gives `['paragraph']`; on `'a b'` where `b` is not auto-creatable gives `null`.
  - `findWrapping('paragraph')` from the start of `'listItem+'` gives `['listItem']`; from doc content `'block+'`, `findWrapping('listItem')` gives `['bulletList']`; `findWrapping('tableCell')` from `'block+'` gives `['table','tableRow']`.
  - Wildcard: on `'paragraph block*'`, `matchTypes(['unknownX'], known)` takes the paragraph edge and is `validEnd`.
  - Ambiguity: `'a* a'` compiles (DFA handles it) and matches `['a']` and `['a','a']`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/schema/content-match.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `parseContentExpr`** (recursive descent: choice > seq > postfix > atom).
- [ ] **Step 4: Implement `compileContent`**: Thompson NFA over expanded type names, subset construction to a DFA (states cached by NFA-set key so equal states are one `ContentMatch`). `fillBefore` is a BFS over edges whose types are `autoCreatable`, visiting each state once. `findWrapping` is a BFS over (state, wrapper chain): for each auto-creatable edge type `w` whose `contentOf(w)` start state can `matchType(type)` (directly or recursively), with a visited set on types so cycles end. Write it from the algorithm, not by copying ProseMirror code.
- [ ] **Step 5: Run** the test file — Expected: PASS.
- [ ] **Step 6: Commit** `feat(core): content expressions and content-match automaton`.

### Task 2: Schema fields on NodeSpec and the Registry

**Files:**
- Modify: `packages/core/src/plugin/types.ts:103-108` (`NodeSpec`)
- Modify: `packages/core/src/plugin/registry.ts` (compile, expose)
- Modify: `packages/core/src/internal.ts`, `packages/core/src/index.ts` (types `ContentMatch` internal; nothing new as a value in index)
- Modify: `packages/core/test/fixtures.ts` (fixtures table above)
- Modify: tests whose fixtures declare `node: { kind: 'block' }` and hold nested blocks: `test/fragment.test.ts:9`, `test/editor.test.ts:16,34`, `test/transaction/edge-cases.test.ts:133,328`, `test/load.test.ts:121+` — add `content: 'block+'` (spec §8)
- Create: `.changeset/nested-content.md`
- Test: `packages/core/test/schema/registry-schema.test.ts`, `test/public-api.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseContentExpr`, `compileContent`, `ContentMatch`, `SchemaLookup`.
- Produces:
  ```ts
  interface NodeSpec { kind; atom?; default?; content?: string; group?: string | string[]; marks?: string; isolating?: boolean }
  class Registry {
    /** Compiled match for an element type's content; the doc's ('block+') for 'doc'. Undefined for unknown types and atoms. */
    contentMatch(type: string): ContentMatch | undefined
    /** A known non-atom block whose content matches only inline content. */
    isTextblock(type: string): boolean
    /** Whether `mark` is allowed in the inline content of `type` (from `marks`: '_' all, '' none, names). */
    allowsMark(type: string, mark: string): boolean
    /** Whether `type`'s content allows inline element `inlineType`. */
    allowsInline(type: string, inlineType: string): boolean
    isIsolating(type: string): boolean
    /** A new node of `type` with data parsed from `data ?? {}` and its required content filled; null if impossible. */
    createAndFill(type: string, data?: Data): ElementNode | null
  }
  ```

- [ ] **Step 1: Write failing tests** in `registry-schema.test.ts`:
  - With `nested`: `isTextblock('paragraph')`, `isTextblock('code')` true; `isTextblock('quote')`, `isTextblock('listItem')` false; a block with omitted content is a textblock.
  - `content: 'inline'` equals `'inline*'`; `content: 'text'` equals `'text*'` with `allowsMark('code','bold') === false`; `allowsInline('code','mention') === false`.
  - `createAndFill('bulletList')` (stripIds) is `bulletList > listItem > paragraph > txt('')`; `createAndFill('table')` is `table > tableRow > tableCell > paragraph > txt('')`.
  - `listItem` (group `[]`) is not in `block`: `contentMatch('doc')!.matchType('listItem') === null`.
  - **Review Focus 2:** unknown name in an expression throws `/plugin "x".*unknown node or group "nope"/`; `a: 'b+'`, `b: 'a+'` throws `/cannot be created/` at construction (no hang; wrap in a 2 s vitest timeout); a required type whose data schema rejects `{}` makes the parent not auto-creatable and throws only if the doc content then has no auto-creatable start.
  - `test/public-api.test.ts` lists stay the same values (only types added) — keep it green.
- [ ] **Step 2: Run** `pnpm exec vitest run test/schema` — Expected: FAIL.
- [ ] **Step 3: Implement** in `registry.ts`: build groups (default `block`/`inline`, `text` in `inline`), compile every non-atom node's content once after all nodes are registered, `doc` content `block+`; `autoCreatable` = data parses from `{}` and own content `fillBefore([], true)` is non-null (memoized with an in-progress set to break cycles).
- [ ] **Step 4: Update the fixtures** listed under Files with `content: 'block+'` and run `pnpm test` — Expected: all existing tests PASS (anything else failing means the default changed behaviour; fix the code, not the test).
- [ ] **Step 5: Write the changeset** `.changeset/nested-content.md` (`'@penline/core': minor`): new `NodeSpec` fields; omitted `content` now means inline content only, so a container must declare `content: 'block+'`.
- [ ] **Step 6: Run** `pnpm typecheck && pnpm test` — Expected: PASS. **Commit** `feat(core)!: schema fields and compiled content on the registry`.

### Task 3: Normalization driven by the schema

**Files:**
- Modify: `packages/core/src/normalize.ts` (`fixOne`, `fixElement`, `holdsInline`, `isInlineContent`, `emptyBlock`, rules 1, 2, 5, 8, 9, 10, 11)
- Modify: `packages/core/src/transaction/transaction.ts` (record touched paths if needed for the dirty set)
- Test: `packages/core/test/normalize-content.test.ts`; update `test/normalize.test.ts` cases :46, :113, :161, :173, :183-215 only where spec §8 says (flat cases keep their exact expectations)

**Interfaces:**
- Consumes: `registry.contentMatch`, `isTextblock`, `allowsMark`, `allowsInline`, `createAndFill`, `ContentMatch.fillBefore/findWrapping/matchTypes`.
- Produces: `normalize(tr)` unchanged signature; documents are valid against the schema after it (`isValidDoc(doc, registry): boolean` exported from `src/schema/validate.ts` for tests and dev asserts).

- [ ] **Step 1: Write failing tests** (`normalize-content.test.ts`, plugins `nested`), each asserting `stripIds(editor.getJSON())` after load:
  - `doc(el('bulletList', p('a')))` → `bulletList > listItem > p('a')` (wrap, §5.2 step 3).
  - `doc(el('bulletList'))` → `bulletList > listItem > p('')` (fill; no text leaf in containers).
  - `doc(el('quote', txt('a')))` → `quote > p('a')` (inline run wrapped at depth).
  - `doc(el('listItem', p('a')))` at the root → `bulletList > listItem > p('a')`.
  - `doc(el('tableRow', el('tableCell', p('a'))))` at the root → wrapped in `table`.
  - `doc(p('a', el('quote', p('b'))))` → `p('ab')` (rule 9 unwrap, as today).
  - `doc(el('listItem'…))` inside `code` → its text lifted, structure dropped (§5.2 step 6), with a dev `console.warn` asserted via `vi.spyOn`.
  - Unknown type: `doc(el('bulletList', el('mystery', {}, p('x'))))` stays unchanged, zero normalize ops.
  - `code` with a bold text → bold removed (rule 8 via `marks: ''`).
  - **Review Focus 1:** 200 seeded random trees (a small deterministic PRNG building nests of the fixture types plus texts) all end `isValidDoc` and normalize in < 500 passes each.
  - **Review Focus 5:** a 200-deep `quote` nest normalizes and `isValidDoc` is true.
- [ ] **Step 2: Run** `pnpm exec vitest run test/normalize-content.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement the content rule** in `fixElement`, in the order of spec §5.2 (inline run → `fillBefore` → `findWrapping` → unwrap → hoist atom → drop with text lifted), then the `validEnd` fill; rule 1 becomes the root case. Replace `holdsInline` with "textblock or inline element"; rules 3, 4, 6, 10, 11 use it; rule 8 reads `allowsMark`/`allowsInline`.
- [ ] **Step 4: Make the check incremental**: only elements on the paths touched by the transaction's ops (and their ancestors) are checked, plus everything on load. Run the normalize perf test alone: `pnpm exec vitest run test/normalize-edge.test.ts test/normalize.test.ts` — Expected: PASS.
- [ ] **Step 5: Run** `pnpm test` — Expected: PASS, including all `single-range-*` scenarios with no change to their `.json` files (`git diff --stat test/transaction/*.json` empty).
- [ ] **Step 6: Commit** `feat(core): schema-driven normalization at every depth`.

### Task 4: Text, HTML parse and plain text at depth

**Files:**
- Modify: `packages/core/src/html/parse.ts:172-238` (`Parser.element`, `blockify`)
- Modify: `packages/core/src/content/text.ts:204-211` (`nodeText`)
- Modify: `packages/core/src/content/clipboard.ts:28-58` (text flavor), `packages/core/src/content/sanitize.ts:164-189`
- Test: `packages/core/test/html-nested.test.ts`, `test/content/clipboard.test.ts` (:36, :181 per §8)

**Interfaces:**
- Consumes: Task 2 registry queries; Task 3 normalization.
- Produces: `nodeText(node, registry, options)` joins different textblocks with `'\n'`.

- [ ] **Step 1: Write failing tests**:
  - With a `quote` plugin claiming `blockquote` via `parseHTML`: `parseHTML('<blockquote><p>a</p><p>b</p></blockquote>')` → `quote > p('a'), p('b')`; `'<blockquote>y</blockquote>'` → `quote > p('y')`.
  - Without a claiming plugin, `html.test.ts:162-165` and `:171-174` expectations still hold.
  - With list fixtures claiming `ul`/`li`: **Review Focus 3** `'<ul><li><p>a</p></li>text<li>b</li></ul>'` → `bulletList > [listItem > p('a'), listItem > p('text'), listItem > p('b')]` (no lost text).
  - `nodeText(quote(p('a'), p('b')))` is `'a\nb'`; clipboard text of a list of two items is `'a\nb'`.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement**: `Parser.element` keeps nested blocks for any non-textblock container and wraps inline runs into the position's `defaultType`; `blockify` takes the parent type to choose the wrapper; sanitize stops top-level-only wrapping (normalization does it); `nodeText` inserts `'\n'` between textblocks.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS. **Commit** `feat(core): nested content in HTML parse and plain text`.

### Task 5: Structural transforms on Transaction

**Files:**
- Create: `packages/core/src/transaction/structure.ts`
- Modify: `packages/core/src/transaction/transaction.ts` (methods delegating to `structure.ts`), `packages/core/src/core-plugin.ts` (commands `wrapIn`, `lift`, `setBlockType` with `can()`)
- Test: `packages/core/test/transaction/structure.test.ts`

**Interfaces:**
- Consumes: Task 2 registry; `splitBlockAt` (`transaction/text.ts:782-801`); `forEachRange`/`RangeStep` (`transaction/ranges.ts`).
- Produces (all follow the per-range step pattern; return `boolean` = something changed; `range` optional):
  ```ts
  tr.wrap(type: string, data?: Data, range?: SelectionRange): boolean
  tr.lift(range?: SelectionRange): boolean
  tr.setBlockType(type: string, data?: Data, range?: SelectionRange): boolean
  tr.split(point: Point, depth?: number, typesAfter?: ({ type: string; data?: Data } | null)[]): Point | null
  tr.join(path: Path): boolean   // joins the node at path with its previous sibling
  canWrap(tr, type, range?) / canLift(tr, range?) / canSetBlockType(tr, type, range?) / canJoin(tr, path): boolean  // in structure.ts, used by can()
  /** Depth (ancestor path length) the blocks of the range can be lifted to, or null (ProseMirror liftTarget semantics). */
  liftTarget(doc: Doc, registry: Registry, range: Range): number | null
  ```

- [ ] **Step 1: Write failing tests** (`nested` plugins), each also asserting `isValidDoc` and that `tr` has no ops when the result is false:
  - `wrap('quote')` on `p('a'), p('b')` with a range over both → `quote > [p('a'), p('b')]`; caret preserved.
  - `wrap('bulletList')` on `p('a')` → `bulletList > listItem > p('a')` (inner wrapper from `findWrapping`).
  - `wrap('listItem')` at the root → false (not allowed in `block+`).
  - `lift()` on the middle paragraph of `quote > [p('a'), p('b'), p('c')]` → `quote > p('a'), p('b'), quote > p('c')`.
  - `lift()` on `p('a')` first in `listItem` inside `bulletList` → false, no ops (spec §5.3).
  - `setBlockType('code')` on `p('a', bold)` → `code('a')` with the mark removed; ids of the new node fresh.
  - `split([0,0,0,0], 2)` inside `listItem > p('ab')` at offset 1 → two `listItem`s holding `p('a')` and `p('b')`.
  - `join([1])` on two adjacent `bulletList`s → one list with both items; `join` of a list and a quote → false.
  - Undo of each of the above restores the original doc and selection.
- [ ] **Step 2: Run** `pnpm exec vitest run test/transaction/structure.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `structure.ts` as composites of `insert_node`, `move_node`, `remove_node`, `split_node`, `merge_node` (a dedicated op only if a composite proves unreasonable — then add apply/invert/transform/rebase tests for it). Each method validates the result with the content matches before emitting ops.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS. **Commit** `feat(core): wrap, lift, setBlockType, split and join transforms`.

### Task 6: Range delete across depths

**Files:**
- Modify: `packages/core/src/transaction/text.ts:322-374` (`deleteRangeStep`, the "not siblings" branch at :347-352)
- Test: `packages/core/test/transaction/delete-nested.test.ts`; update `test/transaction/edge-cases.test.ts:365-389` per §8

**Interfaces:**
- Consumes: Task 5 helpers (`liftTarget`, validity checks); Task 2 `isIsolating`.
- Produces: `tr.deleteRange(range?)` unchanged signature; nested semantics of spec §5.3.

- [ ] **Step 1: Write failing tests**:
  - `quote > p('ab')`, `p('cd')`, range from `a|` to `c|` → `quote > p('ad')`.
  - `p('ab')`, `bulletList > [listItem > p('cd'), listItem > p('ef')]`, range `a|` to `e|` → `p('af')` (the emptied list goes).
  - Range spanning two cells of one row → both cells kept, covered text emptied in each, no merge.
  - Range covering a whole `listItem` in the middle of a list → that item removed, list kept.
  - **Review Focus 4:** delete across a quote and a list, then `undo` → `getJSON()` deep-equals the original including ids, and the selection equals the original.
  - Flat cases: the existing `single-range-*` scenarios unchanged.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the replace: remove nodes fully covered at each depth, move the end textblock's children into the start textblock, remove the end textblock and any ancestor left empty that its parent's content allows to go (otherwise refill with `createAndFill`), never crossing or merging an isolating node.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS. **Commit** `feat(core): range delete across nested blocks`.

### Task 7: Backspace, Delete and Enter at container edges; placing new blocks

**Files:**
- Modify: `packages/core/src/transaction/text.ts` (`adjacentBlock` :618-628, `adjacentOpaque` :631-639, `deleteDirectionStep` :687-741, `splitBlockStep` :759-774, `caretNearRemovedBlock`/`emptyDefaultBlock`/`caretAfterNode` :288-402, `insertBlockNodeStep` :460-493, `replaceNodeStep` :415-441)
- Modify: `packages/core/src/view/composition.ts:90-95` (`createAndFill(defaultType)` of the position)
- Test: `packages/core/test/transaction/edges-nested.test.ts`

**Interfaces:**
- Consumes: Task 5 `lift`, `liftTarget`, `join`; Task 2 `createAndFill`, `isIsolating`.
- Produces: `deleteBackward`, `deleteForward`, `splitBlock`, `insertBlockNode`, `replaceSelectedNode` keep their signatures; behaviour per spec §5.3.

- [ ] **Step 1: Write failing tests**, one per numbered rule in spec §5.3:
  - Backspace at start of `p('a')` first in `quote` → lifted: `p('a')` before the quote.
  - Backspace at start of `p('c')` after `quote > p('ab')` → `quote > p('abc')`.
  - Backspace at start of `p('a')` first in `listItem` → no ops (lift invalid, no plugin override).
  - Backspace at start of an empty `p('')` after a `table` → paragraph removed, caret at end of the last cell; non-empty `p('x')` → caret moves to the end of the last cell, doc unchanged.
  - Backspace at start of the first paragraph in a cell → no ops.
  - Delete at the end of `p('ab')` before `quote > p('cd')` → `p('abcd')`, quote removed if empty; before a table → mirror of the table rule.
  - Enter in empty `p('')` inside `quote > [p('a'), p('')]` → `quote > p('a')`, `p('')` after it; Enter in an empty paragraph in a `listItem` → plain split (lift invalid).
  - Enter at the end of a textblock whose parent forbids the default block after it → the new block takes the position's `defaultType`.
  - `insertBlockNode(table)` with the caret in a paragraph inside a `tableCell` → inserted after that paragraph in the cell (cell allows `block+`); `insertBlockNode(listItem)` with the caret in a root paragraph → wrapped in `bulletList`.
  - Multi-range: two carets at starts of two quote-first paragraphs, Backspace → both lifted, one `set_selection`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the rules in order; every default block the code creates comes from `createAndFill` of the position's `defaultType`.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS (parity JSON untouched). **Commit** `feat(core): Backspace, Delete and Enter across container edges`.

### Task 8: isActive inside containers

**Files:**
- Modify: `packages/core/src/editor.ts:458-469` (`isActive`), `:711-717` (`blockAt`)
- Test: `packages/core/test/editor-nested.test.ts`

**Interfaces:**
- Produces: `editor.isActive(type)` true when any ancestor of the main range start (or the textblock) is `type`; marks unchanged.

- [ ] **Step 1: Write failing tests**: caret in `bulletList > listItem > p('a')` → `isActive('bulletList')`, `isActive('listItem')`, `isActive('paragraph')` all true, `isActive('quote')` false. Flat `isActive('paragraph')` unchanged.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the ancestor walk. **Step 4: Run** `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(core): isActive checks container ancestors`.

### Task 9: Slices, paste and clipboard context

**Files:**
- Create: `packages/core/src/transaction/slice.ts` (`getSlice`, fitter, `insertSlice`)
- Modify: `packages/core/src/transaction/fragment.ts` (`insertFragment` → `insertSlice` with today's open depths; drop the `isContainer` heuristic), `packages/core/src/transaction/transaction.ts` (methods), `packages/core/src/content/clipboard.ts` (MIME JSON with open depths; HTML wrapped in ancestors), `packages/core/src/view/clipboard.ts` + `view/drop.ts` (paste path on slices), `packages/core/src/editor.ts` (`transformPasted` gets `slice.content`)
- Modify: `packages/core/src/index.ts` (`export type { Slice }`), `test/public-api.test.ts` if a value is added
- Test: `packages/core/test/transaction/slice.test.ts`, `test/content/clipboard-nested.test.ts`; update `edge-cases.test.ts:138-157` per §8

**Interfaces:**
- Produces:
  ```ts
  interface Slice { content: Fragment; openStart: number; openEnd: number }
  tr.getSlice(range?: Range): Slice
  tr.insertSlice(slice: Slice, range?: SelectionRange): boolean
  ```

- [ ] **Step 1: Write failing tests**:
  - `getSlice` across `ab|c` in item 1 to `d|ef` in item 2 → content `[listItem > p('c'), listItem > p('d')]`, `openStart 2`, `openEnd 2`.
  - Pasting that slice into `p('x|y')` in another list item → `listItem > p('xc'), listItem > p('dy')` in that list.
  - Pasting it into a root `p('x|y')` → a list is created (spec §5.4): `p('x'), bulletList > [listItem > p('c'), listItem > p('d')], p('y')`.
  - A table slice pasted into a cell → the table nests in the cell (`block+`).
  - `insertFragment(f)` on flat fragments → identical ops to today (`single-range-fragment-*` untouched).
  - `transformPasted` receives `slice.content`; returning fewer nodes clamps the open depths (no throw).
  - Clipboard: HTML of the two-item slice is `<ul><li><p>c</p></li><li><p>d</p></li></ul>`; MIME JSON round-trip keeps open depths; an old payload without depths pastes as today.
  - **Review Focus 3:** pasting `'<ul><li><p>a</p></li>text<li>b</li></ul>'` HTML into a root paragraph gives a valid list with all three texts.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the fitter in `slice.ts`: close the open start into the target textblock, place whole nodes where `matchType` accepts them (wrap with `findWrapping`, else unwrap one level and retry), close the open end into the textblock after the cut, validate before emitting ops.
- [ ] **Step 4: Run** `pnpm test` — Expected: PASS. **Commit** `feat(core): slices with open depths for copy and paste`.

### Task 10: View and React for containers

**Files:**
- Modify: `packages/core/src/plugin/types.ts` (node view spec: `as?: string`, `contentAs?: string`), `packages/core/src/view/renderer.ts:611-633`, `packages/core/src/view/node-view.ts:66-100`
- Modify: `packages/react/src/node-content.tsx` (`as` prop), `packages/react/src/node-views.tsx` (pass `as`/`contentAs` through)
- Test: `packages/core/test/view/nested-render.test.ts`, `packages/react/test/node-content-nested.test.tsx`

**Interfaces:**
- Produces: node views may set container tag `as` and content tag `contentAs` (defaults `div`/`span` as today); `<NodeContent as="tbody" />`; a node view of a non-textblock container gets `update` on any change of its node, children included.

- [ ] **Step 1: Write failing tests**:
  - A `table` node view with `as: 'table'`, `contentAs: 'tbody'`, rows rendered by `renderHTML` `tr`/`td` → DOM is `table > tbody > tr > td > p`, no `div` inside `tbody`.
  - Typing in a cell maps DOM selection to the right model point (`readDomSelection` after placing the caret in the cell's text).
  - A `bulletList` node view counting items re-renders when an item is added (its `update` called with the new node).
  - A paragraph node view is not updated by a sibling change (today's rule kept).
  - **Review Focus 5:** a 200-deep quote renders and `modelToDom`/`domToModel` round-trip a caret in the innermost paragraph.
  - React: `<NodeContent as="tbody" />` renders a `tbody` placeholder holding the core's `contentDOM`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/view/nested-render.test.ts` and the React test — FAIL.
- [ ] **Step 3: Implement**. **Step 4: Run** `pnpm test` — PASS.
- [ ] **Step 5: Commit** `feat(core,react): container tags and children updates for node views`.

### Task 11: Multi-range parity, docs and the release note

**Files:**
- Create: `packages/core/test/transaction/nested-multi-range.test.ts`
- Modify: `docs/plugin-api.md` (`node` section: `content` grammar, `group`, `marks`, `isolating`; `Slice`; the new `tr` methods), `docs/plugin-authoring.md` (container node views: `as`, `contentAs`, children updates), `docs/architecture.md` (nested content now supported), `README.md` (no change unless an example breaks), `.changeset/nested-content.md` (final text), `CLAUDE.md` core map (`schema/`, `structure.ts`, `slice.ts`)

- [ ] **Step 1: Write the parity tests**: for `deleteRange`, `deleteBackward`, `deleteForward`, `splitBlock`, `wrap`, `lift`, `insertSlice` on nested docs, running each command with two ranges gives the same result as running it on each range alone in sequence (mapped), as `single-range-*` does for flat docs.
- [ ] **Step 2: Run** — Expected: PASS (fix code if not).
- [ ] **Step 3: Update the docs** listed above.
- [ ] **Step 4: Run** `pnpm typecheck`, `pnpm exec vitest --typecheck run`, `pnpm test`, `pnpm build`, and `pnpm --filter playground e2e` — Expected: all PASS (e2e unchanged: no playground plugin is nested yet).
- [ ] **Step 5: Commit** `docs: nested content` (with the test file).

---

## Next plans (after this one merges)

Each is its own plan, executed by its own subagent in parallel, in its own worktree branched from the merged core:

- `@penline/blockquote`, `@penline/list` (bullet, ordered, task), `@penline/toggle`, `@penline/table` — spec §5.6; each with a playground story and e2e on Chromium + WebKit.
- Simple plugins that do not need nesting, can start any time: italic, strikethrough, link, divider, tag, button, slash menu, combo box, multi check, chart.
- The block handle with an icon menu (Notion/ClickUp rows): its own design first.
