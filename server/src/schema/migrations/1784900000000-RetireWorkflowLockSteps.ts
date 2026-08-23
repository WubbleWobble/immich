import { Kysely, sql } from 'kysely';

// The fork retires the core plugin's per-asset lock automation: the assetLock workflow
// action is removed from the plugin, and assetVisibility no longer offers 'locked'
// (visibility=locked writes are rejected server-side; filing into a locked album requires
// an elevated session that a background workflow cannot hold).
//
// Without this bridge, first 3.x startup would handle existing workflows badly:
// - plugin sync prunes the now-missing assetLock method, and workflow_step's
//   ON DELETE CASCADE would then SILENTLY delete those steps;
// - assetVisibility steps stored with visibility='locked' would survive but fail on
//   every run, since the runtime forwards the stored value into a rejected asset update.
// Either way, automation the user relies on to hide new assets stops working without a
// word - a privacy hazard.
//
// This migration runs before plugin sync (migrations complete during bootstrap) and:
// 1. disables every workflow containing either step form, so no partial pipeline runs a
//    surprising subset;
// 2. deletes the assetLock steps itself - deliberately and logged, instead of silently
//    via the FK cascade (the method row is about to disappear regardless);
// 3. leaves assetVisibility steps in place (their method still exists) for the operator
//    to re-point; the disabled workflow prevents repeated failures until then.
//
// Fresh installs have no plugin/workflow rows yet: every statement is a no-op.
export async function up(db: Kysely<any>): Promise<void> {
  const lockSteps = await db
    .selectFrom('workflow_step')
    .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
    .innerJoin('plugin', 'plugin.id', 'plugin_method.pluginId')
    .select(['workflow_step.id as stepId', 'workflow_step.workflowId as workflowId'])
    .where('plugin.name', '=', 'immich-plugin-core')
    .where('plugin_method.name', '=', 'assetLock')
    .execute();

  const visibilityLockedSteps = await db
    .selectFrom('workflow_step')
    .innerJoin('plugin_method', 'plugin_method.id', 'workflow_step.pluginMethodId')
    .innerJoin('plugin', 'plugin.id', 'plugin_method.pluginId')
    .select(['workflow_step.id as stepId', 'workflow_step.workflowId as workflowId'])
    .where('plugin.name', '=', 'immich-plugin-core')
    .where('plugin_method.name', '=', 'assetVisibility')
    .where(sql`workflow_step.config ->> 'visibility'`, '=', 'locked')
    .execute();

  const affectedWorkflowIds = [
    ...new Set([...lockSteps, ...visibilityLockedSteps].map(({ workflowId }) => workflowId)),
  ];

  if (affectedWorkflowIds.length > 0) {
    await db
      .updateTable('workflow')
      .set({ enabled: false })
      .where('id', 'in', affectedWorkflowIds)
      .execute();
  }

  if (lockSteps.length > 0) {
    await db
      .deleteFrom('workflow_step')
      .where(
        'id',
        'in',
        lockSteps.map(({ stepId }) => stepId),
      )
      .execute();
  }

  if (lockSteps.length > 0 || visibilityLockedSteps.length > 0) {
    // Surfaces in the server log on first 3.x startup.
    console.warn(
      `[fork upgrade] Retired per-asset lock automation: removed ${lockSteps.length} assetLock workflow step(s), ` +
        `kept ${visibilityLockedSteps.length} assetVisibility(visibility=locked) step(s) for manual re-pointing, ` +
        `and disabled ${affectedWorkflowIds.length} affected workflow(s). ` +
        `Locked albums replaced visibility=locked; see FORK-UPGRADE-3.x.md.`,
    );
  }
}

export async function down(): Promise<void> {
  // The retired steps cannot be meaningfully restored; workflows can be re-enabled by hand.
}
