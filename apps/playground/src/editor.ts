import type { Editor } from '@hte/core'
import { bold } from '@hte/bold'
import { paragraph } from '@hte/paragraph'

export const plugins = [paragraph, bold] as const

export type PlaygroundEditor = Editor<typeof plugins>
