import type { ComponentType } from 'react'
import { describe, expectTypeOf, it } from 'vitest'
import type { PartsOverride, ViewCustomization } from '../src/index'

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
})
