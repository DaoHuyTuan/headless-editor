import { definePlugin, mergeAttrs, type HTMLAttributes } from '@hte/core'

export interface ParagraphOptions {
  /** Extra attributes merged into the `<p>`. */
  HTMLAttributes: HTMLAttributes
}

export const paragraph = definePlugin({
  name: 'paragraph',
  options: { HTMLAttributes: {} } as ParagraphOptions,
  node: { kind: 'block', default: true, content: 'inline' },
  parseHTML: [{ tag: 'p' }],
  renderHTML: (_, { options }) => ['p', mergeAttrs(options.HTMLAttributes, {}), 0],
})
