import type { Doc } from '@hte/core'
import { stories, type StoryId } from './stories'

export interface Scenario {
  label: string
  content: Doc | string
  /** Which React view renders images: the default `ImageView`, or a custom view built from the image hooks only. */
  imageView?: 'default' | 'custom'
}

export type ScenarioName = StoryId

/** The scenarios by name, derived from `stories` (removed once the sidebar replaces the select). */
export const scenarios = Object.fromEntries(
  stories.map((s) => [s.id, { label: s.title, content: s.content, imageView: s.imageView }]),
) as Record<ScenarioName, Scenario>
