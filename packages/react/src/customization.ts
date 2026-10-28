import type { ComponentType } from 'react'

/**
 * Per-part overrides of a view: a replacement component, or `false` to hide the part.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export type PartsOverride<Parts extends Record<string, ComponentType<any>>> = {
  [K in keyof Parts]?: Parts[K] | false
}

/**
 * The standard customization props of a default view: `parts` to replace or hide parts and
 * `classNames` to class the root and each part.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export interface ViewCustomization<Parts extends Record<string, ComponentType<any>>> {
  parts?: PartsOverride<Parts>
  classNames?: { [K in keyof Parts | 'root']?: string }
}

/**
 * Picks, for each part, the override component, the default, or `null` when the part is hidden
 * (`false`). Components are returned as given, so no new component types are created per render.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function resolveParts<Parts extends Record<string, ComponentType<any>>>(
  defaults: Parts,
  overrides: PartsOverride<Parts> | undefined,
): { [K in keyof Parts]: Parts[K] | null } {
  const out = {} as { [K in keyof Parts]: Parts[K] | null }
  for (const key of Object.keys(defaults) as (keyof Parts)[]) {
    const o = overrides?.[key]
    out[key] = o === false ? null : ((o ?? defaults[key]) as Parts[typeof key])
  }
  return out
}

/**
 * Maps boolean state flags to stable `data-*` attributes, present (as `''`) when true and absent
 * otherwise: `{ selected: true, open: false }` gives `{ 'data-selected': '' }`.
 */
export function dataAttrs(flags: Record<string, boolean | undefined>): Record<string, ''> {
  const out: Record<string, ''> = {}
  for (const [name, on] of Object.entries(flags)) if (on) out[`data-${name}`] = ''
  return out
}
