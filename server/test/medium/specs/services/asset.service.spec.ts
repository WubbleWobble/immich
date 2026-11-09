import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  SharedLinkType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AssetService, {
    database: db || defaultDatabase,
    real: [
      LockRepository,
      AssetRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      SharedLinkAssetRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository, WebsocketRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetService.name, () => {
  describe('get', () => {
    it('should not return an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.get(factory.auth({ user: otherUser }), asset.id)).rejects.toThrow(
        'Not found or no asset.read access',
      );
    });
  });

  describe('getStatistics', () => {
    it('should return stats as numbers, not strings', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });
      const auth = factory.auth({ user: { id: user.id } });
      await expect(sut.getStatistics(auth, {})).resolves.toEqual({ images: 1, total: 1, videos: 0 });
    });
  });

  describe('copy', () => {
    it('should copy albums', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: oldAsset.id });

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(albumRepo.getAssetIds(album.id, [oldAsset.id, newAsset.id])).resolves.toEqual(
        new Set([oldAsset.id, newAsset.id]),
      );
    });

    it('should copy shared links', async () => {
      const { sut, ctx } = setup();
      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const { id: sharedLinkId } = await sharedLinkRepo.create({
        allowUpload: false,
        key: Buffer.from('123'),
        type: SharedLinkType.Individual,
        userId: user.id,
        assetIds: [oldAsset.id],
      });

      const auth = factory.auth({ user: { id: user.id } });

      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });
      await expect(sharedLinkRepo.get(user.id, sharedLinkId)).resolves.toEqual(
        expect.objectContaining({
          assets: [expect.objectContaining({ id: oldAsset.id }), expect.objectContaining({ id: newAsset.id })],
        }),
      );
    });

    it('should merge stacks', async () => {
      const { sut, ctx } = setup();
      const stackRepo = ctx.get(StackRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: asset1.id, description: 'bar' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });
      await ctx.newExif({ assetId: asset2.id, description: 'foo' });

      await ctx.newStack({ ownerId: user.id }, [oldAsset.id, asset1.id]);

      const {
        stack: { id: newStackId },
      } = await ctx.newStack({ ownerId: user.id }, [newAsset.id, asset2.id]);

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(stackRepo.getById(oldAsset.id)).resolves.toEqual(undefined);

      const newStack = await stackRepo.getById(newStackId);
      expect(newStack).toEqual(
        expect.objectContaining({
          primaryAssetId: newAsset.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: asset2.id })]),
        }),
      );
      expect(newStack!.assets.length).toEqual(4);
    });

    it('should copy stack', async () => {
      const { sut, ctx } = setup();
      const stackRepo = ctx.get(StackRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: asset1.id, description: 'bar' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const {
        stack: { id: stackId },
      } = await ctx.newStack({ ownerId: user.id }, [oldAsset.id, asset1.id]);

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      const stack = await stackRepo.getById(stackId);
      expect(stack).toEqual(
        expect.objectContaining({
          primaryAssetId: oldAsset.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: newAsset.id })]),
        }),
      );
      expect(stack!.assets.length).toEqual(3);
    });

    it('should copy favorite status', async () => {
      const { sut, ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(assetRepo.getById(newAsset.id)).resolves.toEqual(expect.objectContaining({ isFavorite: true }));
    });

    it('should copy sidecar file', async () => {
      const { sut, ctx } = setup();
      const storageRepo = ctx.getMock(StorageRepository);
      const jobRepo = ctx.getMock(JobRepository);

      storageRepo.copyFile.mockResolvedValue();
      jobRepo.queue.mockResolvedValue();

      const { user } = await ctx.newUser();

      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: oldAsset.id,
        path: '/path/to/my/sidecar.xmp',
        type: AssetFileType.Sidecar,
      });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const auth = factory.auth({ user: { id: user.id } });

      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      expect(storageRepo.copyFile).toHaveBeenCalledWith('/path/to/my/sidecar.xmp', `${newAsset.originalPath}.xmp`);

      expect(jobRepo.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: newAsset.id },
      });
    });
  });

  describe('delete', () => {
    it('should delete asset', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const thumbnailPath = '/path/to/thumbnail.jpg';
      const previewPath = '/path/to/preview.jpg';
      const sidecarPath = '/path/to/sidecar.xmp';
      await Promise.all([
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: previewPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath }),
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [thumbnailPath, previewPath, sidecarPath, asset.originalPath] },
      });
    });

    it('should delete a stacked primary asset (2 assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);

      const stackRepo = ctx.get(StackRepository);

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // stack is deleted as well
      await expect(stackRepo.getById(stack.id)).resolves.toBe(undefined);
    });

    it('should delete a stacked primary asset (3 assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id, asset3.id]);

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // new primary asset is picked
      await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toMatchObject({ primaryAssetId: asset2.id });
    });

    it('should delete a stacked primary asset (3 trashed assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id, asset3.id]);

      await ctx.get(AssetRepository).updateAll([asset1.id, asset2.id, asset3.id], {
        deletedAt: new Date(),
        status: AssetStatus.Deleted,
      });

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // stack is deleted as well
      await expect(ctx.get(StackRepository).getById(stack.id)).resolves.toBe(undefined);
    });

    it('should not delete offline assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isOffline: true });
      const thumbnailPath = '/path/to/thumbnail.jpg';
      const previewPath = '/path/to/preview.jpg';
      await Promise.all([
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: previewPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: `/path/to/sidecar.xmp` }),
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [thumbnailPath, previewPath] },
      });
    });
  });

  describe('update', () => {
    it('refuses to link a hidden motion asset outside elevation like an unknown id (R51)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: still } = await ctx.newAsset({ ownerId: user.id });
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [motion.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, album.id);
      const ordinary = factory.auth({ user, session: { hasElevatedPermission: false } });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      const refusal = async (livePhotoVideoId: string) => {
        try {
          await sut.update(ordinary, still.id, { livePhotoVideoId });
        } catch (error: any) {
          return { type: error.constructor.name, status: error.getStatus(), response: error.getResponse() };
        }
        return 'resolved';
      };

      const unknown = await refusal(factory.uuid());
      expect(unknown).toMatchObject({ status: 400, response: { message: 'Live photo video not found' } });
      await expect(refusal(motion.id)).resolves.toEqual(unknown);
      await expect(
        ctx.database
          .selectFrom('asset')
          .select(['id', 'visibility', 'livePhotoVideoId'])
          .where('id', 'in', [still.id, motion.id])
          .orderBy('createdAt')
          .execute(),
      ).resolves.toEqual(
        expect.arrayContaining([
          { id: still.id, visibility: AssetVisibility.Timeline, livePhotoVideoId: null },
          { id: motion.id, visibility: AssetVisibility.Timeline, livePhotoVideoId: null },
        ]),
      );

      await sut.update(elevated, still.id, { livePhotoVideoId: motion.id });
      await expect(
        ctx.database
          .selectFrom('asset')
          .select('livePhotoVideoId')
          .where('id', '=', still.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ livePhotoVideoId: motion.id });
    });

    it('refuses to unlink a lock-hidden motion part outside elevation like a missing live photo video', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      const { user } = await ctx.newUser();
      const { asset: motion } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
      });
      const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
      // the motion part is filed into a locked album on its own: hidden, while the uncontained still stays visible
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [motion.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, album.id);
      const ordinary = factory.auth({ user, session: { hasElevatedPermission: false } });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      const rows = () =>
        ctx.database
          .selectFrom('asset')
          .select(['id', 'visibility', 'livePhotoVideoId'])
          .where('id', 'in', [still.id, motion.id])
          .orderBy('id')
          .execute();
      const before = await rows();
      StorageCore.setMediaLocation('/photos');
      onTestFinished(() => StorageCore.reset());

      await expect(sut.update(ordinary, still.id, { livePhotoVideoId: null })).rejects.toThrow(
        new BadRequestException('Live photo video not found'),
      );
      await expect(rows()).resolves.toEqual(before);
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AssetShow', expect.anything());

      await sut.update(elevated, still.id, { livePhotoVideoId: null });
      await expect(
        ctx.database
          .selectFrom('asset')
          .select('livePhotoVideoId')
          .where('id', '=', still.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ livePhotoVideoId: null });
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetShow', {
        assetId: motion.id,
        userId: user.id,
      });
    });

    it('should not update an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.update(factory.auth({ user: otherUser }), asset.id, {})).rejects.toThrow(
        'Not found or no asset.update access',
      );
    });

    it('should automatically lock lockable columns', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });

      await sut.update(auth, asset.id, {
        latitude: 42,
        longitude: 42,
        rating: 3,
        description: 'foo',
        dateTimeOriginal: '2023-11-19T18:11:00+01:00',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['timeZone', 'rating', 'description', 'latitude', 'longitude', 'dateTimeOriginal'],
      });
    });

    it('should update dateTimeOriginal', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: null }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00.000-07:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-20T01:11:00+00:00', timeZone: 'UTC-7' }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone UTC+0', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test', timeZone: 'UTC-7' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00.000Z' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: 'UTC' }),
        }),
      );
    });
  });

  describe('fork locks', () => {
    it('stack summary on asset.get counts only visible members and hides a hidden primary id', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
      const newAsset = (day: number) => ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date(2020, 0, day) });
      const { asset: primary } = await newAsset(1);
      const { asset: visible1 } = await newAsset(2);
      const { asset: hiddenMember } = await newAsset(3);
      const { asset: visible2 } = await newAsset(4);
      const { stack } = await ctx.newStack({ ownerId: user.id }, [
        primary.id,
        visible1.id,
        hiddenMember.id,
        visible2.id,
      ]);
      // a second stack whose only other member is hidden
      const { asset: hiddenPrimary } = await newAsset(5);
      const { asset: lonely } = await newAsset(6);
      const { stack: lonelyStack } = await ctx.newStack({ ownerId: user.id }, [hiddenPrimary.id, lonely.id]);

      const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [
        primary.id,
        hiddenMember.id,
        hiddenPrimary.id,
      ]);
      await ctx.get(LockRepository).lockAlbum(user.id, locked.id);

      const auth = factory.auth({ user });
      const revealing = { ...auth, revealedLocks: { albumIds: [locked.id], containerIds: [] } };
      const partnerAuth = factory.auth({ user: partner, session: { hasElevatedPermission: true } });
      // outside elevation (and for a partner, in every session): the hidden primary is replaced by the first visible
      // member and only visible members count; a stack left with one visible member looks unstacked
      for (const viewer of [auth, revealing, partnerAuth]) {
        for (const id of [visible1.id, visible2.id]) {
          await expect(sut.get(viewer, id)).resolves.toMatchObject({
            stack: { id: stack.id, primaryAssetId: visible1.id, assetCount: 2 },
          });
        }
        await expect(sut.get(viewer, lonely.id)).resolves.toMatchObject({ stack: null });
      }

      // a shared-link visitor is judged by the owner's locks but keeps every member the link itself grants
      const sharedLink = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        showExif: true,
        key: Buffer.from(`stack-${stack.id}`),
        type: SharedLinkType.Individual,
        userId: user.id,
        assetIds: [visible1.id, hiddenMember.id],
      });
      const linkAuth = factory.auth({ user: { id: user.id }, sharedLink });
      await expect(sut.get(linkAuth, visible1.id)).resolves.toMatchObject({
        stack: { id: stack.id, primaryAssetId: visible1.id, assetCount: 3 },
      });

      // the elevated owner sees the stack as stored (direct-by-id read, spec §15.3)
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.get(elevated, visible1.id)).resolves.toMatchObject({
        stack: { id: stack.id, primaryAssetId: primary.id, assetCount: 4 },
      });
      await expect(sut.get(elevated, lonely.id)).resolves.toMatchObject({
        stack: { id: lonelyStack.id, primaryAssetId: hiddenPrimary.id, assetCount: 2 },
      });
    });

    it('update re-reads through the lock-checked get: a hidden asset is refused before any write', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      const { user } = await ctx.newUser();
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: visible.id, make: 'Canon' });
      await ctx.newExif({ assetId: hidden.id, make: 'Canon' });
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, locked.id);
      const isFavorite = async (id: string) => {
        const asset = await ctx.get(AssetRepository).getById(id);
        return asset?.isFavorite;
      };

      const auth = factory.auth({ user });
      await expect(sut.update(auth, visible.id, { isFavorite: true })).resolves.toEqual(
        expect.objectContaining({
          id: visible.id,
          isFavorite: true,
          exifInfo: expect.objectContaining({ make: 'Canon' }),
        }),
      );

      const revealing = { ...auth, revealedLocks: { albumIds: [locked.id], containerIds: [] } };
      for (const unelevated of [auth, revealing]) {
        await expect(sut.update(unelevated, hidden.id, { isFavorite: true })).rejects.toThrow(
          'Not found or no asset.update access',
        );
      }
      await expect(isFavorite(hidden.id)).resolves.toBe(false);

      // direct-by-id: the elevated owner may edit hidden content and gets the full re-read back
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.update(elevated, hidden.id, { isFavorite: true })).resolves.toEqual(
        expect.objectContaining({
          id: hidden.id,
          isFavorite: true,
          exifInfo: expect.objectContaining({ make: 'Canon' }),
        }),
      );
    });

    it('updateAll rejects the retired locked visibility and leaves album memberships alone', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      await expect(sut.updateAll(elevated, { ids: [asset.id], visibility: AssetVisibility.Locked })).rejects.toThrow(
        /locked/i,
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({
        visibility: AssetVisibility.Timeline,
      });
    });
  });

  describe('updateAll', () => {
    it('should automatically lock lockable columns', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });

      await sut.updateAll(auth, {
        ids: [asset.id],
        latitude: 42,
        description: 'foo',
        longitude: 42,
        rating: 3,
        dateTimeOriginal: '2023-11-19T18:11:00+01:00',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['timeZone', 'rating', 'description', 'latitude', 'longitude', 'dateTimeOriginal'],
      });
    });

    it('should relatively update assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -11 });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:00:00+00:00',
          }),
        }),
      );
    });

    it('should relatively update assets with timezone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00', timeZone: 'UTC+5' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -1441 });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-18T18:10:00+00:00',
            timeZone: 'UTC+5',
            lockedProperties: ['timeZone', 'dateTimeOriginal'],
          }),
        }),
      );
    });

    it('should relatively update assets and set a timezone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -11, timeZone: 'UTC+5' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:00:00+00:00',
            timeZone: 'UTC+5',
          }),
        }),
      );
    });

    it('should set asset time zones to UTC', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00', timeZone: 'UTC-7' });

      await sut.updateAll(auth, { ids: [asset.id], timeZone: 'UTC' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:11:00+00:00',
            timeZone: 'UTC',
          }),
        }),
      );
    });

    it('should update dateTimeOriginal', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: null }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00.000-07:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-20T01:11:00+00:00', timeZone: 'UTC-7' }),
        }),
      );
    });

    it('should update dateTimeOriginal with UTC time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test', timeZone: 'UTC-7' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00.000Z' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: 'UTC' }),
        }),
      );
    });
  });

  describe('getOcr', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(sut.getOcr(auth, asset.id)).rejects.toThrow('Not found or no asset.read access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ x1: 0.1, x2: 0.3, x3: 0.3, x4: 0.1, y1: 0.2, y2: 0.2, y3: 0.4, y4: 0.4 }),
      ]);
    });

    it('should apply rotation', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      await ctx.database
        .insertInto('asset_edit')
        .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
        .execute();
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({
          x1: 0.6,
          x2: 0.8,
          x3: 0.8,
          x4: 0.6,
          y1: expect.any(Number),
          y2: expect.any(Number),
          y3: 0.3,
          y4: 0.3,
        }),
      ]);
    });
  });

  describe('getOcr', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(sut.getOcr(auth, asset.id)).rejects.toThrow('Not found or no asset.read access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ x1: 0.1, x2: 0.3, x3: 0.3, x4: 0.1, y1: 0.2, y2: 0.2, y3: 0.4, y4: 0.4 }),
      ]);
    });

    it('should apply rotation', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      await ctx.database
        .insertInto('asset_edit')
        .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
        .execute();
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({
          x1: 0.6,
          x2: 0.8,
          x3: 0.8,
          x4: 0.6,
          y1: expect.any(Number),
          y2: expect.any(Number),
          y3: 0.3,
          y4: 0.3,
        }),
      ]);
    });
  });

  describe('upsertBulkMetadata', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const items = [{ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } }];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(1);
      expect(metadata[0]).toEqual(
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } }),
      );
    });

    it('should work on conflict', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'old-id' } });

      // verify existing metadata
      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'old-id' } }),
      ]);

      const items = [{ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'new-id' } }];
      await sut.upsertBulkMetadata(auth, { items });

      // verify updated metadata
      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'new-id' } }),
      ]);
    });

    it('should work with multiple assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });

      const items = [
        { assetId: asset1.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset2.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } },
      ];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata1 = await ctx.get(AssetRepository).getMetadata(asset1.id);
      expect(metadata1).toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } }),
      ]);

      const metadata2 = await ctx.get(AssetRepository).getMetadata(asset2.id);
      expect(metadata2).toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } }),
      ]);
    });

    it('should work with multiple metadata for the same asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const items = [
        { assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } },
      ];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: AssetMetadataKey.MobileApp,
            value: { iCloudId: 'id1' },
          }),
          expect.objectContaining({
            key: 'some-other-key',
            value: { foo: 'bar' },
          }),
        ]),
      );
    });
  });

  describe('deleteBulkMetadata', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } });

      await sut.deleteBulkMetadata(auth, { items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }] });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(0);
    });

    it('should work even if the item does not exist', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.deleteBulkMetadata(auth, { items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }] });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(0);
    });

    it('should work with multiple assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset1.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset2.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } });

      await sut.deleteBulkMetadata(auth, {
        items: [
          { assetId: asset1.id, key: AssetMetadataKey.MobileApp },
          { assetId: asset2.id, key: AssetMetadataKey.MobileApp },
        ],
      });

      await expect(ctx.get(AssetRepository).getMetadata(asset1.id)).resolves.toEqual([]);
      await expect(ctx.get(AssetRepository).getMetadata(asset2.id)).resolves.toEqual([]);
    });

    it('should work with multiple metadata for the same asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      await ctx.newMetadata({ assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } });

      await sut.deleteBulkMetadata(auth, {
        items: [
          { assetId: asset.id, key: AssetMetadataKey.MobileApp },
          { assetId: asset.id, key: 'some-other-key' },
        ],
      });

      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([]);
    });

    it('should not delete unspecified keys', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      await ctx.newMetadata({ assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } });

      await sut.deleteBulkMetadata(auth, {
        items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }],
      });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata).toEqual([expect.objectContaining({ key: 'some-other-key', value: { foo: 'bar' } })]);
    });
  });

  describe('editAsset', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(
        sut.editAsset(auth, asset.id, { edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] }),
      ).rejects.toThrow('Not found or no asset.edit.create access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });

      const editAction = { action: AssetEditAction.Rotate, parameters: { angle: 90 } } as const;
      const editResponse = { ...editAction, id: expect.any(String) };
      await expect(sut.editAsset(auth, asset.id, { edits: [editAction] })).resolves.toEqual({
        assetId: asset.id,
        edits: [editResponse],
      });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ isEdited: true }),
      );
      await expect(ctx.get(AssetEditRepository).getAll(asset.id)).resolves.toEqual([editResponse]);
    });
  });
});
