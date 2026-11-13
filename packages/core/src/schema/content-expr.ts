/** AST of a content expression such as `paragraph block*`. */
export type ContentExpr =
  | { kind: 'name'; name: string }
  | { kind: 'seq'; items: ContentExpr[] }
  | { kind: 'choice'; items: ContentExpr[] }
  | { kind: 'repeat'; expr: ContentExpr; min: number; max: number } // max = Infinity for * + {n,}

interface Token {
  /** 'name' | 'num' | one of ( ) | * + ? { } , | 'end' */
  type: string
  value: string
  /** 1-based column of the token start. */
  col: number
}

const NAME_START = /[A-Za-z_]/
const NAME_PART = /[A-Za-z0-9_-]/

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    if (/\s/.test(c)) {
      i++
    } else if (NAME_START.test(c)) {
      const start = i
      while (i < source.length && NAME_PART.test(source[i]!)) i++
      tokens.push({ type: 'name', value: source.slice(start, i), col: start + 1 })
    } else if (/[0-9]/.test(c)) {
      const start = i
      while (i < source.length && /[0-9]/.test(source[i]!)) i++
      tokens.push({ type: 'num', value: source.slice(start, i), col: start + 1 })
    } else if ('()|*+?{},'.includes(c)) {
      tokens.push({ type: c, value: c, col: i + 1 })
      i++
    } else {
      throw syntaxError(source, `Unexpected character '${c}'`, i + 1)
    }
  }
  tokens.push({ type: 'end', value: '', col: source.length + 1 })
  return tokens
}

function syntaxError(source: string, message: string, col: number): SyntaxError {
  return new SyntaxError(`${message} in content expression "${source}" at column ${col}`)
}

/**
 * Parses a content expression: names, sequence by spaces, `|`, parentheses and the
 * quantifiers `* + ? {n} {n,} {n,m}`. Throws `SyntaxError` carrying the source and column.
 */
export function parseContentExpr(source: string): ContentExpr {
  const tokens = tokenize(source)
  let pos = 0
  const peek = (): Token => tokens[pos]!
  const fail = (msg: string, t: Token = peek()): never => {
    throw syntaxError(source, msg, t.col)
  }

  function parseChoice(): ContentExpr {
    const items = [parseSeq()]
    while (peek().type === '|') {
      pos++
      items.push(parseSeq())
    }
    return items.length === 1 ? items[0]! : { kind: 'choice', items }
  }

  function parseSeq(): ContentExpr {
    const items: ContentExpr[] = []
    while (peek().type === 'name' || peek().type === '(') items.push(parsePostfix())
    if (items.length === 0) return fail('Expected a name or "("')
    return items.length === 1 ? items[0]! : { kind: 'seq', items }
  }

  function parsePostfix(): ContentExpr {
    let expr = parseAtom()
    for (;;) {
      const t = peek()
      if (t.type === '*') expr = { kind: 'repeat', expr, min: 0, max: Infinity }
      else if (t.type === '+') expr = { kind: 'repeat', expr, min: 1, max: Infinity }
      else if (t.type === '?') expr = { kind: 'repeat', expr, min: 0, max: 1 }
      else if (t.type === '{') {
        pos++
        const min = parseNum()
        let max = min
        if (peek().type === ',') {
          pos++
          max = peek().type === 'num' ? parseNum() : Infinity
        }
        if (peek().type !== '}') fail('Expected "}"')
        if (max < min) fail(`Invalid range {${min},${max}}`, t)
        expr = { kind: 'repeat', expr, min, max }
      } else return expr
      pos++ // the quantifier token, or the closing '}'
    }
  }

  function parseNum(): number {
    const t = peek()
    if (t.type !== 'num') return fail('Expected a number')
    pos++
    return Number(t.value)
  }

  function parseAtom(): ContentExpr {
    const t = peek()
    if (t.type === 'name') {
      pos++
      return { kind: 'name', name: t.value }
    }
    if (t.type === '(') {
      pos++
      const inner = parseChoice()
      if (peek().type !== ')') fail('Expected ")"')
      pos++
      return inner
    }
    return fail('Expected a name or "("')
  }

  const result = parseChoice()
  if (peek().type !== 'end') fail(`Unexpected '${peek().value}'`)
  return result
}
