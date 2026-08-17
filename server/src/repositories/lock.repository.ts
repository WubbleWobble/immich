import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { OwnerLockVisibility } from 'src/utils/database';
import {
  getHiddenAlbumIdsQuery,
  getHiddenContainerIdsQuery,
  getOwnerLockVisibility,
  hasAnyLocksQuery,
  LockVisibilityRequest,
  RevealedLocks,
} from 'src/utils/lock-visibility';

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
}
