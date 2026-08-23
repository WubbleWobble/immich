import { WorkflowStepConfig } from '@immich/plugin-sdk';
import { Kysely } from 'kysely';
import { DB } from 'src/schema';
import { up } from 'src/schema/migrations/1779580000001-RetireWorkflowLockSteps';
import { getKyselyDB } from 'test/utils';

// Validates the 2.x -> 3.x workflow bridge (1779580000001-RetireWorkflowLockSteps) against
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
