import { stories, type Story } from './stories'

const groupSlug = (group: string) => group.toLowerCase().replace(/\s+/g, '-')

/** The URL hash for a story: `#/<group-slug>/<slug>`. */
export function storyHash(story: Story): string {
  return `#/${groupSlug(story.group)}/${story.slug}`
}

/** The story a hash points at; unknown or empty hashes fall back to the first story. */
export function storyFromHash(hash: string): Story {
  const path = hash.replace(/^#/, '').replace(/^\/+|\/+$/g, '').toLowerCase()
  return stories.find((s) => `${groupSlug(s.group)}/${s.slug}` === path) ?? stories[0]
}
