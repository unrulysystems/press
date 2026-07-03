import { useLoader } from 'one'

import { loadMagazineFeed } from '@press/web/publish/indexes'

import type { MagazineEntry, MagazineFeed } from '@press/web/publish/indexes'
import type { LoaderProps } from 'one'

export async function loader({ request }: LoaderProps): Promise<MagazineFeed> {
  return await loadMagazineFeed(request)
}

function EntryList({
  entries,
  emptyCopy,
}: {
  readonly entries: readonly MagazineEntry[]
  readonly emptyCopy: string
}) {
  if (entries.length === 0) {
    return <p className="press-empty">{emptyCopy}</p>
  }

  return (
    <section className="press-feed" aria-label="Latest reports">
      {entries.map((entry) => (
        <article
          className="press-entry"
          data-feed-entry
          data-spacing-sample
          key={`${entry.collectionSlug}/${entry.fileSlug}`}
        >
          <a className="press-entry-link" href={entry.href}>
            <span className="press-entry-kicker">
              {entry.collectionTitle}
              {entry.locked ? (
                <span
                  className="press-lock"
                  aria-label="Password protected"
                  title="Password protected"
                >
                  Locked
                </span>
              ) : null}
            </span>
            <h2>{entry.title}</h2>
          </a>
          <div className="press-entry-meta" aria-label={`${entry.title} metadata`}>
            <span>{entry.publisher}</span>
            <time dateTime={entry.publishedAt}>{entry.dateLabel}</time>
          </div>
        </article>
      ))}
    </section>
  )
}

export function IndexPage() {
  const data = useLoader(loader)

  return (
    <main className="press-page" data-design-scope>
      <div className="press-shell" data-feed-shell>
        <header className="press-masthead" aria-label="press masthead">
          <a className="press-wordmark" href="/">
            press
          </a>
          <nav className="press-nav" aria-label="Account">
            {data.viewer.authenticated ? (
              <span className="press-meta">{data.viewer.email}</span>
            ) : (
              <a className="press-meta press-nav-link" href="/login?next=/">
                Log in
              </a>
            )}
          </nav>
        </header>

        <section className="press-standfirst" aria-labelledby="feed-title">
          <div>
            <p className="press-kicker">Latest from readable collections</p>
            <h1 id="feed-title">Reports for close reading.</h1>
          </div>
          <p>
            Self-contained HTML publications, gathered by collection and ordered by what changed
            most recently.
          </p>
        </section>

        <EntryList entries={data.entries} emptyCopy="No readable reports are published yet." />
      </div>
    </main>
  )
}
