import hljsCore from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

/** A highlighted span of a code block's text: UTF-16 offsets into that text, and its CSS class(es). */
export interface HighlightToken {
  from: number
  to: number
  className: string
}

/**
 * Tokenizes `code` written in `language`. Must be pure (it runs on every view update) and return
 * no tokens for a language it does not know. Offsets are UTF-16 offsets into `code`.
 */
export type Highlighter = (code: string, language: string) => HighlightToken[]

// A private instance, so registering languages never touches an app's global `hljs`.
const hljs = hljsCore.newInstance()
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
// `xml` also registers its aliases, among them `html`.
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" }

/**
 * Turns highlight.js's HTML output (`<span class="hljs-…">`, escaped text) back into tokens over the
 * unescaped text. Nested spans each give a token; spans without an `hljs-` class (e.g. a sublanguage
 * wrapper) give none.
 */
function tokensOf(html: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  const open: { className: string; from: number }[] = []
  let offset = 0
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|&([#\w]+);|[^<&]+/g)) {
    if (m[1] !== undefined) {
      open.push({ className: m[1], from: offset })
    } else if (m[0] === '</span>') {
      const span = open.pop()
      if (span && offset > span.from && /(^|\s)hljs-/.test(span.className))
        tokens.push({ from: span.from, to: offset, className: span.className })
    } else if (m[2] !== undefined) {
      offset += (ENTITIES[m[2]] ?? m[0]).length
    } else {
      offset += m[0].length
    }
  }
  return tokens
}

/**
 * highlight.js (core build) with `javascript`, `typescript`, `json`, `css`, `xml` (`html`), `python`
 * and `bash`. Unknown languages (including `plaintext`) give no tokens.
 */
export const defaultHighlighter: Highlighter = (code, language) => {
  if (!code || !hljs.getLanguage(language)) return []
  return tokensOf(hljs.highlight(code, { language, ignoreIllegals: true }).value)
}
