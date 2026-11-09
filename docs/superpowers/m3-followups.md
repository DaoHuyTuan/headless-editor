# M3 follow-ups (input for the M4+ plans)

Collected from the per-task and final reviews of milestone M3 (branch `feat/m3`), from the SDD ledger. The open items of `m2-followups.md` (including its M4 section) and `m1-followups.md` still apply as well.

## Start of M4: do these first
- ✅ ~~**Undo is vetoed after content is normalized into a code block.** Backspace-joining a paragraph that holds bold text or a mention into the code block above cannot be undone: the undo tr re-adds the mark / re-inserts the atom inside the code block before its split restores the paragraph, and the code block's `filterTransaction` (`addsFormatting`) vetoes it, so `undo()` returns false. Pre-existing (old rule 8 also stripped marks and atoms). Likely fix: don't veto history trs, or judge by the final doc.~~ Closed in M4 part 1.
- ✅ ~~**`can()` doesn't run `filterTransaction`.** `can().toggleBold()` is true inside a code block, so the toolbar and the real command disagree.~~ Closed in M4 part 1.
- **Re-run the e2e suite on port 5174.** Port 5174 was held by an unrelated `wslrelay.exe` (another project), so `pnpm --filter playground e2e` could not run. M3 e2e passed (75 tests) on a temporary copy of the config on port 5175.
- ✅ **The three items moved from m2** (see the M4 section of `m2-followups.md`), closed in M4 part 1:
  - ✅ ~~map the history stacks through outside-history structural changes instead of clearing them;~~
  - ✅ ~~move clipboard parse/serialize into `content/`;~~
  - ✅ ~~make text pasted over a node selection behave like typing over it.~~
- **Input for M4 part 2:** [`m4-cross-browser.md`](m4-cross-browser.md). WebKit has 11 real e2e failures (49 pass, 15 CDP-only skips); Firefox cannot launch on this machine, so it has no data yet. Deferred minors from part 1 are in [`m4-followups.md`](m4-followups.md).

## Decisions and scope for M4+
- Firefox and WebKit (M4).
- Decide whether the levels 3-4 (`parts`, hooks) APIs graduate from `@experimental` (spec §5.11).
- Not planned: a generic mechanism for one plugin to intercept another plugin's hooks (spec §5.11); internal drag-move of content.

## Core / view
- Lifecycle (Task 1):
  - focus asymmetries are undocumented (unmount fires no `onBlur`; mount on a focused root fires no `onFocus`);
  - `editor.view` is null during `onMount` (use the `view` argument);
  - `onCreate` under StrictMode double-invoke must be side-effect-free;
  - a throwing `editor.on` listener cuts hook isolation;
  - nested dispatch leaves state ahead of the tr;
  - a throwing `onCreate` leaks earlier resources.
- Types (Task 2): `PluginOverrides` types `state.apply` / `mark.render` as `any` in `extend`; `props.state` is stale without `usePluginState`.
- Attributes (Task 3):
  - `mergeStyle` only normalizes when base has a style;
  - `parseStyle` ignores comments and unbalanced quotes;
  - attribute output order changed (matters for string compares);
  - the `mergeAttrs` JSDoc is spliced awkwardly.
- History (Task 4):
  - ✅ entries grow across undo/redo cycles with appends (no compaction);
  - ✅ appended trs cannot be separate undo steps (JSDoc);
  - ✅ a structural append under `addToHistory: false` clears the stacks (stale since M4);
  - ✅ the meaning of `R.selectionBefore` after a fold;
  - ✅ untested: 3+ levels of appends, a selection-only append, a data-only append after an undo root.
- Inline atoms (Task 5):
  - a literal U+200B in source, and a duplicated ZW constant/attribute (use an escape and one shared helper);
  - rule 10 changes the link-end caret (typing no longer extends a trailing link), untested;
  - `pastMiddle` asymmetry for text-less atoms;
  - `insertInlineNode` returns false with ops on the tr;
  - `leafDomText` strips a real U+200B;
  - word-Backspace removes an atom (comment needed);
  - unknown inline elements get no rule-10 siblings;
  - coverage gaps: typing into a ZW leaf, IME before ZW, ZW to `<br>` after the last chip is removed.
- Input rules (Task 6):
  - `toBlockOffset` at `input-rules.ts:32` is outside the try, but the throw is unreachable: `runAt` just succeeded for the same caret (move it inside the try for robustness only);
  - `findTrigger` false positive when the trigger text is the first child of a link;
  - `runAt` vs `findTrigger` mismatch;
  - a multi-char trigger is loosely supported (docs say single-char);
  - a rule without `$` matches only the leftmost match;
  - missing tests: next char after a rule creates a new entry, Vietnamese/NFD query, composition triggers no rule.
- Decorations (Task 7):
  - a throwing `decorations` hook propagates out of update/mount (document or catch and log);
  - invalid decoration attribute names are caught mid-render (validate in `groupDecorations`);
  - widget at offset 0: caret side;
  - a same-key widget keeps its old element (JSDoc);
  - duplicate keys rebuild the leaf on each render;
  - decoration attrs are not checked by `leafIntact`;
  - no explicit caret-at-widget test;
  - `WIDGET_ATTR` / `DECO_ATTR` are not exported.
- `coordsAt` (Task 8): the leaf-rect fallback bottom is the whole leaf's bottom; a zero-height rect is accepted.
- Node views (Task 9):
  - `isDev()` treats a missing `process` as dev;
  - a missing `contentDOM` is never detected (dev warning);
  - `NodeContent` is silent outside a non-atom view;
  - `coordsAt` / `modelToDom` before `NodeContent` mounts give zero rects;
  - the placement warning is not dev-gated;
  - `placedContentDOMs` runs `querySelectorAll` per added element;
  - a stale-caret record can be invalidated if the same leaf is re-rendered while detached (re-snapshot after render);
  - composition across an `invalidateNodeView` rebuild is untested.
- Selection (Task 17): a caret parked at (block element, n) is no longer rewritten by the leaf rewrite.
- Normalize rule 10 changes the `getJSON()` output: inline elements now get (possibly empty) text siblings on each side, so stored JSON loaded and read back gains `{ text: '' }` nodes around mentions and other inline elements. Needs a changelog / docs note for integrators who diff or store JSON.

## Mention
- The keydown comment near `mention/src/index.ts:411` says the popup stays open after a zero-results Enter; the split moves the caret out of the trigger, so `refresh` closes it. Comment only.
- Caret after a plain `@foo` opens the popup (document in JSDoc).
- Hopping between triggers with the same query clears `dismissedAt`.
- The cache is written during render (`remember()` in two hooks).
- Popup coords don't follow scroll or resize.
- No `aria-activedescendant` or option ids.
- Not all tests assert no `console.error`; the `Label` type in a test is awkward; the `commands` cast assumes the plugin name.
- "Renamed user" is fetch-driven through the suggestion cache; `renderUser` reading an external store is not subscribed (document in `useMention` JSDoc).
- Secondary view roots carry `data-hte-<plugin>-<view>` (popup: `data-hte-mention-suggestion`) so `[data-hte-<plugin>]` matches only node views (documented in the guide).
- ✅ ~~Review Focus items not covered in e2e: mention copy/paste with a fresh id, a mention inside a code block, a space closing the popup. Confirm unit coverage.~~ Unit coverage confirmed (line numbers as of `51be87e`): `inline-atom.test.ts:112`, `mention.test.ts:84/384/241`, `code-block.test.ts:282`.
- `useMention` re-renders every mention chip while the popup is open (each view subscribes to the mention plugin state, which changes on every query and result).

## Code block
- ✅ ~~Normalize rule 11 (split inline blocks at `\n`) restarts from the root per split, so it is super-linear in the number of newlines: Backspace-joining a 1000-line code block takes ~170 ms, 2000 lines ~1.4 s; `setContent` with a 2000-line paragraph ~0.5–1.5 s. Split all newlines of a block in one pass.~~ Closed in M4 part 1.
- Nested blocks (lists) lose newlines when pasted into a code block (`plainText` joins children with `""`).
- Text with newlines pasted outside a code block splits paragraphs (untested for a non-code source).
- A vetoed line-break tr in a code block falls through to core `splitBlock`.
- Hard-coded `aria-label` "Language" (i18n).
- Tests 4 and 7 have spies that are not asserted.
- `useCodeBlock` is not memoized.
- No `hljs` class on `<code>` (documented in the guide).
- The `decorations` hook walks the whole doc (`nodeEntries`) on every view update to find code blocks; tokens are cached per node, but the walk is O(doc). Track code block paths or skip unchanged subtrees.
- The `setLanguage` rejected path is untested.
- Multi-line code paste into a paragraph is not in e2e.

## Image
- Hooks read plugin state by the hard-coded plugin name (`image`); extending under a new name breaks them (documented).
- `useImageResize` measures the first `<img>` inside `closest([data-hte-node-view])` (documented contract).
- The `afterEach` in the resize tests asserts before cleanup/restore (cascade failures).
- Clamp max is the container's `clientWidth` (pre-existing).
- The portal handle fallback is a heuristic.
- The image resize e2e locates via `img`, not `[data-hte-image]`.
- The older image items in `m2-followups.md` still apply.

## React adapter
- Type tests lack positive "fewer props" and negative "extra required prop" cases for `parts`.
- `PartsOverride` has no excess-key check for spread variables.
- A `{ Img: undefined }` fallback is untested.
- `resolveParts` always returns `| null`.
- `usePluginState` is not tied to the editor's plugins; its tests lack ZW/atom/decorated cases and a stateless plugin.
- Doc sentences on nested dispatch, hook-vs-event order, and StrictMode mount counts are not verified against code (Task 16).
- Part keys are camelCase (`img`, `altInput`, `resizeHandle`, `popup`, `list`, `item`, `toolbar`, `languageSelect`, `content`), matching `classNames` (ruling from Task 10).
- The docs-examples type test lives in `packages/plugins/image/test` because core cannot resolve react, `@hte/react` or zod (ruling from Task 16).

## Tests / tooling
- `pnpm vitest` at the root may fail with "Command not found" when `node_modules` is incomplete; `pnpm install --offline` fixes it. Use `pnpm exec vitest`.
- Core `bindCommands` returns false when the pipeline drops a tr (filter veto); kept (ruling from Task 13).
- Consider a clearer failure, or a configurable port, when the e2e port is taken.
