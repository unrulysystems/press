---
name: press-setup
description: Acquire and verify a press auth token before publishing. Use when press doctor reports not authenticated, or before the first press-publish in a session.
command: press
---

# press-setup

Get a working press auth token and confirm it, so `press-publish` can run without
interruption. There are two paths — pick by whether a human is present.

## 1. Check current state first

```
press doctor
```

If it reports `authenticated: yes`, setup is done — go to `press-publish`. Add
`--json` and read `.data.authenticated` if you need to branch programmatically.

## 2a. Agent path (non-interactive)

Use this when running headless. You need a host and a bearer token in the
environment — never on the command line.

- **Localnet testing.** Mint a seeded owner token:

  ```
  nub run dev:share
  ```

  This writes `.dev/agent.env` with `PRESS_TOKEN` and `PRESS_URL`. Load it and map
  the URL to the variable the CLI reads:

  ```
  set -a; . .dev/agent.env; set +a
  export PRESS_HOST="$PRESS_URL"
  ```

- **A provided token.** If an operator gave you a token and host, export them:

  ```
  export PRESS_HOST="https://<press-host>"
  export PRESS_TOKEN="<token>"
  ```

  Keep the token out of shell history and logs (prefer a secret manager piped into
  the environment). Never pass it as a `--token` argument — the CLI does not accept
  one, by design.

## 2b. Interactive path (human present)

```
press login
```

This opens a browser for Google sign-in and stores the token in the OS keychain
for the current host. Use `press login --no-open` to print the URL instead of
opening a browser.

## 3. Verify

```
press whoami
```

`press whoami` is the hard gate: it exits non-zero when unauthenticated. A printed
identity (your email) means setup succeeded. `press doctor` gives the same result
with more context (host, token source) if you need to debug a rejected token.

## Done when

`press whoami` prints your identity (exit 0). Then load `press-publish`.
