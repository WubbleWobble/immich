import { Kysely, sql } from 'kysely';

// Schema-drift repair for the fork's own tables, found by `immich-admin schema-check`
// after the first production upgrade:
//   - locked_album/locked_container: the userId foreign-key columns are indexed in the
//     table definitions (every lock-visibility query filters on userId), but the original
//     migrations only created the album/container-side indexes.
//   - album.cachedThumbnailAssetId: the column comment declared in the table definition
//     was never emitted.
// IF NOT EXISTS keeps this idempotent for databases created after the originals were
// written, and it is a no-op on a database that somehow already has them.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS "locked_album_userId_idx" ON "locked_album" ("userId");`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "locked_container_userId_idx" ON "locked_container" ("userId");`.execute(db);
  await sql`COMMENT ON COLUMN "album"."cachedThumbnailAssetId" IS 'Cached thumbnail asset id for smart albums';`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "locked_album_userId_idx";`.execute(db);
  await sql`DROP INDEX IF EXISTS "locked_container_userId_idx";`.execute(db);
  await sql`COMMENT ON COLUMN "album"."cachedThumbnailAssetId" IS NULL;`.execute(db);
}
