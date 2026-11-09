import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { LockService } from 'src/services/lock.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumContainerRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      LockRepository,
      SearchRepository,
      UserRepository,
    ],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const newSmartAlbum = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, extra = {}) => {
  const { album } = await ctx.newAlbum({
    ownerId,
    kind: AlbumKind.Smart,
    filter: { isFavorite: true },
    ...extra,
  });
  return album;
};

type Ctx = ReturnType<typeof setup>['ctx'];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/**
 * Counts smart-album recomputes (one searchStatistics call each) and can hold the next one after its searches ran
 * but before it publishes, so a test can land a concurrent change in that window.
 */
const watchRecomputes = (ctx: Ctx) => {
  const search = ctx.get(SearchRepository);
  const original = search.searchStatistics.bind(search);
  const spy = vi.spyOn(search, 'searchStatistics');
  return {
    count: () => spy.mock.calls.length,
    holdNext: () => {
      const reached = deferred();
      const released = deferred();
      spy.mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        reached.resolve();
        await released.promise;
        return result;
      });
      return { reached: reached.promise, release: released.resolve };
    },
  };
};

const getCacheState = (ctx: Ctx, albumId: string) =>
  ctx.database
    .selectFrom('album')
    .select([
      'cacheRevision',
      'cachedRevision',
      'cachedAssetCount',
      'cachedThumbnailAssetId',
      'cachedStartDate',
      'cachedEndDate',
    ])
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();

/** The asset count the Albums list shows `auth` for `albumId` (served from, or recomputed into, the cache). */
const listedAssetCount = async (sut: AlbumService, auth: AuthDto, albumId: string) => {
  const albums = await sut.getAll(auth, {});
  return albums.find(({ id }) => id === albumId)?.assetCount;
};

const takenAt = (day: string) => ({ fileCreatedAt: new Date(day), localDateTime: new Date(day) });

const favorite = (ctx: Ctx, assetId: string) =>
  ctx.database.updateTable('asset').set({ isFavorite: true }).where('id', '=', assetId).execute();

// The destination is the locked folder itself, or a folder below a locked ancestor.
const hiddenDestination = async (
  ctx: Ctx,
  ownerId: string,
  depth: 'locked parent' | 'descendant of a locked ancestor',
) => {
  const repository = ctx.get(AlbumContainerRepository);
  const locked = await repository.create({ ownerId, name: 'Locked', parentId: null });
  await ctx.get(LockRepository).lockContainer(ownerId, locked.id);
  return depth === 'locked parent' ? locked : repository.create({ ownerId, name: 'Inner', parentId: locked.id });
};

const albumsIn = (ctx: Ctx, containerId: string) =>
  ctx.database.selectFrom('album').select('id').where('containerId', '=', containerId).execute();

// Fork (review T4) fixtures: an album two folders below a shared folder, and the role both album reads report.
const newFolderAlbum = async (ctx: Ctx) => {
  const { user: owner } = await ctx.newUser();
  const { user: sharee } = await ctx.newUser();
  const folders = ctx.get(AlbumContainerRepository);
  const parent = await folders.create({ ownerId: owner.id, name: 'Shared', parentId: null });
  const child = await folders.create({ ownerId: owner.id, name: 'Inner', parentId: parent.id });
  const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: child.id });
  return { owner, sharee, album, parent, folders };
};
const roleSeenBy = async (sut: AlbumService, user: { id: string }, albumId: string) => {
  const auth = factory.auth({ user });
  const single = await sut.get(auth, albumId);
  const albums = await sut.getAll(auth, {});
  const listed = albums.find(({ id }) => id === albumId);
  expect(listed?.viewerRole).toEqual(single.viewerRole);
  return single.viewerRole;
};

describe(AlbumService.name, () => {
  describe('removeAssets', () => {
    it('should not remove assets from an album of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      await expect(sut.removeAssets(factory.auth({ user: otherUser }), album.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no albumAsset.delete access',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('permissions for fork features', () => {
    it('editor can rename a smart album', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const album = await newSmartAlbum(ctx, owner.id);
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });

      const updated = await sut.update(factory.auth({ user: editor }), album.id, {
        albumName: 'Renamed',
        description: 'New description',
      });

      expect(updated.albumName).toBe('Renamed');
      expect(updated.description).toBe('New description');
    });

    it('editor cannot change a smart album filter', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const album = await newSmartAlbum(ctx, owner.id);
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });

      await expect(
        sut.update(factory.auth({ user: editor }), album.id, {
          filter: { isFavorite: false, visibility: AssetVisibility.Archive },
        }),
      ).rejects.toThrow('Only the album owner can update a smart album filter');
    });

    it("editor cannot move another owner's album into a folder", async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: owner.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
      const folder = await ctx
        .get(AlbumContainerRepository)
        .create({ ownerId: editor.id, name: 'Mine', parentId: null });

      await expect(sut.update(factory.auth({ user: editor }), album.id, { containerId: folder.id })).rejects.toThrow(
        'Only the album owner can move it to a folder',
      );
    });

    it('elevated sharee can lock a shared album for their own view only', async () => {
      const { sut, ctx } = setup();
      const { sut: lockSut } = newMediumService(LockService, {
        database: ctx.database,
        real: [AccessRepository, AlbumContainerRepository, LockRepository],
        mock: [LoggingRepository],
      });
      const { album, owner, sharedWith } = await ctx.newSharedAlbum({ role: AlbumUserRole.Viewer });
      const sharee = factory.auth({ user: sharedWith, session: { hasElevatedPermission: true } });

      await lockSut.lockAlbum(sharee, album.id);

      const rows = await ctx.database.selectFrom('locked_album').selectAll().where('albumId', '=', album.id).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(sharedWith.id);

      const ownerAlbums = await sut.getAll(factory.auth({ user: owner }), {});
      expect(ownerAlbums.map(({ id }) => id)).toContain(album.id);
      const shareeAlbums = await sut.getAll(factory.auth({ user: sharedWith }), {});
      expect(shareeAlbums.map(({ id }) => id)).not.toContain(album.id);
    });

    it('non-elevated lock mutation fails', async () => {
      const { ctx } = setup();
      const { sut: lockSut } = newMediumService(LockService, {
        database: ctx.database,
        real: [AccessRepository, AlbumContainerRepository, LockRepository],
        mock: [LoggingRepository],
      });
      const { album, sharedWith } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: sharedWith });

      await expect(lockSut.lockAlbum(auth, album.id)).rejects.toThrow('Elevated permission is required');
      await expect(lockSut.unlockAlbum(auth, album.id)).rejects.toThrow('Elevated permission is required');
      await expect(
        ctx.database.selectFrom('locked_album').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([]);
    });

    it('leaving a shared album removes it from my folder view', async () => {
      const { sut, ctx } = setup();
      const { album, sharedWith } = await ctx.newSharedAlbum();
      const auth = factory.auth({ user: sharedWith });
      await expect(sut.getAll(auth, {}).then((all) => all.map(({ id }) => id))).resolves.toContain(album.id);

      await sut.removeUser(auth, album.id, 'me');

      await expect(sut.getAll(auth, {}).then((all) => all.map(({ id }) => id))).resolves.not.toContain(album.id);
    });

    it('non-elevated sharee cannot leave a shared album they locked', async () => {
      const { sut, ctx } = setup();
      const { album, sharedWith } = await ctx.newSharedAlbum();
      await ctx.get(LockRepository).lockAlbum(sharedWith.id, album.id);

      await expect(sut.removeUser(factory.auth({ user: sharedWith }), album.id, 'me')).rejects.toThrow(
        'Not found or no album.read access',
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toHaveLength(2);

      await sut.removeUser(
        factory.auth({ user: sharedWith, session: { hasElevatedPermission: true } }),
        album.id,
        'me',
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toHaveLength(1);
    });

    it('null description round-trips for smart albums', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const album = await newSmartAlbum(ctx, owner.id, { description: 'something' });
      const auth = factory.auth({ user: owner });

      await sut.update(auth, album.id, { description: null });

      const row = await ctx.database
        .selectFrom('album')
        .select('description')
        .where('id', '=', album.id)
        .executeTakeFirstOrThrow();
      expect(row.description).toBeNull();
      const fetched = await sut.get(auth, album.id);
      expect(fetched.kind).toBe(AlbumKind.Smart);
      expect(fetched.description).toBe('');
    });
  });

  describe('create inside a hidden folder', () => {
    const cases = [
      [AlbumKind.Regular, 'locked parent'],
      [AlbumKind.Regular, 'descendant of a locked ancestor'],
      [AlbumKind.Smart, 'locked parent'],
      [AlbumKind.Smart, 'descendant of a locked ancestor'],
    ] as const;

    const dtoFor = (kind: AlbumKind, containerId: string) =>
      kind === AlbumKind.Smart
        ? { albumName: 'Inside', kind, filter: { isFavorite: true }, containerId }
        : { albumName: 'Inside', kind, containerId };

    it.each(cases)('rejects a %s album created in a %s outside an elevated session', async (kind, depth) => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const folder = await hiddenDestination(ctx, user.id, depth);

      await expect(sut.create(factory.auth({ user }), dtoFor(kind, folder.id))).rejects.toThrow(
        new BadRequestException('Not found or no albumContainer.read access'),
      );
      await expect(albumsIn(ctx, folder.id)).resolves.toEqual([]);
    });

    it.each(cases)('allows a %s album created in a %s in an elevated session', async (kind, depth) => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const folder = await hiddenDestination(ctx, user.id, depth);
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      const album = await sut.create(elevated, dtoFor(kind, folder.id));

      expect(album.containerId).toBe(folder.id);
      await expect(albumsIn(ctx, folder.id)).resolves.toEqual([{ id: album.id }]);
    });

    it('rejects moving an album into a hidden folder outside an elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const folder = await hiddenDestination(ctx, user.id, 'descendant of a locked ancestor');
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      await expect(sut.update(factory.auth({ user }), album.id, { containerId: folder.id })).rejects.toThrow(
        new BadRequestException('Not found or no albumContainer.read access'),
      );
      await expect(albumsIn(ctx, folder.id)).resolves.toEqual([]);

      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.update(elevated, album.id, { containerId: folder.id })).resolves.toMatchObject({
        containerId: folder.id,
      });
    });
  });

  describe('smart album cache revision', () => {
    it('asset write during recompute leaves the cache stale', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { asset: later } = await ctx.newAsset({ ownerId: user.id });
      const album = await newSmartAlbum(ctx, user.id);
      const recomputes = watchRecomputes(ctx);

      const held = recomputes.holdNext();
      const listing = listedAssetCount(sut, auth, album.id);
      await held.reached;
      // the asset write (and its invalidation) lands between the recompute's searches and its publish
      await favorite(ctx, later.id);
      await sut.invalidateSmartAlbumsForAssetsSafe(user.id, [later.id]);
      held.release();
      await expect(listing).resolves.toBe(1);

      const before = recomputes.count();
      await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(2);
      expect(recomputes.count(), 'the next list read recomputes').toBe(before + 1);
      const state = await getCacheState(ctx, album.id);
      expect(state).toMatchObject({ cachedAssetCount: 2, cachedRevision: state.cacheRevision });
    });

    it('filter edit during recompute leaves the cache stale', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      await ctx.newAsset({ ownerId: user.id });
      await ctx.newAsset({ ownerId: user.id });
      const album = await newSmartAlbum(ctx, user.id);
      const recomputes = watchRecomputes(ctx);

      const held = recomputes.holdNext();
      const listing = listedAssetCount(sut, auth, album.id);
      await held.reached;
      await sut.update(auth, album.id, { filter: { isFavorite: false } });
      held.release();
      await expect(listing).resolves.toBe(1);

      const before = recomputes.count();
      await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(2);
      expect(recomputes.count(), 'the next list read recomputes').toBe(before + 1);
      const state = await getCacheState(ctx, album.id);
      expect(state).toMatchObject({ cachedAssetCount: 2, cachedRevision: state.cacheRevision });
    });

    it('repeated invalidations within one millisecond each make the cache stale', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { asset: later } = await ctx.newAsset({ ownerId: user.id });
      const album = await newSmartAlbum(ctx, user.id);
      const recomputes = watchRecomputes(ctx);

      vi.useFakeTimers({ now: new Date('2026-11-09T12:00:00.000Z'), toFake: ['Date'] });
      try {
        await sut.invalidateAllSmartAlbumsForOwnerSafe(user.id);
        await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(1);

        await favorite(ctx, later.id);
        await sut.invalidateAllSmartAlbumsForOwnerSafe(user.id);

        const before = recomputes.count();
        await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(2);
        expect(recomputes.count(), 'the list read recomputes').toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the publish compare-and-set succeeds when nothing changed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const album = await newSmartAlbum(ctx, user.id);
      const recomputes = watchRecomputes(ctx);

      await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(1);
      await expect(getCacheState(ctx, album.id)).resolves.toMatchObject({ cacheRevision: 0, cachedRevision: 0 });
      let before = recomputes.count();
      await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(1);
      expect(recomputes.count(), 'served from the published cache').toBe(before);

      await sut.invalidateAllSmartAlbumsForOwnerSafe(user.id);
      await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(1);
      await expect(getCacheState(ctx, album.id)).resolves.toMatchObject({ cacheRevision: 1, cachedRevision: 1 });
      before = recomputes.count();
      await expect(listedAssetCount(sut, auth, album.id)).resolves.toBe(1);
      expect(recomputes.count(), 'served from the republished cache').toBe(before);
    });

    it("filter edit between the caller's album read and recompute start is not published under the new revision", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newAsset({ ownerId: user.id, isFavorite: true, ...takenAt('2020-01-01T12:00:00Z') });
      await ctx.newAsset({ ownerId: user.id, ...takenAt('2021-03-04T12:00:00Z') });
      await ctx.newAsset({ ownerId: user.id, ...takenAt('2022-05-06T12:00:00Z') });
      const album = await newSmartAlbum(ctx, user.id);

      // the caller (the Albums list) loads S with filter F1 at revision r; the owner then edits it to F2 (r + 1)
      const repository = ctx.get(AlbumRepository);
      const getAll = repository.getAll.bind(repository);
      let readRevision: number | undefined;
      vi.spyOn(repository, 'getAll').mockImplementationOnce(async (...args) => {
        const albums = await getAll(...args);
        readRevision = albums.find(({ id }) => id === album.id)?.cacheRevision;
        await sut.update(auth, album.id, { filter: { isFavorite: false } });
        return albums;
      });
      await sut.getAll(auth, {});
      const published = await getCacheState(ctx, album.id);

      expect(published.cachedAssetCount, "F2's count, never F1's").toBe(2);
      expect(readRevision).toBe(0);
      expect(published).toMatchObject({ cacheRevision: 1, cachedRevision: 1 });
      // identical to a fresh evaluation of F2 (the single-album view always recomputes)
      await sut.get(auth, album.id);
      await expect(getCacheState(ctx, album.id)).resolves.toEqual(published);
    });
  });

  describe('database triggers', () => {
    it('should cascade delete an album when the owner is deleted', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      await ctx.get(UserRepository).delete({ id: user.id }, true);

      await expect(ctx.database.selectFrom('album').selectAll().where('id', '=', album.id).execute()).resolves.toEqual(
        [],
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([]);
    });
  });

  /**
   * Fork (review T4): the album response carries the viewer's effective role - the strongest of their direct album
   * role and any role inherited from a shared ancestor folder (Owner > Editor > Viewer) - without exposing the folder
   * share graph.
   */
  describe('viewerRole (T4)', () => {
    it('owner -> owner; a folder-only Viewer -> viewer', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, album, parent, folders } = await newFolderAlbum(ctx);
      await folders.addUser(parent.id, sharee.id, AlbumUserRole.Viewer);

      await expect(roleSeenBy(sut, owner, album.id)).resolves.toEqual(AlbumUserRole.Owner);
      await expect(roleSeenBy(sut, sharee, album.id)).resolves.toEqual(AlbumUserRole.Viewer);
    });

    it('direct Viewer + folder Editor -> editor', async () => {
      const { sut, ctx } = setup();
      const { sharee, album, parent, folders } = await newFolderAlbum(ctx);
      await ctx.newAlbumUser({ albumId: album.id, userId: sharee.id, role: AlbumUserRole.Viewer });
      await folders.addUser(parent.id, sharee.id, AlbumUserRole.Editor);

      await expect(roleSeenBy(sut, sharee, album.id)).resolves.toEqual(AlbumUserRole.Editor);
    });

    it('direct Editor + folder Viewer -> editor', async () => {
      const { sut, ctx } = setup();
      const { sharee, album, parent, folders } = await newFolderAlbum(ctx);
      await ctx.newAlbumUser({ albumId: album.id, userId: sharee.id, role: AlbumUserRole.Editor });
      await folders.addUser(parent.id, sharee.id, AlbumUserRole.Viewer);

      await expect(roleSeenBy(sut, sharee, album.id)).resolves.toEqual(AlbumUserRole.Editor);
    });

    it('a direct Viewer with no folder grant -> viewer; the response never lists folder sharees', async () => {
      const { sut, ctx } = setup();
      const { owner, sharee, album, parent, folders } = await newFolderAlbum(ctx);
      await ctx.newAlbumUser({ albumId: album.id, userId: sharee.id, role: AlbumUserRole.Viewer });
      const { user: folderOnly } = await ctx.newUser();
      await folders.addUser(parent.id, folderOnly.id, AlbumUserRole.Editor);

      await expect(roleSeenBy(sut, sharee, album.id)).resolves.toEqual(AlbumUserRole.Viewer);
      const response = await sut.get(factory.auth({ user: owner }), album.id);
      expect(response.albumUsers.map(({ user }) => user.id)).toEqual([owner.id, sharee.id]);
    });
  });
});
