# CLAUDE.md

Project memory for agents. Read this first; open the longer docs only when a task needs them.

## What this is
A headless rich-text editor with its own engine (not ProseMirror). It is a pnpm monorepo in TypeScript.
- `packages/core`: `@hte/core`. Framework-free: model, ops, transactions, history, plugins, DOM view.
- `packages/react`: `@hte/react`. Provides `useEditor`, `EditorContent`, `useEditorState`, `usePluginState`, node views rendered through portals, and the customization helpers (`resolveParts`, `dataAttrs`).
- `packages/plugins/{paragraph,bold,font-size,image,mention,code-block}`: each has its logic in `src/index.ts` and, when it has a view, the React part in `src/react*`.
- `apps/playground`: the Vite demo plus the Playwright e2e tests (`apps/playground/e2e`).

Longer docs:
- `README.md`: usage.
- `docs/plugin-api.md`: the `definePlugin` field reference.
- `docs/plugin-authoring.md`: customization levels and hooks/parts/views.
- `docs/architecture.md`: layers and the future code view.
- `docs/superpowers/specs/*`: specs.
- `docs/superpowers/plans/*`: plans.
- `docs/superpowers/*-followups.md`: known gaps.

## Core map (`packages/core/src`)
- `model/`
  - `types.ts`: `Doc`, `ElementNode`, `TextNode`, `Point {path, offset}`, `Range`, `SelectionRange`, `Selection`.
  - `selection.ts`: `single`, `createSelection` (sort and merge), `mainRange`, `isNodeRange`, `selectionEquals`.
  - `editable.ts`: `nodeSelection`, `isNodeSelection`, `nearestEditablePoint`.
  - `path.ts`, `node.ts`, `find.ts`, `id.ts`.
- `ops/`
  - `types.ts`: invertible ops, including `set_selection`.
  - `apply.ts`, `invert.ts`.
  - `transform.ts`:
    - `transformPoint` / `transformPath` / `transformSelection` drop lost ranges;
    - `transformSelectionStrict` returns null if any range fails, and is used by history and rebase.
  - `rebase.ts`: maps history through ops made outside history.
- `transaction/`
  - `transaction.ts`: the `Transaction` class. `apply` maps the selection through `mapSelection`, which also re-homes lost ranges.
  - `ranges.ts`: `forEachRange`, `RangeStep`, `flagSwallowed`, `mapRun`.
  - `text.ts`: text editing, following the `runStep` pattern.
  - `marks.ts`: marks (`allHaveMark` decides toggle direction and `isActive`).
  - `fragment.ts`: fragments, paste, inline and block inserts.
- `editor.ts`: `Editor` (`dispatch`, the pipeline, `bindCommands`, `can()`, `isActive`, `passesFilters`).
- `history.ts`: undo/redo, grouping, rebase, and folding normalization ops.
- `normalize.ts`: normalization rules. Rule 8 strips marks and atoms in text-only blocks; rule 11 splits inline blocks at `\n`.
- `core-plugin.ts`: default intents (typing, paste, delete) and core commands.
- `content/clipboard.ts`: clipboard parse and serialize.
- `view/`: the DOM view: `renderer`, `dom-selection`, `input` (keydown, beforeinput, the WebKit delete fallback), `composition` (IME), `mutation`, `clipboard` events, `drop`, `node-select`, `decorations`.

## Invariants (do not break)
- Every document change is an invertible op. `data` is JSON (no `undefined`). Validators are synchronous. Core never imports React.
- `Selection = { ranges: SelectionRange[]; main: number }`:
  - `ranges` is never empty, sorted, and never overlapping or touching (touching ranges merge);
  - a node range is always the only range;
  - read the primary range with `mainRange(sel)`.
- Multi-range editing pattern, used by text, marks and fragments:
  - each method has a per-range step that returns its caret and never calls `setSelection`;
  - with no range, the step runs through `tr.forEachRange` (one final `set_selection`);
  - with an explicit range, the method acts only there; inside a callback it replaces the live range only if it touches it;
  - a no-range call inside a `forEachRange` callback throws in dev mode.
- With a single range, behaviour must be byte-identical to before. Recorded parity scenarios live in `packages/core/test/transaction/single-range-*`. Extend them before changing a method.
- `filterTransaction` never vetoes history (`tr.meta.origin === 'history'`).
- HTMLAttributes are merged first and data-driven attributes last (`mergeAttrs`).

## Commands
- `pnpm install`. If vitest is "not found", run `pnpm install --offline`.
- Unit tests: `pnpm exec vitest run <path>` while iterating; `pnpm test` (full) once before committing. Never use watch mode.
- Types: `pnpm typecheck`; type tests: `pnpm exec vitest --typecheck run`.
- e2e: `pnpm --filter playground e2e:chromium` (and `e2e:webkit`). Plain `e2e` also runs Firefox, which cannot launch on this machine.
  - The e2e server uses port 5174. If that port is busy, never kill the process holding it. Run through an uncommitted copy of `apps/playground/playwright.config.ts` with another port, and delete the copy afterwards.
  - Never kill anything on 5173 either.
- One normalize perf test is timing-sensitive. If it flakes under load, re-run that file alone.

## Conventions
- English in code, docs, specs and plans.
- Commit messages are conventional (`feat(core): …`, `fix(…)`, `docs: …`) and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage files explicitly. Never run `git add -A` or `git add .`, stash, or reset when other agents may share the checkout.
- TDD: write a failing test first. Never weaken an assertion to make a test pass.
- Match the surrounding code's style and comment density. JSDoc states contracts, including "acts on the main range on purpose" where that applies.

## Navigating code cheaply
- If the Serena MCP tools are available, prefer them: symbol overview, find symbol, find referencing symbols. Use them instead of reading whole files; the core files are long (`text.ts`, `editor.ts`, `history.ts`).
- Otherwise, grep for the symbol, then read only the relevant line range.
