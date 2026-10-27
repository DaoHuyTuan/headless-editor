import { describe, expectTypeOf, it } from 'vitest'
import { Editor } from '@hte/core'
import { paragraph } from '@hte/paragraph'
import { bold } from '../src/index'

describe('bold types', () => {
  it('types toggleBold when bold is in the plugin list', () => {
    const ed = new Editor({ plugins: [paragraph, bold] })
    expectTypeOf(ed.commands.toggleBold).toBeFunction()
    expectTypeOf(ed.commands.toggleBold).returns.toBeBoolean()
    expectTypeOf(ed.commands.setBold).toBeFunction()
    expectTypeOf(ed.commands.unsetBold).toBeFunction()
  })
})
