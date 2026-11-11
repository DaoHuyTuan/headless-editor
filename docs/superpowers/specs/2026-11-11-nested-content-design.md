# Nested content (block containers) — design

Status: draft, 2026-11-11. Author: Claude, with the project owner.

## 1. Intent

penline is going public. Its users will want the block types every modern editor has: block quotes,
bullet, numbered and task lists, toggle lists and tables. All of these hold blocks inside blocks. Today
the core only edits flat documents: a block holds inline content (`content: 'inline'`) or plain text
(`content: 'text'`), and normalize rule 9 unwraps any block nested inside a block.

The owner chose **real nesting**, with **ProseMirror-style content expressions**
(`"listItem+"`, `"paragraph block*"`, `"tableRow+"`). It was preferred over a flat "indent level in
`data`" model and over containers without type rules. Once the core supports it, the container
plugins are built in parallel by subagents.

Success: a plugin author can declare `blockquote` (`content: 'block+'`), `bulletList`
(`content: 'listItem+'`) or `table` (`content: 'tableRow+'`) and get typing, range delete, paste,
HTML import/export and undo inside them from the core, plus generic Enter and Backspace that are
always either valid or a no-op. Structure-specific behaviour (outdenting a list item, splitting an
item on Enter, Tab between cells) is written once in those plugins on top of the core transforms.

## 2. Goals, non-goals, anti-goals

**Goals**
- A content-expression schema layer in the core: `content`, `group`, `marks`, `isolating` on
  `NodeSpec`, compiled to a content-match automaton.
- Normalization driven by the schema at every depth: wrap, fill, unwrap or drop to make any document
  valid.
- Generic structural editing in the core: range delete across depths, join backward/forward across
  container boundaries, Enter and Backspace lifting out of containers, and `Transaction` transforms
  `wrap`, `lift`, `setBlockType`, `split` (at a depth), `join`.
- Slices for copy and paste: a fragment with `openStart`/`openEnd`, fitted into the target position
  according to the schema.
- The view and React layers render containers with the right tags (a table node view must not put a
  `<div>` inside `<tbody>`), and container node views update when their children change.
- Container plugins built on top: `@penline/blockquote`, `@penline/list` (bullet, ordered, task
  lists), `@penline/toggle`, `@penline/table`.

**Non-goals (this project)**
- Cell selection (selecting a rectangle of table cells), merged cells (`colspan`/`rowspan`), column
  resizing. A table range selection is a plain text range.
- Node selection of containers (selecting a whole list or table as one node). Only opaque nodes
  (atoms, unknown types) are node-selectable, as today.
- Drag-and-drop of blocks and the per-block handle with an icon menu (the "row like Notion/ClickUp"
  request). That is its own project, after this one.
- Full ProseMirror parity: no `defining`, `code`, `whitespace`, mark `excludes`/`inclusive`, or
  attribute-based `fillBefore`.
- Virtualized rendering.

**Anti-goals (a failure even if nesting works)**
- Any behaviour change on flat documents. The single-range parity scenarios
  (`packages/core/test/transaction/single-range-*`) and every existing test on flat docs must pass
  byte-identically, except the tests listed in §8 as deliberately changed.
- Slower typing in large flat documents. The normalize perf test must keep passing, and checking a
  content expression must cost per touched node, not per document.
- Silent data loss. Normalization prefers wrap, fill and unwrap over dropping. Dropping is a last
  resort and is limited to nodes that have no editable text, or the text is lifted out first.
- React or any framework entering the core.

## 3. Constraints (from the project)

- Every change is an invertible op. There is no set-type op today. Wrap, lift and type changes are
  composites (`insert_node` plus `move_node`, and the inverse), as rule 2 already does. A new op type
  is allowed if a composite becomes unreasonable, but it must be invertible, transformable and covered
  by rebase.
- `data` is JSON and validated synchronously. A node the schema creates on its own (fill) gets the
  data its schema parses from `{}`. A type whose schema rejects `{}` cannot be auto-created, and fill
  must pick another type or fail visibly in dev.
- Multi-range invariants and the per-range step pattern (`forEachRange`, `RangeStep`) apply to every
  new command and transform.
- `filterTransaction` never vetoes history. Normalization ops fold into the user's undo step as today.
- `@penline/core/internal` has no semver guarantee. The new schema API that plugin authors need is
  public.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Containers with a small rule language (`children: [...]`, allowed parents). | Less work, but cannot say "a paragraph first, then any blocks" or "at least one item". |
| B | Containers accept any block; each plugin keeps its structure with a `normalize` hook. | Smallest core change. Each plugin rewrites the same rules, and pasting mixed content between plugins is hard to keep valid. |
| **C** | **ProseMirror-style content expressions compiled to an automaton (chosen by the owner).** | **Most core work (parser, matcher, fill and wrapping search), but one place makes any document valid and every plugin states its structure in one line.** |

A flat model (lists as paragraphs with an indent level, as Notion stores them) was rejected by the
owner in favour of real nesting.

## 5. Design

### 5.1 Schema layer

`NodeSpec` gains:

```ts
interface NodeSpec {
  kind: 'block' | 'inline'
  atom?: boolean
  default?: boolean
  /** Content expression. 'inline' and 'text' stay as aliases. */
  content?: string
  /** Groups this node belongs to, usable in content expressions. */
  group?: string | string[]
  /** Marks allowed in this node's inline content: '_' (all, default), '' (none), or space-separated mark names. */
  marks?: string
  /** Edits do not cross this node's boundary: no join, no range delete merging it with a neighbour (table cells). */
  isolating?: boolean
}
```

- **Expression grammar** (subset of ProseMirror): a node name or group name; sequence by spaces;
  `|` alternation; parentheses; `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`. `text` is the text node.
- **Groups.** A `kind: 'block'` node is in group `block` unless `group` is given; `kind: 'inline'`
  nodes and text are in group `inline`. A node that sets `group` is only in the groups it lists
  (`listItem` sets `group: []` or a group of its own, so it is not a `block`).
- **Aliases and defaults.** `content: 'inline'` means `inline*`. `content: 'text'` means `text*`
  with `marks: ''` (this replaces the literal check in rule 8). An omitted `content` on a non-atom
  block means `inline*` (a textblock). **Breaking change** for 0.x: today an omitted `content` also
  allows blocks; such plugins must now write `content: 'block+'`. Tests that rely on the dual
  meaning are updated (§8).
- **The doc** has content `block+`.
- **Textblock.** A node whose content expression only matches inline content. The core asserts that
  texts only live in textblocks and inline elements after normalization.
- **Compiled form.** The registry compiles each expression once into a deterministic automaton
  (`ContentMatch`), with: `matchType(type)`, `validEnd`, `fillBefore(fragment, toEnd)` (the nodes to
  insert so that `fragment` fits, using only auto-creatable types), `findWrapping(type)` (the wrapper
  types needed to place `type` here, e.g. `bulletList > listItem` for a paragraph in a list context),
  and `defaultType` (the first auto-creatable type). Unknown names in an expression throw at editor
  creation with the plugin name.
- **Public API.** `registry.isTextblock(type)`, `registry.contentMatch(type)`,
  `registry.createAndFill(type, data?)` are public (exposed through `tr.registry`). The automaton
  internals stay in `@penline/core/internal`.
- **Unknown types** stay opaque and untouched (rule 7). In a content match an unknown node is a
  wildcard that consumes one slot of whatever is expected at its position (a `listItem` whose first
  child is unknown is valid as it is), so loading a doc with a missing plugin never loses it and
  produces no fill ops.

### 5.2 Normalization

Normalization keeps its shape (find one fix, apply, repeat) and its rule numbers for the existing
rules. Changes:

- Rules 2, 5 and 9 generalize into one **content rule** applied to every non-opaque element whose
  children do not match its content expression (the root included). For the first child that does
  not fit, in this order:
  1. A run of inline content where blocks are expected: wrap it into `defaultType` of that position
     (rule 2, at any depth).
  2. A node that fits after inserting some nodes: insert `fillBefore` (an empty list item gets a
     paragraph; a row gets a cell holding a paragraph).
  3. A node that fits inside wrappers: wrap it with `findWrapping` (a paragraph inside a
     `bulletList` becomes a `listItem`).
  4. A non-atom block that does not fit and cannot be wrapped: unwrap it (lift its children into the
     parent at its position), as rule 9 does today.
  5. An atom block inside a textblock: hoist it out, as rule 9 does today.
  6. Otherwise drop it. Before dropping, its texts are lifted out as a default block when the parent
     allows one. This case should be unreachable for documents made of known plugins; it is logged
     in dev.
  
  At the end, if the content is valid but not complete (`validEnd` is false), append `fillBefore(…,
  toEnd)`. An empty container is therefore filled (rule 5 for containers) and never gets a text leaf.
- **Rule 1** (doc never empty) becomes the root case of the fill step.
- **Rules 3, 4, 6, 10, 11** apply to textblocks and inline elements (the `holdsInline` predicate
  becomes "is a textblock or an inline element"). Containers never get spacer texts.
- **Rule 8** reads `marks` and the textblock content instead of `content === 'text'`: marks a node
  does not allow are removed; inline elements a textblock does not allow are unwrapped, or become
  their `renderText` for atoms (as today).
- **Cost.** The content check runs on elements touched by the transaction (the ops' paths and their
  ancestors), plus a full pass on load (`coerceDoc`). The builder decides how normalization learns
  the dirty set; the perf test is the bar.
- Flat documents (paragraph, heading, code block, image, mention at the root) must normalize to
  exactly the same ops as today.

### 5.3 Structural editing in the core

New `Transaction` methods follow the per-range step pattern (each acts on every range, or on an
explicit range, and returns its caret):

- `wrap(type, data?, range?)`: wrap the blocks covered by the range (at the deepest level where they
  are siblings) into `type`, adding inner wrappers from `findWrapping` when needed. Fails (returns
  false, no ops) if the schema does not allow it.
- `lift(range?)`: move the covered blocks out of their parent container, splitting the container if
  the blocks are in its middle. Removes the container if it is left empty. **Core transforms never
  rely on normalization to repair what they produce:** `lift` finds the nearest ancestor depth where
  the result is valid (ProseMirror's `liftTarget`), and returns false with no ops when there is none.
  A paragraph that is the first child of a `listItem` cannot be lifted alone into `bulletList`, so the
  generic Backspace below falls through; the list plugin's `liftListItem` handles it.
- `setBlockType(type, data?, range?)`: change textblocks in the range to another textblock type
  (paragraph to heading), keeping children. A composite of insert, move and remove.
- `split(point, depth = 1, typesAfter?)`: split the textblock and `depth - 1` ancestors at the point;
  `typesAfter` sets the type of each new node (a list plugin splits a `listItem` with depth 2).
  `splitBlockAt` already does the op chain.
- `join(path)`: join two adjacent compatible siblings (two lists of the same type).
- `canWrap`, `canLift`, `canSetBlockType`, `canJoin` checks for `editor.can()`.

Generic commands change as follows (core-plugin intents keep their names):

- **Range delete** (`deleteRangeStep`, including the "not siblings" branch). ProseMirror-style
  replace: nodes fully covered at any depth are removed, the end textblock's content joins the start
  textblock across different parents, containers left empty are removed or refilled by the content
  rule, and isolating nodes are never merged with their neighbours (a range across two cells empties
  the covered text in each cell and keeps both cells).
- **Backspace at a textblock start** (`deleteDirectionStep` and `adjacentBlock`):
  1. If the textblock is the first child of a non-isolating container and `lift` is valid there: lift
     it out (a paragraph at the start of a blockquote). Plugins with their own rule (list items) bind
     Backspace at a higher priority.
  2. Else if the previous position holds a textblock (searching into the last descendant of a
     previous container, without crossing an isolating boundary): join into it.
  3. Else if the previous node is opaque: node-select it, as today.
  4. If the previous node is a container whose last textblock is behind an isolating boundary (a
     table): an empty textblock is removed and the caret goes to the end of the last cell; a
     non-empty one only moves the caret to the end of the last cell (no join).
  5. At the start of an isolating node: nothing.
- **Delete at a textblock end**: the mirror of Backspace (join the next textblock in, searching into
  the first descendant of a next container; never across an isolating boundary; before a table, an
  empty textblock is removed and the caret goes to the start of the first cell, a non-empty one only
  moves the caret there).
- **Enter** (`splitBlock`): splits the textblock as today. If the textblock is empty, inside a
  non-isolating container, and `lift` is valid there, lift it instead (`liftEmptyBlock`); otherwise
  split as usual. When the parent does not allow the
  default block after the split, the new block takes the type the parent's content match expects.
- **Inserting a block or inline node** (`insertBlockNode`, `insertInlineNode`,
  `replaceSelectedNode`): placement is checked against the content match. A block that does not fit
  at the caret goes to the nearest ancestor position that accepts it (splitting ancestors on the
  way) or is wrapped with `findWrapping`. A default block created next to a node is
  `createAndFill(defaultType)` of that position.
- **`isActive(type)`** is true inside a container of that type (any ancestor), as well as for the
  textblock itself.
- **`nodeText`** joins the texts of different textblocks with `\n` (a block separator), so a list or a
  quote reads as lines.
- **Tab** has no core binding. List and table plugins add theirs.

### 5.4 Fragments, clipboard and HTML

- **Slice.** A new public type `Slice = { content: Fragment; openStart: number; openEnd: number }`:
  the content of the range from the common ancestor, plus how many levels are cut open at each end. A
  range across two list items gives the two items with open depth 2 at both ends. `Fragment` (a node
  list) and the signatures of `getFragment`, `insertFragment` and `transformPasted` stay unchanged;
  new `tr.getSlice(range?)` and `tr.insertSlice(slice, range?)` sit next to them, and
  `insertFragment(f)` behaves as `insertSlice` of `f` with today's open depths (edge blocks merge,
  open depth 1 at each end when they are textblocks). The view's paste path uses slices; a
  `transformPasted` hook gets and returns the slice's `content`, and the open depths are kept
  (clamped to what the returned content can support). A `FRAGMENT_MIME` payload without open depths
  (copied from 0.1/0.2) pastes as today.
- **Clipboard HTML** wraps a slice in its ancestors' tags up to the common ancestor (two `<li>` go out
  inside a `<ul>`), so other apps read valid HTML. The `FRAGMENT_MIME` JSON carries the slice with its
  open depths, so penline-to-penline paste is exact.
- **Paste and insertFragment** fit the slice into the target with a ProseMirror-style fitter: open
  start and end content merges into the textblocks at the edges, whole nodes are placed where the
  content match accepts them, with wrapping (`findWrapping`) or unwrapping when needed. Pasting two
  list items into a paragraph inside a list inserts two items; pasting them into a plain paragraph
  creates a list.
- **HTML parse** places parsed content through the same content rules: inline runs inside a
  container are wrapped into the expected textblock (`<li>text</li>` becomes a list item holding a
  paragraph). `ul`, `ol`, `li`, `blockquote`, `table`, `tr`, `td`, `th` keep today's unwrapping
  only when no plugin claims them.
- **Clipboard text** separates textblocks with `\n` at every depth.
- **`sanitizeFragment`** stops wrapping inline runs at the top level only and relies on the content
  rule instead.

### 5.5 View and React

- **Container tags.** A node view can set the tag of its container and of its `contentDOM`
  (`as` and `contentAs`, any block or table tag). `NodeContent` in React takes an `as` prop. Without
  a node view, `renderHTML` already sets tags (`table`, `tr`, `td`).
- **Children updates.** A node view of a non-textblock container is updated whenever its node
  changes, children included, so it can show numbering or a column count. Textblock and atom views
  keep today's rule (data, selection or options).
- **DOM selection and renderer** recursion already handle nesting; no change expected beyond tests.
- **Composition** replacing a node selection uses `createAndFill(defaultType)` of that position.

### 5.6 Container plugins (built after the core, by subagents in parallel)

Each gets its own package under `packages/plugins/`, tests, a playground story and e2e coverage on
Chromium and WebKit.

- **`@penline/blockquote`**: `blockquote`, `content: 'block+'`. Input rule `> `. Command
  `toggleBlockquote` (wrap or lift).
- **`@penline/list`**: `bulletList` (`listItem+`), `orderedList` (`listItem+`, `data: { start }`),
  `taskList` (`taskItem+`), `listItem` (`paragraph block*`), `taskItem` (`paragraph block*`,
  `data: { checked }`, a checkbox view). Commands: toggle each list type, `sinkListItem` (Tab),
  `liftListItem` (Shift+Tab, and Backspace at an item start), `splitListItem` (Enter; Enter in an
  empty item lifts it). Input rules `- `, `* `, `1. `, `[ ] `. Adjacent lists of the same type join.
- **`@penline/toggle`**: `toggle` (`toggleSummary toggleBody`), `toggleSummary` (inline content),
  `toggleBody` (`block+`), `data: { open }`. Collapsing hides the body in the view only; the content
  stays in the document.
- **`@penline/table`**: `table` (`tableRow+`), `tableRow` (`(tableCell | tableHeader)+`), cells
  (`block+`, `isolating: true`). Commands: insert table, add and delete rows and columns, Tab and
  Shift+Tab to move between cells (Tab in the last cell adds a row). A content rule keeps rows the
  same width (a plugin `normalize` hook).

Charts, combo box, multi check and the simpler plugins (italic, strikethrough, link, divider, tag,
button, slash menu) do not need nesting and are planned separately; they can run in parallel with
this project.

## 6. Decided with the owner

- Real nesting, not an indent level in `data`.
- Content expressions in the ProseMirror style (approach C).
- Container plugins are implemented by subagents once the core supports nesting.

## 7. Calls made by the author (open to correction)

- The grammar subset, groups defaulting to `block`/`inline`, and the `marks` and `isolating` fields.
- Omitted `content` on a non-atom block means a textblock (breaking in 0.x, with a changeset).
- Normalization order: wrap inline runs, fill, wrap, unwrap, hoist, and drop last.
- Backspace at the start of a container's first child lifts; Enter in an empty textblock inside a
  container lifts.
- `isActive` checks ancestors.
- No cell selection, merged cells or container node selection in this project.
- Core transforms are valid or no-ops; list and toggle structure behaviour belongs to their plugins.
- Backspace after a table removes an empty paragraph or moves the caret into the last cell.
- `Slice` is a new type next to an unchanged `Fragment`; old clipboard payloads still paste.
- An unknown node is a wildcard in content matching.
- Nested behaviour is specified test-first; it is not recorded from today's code.
- Package split: blockquote, list (all list types in one package), toggle, table.

## 8. Tests that change on purpose

- normalize.test.ts: rule 2 at the root only (:46), rule 5 for any childless block (:113), rule 9
  unwrap and hoist (:161, :173, :183-215): rewritten for the content rule, the flat cases kept.
- html.test.ts:162-165 and :171-174 (blockquote and unknown containers unwrapped): still true when no
  plugin claims the tags; new tests for claimed tags.
- edge-cases.test.ts:138-157 (containers pasted as siblings) and :365-389 (non-sibling delete leaves
  `quote(p(''))`): become fitting and join tests.
- clipboard.test.ts:36 and :181: text separators and wrapping at every depth.
- Fixtures declaring `node: { kind: 'block' }` with nested blocks (fragment.test.ts:9, editor.test.ts,
  edge-cases.test.ts, load.test.ts): get `content: 'block+'`.

Every other existing test, and the single-range parity scenarios, must pass unchanged. For nested
documents, the expected outcomes of each new behaviour (§5.3, §5.4) are written first as failing
tests (TDD). Once a command works on nested documents, its multi-range results are pinned against
its single-range results, as `single-range-*` does today for flat ones. Today's nested behaviour is
not frozen.

## 9. Left to the builder

- The automaton construction (ProseMirror's NFA-to-DFA approach is a good reference; do not copy its
  code verbatim).
- How normalization tracks the touched elements.
- Whether wrap and lift stay composites of existing ops or get a dedicated op.
- The exact fitter algorithm for paste, as long as the cases in §5.4 hold.
- The order of the core work, provided each step lands with its tests and flat-doc parity holds
  after each one.
- File layout inside `packages/core/src` (a `schema/` folder is suggested).

## 10. Where the core assumes flat blocks today (survey, 2026-11-11)

- `transaction/text.ts`: `blockPathOf` (nearest non-inline ancestor is the edited block),
  `adjacentBlock`/`adjacentOpaque` (own siblings only, so Backspace at the start of an item does
  nothing), `deleteRangeStep` (the "not siblings" branch deletes text only), `splitBlockStep` and
  `caretNearRemovedBlock`/`emptyDefaultBlock`/`caretAfterNode` (always create `defaultBlock`),
  `insertBlockNodeStep` (no content check), `readBlock`/`runAt` (correct only on textblocks; used by
  input rules and suggestions too).
- `transaction/fragment.ts`: `getFragment` (no open depths), `isContainer` (a heuristic:
  `content === undefined` and holds a block), `insertBlocks` and `insertFragmentStep` (one-level
  merge of edge blocks), `insertInlineNode` (literal `content === 'text'`).
- `normalize.ts`: rule 1 and 2 (root only), 5 (a text leaf in any childless block), 8 (literal
  `'text'`), 9, 10 and 11 (keyed on `content === 'inline'`), `emptyBlock`, `isInlineContent`.
- `html/parse.ts`: `Parser.element` splits an `inline` element around nested blocks; `blockify`
  always wraps into the default block; unclaimed list, quote and table tags are unwrapped.
- `content/text.ts` `nodeText` (no block separator); `content/clipboard.ts` (text joins top-level
  blocks only; HTML has no ancestor context); `content/sanitize.ts` (top-level wrapping only).
- `editor.ts` `blockAt`/`isActive` (nearest block only).
- `view/renderer.ts` (node-view container and `contentDOM` are always `div`/`span`);
  `view/node-view.ts` `update` (not called on children changes); `view/composition.ts` (default
  block on node-selection replace); `transaction.ts` `setSelection` (node ranges only on opaque
  nodes, unchanged).
- Already generic: ops (`split_node`/`merge_node` work on elements at any depth, one level per op;
  `merge_node` needs a previous sibling), history and rebase, path utilities, selection re-homing,
  marks, `splitBlockAt`, serializeHTML, renderer recursion and nested node views, dom-selection,
  React portals and `NodeContent` (apart from its tag).
- A block with no `content` today already acts as a container in a few places (rule 9 skips it,
  parseHTML keeps nested blocks in it, `isContainer`), pinned by `edge-cases.test.ts:138-157` and
  `:365-389`.
