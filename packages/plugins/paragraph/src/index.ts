import { definePlugin } from '@hte/core'

export const paragraph = definePlugin({
  name: 'paragraph',
  node: { kind: 'block', default: true, content: 'inline' },
  parseHTML: [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})
