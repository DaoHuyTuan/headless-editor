/** HTML attributes as plugins emit them; `undefined` omits the attribute. */
export type Attrs = Record<string, string | number | undefined>

/** `options.HTMLAttributes`: trusted, app-author-supplied input; not sanitized; cannot override data-driven attributes. */
export type HTMLAttributes = Attrs

const NAME = /^[A-Za-z][A-Za-z0-9:_.-]*$/

/** Returns `name`, or throws `Invalid HTML attribute name "…"` if it is not a safe attribute name. */
export function checkAttrName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid HTML attribute name "${name}"`)
  return name
}

/**
 * Splits a `style` string into `[property, value]` declarations. A `;` inside quotes or parentheses
 * does not split; comments are dropped (outside strings). As in CSS, an unterminated comment, string
 * or parenthesis runs to the end of the string: the declaration holding an unterminated string or
 * parenthesis is dropped, so it cannot swallow declarations merged after it.
 */
function parseStyle(style: string): [string, string][] {
  const out: [string, string][] = []
  let decl = ''
  let depth = 0
  let quote = ''
  const push = () => {
    const colon = decl.indexOf(':')
    if (!quote && depth === 0 && colon >= 0) {
      const prop = decl.slice(0, colon).trim().toLowerCase()
      const value = decl.slice(colon + 1).trim()
      if (prop && value) out.push([prop, value])
    }
    decl = ''
  }
  for (let i = 0; i < style.length; i++) {
    const c = style[i]!
    if (quote) {
      decl += c
      if (c === '\\' && i + 1 < style.length) decl += style[++i]
      else if (c === quote) quote = ''
    } else if (c === '/' && style[i + 1] === '*') {
      const end = style.indexOf('*/', i + 2)
      if (end < 0) break
      decl += ' '
      i = end + 1
    } else if (c === ';' && depth === 0) push()
    else {
      if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      decl += c
    }
  }
  push()
  return out
}

/** `a` and `b` merged per property (`b` wins), as `prop: value;` joined by a space; '' when none is left. */
function mergeStyle(a: string, b: string): string {
  const props = new Map<string, string>()
  for (const [prop, value] of [...parseStyle(a), ...parseStyle(b)]) {
    props.set(prop, value)
  }
  return [...props].map(([prop, value]) => `${prop}: ${value};`).join(' ')
}

/**
 * Merges `extra` into `base`; neither is changed.
 *
 * - Attribute names are validated like the serializer does (an invalid name throws
 *   `Invalid HTML attribute name "…"`) and lowercased, so `SRC` and `src` are one key.
 * - `class`: the values are joined with a space and de-duplicated.
 * - `style`: parsed as CSS declarations (see `parseStyle`) and merged per property, names compared
 *   case-insensitively, `extra` winning; the output is `prop: value;` joined by a space. A style in
 *   `extra` is normalized like this even when `base` has none; a style with no declaration left is omitted.
 * - Any other key: `extra` overrides `base`.
 * - An `undefined` value in `extra` removes the key.
 */
export function mergeAttrs(base: Attrs, extra?: Attrs): Attrs {
  const out: Attrs = {}
  for (const [rawName, value] of Object.entries(base)) out[checkAttrName(rawName).toLowerCase()] = value
  if (!extra) return out
  for (const [rawName, value] of Object.entries(extra)) {
    const name = checkAttrName(rawName).toLowerCase()
    const prev = out[name]
    if (value === undefined) delete out[name]
    else if (name === 'class' && prev !== undefined) {
      const classes = `${prev} ${value}`.split(/\s+/).filter(Boolean)
      out[name] = [...new Set(classes)].join(' ')
    } else if (name === 'style') {
      const style = mergeStyle(prev === undefined ? '' : String(prev), String(value))
      if (style) out[name] = style
      else delete out[name]
    } else out[name] = value
  }
  return out
}
