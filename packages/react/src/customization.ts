import type { ComponentType } from 'react'

/**
 * Per-part overrides of a view: a replacement component, or `false` to hide the part.
 * An unknown part name is a type error in an object literal, but not when it comes from a spread or
 * a variable (TypeScript has no exact types); such a key is ignored at runtime.
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

/** The override given for part `K` in `O` (`undefined` when `O` is undefined or lacks it). */
type OverrideOf<O, K> = O extends object ? (K extends keyof O ? O[K] : undefined) : undefined

/** Makes a key of `O` that is not a part of `Parts` a type error (the inferred `O` skips the literal check). */
type NoExtraKeys<O, Parts> = O extends object ? { [K in Exclude<keyof O, keyof Parts>]: never } : unknown

/**
 * What `resolveParts` returns: each part's component, `| null` only for the parts whose override
 * may be `false`. Overrides typed `PartsOverride<Parts>` (a view's `parts` prop) make every part
 * nullable; `undefined` or a literal without `false` makes none.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export type ResolvedParts<Parts extends Record<string, ComponentType<any>>, O> = {
  [K in keyof Parts]: false extends OverrideOf<O, K> ? Parts[K] | null : Parts[K]
}

/**
 * Picks, for each part, the override component, the default, or `null` when the part is hidden
 * (`false`). Components are returned as given, so no new component types are created per render.
 * An override given as `undefined` falls back to the default.
 * @experimental Level 3 customization API; may change after M3 without a deprecation cycle.
 */
export function resolveParts<
  Parts extends Record<string, ComponentType<any>>,
  const O extends PartsOverride<Parts> | undefined = PartsOverride<Parts> | undefined,
>(defaults: Parts, overrides: O & NoExtraKeys<O, Parts>): ResolvedParts<Parts, O> {
  const out = {} as Record<keyof Parts, Parts[keyof Parts] | null>
  for (const key of Object.keys(defaults) as (keyof Parts)[]) {
    const o = (overrides as PartsOverride<Parts> | undefined)?.[key]
    out[key] = o === false ? null : ((o ?? defaults[key]) as Parts[typeof key])
  }
  return out as ResolvedParts<Parts, O>
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
