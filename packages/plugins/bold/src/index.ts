/**
 * Bold mark (`@penline/bold`). Renders `<strong>`; `options.HTMLAttributes` is merged into it.
 * No React view, so no `data-*` attributes and no parts.
 */
import { definePlugin, mergeAttrs, type Command, type HTMLAttributes } from '@penline/core'

export interface BoldOptions {
  /** Extra attributes merged into the `<strong>`. */
  HTMLAttributes: HTMLAttributes
}

export const bold = definePlugin({
  name: 'bold',
  options: { HTMLAttributes: {} } as BoldOptions,
  mark: { render: (_, { options }) => ({ tag: 'strong', attrs: mergeAttrs(options.HTMLAttributes, {}) }) },
  parseHTML: [
    { tag: 'strong' },
    { tag: 'b', getData: (el) => (el.style.fontWeight === 'normal' ? false : {}) },
    { style: 'font-weight', getData: (_, v) => (/^(bold|bolder|[6-9]00)$/.test(v ?? '') ? {} : false) },
  ],
  // Without a selection a mark edit has no target: the command reports that it did nothing.
  commands: () => ({
    toggleBold: (): Command => ({ tr }) => tr.selection !== null && tr.toggleMark('bold').rejected === null,
    setBold: (): Command => ({ tr }) => tr.selection !== null && tr.addMark({ type: 'bold', data: {} }).rejected === null,
    unsetBold: (): Command => ({ tr }) => tr.selection !== null && tr.removeMark('bold').rejected === null,
  }),
  keymap: (ctx) => ({ 'Mod-b': () => ctx.commands.toggleBold() }),
  onBeforeInput: (intent, ctx) => (intent.inputType === 'formatBold' ? ctx.commands.toggleBold() : false),
})
