---
name: press-publish
description: Compose an HTML report, publish it with the press CLI, and confirm the returned URL and its access control. Use when the user wants to share a report/page via press.
command: press
---

# press-publish

Publish an HTML report and verify it is live at the returned URL with the intended
access control. Requires a working token — run `press-setup` first if
`press doctor` is not `authenticated: yes`.

## 1. Compose the report

Write a single self-contained HTML file (inline CSS; no external assets — press
serves one file). Keep it to a temp/scratch path, e.g. `report.html`.

## 2. Choose the collection, slug, and visibility

- `--to <collection>` — required; the collection slug (e.g. `weekly`).
- `--as <slug>` — optional; the file slug. Omit to derive it from the filename.
- `--visibility <v>` — one of `public`, `default`, `password`, `private`. Default
  collection policy applies when omitted.
- `--allow <emails>` — comma-separated allowlist for `private` pages.

## 3. Publish

```
press publish report.html --to weekly --as q3-summary --visibility public
```

The command prints the page URL on stdout. When `--visibility password`, it also
prints a one-time `password:` line — capture it now; it is shown only once and is
never recoverable.

Use `--json` for a machine-readable envelope (`.data.url`, `.data.password`) if you
are parsing the result.

## 4. Read it back

Fetch the URL you got and confirm the publisher sees the page:

```
curl -sS -o /dev/null -w '%{http_code}\n' "<url>"
```

Expect `200` for a `public` page. Also confirm it is listed:

```
press list weekly
```

## 5. Confirm access control

Verify the ACL matches the chosen visibility from an unauthenticated fetch (no
token):

- `public` → `200` for anyone.
- `default` / `private` → `401` unauthenticated (only authorized identities get
  `200`); `private` additionally restricts to the `--allow` list.
- `password` → the page prompts for the one-time password.

To change a page's access later:

```
press page set weekly/q3-summary --visibility private --allow teammate@send.it
```

To remove it:

```
press unpublish weekly/q3-summary
```

## Done when

The returned URL responds `200` for the publisher, the page appears in
`press list <collection>`, and an unauthenticated fetch returns the status that
matches the chosen visibility.
