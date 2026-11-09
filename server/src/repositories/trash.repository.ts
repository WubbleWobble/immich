import { InjectKysely } from 'nestjs-kysely';
import type { Kysely } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { OwnerLockVisibility, joinDeduplicationPlugin, withLockVisibility } from 'src/utils/database.js';

export class TrashRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Fork (ruling R65): the owner's trashed assets that pass `lockVisibility` (the owner's own-lock entries). With
   * entries, the bulk update is restricted to this set so hidden trashed rows are neither changed nor counted.
   */
  private visibleTrashedIds(userId: string, lockVisibility: OwnerLockVisibility[]) {
    return withLockVisibility(
      this.db
        .selectFrom('asset')
        .select('asset.id')
        .where('asset.ownerId', '=', userId)
        .where('asset.status', '=', AssetStatus.Trashed),
      this.db,
      lockVisibility,
    );
  }

  getDeletedIds(): AsyncIterableIterator<{ id: string }> {
    return this.db.selectFrom('asset').select(['id']).where('status', '=', AssetStatus.Deleted).stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async restore(userId: string, lockVisibility: OwnerLockVisibility[] = []): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      .$if(lockVisibility.length > 0, (qb) =>
        qb
          .where('asset.id', 'in', this.visibleTrashedIds(userId, lockVisibility))
          // Embedded lock-visibility subqueries rely on the root query for join deduplication.
          .withPlugin(joinDeduplicationPlugin),
      )
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async empty(userId: string, lockVisibility: OwnerLockVisibility[] = []): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      .$if(lockVisibility.length > 0, (qb) =>
        qb
          .where('asset.id', 'in', this.visibleTrashedIds(userId, lockVisibility))
          // Embedded lock-visibility subqueries rely on the root query for join deduplication.
          .withPlugin(joinDeduplicationPlugin),
      )
      .set({ status: AssetStatus.Deleted })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async restoreAll(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('status', '=', AssetStatus.Trashed)
      .where('id', 'in', ids)
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }
}
