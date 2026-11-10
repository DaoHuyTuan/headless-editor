import { describe, expectTypeOf, it } from 'vitest'
import { Editor } from '@penline/core'
import { paragraph } from '@penline/paragraph'
import { bold } from '../src/index'

describe('bold types', () => {
  it('types toggleBold when bold is in the plugin list', () => {
    const ed = new Editor({ plugins: [paragraph, bold] })
    expectTypeOf(ed.commands.toggleBold).toBeFunction()
    expectTypeOf(ed.commands.toggleBold).returns.toBeBoolean()
    expectTypeOf(ed.commands.setBold).toBeFunction()
    expectTypeOf(ed.commands.unsetBold).toBeFunction()
  })

  it("gives bold's own hooks its typed commands on ctx", () => {
    type Ctx = Parameters<NonNullable<(typeof bold)['spec']['keymap']>>[0]
    expectTypeOf<Ctx['commands']['toggleBold']>().toEqualTypeOf<() => boolean>()
    expectTypeOf<Ctx['commands']['setBold']>().toEqualTypeOf<() => boolean>()
  })
})
