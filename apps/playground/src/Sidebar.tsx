import { storyHash } from './router'
import { storyGroups, type Story } from './stories'

const LINK =
  'block rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200 aria-[current=page]:bg-neutral-900 aria-[current=page]:text-white'

/** The story list, grouped. `onPick` fires on every click, including on the current story. */
export function Sidebar({ current, onPick }: { current: Story; onPick: (story: Story) => void }) {
  return (
    <nav aria-label="Stories" className="shrink-0 border-b border-neutral-300 p-4 md:w-56 md:border-b-0 md:border-r">
      {storyGroups.map((group) => (
        <section key={group.name} className="mb-3">
          <h2 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{group.name}</h2>
          <ul className="m-0 list-none p-0">
            {group.stories.map((s) => (
              <li key={s.id}>
                <a
                  href={storyHash(s)}
                  data-testid={`story-${s.id}`}
                  aria-current={s === current ? 'page' : undefined}
                  className={LINK}
                  onClick={() => onPick(s)}
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}
