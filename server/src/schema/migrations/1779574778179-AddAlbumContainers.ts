import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD "containerId" uuid;`.execute(db);
  await sql`CREATE INDEX "album_containerId_idx" ON "album" ("containerId");`.execute(db);
  await sql`CREATE TABLE "album_container" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "name" character varying NOT NULL,
  "ownerId" uuid NOT NULL,
  "parentId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "deletedAt" timestamp with time zone,
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "album_container_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_container_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "album_container" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(db);
  await sql`CREATE INDEX "album_container_ownerId_idx" ON "album_container" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "album_container_parentId_idx" ON "album_container" ("parentId");`.execute(db);
  await sql`CREATE INDEX "album_container_updateId_idx" ON "album_container" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_container_updatedAt"
  BEFORE UPDATE ON "album_container"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`ALTER TABLE "album_container" ADD CONSTRAINT "album_container_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "album_container" ("id") ON UPDATE CASCADE ON DELETE CASCADE;`.execute(db);
  await sql`CREATE TABLE "album_container_closure" (
  "id_ancestor" uuid NOT NULL,
  "id_descendant" uuid NOT NULL,
  "depth" integer NOT NULL,
  CONSTRAINT "album_container_closure_id_ancestor_fkey" FOREIGN KEY ("id_ancestor") REFERENCES "album_container" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "album_container_closure_id_descendant_fkey" FOREIGN KEY ("id_descendant") REFERENCES "album_container" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "album_container_closure_pkey" PRIMARY KEY ("id_ancestor", "id_descendant")
);`.execute(db);
  await sql`ALTER TABLE "album_container_closure" ADD CONSTRAINT "album_container_closure_depth_max" CHECK ("depth" <= 16);`.execute(db);
  await sql`CREATE INDEX "album_container_closure_id_ancestor_idx" ON "album_container_closure" ("id_ancestor");`.execute(db);
  await sql`CREATE INDEX "album_container_closure_id_descendant_idx" ON "album_container_closure" ("id_descendant");`.execute(db);
  await sql`CREATE TABLE "album_container_user" (
  "albumContainerId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "role" album_user_role_enum NOT NULL DEFAULT 'editor',
  "createId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "album_container_user_albumContainerId_fkey" FOREIGN KEY ("albumContainerId") REFERENCES "album_container" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_container_user_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_container_user_pkey" PRIMARY KEY ("albumContainerId", "userId")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "album_container_user_unique_owner" ON "album_container_user" ("albumContainerId") WHERE (role = 'owner');`.execute(db);
  await sql`CREATE INDEX "album_container_user_albumContainerId_idx" ON "album_container_user" ("albumContainerId");`.execute(db);
  await sql`CREATE INDEX "album_container_user_userId_idx" ON "album_container_user" ("userId");`.execute(db);
  await sql`CREATE INDEX "album_container_user_createId_idx" ON "album_container_user" ("createId");`.execute(db);
  await sql`CREATE INDEX "album_container_user_updateId_idx" ON "album_container_user" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_container_user_updatedAt"
  BEFORE UPDATE ON "album_container_user"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_album_container_updatedAt', '{"type":"trigger","name":"album_container_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"album_container_updatedAt\\"\\n  BEFORE UPDATE ON \\"album_container\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_album_container_user_updatedAt', '{"type":"trigger","name":"album_container_user_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"album_container_user_updatedAt\\"\\n  BEFORE UPDATE ON \\"album_container_user\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_album_container_user_unique_owner', '{"type":"index","name":"album_container_user_unique_owner","sql":"CREATE UNIQUE INDEX \\"album_container_user_unique_owner\\" ON \\"album_container_user\\" (\\"albumContainerId\\") WHERE (role = ''owner'');"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_album_container_user_unique_owner';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_album_container_user_updatedAt';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_album_container_updatedAt';`.execute(db);
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_containerId_fkey";`.execute(db);
  await sql`DROP INDEX "album_containerId_idx";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "containerId";`.execute(db);
  await sql`DROP TABLE "album_container_user";`.execute(db);
  await sql`ALTER TABLE "album_container_closure" DROP CONSTRAINT "album_container_closure_depth_max";`.execute(db);
  await sql`DROP TABLE "album_container_closure";`.execute(db);
  await sql`ALTER TABLE "album_container" DROP CONSTRAINT "album_container_parentId_fkey";`.execute(db);
  await sql`DROP TABLE "album_container";`.execute(db);
}
