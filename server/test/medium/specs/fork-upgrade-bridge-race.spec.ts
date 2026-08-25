import { Kysely, sql } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';
import { vitest } from 'vitest';

// Deterministic reproduction of the concurrent pre-bridge repair race (P2): the
// needed-check runs outside kysely's migration lock, so a second replica can commit the
// bridge's ledger row between our check and our insert. The bridge module is mocked to
// run the real repair AND plant the winner's row before returning - the loser's insert
// must tolerate it (ON CONFLICT DO NOTHING) instead of failing with a duplicate key.
vitest.mock('src/schema/migrations/1784900000000-RetireWorkflowLockSteps', async (importOriginal) => {
  const original = await importOriginal<typeof import('src/schema/migrations/1784900000000-RetireWorkflowLockSteps')>();
  const up = async (db: Kysely<DB>) => {
    await original.up(db);
    // The "concurrent winner" records the bridge first.
    await sql`
      INSERT INTO kysely_migrations (name, timestamp)
      SELECT '1784900000000-RetireWorkflowLockSteps', timestamp
      FROM kysely_migrations
      WHERE name = '1784836013770-MinFacePreferenceMigration'
      ON CONFLICT (name) DO NOTHING
    `.execute(db);
  };
  // The migrator's file provider may read the module's default export; mirror the shape.
  return { ...original, up, default: { ...original, up } };
});

describe('fork upgrade bridge: concurrent pre-bridge repair', () => {
  it('tolerates a concurrent winner committing the bridge row mid-repair', async () => {
    const db: Kysely<DB> = await getKyselyDB();

    await db.deleteFrom('kysely_migrations').where('name', '=', '1784900000000-RetireWorkflowLockSteps').execute();
    const oldNames: Array<[string, string]> = [
      ['1784910000001-AddAlbumSmartKind', '1779487447243-AddAlbumSmartKind'],
      ['1784910000002-AddAlbumSmartAlbumCache', '1779549231508-AddAlbumSmartAlbumCache'],
      ['1784910000003-AddAlbumContainers', '1779574778179-AddAlbumContainers'],
      ['1784910000004-AddLockedContent', '1779580000000-AddLockedContent'],
    ];
    for (const [current, old] of oldNames) {
      await db
        .updateTable('kysely_migrations')
        .set({ name: old, timestamp: '2026-08-23T00:00:00.000Z' })
        .where('name', '=', current)
        .execute();
    }

    const repository = new DatabaseRepository(db as never, LoggingRepository.create(), new ConfigRepository());
    await expect(repository.runMigrations()).resolves.toBeUndefined();

    const bridgeRows = await db
      .selectFrom('kysely_migrations')
      .select('name')
      .where('name', '=', '1784900000000-RetireWorkflowLockSteps')
      .execute();
    expect(bridgeRows).toHaveLength(1);
  });
});
