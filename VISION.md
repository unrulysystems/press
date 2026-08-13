# press — Vision

## What press is

press is a self-hosted publishing surface for self-contained HTML pages. Humans and
agents publish reports, recaps, and documents through a CLI; readers get a modern,
magazine-grade news site with per-page access control. One binary of taste: publish
in seconds, read something that looks designed, never leak anything.

## Why it exists

Teams generate HTML artifacts constantly — weekly recaps, quarterly reviews, data
reports, agent-produced documents. Today those artifacts rot in git repos, Slack
uploads, and local folders. Existing options fail on at least one axis:

- Static-site pipelines (git-push publishing) are ergonomically wrong for one-off
  documents and hostile to agent publishers.
- SaaS hosting (Notion, Google Sites, Cloudflare Pages) puts third parties in the
  data path — unacceptable for sovereignty-sensitive orgs.
- Bare object storage has no identity, no access control, no front door.

press is the missing shape: **CLI-published, identity-gated, self-hosted, and
beautiful by default.**

## Product / instance split

press is a generic product owned by **unrulysystems**. Each deployment is an
instance configured with its own identity provider client, allowed email domains,
hostname, and storage. Nothing org-specific is hardcoded.

## Who it serves

- **Publishers** — humans running `press publish`, and agents doing the same
  unattended with a human-minted credential.
- **Readers** — org members browsing the news feed; external individuals granted
  per-page access; the public, for pages deliberately made public.
- **Operators** — whoever runs an instance: single container + Postgres, secrets
  via their own store, no third-party services in the data path.

## What "winning" looks like

- Publishing a report is one command and under five seconds.
- The landing page reads like an editorial magazine — calm, typographic,
  uncrowded — not an internal tool.
- Access control is boring: default org-gated, opt-in public, password, or
  per-email private. Nobody ever publishes over someone else's work.
- Published pages are isolated: a malicious report cannot read another report or
  act as its viewer.
- An operator can stand up a new instance from the public image and a dozen env
  vars.

## Non-vision

press is not a CMS, not a wiki, not a comment platform, not a general file host,
and not a native app. It publishes finished, self-contained HTML documents and
makes them findable and safe to share. Editing happens wherever the documents are
made.
