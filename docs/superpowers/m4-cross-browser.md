# M4 cross-browser e2e failure inventory

Recorded 2026-11-03 by running `playwright test --project=<name>` (Playwright, Windows 11, headless) once per new project. Nothing was fixed and no assertion was weakened. The only test edits are `test.skip(browserName !== 'chromium', 'CDP-only')` on the IME tests.

Run totals (75 test-runs per project):

| Browser | Passed | Failed | Skipped (CDP-only) |
| --- | --- | --- | --- |
| Firefox 157 (playwright firefox v1555) | 0 | 75 | 0 |
| WebKit 27.2 (playwright webkit v2370) | 36 | 25 | 14 |

## Firefox: no data (environment blocker)

All 75 tests fail in launch, before any test code runs: `browserType.launch: spawn UNKNOWN`. Running `firefox.exe` directly on this machine fails with "The application has failed to start because its side-by-side configuration is incorrect" (a missing or blocked runtime or policy, not an editor problem). The Firefox column therefore has no real results yet. Needs a machine or CI image where Firefox starts (or a repaired VC++ runtime here) and a re-run of `pnpm --filter playground e2e:firefox`. Because the CDP skip applies before launch only in `beforeEach`, the Firefox skips were also not counted.

## WebKit failures (25), grouped by cause

### A. `clipboard-write` / `clipboard-read` permission unsupported in WebKit (19)

First error line: `browserContext.newPage: Unknown permission: clipboard-write`. Cause: `test.use({ permissions: ['clipboard-read', 'clipboard-write'] })` at `e2e/clipboard.spec.ts:5` and `e2e/image.spec.ts:44` is Chromium-only. The context fails to open, so these tests tell us nothing about the editor yet. Part 2 needs a WebKit-compatible clipboard strategy (no permissions grant; dispatch synthetic `ClipboardEvent`s or use `DataTransfer`).

clipboard.spec.ts:
- `copy then paste with the keyboard round-trips through the clipboard` (49)
- `copy across two blocks and paste keeps the block structure with unique ids` (62)
- `a synthetic HTML paste yields bold in the model` (78)
- `pasting plain text keeps Vietnamese diacritics and emoji intact` (90)
- `pasting multi-line plain text creates blocks` (101)
- `cut removes the selection and puts it on the clipboard` (107)

image.spec.ts (the whole file is blocked, 13 tests):
- `inserting > the file input inserts an image that is uploaded; undo and redo keep the uploaded src` (90)
- `inserting > pasting a png and a pdf file inserts exactly one image and ignores the text flavour` (119)
- `inserting > dropping a png inside the second paragraph splits it and inserts the image there` (141)
- `inserting > a failed upload (?uploadFail=1) removes the image without throwing` (173)
- `the image scenario > clicking the image node-selects it` (196)
- `... Backspace removes the selected image` (202)
- `... Backspace at the start of the following paragraph selects the image` (210)
- `... typing while the image is selected replaces it with a paragraph of the typed text` (218)
- `... an IME composition while the image is selected replaces it with a paragraph of the composed text` (229; CDP-skipped, but the permission error fires first)
- `... typing alt text then tabbing away commits the alt; the text is unchanged` (253)
- `... dragging the resize handle by +40px increases the width` (266)
- `... copying a selected image and pasting it elsewhere adds a second image with a fresh id` (283)
- `... cutting a selected image removes it; pasting puts it back` (296)

### B. Undo via `ControlOrMeta+z` does not take effect (4)

Suspected cause: in WebKit the undo shortcut does not reach the editor's history path (keydown handling or `beforeinput` `historyUndo` inputType differs), so the model stays unchanged.

- `typing.spec.ts:73` `Mod+z undoes and Shift+Mod+z redoes`. First error: `Expected: "" / Received: "Hello"`.
- `mention.spec.ts:74` `Backspace right after a mention removes it whole`. First error: `expect(received).toEqual(expected)` at line 83 (after undo, mention not restored; got `["Hi  and ", "@Bob", ", welcome!"]`).
- `mention.spec.ts:132` `a selection spanning a mention is replaced by typing; undo restores the mention`. Same, at line 146 (got `"HiZand "`).
- `code-block.spec.ts:297` `Ctrl+A in the code block selects the document; typing replaces everything`. Fails at the undo assertion, line 310 (types stay `["paragraph"]` instead of paragraph, codeBlock, paragraph).

### C. Selection API differences around an unknown (non-editable) block (2)

- `unknown-block.spec.ts:31` `focus, type, Ctrl+A and Backspace work; the unknown block survives`. First error: `expect(received).toEqual(expected)` on selection, `anchor.offset` expected 0, received 10 (selection after Ctrl+A is not anchored at the start of the first text; WebKit select-all reports a different anchor/focus direction or boundary). Suspected cause: selection API (select-all range normalisation).
- `unknown-block.spec.ts:51` `Backspace at the start of the block after the unknown block selects it; a second Backspace removes it`. First error: `expect(locator).toHaveAttribute('data-hte-selected', '')`, received `null`. Suspected cause: Backspace at a block start does not produce the expected `beforeinput deleteContentBackward` or the node-selection is not synced to the view in WebKit.

## CDP-only tests (skipped outside Chromium, need a non-CDP IME strategy)

These use `Input.imeSetComposition` through a CDP session, which only exists in Chromium. They are marked `test.skip(browserName !== 'chromium', 'CDP-only')`:

- All tests in `e2e/composition.spec.ts` (skip in `beforeEach`).
- `e2e/code-block.spec.ts`: `IME composition inside a code block > mid-code: the text lands at the caret, ...` and `... on the empty last line after a trailing newline`.
- `e2e/mention.spec.ts`: `right after a mention`, `right before a mention`, `in the zero-width leaf before a mention at the start of a block`.
- `e2e/image.spec.ts`: `an IME composition while the image is selected replaces it with a paragraph of the composed text`.

(The shared helper `compose` in `e2e/helpers.ts` is the CDP entry point for the code-block and mention tests.) Part 2 should look for a real-IME-like alternative: synthetic `compositionstart/update/end` plus `beforeinput` events, or Playwright's `keyboard.insertText` on Firefox and WebKit.

## Gaps

- Firefox results are missing entirely (see above).
- WebKit group A hides all image and clipboard behaviour; those need a re-run after the permission setup is made browser-aware.
- Single run per project, default workers, no retries; no flakiness assessment.
