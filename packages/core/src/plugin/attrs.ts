/** HTML attributes as plugins emit them; `undefined` omits the attribute. */
export type Attrs = Record<string, string | number | undefined>

/** The `options.HTMLAttributes` of a rendering plugin: extra attributes merged into its element. */
export type HTMLAttributes = Attrs

const NAME = /^[A-Za-z][A-Za-z0-9:_.-]*$/

/** Returns `name`, or throws `Invalid HTML attribute name "…"` if it is not a safe attribute name. */
export function checkAttrName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid HTML attribute name "${name}"`)
  return name
}

/** Splits a `style` string into `[property, value]` declarations (`;` inside quotes / parentheses does not split). */
function parseStyle(style: string): [string, string][] {
  const out: [string, string][] = []
  let start = 0
  let depth = 0
  let quote = ''
  const push = (end: number) => {
    const decl = style.slice(start, end)
    const colon = decl.indexOf(':')
    if (colon < 0) return
    const prop = decl.slice(0, colon).trim().toLowerCase()
    const value = decl.slice(colon + 1).trim()
    if (prop && value) out.push([prop, value])
  }
  for (let i = 0; i < style.length; i++) {
    const c = style[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) {
      push(i)
      start = i + 1
    }
  }
  push(style.length)
  return out
}

function mergeStyle(a: string, b: string): string {
  const props = new Map<string, string>()
  for (const [prop, value] of [...parseStyle(a), ...parseStyle(b)]) {
    props.set(prop, value)
  }
  return [...props].map(([prop, value]) => `${prop}: ${value};`).join(' ')
}

/**
 * Merges `extra` into `base` (neither is changed). `class` values are joined with a space and
 * de-duplicated; `style` is merged as CSS declarations with `extra` winning per property (names
 * compared case-insensitively, output as `prop: value;` joined by a space); any other key is
 * overridden by `extra`. An `undefined` in `extra` removes the key. Attribute names are validated
 * like the serializer does: an invalid name throws `Invalid HTML attribute name "…"`.
 */
export function mergeAttrs(base: Attrs, extra?: Attrs): Attrs {
  const out: Attrs = {}
  for (const [name, value] of Object.entries(base)) out[checkAttrName(name)] = value
  if (!extra) return out
  for (const [name, value] of Object.entries(extra)) {
    checkAttrName(name)
    const prev = out[name]
    if (value === undefined) delete out[name]
    else if (name === 'class' && prev !== undefined) {
      const classes = `${prev} ${value}`.split(/\s+/).filter(Boolean)
      out[name] = [...new Set(classes)].join(' ')
    } else if (name === 'style' && prev !== undefined) out[name] = mergeStyle(String(prev), String(value))
    else out[name] = value
  }
  return out
}
