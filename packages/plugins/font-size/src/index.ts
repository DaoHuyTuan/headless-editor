/**
 * Font size mark (`@hte/font-size`). Renders `<span style="font-size: …">`; `options.HTMLAttributes` is
 * merged into it (the data-driven `style` font-size wins). No React view, so no `data-*`
 * attributes and no parts.
 */
import { z } from 'zod'
import { definePlugin, mergeAttrs, type Command, type HTMLAttributes } from '@hte/core'

const SIZE_RE = /^\d+(\.\d+)?(px|pt|em|rem|%)$/

export interface FontSizeOptions {
  /** Extra attributes merged into the `<span>`. */
  HTMLAttributes: HTMLAttributes
}

export const fontSize = definePlugin({
  name: 'fontSize',
  options: { HTMLAttributes: {} } as FontSizeOptions,
  data: z.object({ size: z.string().regex(SIZE_RE) }),
  mark: {
    render: (d, { options }) => ({
      tag: 'span',
      attrs: mergeAttrs(options.HTMLAttributes, { style: `font-size: ${d.size};` }),
    }),
  },
  parseHTML: [{ style: 'font-size', getData: (_, v) => (v && SIZE_RE.test(v) ? { size: v } : false) }],
  // Without a selection a mark edit has no target: the command reports that it did nothing.
  commands: () => ({
    setFontSize: (size: string): Command => ({ tr }) =>
      tr.selection !== null && tr.addMark({ type: 'fontSize', data: { size } }).rejected === null,
    unsetFontSize: (): Command => ({ tr }) => tr.selection !== null && tr.removeMark('fontSize').rejected === null,
  }),
})
