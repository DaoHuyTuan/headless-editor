import { z } from 'zod'
import { definePlugin, type Command } from '@hte/core'

const SIZE_RE = /^\d+(\.\d+)?(px|pt|em|rem|%)$/

export const fontSize = definePlugin({
  name: 'fontSize',
  data: z.object({ size: z.string().regex(SIZE_RE) }),
  mark: { render: (d) => ({ tag: 'span', style: { fontSize: d.size } }) },
  parseHTML: [{ style: 'font-size', getData: (_, v) => (v && SIZE_RE.test(v) ? { size: v } : false) }],
  commands: () => ({
    setFontSize: (size: string): Command => ({ tr }) =>
      tr.addMark({ type: 'fontSize', data: { size } }).rejected === null,
    unsetFontSize: (): Command => ({ tr }) => tr.removeMark('fontSize').rejected === null,
  }),
})
