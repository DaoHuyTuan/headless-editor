# Playground Story Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/playground` into a Storybook-like demo: a sidebar of stories grouped by plugin, a hash URL per story, a description line per story, a collapsible JSON/HTML panel, styled with Tailwind.

**Architecture:** One shared editor (all six plugins) stays mounted; a story list (`src/stories.ts`) plus a tiny hash router (`src/router.ts`) decide which content is loaded. The page shell is React with Tailwind utility classes; DOM rendered by the plugins keeps attribute-selector rules in `styles.css`.

**Tech Stack:** React 19, Vite 7, Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/vite`), Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-playground-stories-design.md`

## Global Constraints
- Tailwind is a dev dependency of `apps/playground` only; no package under `packages/` changes.
- No other new dependency (no Storybook, Ladle or router library).
- `window.editor` stays the dev hook; the same editor instance survives story switches.
- `?uploadFail=1` and `?slowUsers=1` keep working next to the hash.
- Every `data-testid` the e2e uses stays: `editor`, `bold`, `font-size`, `code-block`, `image`, `image-file`, `undo`, `redo`, `json`, `html`, `nv-*`, `custom-alt-caption`. The `image-resize` class and `hljs-*` classes stay.
- No e2e assertion is weakened; spec files other than `helpers.ts` and the new `stories.spec.ts` are not edited.
- e2e runs with `pnpm --filter playground e2e:chromium` and `e2e:webkit`. If port 5174 is busy, never kill its holder: run through an uncommitted copy of `playwright.config.ts` on another port and delete the copy afterwards. Never kill anything on 5173.
- Commits are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files explicitly.

## Review Focus
1. A deep link with a query flag (`/?slowUsers=1#/mention/basic`) opens that story, and switching stories keeps the flag in the URL. Test in Task 3.
2. Clicking the story that is already open restores its original content (a demo viewer expects "click again = start over"; no `hashchange` fires, so it needs its own handler). Test in Task 3.
3. A hand-typed hash with different case or a trailing slash (`#/Bold/Basic/`) opens the story; an unknown one falls back to Empty without an error. Unit test in Task 2.
4. Back/forward after editing loads the stories' original content, and the toolbar state (Bold active, font size) follows the new content. Test in Task 3.
5. A phone-width viewport (375 px) stacks the sidebar above the editor with no horizontal page scroll. Test in Task 3.

---

### Task 1: Tailwind, with the current page restyled

The page keeps its current structure (scenario select, View/Code tabs); only the styling moves to Tailwind. This isolates the Preflight risk before the layout changes.

**Files:**
- Modify: `apps/playground/package.json` (dev deps `tailwindcss@^4.1.0`, `@tailwindcss/vite@^4.1.0`)
- Modify: `apps/playground/vite.config.ts` (add `tailwindcss()` before `react()`)
- Modify: `apps/playground/src/styles.css`
- Modify: `apps/playground/src/App.tsx`, `Toolbar.tsx`, `CodePanel.tsx`, `image-views.tsx`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `styles.css` starting with `@import "tailwindcss";`, then only rules for plugin-rendered DOM under `.editor` (`[data-hte-*]`, `hljs-*`, `.image-resize`). Later tasks style new elements with classes only.

- [ ] **Step 1: Record the baseline.** Run `pnpm --filter playground e2e:chromium` and `pnpm --filter playground e2e:webkit`. Expected: Chromium all pass; WebKit pass with the known skips (keyboard clipboard on WebKit, CDP-only IME). Note the counts; they are this task's bar.
- [ ] **Step 2: Install.** `pnpm --filter playground add -D tailwindcss@^4.1.0 @tailwindcss/vite@^4.1.0` (needs network). Register the plugin in `vite.config.ts`.
- [ ] **Step 3: Restyle.**
  - Elements the playground renders get utility classes: `body` via classes on the root container (`min-h-screen bg-neutral-50 text-neutral-900`), header, tabs, toolbar buttons (`data-[active=true]:bg-neutral-900 data-[active=true]:text-white`, `disabled:opacity-40`), selects, `CodePanel` `<pre>`, the custom image view's figure/figcaption/badge/input, the mention popup and items through `MentionSuggestion` `classNames` (`data-[selected]:bg-blue-600 data-[selected]:text-white` on the item).
  - Where a view offers a `classNames` slot (`ImageView` `resizeHandle`, `MentionView` `root`/`label`), pass Tailwind classes; the resize handle keeps `image-resize` alongside them.
  - `styles.css` keeps, under `.editor`, the rules for plugin-rendered DOM: paragraphs (`margin: 0 0 8px` set explicitly, Preflight zeroes it), unknown block box, `[data-hte-selected]` outline, `[data-hte-image]` layout and `img` sizing, `.image-resize` position, mention chip and `.hte-mention-query`, code-block frame and `pre`, `hljs-*` colours. Use `@apply` or `var(--color-*)` where it reads better; keep the same geometry (handle offsets `bottom: 26px` / `50px`, `right: -5px`, 10 px size).
- [ ] **Step 4: Check by eye.** `pnpm --filter playground dev` (any free port other than 5173/5174 if those are busy), open each scenario in the browser pane, compare with the pre-Tailwind look: same layout, nothing unstyled.
- [ ] **Step 5: Run e2e.** Same two commands as Step 1. Expected: the same pass/skip counts as the baseline.
- [ ] **Step 6: Commit.**
```bash
git add apps/playground/package.json apps/playground/vite.config.ts apps/playground/src/styles.css apps/playground/src/App.tsx apps/playground/src/Toolbar.tsx apps/playground/src/CodePanel.tsx apps/playground/src/image-views.tsx pnpm-lock.yaml
git commit -m "chore(playground): style with Tailwind"
```

### Task 2: Story list and hash router

**Files:**
- Create: `apps/playground/src/stories.ts` (replaces `scenarios.ts`; delete that file in Task 3 when its last import goes)
- Create: `apps/playground/src/router.ts`
- Create: `apps/playground/test/router.test.ts`
- Modify: `vitest.config.ts` (add `'apps/playground/test/**/*.test.ts'` to `include`)

**Interfaces:**
- Produces:
  - `interface Story { id: StoryId; group: string; slug: string; title: string; description: string; content: Doc | string; imageView?: 'default' | 'custom' }`
  - `type StoryId = 'empty' | 'paragraphs' | 'pastedHtml' | 'unknownBlock' | 'bold' | 'fontSizes' | 'image' | 'customImage' | 'mention' | 'codeBlock'` (the old scenario keys, so e2e ids are unchanged)
  - `const stories: readonly Story[]` in sidebar order; `const storyGroups: readonly { name: string; stories: readonly Story[] }[]`
  - `storyHash(story: Story): string` → `'#/<group-slug>/<slug>'`
  - `storyFromHash(hash: string): Story` → the matching story, else `stories[0]` (Empty)
- Story table (group, slug, title): Basics `empty` Empty, `paragraphs` Paragraphs, `pasted-html` Pasted HTML, `unknown-block` Unknown block; Bold `basic` Bold; Font size `sizes` Font sizes; Image `default` Image, `custom-view` Custom image view; Mention `basic` Mention; Code block `javascript` Code block. Group slugs: `basics`, `bold`, `font-size`, `image`, `mention`, `code-block`. Content and `imageView` move over unchanged from `scenarios.ts`. Descriptions: one sentence each saying what to try (wording is the builder's call; e.g. Mention: "Type @ to search users; Backspace after a mention removes it whole.").

- [ ] **Step 1: Write the failing tests** in `apps/playground/test/router.test.ts`:
  - `storyHash(story('bold'))` is `'#/bold/basic'`; `storyHash(story('customImage'))` is `'#/image/custom-view'`.
  - for every story, `storyFromHash(storyHash(s)).id === s.id` (round trip).
  - `storyFromHash('#/Bold/Basic/').id === 'bold'`.
  - `storyFromHash('').id`, `storyFromHash('#/').id` and `storyFromHash('#/nope/missing').id` are all `'empty'`.
  - story ids are unique and every `(group, slug)` pair is unique.
  - `storyGroups.map((g) => g.name)` equals `['Basics', 'Bold', 'Font size', 'Image', 'Mention', 'Code block']`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/playground/test/router.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `stories.ts` and `router.ts`. `storyFromHash` strips the leading `#`, trims slashes, lowercases, then looks up `<group>/<slug>`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `pnpm typecheck`: PASS.
- [ ] **Step 5: Commit.**
```bash
git add apps/playground/src/stories.ts apps/playground/src/router.ts apps/playground/test/router.test.ts vitest.config.ts
git commit -m "feat(playground): story list and hash router"
```

### Task 3: Story browser shell

**Files:**
- Create: `apps/playground/src/Sidebar.tsx`
- Create: `apps/playground/src/use-story.ts`
- Create: `apps/playground/e2e/stories.spec.ts`
- Modify: `apps/playground/src/App.tsx`, `CodePanel.tsx`
- Modify: `apps/playground/e2e/helpers.ts` (`openScenario` only)
- Delete: `apps/playground/src/scenarios.ts`
- Modify: `README.md` § "Run the playground" (lines 38-46 describe the View/Code tabs and the Scenario menu: describe the sidebar, story URLs and the Document panel instead)

**Interfaces:**
- Consumes: `stories`, `storyGroups`, `storyHash`, `storyFromHash`, `Story`, `StoryId` (Task 2).
- Produces:
  - `useStory(): Story`: the story for `location.hash`, updated on `hashchange`.
  - `<Sidebar current={Story} onPick={(story: Story) => void} />`: `<nav aria-label="Stories">`, a heading per group, an `<a href={storyHash(s)} data-testid={`story-${s.id}`} aria-current={s === current ? 'page' : undefined}>` per story. `onPick` fires on every click (including the current story).
  - `openScenario(page, id: string, path = '/')` keeps its signature.

Layout (Tailwind, from the spec): `md:` and up, a fixed-width sidebar (`w-56`) left of a main column (`max-w-3xl`); below `md`, the sidebar stacks on top. Main column: `<h1>` story title, `<p>` description, `<Toolbar>`, `<EditorContent>` (unchanged props), `<MentionSuggestion>`, then `<details data-testid="doc-panel">` with summary "Document" holding `CodePanel` (JSON and HTML). The scenario `<select>` and the View/Code tabs are removed. `CodePanel` renders only while the `<details>` is open (it serializes on every transaction).

Story switching in `App`: `const story = useStory()`; an effect on `story.id` calls `editor.setContent(story.content)` (skip the first run: `useEditor` already got `story.content`). `onPick(s)` with `s === story` calls `editor.setContent(s.content)` (the re-click reset; no `hashchange` fires). `ImageViewKindContext` gets `story.imageView ?? 'default'`.

- [ ] **Step 1: Write the failing e2e** `apps/playground/e2e/stories.spec.ts` (use `openPlayground`, `getText`, `getDoc` from helpers; assert no page errors with the existing collector):
  - `a deep link opens its story`: `goto('/#/code-block/javascript')`, wait for `window.editor.view`; `getText` starts with `'A JS snippet:'`; `story-codeBlock` has `aria-current="page"`; the `h1` reads `Code block`.
  - `clicking a story updates the URL and the content`: open `/`, click `story-bold`; `page.url()` ends with `#/bold/basic`; the editor contains a `strong`/bold mark (assert via `getDoc`: a text leaf with mark type `bold`).
  - `back and forward switch stories and the toolbar follows`: open `/#/bold/basic`, put the caret inside "bold" (`setCaret`), `bold` button has `aria-pressed="true"`; click `story-paragraphs`; `page.goBack()`: text equals the Bold story's original text even after typing `X` into Paragraphs before going back; `goForward()`: Paragraphs' original text.
  - `clicking the open story restores its content`: open `/#/basics/paragraphs`, `focusEnd`, type `zzz`; click `story-paragraphs`; `getText` equals the original three paragraphs.
  - `an unknown hash shows the first story`: `goto('/#/nope')`; `story-empty` is current; no page errors.
  - `a query flag survives a deep link and story switches`: `goto('/?slowUsers=1#/mention/basic')`; `story-mention` is current; click `story-bold`; `new URL(page.url()).search` is `'?slowUsers=1'` and the hash is `#/bold/basic`.
  - `the document panel shows JSON when opened`: open `/`, `json` testid not visible; click the `doc-panel` summary; `json` contains `"type": "doc"`.
  - `phone width stacks the sidebar`: `setViewportSize({ width: 375, height: 800 })`, open `/#/image/default`; the sidebar's bounding box bottom ≤ the editor's top; `document.documentElement.scrollWidth <= innerWidth`.
- [ ] **Step 2: Run** `pnpm --filter playground exec playwright test e2e/stories.spec.ts --project=chromium`. Expected: FAIL (no `story-*` links).
- [ ] **Step 3: Implement** `use-story.ts`, `Sidebar.tsx` and the new `App.tsx` layout; move `CodePanel` into the `<details>`; delete `scenarios.ts`.
- [ ] **Step 4: Update `openScenario`**: `openPlayground(page, path)`, then click `story-<id>` and wait until it has `aria-current="page"`. Keep the JSDoc ("switches to `scenario`, waiting until its content is in the editor").
- [ ] **Step 5: Run** `stories.spec.ts` on Chromium: PASS. Then the full `pnpm --filter playground e2e:chromium` and `e2e:webkit`: the Task 1 counts plus the new tests (WebKit: the new tests pass too).
- [ ] **Step 6: Run** `pnpm typecheck` and `pnpm test`: PASS (re-run the normalize perf file alone if it flakes).
- [ ] **Step 7: Check by eye** in the browser pane at desktop and 375 px width.
- [ ] **Step 8: Commit.**
```bash
git add apps/playground/src/App.tsx apps/playground/src/CodePanel.tsx apps/playground/src/Sidebar.tsx apps/playground/src/use-story.ts apps/playground/e2e/stories.spec.ts apps/playground/e2e/helpers.ts README.md
git rm apps/playground/src/scenarios.ts
git commit -m "feat(playground): story browser with sidebar and hash URLs"
```
