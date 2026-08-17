import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD "cachedAssetCount" integer;`.execute(db);
  await sql`ALTER TABLE "album" ADD "cachedThumbnailAssetId" uuid;`.execute(db);
  await sql`ALTER TABLE "album" ADD "cachedStartDate" date;`.execute(db);
  await sql`ALTER TABLE "album" ADD "cachedEndDate" date;`.execute(db);
  await sql`ALTER TABLE "album" ADD "cacheComputedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "album" ADD "cacheInvalidatedAt" timestamp with time zone;`.execute(db);
  await sql`CREATE INDEX "album_cachedThumbnailAssetId_idx" ON "album" ("cachedThumbnailAssetId");`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_cachedThumbnailAssetId_fkey" FOREIGN KEY ("cachedThumbnailAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_cachedThumbnailAssetId_fkey";`.execute(db);
  await sql`DROP INDEX "album_cachedThumbnailAssetId_idx";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cacheInvalidatedAt";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cacheComputedAt";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cachedEndDate";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cachedStartDate";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cachedThumbnailAssetId";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "cachedAssetCount";`.execute(db);
}
