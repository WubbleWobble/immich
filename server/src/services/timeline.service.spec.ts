import { BadRequestException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole, AssetVisibility } from 'src/enum';
import { TimelineService } from 'src/services/timeline.service';
import { AlbumFactory } from 'test/factories/album.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { getForAlbum } from 'test/mappers';
import { newTestService, ServiceMocks } from 'test/utils';

describe(TimelineService.name, () => {
  let sut: TimelineService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TimelineService));
  });

  describe('getTimeBuckets', () => {
    it("should return buckets if userId and albumId aren't set", async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await expect(sut.getTimeBuckets(authStub.admin, {})).resolves.toEqual(
        expect.arrayContaining([{ timeBucket: 'bucket', count: 1 }]),
      );
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith({
        userIds: [authStub.admin.user.id],
      });
    });

    it('should pass bbox options to repository when all bbox fields are provided', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await sut.getTimeBuckets(authStub.admin, {
        bbox: {
          west: -70,
          south: -30,
          east: 120,
          north: 55,
        },
      });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith({
        userIds: [authStub.admin.user.id],
        bbox: { west: -70, south: -30, east: 120, north: 55 },
      });
    });
  });

  describe('getTimeBucket', () => {
    it('should return the assets for a album time bucket if user has album.read', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(sut.getTimeBucket(authStub.admin, { timeBucket: 'bucket', albumId: 'album-id' })).resolves.toEqual(
        json,
      );

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['album-id']));
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          timeBucket: 'bucket',
          albumId: 'album-id',
        },
        authStub.admin,
      );
    });

    it('should return the assets for a archive time bucket if user has archive.read', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          userIds: [authStub.admin.user.id],
        }),
        authStub.admin,
      );
    });

    it('should include partner shared assets', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Timeline,
          userId: authStub.admin.user.id,
          withPartners: true,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Timeline,
          withPartners: true,
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should check permissions to read tag', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-123']));

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          userId: authStub.admin.user.id,
          tagId: 'tag-123',
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          tagId: 'tag-123',
          timeBucket: 'bucket',
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should return the assets for a library time bucket if user has library.read', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          timeBucket: 'bucket',
          userIds: [authStub.admin.user.id],
        }),
        authStub.admin,
      );
    });

    it('should throw an error if withParners is true and visibility true or undefined', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: undefined,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withParners is true and isFavorite is either true or false', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isFavorite: true,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isFavorite: false,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withParners is true and isTrash is true', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isTrashed: true,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('smart album routing', () => {
    it('getTimeBuckets should query search and bucket results by month for a smart album', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      const owner = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.search.searchTimeBuckets.mockResolvedValue([
        { timeBucket: '2024-12-01', count: 2 },
        { timeBucket: '2024-11-01', count: 1 },
      ]);

      const result = await sut.getTimeBuckets(authStub.admin, { albumId: 'smart-album-id' });

      expect(result).toEqual([
        { timeBucket: '2024-12-01', count: 2 },
        { timeBucket: '2024-11-01', count: 1 },
      ]);
      expect(mocks.search.searchTimeBuckets).toHaveBeenCalledWith(
        expect.objectContaining({ isFavorite: true, userIds: [owner.id] }),
        undefined,
      );
      expect(mocks.asset.getTimeBuckets).not.toHaveBeenCalled();
    });

    it('getTimeBuckets should short-circuit when the smart album has no matching assets', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'empty-smart-album' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['empty-smart-album']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.search.searchTimeBuckets.mockResolvedValue([]);

      const result = await sut.getTimeBuckets(authStub.admin, { albumId: 'empty-smart-album' });

      expect(result).toEqual([]);
      expect(mocks.asset.getTimeBuckets).not.toHaveBeenCalled();
    });

    it('getTimeBucket should query search with date range and return assets for a smart album', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      const owner = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      const json = `{"id":["asset-1","asset-2"]}`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.search.searchAssetIds.mockResolvedValue(['asset-1', 'asset-2']);

      const result = await sut.getTimeBucket(authStub.admin, {
        albumId: 'smart-album-id',
        timeBucket: '2024-12-01',
      });

      expect(result).toEqual(json);
      expect(mocks.search.searchAssetIds).toHaveBeenCalledWith(
        expect.objectContaining({
          isFavorite: true,
          userIds: [owner.id],
          takenAfter: expect.any(Date),
          takenBefore: expect.any(Date),
        }),
      );
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        '2024-12-01',
        expect.objectContaining({
          albumId: undefined,
          assetIds: ['asset-1', 'asset-2'],
          // Search membership defaults to timeline-only; the bucket query must match it
          // rather than fall back to the repository's timeline+archive default.
          visibility: AssetVisibility.Timeline,
        }),
        authStub.admin,
      );
    });

    it('getTimeBucket should carry an archive filter visibility into the bucket query', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ visibility: AssetVisibility.Archive })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: '{"id":["asset-1"]}' });
      mocks.search.searchAssetIds.mockResolvedValue(['asset-1']);

      await sut.getTimeBucket(authStub.admin, { albumId: 'smart-album-id', timeBucket: '2024-12-01' });

      expect(mocks.search.searchAssetIds).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Archive }),
      );
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        '2024-12-01',
        expect.objectContaining({ visibility: AssetVisibility.Archive }),
        authStub.admin,
      );
    });

    it('getTimeBucket should accept a full ISO timeBucket string and derive valid dates', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      const json = `{"id":[]}`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.search.searchAssetIds.mockResolvedValue(['a']);

      await sut.getTimeBucket(authStub.admin, {
        albumId: 'smart-album-id',
        timeBucket: '2024-10-01T00:00:00.000Z',
      });

      const call = mocks.search.searchAssetIds.mock.calls.at(-1)!;
      const options = call[0] as { takenAfter: Date; takenBefore: Date };
      expect(Number.isNaN(options.takenAfter.getTime())).toBe(false);
      expect(Number.isNaN(options.takenBefore.getTime())).toBe(false);
      // The range is widened by a day on each side: it filters on fileCreatedAt while
      // buckets are keyed on localDateTime, which can differ by a timezone offset.
      expect(options.takenAfter.toISOString()).toBe('2024-09-30T00:00:00.000Z');
      expect(options.takenBefore.toISOString()).toBe('2024-11-02T00:00:00.000Z');
    });

    it('getTimeBucket should reject an unparseable timeBucket value', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));

      await expect(
        sut.getTimeBucket(authStub.admin, {
          albumId: 'smart-album-id',
          timeBucket: 'not-a-date',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('getTimeBucket should return an empty payload when a smart-album bucket has no matching assets', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.search.searchAssetIds.mockResolvedValue([]);

      const result = await sut.getTimeBucket(authStub.admin, {
        albumId: 'smart-album-id',
        timeBucket: '2024-12-01',
      });

      expect(JSON.parse(result)).toEqual(expect.objectContaining({ id: [] }));
      expect(mocks.asset.getTimeBucket).not.toHaveBeenCalled();
    });

    it('getTimeBuckets should strip locked visibility from a legacy stored filter', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ visibility: AssetVisibility.Locked as never, isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.search.searchTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(authStub.admin, { albumId: 'smart-album-id' });

      // Rows written before the visibility restriction may still carry locked; evaluating it
      // would bypass the elevated-permission requirement, so it must be dropped.
      expect(mocks.search.searchTimeBuckets).toHaveBeenCalledWith(
        expect.objectContaining({ isFavorite: true }),
        undefined,
      );
      expect(mocks.search.searchTimeBuckets).not.toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Locked }),
        undefined,
      );
    });

    it('getTimeBuckets should use the asset repository path for a regular album', async () => {
      const regularAlbum = AlbumFactory.from({ id: 'regular-album-id' }).build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['regular-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(regularAlbum));
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: '2024-01-01', count: 5 }]);

      const result = await sut.getTimeBuckets(authStub.admin, { albumId: 'regular-album-id' });

      expect(result).toEqual([{ timeBucket: '2024-01-01', count: 5 }]);
      expect(mocks.search.searchTimeBuckets).not.toHaveBeenCalled();
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(expect.objectContaining({ albumId: 'regular-album-id' }));
    });
  });
});
