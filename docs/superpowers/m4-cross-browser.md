# M4 cross-browser e2e failure inventory

Recorded 2026-11-03 by running `playwright test --project=<name>` (Playwright, Windows 11, headless) once per new project. Nothing was fixed and no assertion was weakened. The only test edits are `test.skip(browserName !== 'chromium', 'CDP-only')` on the IME tests.

Run totals (75 test-runs per project). Chromium is 75 passed after the config change (no regression).

| Browser | Passed | Failed | Skipped (CDP-only) |
| --- | --- | --- | --- |
| Chromium | 75 | 0 | 0 |
| Firefox 157 (playwright firefox v1555) | 0 | 75 | 0 (never launched) |
| WebKit 27.2 (playwright webkit v2370) | 49 | 11 | 15 |

Clipboard permissions (`clipboard-read`, `clipboard-write`) are now granted only on the Chromium project in `playwright.config.ts`; Firefox and WebKit reject them as unknown. The earlier 19 WebKit "Unknown permission" failures were config noise and are gone.

## Firefox: no data (environment blocker)

All 75 tests fail in launch, before any test code runs: `browserType.launch: spawn UNKNOWN`. Running `firefox.exe` directly on this machine fails with "The application has failed to start because its side-by-side configuration is incorrect" (a missing or blocked runtime or policy, not an editor problem). The Firefox column therefore has no real results yet. Needs a machine or CI image where Firefox starts (or a repaired VC++ runtime here) and a re-run of `pnpm --filter playground e2e:firefox`. The Firefox skip counts are also not meaningful.

## WebKit failures (11), grouped by cause

### A. Undo (`ControlOrMeta+z`) has no effect (4)

Suspected cause: in WebKit the undo shortcut does not reach the editor's history path (keydown handling or the `beforeinput` `historyUndo` inputType differs), so the model stays unchanged.

- `typing.spec.ts:73` `Mod+z undoes and Shift+Mod+z redoes`. First error: `Expected: "" / Received: "Hello"`.
- `mention.spec.ts:74` `Backspace right after a mention removes it whole`. First error: `expect(received).toEqual(expected)` at line 83 (after undo the mention is not restored; got `["Hi  and ", "@Bob", ", welcome!"]`).
- `mention.spec.ts:132` `a selection spanning a mention is replaced by typing; undo restores the mention`. Same, at line 146 (got `"HiZand "`).
- `code-block.spec.ts:297` `Ctrl+A in the code block selects the document; typing replaces everything`. Fails at the undo assertion, line 310 (types stay `["paragraph"]`).

### B. Keyboard copy/cut then paste does not round-trip the clipboard (5)

Suspected cause: clipboard. After `ControlOrMeta+c`/`x` and `ControlOrMeta+v` in WebKit, nothing (or only part) is pasted, so either the editor's copy/cut handler does not populate `clipboardData` the way WebKit expects, or headless WebKit does not keep the system clipboard between the two events. Needs investigation in part 2 (a `clipboardData`-level test would separate the two).

- `clipboard.spec.ts:47` `copy then paste with the keyboard round-trips through the clipboard`. First error: `Expected: "abcbc" / Received: "abc"`.
- `clipboard.spec.ts:60` `copy across two blocks and paste keeps the block structure with unique ids`. First error: `expect(received).toBe(expected)`, received `one
two` where the pasted copy is missing.
- `clipboard.spec.ts:105` `cut removes the selection and puts it on the clipboard`. First error: `Expected: "hello world" / Received: "hello"`.
- `image.spec.ts:281` `the image scenario > copying a selected image and pasting it elsewhere adds a second image with a fresh id`. First error: `toHaveCount` on `img`, expected 2, received 1.
- `image.spec.ts:294` `the image scenario > cutting a selected image removes it; pasting puts it back`. First error: `toHaveCount` on `img`, expected 1, received 0.

The synthetic-event paste tests (HTML paste, plain text with diacritics, multi-line, png/pdf file paste, code-block rich paste) now pass on WebKit, so the paste handler itself works there.

### C. Selection API differences around an unknown (non-editable) block (2)

- `unknown-block.spec.ts:31` `focus, type, Ctrl+A and Backspace work; the unknown block survives`. First error: selection `anchor.offset` expected 0, received 10. Suspected cause: selection API (WebKit select-all range direction or boundary normalisation differs).
- `unknown-block.spec.ts:51` `Backspace at the start of the block after the unknown block selects it; a second Backspace removes it`. First error: `toHaveAttribute('data-hte-selected', '')`, received `null`. Suspected cause: Backspace at a block start does not produce the expected `beforeinput` `deleteContentBackward`, or the node selection is not synced to the view in WebKit.

## CDP-only tests (skipped outside Chromium, need a non-CDP IME strategy)

These use `Input.imeSetComposition` through a CDP session, which only exists in Chromium. They are marked `test.skip(browserName !== 'chromium', 'CDP-only')`:

- All tests in `e2e/composition.spec.ts` (skip in `beforeEach`).
- `e2e/code-block.spec.ts`: `IME composition inside a code block > mid-code: the text lands at the caret, ...` and `... on the empty last line after a trailing newline`.
- `e2e/mention.spec.ts`: `right after a mention`, `right before a mention`, `in the zero-width leaf before a mention at the start of a block`.
- `e2e/image.spec.ts`: `an IME composition while the image is selected replaces it with a paragraph of the composed text`.

(The shared helper `compose` in `e2e/helpers.ts` is the CDP entry point for the code-block and mention tests.) Part 2 should look for a real-IME-like alternative: synthetic `compositionstart/update/end` plus `beforeinput` events, or Playwright's `keyboard.insertText` on Firefox and WebKit.

## Gaps

- Firefox results are missing entirely (see above).
- Firefox clipboard behaviour is also unknown: it lacks the clipboard permissions too, but never launched here.
- Single run per project, default workers, no retries; no flakiness assessment.
