import type { Editor } from '@hte/core'
import { bold } from '@hte/bold'
import { fontSize } from '@hte/font-size'
import { image } from '@hte/image'
import { paragraph } from '@hte/paragraph'

export const plugins = [paragraph, bold, fontSize, image] as const

export type PlaygroundEditor = Editor<typeof plugins>
