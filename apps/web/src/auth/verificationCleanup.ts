import { sql } from 'drizzle-orm'

import type { db as dbClient } from '../db/client'

const SWEEP_BATCH_SIZE = 500
// Keep an expired row for a grace period so a device poll still sees the row and
// returns `expired_token` (REQ-AUTH-004) rather than `invalid_grant` (row absent).
// No legitimate client polls beyond this window: device grants live 15 minutes and
// the CLI stops at its deadline; loopback codes live 5 minutes.
const SWEEP_GRACE_PERIOD_MS = 60 * 60 * 1000

// Sweep expired press-owned rows from the shared `verification` table (F-33).
// Device grants, user-code indexes, consent rows, loopback pending/code rows, and
// rate-limit state all live under the `cli:` prefix with an expiresAt, and are
// otherwise deleted only on consume — so an abandoned flow leaks its row forever.
// The flow entry points call the best-effort wrapper before creating new rows; this
// is opportunistic cleanup (no boot timer — the server entry doubles as the
// Dockerfile's must-exit preflight, so it cannot host an interval): expired rows are
// drained as flows continue, and an abandoned flow's rows persist until the next
// auth entry request.
export async function sweepExpiredCliVerificationRows(
  db: typeof dbClient,
  now: Date = new Date(),
): Promise<number> {
  // Bounded batch: a large backlog must not make the first sweep an unbounded
  // scan+lock+delete that stalls request handling. Successive flow requests drain
  // the backlog a batch at a time. The cutoff re-checks `expiresAt < cutoff` at the
  // delete target so a limiter that refreshed the row after the subquery is not
  // removed (read-then-delete race).
  const cutoff = new Date(now.getTime() - SWEEP_GRACE_PERIOD_MS)
  const result = await db.execute<{ id: string }>(sql`
    delete from "verification"
    where id in (
      select id from "verification"
      where identifier like 'cli:%' and "expiresAt" < ${cutoff}
      limit ${SWEEP_BATCH_SIZE}
    )
    and "expiresAt" < ${cutoff}
    returning id
  `)
  return result.rows.length
}

// Best-effort housekeeping: a sweep failure must not block the flow that triggered
// it, but it must be observable (fail loudly in the log, not silently swallowed).
export async function sweepExpiredCliVerificationRowsBestEffort(
  db: typeof dbClient,
): Promise<void> {
  try {
    await sweepExpiredCliVerificationRows(db)
  } catch (error) {
    console.error('verification row sweep failed', error)
  }
}
