import { useSyncExternalStore } from 'react'
import { storyFromHash } from './router'
import type { Story } from './stories'

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** The story for `location.hash`, updated on `hashchange`. */
export function useStory(): Story {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return storyFromHash(hash)
}
