# M4 cross-browser e2e failure inventory

Recorded 2026-11-03 by running `playwright test --project=<name>` (Playwright, Windows 11, headless) once per new project. Nothing was fixed and no assertion was weakened. The only test edits are `test.skip(browserName !== 'chromium', 'CDP-only')` on the IME tests.

Run totals after M4 part 2 (85 test-runs per project, 2026-11-03, headless, single run, no retries). Chromium has no regression.

| Browser | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| Chromium | 85 | 0 | 0 |
| Firefox 157 (playwright firefox v1555) | not run | not run | never launched |
| WebKit 27.2 (playwright webkit v2370) | 65 | 0 | 20 (15 CDP-only IME, 5 keyboard clipboard) |

Part 1 (before the fixes) was Chromium 75/75 and WebKit 49 passed, 11 failed, 15 skipped. Part 2 added synthetic copy/paste tests (85 vs 75 runs). Unit tests: 1017 passed; 27 more type tests (1044 with `vitest --typecheck`). Real Safari on macOS was NOT tested; WebKit here means Playwright's WebKit build on Windows.

Clipboard permissions (`clipboard-read`, `clipboard-write`) are now granted only on the Chromium project in `playwright.config.ts`; Firefox and WebKit reject them as unknown. The earlier 19 WebKit "Unknown permission" failures were config noise and are gone.

## Firefox: no data (environment blocker)

All 75 tests fail in launch, before any test code runs: `browserType.launch: spawn UNKNOWN`. Running `firefox.exe` directly on this machine fails with "The application has failed to start because its side-by-side configuration is incorrect" (a missing or blocked runtime or policy, not an editor problem). The Firefox column therefore has no real results yet. Needs a machine or CI image where Firefox starts (or a repaired VC++ runtime here) and a re-run of `pnpm --filter playground e2e:firefox`. The Firefox skip counts are also not meaningful.

## WebKit failures (11), grouped by cause

### A. Undo (`ControlOrMeta+z`) has no effect (4)

**Part 2 result: fixed (commit ae4a8a0).** Root cause: `detectPlatform` preferred the user agent (which says Mac in Playwright's WebKit) over `navigator.platform` (`Win32`), so the keymap resolved `Mod` to Meta while the test sent Control. It now prefers `navigator.platform`. The 4 tests pass on WebKit.

(Original suspicion, now disproved:)

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

**Part 2 result: headless harness limitation, proven; the 5 tests are skipped on WebKit only.**

Evidence (scratch e2e, Playwright WebKit on Windows, 2026-11-03; `setData` wrapped on `DataTransfer.prototype`, capture and bubble listeners on `document`):

1. In the editor, select `bc` of `abc`, then `ControlOrMeta+c`, `End`, `ControlOrMeta+v`:
   - `copy`: the editor's handler called `setData` three times: `text/plain` = `bc`, `text/html` = `<p>bc</p>`, `application/x-hte-fragment` = `[{"text":"bc","marks":[]}]`. After each call, `clipboardData.types` held the new flavor, and at the end of bubbling it was `[text/plain, text/html, application/x-hte-fragment]` with `defaultPrevented: true`. So the copy populated the data, custom MIME included (not cause (a)).
   - The next `paste`: `clipboardData.types` = `[text/plain, text/uri-list, text/html]`, and `getData` returned `""` for every one. The editor's paste handler ran (`defaultPrevented: true`) and got nothing to insert. Result: `abc`.
   - `navigator.clipboard.readText()` rejects with `NotAllowedError` (WebKit has no clipboard permission in Playwright).
   - Chromium, same steps: the paste sees all 3 flavors with their values, and the result is `abcbc`.
2. Control page with no editor (`page.setContent`, a textarea copied with `ControlOrMeta+a`/`c` and pasted into a second textarea):
   - native copy (no handler): the paste gets `text/plain` = `hello world`, and it round-trips;
   - a copy handler that sets only `text/plain` = `FROMHANDLER` and calls `preventDefault`: the paste gets `text/plain`, `text/uri-list`, `text/html`, all `""`, and the textarea stays empty;
   - the same with an added custom MIME: the same, all empty.
   - Chromium: both handler variants round-trip, the custom MIME included.

So headless WebKit does not carry data written by a `copy`/`cut` handler (`setData` + `preventDefault`) to the next keyboard paste, even for plain text on a bare page. That is cause (b). The paste handler does not drop WebKit's flavors (not (c)), because there are no values to read. Custom-MIME stripping is not the cause either: plain text is lost too. In this build, the drop happens in the port's pasteboard, not in the editor. Whether real Safari carries `setData` data from a copy handler to a keyboard paste is untested on real Safari.

Safari may still strip the custom JSON MIME in real use (it restricts custom types). That does not lose content: the HTML flavor alone round-trips with fresh ids. This is pinned by:
- unit tests: `packages/core/test/view/clipboard.test.ts` ("pasting only the html flavor of a same-doc copy …") and `packages/plugins/image/test/image.test.ts` ("pasting only the html flavour of a copied image …");
- e2e tests: the "html fallback" variants below.

What changed:
- The 5 keyboard tests have `test.skip(browserName === 'webkit', WEBKIT_KEYBOARD_CLIPBOARD)`, with the reason in `e2e/helpers.ts`. Their assertions are unchanged.
- The same flows run on every browser through synthetic `ClipboardEvent`s that share one `DataTransfer` (`syntheticCopy` / `syntheticPaste` in `e2e/helpers.ts`). In `clipboard.spec.ts`, under `synthetic copy / cut → paste`:
  - copy → paste;
  - two blocks with unique ids, both JSON and HTML-only;
  - cut → paste.

  In `image.spec.ts`:
  - image copy with a fresh id, both JSON and HTML-only;
  - image cut → paste.

  All of these pass on WebKit and Chromium.

### C. Selection API differences around an unknown (non-editable) block (2)

**Part 2 result: fixed (commits fdcee36, 7f4c82a).** Root cause: when only an empty `contenteditable=false` block would be deleted, WebKit fires no `beforeinput` at all, so Backspace/Delete did nothing. A keydown fallback (`setTimeout`) performs the delete if no `beforeinput` arrived. It is guarded: cleared by cut, paste, composition, an ignored or defaultPrevented `beforeinput`, and any dispatch in between; it also handles Safari's keyCode 229 after `compositionend` (50 ms window). Both tests pass on WebKit.

(Original suspicion, now refined:)

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

- Firefox results are missing entirely and Firefox still cannot be launched on this machine (see above).
- Real Safari on macOS was not tested; every WebKit statement here is about Playwright's WebKit build.
- Firefox clipboard behaviour is also unknown: it lacks the clipboard permissions too, but never launched here.
- Single run per project, default workers, no retries; no flakiness assessment.
