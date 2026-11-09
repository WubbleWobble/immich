import { Kysely } from 'kysely';
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
});
