import { Kysely } from 'kysely';
import { AlbumUserRole, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { checkAccess } from 'src/utils/access.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AccessRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AccessRepository.name, () => {
  describe('asset.checkAlbumAccess', () => {
    it('grants asset access via a direct album share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const asset = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.result.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });

      const allowed = await sut.asset.checkAlbumAccess(viewer.id, new Set([asset.result.id]));
      expect(allowed).toEqual(new Set([asset.result.id]));
    });

    it('grants asset access via a folder share (cascade)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const folderRepo = ctx.get(AlbumContainerRepository);
      const folder = await folderRepo.create({ ownerId: owner.id, name: 'Family', parentId: null });

      const asset = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: folder.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.result.id });

      await folderRepo.addUser(folder.id, viewer.id, AlbumUserRole.Viewer);

      const allowed = await sut.asset.checkAlbumAccess(viewer.id, new Set([asset.result.id]));
      expect(allowed).toEqual(new Set([asset.result.id]));
    });

    it('grants asset access via an ancestor folder share (nested cascade)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const folderRepo = ctx.get(AlbumContainerRepository);
      const family = await folderRepo.create({ ownerId: owner.id, name: 'Family', parentId: null });
      const andi = await folderRepo.create({ ownerId: owner.id, name: 'Andi', parentId: family.id });

      const asset = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: andi.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.result.id });

      await folderRepo.addUser(family.id, viewer.id, AlbumUserRole.Editor);

      const allowed = await sut.asset.checkAlbumAccess(viewer.id, new Set([asset.result.id]));
      expect(allowed).toEqual(new Set([asset.result.id]));
    });

    it('does not grant access without a direct or cascade share', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();

      const folderRepo = ctx.get(AlbumContainerRepository);
      const folder = await folderRepo.create({ ownerId: owner.id, name: 'Family', parentId: null });

      const asset = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: folder.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.result.id });

      const allowed = await sut.asset.checkAlbumAccess(stranger.id, new Set([asset.result.id]));
      expect(allowed).toEqual(new Set());
    });
  });

  describe('asset read access and locks', () => {
    it("asset access through partner grant is not removed by the viewer's own album lock", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: viewer.id });

      const { asset } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      await ctx.get(LockRepository).lockAlbum(viewer.id, album.id);

      const auth = factory.auth({ user: { id: viewer.id } });
      // the viewer's lock withholds the album grant (spec §15.1) ...
      await expect(sut.asset.checkAlbumAccess(viewer.id, new Set([asset.id]))).resolves.toEqual(new Set());
      // ... but the partner check runs on whatever the album check does not grant, under the owner's locks
      await expect(checkAccess(sut, { auth, permission: Permission.AssetRead, ids: [asset.id] })).resolves.toEqual(
        new Set([asset.id]),
      );
    });
  });
});
