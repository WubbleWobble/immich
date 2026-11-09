import { Injectable } from '@nestjs/common';
import {
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type OrderByDirection,
  type Updateable,
  sql,
} from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { IBulkAsset } from 'src/types.js';
import { Chunked, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import { MemorySearchDto } from 'src/dtos/memory.dto.js';
import { AssetFileType, AssetOrderWithRandom, AssetVisibility } from 'src/enum.js';
import { type YearMonthDay } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { MemoryTable } from 'src/schema/tables/memory.table.js';
import { OwnerLockVisibility, joinDeduplicationPlugin, withLockVisibility } from 'src/utils/database.js';
import { asLocalTime } from 'src/utils/date.js';

const asMakeDate = (eb: ExpressionBuilder<DB, 'asset'>, { year, month, day }: YearMonthDay) =>
  eb.fn('make_date', [sql`${year}::int`, sql`${month}::int`, sql`${day}::int`]);

@Injectable()
export class MemoryRepository implements IBulkAsset {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async cleanup() {
    await this.db
      .deleteFrom('memory_asset')
      .using('asset')
      .whereRef('memory_asset.assetId', '=', 'asset.id')
      .where('asset.visibility', '!=', AssetVisibility.Timeline)
      .execute();

    return this.db
      .deleteFrom('memory')
      .where('createdAt', '<', DateTime.now().minus({ days: 30 }).toJSDate())
      .where('isSaved', '=', false)
      .execute();
  }

  searchBuilder(ownerId: string, dto: MemorySearchDto) {
    return this.db
      .selectFrom('memory')
      .$if(dto.isSaved !== undefined, (qb) => qb.where('isSaved', '=', dto.isSaved!))
      .$if(dto.type !== undefined, (qb) => qb.where('type', '=', dto.type!))
      .$if(dto.for !== undefined, (qb) =>
        qb
          .where((where) => where.or([where('showAt', 'is', null), where('showAt', '<=', dto.for!)]))
          .where((where) => where.or([where('hideAt', 'is', null), where('hideAt', '>=', dto.for!)])),
      )
      .$if(dto.isUpcoming !== undefined, (qb) => {
        const now = asLocalTime(DateTime.now());
        return dto.isUpcoming
          ? qb.where('showAt', '>', now)
          : qb.where((where) => where.or([where('showAt', 'is', null), where('showAt', '<=', now)]));
      })
      .where('deletedAt', dto.isTrashed ? 'is not' : 'is', null)
      .where('ownerId', '=', ownerId);
  }

  @GenerateSql(
    { params: [DummyValue.UUID, {}] },
    { name: 'date filter', params: [DummyValue.UUID, { for: DummyValue.DATE }] },
  )
  statistics(ownerId: string, dto: MemorySearchDto, lockVisibility?: OwnerLockVisibility[]) {
    return this.searchBuilderWithLocks(ownerId, dto, lockVisibility)
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  /**
   * Fork: with locks in play, only memories that still have at least one visible asset match - in SQL, so a memory
   * whose every asset is locked away neither counts nor consumes a page slot (memories page, 351be9576). The embedded
   * subqueries rely on the root query for join deduplication.
   */
  private searchBuilderWithLocks(ownerId: string, dto: MemorySearchDto, lockVisibility?: OwnerLockVisibility[]) {
    const qb = this.searchBuilder(ownerId, dto);
    if (!lockVisibility?.length) {
      return qb;
    }
    const visibleAsset = withLockVisibility(
      this.db
        .selectFrom('asset')
        .select('asset.id')
        .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
        // Correlated ref to the outer memory row; 'memory' is outside this builder's type scope.
        .whereRef('memory_asset.memoriesId', '=', 'memory.id' as never)
        .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
        .where('asset.deletedAt', 'is', null),
      this.db,
      lockVisibility,
    );
    return qb.where((eb) => eb.exists(visibleAsset)).withPlugin(joinDeduplicationPlugin);
  }

  @GenerateSql(
    { params: [DummyValue.UUID, {}] },
    { name: 'date filter', params: [DummyValue.UUID, { for: DummyValue.DATE }] },
    { name: 'upcoming filter', params: [DummyValue.UUID, { isUpcoming: true }] },
    { name: 'not upcoming filter', params: [DummyValue.UUID, { isUpcoming: false }] },
  )
  search(ownerId: string, dto: MemorySearchDto, lockVisibility?: OwnerLockVisibility[]) {
    return (
      this.searchBuilderWithLocks(ownerId, dto, lockVisibility)
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .selectAll('asset')
              .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
              .whereRef('memory_asset.memoriesId', '=', 'memory.id')
              .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
              .where('asset.deletedAt', 'is', null)
              .$if(!!lockVisibility?.length, (qb) => withLockVisibility(qb, this.db, lockVisibility!))
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('asset_face')
                      .innerJoin('person', (join) =>
                        join
                          .onRef('person.personGroupId', '=', 'asset_face.personGroupId')
                          .onRef('person.ownerId', '=', 'asset.ownerId'),
                      )
                      .select((eb) => eb.val(1).as('one'))
                      .whereRef('asset_face.assetId', '=', 'asset.id')
                      .where('person.isHidden', '=', true),
                  ),
                ),
              )
              .orderBy('asset.fileCreatedAt', 'asc'),
          ).as('assets'),
        )
        .selectAll('memory')
        .$call((qb) => {
          if (dto.order === AssetOrderWithRandom.Random) {
            return qb.orderBy(sql`RANDOM()`);
          }

          const direction = (dto.order?.toLowerCase() || 'desc') as OrderByDirection;
          return qb
            .orderBy('showAt', (ob) => (direction === 'asc' ? ob.asc() : ob.desc()).nullsLast())
            .orderBy('memoryAt', direction);
        })
        .$if(dto.id !== undefined, (qb) => qb.where('id', '=', dto.id!))
        .$if(dto.size !== undefined, (qb) => qb.limit(dto.size!))
        .$if(dto.page !== undefined && dto.size !== undefined, (qb) => qb.offset((dto.page! - 1) * dto.size!))
        // Embedded lock-visibility subqueries rely on the root query for join deduplication.
        .$if(!!lockVisibility?.length, (qb) => qb.withPlugin(joinDeduplicationPlugin))
        .execute()
    );
  }

  /**
   * Fork (d6d094738 lock audit): the birthday-memory candidates. Generated by the memory job, so `lockVisibility`
   * must be the owner's entries computed with no reveal set and no elevation - assets hidden by the owner's album or
   * folder locks never seed a memory (the memory data carries the person's name).
   */
  private personAssets(ownerId: string, personGroupId: string, lockVisibility: OwnerLockVisibility[]) {
    return this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_face')
            .whereRef('asset_face.assetId', '=', 'asset.id')
            .where('asset_face.personGroupId', '=', personGroupId)
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', 'is', true),
        ),
      )
      .where((eb) =>
        eb.exists((qb) =>
          qb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .$call((qb) => withLockVisibility(qb, this.db, lockVisibility))
      .$if(lockVisibility.length > 0, (qb) => qb.withPlugin(joinDeduplicationPlugin));
  }

  @GenerateSql({
    params: [DummyValue.UUID, DummyValue.UUID, { year: 2000, month: 1, day: 1 }, { year: 2025, month: 1, day: 1 }, []],
  })
  async getPersonBirthdayYears(
    ownerId: string,
    personGroupId: string,
    birthDate: YearMonthDay,
    until: YearMonthDay,
    lockVisibility: OwnerLockVisibility[],
  ): Promise<number[]> {
    const rows = await this.personAssets(ownerId, personGroupId, lockVisibility)
      .where(sql`date_part('month', (asset."localDateTime" at time zone 'UTC')::date)::int`, '=', birthDate.month)
      .where(sql`date_part('day', (asset."localDateTime" at time zone 'UTC')::date)::int`, '=', birthDate.day)
      .where((eb) => eb(sql`(asset."localDateTime" at time zone 'UTC')::date`, '>=', asMakeDate(eb, birthDate)))
      .where((eb) => eb(sql`(asset."localDateTime" at time zone 'UTC')::date`, '<', asMakeDate(eb, until)))
      .select(sql<number>`date_part('year', (asset."localDateTime" at time zone 'UTC')::date)::int`.as('year'))
      .distinct()
      .orderBy(sql`year`, 'desc')
      .execute();

    return rows.map(({ year }) => year);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { year: 2000, month: 1, day: 1 }, 5, []] })
  getPersonAssetsByDate(
    ownerId: string,
    personGroupId: string,
    date: YearMonthDay,
    limit: number,
    lockVisibility: OwnerLockVisibility[],
  ) {
    return this.personAssets(ownerId, personGroupId, lockVisibility)
      .select(['asset.id'])
      .where((eb) => eb(sql`(asset."localDateTime" at time zone 'UTC')::date`, '=', asMakeDate(eb, date)))
      .orderBy('asset.localDateTime', 'desc')
      .limit(limit)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string, lockVisibility?: OwnerLockVisibility[]) {
    return this.getByIdBuilder(id, lockVisibility).executeTakeFirst();
  }

  async create(memory: Insertable<MemoryTable>, assetIds: Set<string>) {
    const id = await this.db.transaction().execute(async (tx) => {
      const { id } = await tx.insertInto('memory').values(memory).returning('id').executeTakeFirstOrThrow();

      if (assetIds.size > 0) {
        const values = [...assetIds].map((assetId) => ({ memoriesId: id, assetId }));
        await tx.insertInto('memory_asset').values(values).execute();
      }

      return id;
    });

    return this.getByIdBuilder(id).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, { ownerId: DummyValue.UUID, isSaved: true }] })
  async update(id: string, memory: Updateable<MemoryTable>, lockVisibility?: OwnerLockVisibility[]) {
    await this.db.updateTable('memory').set(memory).where('id', '=', id).execute();
    return this.getByIdBuilder(id, lockVisibility).executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('memory').where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return new Set<string>();
    }

    const results = await this.db
      .selectFrom('memory_asset')
      .select(['assetId'])
      .where('memoriesId', '=', id)
      .where('assetId', 'in', assetIds)
      .execute();

    return new Set(results.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('memory_asset')
      .values(assetIds.map((assetId) => ({ memoriesId: id, assetId })))
      .execute();
  }

  @Chunked({ paramIndex: 1 })
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async removeAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('memory_asset').where('memoriesId', '=', id).where('assetId', 'in', assetIds).execute();
  }

  private getByIdBuilder(id: string, lockVisibility?: OwnerLockVisibility[]) {
    return (
      this.db
        .selectFrom('memory')
        .selectAll('memory')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .selectAll('asset')
              .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
              .whereRef('memory_asset.memoriesId', '=', 'memory.id')
              .orderBy('asset.fileCreatedAt', 'asc')
              .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
              .where('asset.deletedAt', 'is', null)
              .$if(!!lockVisibility?.length, (qb) => withLockVisibility(qb, this.db, lockVisibility!)),
          ).as('assets'),
        )
        .where('id', '=', id)
        .where('deletedAt', 'is', null)
        // Embedded lock-visibility subqueries rely on the root query for join deduplication.
        .$if(!!lockVisibility?.length, (qb) => qb.withPlugin(joinDeduplicationPlugin))
    );
  }
}
