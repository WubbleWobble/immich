import { WorkflowStepConfig } from '@immich/plugin-sdk';
import { Kysely, sql } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { up } from 'src/schema/migrations/1784900000000-RetireWorkflowLockSteps';
import { getKyselyDB } from 'test/utils';
import { vitest } from 'vitest';

// Validates the 2.x -> 3.x workflow bridge (1784900000000-RetireWorkflowLockSteps) against
// rows shaped like a live 2.x fork database: assetLock steps must be removed deliberately
// (not left for the plugin-sync FK cascade), assetVisibility(visibility=locked) steps must
// survive for manual re-pointing, both parent workflows must be disabled, and untouched
// workflows must stay enabled.
describe('fork upgrade bridge: RetireWorkflowLockSteps', () => {
  let db: Kysely<DB>;

  beforeAll(async () => {
    db = await getKyselyDB();
  });

  it('disables affected workflows, removes assetLock steps, keeps assetVisibility steps', async () => {
    const user = await db
      .insertInto('user')
      .values({
        name: 'bridge tester',
        email: 'bridge-tester@immich.cloud',
        password: '',
        profileImagePath: '',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const plugin = await db
      .insertInto('plugin')
      .values({
        name: 'immich-plugin-core',
        version: '0.0.0-test',
        title: 'test core',
        description: 'test',
        author: 'test',
        wasmBytes: Buffer.from(''),
        templates: [],
        sha256hash: Buffer.from(''),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const method = (name: string) =>
      db
        .insertInto('plugin_method')
        .values({
          pluginId: plugin.id,
          name,
          title: name,
          description: name,
          schema: null,
          types: ['AssetV1'] as never,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const assetLockMethod = await method('assetLock');
    const assetVisibilityMethod = await method('assetVisibility');
    const assetFavoriteMethod = await method('assetFavorite');

    const workflow = (name: string) =>
      db
        .insertInto('workflow')
        .values({ ownerId: user.id, trigger: 'AssetCreate' as never, name, description: null })
        .returning('id')
        .executeTakeFirstOrThrow();
    const lockWorkflow = await workflow('locks new assets');
    const visibilityWorkflow = await workflow('locks via visibility');
    const innocentWorkflow = await workflow('favorites new assets');

    const step = (workflowId: string, pluginMethodId: string, config: WorkflowStepConfig | null) =>
      db
        .insertInto('workflow_step')
        .values({ workflowId, pluginMethodId, config, order: 0 } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    const lockStep = await step(lockWorkflow.id, assetLockMethod.id, null);
    const visibilityStep = await step(visibilityWorkflow.id, assetVisibilityMethod.id, { visibility: 'locked' });
    const innocentStep = await step(innocentWorkflow.id, assetFavoriteMethod.id, null);

    await up(db);

    const workflows = await db
      .selectFrom('workflow')
      .select(['id', 'enabled'])
      .where('id', 'in', [lockWorkflow.id, visibilityWorkflow.id, innocentWorkflow.id])
      .execute();
    const enabledById = new Map(workflows.map(({ id, enabled }) => [id, enabled]));
    expect(enabledById.get(lockWorkflow.id)).toBe(false);
    expect(enabledById.get(visibilityWorkflow.id)).toBe(false);
    expect(enabledById.get(innocentWorkflow.id)).toBe(true);

    const steps = await db
      .selectFrom('workflow_step')
      .select('id')
      .where('id', 'in', [lockStep.id, visibilityStep.id, innocentStep.id])
      .execute();
    const stepIds = new Set(steps.map(({ id }) => id));
    expect(stepIds.has(lockStep.id)).toBe(false);
    expect(stepIds.has(visibilityStep.id)).toBe(true);
    expect(stepIds.has(innocentStep.id)).toBe(true);
  });
});

// Validates the ledger repair for databases that executed interim commit 1061114a0, whose
// bridge migration shipped under the backdated name 1779580000001. Renaming the file made
// kysely reject such ledgers ("previously executed migration ... is missing"), so
// runMigrations() normalizes the row - name AND timestamp (execution order is validated
// too) - before the migrator runs.
describe('fork upgrade bridge: ledger normalization for interim commit 1061114a0', () => {
  it('renames and reorders the backdated ledger row, then migrates cleanly - in any session timezone', async () => {
    const db = await getKyselyDB();

    // The repair must not depend on the PostgreSQL session timezone (to_char renders local
    // time; a literal 'Z' suffix would mislabel the instant and sort the row too early).
    await sql`SET timezone = 'America/Los_Angeles'`.execute(db);

    // Simulate the 1061114a0 ledger: the bridge executed under its old name, early.
    await db
      .updateTable('kysely_migrations')
      .set({
        name: '1779580000001-RetireWorkflowLockSteps',
        timestamp: '2026-08-23T00:00:00.000Z',
      })
      .where('name', '=', '1784900000000-RetireWorkflowLockSteps')
      .execute();

    const repository = new DatabaseRepository(db as never, LoggingRepository.create(), new ConfigRepository());

    // Without normalization this throws "corrupted migrations: ... is missing".
    await expect(repository.runMigrations()).resolves.toBeUndefined();

    // The bridge adopts its filename-order predecessor's timestamp verbatim; kysely's
    // name tiebreak then places it exactly where the filename sorts - after the
    // predecessor, but never past migrations added later.
    const rows = await db
      .selectFrom('kysely_migrations')
      .select(['name', 'timestamp'])
      .orderBy('timestamp', 'asc')
      .orderBy('name', 'asc')
      .execute();
    const names = rows.map(({ name }) => name);
    expect(names).not.toContain('1779580000001-RetireWorkflowLockSteps');
    const bridgeIndex = names.indexOf('1784900000000-RetireWorkflowLockSteps');
    expect(names[bridgeIndex - 1]).toBe('1784836013770-MinFacePreferenceMigration');
    expect(rows[bridgeIndex].timestamp).toBe(rows[bridgeIndex - 1].timestamp);

    // A second startup is a no-op and still migrates cleanly.
    await expect(repository.runMigrations()).resolves.toBeUndefined();
  });
});

// The abnormal-ledger fallback (P2): if the bridge executed under its backdated name but
// its filename-order predecessor was later reverted (so it is pending again), renaming the
// row would sort it after pending migrations and kysely would reject the ledger. The
// normalization instead drops the old entry, and the idempotent bridge reruns in order.
describe('fork upgrade bridge: ledger normalization with a pending predecessor', () => {
  it('drops the backdated row and reruns the bridge in filename order', async () => {
    const db = await getKyselyDB();
    const repository = new DatabaseRepository(db as never, LoggingRepository.create(), new ConfigRepository());

    // Revert the bridge and its predecessor, then plant the backdated ledger entry -
    // reproducing a 1061114a0-executed bridge on a partially reverted ledger.
    await repository.revertLastMigration();
    await repository.revertLastMigration();
    await db
      .insertInto('kysely_migrations')
      .values({ name: '1779580000001-RetireWorkflowLockSteps', timestamp: '2026-08-23T00:00:00.000Z' })
      .execute();

    await expect(repository.runMigrations()).resolves.toBeUndefined();

    const ledgerRows = await db.selectFrom('kysely_migrations').select('name').execute();
    const names = ledgerRows.map(({ name }) => name);
    expect(names).not.toContain('1779580000001-RetireWorkflowLockSteps');
    expect(names).toContain('1784836013770-MinFacePreferenceMigration');
    expect(names).toContain('1784900000000-RetireWorkflowLockSteps');
  });
});

// The rolling-upgrade race (P2): an old 1061114a0 instance can commit the backdated row
// AFTER the new instance's normalization ran but before its migrator locked. Simulated by
// suppressing the first normalization call: the migrator then fails on the backdated row,
// and runMigrations() must re-normalize and retry instead of aborting startup.
describe('fork upgrade bridge: rolling-upgrade race retry', () => {
  it('re-normalizes and retries when the migrator hits the backdated row', async () => {
    const db = await getKyselyDB();

    await db
      .updateTable('kysely_migrations')
      .set({
        name: '1779580000001-RetireWorkflowLockSteps',
        timestamp: '2026-08-23T00:00:00.000Z',
      })
      .where('name', '=', '1784900000000-RetireWorkflowLockSteps')
      .execute();

    const repository = new DatabaseRepository(db as never, LoggingRepository.create(), new ConfigRepository());
    const prototype = DatabaseRepository.prototype as unknown as { normalizeForkLedger: () => Promise<void> };
    const spy = vitest.spyOn(prototype, 'normalizeForkLedger').mockImplementationOnce(() => Promise.resolve());

    try {
      await expect(repository.runMigrations()).resolves.toBeUndefined();
      // First call was the suppressed pre-migration attempt; the retry made the second.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }

    const ledgerRows = await db.selectFrom('kysely_migrations').select('name').execute();
    const names = ledgerRows.map(({ name }) => name);
    expect(names).not.toContain('1779580000001-RetireWorkflowLockSteps');
    expect(names).toContain('1784900000000-RetireWorkflowLockSteps');
  });
});
