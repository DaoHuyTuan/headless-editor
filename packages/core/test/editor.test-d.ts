import { describe, expectTypeOf, it } from 'vitest'
import { definePlugin } from '../src/plugin/define'
import type {
  AnyPlugin,
  Command,
  CommandsOf,
  CommandsOfPlugin,
  OptionsOf,
  StateOf,
  StorageOf,
  StorageOfPlugin,
} from '../src/plugin/types'
import type { Doc } from '../src/model/types'
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

  it('state.doc is deeply readonly; getJSON() returns a mutable Doc', () => {
    const ed = createTestEditor({ plugins: [testParagraph] })
    const block = ed.state.doc.children[0]!
    // @ts-expect-error readonly children
    ed.state.doc.children.push(block)
    // @ts-expect-error readonly data
    block.data.x = 1
    // @ts-expect-error readonly nested children
    block.children!.pop()
    expectTypeOf(ed.getJSON()).toEqualTypeOf<Doc>()
    ed.getJSON().children[0]!.data.x = 1
  })

  it('a typed editor is usable where Editor is expected', () => {
    const ed = createTestEditor({ plugins: [testParagraph, counter] })
    expectTypeOf(ed).toMatchTypeOf<Editor>()
  })

  it('types storage per plugin', () => {
    const stored = definePlugin({
      name: 'counter',
      state: { init: () => 0, apply: (_tr, n: number) => n + 1 },
      options: { step: 1 },
      commands: () => ({ bump: (): Command => () => true }),
      storage: (ctx) => ({
        count: () => ctx.getState(),
        step: () => ctx.options.step,
        bump: () => ctx.commands.bump(),
      }),
      destroy: (ctx) => {
        expectTypeOf(ctx.getState()).toEqualTypeOf<number>()
      },
    })
    type Storage = { count: () => number; step: () => number; bump: () => boolean }
    expectTypeOf<StorageOfPlugin<typeof stored>>().toEqualTypeOf<Storage>()
    expectTypeOf<StateOf<typeof stored>>().toEqualTypeOf<number>()
    expectTypeOf<OptionsOf<typeof stored>>().toEqualTypeOf<{ step: number }>()
    expectTypeOf<CommandsOfPlugin<typeof stored>>().toEqualTypeOf<{ bump: () => Command }>()

    const ed = createTestEditor({ plugins: [testParagraph, stored] })
    expectTypeOf(ed.storage.counter.count).toEqualTypeOf<() => number>()
    expectTypeOf(ed.storage.counter).toEqualTypeOf<Storage>()
    // @ts-expect-error unknown storage
    ed.storage.nope
    // @ts-expect-error paragraph has no storage
    ed.storage.paragraph
    expectTypeOf(ed.commands.bump).toEqualTypeOf<() => boolean>()

    const direct = new Editor({ plugins: [testParagraph, stored] })
    expectTypeOf(direct.storage.counter.count).toEqualTypeOf<() => number>()
  })

  it('an any-typed plugin contributes no storage instead of collapsing to any', () => {
    expectTypeOf<StorageOf<[AnyPlugin]>>().toEqualTypeOf<{}>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expectTypeOf<StorageOf<[any]>>().toEqualTypeOf<{}>()
    const stored = definePlugin({ name: 'box', storage: () => ({ n: 1 }) })
    const loose: AnyPlugin = stored
    const ed = createTestEditor({ plugins: [testParagraph, stored, loose] })
    expectTypeOf(ed.storage.box).toEqualTypeOf<{ n: number }>()
    // @ts-expect-error unknown storage
    ed.storage.nope
  })
})
