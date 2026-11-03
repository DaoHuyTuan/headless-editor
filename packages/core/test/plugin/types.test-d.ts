import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { definePlugin } from '../../src/plugin/define'
import type {
  AnyPlugin,
  Command,
  CommandsOf,
  CommandsOfPlugin,
  DataOf,
  NodeViewPropsOf,
  OptionsOf,
  Plugin,
  StateOf,
  StorageOfPlugin,
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

  it("types the plugin's own commands on ctx.commands", () => {
    definePlugin({
      name: 'own',
      options: { n: 1 },
      commands: () => ({ mine: (): Command => () => true, withArg: (x: string): Command => () => x === '' }),
      keymap: (ctx) => {
        expectTypeOf(ctx.commands.mine).toEqualTypeOf<() => boolean>()
        expectTypeOf(ctx.commands.withArg).toEqualTypeOf<(x: string) => boolean>()
        // @ts-expect-error not a command of this plugin
        ctx.commands.nope()
        return {}
      },
      onBeforeInput: (_intent, ctx) => {
        expectTypeOf(ctx.commands.mine).toEqualTypeOf<() => boolean>()
        return false
      },
    })
  })

  describe('typed own storage and state', () => {
    interface Upload {
      upload(files: File[]): void
      isPending(id: string): boolean
    }
    const image = definePlugin({
      name: 'image',
      options: { max: 1 },
      data: z.object({ src: z.string() }),
      state: { init: () => ({ pending: new Set<string>() }), apply: (_tr, prev: { pending: Set<string> }) => prev },
      commands: () => ({ insertImage: (src: string): Command => () => src !== '' }),
      storage: (ctx): Upload => {
        expectTypeOf(ctx.commands.insertImage).toEqualTypeOf<(src: string) => boolean>()
        return { upload: () => {}, isPending: () => false }
      },
      onBeforeInput: (_intent, ctx) => {
        expectTypeOf(ctx.storage.upload).toEqualTypeOf<(files: File[]) => void>()
        expectTypeOf(ctx.getState().pending).toEqualTypeOf<Set<string>>()
        ctx.storage.upload([])
        return false
      },
      keymap: (ctx) => {
        expectTypeOf(ctx.storage).toEqualTypeOf<Upload>()
        return {}
      },
      destroy: (ctx) => {
        expectTypeOf(ctx.storage).toEqualTypeOf<Upload>()
        expectTypeOf(ctx.commands.insertImage).toEqualTypeOf<(src: string) => boolean>()
      },
    })

    it('types ctx.storage in hooks', () => {
      expectTypeOf<StorageOfPlugin<typeof image>>().toEqualTypeOf<Upload>()
    })

    it('infers storage when hooks come before the storage factory', () => {
      const p = definePlugin({
        name: 'early',
        keymap: (ctx) => {
          expectTypeOf(ctx.storage).toEqualTypeOf<{ n: number }>()
          return {}
        },
        storage: () => ({ n: 1 }),
      })
      expectTypeOf<StorageOfPlugin<typeof p>>().toEqualTypeOf<{ n: number }>()
      // A factory taking ctx, declared before the hooks that read ctx.storage.
      const q = definePlugin({
        name: 'late',
        storage: (ctx) => ({ n: ctx.name.length }),
        keymap: (ctx) => {
          expectTypeOf(ctx.storage).toEqualTypeOf<{ n: number }>()
          return {}
        },
      })
      expectTypeOf<StorageOfPlugin<typeof q>>().toEqualTypeOf<{ n: number }>()
    })

    it('derives node view props from a plugin', () => {
      type Props = NodeViewPropsOf<typeof image>
      expectTypeOf<Props['storage']['isPending']>().toEqualTypeOf<(id: string) => boolean>()
      expectTypeOf<Props['state']>().toEqualTypeOf<{ pending: Set<string> }>()
      expectTypeOf<Props['options']>().toEqualTypeOf<{ max: number }>()
      expectTypeOf<Props['node']['data']['src']>().toEqualTypeOf<string>()
      expectTypeOf<Props['updateData']>().parameter(0).toEqualTypeOf<Partial<{ src: string }>>()
    })

    it('extend(parent) receives the parent spec and keeps the generics', () => {
      const e = image.extend((parent) => {
        expectTypeOf(parent).toEqualTypeOf<(typeof image)['spec']>()
        return {
          keymap: (ctx) => {
            expectTypeOf(ctx.storage).toEqualTypeOf<Upload>()
            return { ...parent.keymap?.(ctx), 'Mod-u': () => ctx.commands.insertImage('x') }
          },
          renderHTML: (n, c) => {
            expectTypeOf(c.options).toEqualTypeOf<{ max: number }>()
            return ['figure', {}, parent.renderHTML!(n, c)]
          },
        }
      })
      expectTypeOf(e.name).toEqualTypeOf<'image'>()
      expectTypeOf<OptionsOf<typeof e>>().toEqualTypeOf<{ max: number }>()
      expectTypeOf<DataOf<typeof e>>().toEqualTypeOf<{ src: string }>()
      expectTypeOf<StateOf<typeof e>>().toEqualTypeOf<{ pending: Set<string> }>()
      expectTypeOf<StorageOfPlugin<typeof e>>().toEqualTypeOf<Upload>()
      expectTypeOf<CommandsOfPlugin<typeof e>>().toEqualTypeOf<{ insertImage: (src: string) => Command }>()
      expectTypeOf(e).toMatchTypeOf<AnyPlugin>()
      // Chained: the second extend's parent is the first one's spec.
      const twice = e.extend((parent) => {
        expectTypeOf(parent).toEqualTypeOf<(typeof e)['spec']>()
        return { priority: 5 }
      })
      expectTypeOf<StorageOfPlugin<typeof twice>>().toEqualTypeOf<Upload>()
      expectTypeOf(twice.name).toEqualTypeOf<'image'>()
    })

    it('extend infers C, S and T from the merged spec when an override replaces them', () => {
      const e = image.extend(() => ({
        commands: () => ({ other: (n: number): Command => () => n > 0 }),
        state: { init: () => 1, apply: (_tr: unknown, prev: number) => prev },
        storage: () => ({ replaced: true }),
      }))
      expectTypeOf<CommandsOfPlugin<typeof e>>().toEqualTypeOf<{ other: (n: number) => Command }>()
      expectTypeOf<StateOf<typeof e>>().toEqualTypeOf<number>()
      expectTypeOf<StorageOfPlugin<typeof e>>().toEqualTypeOf<{ replaced: boolean }>()
      const o = image.extend({ storage: () => ({ obj: 1 }) })
      expectTypeOf<StorageOfPlugin<typeof o>>().toEqualTypeOf<{ obj: number }>()
    })

    it('the object form of extend still compiles with contextual types', () => {
      const e = image.extend({
        priority: 3,
        onBeforeInput: (_i, ctx) => {
          expectTypeOf(ctx.storage).toEqualTypeOf<Upload>()
          return false
        },
      })
      expectTypeOf<StorageOfPlugin<typeof e>>().toEqualTypeOf<Upload>()
    })
  })
})
