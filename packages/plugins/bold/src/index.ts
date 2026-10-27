import { definePlugin, type Command } from '@hte/core'

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
  keymap: (ctx) => ({ 'Mod-b': () => ctx.commands.toggleBold() }),
  onBeforeInput: (intent, ctx) => (intent.inputType === 'formatBold' ? ctx.commands.toggleBold() : false),
})
