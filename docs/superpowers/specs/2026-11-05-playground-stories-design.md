# Playground as a story browser (short design)

## Intent
The playground becomes a demo of the library for other people: a Storybook-like page where a viewer picks a story from a sidebar, reads one line on what to try, and plays with the editor. Developers who want to use the library install the packages; the playground does not need copyable usage code.

## Goals
- A sidebar on the left lists the stories, grouped by plugin.
- Each story has a title and a one-line description of what it shows and what to try.
- The URL names the story (`#/<group>/<story>`), so a link opens that story directly; back/forward switch stories.
- The document panel (JSON / HTML) sits under the editor and can be collapsed.
- Styling with Tailwind utility classes first (project owner's call), a clean and simple look.

## Non-goals
- A usage/code-snippet tab, controls, addons.
- One editor per story with only that story's plugins: all stories keep the one shared editor with all six plugins.
- Deploying the playground anywhere.

## Anti-goals
- Breaking or weakening any e2e test.
- Adding dependencies beyond Tailwind (no Storybook, Ladle or a router library).
- Tailwind leaking into the library packages: it is a playground-only dev dependency.

## Constraints
- `window.editor` stays the dev hook the e2e tests use.
- The query flags `?uploadFail=1` and `?slowUsers=1` keep working next to the hash.
- Every existing `data-testid` the tests use stays (`editor`, `bold`, `font-size`, `undo`, `redo`, `image-file`, `code-block`, `nv-*`, `custom-alt-caption`).

## Approaches
- **A. Hand-written in the current app (picked).** Extend `scenarios.ts` into a story list, add a sidebar and a ~20-line hash router to `App.tsx`. No dependency besides Tailwind; e2e only changes `openScenario`.
- B. Real Storybook: heavy dependencies, stories run in an iframe so every e2e test would need rewriting.
- C. Ladle: lighter than Storybook, but still a dependency and the e2e tests would follow its page structure.

## Design
- **Stories** (`src/stories.ts`, replacing `scenarios.ts`): each entry keeps its current key as `id` and adds `group`, `slug`, `title`, `description`, plus the existing `content` and `imageView`. Groups and stories:
  - Basics: Empty, Paragraphs, Pasted HTML, Unknown block
  - Bold: Bold
  - Font size: Font sizes
  - Image: Image, Custom image view
  - Mention: Mention
  - Code block: Code block
- **Router**: reads `location.hash`, listens to `hashchange`; an unknown or empty hash shows the first story (Empty). Switching story calls `editor.setContent` as today.
- **Layout**: sidebar (group headings, story links with `data-testid="story-<id>"` and `aria-current` on the active one) | main column: story title, description, toolbar, editor, collapsible document panel (`<details>`, JSON and HTML side by side or stacked).
- **Styling (Tailwind v4)**: `tailwindcss` and `@tailwindcss/vite` as playground dev dependencies, registered in `vite.config.ts`; `styles.css` starts with `@import "tailwindcss"`.
  - Utility classes on every element the playground renders: the shell, sidebar, toolbar, document panel, the custom image view (`image-views.tsx`) and the mention popup (through `MentionSuggestion`'s `classNames`).
  - DOM the plugins render (`[data-hte-*]` attributes, `hljs-*` tokens, the resize handle) cannot take classes from the playground, so its rules stay in `styles.css`, rewritten with `@apply` / theme variables where that reads better.
  - Preflight (Tailwind's reset) is on; the editor's paragraph margins and the image sizes are set again explicitly so the e2e geometry (resize drag, clicks by position) still holds.
- **e2e**: `openScenario(page, id, path)` clicks `story-<id>` in the sidebar and waits until that link is current; spec files are untouched. The scenario `<select>` and the View/Code tabs go away.

## Left to the builder
- Exact classes, spacing and colours; narrow-screen behaviour (sidebar on top is fine).
- Description wording for each story.
