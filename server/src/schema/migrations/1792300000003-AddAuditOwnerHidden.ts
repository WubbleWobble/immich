import { Kysely, sql } from 'kysely';

// Fork (ruling R66): the partner sync delete streams read every audit row of a sharing owner, and once the live row and
// its memberships are gone the owner's lock verdict cannot be reconstructed. The deletion paths therefore judge the
// asset or stack BEFORE deleting it (the R58/R61 verdict) and persist the verdict on the audit row the delete trigger
// writes: "ownerHidden" = true marks an asset hidden by its owner's own locks outside elevation, or a stack with such a
// member (the partner stack stream's rule). Partner delete streams skip those rows; the owner's own streams do not.
// Existing rows stay NULL and are treated as visible (no reconstruction; production holds no locks).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_audit" ADD "ownerHidden" boolean;`.execute(db);
  await sql`ALTER TABLE "stack_audit" ADD "ownerHidden" boolean;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "stack_audit" DROP COLUMN "ownerHidden";`.execute(db);
  await sql`ALTER TABLE "asset_audit" DROP COLUMN "ownerHidden";`.execute(db);
}
