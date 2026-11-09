# Multi-selection follow-ups

These items were collected from the per-task reviews of the multi-selection milestone (branch `feat/multi-selection`). The open items of `m1`–`m4-followups.md` still apply.

## Next steps for the feature
- **No UI creates secondary ranges yet.** Alt+Click, Ctrl+D, Ctrl+Alt+Down and column selection are all missing. Secondary carets are not drawn either: a plugin can draw them with decorations, and there is a test showing how.
- **A click exactly on the main caret keeps the secondary ranges.** The view cannot tell that click apart from the `selectionchange` caused by its own write. Fix: flag `pointerdown` in the root and collapse on the next sync.
- **Pasting N lines into N carets** (VS Code's "distribute") is deferred to the code view.

## Core
- ✅ Ranges that touch across a text-node boundary stay as two ranges until the texts merge. This needs a normalization tweak in `createSelection`.
- `comparePath` treats an ancestor and its descendant as equal. Selection points sit in leaves, so this is safe today; add a comment.
- ✅ Commit-time `rehomeRanges` moves each invalid point on its own, so a half-invalid raw selection can span blocks.
- ✅ (documented) Inside a transaction, one position can sit in two leaves (two carets) until commit merges them.
- ✅ (documented) A `forEachRange` callback that deletes and then re-inserts text skips the later carets inside that text.
- ✅ When every range covers no characters, `toggleMark` stays stuck on "add". This matches the old single-range behaviour.
- ✅ (documented, single-range parity) The selection after a mark split lands at offset 0 of the next text.
- Any dispatch between a keydown and the timer cancels the WebKit delete fallback (from M4).
- **Performance:**
  - ✅ `docIds` is recomputed per insert, so it costs O(ranges × doc) per paste.
  - ✅ A multi-range paste parses the clipboard once per range.
  - Measured: 100 carets typing one character takes about 9 ms (target under 16 ms).

## Plugins
- **Code block:**
  - With Tab, a selection that ends at a line start next to another indented range ends up mapped over that indent. This is cosmetic.
  - `onBeforeInput` `insertParagraph` overlaps with the mention popup; registration order decides which runs.
- **Mention:**
  - ✅ `insertAtTriggers` fakes an `EditorState`.
  - The popup test checks the popup range, not its coordinates.
- **Image:**
  - ✅ The pending state is briefly only the main id while multiple copies upload (two dispatches).
  - An image file paste with a targeted range (one that is not main) still goes to every range. No intent reaches this today.

## Tests and docs
- Task 1: no tests for merging across blocks, or for a node range that is not the main range.
