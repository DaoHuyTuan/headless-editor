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
  commands: () => ({
    setFontSize: (size: string): Command => ({ tr }) =>
      tr.addMark({ type: 'fontSize', data: { size } }).rejected === null,
    unsetFontSize: (): Command => ({ tr }) => tr.removeMark('fontSize').rejected === null,
  }),
})
