import { Kysely, sql } from 'kysely';

// Per-user locked albums & folders. See
// ../immich-specs/2026-05-24-locked-albums-and-folders-design.md §5 and §11.
//
// The data step replaces the old per-asset visibility=locked mechanism: each user's locked
// assets move into a per-user "Locked Folder" album, that album gets a locked_album row, and
// the assets flip back to visibility=timeline. The per-user step is idempotent on re-run:
// users who already have a locked_album row on an owned album named 'Locked Folder' are
// skipped (spec §5.5 - the heuristic marker; a dedicated marker column is a tracked
// follow-up).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "locked_album" (
  "userId" uuid NOT NULL,
  "albumId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "locked_album_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "locked_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "locked_album_pkey" PRIMARY KEY ("userId", "albumId")
);`.execute(db);
  await sql`CREATE INDEX "locked_album_albumId_idx" ON "locked_album" ("albumId");`.execute(db);
  await sql`CREATE TABLE "locked_container" (
  "userId" uuid NOT NULL,
  "containerId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "locked_container_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "locked_container_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "album_container" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "locked_container_pkey" PRIMARY KEY ("userId", "containerId")
);`.execute(db);
  await sql`CREATE INDEX "locked_container_containerId_idx" ON "locked_container" ("containerId");`.execute(db);

  // Data migration. A single data-modifying CTE so every branch sees one snapshot: users
  // that still have visibility=locked assets and no migrated built-in album get one new
  // album, ownership row, membership rows, and lock row; their locked assets flip to
  // timeline. Users without locked assets are untouched.
  //
  // NOTE: 'locked' comparisons go through ::text - on a fresh install all pending migrations
  // share one transaction, and Postgres forbids referencing an enum value added by
  // ALTER TYPE ADD VALUE (which is how 'locked' entered the enum) in that same transaction.
  await sql`WITH users_needing AS (
  SELECT DISTINCT a."ownerId" AS user_id
  FROM "asset" a
  WHERE a."visibility"::text = 'locked'
    AND NOT EXISTS (
      SELECT 1
      FROM "locked_album" la
      JOIN "album" al ON al."id" = la."albumId" AND al."albumName" = 'Locked Folder'
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
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse per spec §11.3: privacy first. Every asset in ANY currently-locked album is
  // re-flagged visibility=locked so stock Immich's filter hides it again - this covers both
  // the migrated built-in albums and user-created locked albums.
  await sql`UPDATE "asset" SET "visibility" = 'locked'
WHERE "id" IN (
  SELECT aa."assetId" FROM "album_asset" aa
  JOIN "locked_album" la ON la."albumId" = aa."albumId"
);`.execute(db);
  // Migrated built-in albums (heuristic: named 'Locked Folder' and locked by their owner)
  // are dismantled; user-created locked albums keep their membership rows (stock hides the
  // assets via the visibility filter - see spec §11.3 for the cosmetic caveat).
  await sql`DELETE FROM "album_asset"
WHERE "albumId" IN (
  SELECT al."id" FROM "album" al
  JOIN "locked_album" la ON la."albumId" = al."id"
  JOIN "album_user" au ON au."albumId" = al."id" AND au."role" = 'owner' AND au."userId" = la."userId"
  WHERE al."albumName" = 'Locked Folder'
);`.execute(db);
  await sql`DELETE FROM "album"
WHERE "id" IN (
  SELECT al."id" FROM "album" al
  JOIN "locked_album" la ON la."albumId" = al."id"
  JOIN "album_user" au ON au."albumId" = al."id" AND au."role" = 'owner' AND au."userId" = la."userId"
  WHERE al."albumName" = 'Locked Folder'
);`.execute(db);
  await sql`DROP TABLE "locked_container";`.execute(db);
  await sql`DROP TABLE "locked_album";`.execute(db);
}
