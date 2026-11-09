import type { ComponentType } from 'react'
import { describe, expectTypeOf, it } from 'vitest'
import { resolveParts, type PartsOverride, type ViewCustomization } from '../src/index'

type Parts = { Img: ComponentType<{ className?: string }>; Handle: ComponentType<{ className?: string }> }

describe('customization types', () => {
  it('classNames keys are root plus the part keys', () => {
    type Keys = keyof NonNullable<ViewCustomization<Parts>['classNames']>
    expectTypeOf<Keys>().toEqualTypeOf<'root' | 'Img' | 'Handle'>()
  })

  it('parts accept false or a compatible component', () => {
    const Mine: ComponentType<{ className?: string }> = () => null
    const ok: PartsOverride<Parts> = { Img: Mine, Handle: false }
    expectTypeOf(ok).toMatchTypeOf<PartsOverride<Parts>>()
    // @ts-expect-error incompatible component props
    const bad: PartsOverride<Parts> = { Img: (() => null) as ComponentType<{ nope: number }> }
    void bad
  })

  it('a wrong part name is an error', () => {
    // @ts-expect-error unknown part
    const bad: ViewCustomization<Parts> = { parts: { Nope: false } }
    void bad
  })

  it('a component needing fewer props fits a part; one requiring an extra prop does not', () => {
    const Fewer: ComponentType<object> = () => null
    const ok: PartsOverride<Parts> = { Img: Fewer }
    void ok
    // @ts-expect-error `extra` is required but the view never passes it
    const bad: PartsOverride<Parts> = { Img: (() => null) as ComponentType<{ className?: string; extra: string }> }
    void bad
  })

  it('keys coming from a spread or a variable are not checked (a TypeScript limit, documented)', () => {
    const Mine: ComponentType<{ className?: string }> = () => null
    // TypeScript has no exact types: excess keys are only checked on the literal's own properties.
    const spread: PartsOverride<Parts> = { ...{ Nope: false }, Img: Mine }
    const loose = { Img: Mine, Nope: false }
    const variable: PartsOverride<Parts> = loose
    void spread
    void variable
  })
})

describe('resolveParts types', () => {
  const defaults = {} as Parts
  const { Img, Handle } = defaults
  type Resolved = { Img: Parts['Img']; Handle: Parts['Handle'] }

  it('no overrides, or overrides without `false`: no part is null', () => {
    expectTypeOf(resolveParts(defaults, undefined)).toEqualTypeOf<Resolved>()
    expectTypeOf(resolveParts(defaults, { Img: Handle })).toEqualTypeOf<Resolved>()
    expectTypeOf(resolveParts(defaults, { Img: undefined })).toEqualTypeOf<Resolved>()
  })

  it('a literal `false` makes only that part nullable', () => {
    expectTypeOf(resolveParts(defaults, { Img: false })).toEqualTypeOf<{ Img: Parts['Img'] | null; Handle: Parts['Handle'] }>()
  })

  it('overrides typed `PartsOverride` (a view prop), or an explicit Parts argument, make every part nullable', () => {
    const fromProps = undefined as PartsOverride<Parts> | undefined
    type Nullable = { Img: Parts['Img'] | null; Handle: Parts['Handle'] | null }
    expectTypeOf(resolveParts(defaults, fromProps)).toEqualTypeOf<Nullable>()
    expectTypeOf(resolveParts<Parts>(defaults, undefined)).toEqualTypeOf<Nullable>()
  })

  it('an unknown key in literal overrides is an error', () => {
    // @ts-expect-error unknown part
    resolveParts(defaults, { Nope: false })
    // @ts-expect-error unknown part next to a known one
    resolveParts(defaults, { Img, Nope: false })
  })
})
