---
'@penline/core': minor
---

Schema fields for nested content.

`NodeSpec` gains `content` as a content expression (`'block+'`, `'listItem+'`, `'paragraph block*'`: node and group names, sequence, `|`, parentheses, `* + ? {n} {n,} {n,m}`), `group` (default `block` or `inline`; a node that sets it is only in the groups it lists), `marks` (`'_'` all, `''` none, or mark names) and `isolating`. `'inline'` and `'text'` stay as aliases of `inline*` and `text*` (the latter with no marks). The registry compiles every expression once and exposes `isTextblock(type)`, `contentMatch(type)` and `createAndFill(type, data?)` (through `tr.registry`). An unknown name in an expression, or a node that can never be created, throws at editor creation and names the plugin.

**Breaking:** an omitted `content` on a non-atom block now means inline content only (a textblock). A block that holds other blocks must declare `content: 'block+'` (or a narrower expression).
