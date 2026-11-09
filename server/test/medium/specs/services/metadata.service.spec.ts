import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, newRandomImage } from 'test/utils.js';

type TimeZoneTest = {
  description: string;
  serverTimeZone?: string;
  exifData: Record<string, any>;
  expected: {
    localDateTime: string;
    dateTimeOriginal: string;
    timeZone: string | null;
  };
};

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(MetadataService, {
    database: db || defaultDatabase,
    real: [
      AlbumRepository,
      AssetRepository,
      AssetJobRepository,
      ConfigRepository,
      LockRepository,
      MetadataRepository,
      SystemMetadataRepository,
      TagRepository,
    ],
    mock: [EventRepository, StorageRepository, LoggingRepository],
  });

  ctx.getMock(StorageRepository).stat.mockResolvedValue({
    size: 123_456,
    mtime: new Date(654_321),
    mtimeMs: 654_321,
    birthtimeMs: 654_322,
  } as Stats);

  return { sut, ctx };
};

const createTestFile = async (exifData: Record<string, any>) => {
  const { ctx } = setup();
  const data = newRandomImage();
  const filePath = join(tmpdir(), 'test.png');
  await writeFile(filePath, data);
  await ctx.get(MetadataRepository).writeTags(filePath, exifData);
  return { filePath };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** A still and a motion video sharing a livePhotoCID, each in its own album (optionally locked). */
const setupLivePhoto = async ({ lockStill, lockMotion }: { lockStill: boolean; lockMotion: boolean }) => {
  const { sut, ctx } = setup();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const cid = randomUUID().toUpperCase();

  const { user } = await ctx.newUser();
  const { asset: still } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  await ctx.newExif({ assetId: still.id, livePhotoCID: cid });
  const { asset: motion } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Video,
    visibility: AssetVisibility.Timeline,
  });
  await ctx.newExif({ assetId: motion.id, livePhotoCID: cid });
  const { album: stillAlbum } = await ctx.newAlbum({ ownerId: user.id }, [still.id]);
  const { album: motionAlbum } = await ctx.newAlbum({ ownerId: user.id }, [motion.id]);
  if (lockStill) {
    await ctx.get(LockRepository).lockAlbum(user.id, stillAlbum.id);
  }
  if (lockMotion) {
    await ctx.get(LockRepository).lockAlbum(user.id, motionAlbum.id);
  }

  const state = async () => {
    const rows = await ctx.database
      .selectFrom('asset')
      .select(['id', 'livePhotoVideoId', 'visibility'])
      .where('id', 'in', [still.id, motion.id])
      .execute();
    const motionAlbums = await ctx.database
      .selectFrom('album_asset')
      .select('albumId')
      .where('assetId', '=', motion.id)
      .execute();
    return {
      livePhotoVideoId: rows.find(({ id }) => id === still.id)?.livePhotoVideoId,
      motionVisibility: rows.find(({ id }) => id === motion.id)?.visibility,
      motionAlbums,
    };
  };
  // the job step that runs once the still's metadata (with its livePhotoCID) is extracted
  // (the still's or the motion's, whichever is extracted second)
  const link = (from: 'still' | 'motion') => {
    const asset = from === 'still' ? still : motion;
    return sut['linkLivePhotos'](
      { id: asset.id, type: asset.type, ownerId: user.id, libraryId: null },
      { assetId: asset.id, livePhotoCID: cid },
    );
  };
  return { ctx, still, motion, motionAlbum, state, link };
};

describe(MetadataService.name, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should be defined', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  describe('handleMetadataExtraction', () => {
    const timeZoneTests: TimeZoneTest[] = [
      {
        description: 'should handle no time zone information',
        exifData: {
          DateTimeOriginal: '2022:01:01 00:00:00',
        },
        expected: {
          localDateTime: '2022-01-01T00:00:00.000Z',
          dateTimeOriginal: '2022-01-01T00:00:00.000Z',
          timeZone: null,
        },
      },
      {
        description: 'should handle a +13:00 time zone',
        exifData: {
          DateTimeOriginal: '2022:01:01 00:00:00+13:00',
        },
        expected: {
          localDateTime: '2022-01-01T00:00:00.000Z',
          dateTimeOriginal: '2021-12-31T11:00:00.000Z',
          timeZone: 'UTC+13',
        },
      },
    ];

    it.each(timeZoneTests)('$description', async ({ exifData, serverTimeZone, expected }) => {
      vi.stubEnv('TZ', serverTimeZone);

      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile(exifData);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['dateTimeOriginal', 'timeZone', 'lockedProperties'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        dateTimeOriginal: new Date(expected.dateTimeOriginal),
        timeZone: expected.timeZone,
        lockedProperties: null,
      });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ localDateTime: new Date(expected.localDateTime) }),
      );
    });

    it('should handle dates far in the future', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ CreateDate: '42603:05:04 04:12:48' });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .where('assetId', '=', asset.id)
          .select('dateTimeOriginal')
          .executeTakeFirstOrThrow(),
        // note that this date is technically wrong. it does not throw though and should get the user's attention either way.
      ).resolves.toEqual({ dateTimeOriginal: new Date('4260-03-05T04:04:12.000Z') });
    });

    it('should ignore IFD1 thumbnail orientation when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD1:Orientation#': 6 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('orientation')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ orientation: null });
    });

    it('should ignore IFD1 thumbnail dimensions when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD1:ImageWidth#': 160, 'IFD1:ImageHeight#': 120 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ width: 1, height: 1 }),
      );
    });

    it('should keep IFD0 orientation when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD0:Orientation#': 6 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('orientation')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ orientation: '6' });
    });
  });

  it('should handle float lens models (#30492)', async () => {
    const { sut, ctx } = setup();
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    const { filePath } = await createTestFile({ LensModel: 1.8 });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, description: '' });

    await sut.handleMetadataExtraction({ id: asset.id });

    await expect(
      ctx.database
        .selectFrom('asset_exif')
        .where('assetId', '=', asset.id)
        .select('lensModel')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ lensModel: '1.8' });
  });

  describe('live photo auto-linking and locks', () => {
    it("does not link a visible still to a motion asset hidden by the owner's locks, nor touch it", async () => {
      for (const from of ['still', 'motion'] as const) {
        const { ctx, motionAlbum, state, link } = await setupLivePhoto({ lockStill: false, lockMotion: true });

        await link(from);

        await expect(state()).resolves.toEqual({
          livePhotoVideoId: null,
          motionVisibility: AssetVisibility.Timeline,
          motionAlbums: [{ albumId: motionAlbum.id }],
        });
        expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalledWith('AssetHide', expect.anything());
      }
    });

    it.each([
      { lockStill: false, lockMotion: false, title: 'both visible' },
      { lockStill: true, lockMotion: true, title: 'both hidden' },
    ])('links as upstream when $title', async ({ lockStill, lockMotion }) => {
      const { ctx, motion, state, link } = await setupLivePhoto({ lockStill, lockMotion });

      await link('still');

      await expect(state()).resolves.toEqual({
        livePhotoVideoId: motion.id,
        motionVisibility: AssetVisibility.Hidden,
        motionAlbums: [],
      });
      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetHide', {
        assetId: motion.id,
        userId: motion.ownerId,
      });
    });
  });
});
