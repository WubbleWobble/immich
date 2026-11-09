import { Kysely, sql } from 'kysely';

// Fork (R40): per-asset visibility=locked is retired (1784910000004-AddLockedContent moved those assets into a locked
// per-user "Locked Folder" album and every write path rejects the value), so the database now refuses it outright. The
// enum keeps the value (spec §13: removal is a later release).
//
// Before the constraint is added, any asset still flagged locked is filed into its owner's locked built-in album and
// flipped to timeline, so it stays hidden rather than failing the upgrade or surfacing:
// - owners without a live locked built-in album get one (the 1784910000004 step; a trashed album does not count, since
//   membership in a trashed album hides nothing);
// - owners who already had one (the case that step skipped) get the asset filed into it.
//
// NOTE: 'locked' comparisons go through ::text - on a fresh install all pending migrations share one transaction, and
// Postgres forbids referencing an enum value added by ALTER TYPE ADD VALUE in that same transaction. The constraint
// expression does the same for the same reason.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`WITH users_needing AS (
  SELECT DISTINCT a."ownerId" AS user_id
  FROM "asset" a
  WHERE a."visibility"::text = 'locked'
    AND NOT EXISTS (
      SELECT 1
      FROM "locked_album" la
      JOIN "album" al ON al."id" = la."albumId" AND al."albumName" = 'Locked Folder' AND al."deletedAt" IS NULL
      JOIN "album_user" au ON au."albumId" = al."id" AND au."role" = 'owner' AND au."userId" = la."userId"
      WHERE la."userId" = a."ownerId"
    )
),
albums_to_create AS (
  SELECT uuid_generate_v4() AS album_id, user_id FROM users_needing
),
ins_album AS (
  INSERT INTO "album" ("id", "albumName", "description")
  SELECT album_id, 'Locked Folder', '' FROM albums_to_create
),
ins_owner AS (
  INSERT INTO "album_user" ("albumId", "userId", "role")
  SELECT album_id, user_id, 'owner' FROM albums_to_create
),
ins_assets AS (
  INSERT INTO "album_asset" ("albumId", "assetId")
  SELECT c.album_id, a."id"
  FROM albums_to_create c
  JOIN "asset" a ON a."ownerId" = c.user_id AND a."visibility"::text = 'locked'
),
ins_lock AS (
  INSERT INTO "locked_album" ("userId", "albumId")
  SELECT user_id, album_id FROM albums_to_create
)
UPDATE "asset" SET "visibility" = 'timeline'
WHERE "visibility"::text = 'locked'
  AND "ownerId" IN (SELECT user_id FROM albums_to_create);`.execute(db);

  await sql`WITH built_in AS (
  SELECT DISTINCT ON (la."userId") la."userId" AS user_id, al."id" AS album_id
  FROM "locked_album" la
  JOIN "album" al ON al."id" = la."albumId" AND al."albumName" = 'Locked Folder' AND al."deletedAt" IS NULL
  JOIN "album_user" au ON au."albumId" = al."id" AND au."role" = 'owner' AND au."userId" = la."userId"
  ORDER BY la."userId", al."createdAt"
),
ins_assets AS (
  INSERT INTO "album_asset" ("albumId", "assetId")
  SELECT b.album_id, a."id"
  FROM built_in b
  JOIN "asset" a ON a."ownerId" = b.user_id AND a."visibility"::text = 'locked'
  ON CONFLICT DO NOTHING
)
UPDATE "asset" SET "visibility" = 'timeline'
WHERE "visibility"::text = 'locked'
  AND "ownerId" IN (SELECT user_id FROM built_in);`.execute(db);

  await sql`ALTER TABLE "asset" ADD CONSTRAINT "asset_visibility_not_locked_chk" CHECK ("visibility"::text <> 'locked');`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" DROP CONSTRAINT "asset_visibility_not_locked_chk";`.execute(db);
}
