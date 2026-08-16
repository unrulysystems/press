import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'

import { verification } from '../db/schema'

import type { db as dbClient } from '../db/client'

export type RateLimitState = {
  readonly count: number
  readonly windowStart: number
}

export function parseRateLimitState(value: string): RateLimitState | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const record = parsed as Partial<RateLimitState>
    if (typeof record.count !== 'number' || typeof record.windowStart !== 'number') {
      return null
    }
    return { count: record.count, windowStart: record.windowStart }
  } catch {
    return null
  }
}

export function nextRateLimitState(
  existing: RateLimitState | null,
  now: number,
  windowMs: number,
): RateLimitState {
  if (existing && now - existing.windowStart < windowMs) {
    return { count: existing.count + 1, windowStart: existing.windowStart }
  }
  return { count: 1, windowStart: now }
}

// Shared fixed-window rate limiter stored in the `verification` table. The advisory
// lock serializes the read-modify-write so concurrent callers cannot each observe an
// empty bucket and all pass. The identifier is server-chosen (never client IP — a
// Fetch Request has no trusted peer address). Returns false once `max` attempts have
// been counted inside the window.
export async function consumeRateLimit(
  db: typeof dbClient,
  input: {
    readonly identifier: string
    readonly max: number
    readonly windowMs: number
    readonly now: number
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.identifier}))`)
    const existing = await tx
      .select()
      .from(verification)
      .where(eq(verification.identifier, input.identifier))
    const row = existing[0]
    const state = nextRateLimitState(
      row ? parseRateLimitState(row.value) : null,
      input.now,
      input.windowMs,
    )
    const expiresAt = new Date(state.windowStart + input.windowMs)
    if (row) {
      await tx
        .update(verification)
        .set({
          value: JSON.stringify(state),
          expiresAt,
          updatedAt: new Date(input.now),
        })
        .where(eq(verification.identifier, input.identifier))
    } else {
      await tx.insert(verification).values({
        id: randomUUID(),
        identifier: input.identifier,
        value: JSON.stringify(state),
        expiresAt,
      })
    }
    return state.count <= input.max
  })
}
