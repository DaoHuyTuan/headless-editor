# Multi-selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-range `Selection` with a list of ranges in the core model. Make every core editing command and every built-in plugin act on all ranges, in one transaction and one undo step.

**Architecture:** The work is staged in three phases.
- **Type switch:** first the new selection module and its normalization (Task 1). Then a mechanical switch of every call site to `{ ranges, main }` that acts on the main range only. Behaviour stays identical and all existing suites pass (Task 2).
- **Infrastructure:** next, the mapping and normalization of ranges (Task 3) and the `forEachRange` primitive (Task 4).
- **Behaviour:** finally each layer becomes multi-range aware behind its own tests (Tasks 5–11), followed by docs, e2e smoke and verification (Task 12).

**Tech Stack:** TypeScript, Vitest (happy-dom), React 18, Playwright (Chromium, WebKit), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-03-multi-selection-design.md`. It is authoritative, and its §8 "Calls I made" is binding. Background: `docs/architecture.md` §4a.

## Global Constraints

**Project rules**
- Core is framework-free.
- Document changes go through invertible ops.
- `data` is JSON.
- `filterTransaction` never vetoes history (`origin === 'history'`).
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Selection shape**
- The shape is `interface SelectionRange { anchor: Point; focus: Point; node?: Path }` and `interface Selection { ranges: SelectionRange[]; main: number }`.
- `ranges` is never empty, sorted by document position, and non-overlapping. Touching ranges merge.
- There is no compatibility accessor: no top-level `selection.anchor`.
- A node range is always the only range.

**Behaviour that must not change**
- With a single range, behaviour is identical to today.
- The existing ~1,017 unit tests, the type tests, and the e2e suites (Chromium 85, WebKit 65) keep passing. They may be adjusted only for the new type shape, never in behaviour.

**Commands and the view**
- No command or plugin silently ignores a secondary range. When a command acts on the main range on purpose, its JSDoc says so.
- Edits at N ranges form one transaction and one undo step. The exception is input rules, which keep today's two steps: typing, then the rules.
- The document view writes only the main range to the DOM. A user `selectionchange`, IME `compositionstart`, or a `beforeinput` intent whose target range differs from the main range collapses the selection to one range.

**Tooling**
- `pnpm exec vitest run <path>`, `pnpm test`, `pnpm typecheck`, `pnpm exec vitest --typecheck run`.
- e2e: use `pnpm --filter playground e2e:chromium` and `e2e:webkit`. Run them through a temporary, uncommitted copy of the config on port 5175 if 5174 is busy. Never kill processes on 5173 or 5174.

## Review Focus

1. **Range order inside one transaction.** Two carets in the same text, where the edit at the earlier caret changes the offsets of the later one. Each later caret must land after its own insert or delete, not after the earlier one's. This applies to Task 4 and to every task that uses `forEachRange`.
2. **Carets that merge.** Backspace at two adjacent carets, or a delete that swallows another range, must merge them into one range. The selection must never hold duplicates, and `main` must stay valid (Tasks 3, 5).
3. **Undo restores the exact selection.** After a multi-range edit, one undo must restore every range and `main`, and redo must restore the after-state. This must also hold after a history rebase (Task 9).
4. **The single-caret path stays the same.** Every existing suite passes. The new multi-range code must not change op sequences for a single range: history grouping and IME depend on them (Tasks 2–8).
5. **Node selection meets multi-range.** Setting a node range together with text ranges keeps only the node range. Backspace next to an image with several carets moves no caret and drops no range (Tasks 1, 5).

---

### Task 1: Selection module and normalization

**Files:**
- Create: `packages/core/src/model/selection.ts`
- Test: `packages/core/test/selection/multi.test.ts`

**Interfaces:**
- Produces, in `model/selection.ts`:
  - `type SelectionRange = { anchor: Point; focus: Point; node?: Path }`
  - `type MultiSelection = { ranges: SelectionRange[]; main: number }`. This is a temporary name; Task 2 renames it to `Selection`.
  - `function single(range: SelectionRange): MultiSelection`
  - `function createSelection(ranges: SelectionRange[], main?: number): MultiSelection`, which normalizes (§5.3 of the spec). It throws on an empty `ranges`.
  - `function mainRange(sel: MultiSelection): SelectionRange`
  - `function rangeEquals(a: SelectionRange, b: SelectionRange): boolean`
  - `function selectionEquals(a: MultiSelection | null, b: MultiSelection | null): boolean`, which compares the ranges and `main`.
  - `function isNodeRange(r: SelectionRange): r is SelectionRange & { node: Path }`

- [ ] **Step 1: Write the failing tests** (`describe('createSelection')`):
  - `sorts ranges by document position and keeps main on the same range`: input carets at `[0,0]:5` (main) and `[0,0]:1` give `ranges[0]` at offset 1, `ranges[1]` at offset 5, and `main === 1`.
  - `merges overlapping ranges`: `[0,0]:1–4` and `[0,0]:3–6` give one range `1–6`.
  - `merges touching ranges`: `1–3` and `3–5` give `1–5`. Two carets at the same point give one caret.
  - `a caret inside a range is absorbed`.
  - `main follows the merged range that contains the old main`.
  - `a node range drops the other ranges`: a node range together with two carets gives `ranges.length === 1` and `isNodeRange(ranges[0])`.
  - `keeps anchor/focus direction of a backward range when not merged`.
  - `throws on an empty list`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/core/test/selection/multi.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `model/selection.ts`, using `comparePoint` from `model/path.ts`. Merging works on `[min(anchor, focus), max(anchor, focus)]`. A merged range takes the direction of the range that held `main`, or forward otherwise.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): multi-range selection module`.

### Task 2: Switch `Selection` to the multi-range shape (behaviour unchanged)

**Files:**
- Modify:
  - `packages/core/src/model/types.ts`: `Selection` becomes the Task 1 shape, and `SelectionRange` is added.
  - `model/selection.ts`: drop the `MultiSelection` alias.
  - Every compile error site across `packages/core/src`, `packages/react/src`, `packages/plugins/*/src` and `apps/playground/src` (about 35 files), plus every test that writes a selection literal (about 77 sites).
- Test: the existing suites, unchanged in behaviour.

**Interfaces:**
- Produces:
  - `Selection` and `SelectionRange` exported from `@hte/core`, together with `single`, `createSelection`, `mainRange` and `isNodeRange`.
  - The ops: `{ type: 'set_selection'; selection: Selection | null; prevSelection: Selection | null }`.
  - `InputIntent.range: SelectionRange | null`.
  - `isNodeSelection(sel: Selection | null | undefined): boolean`, which is true when the single range is a node range.
  - `nodeSelection(...)` and `firstEditableCaret(...)` return a `Selection`, built with `single(...)`.
  - The testing helpers in `packages/core/src/testing` build selections through `single`.

- [ ] **Step 1:** Change the types, then run `pnpm typecheck` and record the error list. Expected: FAIL, with the call-site list.
- [ ] **Step 2: Migrate every site to act on `mainRange(sel)`**, with today's single-range logic.
  - Do not add multi-range behaviour here.
  - At each site that will later become multi-range aware, leave nothing behind: no TODOs. Tasks 3–11 list the sites they own.
  - In tests, wrap each selection literal in `single(...)`.
- [ ] **Step 3:** Run `pnpm typecheck`, `pnpm test` and `pnpm exec vitest --typecheck run`. Expected: all PASS. The test count must equal the count before the change.
- [ ] **Step 4:** Run `pnpm --filter playground e2e:chromium`. Expected: 85 passed.
- [ ] **Step 5:** Commit `refactor(core)!: Selection is a list of ranges`.

### Task 3: Map and normalize every range

**Files:**
- Modify:
  - `packages/core/src/ops/transform.ts`: `transformSelection`.
  - `packages/core/src/transaction/transaction.ts`: `apply`, `setSelection`.
  - `packages/core/src/normalize.ts`: `rehomeSelection` and the empty-text cleanup, around lines 280–310.
  - `packages/core/src/editor.ts`: where a committed selection is validated (`contentTransaction`, `applyTransaction`).
- Test: `packages/core/test/selection/multi-mapping.test.ts`

**Interfaces:**
- Consumes: `createSelection` from Task 1.
- Produces:
  - `transformSelection(sel: Selection, op: Operation, affinity?): Selection | null` maps each range on its own. A range that cannot be mapped is dropped. The function returns `null` only when every range is dropped. The result is normalized with `createSelection`.
  - `Transaction.setSelection(sel)` normalizes `sel` before applying it.
  - After normalization, each committed selection is validated per range. A range that is not at an editable point is moved to the nearest editable point, using the `rehomeSelection` rule. It is dropped only if no such point exists.

- [ ] **Step 1: Write the failing tests:**
  - `maps every range through an insert before them`: carets at offsets 2 and 6, then an `insert_text` of 2 chars at offset 0, give 4 and 8.
  - `a range in a removed text node is rehomed, others kept`: removing the paragraph that holds the second caret keeps the first caret. The second caret moves to the nearest editable point, and `ranges.length` is 2, or 1 if it merged.
  - `null only when every range is gone`.
  - `carets that collide after mapping are merged`.
  - `setSelection normalizes`: two identical carets give one.
  - `normalize's empty-text cleanup maps every range`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3: Implement.** The single-range results must stay identical. Run the existing selection and normalize suites.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): map and normalize every selection range`.

### Task 4: `forEachRange` primitive and stored marks

**Files:**
- Create: `packages/core/src/transaction/ranges.ts`
- Modify: `packages/core/src/transaction/transaction.ts`, with a `forEachRange` method and the stored-marks rule. Export it from `packages/core/src/index.ts`.
- Test: `packages/core/test/transaction/for-each-range.test.ts`

**Interfaces:**
- Produces:
  - `tr.forEachRange(fn: (range: SelectionRange, tr: Transaction) => SelectionRange | null): this`. It runs `fn` once per range, in document order. Before each call it maps the range through the ops added since the call started. It collects the returned ranges (`null` drops that range) and sets the selection to `createSelection(results, mainIndex)`, where `mainIndex` is the result index of the old main range.
  - `tr.inForEachRange: boolean` (readonly), which is true during a callback.
  - Stored marks are not cleared by selection moves made inside `forEachRange`. After the run they are kept if the run made a doc change at the carets, by the same rule as a single `insertText` today.

- [ ] **Step 1: Write the failing tests:**
  - `later ranges see earlier inserts`: carets at 1 and 3 in `abcd`, with a callback that inserts `X` at each range, give `aXbcXd` and carets at 2 and 5.
  - `later ranges see earlier deletes`.
  - `null drops a range`.
  - `main is preserved`.
  - `one transaction`: `tr.ops` contains the edits and one final `set_selection`.
  - `stored marks survive the per-range caret moves`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Track the op count at the start of each callback and map the next range through `tr.ops.slice(start)`.
- [ ] **Step 4:** Run the test and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): forEachRange`.

### Task 5: Text editing on every range

**Files:**
- Modify: `packages/core/src/transaction/text.ts` (`insertText`, `deleteRange`, `deleteBackward`, `deleteForward`, `splitBlock`, `insertBlockNode`, `selectAll`, `replaceSelectedNode`) and `packages/core/src/transaction/transaction.ts` (the method wrappers).
- Test: `packages/core/test/transaction/multi-text.test.ts`

**Interfaces:**
- Consumes: `forEachRange` from Task 4.
- Produces:
  - Every listed method, called with no explicit `at`/range, runs over every range through `forEachRange`.
  - With an explicit `at`, a method acts there only. Other ranges are mapped, not collapsed.
  - A no-range call while `tr.inForEachRange` is true throws in dev mode (`editor` option `dev`), and is otherwise treated as the callback's range.
  - `selectAll` collapses to one range.

- [ ] **Step 1: Write the failing tests** (two- and three-caret variants):
  - `insertText types at every caret`: `foo bar foo` with carets after both `foo` → `foox bar foox`.
  - `insertText replaces every non-empty range`.
  - `deleteBackward at every caret`.
  - `deleteBackward word unit at every caret`.
  - `deleteBackward at adjacent carets merges them`: carets at 2 and 3 in `abcd` → `ad` with a single caret at offset 1.
  - `Backspace next to an opaque block with several carets leaves that caret in place and deletes at the others`. This is Review Focus 5. Assert that `ranges.length` is unchanged and that there is no node range.
  - `with one caret, Backspace next to an opaque block still node-selects`: a regression check.
  - `splitBlock at two carets in one block gives three blocks, carets at the starts of blocks 2 and 3`.
  - `explicit at acts only there and maps the other caret`.
  - `no-range call inside forEachRange throws in dev`.
  - `selectAll collapses to one range`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Each method's body becomes the per-range step, and the no-range entry point wraps it in `forEachRange`.
- [ ] **Step 4:** Run the test, `pnpm test` and `pnpm --filter playground e2e:chromium`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): text editing on every selection range`.

### Task 6: Marks on every range

**Files:**
- Modify: `packages/core/src/transaction/marks.ts` (`addMark`, `removeMark`, `toggleMark`, `isMarkActive`, `marksAt`, `marksOfRange`) and `packages/core/src/editor.ts` (`isActive`).
- Test: `packages/core/test/transaction/multi-marks.test.ts`

**Interfaces:**
- Produces:
  - `toggleMark` computes activity over every range. If every range has the mark, it removes it everywhere; otherwise it adds it everywhere.
  - With all ranges collapsed, toggling sets stored marks once for the whole selection.
  - `isMarkActive` and `editor.isActive` are true only if every range has the mark.
  - The next insert applies the stored marks at every caret.

- [ ] **Step 1: Write the failing tests:**
  - `toggleMark adds everywhere when one range lacks it`.
  - `toggleMark removes everywhere when all have it`.
  - `isActive is false when one range lacks the mark`.
  - `toggle at two carets, then type, makes both inserts bold`.
  - `addMark/removeMark act on every non-empty range`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the test and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): marks on every selection range`.

### Task 7: Fragments, paste and drop on every range

**Files:**
- Modify:
  - `packages/core/src/transaction/fragment.ts`: `insertFragment`, `insertInlineNode`, and `replaceSelectedNodeWithBlocks` (stays a single node range).
  - `packages/core/src/core-plugin.ts`: `insertTransfer` and the `insertContent` command.
  - `packages/core/src/view/drop.ts`.
- Test: `packages/core/test/transaction/multi-fragment.test.ts`

**Interfaces:**
- Produces:
  - `insertFragment(tr, fragment)` with no `at` inserts the same fragment at every range. Each copy gets fresh ids, through the existing id-uniqueness step run per insert.
  - A paste intent goes to every range.
  - A drop goes to its drop point only, and the selection collapses to one range there.
  - `insertInlineNode` inserts at every range.

- [ ] **Step 1: Write the failing tests:**
  - `paste text at two carets`.
  - `paste blocks at two carets keeps order at each`.
  - `every inserted copy has unique ids`.
  - `insertInlineNode at every caret`.
  - `drop collapses to the drop point`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the test, `pnpm test` and the Chromium clipboard and image e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): paste and fragments on every selection range`.

### Task 8: Input pipeline, IME, input rules and view

**Files:**
- Modify:
  - `packages/core/src/core-plugin.ts`: intents. An intent whose range differs from the main range applies only at the intent's range and collapses.
  - `packages/core/src/input-rules.ts` and `packages/core/src/editor.ts`: `runInputRules` runs per caret on one shared rule tr.
  - `packages/core/src/view/composition.ts`: `compositionstart` collapses to the main range first.
  - `packages/core/src/view/dom-selection.ts`: write the main range, and read a single range.
  - `packages/core/src/view/view.ts`: `selectionchange` collapses.
- Test: `packages/core/test/view/multi-input.test.ts` and `packages/core/test/input-rules.test.ts`

**Interfaces:**
- Produces:
  - `runInputRules` checks each collapsed caret on its own. At each caret, the first matching rule wins. All firings share one tr with meta `inputRule: true`, and each handler gets its `range` mapped through earlier firings.
  - A `tr.setSelection` inside a rule handler throws in dev mode when there is more than one range.
  - With one caret, the ops and history steps are identical to today.

- [ ] **Step 1: Write the failing tests:**
  - `typing intent at two carets inserts at both`.
  - `insertReplacementText with its own range applies there only and collapses`.
  - `compositionstart with two carets collapses to main and the composition lands at main`.
  - `input rule fires at both carets in one rule step; one undo reverts both rules, keeps typed text`.
  - `input rule fires at one caret only; the other caret is untouched`.
  - `selectionchange collapses to one range`.
  - `writeDomSelection writes the main range`.
  - `a plugin can draw secondary ranges from state.selection.ranges via decorations`, as a widget decoration per secondary caret.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests, `pnpm test`, and `pnpm --filter playground e2e:chromium` (composition specs included). Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): multi-range input, IME and input rules`.

### Task 9: History and rebase with full selections

**Files:**
- Modify: `packages/core/src/history.ts` and `packages/core/src/ops/rebase.ts`, where selections are mapped.
- Test: `packages/core/test/history.test.ts`

**Interfaces:**
- Produces:
  - Entries store the full `Selection` before and after the change.
  - Rebasing an entry drops it if any range fails to map.
  - Normalization ops folded into neighbouring entries keep the full selection.

- [ ] **Step 1: Write the failing tests:**
  - `undo restores every range and main after a two-caret edit`.
  - `redo restores the after-selection`.
  - `typing at two carets within groupDelay groups into one step`.
  - `rebase maps every range through an outside insert`.
  - `rebase drops an entry when one range cannot map`.
  - Extend the seeded history fuzz: random two- or three-caret edits, with undo-all and redo-all restoring the exact docs and selections.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): history keeps full selections`.

### Task 10: Code block and font-size

**Files:**
- Modify: `packages/plugins/code-block/src/index.ts` and `packages/plugins/font-size/src/index.ts`.
- Test: `packages/plugins/code-block/test/code-block.test.ts` and `packages/plugins/font-size/test/*.test.ts`

**Interfaces:**
- Consumes: `forEachRange`, the multi-range `tr` methods.
- Produces, per spec §5.5:
  - Tab and Shift-Tab work per range. A line touched by two ranges is indented once.
  - Enter, Shift-Enter and the line-break intents work per caret. The triple-Enter exit happens only for a caret at the end of a block that ends in `\n\n`.
  - `setCodeBlock`, `exitCodeBlock` and `setLanguage` act on every distinct block that holds a range.
  - Font-size with mixed sizes across ranges reports `''`.

- [ ] **Step 1: Write the failing tests:**
  - `Tab at two carets in different blocks indents both`.
  - `Tab with two ranges on the same line indents it once`.
  - `Enter at two carets inserts two newlines`.
  - `triple-Enter exits only at the caret at a \n\n end`.
  - `setCodeBlock converts every block with a range`.
  - `setLanguage updates every code block with a range`.
  - `font-size reports mixed across ranges`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests, `pnpm test` and the Chromium code-block e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(code-block,font-size): multi-range commands`.

### Task 11: Mention and image

**Files:**
- Modify: `packages/plugins/mention/src/index.ts`, `packages/plugins/mention/src/react.tsx` (if it reads the selection), `packages/plugins/image/src/index.ts` and `packages/plugins/image/src/react/hooks.ts`.
- Test: `packages/plugins/mention/test/mention.test.ts` and `packages/plugins/image/test/image.test.ts`

**Interfaces:**
- Produces, per spec §5.5:
  - **Mention:**
    - The trigger, query and popup coordinates use the main caret.
    - `acceptSuggestion` and `insertMention` replace the trigger at every caret whose text before the caret matches the main caret's trigger plus query. Other carets are untouched.
    - `range` and `dismissedAt` map through the multi-range `transformSelection`.
  - **Image:**
    - `insertImage` inserts at every range.
    - A file upload with N ranges uploads once and inserts N previews that share the blob URL, all tracked as copies of one upload. They are finalized, or removed together on failure. The M4 failure-history rule (missing ids checked before removal) applies to all of them.

- [ ] **Step 1: Write the failing tests:**
  - `accept inserts at every caret with the same @query`.
  - `accept leaves a caret without the trigger untouched`.
  - `popup coords follow the main caret`.
  - `insertImage at two carets`.
  - `upload with two carets uploads once and finalizes both previews`.
  - `upload failure removes both previews; an unrelated later entry survives`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the tests, `pnpm test`, and the Chromium mention and image e2e. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mention,image): multi-range commands`.

### Task 12: Docs, e2e smoke, performance and verification

**Files:**
- Modify:
  - `docs/plugin-api.md`: the `Command`/`tr` sections, `forEachRange`, multi-range defaults, the `Selection` shape, and the JSDoc rule "main range on purpose".
  - `docs/plugin-authoring.md`
  - `docs/architecture.md`: mark §4a as implemented.
  - `README.md`, if a sample reads the selection.
  - `packages/plugins/image/test/docs-examples.test-d.tsx`: add a `forEachRange` sample.
- Create: `apps/playground/e2e/multi-selection.spec.ts`
- Test: `packages/core/test/transaction/multi-perf.test.ts`

- [ ] **Step 1: Add the e2e smoke test** `typing at two carets set through window.editor inserts at both; Ctrl+Z restores`. It uses real keys. Run it on chromium and webkit with `--repeat-each=3`. Expected: PASS.
- [ ] **Step 2: Add the perf test** `100 carets typing one character stays under 16 ms`. Warm up, then take the best of 5. The spec calls this a target, not a hard requirement: if it fails, record the measured time in the report and in the follow-ups instead of failing the suite.
- [ ] **Step 3: Update the docs.** Run `pnpm typecheck` and `pnpm exec vitest --typecheck run`. Expected: PASS.
- [ ] **Step 4: Full verification:** `pnpm typecheck`, `pnpm test`, `pnpm exec vitest --typecheck run`, then the full chromium and webkit e2e. Expected: all pass. WebKit keeps its documented skips.
- [ ] **Step 5:** Create `docs/superpowers/multi-selection-followups.md` with the deferred items, then commit `chore: multi-selection verification and docs`.
