import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import type {
  AnyPlugin,
  Command,
  CommandsOf,
  CommandsOfPlugin,
  DataOf,
  OptionsOf,
  Plugin,
} from '../../src/plugin/types'
import type { Data } from '../../src/model/types'

describe('plugin types', () => {
  it('flows data types into mark.render', () => {
    const fs = definePlugin({
      name: 'fontSize',
      mark: {
        render: (d) => {
          expectTypeOf(d).toEqualTypeOf<{ size: string }>()
          return { tag: 'span', style: { fontSize: d.size } }
        },
      },
      data: z.object({ size: z.string().default('16px') }),
    })
    expectTypeOf(fs).toMatchTypeOf<Plugin<any>>()
    expectTypeOf(fs).toMatchTypeOf<AnyPlugin>()
    expectTypeOf(fs.name).toEqualTypeOf<'fontSize'>()
    expectTypeOf<DataOf<typeof fs>>().toEqualTypeOf<{ size: string }>()
  })

  it('defaults data to Data without a schema', () => {
    const b = definePlugin({ name: 'bold', mark: { render: (d) => (expectTypeOf(d).toEqualTypeOf<Data>(), { tag: 'strong' }) } })
    expectTypeOf<DataOf<typeof b>>().toEqualTypeOf<Data>()
  })

  it('flows options into callbacks and configure', () => {
    const m = definePlugin({
      name: 'm',
      options: { n: 1, s: 'x' },
      commands: (ctx) => {
        expectTypeOf(ctx.options).toEqualTypeOf<{ n: number; s: string }>()
        return { setN: (n: number): Command => () => n > ctx.options.n }
      },
      renderHTML: (_node, ctx) => {
        expectTypeOf(ctx.options.s).toBeString()
        return ['p', 0]
      },
    })
    expectTypeOf<OptionsOf<typeof m>>().toEqualTypeOf<{ n: number; s: string }>()
    expectTypeOf(m.configure).parameter(0).toEqualTypeOf<Partial<{ n: number; s: string }>>()
    // @ts-expect-error wrong option type
    m.configure({ n: 'nope' })
    expectTypeOf<CommandsOfPlugin<typeof m>>().toEqualTypeOf<{ setN: (n: number) => Command }>()
    expectTypeOf<CommandsOfPlugin<(typeof m)['spec']>>().toEqualTypeOf<{ setN: (n: number) => Command }>()
  })

  it('flows plugin state into getState', () => {
    definePlugin({
      name: 'counter',
      state: { init: () => 0, apply: (_tr, prev) => prev + 1 },
      keymap: (ctx) => {
        expectTypeOf(ctx.getState()).toEqualTypeOf<number>()
        return {}
      },
    })
  })

  it('combines commands across plugins', () => {
    const a = definePlugin({ name: 'a', commands: () => ({ foo: (): Command => () => true }) })
    const b = definePlugin({ name: 'b', commands: () => ({ bar: (x: string): Command => () => x === '' }) })
    const c = definePlugin({ name: 'c' })
    expectTypeOf<CommandsOfPlugin<typeof c>>().toEqualTypeOf<{}>()
    type All = CommandsOf<[typeof a, typeof b, typeof c]>
    expectTypeOf<All['foo']>().toEqualTypeOf<() => Command>()
    expectTypeOf<All['bar']>().toEqualTypeOf<(x: string) => Command>()
  })

  it('extend keeps the plugin typed', () => {
    const m = definePlugin({ name: 'm', options: { n: 1 } })
    const e = m.extend({ priority: 7 })
    expectTypeOf(e.name).toEqualTypeOf<'m'>()
    expectTypeOf<OptionsOf<typeof e>>().toEqualTypeOf<{ n: number }>()
    expectTypeOf(e).toMatchTypeOf<AnyPlugin>()
  })
})
