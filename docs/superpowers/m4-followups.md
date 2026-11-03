# M4 part 1 follow-ups (input for M4 part 2 and later)

Collected from the per-task reviews of M4 part 1 (branch `feat/m4`), from the SDD ledger. The open items of `m3-followups.md`, `m2-followups.md` and `m1-followups.md` still apply. Part 2 input: [`m4-cross-browser.md`](m4-cross-browser.md).

## Tooling / e2e
- Plain `pnpm --filter playground e2e` now runs all 3 projects, so it fails on this machine (Firefox cannot launch, WebKit has 11 real failures). Until Part 2 the Chromium gate is `e2e:chromium`.
- Re-run the e2e suite on port 5174 (still held by an unrelated `wslrelay.exe`; part 1 verified on a temporary 5175 config: 78 Chromium tests passed).
- Firefox is unverified: re-run `pnpm --filter playground e2e:firefox` on a machine where it starts.

## Core / history
- Any caller can set `meta.origin = history` to bypass the code-block veto (the doc stays valid via rule 8). Pre-existing. Hardened: a doc-changing `origin: history` tr that is not a valid undo/redo of the top entry (no or an unknown `historyAction`, or an empty stack) now empties both stacks instead of leaving them desynced.
- A mixed data+structural outside tr drops entries the data path would rewrite.
- A failed image upload while the preview (and every copy) is still in the doc keeps history: the removal is mapped like any outside structural tr, so the upload step and every entry below it are dropped, while later unrelated steps stay undoable. If a preview or copy was undone or deleted, history is still cleared (the dead `blob:` src must not come back).
- A composed command that runs `undo` then `insertText` on one tr folds the insert into the stacks (it joins the entry now on top of the undo stack) instead of recording it as its own undo step (safe; documented on `historyPlugin`).

## Normalize / clipboard
- No multi-newline selection-mapping test for rule 11.
- The rule 11 perf bound is machine-dependent (~3x margin).
- Split pieces share data by reference (pre-existing).
- A lone non-opaque block pasted over a node selection takes the placeholder type (heading becomes paragraph), per caret rules.
- `nodeSelection` accepts inline atoms programmatically (the view never does).
- Non-atom block node views cannot be node-selected (`nodeSelection` throws); no test.

## Playground
- The Bold button is disabled with no selection or focus.
