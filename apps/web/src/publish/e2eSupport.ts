import { and, eq, sql } from 'drizzle-orm'

import { apiToken, auditEvent, collection, page } from '../db/schema'

import type { db as dbClient } from '../db/client'

type PressDb = typeof dbClient

export type FailingAuditTrigger = {
  readonly collectionSlug: string
}

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

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export async function installFailingAuditTrigger(
  db: PressDb,
  collectionSlug: string,
): Promise<FailingAuditTrigger> {
  const collectionLiteral = quoteSqlLiteral(collectionSlug)

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('press_e2e_fail_audit_setup'))`)
    await tx.execute(
      sql.raw(`
      create table if not exists press_e2e_failing_audit_collection (
        "collectionSlug" text primary key
      );
    `),
    )
    await tx.execute(
      sql.raw(`
      do $$
      begin
        if to_regprocedure('press_e2e_fail_audit_insert()') is null then
          create function press_e2e_fail_audit_insert()
          returns trigger as $trigger$
          begin
            if exists (
              select 1
              from press_e2e_failing_audit_collection
              where "collectionSlug" = new."collectionSlug"
            ) then
              raise exception 'press e2e forced audit failure';
            end if;
            return new;
          end;
          $trigger$ language plpgsql;
        end if;

        if not exists (
          select 1
          from pg_trigger
          where tgname = 'press_e2e_fail_audit_insert'
            and tgrelid = '"auditEvent"'::regclass
        ) then
          create trigger press_e2e_fail_audit_insert
          before insert on "auditEvent"
          for each row execute function press_e2e_fail_audit_insert();
        end if;
      end $$;
    `),
    )
    await tx.execute(
      sql.raw(`
      insert into press_e2e_failing_audit_collection ("collectionSlug")
      values (${collectionLiteral})
      on conflict ("collectionSlug") do nothing;
    `),
    )
  })

  return { collectionSlug }
}

export async function removeFailingAuditTrigger(
  db: PressDb,
  handle: FailingAuditTrigger,
): Promise<void> {
  await db.execute(
    sql.raw(
      `delete from press_e2e_failing_audit_collection where "collectionSlug" = ${quoteSqlLiteral(
        handle.collectionSlug,
      )};`,
    ),
  )
}
