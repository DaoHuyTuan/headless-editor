# M4 Part 2: WebKit Failures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 11 real WebKit e2e failures recorded in `docs/superpowers/m4-cross-browser.md` pass, by fixing the editor or, where the cause is shown to be the headless test harness, by recording that proof.

**Architecture:** The failures fall into three groups:
- A: undo shortcut;
- B: keyboard copy/cut/paste;
- C: selection and Backspace around an unknown block.

Each group is a debugging task: find the root cause with `superpowers:systematic-debugging`, fix it in the core view/input layer, pin the fix with a unit test where the cause is reproducible in happy-dom, and confirm on WebKit and Chromium e2e.

**Tech Stack:** TypeScript, Vitest (happy-dom), Playwright (WebKit 27.2, Chromium).

**Spec:** `docs/superpowers/specs/2026-10-27-headless-editor-design.md`. §2 sets the desktop targets: Chrome, Firefox, Safari. §10 sets M4: "run e2e on Firefox and WebKit, fix cross-browser differences".

**Input:** `docs/superpowers/m4-cross-browser.md`, which holds the failing tests, their first errors, and the suspected causes.

**Time box:** the session ends at 14:20 on 2026-11-03. Whatever is not fixed by then stays in `m4-cross-browser.md`, with what was learned.

## Global Constraints

- All M1–M4 part 1 constraints hold:
  - the core is framework-free;
  - document changes go through ops;
  - commits carry the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never weaken an assertion. A WebKit-only skip (`test.skip(browserName === 'webkit', '<reason>')`) is allowed only when the root cause is proven to be the headless harness and not the editor, for example the system clipboard not being shared between key events. The proof must be written in `m4-cross-browser.md`.
- E2e:
  - Never kill processes on 5173 or 5174.
  - Each task runs e2e through its own uncommitted temporary copy of `apps/playground/playwright.config.ts`, on its own port: A on 5175, B on 5176, C on 5177. Delete the copy afterwards.
- Every fix must keep Chromium green (`--project=chromium`, 78 tests at the start of this plan).

## Review Focus

1. **A WebKit fix must not change Chromium behaviour.** Event-order or inputType differences must be handled in addition to the existing path, not instead of it. Applies to all tasks.
2. **Undo must not run twice.** It must not run once from keydown and once from `beforeinput historyUndo`, in either browser. Task A.
3. **Copy then paste must give fresh ids.** That holds for the JSON flavor and for the HTML-only fallback. Task B.
4. **Select-all must cover the whole doc.** Its direction (anchor and focus) must be consistent, so that a following Backspace or typing replaces everything and keeps unknown blocks per the existing rules. Task C.

---

### Task A: Undo shortcut in WebKit

**Files:** to be determined by diagnosis. The likely candidates are `packages/core/src/view/input.ts`, `packages/core/src/keymap.ts`, `packages/core/src/core-plugin.ts` (intent map), and `packages/core/src/history.ts` (keymap). Tests go in `packages/core/test/view/input.test.ts`.

**Failing e2e:**
- `typing.spec.ts:73`
- `mention.spec.ts:74`
- `mention.spec.ts:132`
- `code-block.spec.ts:297`

All four fail because `ControlOrMeta+z` has no effect.

- [ ] **Step 1: Diagnose on WebKit.** In a scratch e2e, log the `keydown` (key, code, modifiers), any `beforeinput` (inputType), and whether `runKeymap` matched. Write the observed sequence into the report. Hypotheses:
  - Playwright maps `ControlOrMeta` to Meta on WebKit, and the keymap's `Mod` resolves to Ctrl on Windows;
  - WebKit sends `beforeinput historyUndo` and the core has no intent for it;
  - the keydown is consumed elsewhere.
- [ ] **Step 2: Write a failing unit test** that reproduces the observed event sequence in happy-dom. Name it after the cause.
- [ ] **Step 3: Fix the root cause.** If `historyUndo`/`historyRedo` intents are missing, map them to the history commands, and make sure an undo already handled on keydown prevents the second one.
- [ ] **Step 4:** Run the unit suite. Run the 4 e2e on webkit and chromium (`--repeat-each=3`). Run the full chromium project once. Expected: PASS.
- [ ] **Step 5:** Commit `fix(core): undo shortcut on WebKit`.

### Task B: Keyboard copy/cut/paste round-trip in WebKit

**Files:** to be determined by diagnosis. The likely candidates are `packages/core/src/view/clipboard.ts` (copy/cut handlers) and the e2e specs, if the harness is shown to be the cause.

**Failing e2e:**
- `clipboard.spec.ts:47`
- `clipboard.spec.ts:60`
- `clipboard.spec.ts:105`
- `image.spec.ts:281`
- `image.spec.ts:294`

- [ ] **Step 1: Diagnose.** In a scratch e2e on WebKit:
  - Log the `copy` event: whether `clipboardData.setData` was called, and the flavors set.
  - Log the `paste` event: `clipboardData.types` and its contents.
  - Check `navigator.clipboard.readText()` availability.
  - Decide which is true: (a) the editor's copy does not populate data on WebKit; (b) WebKit's headless clipboard does not carry data from the copy event to the next paste event; (c) the paste handler drops WebKit's flavors.
- [ ] **Step 2:** If (a) or (c), write a failing unit test for the handler behaviour, fix it, and run the 5 e2e on webkit and chromium. If (b), write the proof (the logged evidence) into `m4-cross-browser.md`, and add a WebKit-only skip with that reason to exactly these 5 tests. Also add a WebKit e2e that drives copy → paste through a synthetic `ClipboardEvent` with a shared `DataTransfer`, so that the editor's own handlers are still covered on WebKit.
- [ ] **Step 3:** Run the full chromium project once. Expected: PASS.
- [ ] **Step 4:** Commit `fix(core): keyboard copy/cut on WebKit` or `test(playground): webkit clipboard harness limitation`, whichever applies.

### Task C: Select-all and Backspace around an unknown block in WebKit

**Files:** to be determined by diagnosis. The likely candidates are `packages/core/src/view/dom-selection.ts`, `packages/core/src/view/input.ts`, and `packages/core/src/view/node-select.ts`.

**Failing e2e:**
- `unknown-block.spec.ts:31`: after Ctrl+A, `anchor.offset` is expected to be 0 but is 10.
- `unknown-block.spec.ts:51`: Backspace at a block start after the unknown block does not node-select it.

- [ ] **Step 1: Diagnose.** On WebKit, log the DOM selection after Ctrl+A, the model selection, and the events fired for Backspace at a block start (`keydown`, `beforeinput` with its inputType and target range).
- [ ] **Step 2: Write failing unit tests** reproducing the observed DOM selection or event sequence.
- [ ] **Step 3: Fix.** Normalize a select-all DOM selection to the model's whole-doc range, independent of direction. Make Backspace at a block start node-select a preceding opaque block whether it arrives via keydown or via `beforeinput deleteContentBackward`.
- [ ] **Step 4:** Run the 2 e2e on webkit and chromium (`--repeat-each=3`), and the full chromium project once. Expected: PASS.
- [ ] **Step 5:** Commit `fix(core): select-all and Backspace near an unknown block on WebKit`.

### Task D: Verification

- [ ] **Step 1:** Run `pnpm typecheck && pnpm test && pnpm exec vitest --typecheck run`. Then run the full webkit and chromium projects once each, through a temporary config. Expected: chromium all pass. On webkit, everything not recorded in `m4-cross-browser.md` with proof passes.
- [ ] **Step 2:** Update `m4-cross-browser.md` with the new counts and with what was fixed, skipped with proof, or left open. Update `m4-followups.md`.
- [ ] **Step 3:** Commit `chore: M4 part 2 verification`.
