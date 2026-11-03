# M4 Part 1: M3 Follow-ups and Cross-Browser E2E — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "Start of M4" items from `docs/superpowers/m3-followups.md` and the M4 section of `docs/superpowers/m2-followups.md`, then run the e2e suite on Firefox and WebKit and record what breaks.

**Architecture:** This plan only fixes and tightens existing code: the core editor pipeline, history, normalize and clipboard modules, the code-block plugin, and the Playwright config. It adds no new plugins. Behaviour changes are pinned by unit tests in `packages/*/test` and by Chromium e2e in `apps/playground/e2e`. Part 2 (a later plan) fixes the cross-browser failures that Task 7 records.

**Tech Stack:** TypeScript, Vitest (happy-dom), React 18, Playwright, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-27-headless-editor-design.md` (§10 milestones: "M4: run e2e on Firefox and WebKit, fix cross-browser differences"; §5.11 plugin guidelines).

**Time box:** this session ends at 14:20 on 2026-11-03. Execute the tasks in order. Task 8 is a stretch task: if it cannot be finished and reviewed in time, it moves back to the follow-ups.

## Global Constraints

- Core is framework-free.
- The public API is the only entry point.
- Document changes go through invertible operations.
- `data` is JSON.
- Validators are synchronous.
- Plugin logic never imports React.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- E2e runs on the playground's dedicated port 5174 (`apps/playground/playwright.config.ts`, `reuseExistingServer: false`). Never kill processes on 5173 or 5174.
  - While 5174 is held by an unrelated process, run e2e through an uncommitted temporary copy of the config on port 5175, and delete the copy afterwards.
- Desktop targets per spec §2: Chrome, Firefox and Safari (WebKit). Mobile is best-effort and out of scope here.
- Tooling:
  - focused tests: `pnpm exec vitest run <path>`;
  - full suite: `pnpm test`, then `pnpm typecheck`, then `pnpm exec vitest --typecheck run`;
  - never use watch mode.

## Review Focus

1. **Undo after normalization.** Undo after any edit that normalization rewrote must restore the exact previous doc in one step. This covers code-block joins, rule 8 atom replacement and rule 11 splits. A filter hook must never veto history. → Task 1, Task 5.
2. **`can()` purity.** `can()` must answer exactly what the command would do, filters included, without dispatching, emitting events or changing plugin state. → Task 2.
3. **Paste over a selected node.** Paste with a node selected, whether an image or a block node view, replaces the node in place. The pasted content lands where the node was, the caret ends after it, and one undo restores the node. → Task 3.
4. **Refactor behaviour.** The clipboard move must keep the `@hte/core` public exports and every paste and drop path byte-identical. → Task 4.
5. **Cross-browser failures.** The Firefox and WebKit runs must report real failures, not infrastructure noise such as a missing browser binary or wrong port. → Task 7.

---

### Task 1: History is never vetoed by the code block filter

**Files:**
- Modify: `packages/plugins/code-block/src/index.ts`. Change the `filterTransaction` hook near line 420 and its JSDoc near line 275.
- Test: `packages/plugins/code-block/test/code-block.test.ts`

**Interfaces:**
- Produces: `filterTransaction` returns `true` for any tr with `tr.meta.origin === 'history'`. Other trs keep the existing `addsFormatting` veto.

- [ ] **Step 1: Write the failing tests** (`describe('undo after normalizing into a code block')`):
  - `it('undoes a Backspace-join of a paragraph with bold text')`
    - Setup: code block `"x"`, then a paragraph whose text is `"a"` plus a bold `"b"`. Put the caret at `[1,0]:0` and run the Backspace keymap.
    - Assert that the doc now has 1 block.
    - Run `commands.undo()`. Assert it returns `true`, and that `getJSON()` equals the JSON before the Backspace (the bold mark is on `"b"` again).
  - `it('undoes a Backspace-join of a paragraph with a mention')`: same steps with a mention atom in place of the bold text. After undo the mention is back with the same `userId` and `label`.
  - `it('redo re-applies the join')`: after the undo, `commands.redo()` returns `true` and the doc is the joined code block again.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/plugins/code-block`. Expected: the undo assertions FAIL (`undo()` returns `false`).
- [ ] **Step 3: Implement.** Return `true` early in `filterTransaction` for `origin === 'history'`. History trs are inverses of states the pipeline already accepted, and rule 8 normalization strips anything left inside. Update the JSDoc.
- [ ] **Step 4:** Run the code-block tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(code-block): never veto history transactions`.

### Task 2: `can()` runs the `filterTransaction` chain

**Files:**
- Modify: `packages/core/src/editor.ts`. This touches `bindCommands` (around line 571) and the filter loop inside `applyTransaction` (around line 550).
- Test: `packages/core/test/editor.test.ts`, `packages/plugins/code-block/test/code-block.test.ts`

**Interfaces:**
- Produces: a private `Editor.passesFilters(tr: Transaction): boolean` that runs every plugin's `filterTransaction(tr, this._state)` in plugin order and returns `false` on the first veto.
  - `applyTransaction` uses it in place of its inline loop.
  - With `dispatch === false`, `bindCommands` returns `ok && (no ops and no stored-mark change || this.passesFilters(tr))`.

- [ ] **Step 1: Write the failing tests:**
  - core, `it('can() answers false when a filterTransaction vetoes the command tr')`:
    - Set up a test plugin whose filter vetoes trs carrying meta `veto: true`, and a command that sets that meta and inserts text.
    - Assert `editor.can().cmd()` is `false`.
    - Assert `editor.state` is identical (`toBe`) before and after.
    - Assert that no `update` or `transaction` event fired and that the filter spy saw the tr.
  - core, `it('can() still answers true for an allowed command')`.
  - code-block:
    - `it('can().toggleBold() is false inside a code block')`;
    - `it('can().toggleBold() is true in a paragraph')`.
- [ ] **Step 2:** Run the focused tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Write `passesFilters` and use it in both places. `can()` must never call `dispatch` and never run `appendTransaction` or normalize.
- [ ] **Step 4:** Run the focused tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(core): can() runs filterTransaction`.

### Task 3: Paste over a node selection replaces the node in place

**Files:**
- Modify: `packages/core/src/core-plugin.ts`, `insertTransfer` around lines 38-60, and `packages/core/src/transaction/fragment.ts`, the `insertFragment` node-selection branch.
- Test: `packages/core/test/view/clipboard.test.ts`. If the existing paste tests live elsewhere, use that file.

**Interfaces:**
- Consumes: `isNodeSelection(selection)`, `insertFragment(tr, fragment, at?)`.
- Produces: when the selection is a node selection, the inserted content takes the selected node's index under the same parent, and the node is removed in the same tr. This matches the typing path (the typing path's behaviour is the reference; find it via `insertText` over a node selection).

- [ ] **Step 1: Write the failing tests:**
  - `it('pasting text over a selected image puts the text where the image was')`:
    - Doc: paragraph `"a"`, image, paragraph `"b"`. Node-select the image, then paste `text/plain` `"x"`.
    - Expected blocks: paragraph `"a"`, paragraph `"x"`, paragraph `"b"`, in that order.
    - The caret is at the end of `"x"`.
  - `it('pasting HTML blocks over a selected image keeps their order in place')`: paste `<p>x</p><p>y</p>`. Expected: `a`, `x`, `y`, `b`.
  - `it('one undo restores the image')`.
  - `it('paste over a node selection matches typing over it')`: typing `"x"` over the selected image and pasting `"x"` over it give equal `getJSON()` docs, ignoring ids.
- [ ] **Step 2:** Run the focused test. Expected: FAIL (the text lands in the previous block).
- [ ] **Step 3: Implement.** Make the fragment insertion over a node selection remove the node and insert at its index, with the same split and merge rules `insertFragment` applies at a block boundary.
- [ ] **Step 4:** Run the focused tests, the e2e-free full suite (`pnpm test`), and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(core): paste over a node selection replaces the node in place`.

### Task 4: Move clipboard parse/serialize into `content/`

**Files:**
- Create: `packages/core/src/content/clipboard.ts`. It holds `FRAGMENT_MIME`, `parseFromClipboard` and `serializeForClipboard`, plus their private helpers, moved verbatim with only import paths changed.
- Modify:
  - `packages/core/src/view/clipboard.ts`, which keeps only the DOM event wiring (copy, cut and paste listeners) and imports from `../content/clipboard`;
  - `packages/core/src/core-plugin.ts:9`;
  - `packages/core/src/index.ts:116`.
- Test: move the parse and serialize unit tests that need no DOM events into `packages/core/test/content/clipboard.test.ts`. Event tests stay where they are.

**Interfaces:**
- Produces: `@hte/core` still exports `FRAGMENT_MIME`, `parseFromClipboard` and `serializeForClipboard` with identical signatures. `content/clipboard.ts` imports nothing from `view/`.

- [ ] **Step 1:** Run `grep -rn "view/clipboard" packages apps --include=*.ts --include=*.tsx` and record every importer.
- [ ] **Step 2: Move the code.** Then run `grep -n "from '../view" packages/core/src/content/clipboard.ts`. Expected: no matches.
- [ ] **Step 3:** Run `pnpm test`, `pnpm typecheck` and `pnpm exec vitest --typecheck run`. Expected: PASS, with the same test count as before the move.
- [ ] **Step 4:** Commit `refactor(core): move clipboard parse/serialize into content/`.

### Task 5: Normalize rule 11 splits every newline of a block in one pass

**Files:**
- Modify: `packages/core/src/normalize.ts`, rule 11 at around lines 133-142 and `splitAtNewline` / `firstNewline` at around lines 183-215.
- Test: `packages/core/test/normalize.test.ts`

**Interfaces:**
- Produces: rule 11 splits a block at all of its `\n` positions in one fix, from last to first, so that earlier paths stay valid. Every other observable result stays as it is today:
  - block types;
  - marks per segment;
  - the first piece keeps the id, and the other pieces get fresh ids;
  - selection mapping;
  - one undo step.

- [ ] **Step 1: Write the tests:**
  - `it('splits a 2000-line paragraph in under 200 ms')`: warm up once, then take the best of 3 runs of `setContent` with a paragraph made of 2000 lines joined by `\n`. Assert the time is under 200 ms and the doc has 2000 paragraphs.
  - Keep every existing rule 11 test unchanged.
- [ ] **Step 2:** Run the test. Expected: FAIL. Today this takes about 0.5-1.5 s.
- [ ] **Step 3: Implement** the one-pass split.
- [ ] **Step 4:** Run `pnpm exec vitest run packages/core/test/normalize.test.ts packages/plugins/code-block`, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `perf(core): normalize rule 11 splits all newlines in one pass`.

### Task 6: Chromium e2e for Tasks 1-3

**Files:**
- Modify: `apps/playground/e2e/code-block.spec.ts`, `apps/playground/e2e/image.spec.ts`

- [ ] **Step 1: Add the specs:**
  - code-block: `test('Backspace-join of bold text into a code block, then Ctrl+Z restores it')`. Real keys. Assert the editor JSON before the join equals the JSON after the undo.
  - code-block: `test('the Bold toolbar button is disabled inside a code block')`. This needs the playground toolbar to use `editor.can()` for disabled state. If it doesn't yet, make that change in `apps/playground/src` in this task.
  - image: `test('pasting text over a selected image replaces it in place')`. Use the clipboard via `page.evaluate` with a synthetic `ClipboardEvent`, following the existing paste e2e pattern.
- [ ] **Step 2:** Run the e2e suite through the 5175 temporary config: first the new tests with `--repeat-each=3`, then the full suite once. Expected: PASS.
- [ ] **Step 3:** Commit `test(playground): e2e for undo after join, can() toolbar, paste over node`.

### Task 7: Enable Firefox and WebKit e2e and record the failures

**Files:**
- Modify: `apps/playground/playwright.config.ts`. Add the projects `{ name: 'firefox', use: devices['Desktop Firefox'] }` and `{ name: 'webkit', use: devices['Desktop Safari'] }`.
- Modify: `apps/playground/package.json`. Add scripts `e2e:chromium`, `e2e:firefox` and `e2e:webkit`, each running `playwright test --project=<name>`. The plain `e2e` script runs all projects.
- Create: `docs/superpowers/m4-cross-browser.md`

- [ ] **Step 1:** Run `pnpm --filter playground exec playwright install firefox webkit`. Expected: both browsers downloaded. If the download is blocked, stop and report BLOCKED with the error.
- [ ] **Step 2:** Run each new project once through the 5175 temporary config. Record every failing test in `m4-cross-browser.md`: the spec, the test, the browser, the first error line, and a one-line suspected cause (IME/CDP-only, selection API, `beforeinput` inputType, clipboard, layout).
  - CDP-only tests (IME via `Input.imeSetComposition`) cannot run outside Chromium. Mark them `test.skip(browserName !== 'chromium', 'CDP-only')`, and list them separately as needing a non-CDP IME strategy.
- [ ] **Step 3:** Do not fix the cross-browser failures in this task. Part 2 plans the fixes from the recorded list.
- [ ] **Step 4:** Commit `test(playground): firefox and webkit projects, failure inventory`.

### Task 8 (stretch): Map history stacks through outside-history structural changes

**Files:**
- Modify: `packages/core/src/history.ts`, the `addToHistory === false` branch around lines 239-251, which today returns `EMPTY` for structural changes.
- Create: `packages/core/src/ops/rebase.ts`. It exports `rebaseOps(ops: Operation[], over: Operation[]): Operation[] | null`, where `null` means the ops can't be rebased.
- Test: `packages/core/test/history.test.ts`, `packages/core/test/ops/rebase.test.ts`

**Interfaces:**
- Produces:
  - `rebaseOps` transforms paths and offsets of `ops` (which were recorded before `over`) so they apply after `over`.
  - It returns `null` when an op touches a node that `over` removed, or a text range `over` removed.
  - History maps every undo and redo entry through the outside ops. An entry that can't be rebased drops itself and every entry under it on the same stack. Entries above it stay.

- [ ] **Step 1: Write the failing tests:**
  - rebase:
    - `insert_node` before an op's path shifts its index by +1;
    - `remove_node` before it shifts by -1;
    - `insert_text` earlier in the same text shifts the offset;
    - an op inside a removed node returns `null`.
  - history: `it('keeps undo after an outside-history insert of an unrelated block')`.
    - Setup: type `"a"` in paragraph 0, then insert a paragraph at index 0 with `addToHistory: false`.
    - Assert `undo()` returns `true` and removes the `"a"` from what is now paragraph 1.
  - history: `it('drops only entries that touch a node removed outside history')`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Cover the op types `insert_text`, `remove_text`, `insert_node`, `remove_node`, `split_node`, `merge_node`, `move_node`, `set_node_data`, `add_mark` and `remove_mark`. Use path transformation rules that are symmetric to `invertOp`. Return `null` for any pair the rules don't cover.
- [ ] **Step 4:** Run the history and rebase tests, then `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): map history through outside-history structural changes`.

### Task 9: Verification and follow-ups

- [ ] **Step 1:** Run `pnpm typecheck && pnpm test && pnpm exec vitest --typecheck run`. Then run the Chromium e2e on the 5175 temporary config. Expected: all pass.
- [ ] **Step 2:** In `docs/superpowers/m3-followups.md` and `m2-followups.md`, check off the items closed here, using the existing ✅ ~~strikethrough~~ style. Link `m4-cross-browser.md` from the "Start of M4" section as the input for Part 2. If Task 8 was not done, leave its item open.
- [ ] **Step 3:** Commit `chore: M4 part 1 verification`.
