import { definePlugin } from './plugin/define'

/**
 * Built-in core editing plugin, always prepended by the Editor. Priority 0 so its default
 * intent handling runs after every other plugin. Commands and intents arrive in Task 9.
 */
export const corePlugin = definePlugin({
  name: 'core',
  priority: 0,
})
