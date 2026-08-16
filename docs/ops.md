# press operations runbook

## Backup and restore

`press` durability has two state stores:

- Postgres rows: source of truth for page existence, ACL, audit history, users,
  sessions, and API tokens.
- Blob storage: the HTML files under
  `$PRESS_STORAGE_DIR/<collection>/<file>`.

The executable proof for this procedure is `nub run drill:backup-restore`,
implemented in `scripts/backupRestoreDrill.ts`. The drill allocates an isolated
silo instance, migrates and seeds it, records a page row, hashes the matching
blob, probes ACL behavior, takes a backup, destroys Postgres volumes and
storage, restores into an empty target without re-seeding, boots the server,
and repeats the same checks.

### Required restore-target configuration

Before restoring, the target runtime must have the same operational config
needed for a normal boot:

- `DATABASE_URL`, or equivalent `PGHOST`, `PGPORT`, `PGDATABASE`, and `PGUSER`
  variables for the restore target.
- Postgres password material supplied by the approved secret manager for the
  operator shell or container. Do not paste secrets into commands, shell
  history, logs, or this repo.
- `PRESS_STORAGE_DIR` pointing at the blob directory to restore.
- `PRESS_BASE_URL`, `PRESS_ALLOWED_DOMAINS`, `PRESS_ADMIN_EMAILS`,
  `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `PRESS_MAX_UPLOAD_BYTES`, `PRESS_MAX_METADATA_BYTES`, and any
  deployment-specific server config required
  by `press` boot validation.
- The same `press` build or image version that produced the backup. Upgrade as
  a separate migration after the restore is verified.

### Snapshot order

Quiesce mutations, then take the Postgres dump first and copy the blob directory.

Rows are the source of truth for whether a page exists and who may read it.
A row without its blob is a serving failure; a blob without a row is only an
orphan file. Database-first remains the required order, but ordering alone is
not a consistency mechanism: publish/overwrite can replace bytes, unpublish can
remove them, and move can relocate them between the database dump and blob
copy. Put the service in maintenance/read-only mode and stop all page mutation
traffic — publish, overwrite, move, unpublish, and page/collection changes — as
part of quiescing all application mutations before starting `pg_dump`. Keep
mutations stopped until the blob copy finishes; do not begin either snapshot
while an earlier mutation is still in flight.

Use Postgres custom format (`pg_dump -Fc`) so restores use `pg_restore`, can
validate the archive, and are not tied to host `psql` client tooling. The
local drill uses the Postgres client tools inside the compose container:
`docker exec <postgres-container> pg_dump ...` and `pg_restore ...`.

### Backup

Set parameters in the operator shell. Load secret values from the approved
secret manager into the process environment without echoing them.

```sh
export BACKUP_DIR="/secure/backups/press/$(date -u +%Y%m%dT%H%M%SZ)"
export PRESS_STORAGE_DIR="/srv/press/storage"
export PRESS_COMPOSE_FILE="/srv/press/compose.yaml"
export PRESS_COMPOSE_PROJECT="press-prod"
export PGDATABASE="press"
export PGUSER="press"

mkdir -p "$BACKUP_DIR"
POSTGRES_CONTAINER="$(
  docker compose -f "$PRESS_COMPOSE_FILE" -p "$PRESS_COMPOSE_PROJECT" ps -q postgres
)"

docker exec "$POSTGRES_CONTAINER" \
  pg_dump -Fc --no-owner --no-privileges -U "$PGUSER" "$PGDATABASE" \
  > "$BACKUP_DIR/database.dump"

mkdir -p "$BACKUP_DIR/blobs"
rsync -a --delete "$PRESS_STORAGE_DIR"/ "$BACKUP_DIR/blobs"/
```

Record the application image/tag, git SHA, and non-secret config names beside
the backup:

```sh
{
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'press_image=%s\n' "$PRESS_IMAGE"
  printf 'press_git_sha=%s\n' "$PRESS_GIT_SHA"
  printf 'storage_dir=%s\n' "$PRESS_STORAGE_DIR"
} > "$BACKUP_DIR/manifest.env"
```

### Restore

Restore into an empty target database and empty storage directory. Do not run
the localnet/demo seed step; a restore must stand alone.

```sh
export BACKUP_DIR="/secure/backups/press/20260703T000000Z"
export PRESS_STORAGE_DIR="/srv/press/storage"
export PRESS_COMPOSE_FILE="/srv/press/compose.yaml"
export PRESS_COMPOSE_PROJECT="press-restore"
export PGDATABASE="press"
export PGUSER="press"

docker compose -f "$PRESS_COMPOSE_FILE" -p "$PRESS_COMPOSE_PROJECT" up -d postgres
POSTGRES_CONTAINER="$(
  docker compose -f "$PRESS_COMPOSE_FILE" -p "$PRESS_COMPOSE_PROJECT" ps -q postgres
)"

docker exec -i "$POSTGRES_CONTAINER" \
  pg_restore --clean --if-exists --no-owner --no-privileges \
    -U "$PGUSER" -d "$PGDATABASE" \
  < "$BACKUP_DIR/database.dump"

rm -rf "$PRESS_STORAGE_DIR"
mkdir -p "$PRESS_STORAGE_DIR"
rsync -a --delete "$BACKUP_DIR/blobs"/ "$PRESS_STORAGE_DIR"/
```

Start the `press` server with the restore-target config after both state stores
are in place.

### Restore verification

Run the same three checks as the drill:

1. Query a known page row and record `contentHash`.
2. Hash that page's restored blob and compare it with `contentHash`.
3. Probe ACL behavior over HTTP: a known public page returns `200`, and an
   unauthenticated non-HTML request for a default/private page returns `401`.

Example using the seeded localnet page names from the drill:

```sh
CONTENT_HASH="$(
  docker exec "$POSTGRES_CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" \
    -t -A -v ON_ERROR_STOP=1 \
    -c "select \"contentHash\" from \"page\" where \"collectionSlug\" = 'market-notes' and \"fileSlug\" = 'agent-margin-review.html' and \"archivedAt\" is null"
)"

BLOB_HASH="$(
  sha256sum "$PRESS_STORAGE_DIR/market-notes/agent-margin-review.html" | awk '{print $1}'
)"
test "$CONTENT_HASH" = "$BLOB_HASH"

test "$(
  curl -sS -o /dev/null -w '%{http_code}' \
    "$PRESS_BASE_URL/p/market-notes/agent-margin-review.html"
)" = "200"

test "$(
  curl -sS -H 'Accept: application/json' -o /dev/null -w '%{http_code}' \
    "$PRESS_BASE_URL/p/systems-review/latency-budget-audit.html"
)" = "401"
```

For production, replace the seeded page paths with operator-selected known
public and default/private pages from the restored database. A restore is not
accepted until all three checks pass.

## Archive retention and confidentiality purges

Unpublish is a soft delete. The application removes the page from serving and
indexes, then moves the blob from `$PRESS_STORAGE_DIR/<collection>/<file>` into
`$PRESS_STORAGE_DIR/.archive/<collection>/<file>`. Archived HTML remains on
disk and is included when the full storage directory is backed up with the
backup procedure above.

For ordinary unpublishes, keep `.archive` with the rest of storage so operators
can inspect what was removed. For confidentiality removals where retained bytes
must not remain on disk, purge the archive contents after confirming the page is
already unpublished and no running backup or restore is reading the directory:

```sh
export PRESS_STORAGE_DIR="/srv/press/storage"
find "$PRESS_STORAGE_DIR/.archive" -type f -print
rm -rf "$PRESS_STORAGE_DIR/.archive"/*
```

The purge is irreversible. It deletes only the archived blob copies; it does not
delete historical backups that already captured `.archive`, nor does it remove
audit rows from Postgres. Treat backup-set deletion or rotation as a separate
operator procedure under the same confidentiality incident.
