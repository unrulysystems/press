import { and, eq, sql } from 'drizzle-orm'

import { apiToken, auditEvent, collection, page } from '../db/schema'

import type { db as dbClient } from '../db/client'

type PressDb = typeof dbClient

export type AuditLookup = {
  readonly collectionSlug: string
  readonly fileSlug?: string
  readonly action: 'publish' | 'overwrite' | 'unpublish' | 'visibility-change' | 'password-reroll'
  readonly userId: string
  readonly contentHash?: string
}

export async function findCollection(db: PressDb, collectionSlug: string) {
  return db.query.collection.findFirst({
    where: eq(collection.slug, collectionSlug),
  })
}

export async function findPage(db: PressDb, collectionSlug: string, fileSlug: string) {
  return db.query.page.findFirst({
    where: and(eq(page.collectionSlug, collectionSlug), eq(page.fileSlug, fileSlug)),
  })
}

export async function findTokenByUserAndName(db: PressDb, userId: string, name: string) {
  return db.query.apiToken.findFirst({
    where: and(eq(apiToken.userId, userId), eq(apiToken.name, name)),
  })
}

export async function findMatchingAuditEvent(db: PressDb, input: AuditLookup) {
  const rows = await db.query.auditEvent.findMany({
    where: and(
      eq(auditEvent.collectionSlug, input.collectionSlug),
      eq(auditEvent.action, input.action),
      eq(auditEvent.userId, input.userId),
    ),
  })
  return rows.find((row) => {
    if (input.fileSlug !== undefined && row.fileSlug !== input.fileSlug) {
      return false
    }
    return input.contentHash === undefined || row.contentHash === input.contentHash
  })
}

export async function installFailingAuditTrigger(
  db: PressDb,
  collectionSlug: string,
): Promise<void> {
  const collectionLiteral = `'${collectionSlug.replaceAll("'", "''")}'`
  await db.execute(
    sql.raw(`
    create or replace function press_e2e_fail_audit_insert()
    returns trigger as $$
    begin
      if new."collectionSlug" = ${collectionLiteral} then
        raise exception 'press e2e forced audit failure';
      end if;
      return new;
    end;
    $$ language plpgsql;
  `),
  )
  await db.execute(
    sql.raw(`
    create trigger press_e2e_fail_audit_insert
    before insert on "auditEvent"
    for each row execute function press_e2e_fail_audit_insert();
  `),
  )
}

export async function removeFailingAuditTrigger(db: PressDb): Promise<void> {
  await db.execute(sql`drop trigger if exists press_e2e_fail_audit_insert on "auditEvent";`)
  await db.execute(sql`drop function if exists press_e2e_fail_audit_insert();`)
}
