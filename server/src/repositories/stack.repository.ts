import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Updateable } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { StackTable } from 'src/schema/tables/stack.table';
import {
  asUuid,
  joinDeduplicationPlugin,
  OwnerLockVisibility,
  withDefaultVisibility,
  withLockVisibility,
} from 'src/utils/database';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

const withAssets = (
  eb: ExpressionBuilder<DB, 'stack'>,
  withTags = false,
  db?: Kysely<DB>,
  lockVisibility?: OwnerLockVisibility[],
) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call(withDefaultVisibility)
      .$if(!!db && !!lockVisibility?.length, (qb) => withLockVisibility(qb, db!, lockVisibility!)),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID }] })
  search(query: StackSearch, lockVisibility?: OwnerLockVisibility[]) {
    return (
      this.db
        .selectFrom('stack')
        .selectAll('stack')
        .select((eb) => withAssets(eb, false, this.db, lockVisibility))
        .where('stack.ownerId', '=', query.ownerId)
        .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
        // Embedded lock-visibility subqueries rely on the root query for join deduplication.
        .$if(!!lockVisibility?.length, (qb) => qb.withPlugin(joinDeduplicationPlugin))
        .execute()
    );
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      return tx
        .selectFrom('stack')
        .selectAll('stack')
        .select(withAssets)
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  update(id: string, entity: Updateable<StackTable>, lockVisibility?: OwnerLockVisibility[]) {
    return this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .returning((eb) => withAssets(eb, true, this.db, lockVisibility))
      .$if(!!lockVisibility?.length, (qb) => qb.withPlugin(joinDeduplicationPlugin))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string, lockVisibility?: OwnerLockVisibility[]) {
    return (
      this.db
        .selectFrom('stack')
        .selectAll()
        .select((eb) => withAssets(eb, true, this.db, lockVisibility))
        .where('id', '=', asUuid(id))
        // Embedded lock-visibility subqueries rely on the root query for join deduplication.
        .$if(!!lockVisibility?.length, (qb) => qb.withPlugin(joinDeduplicationPlugin))
        .executeTakeFirst()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
  }
}
