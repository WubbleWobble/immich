import { Kysely } from 'kysely';
import { AlbumKind } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

const getRevisions = (ctx: ReturnType<typeof setup>['ctx'], albumId: string) =>
  ctx.database
    .selectFrom('album')
    .select(['cacheRevision', 'cachedRevision'])
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumRepository.name, () => {
  describe('getSmartAlbumsForOwnerByPersonIds', () => {
    it("finds the owner's smart albums by a person id that no longer exists (D12: ids dangle, not pruned)", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const deadId = newUuid();
      const liveId = newUuid();
      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [deadId, liveId] } as any,
      });
      await ctx.newAlbum({ ownerId: other.id, kind: AlbumKind.Smart, filter: { personIds: [deadId] } as any });
      await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { personIds: [newUuid()] } as any });

      await expect(sut.getSmartAlbumsForOwnerByPersonIds(user.id, [deadId])).resolves.toEqual([{ id: album.id }]);
    });
  });

  describe('smart album cache revision', () => {
    it('starts stale: revision 0, nothing published', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });

      await expect(getRevisions(ctx, album.id)).resolves.toEqual({ cacheRevision: 0, cachedRevision: null });
    });

    it('markCacheInvalidated increments the revision on every call', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });
      const { album: other } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { city: 'x' } });

      await sut.markCacheInvalidated([album.id]);
      await sut.markCacheInvalidated([album.id]);
      await sut.markCacheInvalidated([]);

      await expect(getRevisions(ctx, album.id)).resolves.toEqual({ cacheRevision: 2, cachedRevision: null });
      await expect(getRevisions(ctx, other.id)).resolves.toEqual({ cacheRevision: 0, cachedRevision: null });
    });

    it('markAllSmartAlbumsWithPersonFilterInvalidated increments only person-filtered smart albums', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album: byPerson } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [newUuid()] } as any,
      });
      const { album: byCity } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { city: 'x' } });

      await sut.markAllSmartAlbumsWithPersonFilterInvalidated();

      await expect(getRevisions(ctx, byPerson.id)).resolves.toMatchObject({ cacheRevision: 1 });
      await expect(getRevisions(ctx, byCity.id)).resolves.toMatchObject({ cacheRevision: 0 });
    });

    it('update bumps the revision in the same statement as a filter write, and only then', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });

      await sut.update(album.id, { albumName: 'renamed' }, user.id);
      await expect(getRevisions(ctx, album.id)).resolves.toMatchObject({ cacheRevision: 0 });

      const updated = await sut.update(album.id, { filter: { isFavorite: false } }, user.id);
      expect(updated).toMatchObject({ filter: { isFavorite: false }, cacheRevision: 1 });
    });

    it('restoreAll invalidates the restored albums (invalidation skipped them while soft-deleted)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });
      await sut.updateCachedMetadata(album.id, 0, {
        cachedAssetCount: 1,
        cachedThumbnailAssetId: null,
        cachedStartDate: null,
        cachedEndDate: null,
      });

      await sut.softDeleteAll(user.id);
      await sut.restoreAll(user.id);

      await expect(getRevisions(ctx, album.id)).resolves.toEqual({ cacheRevision: 1, cachedRevision: 0 });
    });

    it('getSmartAlbumCacheSource reads the filter, owner and revision of one row together', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });
      const { album: regular } = await ctx.newAlbum({ ownerId: user.id });
      await sut.markCacheInvalidated([album.id]);

      await expect(sut.getSmartAlbumCacheSource(album.id)).resolves.toEqual({
        filter: { isFavorite: true },
        ownerId: user.id,
        cacheRevision: 1,
      });
      await expect(sut.getSmartAlbumCacheSource(regular.id)).resolves.toBeUndefined();
    });

    it('updateCachedMetadata publishes only under the revision it was computed for', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });
      const values = { cachedAssetCount: 3, cachedThumbnailAssetId: null, cachedStartDate: null, cachedEndDate: null };

      await sut.markCacheInvalidated([album.id]);
      await expect(sut.updateCachedMetadata(album.id, 0, values), 'a superseded revision').resolves.toBe(false);
      await expect(getRevisions(ctx, album.id)).resolves.toEqual({ cacheRevision: 1, cachedRevision: null });

      await expect(sut.updateCachedMetadata(album.id, 1, values), 'the current revision').resolves.toBe(true);
      await expect(getRevisions(ctx, album.id)).resolves.toEqual({ cacheRevision: 1, cachedRevision: 1 });
    });
  });
});
