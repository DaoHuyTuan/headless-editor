import type { Doc } from '@hte/core'

export interface Scenario {
  label: string
  content: Doc | string
}

export const scenarios = {
  empty: { label: 'Empty', content: { type: 'doc', children: [] } },
  paragraphs: {
    label: 'Paragraphs',
    content: '<p>The first paragraph.</p><p>The second paragraph.</p><p>The third paragraph.</p>',
  },
  bold: { label: 'Bold', content: '<p>Some <strong>bold</strong> text and some <b>more bold</b>.</p>' },
  pastedHtml: {
    label: 'Pasted HTML',
    content:
      '<meta charset="utf-8"><div><span style="font-weight:700">Bold via style</span> then plain</div>' +
      '<p>Para with <b style="font-weight:normal">not bold</b> and <em>unknown em</em></p>loose text',
  },
} satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof scenarios
