import { definePlugin } from '../src/plugin/define'

export const testParagraph = definePlugin({
  name: 'paragraph',
  node: { kind: 'block', default: true, content: 'inline' },
  parseHTML: [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})

export const testBold = definePlugin({
  name: 'bold',
  mark: { render: () => ({ tag: 'strong' }) },
  parseHTML: [{ tag: 'strong' }, { tag: 'b' }],
})
