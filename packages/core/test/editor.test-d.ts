import { describe, expectTypeOf, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type { AnyPlugin, Command, CommandsOf, CommandsOfPlugin } from '../src/plugin/types'
import { Editor } from '../src/editor'
import { createTestEditor } from '../src/testing/index'
import { testParagraph } from './fixtures'

const counter = definePlugin({
  name: 'counter',
  node: { kind: 'block' },
  state: { init: () => 0, apply: (tr, n: number) => n + (tr.docChanged ? 1 : 0) },
  options: { label: 'x' },
  commands: (ctx) => ({
    readLabel: () => () => ctx.options.label === 'y',
    take: (n: number): Command => () => n > 0,
  }),
})

describe('Editor types', () => {
  it('types commands from the plugin list', () => {
    const ed = createTestEditor({ plugins: [testParagraph, counter] })
    expectTypeOf(ed.commands.readLabel).toEqualTypeOf<() => boolean>()
    expectTypeOf(ed.commands.take).toEqualTypeOf<(n: number) => boolean>()
    expectTypeOf(ed.can().take).toEqualTypeOf<(n: number) => boolean>()
    ed.commands.readLabel()
    // @ts-expect-error unknown command
    ed.commands.nope
    // @ts-expect-error wrong argument type
    ed.commands.take('x')

    const direct = new Editor({ plugins: [testParagraph, counter] })
    expectTypeOf(direct.commands.take).toEqualTypeOf<(n: number) => boolean>()
  })

  it('an any-typed plugin contributes no commands instead of collapsing to any', () => {
    expectTypeOf<CommandsOfPlugin<AnyPlugin>>().toEqualTypeOf<{}>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expectTypeOf<CommandsOfPlugin<any>>().toEqualTypeOf<{}>()
    type C = CommandsOf<[typeof counter, AnyPlugin]>
    expectTypeOf<C['take']>().toEqualTypeOf<(n: number) => Command>()

    const loose: AnyPlugin = counter
    const ed = createTestEditor({ plugins: [testParagraph, counter, loose] })
    expectTypeOf(ed.commands.take).toEqualTypeOf<(n: number) => boolean>()
    // @ts-expect-error unknown command
    ed.commands.nope
  })

  it('a typed editor is usable where Editor is expected', () => {
    const ed = createTestEditor({ plugins: [testParagraph, counter] })
    expectTypeOf(ed).toMatchTypeOf<Editor>()
  })
})
