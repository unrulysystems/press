import { sql } from 'drizzle-orm'

import type { PressDb } from '../db/client'

const SWEEP_BATCH_SIZE = 500
// Keep an expired row for a grace period so a device poll still sees the row and
// returns `expired_token` (REQ-AUTH-004) rather than `invalid_grant` (row absent).
const SWEEP_GRACE_PERIOD_MS = 60 * 60 * 1000

// Sweep expired press-owned rows from the shared `verification` table.
export async function sweepExpiredCliVerificationRows(
  db: PressDb,
  now: Date = new Date(),
): Promise<number> {
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

export async function sweepExpiredCliVerificationRowsBestEffort(db: PressDb): Promise<void> {
  try {
    await sweepExpiredCliVerificationRows(db)
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'verification_sweep_failed',
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
