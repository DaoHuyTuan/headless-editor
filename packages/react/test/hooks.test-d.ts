import { describe, expectTypeOf, it } from 'vitest'
import { definePlugin, Editor, type AnyPlugin } from '@hte/core'
import { paragraph } from '@hte/paragraph'
import { bold } from '@hte/bold'
import { useEditorState, usePluginState } from '../src/index'

const counter = definePlugin({
  name: 'counter',
  state: {
    init: () => ({ count: 0 }),
    apply: (_tr, prev: { count: number }) => prev,
  },
})
const other = definePlugin({
  name: 'other',
  state: { init: () => 'x', apply: (_tr, prev: string) => prev },
})
const stateless = definePlugin({ name: 'stateless' })

declare const editor: Editor<readonly [typeof paragraph, typeof bold, typeof counter, typeof stateless]>
declare const anyEditor: Editor<readonly AnyPlugin[]>
declare const defaultEditor: Editor

describe('useEditorState types', () => {
  it('infers the selector editor from the editor argument', () => {
    useEditorState(editor, (_s, e) => {
      expectTypeOf(e).toEqualTypeOf(editor)
      return e.commands.toggleBold
    })
  })

  it('an annotated selector return keeps the editor type (no explicit T needed)', () => {
    const v = useEditorState(editor, (_s, e): boolean => {
      expectTypeOf(e).toEqualTypeOf(editor)
      return e.isActive('bold')
    })
    expectTypeOf(v).toEqualTypeOf<boolean>()
  })

  it('an explicit T with the editor type keeps it; an explicit T alone falls back to a plain Editor', () => {
    useEditorState<boolean, typeof editor>(editor, (_s, e) => {
      expectTypeOf(e).toEqualTypeOf(editor)
      return true
    })
    // TypeScript has no partial inference: with only `T` given, `E` takes its default.
    useEditorState<boolean>(editor, (_s, e) => {
      expectTypeOf(e).toEqualTypeOf<Editor<readonly AnyPlugin[]>>()
      return true
    })
  })
})

describe('usePluginState types', () => {
  it('returns the plugin state type, undefined for a stateless plugin', () => {
    expectTypeOf(usePluginState(editor, counter)).toEqualTypeOf<{ count: number }>()
    expectTypeOf(usePluginState(editor, stateless)).toEqualTypeOf<undefined>()
  })

  it('rejects a plugin the typed editor does not have', () => {
    // @ts-expect-error `other` is not one of the editor's plugins
    usePluginState(editor, other)
  })

  it('accepts any plugin for an editor whose plugin list is not known', () => {
    expectTypeOf(usePluginState(anyEditor, other)).toEqualTypeOf<string>()
    expectTypeOf(usePluginState(defaultEditor, other)).toEqualTypeOf<string>()
  })
})
