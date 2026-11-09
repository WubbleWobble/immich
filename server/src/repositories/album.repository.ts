import { Injectable } from '@nestjs/common';
import {
  type ExpressionBuilder,
  type Insertable,
  type Kysely,
  type NotNull,
  type Selectable,
  type ShallowDehydrateObject,
  type Updateable,
  sql,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { Chunked, ChunkedArray, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserCreateDto, MapAlbumDto } from 'src/dtos/album.dto.js';
import { toEvaluableSmartAlbumFilter } from 'src/dtos/smart-album-filter.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { asUuid, dummy, searchAssetBuilderLegacy, withDefaultVisibility } from 'src/utils/database.js';

export interface AlbumAssetCount {
  albumId: string;
  assetCount: number;
  startDate: Date | null;
  endDate: Date | null;
  lastModifiedAssetTimestamp: Date | null;
}

export interface AlbumInfoOptions {
  withAssets: boolean;
}

const withAlbumUsers = (authUserId?: string) => (eb: ExpressionBuilder<DB, 'album'>) =>
  jsonArrayFrom(
    eb
      .selectFrom('album_user')
      .innerJoin('user', 'user.id', 'album_user.userId')
      .whereRef('album_user.albumId', '=', 'album.id')
      .select('album_user.role')
      .select((eb) => jsonObjectFrom(eb.selectFrom(dummy).select(columns.user)).$notNull().as('user'))
      .orderBy('album_user.role')
      .$if(!!authUserId, (qb) => qb.orderBy((eb) => eb('album_user.userId', '=', authUserId!), 'desc'))
      .orderBy('user.name', 'asc'),
  )
    .$notNull()
    .as('albumUsers');

/**
 * Fork (review T4): the requesting user's effective role on the album - the strongest of their direct album_user role
 * and any album_container_user role on an ancestor folder (through the closure; the cascade rule of
 * buildAlbumBaseQuery), ranked owner > editor > viewer; null without a viewer or when they hold no role. Only the role
 * is exposed, never the folder share graph.
 */
const withViewerRole = (authUserId?: string) => (eb: ExpressionBuilder<DB, 'album'>) => {
  if (!authUserId) {
    return sql<AlbumUserRole | null>`null`.as('viewerRole');
  }
  return eb
    .selectFrom(
      eb
        .selectFrom('album_user')
        .select('album_user.role')
        .whereRef('album_user.albumId', '=', 'album.id')
        .where('album_user.userId', '=', authUserId)
        .union(
          eb
            .selectFrom('album_container_closure as c')
            .innerJoin('album_container_user as acu', 'acu.albumContainerId', 'c.id_ancestor')
            .select('acu.role')
            .whereRef('c.id_descendant', '=', 'album.containerId')
            .where('acu.userId', '=', authUserId),
        )
        .as('viewer_role'),
    )
    .select('viewer_role.role')
    .orderBy(
      sql`case ${sql.ref('viewer_role.role')} when ${sql.lit(AlbumUserRole.Owner)} then 0 when ${sql.lit(AlbumUserRole.Editor)} then 1 else 2 end`,
    )
    .limit(1)
    .$castTo<AlbumUserRole | null>()
    .as('viewerRole');
};

const withSharedLink = (eb: ExpressionBuilder<DB, 'album'>) =>
  jsonArrayFrom(
    eb.selectFrom('shared_link').selectAll('shared_link').whereRef('shared_link.albumId', '=', 'album.id'),
  ).as('sharedLinks');

const withAssets = (eb: ExpressionBuilder<DB, 'album'>) => {
  return eb
    .selectFrom((eb) =>
      eb
        .selectFrom('asset')
        .selectAll('asset')
        .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .select((eb) =>
          eb.table('asset_exif').$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>().as('exifInfo'),
        )
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .whereRef('album_asset.albumId', '=', 'album.id')
        .where('asset.deletedAt', 'is', null)
        .$call(withDefaultVisibility)
        .orderBy('asset.fileCreatedAt', 'desc')
        .as('asset'),
    )
    .select((eb) => eb.fn.jsonAgg('asset').as('assets'))
    .as('assets');
};

/**
 * Invalidates a smart-album cache: `cacheRevision` is incremented by the statement itself, never set from a value
 * read into JS, so concurrent invalidations cannot collapse. `cacheInvalidatedAt` is for display/debugging only.
 */
const bumpCacheRevision = (eb: ExpressionBuilder<DB, 'album'>) => ({
  cacheRevision: eb('album.cacheRevision', '+', sql.lit(1)),
  cacheInvalidatedAt: sql<Date>`now()`,
});

const isAlbumOwned = (ownerId: string) => (eb: ExpressionBuilder<DB, 'album'>) =>
  eb.exists(
    eb
      .selectFrom('album_user')
      .whereRef('album_user.albumId', '=', 'album.id')
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .where('album_user.userId', '=', ownerId),
  );

@Injectable()
export class AlbumRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, { withAssets: true }, DummyValue.UUID] })
  getById(id: string, options: AlbumInfoOptions, authUserId?: string) {
    return this.db
      .with('album_user', (qb) => qb.selectFrom('album_user').selectAll().where('album_user.albumId', '=', id))
      .selectFrom('album')
      .selectAll('album')
      .where('album.id', '=', id)
      .where('album.deletedAt', 'is', null)
      .select(withAlbumUsers(authUserId))
      .select(withViewerRole(authUserId))
      .select(withSharedLink)
      .$if(options.withAssets, (eb) => eb.select(withAssets))
      .$narrowType<{ assets: NotNull }>()
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getByAssetId(ownerId: string, assetId: string) {
    return this.db
      .selectFrom('album')
      .selectAll('album')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', '=', assetId)
      .where('album.deletedAt', 'is', null)
      .select(withAlbumUsers(ownerId))
      .select(withViewerRole(ownerId))
      .orderBy('album.createdAt', 'desc')
      .execute();
  }

  /**
   * Viewer-visible regular-album memberships (direct share or folder cascade) for a batch
   * of assets, as (assetId, albumId) rows. Powers the server-side locked-album move: the
   * assets' other memberships must be removed or the lock never bites.
   */
  @Chunked({ paramIndex: 1 })
  async getVisibleMembershipsByAssetIds(
    ownerId: string,
    assetIds: string[],
  ): Promise<{ assetId: string; albumId: string }[]> {
    if (assetIds.length === 0) {
      return [];
    }
    return this.buildAlbumBaseQuery(ownerId, {})
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where('album_asset.assetId', 'in', assetIds)
      .select(['album_asset.assetId as assetId', 'album.id as albumId'])
      .execute();
  }

  /**
   * Smart albums reachable by the user (directly or via folder share) whose filter matches
   * the asset. Smart membership is computed, so getByAssetId's album_asset join cannot see
   * it; callers merging the two get the complete "appears in" answer - which the locked
   * "move" flow needs to know an unlocked saved search still rescues the asset.
   */
  async getMatchingSmartAlbumsByAssetId(ownerId: string, assetId: string): Promise<MapAlbumDto[]> {
    const candidates = await this.buildAlbumBaseQuery(ownerId, {})
      .innerJoin('album_user as owner', (join) =>
        join.onRef('owner.albumId', '=', 'album.id').on('owner.role', '=', sql.lit(AlbumUserRole.Owner)),
      )
      .select(['album.id', 'album.filter', 'owner.userId as albumOwnerId'])
      .where('album.kind', '=', AlbumKind.Smart)
      .where('album.filter', 'is not', null)
      .execute();

    const matchingIds: string[] = [];
    for (const candidate of candidates) {
      // Fail closed: an unevaluable filter matches nothing.
      const filter = candidate.filter ? toEvaluableSmartAlbumFilter(candidate.filter) : null;
      if (!filter) {
        continue;
      }
      const match = await searchAssetBuilderLegacy(this.db, { ...filter, userIds: [candidate.albumOwnerId] })
        .select('asset.id')
        .where((eb) => eb.or([eb('asset.id', '=', assetId), eb('asset.livePhotoVideoId', '=', assetId)]))
        .limit(1)
        .executeTakeFirst();
      if (match) {
        matchingIds.push(candidate.id);
      }
    }
    if (matchingIds.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('album')
      .selectAll('album')
      .select(withAlbumUsers(ownerId))
      .select(withViewerRole(ownerId))
      .where('album.id', 'in', matchingIds)
      .where('album.deletedAt', 'is', null)
      .orderBy('album.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getByAssetIds(ownerId: string, assetIds: string[]): Promise<Map<string, string[]>> {
    if (assetIds.length === 0) {
      return new Map();
    }

    const results = await this.db
      .selectFrom('album')
      .select('album.id')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', 'in', assetIds)
      .where('album.deletedAt', 'is', null)
      .select('album_asset.assetId')
      .execute();

    // Group by assetId
    const map = new Map<string, string[]>();
    for (const row of results) {
      const existing = map.get(row.assetId) ?? [];
      existing.push(row.id);
      map.set(row.assetId, existing);
    }

    return map;
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  async getMetadataForIds(ids: string[]): Promise<AlbumAssetCount[]> {
    // Guard against running invalid query when ids list is empty.
    if (ids.length === 0) {
      return [];
    }

    return (
      this.db
        .selectFrom('asset')
        .$call(withDefaultVisibility)
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .select('album_asset.albumId as albumId')
        .select((eb) => eb.fn.min(sql<Date>`("asset"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('startDate'))
        .select((eb) => eb.fn.max(sql<Date>`("asset"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('endDate'))
        // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
        .select((eb) => eb.fn.max('asset.updatedAt').as('lastModifiedAssetTimestamp'))
        .select((eb) => sql<number>`${eb.fn.count('asset.id')}::int`.as('assetCount'))
        .where('album_asset.albumId', 'in', ids)
        .where('asset.deletedAt', 'is', null)
        .groupBy('album_asset.albumId')
        .execute()
    );
  }

  private buildAlbumBaseQuery(ownerId: string, { isOwned, isShared }: { isOwned?: boolean; isShared?: boolean }) {
    return this.db
      .selectFrom('album')
      .where('album.deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          // Direct album_user membership (any role).
          eb.exists(
            eb
              .selectFrom('album_user')
              .whereRef('album_user.albumId', '=', 'album.id')
              .where('album_user.userId', '=', ownerId),
          ),
          // Cascade folder share resolution: any ancestor folder of this album's container shared
          // with the user grants access to this album. This same rule is encoded in:
          //   - album-container.repository.ts (getForUser cascade EXISTS)
          //   - access.repository.ts (AlbumAccess.checkSharedAlbumAccess cascade EXISTS)
          // Keep semantics in sync if you change one; consider extracting to a shared SQL builder
          // if a fourth call site is needed.
          eb.exists(
            eb
              .selectFrom('album_container_closure as c')
              .innerJoin('album_container_user as acu', 'acu.albumContainerId', 'c.id_ancestor')
              .whereRef('c.id_descendant', '=', 'album.containerId')
              .where('acu.userId', '=', ownerId),
          ),
        ]),
      )
      .$if(isOwned === true, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom('album_user')
              .whereRef('album_user.albumId', '=', 'album.id')
              .where('album_user.userId', '=', ownerId)
              .where('album_user.role', '=', sql.lit(AlbumUserRole.Owner)),
          ),
        ),
      )
      .$if(isOwned === false, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('album_user')
                .whereRef('album_user.albumId', '=', 'album.id')
                .where('album_user.userId', '=', ownerId)
                .where('album_user.role', '=', sql.lit(AlbumUserRole.Owner)),
            ),
          ),
        ),
      )
      .$if(isShared !== undefined, (qb) =>
        qb.where((eb) => {
          const isSharedAlbum = eb.or([
            eb.exists(
              eb
                .selectFrom('album_user as au')
                .whereRef('au.albumId', '=', 'album.id')
                .where('au.role', '!=', sql.lit(AlbumUserRole.Owner)),
            ),
            eb.exists(eb.selectFrom('shared_link').whereRef('shared_link.albumId', '=', 'album.id')),
            // Cascade shares make the album "shared" from the user's perspective.
            eb.exists(
              eb
                .selectFrom('album_container_closure as c')
                .innerJoin('album_container_user as acu', 'acu.albumContainerId', 'c.id_ancestor')
                .whereRef('c.id_descendant', '=', 'album.containerId'),
            ),
          ]);
          return isShared ? isSharedAlbum : eb.not(isSharedAlbum);
        }),
      );
  }

  @GenerateSql({ params: [DummyValue.UUID, { isOwned: true, isShared: true }] })
  getAll(
    ownerId: string,
    options: { id?: string; isOwned?: boolean; isShared?: boolean; name?: string } = {},
  ): Promise<MapAlbumDto[]> {
    return this.buildAlbumBaseQuery(ownerId, options)
      .selectAll('album')
      .select(withAlbumUsers(ownerId))
      .select(withViewerRole(ownerId))
      .select(withSharedLink)
      .$if(!!options.id, (qb) => qb.where('album.id', '=', options.id!))
      .$if(!!options.name, (qb) => qb.where('album.albumName', '=', options.name!))
      .orderBy('album.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { isOwned: true, isShared: true }] })
  async getAllIds(ownerId: string, options: { isOwned?: boolean; isShared?: boolean } = {}): Promise<string[]> {
    const rows = await this.buildAlbumBaseQuery(ownerId, options)
      .select('album.id')
      .orderBy('album.createdAt', 'desc')
      .execute();
    return rows.map((r) => r.id);
  }

  async restoreAll(userId: string): Promise<void> {
    // Invalidation skips soft-deleted albums, so a restored smart album's cache may have missed changes.
    await this.db
      .updateTable('album')
      .set({ deletedAt: null })
      .set(bumpCacheRevision)
      .where(isAlbumOwned(userId))
      .execute();
  }

  async softDeleteAll(userId: string): Promise<void> {
    await this.db.updateTable('album').set({ deletedAt: new Date() }).where(isAlbumOwned(userId)).execute();
  }

  async deleteAll(userId: string): Promise<void> {
    await this.db.deleteFrom('album').where(isAlbumOwned(userId)).execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async removeAssetsFromAll(assetIds: string[]): Promise<void> {
    await this.db.deleteFrom('album_asset').where('album_asset.assetId', 'in', assetIds).execute();
  }

  @Chunked({ paramIndex: 1 })
  async removeAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('album_asset')
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.assetId', 'in', assetIds)
      .execute();
  }

  /**
   * Get asset IDs for the given album ID.
   *
   * @param albumId Album ID to get asset IDs for.
   * @param assetIds Optional list of asset IDs to filter on.
   * @returns Set of Asset IDs for the given album ID.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getAssetIds(albumId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    return this.db
      .selectFrom('album_asset')
      .selectAll()
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.assetId', 'in', assetIds)
      .execute()
      .then((results) => new Set(results.map(({ assetId }) => assetId)));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('album_asset')
      .expression((eb) =>
        eb.selectFrom(dummy).select([asUuid(albumId).as('albumId'), sql`unnest(${assetIds}::uuid[])`.as('assetId')]),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({
    params: [
      { albumName: DummyValue.STRING },
      [],
      [{ userId: DummyValue.UUID, role: AlbumUserRole.Owner }, DummyValue.UUID],
    ],
  })
  async create(
    album: Insertable<AlbumTable>,
    assetIds: string[],
    albumUsers: AlbumUserCreateDto[],
    authUserId: string,
    // A placement into a folder passes its folder-structure transaction (AlbumContainerRepository).
    db: Kysely<DB> = this.db,
  ) {
    if (albumUsers.every((u) => u.role !== AlbumUserRole.Owner)) {
      throw new Error('Album must have an owner');
    }

    const userIds = albumUsers.map((u) => u.userId);
    const roles = albumUsers.map((u) => u.role);

    const result = await db
      .with('album', (db) => db.insertInto('album').values(album).returningAll())
      .with('album_user', (db) =>
        db
          .insertInto('album_user')
          .expression((eb) =>
            eb
              .selectFrom('album')
              .select(({ ref }) => [
                ref('album.id').as('albumId'),
                sql`unnest(${userIds}::uuid[])`.as('userId'),
                sql`unnest(${roles}::album_user_role_enum[])`.as('role'),
              ]),
          )
          .returning(['album_user.albumId', 'album_user.userId', 'album_user.role']),
      )
      .with('album_asset', (db) =>
        db
          .insertInto('album_asset')
          .expression((eb) =>
            eb
              .selectFrom('album')
              .select(({ ref }) => [ref('album.id').as('albumId'), sql`unnest(${assetIds}::uuid[])`.as('assetId')]),
          )
          .onConflict((oc) => oc.doNothing())
          .returning(['album_asset.albumId', 'album_asset.assetId']),
      )
      .selectFrom('album')
      .selectAll('album')
      .select(withAlbumUsers(authUserId))
      .select(withViewerRole(authUserId))
      .select(withAssets)
      .$narrowType<{ assets: NotNull }>()
      .executeTakeFirstOrThrow();

    return result;
  }

  /** A move into or out of a folder passes its folder-structure transaction (AlbumContainerRepository). */
  update(id: string, album: Updateable<AlbumTable>, authUserId: string, db: Kysely<DB> = this.db) {
    return (
      db
        .updateTable('album')
        .set(album)
        // A filter write invalidates the smart-album cache in the same statement, so a recompute that reads
        // (filter, cacheRevision) together never sees the new filter under the old revision.
        .$if(album.filter !== undefined, (qb) => qb.set(bumpCacheRevision))
        .where('album.id', '=', id)
        .returningAll('album')
        .returning(withSharedLink)
        .returning(withAlbumUsers(authUserId))
        .returning(withViewerRole(authUserId))
        .executeTakeFirstOrThrow()
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('album').where('id', '=', id).execute();
  }

  @Chunked({ chunkSize: 30_000 })
  async addAssetIdsToAlbums(values: { albumId: string; assetId: string }[]): Promise<void> {
    if (values.length === 0) {
      return;
    }
    await this.db
      .insertInto('album_asset')
      .values(values)
      // Allow idempotent album sync without failing on existing album memberships.
      .onConflict((oc) => oc.columns(['albumId', 'assetId']).doNothing())
      .execute();
  }

  /**
   * Makes sure all thumbnails for albums are updated by:
   * - Removing thumbnails from albums without assets
   * - Removing references of thumbnails to assets outside the album
   * - Setting a thumbnail when none is set and the album contains assets
   *
   * @returns Amount of updated album thumbnails or undefined when unknown
   */
  async updateThumbnails(): Promise<number | undefined> {
    // Subquery for getting a new thumbnail.

    const result = await this.db
      .updateTable('album')
      .set((eb) => ({
        albumThumbnailAssetId: this.updateThumbnailBuilder(eb)
          .select('album_asset.assetId')
          .orderBy('asset.fileCreatedAt', 'desc')
          .limit(sql.lit(1)),
      }))
      .where((eb) =>
        eb.or([
          eb.and([
            eb('albumThumbnailAssetId', 'is', null),
            eb.exists(this.updateThumbnailBuilder(eb).select(sql`1`.as('1'))), // Has assets
          ]),
          eb.and([
            eb('albumThumbnailAssetId', 'is not', null),
            eb.not(
              eb.exists(
                this.updateThumbnailBuilder(eb)
                  .select(sql`1`.as('1'))
                  .whereRef('album.albumThumbnailAssetId', '=', 'album_asset.assetId'), // Has invalid assets
              ),
            ),
          ]),
        ]),
      )
      .execute();

    return Number(result[0].numUpdatedRows);
  }

  private updateThumbnailBuilder(eb: ExpressionBuilder<DB, 'album'>) {
    return eb
      .selectFrom('album_asset')
      .innerJoin('asset', (join) =>
        join.onRef('album_asset.assetId', '=', 'asset.id').on('asset.deletedAt', 'is', null),
      )
      .whereRef('album_asset.albumId', '=', 'album.id');
  }

  /**
   * Get per-user asset contribution counts for a single album.
   * Excludes deleted assets, orders by count desc.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getContributorCounts(id: string) {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'assetId')
      .where('asset.deletedAt', 'is', sql.lit(null))
      .where('album_asset.albumId', '=', id)
      .select('asset.ownerId as userId')
      .select((eb) => eb.fn.countAll<number>().as('assetCount'))
      .groupBy('asset.ownerId')
      .orderBy('assetCount', 'desc')
      .execute();
  }

  /**
   * Fork (D6): which of `albumIds` are smart albums. Search refuses smart albums as album filters (their membership
   * is computed, not stored in `album_asset`); callers check access first so the answer is never an oracle.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getSmartAlbumIds(albumIds: string[]): Promise<string[]> {
    if (albumIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('album')
      .select('album.id')
      .where('album.id', 'in', albumIds)
      .where('album.kind', '=', sql.lit(AlbumKind.Smart))
      .execute();
    return rows.map(({ id }) => id);
  }

  /**
   * Returns smart albums owned by `ownerId` (with their stored filter).
   * Used by smart-album cache invalidation.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getSmartAlbumsForOwner(ownerId: string) {
    return this.db
      .selectFrom('album')
      .select(['album.id', 'album.filter', 'album.cachedThumbnailAssetId'])
      .where('album.kind', '=', sql.lit(AlbumKind.Smart))
      .where('album.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.role', '=', sql.lit(AlbumUserRole.Owner))
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .execute();
  }

  /**
   * Returns the ids of smart albums owned by `ownerId` whose `filter.personIds` JSONB
   * array overlaps any of the given `personIds`. Used to narrowly invalidate caches when
   * persons are merged, without re-running a full per-asset filter check.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getSmartAlbumsForOwnerByPersonIds(ownerId: string, personIds: string[]): Promise<{ id: string }[]> {
    if (personIds.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('album')
      .select('album.id')
      .where('album.kind', '=', sql.lit(AlbumKind.Smart))
      .where('album.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.role', '=', sql.lit(AlbumUserRole.Owner))
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where(sql<boolean>`album.filter -> 'personIds' ?| ${personIds}::text[]`)
      .execute();
  }

  /**
   * Invalidate the smart-album cache of the given album ids: increment `cacheRevision` in SQL, so any recompute that
   * read an older revision can no longer publish (see `updateCachedMetadata`). `cacheInvalidatedAt` is display only.
   * No-op when `albumIds` is empty.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async markCacheInvalidated(albumIds: string[]): Promise<void> {
    if (albumIds.length === 0) {
      return;
    }
    await this.db.updateTable('album').set(bumpCacheRevision).where('album.id', 'in', albumIds).execute();
  }

  /**
   * Invalidate (see `markCacheInvalidated`) every active smart album whose stored `filter` JSONB contains a
   * `personIds` key, regardless of owner. Used by system-wide face-reset jobs (force-detect / force-recognize) where
   * every user's person-filtered smart album can be affected and the specific person ids are not known.
   */
  @GenerateSql()
  async markAllSmartAlbumsWithPersonFilterInvalidated(): Promise<void> {
    await this.db
      .updateTable('album')
      .set(bumpCacheRevision)
      .where('album.kind', '=', sql.lit(AlbumKind.Smart))
      .where('album.deletedAt', 'is', null)
      .where(sql<boolean>`album.filter ? 'personIds'`)
      .execute();
  }

  /**
   * The inputs of a smart-album cache recompute, read in ONE statement: the filter to evaluate, the owner whose
   * library it runs against, and the cache revision they belong to. Filter writes bump the revision in the same
   * UPDATE, so the pair is consistent. Undefined for a missing, deleted or non-smart album.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getSmartAlbumCacheSource(id: string) {
    return this.db
      .selectFrom('album')
      .leftJoin('album_user as owner', (join) =>
        join.onRef('owner.albumId', '=', 'album.id').on('owner.role', '=', sql.lit(AlbumUserRole.Owner)),
      )
      .select(['album.filter', 'album.cacheRevision', 'owner.userId as ownerId'])
      .where('album.id', '=', id)
      .where('album.kind', '=', sql.lit(AlbumKind.Smart))
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /**
   * Publish freshly computed smart-album list-view metadata, compare-and-set on the revision it was computed for:
   * the row is written (and marked fresh, `cachedRevision = revision`) only if no invalidation happened since.
   * Returns false when the result was superseded and therefore discarded.
   */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      0,
      { cachedAssetCount: 0, cachedThumbnailAssetId: null, cachedStartDate: null, cachedEndDate: null },
    ],
  })
  async updateCachedMetadata(
    id: string,
    revision: number,
    values: Pick<
      Updateable<AlbumTable>,
      'cachedAssetCount' | 'cachedThumbnailAssetId' | 'cachedStartDate' | 'cachedEndDate'
    >,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('album')
      .set({ ...values, cachedRevision: revision, cacheComputedAt: sql`now()` })
      .where('album.id', '=', id)
      .where('album.cacheRevision', '=', revision)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  @GenerateSql({ params: [{ sourceAssetId: DummyValue.UUID, targetAssetId: DummyValue.UUID }] })
  async copyAlbums({ sourceAssetId, targetAssetId }: { sourceAssetId: string; targetAssetId: string }) {
    return this.db
      .insertInto('album_asset')
      .expression((eb) =>
        eb
          .selectFrom('album_asset')
          .select((eb) => ['album_asset.albumId', eb.val(targetAssetId).as('assetId')])
          .where('album_asset.assetId', '=', sourceAssetId),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
