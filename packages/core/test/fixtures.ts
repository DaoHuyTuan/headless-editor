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

// Nested-content fixtures (no views): containers, lists, tables and a text-only code block.
export const testQuote = definePlugin({ name: 'quote', node: { kind: 'block', content: 'block+' } })
export const testBulletList = definePlugin({ name: 'bulletList', node: { kind: 'block', content: 'listItem+' } })
export const testListItem = definePlugin({
  name: 'listItem',
  node: { kind: 'block', content: 'paragraph block*', group: [] },
})
export const testTable = definePlugin({ name: 'table', node: { kind: 'block', content: 'tableRow+' } })
export const testTableRow = definePlugin({ name: 'tableRow', node: { kind: 'block', content: 'tableCell+', group: [] } })
export const testTableCell = definePlugin({
  name: 'tableCell',
  node: { kind: 'block', content: 'block+', group: [], isolating: true },
})
export const testCode = definePlugin({ name: 'code', node: { kind: 'block', content: 'text' } })

export const nested = [
  testParagraph,
  testBold,
  testQuote,
  testBulletList,
  testListItem,
  testTable,
  testTableRow,
  testTableCell,
  testCode,
]
