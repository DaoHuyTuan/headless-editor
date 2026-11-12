---
'@penline/code-block': patch
'@penline/mention': patch
---

`setCodeBlock` converts any textblock with inline content, whatever its content expression says (`'inline'`, `'inline*'` or omitted), and still leaves text-only blocks alone. The mention suggestion and `insertMention` stay out of every textblock whose content does not allow mentions (any text-only block, not only `content: 'text'`). Both read the schema (`registry.isTextblock`, `registry.isTextOnly`, `registry.allowsInline`) instead of comparing `content` literally. (The fixed `@penline/*` group bumps together anyway.)
