import { describe, expect, it } from 'vitest'
import { storyFromHash, storyHash } from '../src/router'
import { storyGroups, stories, type StoryId } from '../src/stories'

const story = (id: StoryId) => {
  const s = stories.find((x) => x.id === id)
  if (!s) throw new Error(`no story ${id}`)
  return s
}

describe('story router', () => {
  it('builds hashes from group and slug', () => {
    expect(storyHash(story('bold'))).toBe('#/bold/basic')
    expect(storyHash(story('customImage'))).toBe('#/image/custom-view')
  })

  it('round-trips every story', () => {
    for (const s of stories) expect(storyFromHash(storyHash(s)).id).toBe(s.id)
  })

  it('is case- and trailing-slash-insensitive', () => {
    expect(storyFromHash('#/Bold/Basic/').id).toBe('bold')
  })

  it('falls back to the first story', () => {
    expect(storyFromHash('').id).toBe('empty')
    expect(storyFromHash('#/').id).toBe('empty')
    expect(storyFromHash('#/nope/missing').id).toBe('empty')
  })

  it('has unique ids and unique (group, slug) pairs', () => {
    expect(new Set(stories.map((s) => s.id)).size).toBe(stories.length)
    expect(new Set(stories.map((s) => `${s.group}/${s.slug}`)).size).toBe(stories.length)
  })

  it('lists the groups in sidebar order', () => {
    expect(storyGroups.map((g) => g.name)).toEqual(['Basics', 'Bold', 'Font size', 'Image', 'Mention', 'Code block'])
  })
})
