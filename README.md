# press

Self-hosted, CLI-published, identity-gated HTML report publishing.

## Development

### Shared dev session (human + agent)

Run:

```sh
nub run dev:share
```

This boots the normal silo/Tilt localnet dev server, then prints the base URL,
seeded users with their committed fixture passwords, seeded collections, and
example page URLs. It also mints a fresh owner API token for agents and writes
only the local file path to stdout.

The agent environment lands at `.dev/agent.env` with `PRESS_TOKEN` and
`PRESS_URL`. The token is not printed.

With `dev:share` still running, verify the shared session from another shell:

```sh
nub run dev:share:smoke
```

The smoke signs in through the credential auth endpoint, publishes one page
through the real `press` CLI using `.dev/agent.env`, and asserts the page is
served.

## Deployment (boundary — Allen)

Nothing deploys from inside a loop; the boundary list below is Allen's. Going
live on `reports.send.it` requires, in order:

1. Push the branch and confirm CI is green (check, test, e2e, build:web,
   smoke:image).
2. Create the Google OAuth client and configure the provider env.
3. Configure DNS for instance #1 at `reports.send.it`.
4. Build and mirror the image to `0xsend/press` with the repo's tag
   convention, then author the deploy manifests.
5. Provision ESO secrets (no live secret ever enters the repo).
6. Deploy.
7. Attended gates: the real macOS keychain `press login` loopback test, and
   the real-Google final-gate walkthrough (`BRIEF.md` § Oracle).

After a push, a boundary re-audit of `AUDIT.md` flips the open ledger statuses
(F-12..F-20); audit tooling owns that ledger.
