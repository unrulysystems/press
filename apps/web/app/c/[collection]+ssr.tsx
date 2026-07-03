import { useLoader } from 'one'

import { loadMagazineCollection } from '@press/web/publish/indexes'
import { Masthead } from '@press/web/ui/Masthead'

import type { MagazineCollection, MagazineEntry } from '@press/web/publish/indexes'
import type { LoaderProps } from 'one'

type CollectionParams = {
  readonly collection: string
}

export async function loader({
  params,
  request,
}: LoaderProps<CollectionParams>): Promise<MagazineCollection> {
  const data = await loadMagazineCollection(params.collection, request)
  if (!data) {
    throw new Response('Not Found', { status: 404 })
  }
  return data
}

function CollectionEntry({ entry }: { readonly entry: MagazineEntry }) {
  return (
    <article className="press-entry" data-feed-entry data-spacing-sample>
      <a className="press-entry-link" href={entry.href}>
        <span className="press-entry-kicker">
          {entry.collectionTitle}
          {entry.locked ? (
            <span className="press-lock" aria-label="Password protected" title="Password protected">
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
  )
}

export function CollectionPage() {
  const data = useLoader(loader)

  return (
    <main className="press-page" data-design-scope>
      <div className="press-shell press-collection-shell">
        <Masthead viewer={data.viewer} loginNext={`/c/${data.collection.slug}`} />

        <section
          className="press-collection-head"
          data-spacing-sample
          aria-labelledby="collection-title"
        >
          <a className="press-backlink" href="/">
            Index
          </a>
          <p className="press-kicker">Collection</p>
          <h1 id="collection-title">{data.collection.title}</h1>
          <p>
            {data.entries.length} readable {data.entries.length === 1 ? 'report' : 'reports'},
            newest first.
          </p>
        </section>

        <section className="press-feed" aria-label={`${data.collection.title} reports`}>
          {data.entries.map((entry) => (
            <CollectionEntry entry={entry} key={`${entry.collectionSlug}/${entry.fileSlug}`} />
          ))}
        </section>
      </div>
    </main>
  )
}
