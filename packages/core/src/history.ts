import { definePlugin } from './plugin/define'

/**
 * Built-in undo/redo plugin, prepended by the Editor unless `history: false`.
 * State, commands and keymap arrive in Task 12.
 */
export const historyPlugin = definePlugin({
  name: 'history',
  priority: 0,
})
