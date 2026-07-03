# press

Self-hosted, CLI-published, identity-gated HTML report publishing.

## Development

### Shared dev session (human + agent)

Run:

```sh
nub run dev:share
```

This boots the normal localnet dev server, then prints the base URL, seeded
users with their committed fixture passwords, seeded collections, and example
page URLs. It also mints a fresh owner API token for agents and writes only the
local file path to stdout.

The agent environment lands at `.dev/agent.env` with `PRESS_TOKEN` and
`PRESS_URL`. The token is not printed.

With `dev:share` still running, verify the shared session from another shell:

```sh
nub run dev:share:smoke
```

The smoke signs in through the credential auth endpoint, publishes one page
through the real `press` CLI using `.dev/agent.env`, and asserts the page is
served.
