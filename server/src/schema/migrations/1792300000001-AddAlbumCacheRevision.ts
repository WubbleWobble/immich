import { Kysely, sql } from 'kysely';

// Fork (7A.5): smart-album cache freshness becomes an integer revision token instead of comparing timestamps.
// Existing rows get "cachedRevision" NULL, i.e. stale, so each smart album recomputes its cache once.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD "cacheRevision" integer NOT NULL DEFAULT 0;`.execute(db);
  await sql`ALTER TABLE "album" ADD "cachedRevision" integer;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" DROP COLUMN "cachedRevision";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cacheRevision";`.execute(db);
}
