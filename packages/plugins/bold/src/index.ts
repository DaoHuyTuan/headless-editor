import { definePlugin, type Command, type Editor } from '@hte/core'

// The plugin's own commands are not in `ctx.editor`'s type (it is derived from the plugin list).
const toggleBold = (editor: Editor): boolean => (editor.commands as unknown as { toggleBold(): boolean }).toggleBold()

export const bold = definePlugin({
  name: 'bold',
  mark: { render: () => ({ tag: 'strong' }) },
  parseHTML: [
    { tag: 'strong' },
    { tag: 'b', getData: (el) => (el.style.fontWeight === 'normal' ? false : {}) },
    { style: 'font-weight', getData: (_, v) => (/^(bold|bolder|[6-9]00)$/.test(v ?? '') ? {} : false) },
  ],
  commands: () => ({
    toggleBold: (): Command => ({ tr }) => tr.toggleMark('bold').rejected === null,
    setBold: (): Command => ({ tr }) => tr.addMark({ type: 'bold', data: {} }).rejected === null,
    unsetBold: (): Command => ({ tr }) => tr.removeMark('bold').rejected === null,
  }),
  keymap: (ctx) => ({ 'Mod-b': () => toggleBold(ctx.editor) }),
  onBeforeInput: (intent, ctx) => (intent.inputType === 'formatBold' ? toggleBold(ctx.editor) : false),
})
