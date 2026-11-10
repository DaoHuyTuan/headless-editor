# CLAUDE.md

Project memory for agents. Read this first; open the longer docs only when a task needs them.

## What this is
A headless rich-text editor with its own engine (not ProseMirror). It is a pnpm monorepo in TypeScript.
- `packages/core`: `@penline/core`. Framework-free: model, ops, transactions, history, plugins, DOM view.
- `packages/react`: `@penline/react`. Provides `useEditor`, `EditorContent`, `useEditorState`, `usePluginState`, node views rendered through portals, and the customization helpers (`resolveParts`, `dataAttrs`).
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
- e2e: `pnpm --filter playground e2e` (Chromium + WebKit), or `e2e:chromium` / `e2e:webkit` alone. Firefox is not in the suite.
  - The e2e server uses port 5174. If that port is busy, never kill the process holding it. Run through an uncommitted copy of `apps/playground/playwright.config.ts` with another port, and delete the copy afterwards.
  - Never kill anything on 5173 either.
- One normalize perf test is timing-sensitive. If it flakes under load, re-run that file alone.

## Conventions
- English in code, docs, specs and plans.
- Commit messages are conventional (`feat(core): …`, `fix(…)`, `docs: …`) and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Stage files explicitly. Never run `git add -A` or `git add .`, stash, or reset when other agents may share the checkout.
- TDD: write a failing test first. Never weaken an assertion to make a test pass.
- A change users of a published package can notice gets a changeset (`pnpm changeset`, or a file in `.changeset/`): patch for fixes, minor for features or 0.x breaking changes. Docs, tests and internal refactors need none.
- Match the surrounding code's style and comment density. JSDoc states contracts, including "acts on the main range on purpose" where that applies.

## Navigating code cheaply: Serena by default
This repo is set up for the Serena MCP server. Its config is `.serena/project.yml`, which uses the TypeScript language server and ignores `.superpowers/`, `dist/` and the Playwright output.

**Use Serena first for code reading and edits.** The core files are long (`text.ts`, `editor.ts`, `history.ts`), so read single symbols instead of whole files.

1. Call `initial_instructions` once per session. It gives the session id.
2. Call `activate_project` with `headless-text-editor`, or with the repo path.
3. Work through `serena_repl`:
   - `s.lsp.get_symbols_overview(path)` to see what a file contains;
   - `s.lsp.find_symbol(name, relative_path=..., include_body=True)` to read one symbol;
   - `s.lsp.find_referencing_symbols(...)` to find who uses it;
   - `s.edit.replace_content` / `replace_symbol_body` for edits;
   - `s.lsp.rename_symbol` for renames.
4. Batch independent Serena calls in one turn.
5. Remember that Serena's line numbers are 0-based.

Serena's own project memory (`.serena/memories`) only points back to this file. Keep project knowledge here, not in Serena memories.

If Serena isn't available in a session, grep for the symbol and read only the relevant line range.
