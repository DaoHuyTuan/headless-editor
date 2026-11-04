# Multi-selection: working digest

The current state of the multi-selection milestone (branch `feat/multi-selection`). Read this instead of re-reading the full spec and plan. Open them only for the section your task cites:
- spec: `docs/superpowers/specs/2026-11-03-multi-selection-design.md`, whose §8 calls are binding;
- plan: `docs/superpowers/plans/2026-11-03-multi-selection.md`.

The controller updates this file after each task.

## Status
| Task | State | Commits |
|---|---|---|
| 1 Selection module | done | dd9a029 |
| 2 Type switch (main range only) | done | befea19 |
| 3 Map and normalize every range | done | 8c5e1dd, 1c484d8 |
| 4 `forEachRange` | done | a49902d, 92e9214 |
| 5 Text editing on every range | done | 68b849e, 31e8b5e, 44cdfab |
| 6 Marks on every range | done | 9daee41, b899257 |
| 7 Fragments, paste, drop | done | 2b848f5 |
| 8 Input, IME, input rules, view | done | c5bb316, fa359f4 |
| 9 History, rebase | done (tests only; code already correct) | 150ca0c |
| 10 Code block, font-size | done | a49c1ce |
| 11 Mention, image | done | 83186cb, 5729204 |
| 12 Docs, e2e smoke, perf, verification | done (controller) | 4cd928d + docs |

## API built so far (what later tasks use)
- **`model/selection.ts`**:
  - `single(range)`;
  - `createSelection(ranges, main?)`: sorts, merges overlapping and touching ranges, makes a node range the only range, and keeps `main` on the merged range;
  - `mainRange`, `rangeEquals`, `selectionEquals`, `isNodeRange`.
- **`ops/transform.ts`**:
  - `transformSelection` maps each range independently and drops lost ones;
  - `transformSelectionStrict` returns null if any range fails. History and rebase use it.
- **`Transaction`**:
  - `apply` maps the selection op by op through `mapSelection`. With several ranges, a lost range is re-homed to the nearest editable point. A range that lost one point collapses to a caret. The result is null only when nothing is editable. A single range behaves as before.
  - `setSelection` normalizes.
  - At commit, a selection with several ranges is normalized again and validated range by range (`rehomeRanges`).
- **`tr.forEachRange(fn: RangeStep)`**, in `transaction/ranges.ts`. `RangeStep = (range, tr, index) => SelectionRange | null | void`.
  - It runs in document order on the same tr. Ranges still pending are mapped op by op with forward affinity (a later caret at an insert point ends up after the inserted text). Results already returned map backward.
  - `null` drops the range; `void` keeps the live range.
  - It emits one `set_selection` at the end, and `main` is kept.
  - `tr.inForEachRange` is true during a run.
  - `flagSwallowed(tr, inside)`: a pending range strictly inside a removal, with real content on both sides, skips its step and is merged afterwards. A range at the edge still runs.
  - Stored marks: each step starts from the run's initial marks. Afterwards, the marks are null if any step consumed them, otherwise a step's new marks, otherwise the initial ones. A run with no doc change clears them.
- **Text (`transaction/text.ts`)**: `runStep`, `touchedRange` (prefers main), `touches`.
  - Converted: `insertText`, `deleteRange` (`SelectionRange | Range`), `deleteBackward`/`deleteForward(unit, at?)`, `splitBlock(at?)`, `insertBlockNode(node, at?)`, `selectAll` (collapses), `replaceSelectedNode`.
  - At top level, an explicit `at` that touches no range replaces main. This matches single-range behaviour.
  - Backspace/Delete next to an opaque block with several ranges leaves that caret alone; the others delete. With one range it node-selects.
  - `insertBlockNode` copies: the first keeps the caller's ids, the rest get fresh ids.
  - `tr.dev` comes from the editor's `dev` option. A no-range call inside a callback throws when `tr.dev` is set.
- **Marks (`transaction/marks.ts`)**: edits do not go through `forEachRange`; `tr.apply` maps the selection.
  - `allHaveMark` decides both the `toggleMark` direction and `isMarkActive`/`editor.isActive`.
  - Carets count. Ranges that cover no characters are ignored when some other range can change.
  - Stored marks for carets are the intersection of all carets' marks.
  - With mixed ranges and carets, the ranges get the mark and the carets get stored marks.
  - `isActive` for elements requires every range.
  - `toggleMark` takes no range. Inside a callback, use `addMark`/`removeMark` with the callback's range.

## Carry-overs (owned by a later task)
- **Task 8:**
  - `composition.ts:70` calls `marksAt(state)` on the whole selection, which gives the intersection. Collapse to main before it, or use the main range only.
  - Add "acts on the main range on purpose" comments at the IME sites (spec §5.8, class b).
- **Task 10:** code-block `codeAt` checks only main, so a no-range `tr.insertText(INDENT / '\n')` now inserts at every caret, including carets outside code blocks. Make it per range.
- **Task 11:** the image upload tracks one id. `insertBlockNode` copies get fresh ids, so all copies must be tracked.
- **Task 12 (docs):**
  - `isNodeSelection` is no longer a type guard.
  - Document the new optional `at` params, `RangeStep`'s void/index, `tr.dev`, and the `toggleMark`-in-callback rule.

## Added after Task 7
- Fragments (`transaction/fragment.ts`):
  - `insertFragment`, `insertInlineNode` and `insertContent` act at every range. Ids are fresh per copy: `docIds` is recomputed per insert.
  - Paste (`core-plugin.ts insertTransfer`) goes to every range. With one range, `transformPasted` gets `info.at = intent.range`; with several, it gets `null`.
  - A drop goes to its drop point and collapses there, or to main as a fallback.
  - The node-range paths (`replaceNodeStep`, `replaceNodeWithBlocksStep`) run only without `at`.
- More carry-overs:
  - **Task 8:** a paste intent whose range is not main acts only there and does not collapse. In practice this is unreachable. Either collapse it like the other intents (§8 call 13) or document why not.
  - **Task 10 (not in the plan, must do):** code-block `transformPasted` (`code-block/src/index.ts:435`) uses `at ?? mainRange(selection)`, so main alone decides the code/plain conversion for every caret. Make paste per range: carets inside code blocks get plain text, carets outside get the rich fragment.
  - **Task 12 (perf):** `docIds` costs O(ranges × doc) per paste. Compute it once and add each copy's ids.

## Added after Task 8
- **Intents** (`core-plugin.ts`):
  - Plain typing goes to every caret. It counts as plain when the intent has no range, or when its range spans main in either direction.
  - `insertReplacementText` is always targeted. An intent with a target other than main applies only at that target and collapses the selection, keeping stored marks. A paste intent whose target is not main collapses the same way.
- **Input rules** (`input-rules.ts`): with several carets, each collapsed caret is checked on its own and the first matching rule at that caret wins.
  - The handler's scratch tr has `single(own caret)` as its selection and the shared doc, so a no-range call acts only at that caret.
  - When the handler returns true, its doc ops (without its `set_selection` ops) are applied to one shared rule tr, and the other ranges are mapped through them.
  - A `setSelection` in a handler throws in dev mode. Undo is two steps, as before: the typing, then the rules.
  - With a single caret the old path runs unchanged.
- **IME:** `compositionstart` with several ranges collapses to main first (`addToHistory: false`, stored marks kept). Composition takes main's marks.
- **View:**
  - The DOM gets only the main range.
  - A user `selectionchange` that moves away from main collapses to one range.
  - Known gap, a follow-up: a click exactly on the main caret keeps the secondary ranges.
