import { BadRequestException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole, AssetOrder, AssetVisibility } from 'src/enum';
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
    it('getTimeBuckets should apply the smart filter as an assetFilter subquery', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      const owner = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBuckets.mockResolvedValue([
        { timeBucket: '2024-12-01', count: 2 },
        { timeBucket: '2024-11-01', count: 1 },
      ]);

      const result = await sut.getTimeBuckets(authStub.admin, { albumId: 'smart-album-id' });

      expect(result).toEqual([
        { timeBucket: '2024-12-01', count: 2 },
        { timeBucket: '2024-11-01', count: 1 },
      ]);
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        expect.objectContaining({
          albumId: undefined,
          assetFilter: expect.objectContaining({ isFavorite: true, userIds: [owner.id] }),
        }),
      );
    });

    it('getTimeBuckets should preserve request-level options alongside the smart filter', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(authStub.admin, {
        albumId: 'smart-album-id',
        order: AssetOrder.Asc,
        withStacked: true,
      });

      // Request options ride through to the bucket query; membership is the subquery.
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        expect.objectContaining({
          order: AssetOrder.Asc,
          withStacked: true,
          assetFilter: expect.objectContaining({ isFavorite: true }),
        }),
      );
    });

    it('getTimeBucket should apply the smart filter as an assetFilter subquery', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true })
        .build();
      const owner = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      const json = `{"id":["asset-1","asset-2"]}`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      const result = await sut.getTimeBucket(authStub.admin, {
        albumId: 'smart-album-id',
        timeBucket: '2024-12-01',
      });

      expect(result).toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        '2024-12-01',
        expect.objectContaining({
          albumId: undefined,
          assetFilter: expect.objectContaining({ isFavorite: true, userIds: [owner.id] }),
        }),
        authStub.admin,
      );
    });

    it('should carry an archive filter visibility inside the membership subquery', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ visibility: AssetVisibility.Archive })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: '{"id":["asset-1"]}' });

      await sut.getTimeBucket(authStub.admin, { albumId: 'smart-album-id', timeBucket: '2024-12-01' });

      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        '2024-12-01',
        expect.objectContaining({
          assetFilter: expect.objectContaining({ visibility: AssetVisibility.Archive }),
        }),
        authStub.admin,
      );
    });

    it('should strip locked visibility from a legacy stored filter', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ visibility: AssetVisibility.Locked as never, isFavorite: true })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(authStub.admin, { albumId: 'smart-album-id' });

      // Rows written before the visibility restriction may still carry locked; evaluating it
      // would bypass the elevated-permission requirement, so it must be dropped.
      const options = mocks.asset.getTimeBuckets.mock.calls.at(-1)![0];
      expect(options.assetFilter).toEqual(expect.objectContaining({ isFavorite: true }));
      expect(options.assetFilter).not.toHaveProperty('visibility');
    });

    it('should fail closed when the legacy filter has no effective criteria left', async () => {
      // Only field is stripped at evaluation time -> the album presents as EMPTY, without
      // touching the album_asset path (legacy/corrupt rows there must not surface).
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ visibility: AssetVisibility.Locked as never })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));

      const result = await sut.getTimeBuckets(authStub.admin, { albumId: 'smart-album-id' });

      expect(result).toEqual([]);
      expect(mocks.asset.getTimeBuckets).not.toHaveBeenCalled();
    });

    it('getTimeBucket should present an unevaluable smart album as an empty bucket', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ visibility: AssetVisibility.Locked as never })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: '{"id":[]}' });

      const result = await sut.getTimeBucket(authStub.admin, {
        albumId: 'smart-album-id',
        timeBucket: '2024-12-01',
      });

      expect(JSON.parse(result)).toEqual(expect.objectContaining({ id: [] }));
      // The repository produces the authoritative empty payload: match nothing via
      // assetIds: [], never via the album_asset join.
      const options = mocks.asset.getTimeBucket.mock.calls.at(-1)![1];
      expect(options.assetIds).toEqual([]);
      expect(options).not.toHaveProperty('assetFilter');
      expect(options.albumId).toBeUndefined();
    });

    it('should strip trash filters from a legacy stored filter', async () => {
      const smartAlbum = AlbumFactory.from({ id: 'smart-album-id' })
        .kind(AlbumKind.Smart)
        .filter({ isFavorite: true, ...({ trashedAfter: new Date('2024-01-01T00:00:00Z') } as object) })
        .build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['smart-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(smartAlbum));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(authStub.admin, { albumId: 'smart-album-id' });

      // trashedAfter would flip the search builder's withDeleted flag and surface the
      // owner's trashed assets to sharees.
      const options = mocks.asset.getTimeBuckets.mock.calls.at(-1)![0];
      expect(options.assetFilter).toEqual(expect.objectContaining({ isFavorite: true }));
      expect(options.assetFilter).not.toHaveProperty('trashedAfter');
    });

    it('getTimeBuckets should use the asset repository path for a regular album', async () => {
      const regularAlbum = AlbumFactory.from({ id: 'regular-album-id' }).build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['regular-album-id']));
      mocks.album.getById.mockResolvedValue(getForAlbum(regularAlbum));
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: '2024-01-01', count: 5 }]);

      const result = await sut.getTimeBuckets(authStub.admin, { albumId: 'regular-album-id' });

      expect(result).toEqual([{ timeBucket: '2024-01-01', count: 5 }]);
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(expect.objectContaining({ albumId: 'regular-album-id' }));
      expect(mocks.asset.getTimeBuckets.mock.calls.at(-1)![0]).not.toHaveProperty('assetFilter');
    });
  });
});
