import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole, AssetStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { LockService } from 'src/services/lock.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const result = newMediumService(LockService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AlbumUserRepository, AssetRepository, LockRepository, UserRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  result.ctx.getMock(EventRepository).emit.mockResolvedValue();
  result.ctx.getMock(JobRepository).queue.mockResolvedValue();
  result.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return result;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

type Ctx = MediumTestContext<typeof LockService>;

/** An owner with a locked (empty) destination album, an unlocked regular album holding `assetIds`, and a tag. */
const newMoveFixture = async (ctx: Ctx) => {
  const { user } = await ctx.newUser();
  const { album: destination } = await ctx.newAlbum({ ownerId: user.id });
  await ctx.get(LockRepository).lockAlbum(user.id, destination.id);
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['saved-search'] });
  const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
  return { user, destination, tag, elevated };
};

/**
 * Fork (R79 fix round 1): `stillVisible` is the real verdict after the move - the moved assets that still pass the
 * owner's own locks (no reveal, no elevation), as partners and cluster peers judge them. Every rescue counts:
 * an unremovable regular membership and a matching unlocked smart album, trashed photos included (R79).
 */
describe(LockService.name, () => {
  describe('moveAssetsToLockedAlbum reports the real verdict', () => {
    it('a trashed photo an unlocked smart album matches is reported still visible', async () => {
      const { sut, ctx } = setup();
      const { user, destination, tag, elevated } = await newMoveFixture(ctx);
      const { asset: rescued } = await ctx.newAsset({ ownerId: user.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbum({ ownerId: user.id }, [rescued.id, plain.id]);
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [rescued.id] });
      await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { tagIds: [tag.id] } as any });
      const ids = [rescued.id, plain.id];
      await ctx.get(AssetRepository).updateAll(ids, { deletedAt: new Date(), status: AssetStatus.Trashed });

      await expect(sut.moveAssetsToLockedAlbum(elevated, { albumId: destination.id, assetIds: ids })).resolves.toEqual({
        moved: [plain.id],
        stillVisible: [rescued.id],
        failed: [],
      });
      const visible = await ctx.get(LockRepository).getVisibleAssetIds(
        ids,
        await ctx.get(LockRepository).getOwnerLockVisibility({
          viewerId: user.id,
          ownerIds: [user.id],
          revealed: { albumIds: [], containerIds: [] },
          isElevated: false,
        }),
      );
      expect([...visible]).toEqual([rescued.id]);
    });

    it('control: a live photo an unlocked smart album matches is reported still visible, the others moved', async () => {
      const { sut, ctx } = setup();
      const { user, destination, tag, elevated } = await newMoveFixture(ctx);
      const { asset: rescued } = await ctx.newAsset({ ownerId: user.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbum({ ownerId: user.id }, [rescued.id, plain.id]);
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [rescued.id] });
      await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { tagIds: [tag.id] } as any });

      await expect(
        sut.moveAssetsToLockedAlbum(elevated, { albumId: destination.id, assetIds: [rescued.id, plain.id] }),
      ).resolves.toEqual({ moved: [plain.id], stillVisible: [rescued.id], failed: [] });
    });

    it('control: a membership the owner cannot remove (viewer of a shared album) is reported still visible', async () => {
      const { sut, ctx } = setup();
      const { user, destination, elevated } = await newMoveFixture(ctx);
      const { user: other } = await ctx.newUser();
      const { asset: stuck } = await ctx.newAsset({ ownerId: user.id });
      const { album: shared } = await ctx.newAlbum({ ownerId: other.id }, [stuck.id]);
      await ctx.newAlbumUser({ albumId: shared.id, userId: user.id, role: AlbumUserRole.Viewer });

      await expect(
        sut.moveAssetsToLockedAlbum(elevated, { albumId: destination.id, assetIds: [stuck.id] }),
      ).resolves.toEqual({ moved: [], stillVisible: [stuck.id], failed: [] });
    });

    it('control: a trashed photo with no rescue is reported moved', async () => {
      const { sut, ctx } = setup();
      const { user, destination, elevated } = await newMoveFixture(ctx);
      const { asset } = await ctx.newAsset({ ownerId: user.id, status: AssetStatus.Trashed, deletedAt: new Date() });
      await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      await expect(
        sut.moveAssetsToLockedAlbum(elevated, { albumId: destination.id, assetIds: [asset.id] }),
      ).resolves.toEqual({ moved: [asset.id], stillVisible: [], failed: [] });
    });
  });
});
