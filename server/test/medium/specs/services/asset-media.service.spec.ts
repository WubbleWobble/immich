import { ExecutionContext } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { lastValueFrom, of } from 'rxjs';
import { AssetMediaStatus, AssetRejectReason, AssetUploadAction } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaSize } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, AssetFileType, ImmichHeader, SharedLinkType } from 'src/enum.js';
import { AssetUploadInterceptor } from 'src/middleware/asset-upload.interceptor.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AssetMediaService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      CryptoRepository,
      LockRepository,
      SharedLinkRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const lockUploadDto = () => ({
  fileModifiedAt: new Date(),
  fileCreatedAt: new Date(),
  assetData: Buffer.from('some data'),
});

const setupLocked = async () => {
  const { sut, ctx } = setup();
  ctx.getMock(StorageRepository).utimes.mockResolvedValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();

  const { user } = await ctx.newUser();
  const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
  const { asset: hiddenTrashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
  const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
  const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id, hiddenTrashed.id]);
  await ctx.get(LockRepository).lockAlbum(user.id, locked.id);
  const ordinary = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });
  const elevated = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
  const countAssets = async () => {
    const rows = await ctx.database.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute();
    return rows.length;
  };
  return { sut, ctx, user, hidden, hiddenTrashed, visible, ordinary, elevated, countAssets };
};

const intercept = async (sut: AssetMediaService, auth: AuthDto, checksum: Buffer) => {
  const interceptor = new AssetUploadInterceptor(sut);
  const res = { status: vitest.fn() };
  const req = { user: auth, headers: { [ImmichHeader.Checksum]: checksum.toString('hex') } };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  const handled = of({ status: AssetMediaStatus.CREATED, id: 'from-the-upload-handler' });
  const next = { handle: vitest.fn(() => handled) };
  const observable = await interceptor.intercept(context, next);
  return { result: await lastValueFrom(observable), next, res };
};

describe(AssetService.name, () => {
  describe('uploadAsset', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const fileSizeInByte = 12_345;

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte });
      const auth = factory.auth({ user: { id: user.id } });

      await expect(
        sut.uploadAsset(
          auth,
          {
            fileModifiedAt: new Date(),
            fileCreatedAt: new Date(),
            assetData: Buffer.from('some data'),
          },
          mediumFactory.uploadFile({ size: fileSizeInByte }),
        ),
      ).resolves.toEqual({
        id: expect.any(String),
        status: AssetMediaStatus.CREATED,
      });

      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetCreate', {
        asset: expect.objectContaining({}),
        file: expect.objectContaining({ size: fileSizeInByte }),
      });
    });

    it('should work with an empty metadata list', async () => {
      const { sut, ctx } = setup();

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });
      const auth = factory.auth({ user: { id: user.id } });
      const file = mediumFactory.uploadFile();

      await expect(
        sut.uploadAsset(
          auth,
          {
            fileModifiedAt: new Date(),
            fileCreatedAt: new Date(),
            assetData: Buffer.from('some data'),
            metadata: [],
          },
          file,
        ),
      ).resolves.toEqual({
        id: expect.any(String),
        status: AssetMediaStatus.CREATED,
      });
    });

    it('should add to a shared link', async () => {
      const { sut, ctx } = setup();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Individual,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const file = mediumFactory.uploadFile();
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, file);
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });

      const update = await sharedLinkRepo.get(user.id, sharedLink.id);
      const assets = update!.assets;
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ id: response.id });
    });

    it('should handle adding a duplicate asset to a shared link', async () => {
      const { sut, ctx } = setup();

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Individual,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
        assetIds: [asset.id],
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile({ checksum: asset.checksum }));
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.DUPLICATE });

      const update = await sharedLinkRepo.get(user.id, sharedLink.id);
      const assets = update!.assets;
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ id: response.id });
    });

    it('should add to an album shared link', async () => {
      const { sut, ctx } = setup();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: album.id,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile());
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });

      const result = await ctx.get(AlbumRepository).getAssetIds(album.id, [response.id]);
      const assets = [...result];
      expect(assets).toHaveLength(1);
      expect(assets[0]).toEqual(response.id);

      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album.id,
        userIds: [user.id],
        recipientIds: [user.id],
      });
    });

    it('should handle adding a duplicate asset to an album shared link', async () => {
      const { sut, ctx } = setup();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      // await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: album.id,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile({ checksum: asset.checksum }));
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.DUPLICATE });

      const result = await ctx.get(AlbumRepository).getAssetIds(album.id, [response.id]);
      const assets = [...result];
      expect(assets).toHaveLength(1);
      expect(assets[0]).toEqual(response.id);
    });
  });

  describe('fork locks', () => {
    it('shared-link upload matching a hidden asset checksum neither adds it to the link/album nor reveals its id', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id });
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      await ctx.get(LockRepository).lockAlbum(user.id, locked.id);
      const { album: open } = await ctx.newAlbum({ ownerId: user.id });

      const linkDto = {
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      };
      const individualLink = await sharedLinkRepo.create({
        ...linkDto,
        key: randomBytes(50),
        type: SharedLinkType.Individual,
      });
      const albumLink = await sharedLinkRepo.create({
        ...linkDto,
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: open.id,
      });
      const uploadDto = { fileModifiedAt: new Date(), fileCreatedAt: new Date(), assetData: Buffer.from('some data') };

      for (const sharedLink of [individualLink, albumLink]) {
        const auth = factory.auth({ user: { id: user.id }, sharedLink });

        // the checksum pre-check (x-immich-checksum) falls through to a regular upload instead of naming the asset
        await expect(sut.getUploadAssetIdByChecksum(auth, hidden.checksum.toString('hex'))).resolves.toBeUndefined();

        // the response is shaped like a fresh upload (ruling R32): no DUPLICATE status, no hidden id
        const response = await sut.uploadAsset(
          auth,
          uploadDto,
          mediumFactory.uploadFile({ checksum: hidden.checksum }),
        );
        expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });
        expect(response.id).not.toEqual(hidden.id);
        // same keys in the same order as a fresh upload (the body is not schema-serialized)
        expect(JSON.stringify(Object.keys(response))).toBe(JSON.stringify(['id', 'status']));
      }

      // the hidden asset was added to neither the individual link nor the album behind the album link
      const individual = await sharedLinkRepo.get(user.id, individualLink.id);
      expect(individual!.assets).toEqual([]);
      await expect(ctx.get(AlbumRepository).getAssetIds(open.id, [hidden.id])).resolves.toEqual(new Set());
      await expect(
        ctx.database.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([{ id: hidden.id }]);

      // a link that already grants the asset (an album link to the locked album itself) reveals nothing new
      const lockedLink = await sharedLinkRepo.create({
        ...linkDto,
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: locked.id,
      });
      const lockedLinkAuth = factory.auth({ user: { id: user.id }, sharedLink: lockedLink });
      await expect(
        sut.uploadAsset(lockedLinkAuth, uploadDto, mediumFactory.uploadFile({ checksum: hidden.checksum })),
      ).resolves.toEqual({ id: hidden.id, status: AssetMediaStatus.DUPLICATE });
      // ...but the granted hidden duplicate is not re-filed through the link (R36-5): no album write, no event
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AlbumUpdate', expect.anything());
    });

    it('a hidden duplicate granted through a smart-album link adds no album_asset row', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id }, [hidden.id]);
      const { album: smart } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { isFavorite: true },
      });
      await ctx.get(LockRepository).lockAlbum(user.id, locked.id);
      await ctx.get(LockRepository).lockAlbum(user.id, smart.id);
      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: smart.id,
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = { fileModifiedAt: new Date(), fileCreatedAt: new Date(), assetData: Buffer.from('some data') };
      await expect(
        sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile({ checksum: hidden.checksum })),
      ).resolves.toEqual({ id: hidden.id, status: AssetMediaStatus.DUPLICATE });

      await expect(
        ctx.database.selectFrom('album_asset').select('assetId').where('albumId', '=', smart.id).execute(),
      ).resolves.toEqual([]);
      await expect(
        ctx.database
          .selectFrom('shared_link_asset')
          .select('assetId')
          .where('sharedLinkId', '=', sharedLink.id)
          .execute(),
      ).resolves.toEqual([]);
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AlbumUpdate', expect.anything());
    });

    describe('ordinary-session duplicates (R49)', () => {
      it('the checksum pre-check names no hidden asset and falls through like a brand-new checksum', async () => {
        const { sut, hidden, hiddenTrashed, ordinary } = await setupLocked();

        for (const checksum of [hidden.checksum, hiddenTrashed.checksum, randomBytes(20)]) {
          await expect(sut.getUploadAssetIdByChecksum(ordinary, checksum.toString('hex'))).resolves.toBeUndefined();

          const { result, next, res } = await intercept(sut, ordinary, checksum);
          expect(next.handle).toHaveBeenCalledTimes(1);
          expect(res.status).not.toHaveBeenCalled();
          expect(result).toEqual({ status: AssetMediaStatus.CREATED, id: 'from-the-upload-handler' });
        }
      });

      it('bulkUploadCheck reports a hidden match exactly like a brand-new checksum', async () => {
        const { sut, hidden, hiddenTrashed, visible, ordinary } = await setupLocked();

        const response = await sut.bulkUploadCheck(ordinary, {
          assets: [
            { id: 'hidden', checksum: hidden.checksum.toString('hex') },
            { id: 'hidden-trashed', checksum: hiddenTrashed.checksum.toString('hex') },
            { id: 'brand-new', checksum: randomBytes(20).toString('hex') },
            { id: 'visible', checksum: visible.checksum.toString('hex') },
          ],
        });

        expect(response).toEqual({
          results: [
            { id: 'hidden', action: AssetUploadAction.ACCEPT },
            { id: 'hidden-trashed', action: AssetUploadAction.ACCEPT },
            { id: 'brand-new', action: AssetUploadAction.ACCEPT },
            {
              id: 'visible',
              action: AssetUploadAction.REJECT,
              reason: AssetRejectReason.DUPLICATE,
              assetId: visible.id,
              isTrashed: false,
            },
          ],
        });
        expect(Object.keys(response.results[0])).toEqual(Object.keys(response.results[2]));
      });

      it('an upload hitting the checksum conflict of a hidden asset answers with a phantom CREATED and stores nothing', async () => {
        const { sut, ctx, hidden, hiddenTrashed, ordinary, countAssets } = await setupLocked();
        const before = await countAssets();

        for (const checksum of [hidden.checksum, hiddenTrashed.checksum]) {
          const response = await sut.uploadAsset(ordinary, lockUploadDto(), mediumFactory.uploadFile({ checksum }));
          expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });
          // same keys in the same order as a fresh upload: the JSON body is not serialized through a schema
          expect(JSON.stringify(Object.keys(response))).toBe(JSON.stringify(['id', 'status']));
          expect([hidden.id, hiddenTrashed.id]).not.toContain(response.id);
          // the phantom id is never stored
          await expect(
            ctx.database.selectFrom('asset').select('id').where('id', '=', response.id).execute(),
          ).resolves.toEqual([]);
        }

        expect(await countAssets()).toBe(before);
        expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AssetCreate', expect.anything());

        // a brand-new checksum has the same response shape (and is stored)
        const fresh = await sut.uploadAsset(ordinary, lockUploadDto(), mediumFactory.uploadFile());
        expect(fresh).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });
        expect(JSON.stringify(Object.keys(fresh))).toBe(JSON.stringify(['id', 'status']));
        expect(await countAssets()).toBe(before + 1);
      });

      it('an elevated owner keeps the real duplicate behaviour', async () => {
        const { sut, hidden, hiddenTrashed, elevated, countAssets } = await setupLocked();
        const before = await countAssets();

        await expect(sut.getUploadAssetIdByChecksum(elevated, hidden.checksum.toString('hex'))).resolves.toEqual({
          id: hidden.id,
          status: AssetMediaStatus.DUPLICATE,
        });
        const { result, next } = await intercept(sut, elevated, hidden.checksum);
        expect(next.handle).not.toHaveBeenCalled();
        expect(result).toEqual({ id: hidden.id, status: AssetMediaStatus.DUPLICATE });

        await expect(
          sut.bulkUploadCheck(elevated, {
            assets: [
              { id: 'hidden', checksum: hidden.checksum.toString('hex') },
              { id: 'hidden-trashed', checksum: hiddenTrashed.checksum.toString('hex') },
            ],
          }),
        ).resolves.toEqual({
          results: [
            {
              id: 'hidden',
              action: AssetUploadAction.REJECT,
              reason: AssetRejectReason.DUPLICATE,
              assetId: hidden.id,
              isTrashed: false,
            },
            {
              id: 'hidden-trashed',
              action: AssetUploadAction.REJECT,
              reason: AssetRejectReason.DUPLICATE,
              assetId: hiddenTrashed.id,
              isTrashed: true,
            },
          ],
        });

        await expect(
          sut.uploadAsset(elevated, lockUploadDto(), mediumFactory.uploadFile({ checksum: hidden.checksum })),
        ).resolves.toEqual({ id: hidden.id, status: AssetMediaStatus.DUPLICATE });
        expect(await countAssets()).toBe(before);
      });

      it('a visible duplicate keeps the upstream behaviour in an ordinary session', async () => {
        const { sut, visible, ordinary, countAssets } = await setupLocked();
        const before = await countAssets();

        await expect(sut.getUploadAssetIdByChecksum(ordinary, visible.checksum.toString('hex'))).resolves.toEqual({
          id: visible.id,
          status: AssetMediaStatus.DUPLICATE,
        });
        const { result, next, res } = await intercept(sut, ordinary, visible.checksum);
        expect(next.handle).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(result).toEqual({ id: visible.id, status: AssetMediaStatus.DUPLICATE });

        await expect(
          sut.uploadAsset(ordinary, lockUploadDto(), mediumFactory.uploadFile({ checksum: visible.checksum })),
        ).resolves.toEqual({ id: visible.id, status: AssetMediaStatus.DUPLICATE });
        expect(await countAssets()).toBe(before);
      });
    });

    it('an upload through a (legacy, upload-enabled) smart-album link files nothing into the smart album', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { album: smart } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { isFavorite: true },
      });
      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: smart.id,
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = { fileModifiedAt: new Date(), fileCreatedAt: new Date(), assetData: Buffer.from('some data') };
      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile());
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });

      await expect(
        ctx.database.selectFrom('album_asset').select('assetId').where('albumId', '=', smart.id).execute(),
      ).resolves.toEqual([]);
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AlbumUpdate', expect.anything());
    });
  });

  describe('viewThumbnail', () => {
    it('should return original thumbnail by default when both exist', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should return edited thumbnail when edited=true', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: true });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/edited/preview.jpg');
    });

    it('should return original thumbnail when edited=false', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: false });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should return original thumbnail when only original exists and edited=false', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create only original thumbnail
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: false });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should return original thumbnail when only original exists and edited=true', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create only original thumbnail
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: true });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should work with thumbnail size', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Thumbnail,
        path: '/original/thumbnail.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Thumbnail,
        path: '/edited/thumbnail.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });

      // Test default (should get original)
      const resultDefault = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.THUMBNAIL });
      expect(resultDefault).toBeInstanceOf(ImmichFileResponse);
      expect((resultDefault as ImmichFileResponse).path).toBe('/original/thumbnail.jpg');

      // Test edited=true (should get edited)
      const resultEdited = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.THUMBNAIL, edited: true });
      expect(resultEdited).toBeInstanceOf(ImmichFileResponse);
      expect((resultEdited as ImmichFileResponse).path).toBe('/edited/thumbnail.jpg');
    });
  });
});
