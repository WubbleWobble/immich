import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { MetadataSearchDto } from 'src/dtos/search.dto.js';
import { TimeBucketAssetDto } from 'src/dtos/time-bucket.dto.js';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  QueueName,
  SharedLinkType,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { DownloadService } from 'src/services/download.service.js';
import { DuplicateService } from 'src/services/duplicate.service.js';
import { JobService } from 'src/services/job.service.js';
import { MemoryService } from 'src/services/memory.service.js';
import { SearchService } from 'src/services/search.service.js';
import { StackService } from 'src/services/stack.service.js';
import { TimelineService } from 'src/services/timeline.service.js';
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
      SessionRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository, WebsocketRepository],
  });
};

// Fork (ruling R56): the Live Photo fixture and the list surfaces it is read through.
const timeline = () =>
  newMediumService(TimelineService, {
    database: defaultDatabase,
    real: [AlbumRepository, AssetRepository, AccessRepository, LockRepository, PartnerRepository],
    mock: [LoggingRepository],
  }).sut;
const search = () =>
  newMediumService(SearchService, {
    database: defaultDatabase,
    real: [
      LockRepository,
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
    ],
    mock: [LoggingRepository],
  }).sut;

/** The unlink fixture: an uncontained, visible still whose motion part is filed only into a locked album. */
const newLivePhoto = async (ctx: ReturnType<typeof setup>['ctx'], { lock = true } = {}) => {
  const { user } = await ctx.newUser();
  const localDateTime = '1970-02-15T00:00:00.000Z';
  const { asset: motion } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Video,
    visibility: AssetVisibility.Hidden,
    localDateTime,
  });
  const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id, localDateTime });
  await ctx.newExif({ assetId: still.id, make: 'Canon' });
  await ctx.newExif({ assetId: motion.id, make: 'Canon' });
  const { album } = await ctx.newAlbum({ ownerId: user.id }, [motion.id]);
  if (lock) {
    await ctx.get(LockRepository).lockAlbum(user.id, album.id);
  }
  return { user, still, motion, album };
};

/** The still's livePhotoVideoId as each list surface presents it: timeline bucket, search v1 and search v3. */
const listed = async (auth: AuthDto, stillId: string, bucket: Partial<TimeBucketAssetDto> = {}) => {
  const columnar = JSON.parse(await timeline().getTimeBucket(auth, { timeBucket: '1970-02-01', ...bucket }));
  const inBucket = (columnar.id as string[]).flatMap((id, index) =>
    id === stillId ? [columnar.livePhotoVideoId[index]] : [],
  );
  const fromSearch = async (dto: MetadataSearchDto) => {
    const { assets } = await search().searchMetadata(auth, dto);
    return assets.items.filter(({ id }) => id === stillId).map(({ livePhotoVideoId }) => livePhotoVideoId);
  };
  return {
    bucket: inBucket,
    searchV1: await fromSearch({ size: 250 }),
    searchV3: await fromSearch({ size: 250, filter: {} }),
  };
};
const everywhere = (value: string | null) => ({ bucket: [value], searchV1: [value], searchV3: [value] });

const lists = (value: string | null) => ({
  stack: value,
  stacks: value,
  memory: value,
  memories: value,
  duplicates: value,
});

/** Fork (R58): the `on_asset_update` events the owner-room websocket mock received. */
const updatesSent = (ctx: ReturnType<typeof setup>['ctx']) =>
  ctx
    .getMock(WebsocketRepository)
    .clientSend.mock.calls.filter(([event]) => event === 'on_asset_update')
    .map(([, room, asset]) => ({
      room,
      id: (asset as { id: string }).id,
      livePhotoVideoId: (asset as any).livePhotoVideoId,
    }));

/** Fork (R56 follow-up): whether the still is found by isMotion, in search v1 and v3. */
const found = async (auth: AuthDto, stillId: string, isMotion: boolean) => {
  const v1 = await search().searchMetadata(auth, { size: 250, isMotion });
  const v3 = await search().searchMetadata(auth, { size: 250, filter: { isMotion: { eq: isMotion } } });
  return [v1, v3].map(({ assets }) => assets.items.some(({ id }) => id === stillId));
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

      // R56: the visible still's read response does not enumerate the hidden motion part either
      await expect(sut.get(ordinary, still.id)).resolves.toMatchObject({ id: still.id, livePhotoVideoId: null });
      await expect(sut.get(elevated, still.id)).resolves.toMatchObject({ livePhotoVideoId: motion.id });

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

  /**
   * Fork (ruling R56): a visible still must not enumerate a motion part the caller cannot reach. Each response applies
   * its own rule: direct-by-id responses the caller's asset.read rule (elevation bypasses only the viewer's own locks),
   * lists the lock visibility they were filtered with (hidden stays hidden when elevated unless revealed).
   */
  describe('Live Photo motion id of a visible still (R56)', () => {
    it("the owner's detail, timeline bucket and search withhold a lock-hidden motion part's id", async () => {
      const { sut, ctx } = setup();
      const { user, still, motion, album } = await newLivePhoto(ctx);
      const ordinary = factory.auth({ user, session: { hasElevatedPermission: false } });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      const revealing = { ...elevated, revealedLocks: { albumIds: [album.id], containerIds: [] } };

      // the motion part itself is unreachable by id, and the visible still must not enumerate it
      await expect(sut.get(ordinary, motion.id)).rejects.toThrow('Not found or no asset.read access');
      await expect(sut.get(ordinary, still.id)).resolves.toMatchObject({ id: still.id, livePhotoVideoId: null });
      await expect(listed(ordinary, still.id)).resolves.toEqual(everywhere(null));

      // direct-by-id: elevation bypasses the viewer's own locks; lists: hidden stays hidden until revealed
      await expect(sut.get(elevated, still.id)).resolves.toMatchObject({ livePhotoVideoId: motion.id });
      await expect(listed(elevated, still.id)).resolves.toEqual(everywhere(null));
      await expect(listed(revealing, still.id)).resolves.toEqual(everywhere(motion.id));
    });

    it("a partner never sees the id while the owner's lock hides the motion part, whatever the partner's session", async () => {
      const { sut, ctx } = setup();
      const { user: owner, still } = await newLivePhoto(ctx);
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
      const ordinary = factory.auth({ user: partner, session: { hasElevatedPermission: false } });
      const elevated = factory.auth({ user: partner, session: { hasElevatedPermission: true } });

      for (const auth of [ordinary, elevated]) {
        await expect(sut.get(auth, still.id)).resolves.toMatchObject({ id: still.id, livePhotoVideoId: null });
        await expect(listed(auth, still.id, { userId: owner.id })).resolves.toEqual(everywhere(null));
      }
    });

    it('a legitimate album or shared-link grant still reaches the motion part through its still', async () => {
      const { sut, ctx } = setup();
      const { user: owner, still, motion } = await newLivePhoto(ctx);
      // an album the owner is not a member of: it grants its viewer the still and, through it, the motion part, while
      // it neither rescues the motion part from the owner's lock nor counts for the owner
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbum({ ownerId: viewer.id }, [still.id]);
      await expect(sut.get(factory.auth({ user: viewer }), still.id)).resolves.toMatchObject({
        livePhotoVideoId: motion.id,
      });
      await expect(sut.get(factory.auth({ user: owner }), still.id)).resolves.toMatchObject({
        livePhotoVideoId: null,
      });

      // the shared-link visitor (stripped-metadata form included) reaches the motion part through the link's own grant
      for (const showExif of [true, false]) {
        const sharedLink = await ctx.get(SharedLinkRepository).create({
          allowUpload: false,
          showExif,
          key: Buffer.from(`live-photo-${still.id}-${showExif}`),
          type: SharedLinkType.Individual,
          userId: owner.id,
          assetIds: [still.id],
        });
        const response = await sut.get(factory.auth({ user: { id: owner.id }, sharedLink }), still.id);
        expect(response).toMatchObject({ id: still.id, hasMetadata: showExif, livePhotoVideoId: motion.id });
      }
    });

    it('a V3 search keeps the id for a still its album arm grants', async () => {
      const { ctx } = setup();
      const { user: owner, still, motion } = await newLivePhoto(ctx);
      // a partner who also holds an album of their own (the owner is not a member) containing the still
      const { user: viewer } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: viewer.id });
      const { album } = await ctx.newAlbum({ ownerId: viewer.id }, [still.id]);
      const auth = factory.auth({ user: viewer });
      const motionIds = async (filter: MetadataSearchDto['filter']) => {
        const { assets } = await search().searchMetadata(auth, { size: 250, filter });
        return assets.items.filter(({ id }) => id === still.id).map(({ livePhotoVideoId }) => livePhotoVideoId);
      };

      // reached through the partner arm only, the owner's lock decides; through the album arm, the album grants
      await expect(motionIds({ isFavorite: { eq: false } })).resolves.toEqual([null]);
      await expect(
        motionIds({ or: [{ albumIds: { any: [album.id] } }, { isFavorite: { eq: false } }] }),
      ).resolves.toEqual([motion.id]);

      // isMotion follows the same reachability (the album arm included)
      await expect(motionIds({ isMotion: { eq: true } })).resolves.toEqual([]);
      await expect(
        motionIds({ or: [{ albumIds: { any: [album.id] } }, { isFavorite: { eq: false } }], isMotion: { eq: true } }),
      ).resolves.toEqual([motion.id]);
    });

    it('stacks, memories, duplicates and download info apply the same rules', async () => {
      const { ctx } = setup();
      const { user, still, motion, album } = await newLivePhoto(ctx);
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: other.id, make: 'Canon' });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [still.id, other.id]);
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.newMemoryAsset({ memoryId: memory.id, assetId: still.id });
      // duplicates leave stacked assets out: a second, unstacked still of the same motion part forms the group
      const duplicateId = factory.uuid();
      const duplicateIds: string[] = [];
      for (const livePhotoVideoId of [motion.id, null]) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId, duplicateId });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        duplicateIds.push(asset.id);
      }

      const real = [AccessRepository, AlbumRepository, AssetRepository, LockRepository];
      const stacks = newMediumService(StackService, {
        database: defaultDatabase,
        real: [...real, StackRepository],
        mock: [EventRepository, LoggingRepository],
      }).sut;
      const memories = newMediumService(MemoryService, {
        database: defaultDatabase,
        real: [...real, MemoryRepository],
        mock: [LoggingRepository],
      }).sut;
      const duplicates = newMediumService(DuplicateService, {
        database: defaultDatabase,
        real: [...real, DuplicateRepository],
        mock: [LoggingRepository],
      }).sut;
      const downloads = newMediumService(DownloadService, {
        database: defaultDatabase,
        real: [...real, DownloadRepository, UserRepository],
        mock: [LoggingRepository],
      }).sut;

      const presented = async (auth: AuthDto) => {
        const ofStill = (assets: { id: string; livePhotoVideoId?: string | null }[], stillId = still.id) =>
          assets.find(({ id }) => id === stillId)?.livePhotoVideoId;
        const [duplicate] = await duplicates.getDuplicates(auth);
        const [stackListed] = await stacks.search(auth, {});
        const [memoryListed] = await memories.search(auth, {});
        const { archives } = await downloads.getDownloadInfo(auth, { assetIds: [still.id] });
        const stackRead = await stacks.get(auth, stack.id);
        const memoryRead = await memories.get(auth, memory.id);
        return {
          stack: ofStill(stackRead.assets),
          stacks: ofStill(stackListed.assets),
          memory: ofStill(memoryRead.assets),
          memories: ofStill(memoryListed.assets),
          duplicates: ofStill(duplicate.assets, duplicateIds[0]),
          download: archives.flatMap(({ assetIds }) => assetIds).toSorted(),
        };
      };
      StorageCore.setMediaLocation('/photos');
      onTestFinished(() => StorageCore.reset());
      const ordinary = factory.auth({ user, session: { hasElevatedPermission: false } });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      const revealing = { ...elevated, revealedLocks: { albumIds: [album.id], containerIds: [] } };

      await expect(presented(ordinary)).resolves.toEqual({ ...lists(null), download: [still.id] });
      // the requested download is direct-by-id: elevation reaches the motion part, as asset.download would
      await expect(presented(elevated)).resolves.toEqual({
        ...lists(null),
        download: [still.id, motion.id].toSorted(),
      });
      await expect(presented(revealing)).resolves.toEqual({
        ...lists(motion.id),
        download: [still.id, motion.id].toSorted(),
      });
    });

    it('isMotion filters on the same reachability: a still whose motion part is hidden is no Live Photo', async () => {
      const { ctx } = setup();
      const { user: owner, still, album } = await newLivePhoto(ctx);
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
      const { still: plainStill, user: lockless } = await newLivePhoto(ctx, { lock: false });
      const elevated = factory.auth({ user: owner, session: { hasElevatedPermission: true } });
      const revealing = { ...elevated, revealedLocks: { albumIds: [album.id], containerIds: [] } };

      for (const auth of [
        factory.auth({ user: owner }),
        elevated,
        factory.auth({ user: partner }),
        factory.auth({ user: partner, session: { hasElevatedPermission: true } }),
      ]) {
        await expect(found(auth, still.id, true)).resolves.toEqual([false, false]);
        await expect(found(auth, still.id, false)).resolves.toEqual([true, true]);
      }
      // revealed, the list rule reaches the motion part again
      await expect(found(revealing, still.id, true)).resolves.toEqual([true, true]);
      await expect(found(revealing, still.id, false)).resolves.toEqual([false, false]);
      // no locks: unchanged
      await expect(found(factory.auth({ user: lockless }), plainStill.id, true)).resolves.toEqual([true, true]);
      await expect(found(factory.auth({ user: lockless }), plainStill.id, false)).resolves.toEqual([false, false]);
    });

    it('a user without locks sees the motion id unchanged', async () => {
      const { sut, ctx } = setup();
      const { user, still, motion } = await newLivePhoto(ctx, { lock: false });
      const auth = factory.auth({ user, session: { hasElevatedPermission: false } });

      await expect(sut.get(auth, still.id)).resolves.toMatchObject({ livePhotoVideoId: motion.id });
      await expect(listed(auth, still.id)).resolves.toEqual(everywhere(motion.id));
    });
  });

  /**
   * Fork (ruling R58): asset-level websocket events go to the owner's room, which every session of the owner joins -
   * elevated or not - so they follow the owner's non-elevated direct rule.
   */
  describe('owner-room websocket events (R58)', () => {
    it("an update of a visible still sends the event without the hidden motion part's id", async () => {
      const { sut, ctx } = setup();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user, still } = await newLivePhoto(ctx);

      await sut.update(factory.auth({ user }), still.id, { isFavorite: true });
      await sut.updateAll(factory.auth({ user }), { ids: [still.id], isFavorite: false });

      expect(updatesSent(ctx)).toEqual([
        { room: user.id, id: still.id, livePhotoVideoId: null },
        { room: user.id, id: still.id, livePhotoVideoId: null },
      ]);
    });

    it("an update of a hidden asset reaches only the owner's elevated sessions, never the user room", async () => {
      const { sut, ctx } = setup();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user, motion } = await newLivePhoto(ctx);
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, album.id);
      const { session: elevatedSession } = await ctx.newSession({
        userId: user.id,
        pinExpiresAt: new Date(Date.now() + 60_000),
      });
      await ctx.newSession({ userId: user.id });
      await ctx.newSession({ userId: user.id, pinExpiresAt: new Date(Date.now() - 60_000) });
      const elevated = factory.auth({ user, session: { id: elevatedSession.id, hasElevatedPermission: true } });

      await sut.update(elevated, hidden.id, { isFavorite: true });
      await sut.updateAll(elevated, { ids: [hidden.id, motion.id], isFavorite: false });

      // getByIds does not order the bulk update's events
      const sent = updatesSent(ctx).map(({ room, id }) => `${room}/${id}`);
      expect(sent.toSorted()).toEqual(
        [hidden.id, hidden.id, motion.id].map((id) => `${elevatedSession.id}/${id}`).toSorted(),
      );
    });

    it('a user without locks gets the events unchanged in the user room', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user, still, motion } = await newLivePhoto(ctx, { lock: false });

      await sut.update(factory.auth({ user }), still.id, { isFavorite: true });

      expect(updatesSent(ctx)).toEqual([{ room: user.id, id: still.id, livePhotoVideoId: motion.id }]);
    });

    it("upload-ready and edit-ready payloads withhold the hidden motion part's id; a hidden asset's go to elevated sessions", async () => {
      const { ctx } = setup();
      const { sut: jobs, ctx: jobCtx } = newMediumService(JobService, {
        database: defaultDatabase,
        real: [
          AccessRepository,
          AlbumRepository,
          AssetEditRepository,
          AssetRepository,
          LockRepository,
          SessionRepository,
        ],
        mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
      });
      jobCtx.getMock(EventRepository).emit.mockResolvedValue();
      jobCtx.getMock(JobRepository).run.mockResolvedValue(JobStatus.Success);
      jobCtx.getMock(JobRepository).queueAll.mockResolvedValue();
      jobCtx.getMock(WebsocketRepository).clientSend.mockReturnValue();
      const { user, still, album } = await newLivePhoto(ctx);
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: hidden.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: hidden.id });
      const { session } = await ctx.newSession({ userId: user.id, pinExpiresAt: new Date(Date.now() + 60_000) });

      for (const id of [still.id, hidden.id]) {
        await jobs.onJobRun(QueueName.ThumbnailGeneration, {
          name: JobName.AssetGenerateThumbnails,
          data: { id, source: 'upload' },
        });
        await jobs.onJobRun(QueueName.ThumbnailGeneration, {
          name: JobName.AssetEditThumbnailGeneration,
          data: { id },
        });
      }

      const sent = jobCtx.getMock(WebsocketRepository).clientSend.mock.calls.map(([event, room, payload]) => {
        const asset = ((payload as { asset?: unknown }).asset ?? payload) as { id: string; livePhotoVideoId: unknown };
        return { event, room, id: asset.id, livePhotoVideoId: asset.livePhotoVideoId };
      });
      const ofStill = { room: user.id, id: still.id, livePhotoVideoId: null };
      const ofHidden = { room: session.id, id: hidden.id, livePhotoVideoId: null };
      expect(sent).toEqual([
        { event: 'on_upload_success', ...ofStill },
        { event: 'AssetUploadReadyV2', ...ofStill },
        { event: 'AssetEditReadyV2', ...ofStill },
        { event: 'on_upload_success', ...ofHidden },
        { event: 'AssetUploadReadyV2', ...ofHidden },
        { event: 'AssetEditReadyV2', ...ofHidden },
      ]);
    });
  });
});
