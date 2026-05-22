import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TYPE "album_kind_enum" AS ENUM ('regular','smart');`.execute(db);
  await sql`ALTER TABLE "album" ADD "kind" album_kind_enum NOT NULL DEFAULT 'regular';`.execute(db);
  await sql`ALTER TABLE "album" ADD "filter" jsonb;`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_kind_filter_consistency" CHECK (("kind" = 'smart' AND "filter" IS NOT NULL) OR ("kind" = 'regular' AND "filter" IS NULL));`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_kind_filter_consistency";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "filter";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "kind";`.execute(db);
  await sql`DROP TYPE "album_kind_enum";`.execute(db);
}
