# Nested content: followups

Collected from the per-task and final reviews of the nested-content core (branch `feat/nested-content`,
plan `docs/superpowers/plans/2026-11-11-nested-content-core.md`). Items fixed before merge are not listed.

## Before the container plugins (blockquote, list, toggle, table)

- **Consolidate predicates and validity helpers.** `isBlock`/`isBlockNode`/`blockAt`/`blockPathOf`/`blockAncestorOfType`
  live in sanitize, parse, `content/text`, slice, structure, text, editor and code-block; `childrenOf`/`typeOf`
  vs `childrenAt`/`typeAt`; `stub` twice; container predicates in `slice.ts` and `node-view.ts`; four validity
  checks (`validate.isValidDoc`/`fits`, `text.validAt`, `slice.validNode`, `structure.joinable`), not all checking
  `\n`. Move them into one module (`schema/validate.ts` or a predicates module). One drift already caused a bug.
- **Touched-set regression tests.** Only `remove_node` is covered; add `move_node`, element `split_node`,
  `merge_node` and undo/redo cases. The dirty set is load-bearing.
- **Split `transaction/text.ts`** (~1500 lines): move the placement helpers (`placeBlock`, `insertAbove`,
  `insertAboveNode`, `acceptsAt`, `fitsWith`, `defaultNodeAt`, `wrapToFit`, `stub`, …) to `transaction/placement.ts`.
- **Reserve node names** `doc`, `text`, `block`, `inline` (a plugin with one of these names silently changes the
  schema). Reserving later would be breaking, so do it in the next 0.x.
- **Table e2e**: typing in a cell through real DOM input, and `contenteditable` on a `tbody` in real browsers
  (Chromium, WebKit, Firefox manually).

## Schema and automaton

- `ContentMatch.edges` is typed mutable (should be `readonly`).
- No cap on `{n,m}` expansion; `stateFor` recurses once per DFA state (long counted chains can overflow). Cap at
  e.g. 1000 with a `SyntaxError`, or make it iterative.
- JSDoc: an unknown type takes the state's first edge (greedy wildcard). In sequences such as
  `'heading paragraph*'`, `[mystery, heading]` misfits the heading; a set-of-states wildcard would fix it.
- Tests: `fillBefore(…, toEnd: false)`; a cyclic `fillBefore` through creatable types; the cycle test's timeout
  cannot catch a synchronous hang (the fixpoint prevents it today).
- Error wording repeats the type as the plugin name (`registry.ts` ~280).
- `createAndFill` of inline content that excludes text (`'mention*'`) gives `children: []`.
- Mark names in `marks` are not validated against registered marks (documented).
- `wrap` requires `validEnd` while `findWrapping` accepts completable chains (a wrapper needing fill is refused).

## Normalization

- Hoisting an only-child atom out of a container leaves an empty refilled container
  (`box > [img]` → `img, box > p('')`). Remove the container instead.
- Consecutive misfit paragraphs in a list each get their own `listItem`, while paste's `wrapRun` groups them.
- Rules 3/4/6 loop over container children (harmless); rules 3, 4, 6, 9 and 10 still walk the whole doc per fix
  (as before this branch).
- No test for `drop()` with `\n` text and rule 11.
- Misplaced JSDoc of the rule-10 helper (pre-existing).

## Editing commands

- `canWrap`/`canLift` are approximate (some range could change); say so in JSDoc.
- Multi-range `wrap`: inner wrapper data is still validated per range; `wrap` sets `tr.rejected` for invalid outer
  data even when no range could be wrapped.
- `fillMissing`/`missingContent` tries the front fill first even on a chain whose tail was cut (stale caret in exotic
  grammars).
- `planNestedDelete` takes 8 positional parameters (use an options object).
- Failed dry runs consume ids from the generator (document it in `recordIds`); a replay that diverged from its dry
  run would leave partial ops (add a dev-mode throw).
- `insertAboveNode` is less eager than the caret walk at index 0.
- `isInlineOpaque` now treats an unknown element as opaque in text-only blocks too (untested).
- `isActive` on an atom node selection reports the neighbouring block (pre-existing).
- `replaceNodeStep` with an inline node selection inserts a default block inside the textblock (pre-existing).
- Test gaps: `setBlockType` skip / explicit range / multi-range parity; `lift` explicit and multi-range; `join` seam
  marks; multi-range undo; two nested-delete tests without undo checks; the fallback's "text-only invalid → no ops"
  branch; rule 3 with an opaque node inside the previous container; Enter lift + split across ranges; nested `isActive`
  data mismatch and same-type ancestors.

## Paste and clipboard

- Mixed list + quote pasted into a list item splits the caret's list around the quote.
- A lone one-item list whose item ends in a nested list, pasted into a list item, leaves the trailing text as a
  paragraph after the nested list.
- When the two ends would merge at different depths, the fitter falls back to start-only (untested).
- `slice.test.ts` "flat fragment %i: the same ops" is tautological (real parity rests on `single-range-fragment-*`).
- The clipboard text test's first assertion is not nested; stale describe title in `clipboard-nested.test.ts`.
- A node-selected inline atom inside a nested block goes through the fitter (untested).

## View and React

- Node-view tag validation is syntactic only and the error lacks the node type; void elements and `script` are
  accepted as `contentAs`.
- A node-view spec object without `factory` fails late, at render.
- No `.test-d.ts` for `NodeViewSpec` / `ReactNodeViewSpec`.
- `NodeContent placeholder={false}`: a stale `adopters` entry when switching modes (cosmetic); no test for a
  re-render of the view while it adopts.

## Docs

- The changeset is long; `plugin-api.md` lift table wording mentions only the single-range failure case.
- JSDoc line width in `clipboard.ts` / `parse.ts`.
