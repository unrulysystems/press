type FeedEntry = {
  readonly title: string
  readonly collection: string
  readonly byline: string
  readonly date: string
  readonly summary: string
}

const feedEntries: readonly FeedEntry[] = [
  {
    title: 'Local reports, published with a permanent address',
    collection: 'field-notes',
    byline: 'Allen',
    date: 'Jul 2',
    summary:
      'A quiet place for self-contained reports that need identity, links, and enough polish to be worth returning to.',
  },
  {
    title: 'The archive should feel like a reading room',
    collection: 'research',
    byline: 'press localnet',
    date: 'Jul 1',
    summary:
      'Collections will gather published pages by project, newest first, without turning the front door into an admin console.',
  },
  {
    title: 'Every page keeps its own shape',
    collection: 'design',
    byline: 'unrulysystems',
    date: 'Jun 30',
    summary:
      'Reports remain self-contained HTML documents; press supplies the gate, the index, and the editorial frame around them.',
  },
]

export function IndexPage() {
  return (
    <main className="press-page" data-design-scope>
      <div className="press-shell" data-feed-shell>
        <header className="press-masthead" aria-label="press masthead">
          <a className="press-wordmark" href="/">
            press
          </a>
          <p className="press-meta">Self-hosted report publishing</p>
        </header>

        <section className="press-standfirst" aria-labelledby="feed-title">
          <div>
            <p className="press-kicker">Latest from readable collections</p>
            <h1 id="feed-title">A publishing home for reports worth reading twice.</h1>
          </div>
          <p>
            Identity-gated HTML reports, organized like a small magazine instead of a dashboard.
          </p>
        </section>

        <section className="press-feed" aria-label="Latest reports">
          {feedEntries.map((entry) => (
            <article className="press-entry" data-feed-entry key={entry.title}>
              <div>
                <h2>{entry.title}</h2>
                <p className="press-entry-summary">{entry.summary}</p>
              </div>
              <div className="press-entry-meta">
                <span className="press-entry-collection">{entry.collection}</span>
                <span>{entry.byline}</span>
                <time>{entry.date}</time>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  )
}
