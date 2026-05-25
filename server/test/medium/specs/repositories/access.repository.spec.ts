import { Kysely } from 'kysely';
import { AlbumUserRole } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

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
});
