import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { anyUuid } from 'src/utils/database';

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
    await this.db
      .deleteFrom('locked_album')
      .where('userId', '=', userId)
      .where('albumId', '=', albumId)
      .execute();
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
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasAnyLocks(userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('locked_album')
      .select('albumId as id')
      .where('userId', '=', userId)
      .union((eb) => eb.selectFrom('locked_container').select('containerId as id').where('userId', '=', userId))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The user's effectively-hidden album ids: directly-locked albums (minus the revealed
   * set) plus every album living in a folder subtree whose root is locked (minus revealed
   * folders). Reveal subtraction happens BEFORE closure expansion, so revealing a parent
   * folder does not reveal a separately-locked descendant. Reveal sets are intersected with
   * the user's own lock rows by construction - foreign ids in the reveal set cannot reveal
   * anything.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID]] })
  async getHiddenAlbumIds(
    userId: string,
    revealedAlbumIds: string[],
    revealedContainerIds: string[],
  ): Promise<string[]> {
    const rows = await this.db
      .selectFrom('locked_album')
      .select('albumId as id')
      .where('userId', '=', userId)
      .where((eb) => eb.not(eb('albumId', '=', anyUuid(revealedAlbumIds))))
      .union((eb) =>
        eb
          .selectFrom('album')
          .select('album.id as id')
          .where('album.deletedAt', 'is', null)
          .where('album.containerId', 'in', (qb) =>
            qb
              .selectFrom('locked_container')
              .innerJoin(
                'album_container_closure',
                'album_container_closure.id_ancestor',
                'locked_container.containerId',
              )
              .select('album_container_closure.id_descendant')
              .where('locked_container.userId', '=', userId)
              .where((eb2) => eb2.not(eb2('locked_container.containerId', '=', anyUuid(revealedContainerIds)))),
          ),
      )
      .execute();
    return rows.map(({ id }) => id);
  }

  /**
   * The user's effectively-hidden container ids: locked folders (minus revealed) expanded
   * through the closure table to all descendants.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getHiddenContainerIds(userId: string, revealedContainerIds: string[]): Promise<string[]> {
    const rows = await this.db
      .selectFrom('locked_container')
      .innerJoin('album_container_closure', 'album_container_closure.id_ancestor', 'locked_container.containerId')
      .select('album_container_closure.id_descendant as id')
      .distinct()
      .where('locked_container.userId', '=', userId)
      .where((eb) => eb.not(eb('locked_container.containerId', '=', anyUuid(revealedContainerIds))))
      .execute();
    return rows.map(({ id }) => id);
  }
}
