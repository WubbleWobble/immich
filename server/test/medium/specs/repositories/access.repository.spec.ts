import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AlbumUserRole, AssetFileType, AssetType, AssetVisibility, Permission } from 'src/enum.js';
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

type Ctx = ReturnType<typeof setup>['ctx'];
type StillLock = 'regular' | 'smart' | 'folder';

/**
 * A Live Photo of `owner` (shared with `partner` through partner sharing) whose still is hidden by the owner's lock on a
 * regular album, a smart album, or a folder. The motion part M has no container of its own, so before 7A.2 it passed
 * the lock filter's zero-container clause.
 */
const setupLockedLivePhoto = async (ctx: Ctx, kind: StillLock) => {
  const locks = ctx.get(LockRepository);
  const { user: owner } = await ctx.newUser();
  const { user: partner } = await ctx.newUser();
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });

  const { asset: motion } = await ctx.newAsset({
    ownerId: owner.id,
    type: AssetType.Video,
    visibility: AssetVisibility.Hidden,
  });
  const { asset: still } = await ctx.newAsset({
    ownerId: owner.id,
    livePhotoVideoId: motion.id,
    isFavorite: kind === 'smart',
  });
  await ctx.newAssetFile({ assetId: motion.id, type: AssetFileType.EncodedVideo, path: `/encoded/${motion.id}.mp4` });
  const { id: motionFileId } = await ctx.database
    .selectFrom('asset_file')
    .select('id')
    .where('assetId', '=', motion.id)
    .executeTakeFirstOrThrow();

  switch (kind) {
    case 'regular': {
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [still.id]);
      await locks.lockAlbum(owner.id, album.id);
      break;
    }
    case 'smart': {
      const { album } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Smart, filter: { isFavorite: true } });
      await locks.lockAlbum(owner.id, album.id);
      break;
    }
    case 'folder': {
      const folder = await ctx.get(AlbumContainerRepository).create({ ownerId: owner.id, name: 'F', parentId: null });
      await ctx.newAlbum({ ownerId: owner.id, containerId: folder.id }, [still.id]);
      await locks.lockContainer(owner.id, folder.id);
      break;
    }
  }

  return {
    owner,
    partner,
    still,
    motion,
    motionFileId,
    ownerPlain: factory.auth({ user: owner }),
    ownerElevated: factory.auth({ user: owner, session: { hasElevatedPermission: true } }),
    partnerPlain: factory.auth({ user: partner }),
    partnerElevated: factory.auth({ user: partner, session: { hasElevatedPermission: true } }),
  };
};

/**
 * Which motion-asset surfaces `auth` reaches: known-id reads (asset.read), video-stream playback (asset.view, the HLS
 * and playback permission), original download (asset.download) and - owner-only - the asset-file API.
 */
const motionAccess = async (
  access: AccessRepository,
  auth: AuthDto,
  { motionId, fileId }: { motionId: string; fileId?: string },
) => {
  const result: Record<string, boolean> = {};
  for (const permission of [Permission.AssetRead, Permission.AssetView, Permission.AssetDownload]) {
    const allowed = await checkAccess(access, { auth, permission, ids: [motionId] });
    result[permission] = allowed.has(motionId);
  }
  if (fileId) {
    for (const permission of [Permission.AssetFileRead, Permission.AssetFileDownload]) {
      const allowed = await checkAccess(access, { auth, permission, ids: [fileId] });
      result[permission] = allowed.has(fileId);
    }
  }
  return result;
};

const OWNER_SURFACES = [
  Permission.AssetRead,
  Permission.AssetView,
  Permission.AssetDownload,
  Permission.AssetFileRead,
  Permission.AssetFileDownload,
];
const PARTNER_SURFACES = [Permission.AssetRead, Permission.AssetView, Permission.AssetDownload];
const all = (permissions: Permission[], value: boolean) =>
  Object.fromEntries(permissions.map((permission) => [permission, value]));

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
  describe.each<StillLock>(['regular', 'smart', 'folder'])(
    'Live Photo motion follows its still (7A.2), still hidden by a %s lock',
    (kind) => {
      it('owner, non-elevated → denied', async () => {
        const { ctx, sut } = setup();
        const fixture = await setupLockedLivePhoto(ctx, kind);
        const { ownerPlain, still, motion, motionFileId } = fixture;

        // the still itself is hidden ...
        await expect(
          checkAccess(sut, { auth: ownerPlain, permission: Permission.AssetRead, ids: [still.id] }),
        ).resolves.toEqual(new Set());
        // ... and so is its motion part, on every surface
        await expect(motionAccess(sut, ownerPlain, { motionId: motion.id, fileId: motionFileId })).resolves.toEqual(
          all(OWNER_SURFACES, false),
        );

        // a visible Live Photo of the same (lock-holding) owner keeps working: M is not rejected for being hidden
        const { asset: visibleMotion } = await ctx.newAsset({
          ownerId: fixture.owner.id,
          type: AssetType.Video,
          visibility: AssetVisibility.Hidden,
        });
        await ctx.newAsset({ ownerId: fixture.owner.id, livePhotoVideoId: visibleMotion.id });
        await expect(motionAccess(sut, ownerPlain, { motionId: visibleMotion.id })).resolves.toEqual(
          all(PARTNER_SURFACES, true),
        );
      });

      it('owner, elevated → allowed', async () => {
        const { ctx, sut } = setup();
        const { ownerElevated, motion, motionFileId } = await setupLockedLivePhoto(ctx, kind);

        await expect(motionAccess(sut, ownerElevated, { motionId: motion.id, fileId: motionFileId })).resolves.toEqual(
          all(OWNER_SURFACES, true),
        );
      });

      it('partner, non-elevated → denied', async () => {
        const { ctx, sut } = setup();
        const { partnerPlain, motion } = await setupLockedLivePhoto(ctx, kind);

        await expect(motionAccess(sut, partnerPlain, { motionId: motion.id })).resolves.toEqual(
          all(PARTNER_SURFACES, false),
        );
      });

      it('partner, elevated → still denied', async () => {
        const { ctx, sut } = setup();
        const { partnerElevated, motion } = await setupLockedLivePhoto(ctx, kind);

        // the owner's lock is not the partner's to bypass (spec §7, §15.3)
        await expect(motionAccess(sut, partnerElevated, { motionId: motion.id })).resolves.toEqual(
          all(PARTNER_SURFACES, false),
        );
      });

      it('partner, elevated, with another legitimate grant (M or its still in an album shared with the partner and not hidden for them) → allowed', async () => {
        const { ctx, sut } = setup();
        const locks = ctx.get(LockRepository);

        for (const member of ['motion', 'still'] as const) {
          const fixture = await setupLockedLivePhoto(ctx, kind);
          const { owner, partner, partnerElevated, partnerPlain, motion, still } = fixture;
          // the owner shares an album holding M (or its still) with the partner - and locks it too, so the owner's
          // locks still hide M: only the partner's album grant (album owner's locks never bind sharees, spec §4) remains
          const { album } = await ctx.newAlbum({ ownerId: owner.id }, [member === 'motion' ? motion.id : still.id]);
          await ctx.newAlbumUser({ albumId: album.id, userId: partner.id, role: AlbumUserRole.Viewer });
          await locks.lockAlbum(owner.id, album.id);

          await expect(motionAccess(sut, fixture.ownerPlain, { motionId: motion.id })).resolves.toEqual(
            all(PARTNER_SURFACES, false),
          );
          for (const auth of [partnerElevated, partnerPlain]) {
            await expect(motionAccess(sut, auth, { motionId: motion.id })).resolves.toEqual(
              all(PARTNER_SURFACES, true),
            );
          }

          // a grant the partner hid with their own lock no longer counts outside elevation (spec §15.1)
          await locks.lockAlbum(partner.id, album.id);
          await expect(motionAccess(sut, partnerPlain, { motionId: motion.id })).resolves.toEqual(
            all(PARTNER_SURFACES, false),
          );
          await expect(motionAccess(sut, partnerElevated, { motionId: motion.id })).resolves.toEqual(
            all(PARTNER_SURFACES, true),
          );
        }
      });

      it('still in a visible album → allowed for owner and partner', async () => {
        const { ctx, sut } = setup();
        const { owner, ownerPlain, partnerPlain, still, motion, motionFileId } = await setupLockedLivePhoto(ctx, kind);
        await ctx.newAlbum({ ownerId: owner.id }, [still.id]);

        await expect(motionAccess(sut, ownerPlain, { motionId: motion.id, fileId: motionFileId })).resolves.toEqual(
          all(OWNER_SURFACES, true),
        );
        await expect(motionAccess(sut, partnerPlain, { motionId: motion.id })).resolves.toEqual(
          all(PARTNER_SURFACES, true),
        );
      });

      it('M independently in a visible album → allowed', async () => {
        const { ctx, sut } = setup();
        const { owner, ownerPlain, partnerPlain, motion, motionFileId } = await setupLockedLivePhoto(ctx, kind);
        await ctx.newAlbum({ ownerId: owner.id }, [motion.id]);

        await expect(motionAccess(sut, ownerPlain, { motionId: motion.id, fileId: motionFileId })).resolves.toEqual(
          all(OWNER_SURFACES, true),
        );
        await expect(motionAccess(sut, partnerPlain, { motionId: motion.id })).resolves.toEqual(
          all(PARTNER_SURFACES, true),
        );
      });
    },
  );
});
