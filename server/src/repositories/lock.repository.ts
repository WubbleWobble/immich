import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import {
  OwnerLockVisibility,
  anyUuid,
  joinDeduplicationPlugin,
  lockVisibilityExpression,
  withLockVisibility,
} from 'src/utils/database.js';
import {
  LockVisibilityRequest,
  RevealedLocks,
  anyHasLocksQuery,
  getHiddenAlbumIdsQuery,
  getHiddenContainerIdsQuery,
  getLockHolderVisibility,
  getOwnerLockVisibility,
  hasAnyLocksQuery,
  isAlbumHiddenForViewerQuery,
  isContainerHiddenForViewerQuery,
  subtreeContainsHiddenContentQuery,
} from 'src/utils/lock-visibility.js';

/**
 * Per-user lock state for albums and album containers (folders). Rows are pure per-user
 * presentation state: they never affect what OTHER users can see, only what their owner's
 * own queries return. See ../immich-specs/2026-05-24-locked-albums-and-folders-design.md.
 */
@Injectable()
export class LockRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async lockAlbum(userId: string, albumId: string): Promise<void> {
    await this.db
      .insertInto('locked_album')
      .values({ userId, albumId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async unlockAlbum(userId: string, albumId: string): Promise<void> {
    await this.db.deleteFrom('locked_album').where('userId', '=', userId).where('albumId', '=', albumId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async lockContainer(userId: string, containerId: string): Promise<void> {
    await this.db
      .insertInto('locked_container')
      .values({ userId, containerId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async unlockContainer(userId: string, containerId: string): Promise<void> {
    await this.db
      .deleteFrom('locked_container')
      .where('userId', '=', userId)
      .where('containerId', '=', containerId)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLocks(userId: string): Promise<{ lockedAlbumIds: string[]; lockedContainerIds: string[] }> {
    const [albums, containers] = await Promise.all([
      this.db.selectFrom('locked_album').select('albumId').where('userId', '=', userId).execute(),
      this.db.selectFrom('locked_container').select('containerId').where('userId', '=', userId).execute(),
    ]);
    return {
      lockedAlbumIds: albums.map(({ albumId }) => albumId),
      lockedContainerIds: containers.map(({ containerId }) => containerId),
    };
  }

  /**
   * Fast path for the visibility filter: a user with zero lock rows pays nothing.
   */
  hasAnyLocks(userId: string): Promise<boolean> {
    return hasAnyLocksQuery(this.db, userId);
  }

  /** Batched fast path (ruling R56): whether any of `userIds` holds a lock row. */
  anyHasLocks(userIds: string[]): Promise<boolean> {
    return anyHasLocksQuery(this.db, userIds);
  }

  /** See getHiddenAlbumIdsQuery in utils/lock-visibility.ts - the single source of truth. */
  getHiddenAlbumIds(userId: string, revealed: RevealedLocks): Promise<string[]> {
    return getHiddenAlbumIdsQuery(this.db, userId, revealed);
  }

  /** See getHiddenContainerIdsQuery in utils/lock-visibility.ts. */
  getHiddenContainerIds(userId: string, revealedContainerIds: string[]): Promise<string[]> {
    return getHiddenContainerIdsQuery(this.db, userId, revealedContainerIds);
  }

  /**
   * Per-owner visibility entries for withLockVisibility(). Compute once per request and
   * thread through the query options.
   */
  getOwnerLockVisibility(request: LockVisibilityRequest): Promise<OwnerLockVisibility[]> {
    return getOwnerLockVisibility(this.db, request);
  }

  /**
   * Fork (ruling R71): lock entries in job context (own locks, no reveal, no elevation) for `ownerIds`, or for every
   * lock holder when omitted. See getLockHolderVisibility in utils/lock-visibility.ts.
   */
  getLockHolderVisibility(ownerIds?: string[]): Promise<OwnerLockVisibility[]> {
    return getLockHolderVisibility(this.db, ownerIds);
  }

  /** Whether one asset passes the given per-owner lock entries (an empty list passes everything that exists). */
  @GenerateSql({ params: [DummyValue.UUID, []] })
  async isAssetVisible(assetId: string, entries: OwnerLockVisibility[]): Promise<boolean> {
    const row = await withLockVisibility(
      this.db.selectFrom('asset').select(sql.lit(1).as('one')).where('asset.id', '=', assetId),
      this.db,
      entries,
    )
      .withPlugin(joinDeduplicationPlugin)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The subset of `assetIds` that passes the given per-owner lock entries (an empty list passes everything that
   * exists). Batched counterpart of isAssetVisible.
   */
  async getVisibleAssetIds(assetIds: string[], entries: OwnerLockVisibility[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }
    const rows = await withLockVisibility(
      this.db.selectFrom('asset').select('asset.id').where('asset.id', '=', anyUuid(assetIds)),
      this.db,
      entries,
    )
      .withPlugin(joinDeduplicationPlugin)
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  /**
   * Fork (ruling R56): the list rule for Live Photo motion parts - the subset of `motionIds` that passes `entries`
   * (each judged as the 7A.2 Live Photo unit under its owner's entry), or whose still sits in one of
   * `grantedAlbumIds` (the list's album arm, which reaches a motion part through its still). One query; callers skip
   * it when `entries` is empty.
   */
  async getVisibleMotionIds(
    motionIds: string[],
    entries: OwnerLockVisibility[],
    grantedAlbumIds: string[] = [],
  ): Promise<Set<string>> {
    if (motionIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', anyUuid(motionIds))
      .where((eb) =>
        eb.or([
          entries.length > 0 ? lockVisibilityExpression(eb, this.db, entries) : eb.lit(true),
          ...(grantedAlbumIds.length > 0
            ? [
                eb.exists(
                  eb
                    .selectFrom('asset as still')
                    .innerJoin('album_asset', 'album_asset.assetId', 'still.id')
                    .innerJoin('album', (join) =>
                      join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
                    )
                    .select('still.id')
                    .whereRef('still.livePhotoVideoId', '=', 'asset.id')
                    .where('still.deletedAt', 'is', null)
                    .where('album_asset.albumId', '=', anyUuid(grantedAlbumIds)),
                ),
              ]
            : []),
        ]),
      )
      .withPlugin(joinDeduplicationPlugin)
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  /**
   * Owners of the given assets (deleted or not), with whether the owner shares their library with `viewerId` as a
   * partner - the asset relationships under which a viewer may legitimately learn that an asset is lock-hidden.
   */
  async getAssetOwners(
    viewerId: string,
    assetIds: string[],
  ): Promise<{ id: string; ownerId: string; isPartner: boolean }[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('asset')
      .select((eb) => [
        'asset.id',
        'asset.ownerId',
        eb
          .exists(
            eb
              .selectFrom('partner')
              .select('partner.sharedById')
              .whereRef('partner.sharedById', '=', 'asset.ownerId')
              .where('partner.sharedWithId', '=', viewerId),
          )
          .as('isPartner'),
      ])
      .where('asset.id', '=', anyUuid(assetIds))
      .execute();
    return rows.map(({ id, ownerId, isPartner }) => ({ id, ownerId, isPartner: !!isPartner }));
  }

  isAlbumHiddenForViewer(viewerId: string, albumId: string): Promise<boolean> {
    return isAlbumHiddenForViewerQuery(this.db, viewerId, albumId);
  }

  /** `db` lets a folder-structure mutation judge visibility inside its locked transaction. */
  subtreeContainsHiddenContent(userId: string, containerId: string, db: Kysely<DB> = this.db): Promise<boolean> {
    return subtreeContainsHiddenContentQuery(db, userId, containerId);
  }

  /** `db` lets a folder-structure mutation judge visibility inside its locked transaction. */
  isContainerHiddenForViewer(viewerId: string, containerId: string, db: Kysely<DB> = this.db): Promise<boolean> {
    return isContainerHiddenForViewerQuery(db, viewerId, containerId);
  }
}
