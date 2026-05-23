import { BadRequestException } from '@nestjs/common';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AlbumKind, AlbumUserRole, AssetOrder, UserMetadataKey } from 'src/enum';
import { AlbumService } from 'src/services/album.service';
import { AlbumUserFactory } from 'test/factories/album-user.factory';
import { AlbumFactory } from 'test/factories/album.factory';
import { AssetFactory } from 'test/factories/asset.factory';
import { AuthFactory } from 'test/factories/auth.factory';
import { UserFactory } from 'test/factories/user.factory';
import { authStub } from 'test/fixtures/auth.stub';
import { getForAlbum } from 'test/mappers';
import { newUuid } from 'test/small.factory';
import { newTestService, ServiceMocks } from 'test/utils';

describe(AlbumService.name, () => {
  let sut: AlbumService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getStatistics', () => {
    it('should get the album count', async () => {
      mocks.album.getAll.mockResolvedValue([]);
      await expect(sut.getStatistics(authStub.admin)).resolves.toEqual({
        owned: 0,
        shared: 0,
        notShared: 0,
      });

      expect(mocks.album.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { isOwned: true });
      expect(mocks.album.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { isShared: true });
      expect(mocks.album.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { isOwned: true, isShared: false });
    });
  });

  describe('getAll', () => {
    it('gets list of albums for auth user', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const sharedWithUserAlbum = AlbumFactory.from().owner(owner).albumUser().build();
      mocks.album.getAll.mockResolvedValue([getForAlbum(album), getForAlbum(sharedWithUserAlbum)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
        {
          albumId: sharedWithUserAlbum.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), {});
      expect(result).toHaveLength(2);
      expect(result[0].id).toEqual(album.id);
      expect(result[1].id).toEqual(sharedWithUserAlbum.id);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, { isOwned: undefined, isShared: undefined });
    });

    it('overlays smart album metadata from search results in the list view', async () => {
      const smartAlbum = AlbumFactory.from().albumUser().kind(AlbumKind.Smart).filter({ isFavorite: true }).build();
      const { user: owner } = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const firstAssetId = newUuid();
      const secondAssetId = newUuid();
      mocks.album.getAll.mockResolvedValue([getForAlbum(smartAlbum)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: smartAlbum.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);
      mocks.search.searchMetadata.mockResolvedValue({
        items: [
          {
            id: firstAssetId,
            fileCreatedAt: new Date('2024-12-25T00:00:00Z'),
            localDateTime: new Date('2024-12-25T00:00:00Z'),
          },
          {
            id: secondAssetId,
            fileCreatedAt: new Date('2024-10-01T00:00:00Z'),
            localDateTime: new Date('2024-10-01T00:00:00Z'),
          },
        ] as any,
        hasNextPage: false,
      });

      const result = await sut.getAll(AuthFactory.create(owner), {});

      expect(result).toHaveLength(1);
      expect(result[0].assetCount).toBe(2);
      expect(result[0].albumThumbnailAssetId).toBe(firstAssetId);
      expect(result[0].startDate).toBeDefined();
      expect(result[0].endDate).toBeDefined();
      expect(mocks.search.searchMetadata).toHaveBeenCalledWith(
        { page: 1, size: 1000 },
        expect.objectContaining({ isFavorite: true, userIds: [owner.id] }),
      );
      // The freshly computed values are persisted to the album row.
      expect(mocks.album.updateCachedMetadata).toHaveBeenCalledWith(
        smartAlbum.id,
        expect.objectContaining({ cachedAssetCount: 2, cachedThumbnailAssetId: firstAssetId }),
      );
    });

    it('serves smart album metadata from the cache when fresh', async () => {
      const cachedThumbnailAssetId = newUuid();
      const computedAt = new Date('2026-05-22T10:00:00Z');
      const smartAlbum = AlbumFactory.from().albumUser().kind(AlbumKind.Smart).filter({ isFavorite: true }).build();
      smartAlbum.cachedAssetCount = 7;
      smartAlbum.cachedThumbnailAssetId = cachedThumbnailAssetId;
      smartAlbum.cachedStartDate = '2024-01-15';
      smartAlbum.cachedEndDate = '2024-12-25';
      smartAlbum.cacheComputedAt = computedAt;
      smartAlbum.cacheInvalidatedAt = null;
      const { user: owner } = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(smartAlbum)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: smartAlbum.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), {});

      expect(result).toHaveLength(1);
      expect(result[0].assetCount).toBe(7);
      expect(result[0].albumThumbnailAssetId).toBe(cachedThumbnailAssetId);
      // Fresh cache means no search query and no rewrite.
      expect(mocks.search.searchMetadata).not.toHaveBeenCalled();
      expect(mocks.album.updateCachedMetadata).not.toHaveBeenCalled();
    });

    it('recomputes smart album metadata when cache is stale', async () => {
      const smartAlbum = AlbumFactory.from().albumUser().kind(AlbumKind.Smart).filter({ isFavorite: true }).build();
      // Older computed timestamp, newer invalidation timestamp -> stale.
      smartAlbum.cachedAssetCount = 1;
      smartAlbum.cachedThumbnailAssetId = newUuid();
      smartAlbum.cacheComputedAt = new Date('2026-05-22T10:00:00Z');
      smartAlbum.cacheInvalidatedAt = new Date('2026-05-22T11:00:00Z');
      const { user: owner } = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const freshAssetId = newUuid();
      mocks.album.getAll.mockResolvedValue([getForAlbum(smartAlbum)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: smartAlbum.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);
      mocks.search.searchMetadata.mockResolvedValue({
        items: [
          {
            id: freshAssetId,
            fileCreatedAt: new Date('2024-12-25T00:00:00Z'),
            localDateTime: new Date('2024-12-25T00:00:00Z'),
          },
        ] as any,
        hasNextPage: false,
      });

      const result = await sut.getAll(AuthFactory.create(owner), {});

      expect(result[0].assetCount).toBe(1);
      expect(result[0].albumThumbnailAssetId).toBe(freshAssetId);
      expect(mocks.search.searchMetadata).toHaveBeenCalledTimes(1);
      expect(mocks.album.updateCachedMetadata).toHaveBeenCalledWith(
        smartAlbum.id,
        expect.objectContaining({ cachedAssetCount: 1, cachedThumbnailAssetId: freshAssetId }),
      );
    });

    it('recomputes smart album metadata on first read (no computedAt)', async () => {
      const smartAlbum = AlbumFactory.from().albumUser().kind(AlbumKind.Smart).filter({ isFavorite: true }).build();
      // cacheComputedAt remains null on a never-read album.
      expect(smartAlbum.cacheComputedAt).toBeNull();
      const { user: owner } = smartAlbum.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const assetId = newUuid();
      mocks.album.getAll.mockResolvedValue([getForAlbum(smartAlbum)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: smartAlbum.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);
      mocks.search.searchMetadata.mockResolvedValue({
        items: [{ id: assetId, fileCreatedAt: new Date('2024-05-01T00:00:00Z'), localDateTime: null }] as any,
        hasNextPage: false,
      });

      await sut.getAll(AuthFactory.create(owner), {});

      expect(mocks.search.searchMetadata).toHaveBeenCalledTimes(1);
      expect(mocks.album.updateCachedMetadata).toHaveBeenCalledTimes(1);
    });

    it('gets list of albums that have a specific asset', async () => {
      const album = AlbumFactory.from()
        .owner({ isAdmin: true })
        .albumUser()
        .asset({}, (builder) => builder.exif())
        .asset({}, (builder) => builder.exif())
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getByAssetId.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { assetId: album.assets[0].id });
      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(album.id);
      expect(mocks.album.getByAssetId).toHaveBeenCalledTimes(1);
    });

    it('gets list of albums that are shared', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isShared: true });
      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(album.id);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isShared: true }));
    });

    it('gets list of albums that are NOT shared', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isShared: false });
      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(album.id);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isShared: false }));
    });

    it('gets only owned albums when isOwned=true', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: album.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: true });
      expect(result).toHaveLength(1);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isOwned: true }));
    });

    it('gets only shared-with-me albums when isOwned=false', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: album.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: false });
      expect(result).toHaveLength(1);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isOwned: false }));
    });

    it('gets owned shared-out albums when isOwned=true and isShared=true', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: album.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: true, isShared: true });
      expect(result).toHaveLength(1);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, { isOwned: true, isShared: true });
    });

    it('returns empty list when isOwned=false and isShared=false', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: false, isShared: false });
      expect(result).toHaveLength(0);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, { isOwned: false, isShared: false });
    });
  });

  it('counts assets correctly', async () => {
    const album = AlbumFactory.create();
    const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
    mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
    mocks.album.getMetadataForIds.mockResolvedValue([
      {
        albumId: album.id,
        assetCount: 1,
        startDate: new Date('1970-01-01'),
        endDate: new Date('1970-01-01'),
        lastModifiedAssetTimestamp: new Date('1970-01-01'),
      },
    ]);

    const result = await sut.getAll(AuthFactory.create(owner), {});
    expect(result).toHaveLength(1);
    expect(result[0].assetCount).toEqual(1);
    expect(mocks.album.getAll).toHaveBeenCalledTimes(1);
  });

  describe('create', () => {
    it('should create a smart album with a filter', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);
      const personId = newUuid();
      const album = AlbumFactory.from()
        .owner(owner)
        .kind(AlbumKind.Smart)
        .filter({ personIds: [personId] })
        .build();

      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.getMetadata.mockResolvedValue([]);

      const result = await sut.create(auth, {
        albumName: 'Smart Album',
        kind: AlbumKind.Smart,
        filter: { personIds: [personId] },
      });

      expect(result.kind).toEqual(AlbumKind.Smart);
      expect(result.filter).toBeDefined();
      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: AlbumKind.Smart,
          filter: { personIds: [personId] },
        }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should reject a smart album payload that includes assetIds', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);

      await expect(
        sut.create(auth, {
          albumName: 'Smart with assets',
          kind: AlbumKind.Smart,
          filter: {},
          assetIds: [newUuid()],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should reject a regular album that includes a filter', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);

      await expect(
        sut.create(auth, {
          albumName: 'Bogus',
          filter: { personIds: [newUuid()] },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should reject a smart album without a filter', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);

      await expect(
        sut.create(auth, {
          albumName: 'No filter',
          kind: AlbumKind.Smart,
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates album', async () => {
      const assetId = newUuid();
      const albumUser = { userId: newUuid(), role: AlbumUserRole.Editor };
      const album = AlbumFactory.from({ albumName: 'test', description: 'description' })
        .asset({ id: assetId }, (asset) => asset.exif())
        .albumUser(albumUser)
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;

      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(UserFactory.create(album.albumUsers[0].user));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.create(AuthFactory.create(owner), {
        albumName: 'test',
        albumUsers: [albumUser],
        description: 'description',
        assetIds: [assetId],
        kind: AlbumKind.Regular,
      });

      expect(mocks.album.create).toHaveBeenCalledWith(
        {
          albumName: 'test',
          description: 'description',
          order: album.order,
          albumThumbnailAssetId: assetId,
          kind: AlbumKind.Regular,
          filter: null,
        },
        [assetId],
        [
          { userId: owner.id, role: AlbumUserRole.Owner },
          { userId: albumUser.userId, role: AlbumUserRole.Editor },
        ],
        owner.id,
      );

      expect(mocks.user.get).toHaveBeenCalledWith(albumUser.userId, {});
      expect(mocks.user.getMetadata).toHaveBeenCalledWith(owner.id);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([assetId]), false);
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: albumUser.userId,
        senderName: owner.name,
      });
    });

    it('creates album with assetOrder from user preferences', async () => {
      const assetId = newUuid();
      const albumUser = { userId: newUuid(), role: AlbumUserRole.Editor };
      const album = AlbumFactory.from()
        .asset({ id: assetId }, (asset) => asset.exif())
        .albumUser(albumUser)
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.create.mockResolvedValue(album.albumUsers[0]);
      mocks.user.get.mockResolvedValue(UserFactory.create(album.albumUsers[1].user));
      mocks.user.getMetadata.mockResolvedValue([
        {
          key: UserMetadataKey.Preferences,
          value: {
            albums: {
              defaultAssetOrder: AssetOrder.Asc,
            },
          },
        },
      ]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.create(AuthFactory.create(owner), {
        albumName: album.albumName,
        albumUsers: [albumUser],
        description: album.description,
        assetIds: [assetId],
        kind: AlbumKind.Regular,
      });

      expect(mocks.album.create).toHaveBeenCalledWith(
        {
          albumName: album.albumName,
          description: album.description,
          order: 'asc',
          albumThumbnailAssetId: assetId,
          kind: AlbumKind.Regular,
          filter: null,
        },
        [assetId],
        [{ userId: owner.id, role: AlbumUserRole.Owner }, albumUser],
        owner.id,
      );

      expect(mocks.user.get).toHaveBeenCalledWith(albumUser.userId, {});
      expect(mocks.user.getMetadata).toHaveBeenCalledWith(owner.id);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([assetId]), false);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: albumUser.userId,
        senderName: owner.name,
      });
    });

    it('should require valid userIds', async () => {
      mocks.user.get.mockResolvedValue(void 0);
      await expect(
        sut.create(AuthFactory.create(), {
          albumName: 'Empty album',
          albumUsers: [{ userId: 'unknown-user', role: AlbumUserRole.Editor }],
          kind: AlbumKind.Regular,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.user.get).toHaveBeenCalledWith('unknown-user', {});
      expect(mocks.album.create).not.toHaveBeenCalled();
    });

    it('should only add assets the user is allowed to access', async () => {
      const assetId = newUuid();
      const album = AlbumFactory.from()
        .asset({ id: assetId }, (asset) => asset.exif())
        .albumUser()
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.user.get.mockResolvedValue(album.albumUsers[0].user);
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.create(AuthFactory.create(owner), {
        albumName: album.albumName,
        description: album.description,
        assetIds: [assetId, 'asset-2'],
        kind: AlbumKind.Regular,
      });

      expect(mocks.album.create).toHaveBeenCalledWith(
        {
          albumName: album.albumName,
          description: album.description,
          order: 'desc',
          albumThumbnailAssetId: assetId,
          kind: AlbumKind.Regular,
          filter: null,
        },
        [assetId],
        [{ userId: owner.id, role: AlbumUserRole.Owner }],
        owner.id,
      );
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([assetId, 'asset-2']), false);
    });

    it('should throw an error if the userId is the ownerId', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.user.get.mockResolvedValue(owner);
      await expect(
        sut.create(AuthFactory.create(owner), {
          albumName: 'Empty album',
          albumUsers: [{ userId: owner.id, role: AlbumUserRole.Editor }],
          kind: AlbumKind.Regular,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should prevent updating an album that does not exist', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.album.getById.mockResolvedValue(void 0);

      await expect(
        sut.update(AuthFactory.create(), 'invalid-id', {
          albumName: 'Album',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should prevent updating a not owned album (shared with auth user)', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.update(AuthFactory.create(owner), album.id, { albumName: 'new album name' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should require a valid thumbnail asset id', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set());

      await expect(
        sut.update(AuthFactory.create(owner), album.id, { albumThumbnailAssetId: 'not-in-album' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.getAssetIds).toHaveBeenCalledWith(album.id, ['not-in-album']);
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow the owner to update the album', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.update.mockResolvedValue(getForAlbum(album));

      await sut.update(AuthFactory.create(owner), album.id, { albumName: 'new album name' });

      expect(mocks.album.update).toHaveBeenCalledTimes(1);
      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        { id: album.id, albumName: 'new album name' },
        owner.id,
      );
    });

    it('should reject changing the album kind', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);
      const album = AlbumFactory.from().owner(owner).kind(AlbumKind.Regular).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));

      await expect(sut.update(auth, album.id, { kind: AlbumKind.Smart } as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should reject setting a filter on a regular album', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);
      const album = AlbumFactory.from().owner(owner).kind(AlbumKind.Regular).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));

      await expect(sut.update(auth, album.id, { filter: { personIds: [newUuid()] } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should update the filter on a smart album', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);
      const album = AlbumFactory.from()
        .owner(owner)
        .kind(AlbumKind.Smart)
        .filter({ personIds: [newUuid()] })
        .build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      const updatedFilter = { tagIds: [newUuid()] };
      mocks.album.update.mockResolvedValue({ ...getForAlbum(album), filter: updatedFilter });

      const result = await sut.update(auth, album.id, { filter: updatedFilter });

      expect(result.filter).toEqual(updatedFilter);
      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        expect.objectContaining({ filter: updatedFilter }),
        owner.id,
      );
    });
  });

  describe('delete', () => {
    it('should require permissions', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.delete(AuthFactory.create(owner), album.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('should not let a shared user delete the album', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.delete(AuthFactory.create(owner), album.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('should let the owner delete an album', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await sut.delete(AuthFactory.create(owner), album.id);

      expect(mocks.album.delete).toHaveBeenCalledTimes(1);
      expect(mocks.album.delete).toHaveBeenCalledWith(album.id);
    });
  });

  describe('addUsers', () => {
    it('should throw an error if the auth user is not the owner', async () => {
      const album = AlbumFactory.create();
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.addUsers(AuthFactory.create(user), album.id, { albumUsers: [{ userId: newUuid() }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should throw an error if the userId is already added', async () => {
      const userId = newUuid();
      const album = AlbumFactory.from().albumUser({ userId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      await expect(
        sut.addUsers(AuthFactory.create(owner), album.id, { albumUsers: [{ userId }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.user.get).not.toHaveBeenCalled();
    });

    it('should throw an error if the userId does not exist', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(void 0);
      await expect(
        sut.addUsers(AuthFactory.create(owner), album.id, { albumUsers: [{ userId: 'unknown-user' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.user.get).toHaveBeenCalledWith('unknown-user', {});
    });

    it('should throw an error if the userId is the ownerId', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      await expect(
        sut.addUsers(AuthFactory.create(owner), album.id, {
          albumUsers: [{ userId: owner.id }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.user.get).not.toHaveBeenCalled();
    });

    it('should add valid shared users', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.update.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.albumUser.create.mockResolvedValue(AlbumUserFactory.from().album(album).user(user).build());

      await sut.addUsers(AuthFactory.create(owner), album.id, { albumUsers: [{ userId: user.id }] });

      expect(mocks.albumUser.create).toHaveBeenCalledWith({
        userId: user.id,
        albumId: album.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: user.id,
        senderName: owner.name,
      });
    });
  });

  describe('removeUser', () => {
    it('should require a valid album id', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-1']));
      mocks.album.getById.mockResolvedValue(void 0);
      await expect(sut.removeUser(AuthFactory.create(), 'album-1', 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should remove a shared user from an owned album', async () => {
      const userId = newUuid();
      const album = AlbumFactory.from().albumUser({ userId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await expect(sut.removeUser(AuthFactory.create(owner), album.id, userId)).resolves.toBeUndefined();

      expect(mocks.albumUser.delete).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId });
      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, owner.id);
    });

    it('should prevent removing a shared user from a not-owned album (shared with auth user)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user1.id }).albumUser({ userId: user2.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.removeUser(AuthFactory.create(user1), album.id, user2.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.albumUser.delete).not.toHaveBeenCalled();
      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(user1.id, new Set([album.id]));
    });

    it('should allow a shared user to remove themselves', async () => {
      const user1 = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user1.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await sut.removeUser(AuthFactory.create(user1), album.id, user1.id);

      expect(mocks.albumUser.delete).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId: user1.id });
    });

    it('should allow a shared user to remove themselves using "me"', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await sut.removeUser(AuthFactory.create(user), album.id, 'me');

      expect(mocks.albumUser.delete).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId: user.id });
    });

    it('should not allow the owner to be removed', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.removeUser(AuthFactory.create(owner), album.id, owner.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should throw an error for a user not in the album', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.removeUser(AuthFactory.create(owner), album.id, 'user-3')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.album.update).not.toHaveBeenCalled();
    });
  });

  describe('updateUser', () => {
    it('should update user role', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.albumUser.update.mockResolvedValue();

      await sut.updateUser(AuthFactory.create(owner), album.id, user.id, { role: AlbumUserRole.Viewer });

      expect(mocks.albumUser.update).toHaveBeenCalledWith(
        { albumId: album.id, userId: user.id },
        { role: AlbumUserRole.Viewer },
      );
    });
  });

  describe('getAlbumInfo', () => {
    it('should get a shared album', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      await sut.get(AuthFactory.create(owner), album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, owner.id);
      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([album.id]));
    });

    it('should get a shared album via a shared link', async () => {
      const album = AlbumFactory.from().albumUser().build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      const auth = AuthFactory.from().sharedLink().build();
      await sut.get(auth, album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, auth.user.id);
      expect(mocks.access.album.checkSharedLinkAccess).toHaveBeenCalledWith(auth.sharedLink!.id, new Set([album.id]));
    });

    it('should get a shared album via shared with user', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      await sut.get(AuthFactory.create(user), album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, user.id);
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalledWith(
        user.id,
        new Set([album.id]),
        AlbumUserRole.Viewer,
      );
    });

    it('should throw an error for no access', async () => {
      const auth = AuthFactory.create();
      await expect(sut.get(auth, 'album-123')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set(['album-123']));
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalledWith(
        auth.user.id,
        new Set(['album-123']),
        AlbumUserRole.Viewer,
      );
    });

    it('returns search results for smart album when fetching by id', async () => {
      const personId = newUuid();
      const album = AlbumFactory.from()
        .kind(AlbumKind.Smart)
        .filter({ personIds: [personId] })
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const auth = AuthFactory.create(owner);
      const asset = AssetFactory.create({ ownerId: owner.id });

      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);
      mocks.search.searchMetadata.mockResolvedValue({
        items: [asset],
        hasNextPage: false,
      } as any);

      const result = await sut.get(auth, album.id);

      expect(mocks.search.searchMetadata).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userIds: [owner.id], personIds: [personId] }),
      );
      expect(result.assetCount).toBe(1);
    });

    it('returns most recent matching asset as thumbnail for smart album', async () => {
      const album = AlbumFactory.from()
        .kind(AlbumKind.Smart)
        .filter({ personIds: [newUuid()] })
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const auth = AuthFactory.create(owner);
      const recent = AssetFactory.create({ ownerId: owner.id });

      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);
      mocks.search.searchMetadata.mockResolvedValue({ items: [recent], hasNextPage: false } as any);

      const result = await sut.get(auth, album.id);
      expect(result.albumThumbnailAssetId).toEqual(recent.id);
    });
  });

  describe('addAssets', () => {
    it('should allow the owner to add assets', async () => {
      const owner = UserFactory.create({ isAdmin: true });
      const album = AlbumFactory.from().owner(owner).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset1.id, asset2.id, asset3.id] }),
      ).resolves.toEqual([
        { success: true, id: asset1.id },
        { success: true, id: asset2.id },
        { success: true, id: asset3.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(album.id, [asset1.id, asset2.id, asset3.id]);
    });

    it('should not set the thumbnail if the album has one already', async () => {
      const [asset1, asset2] = [AssetFactory.create(), AssetFactory.create()];
      const album = AlbumFactory.from({ albumThumbnailAssetId: asset1.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset2.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset2.id] })).resolves.toEqual([
        { success: true, id: asset2.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalled();
    });

    it('should allow a shared user to add assets', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Editor }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssets(AuthFactory.create(user), album.id, { ids: [asset1.id, asset2.id, asset3.id] }),
      ).resolves.toEqual([
        { success: true, id: asset1.id },
        { success: true, id: asset2.id },
        { success: true, id: asset3.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        user.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(album.id, [asset1.id, asset2.id, asset3.id]);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album.id,
        recipientId: owner.id,
      });
    });

    it('should not allow a shared user with viewer access to add assets', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Viewer }).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(
        sut.addAssets(AuthFactory.create(user), album.id, { ids: [asset1.id, asset2.id, asset3.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow adding assets shared via partner sharing', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const asset = AssetFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: true, id: asset.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset.id,
        },
        owner.id,
      );
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]));
    });

    it('should skip duplicate assets', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set([asset.id]));

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: false, id: asset.id, error: BulkIdErrorReason.DUPLICATE },
      ]);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should skip assets not shared with user', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: false, id: asset.id, error: BulkIdErrorReason.NO_PERMISSION },
      ]);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]), false);
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]));
    });

    it('should not allow unauthorized access to the album', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.create();
      const asset = AssetFactory.create({ ownerId: user.id });
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.addAssets(AuthFactory.create(user), album.id, { ids: [asset.id] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalled();
    });

    it('should not allow unauthorized shared link access to the album', async () => {
      const album = AlbumFactory.create();
      const asset = AssetFactory.create();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(
        sut.addAssets(AuthFactory.from().sharedLink({ allowUpload: true }).build(), album.id, { ids: [asset.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.album.checkSharedLinkAccess).toHaveBeenCalled();
    });

    it('should reject adding assets to a smart album', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);
      const album = AlbumFactory.from().owner(owner).kind(AlbumKind.Smart).filter({}).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));

      await expect(sut.addAssets(auth, album.id, { ids: [newUuid()] })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('addAssetsToAlbums', () => {
    it('should allow the owner to add assets', async () => {
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
    });

    it('should not set the thumbnail if the album has one already', async () => {
      const asset = AssetFactory.create();
      const album1 = AlbumFactory.from({ albumThumbnailAssetId: asset.id }).build();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.from({ albumThumbnailAssetId: asset.id }).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset.id,
        },
        owner.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
    });

    it('should allow a shared user to add assets', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Editor }).build();
      const { user: owner1 } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Editor }).build();
      const { user: owner2 } = album2.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(user), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        user.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        user.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album1.id,
        recipientId: owner1.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album2.id,
        recipientId: owner2.id,
      });
    });

    it('should not allow a shared user with viewer access to add assets', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Viewer }).build();
      const album2 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Viewer }).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(user), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow adding assets shared via partner sharing', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
      ];
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(
        owner.id,
        new Set([asset1.id, asset2.id, asset3.id]),
      );
    });

    it('should skip some duplicate assets', async () => {
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();

      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getAssetIds
        .mockResolvedValueOnce(new Set([asset1.id, asset2.id, asset3.id]))
        .mockResolvedValueOnce(new Set());
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(1);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
    });

    it('should skip all duplicate assets', async () => {
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      mocks.access.album.checkOwnerAccess
        .mockResolvedValueOnce(new Set([album1.id]))
        .mockResolvedValueOnce(new Set([album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.DUPLICATE,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
    });

    it('should skip assets not shared with user', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
      ];
      mocks.access.album.checkSharedAlbumAccess
        .mockResolvedValueOnce(new Set([album1.id]))
        .mockResolvedValueOnce(new Set([album2.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        owner.id,
        new Set([asset1.id, asset2.id, asset3.id]),
        false,
      );
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(
        owner.id,
        new Set([asset1.id, asset2.id, asset3.id]),
      );
    });

    it('should not allow unauthorized access to the albums', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.create();
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(user), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalled();
    });

    it('should not allow unauthorized shared link access to the album', async () => {
      const album1 = AlbumFactory.create();
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.from().sharedLink({ allowUpload: true }).build(), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.access.album.checkSharedLinkAccess).toHaveBeenCalled();
    });
  });

  describe('removeAssets', () => {
    it('should allow the owner to remove assets', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset.id]));

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: true, id: asset.id },
      ]);

      expect(mocks.album.removeAssetIds).toHaveBeenCalledWith(album.id, [asset.id]);
    });

    it('should skip assets not in the album', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set());

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: false, id: asset.id, error: BulkIdErrorReason.NOT_FOUND },
      ]);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow owner to remove all assets from the album', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset.id]));

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: true, id: asset.id },
      ]);
    });

    it('should reset the thumbnail if it is removed', async () => {
      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();
      const album = AlbumFactory.from({ albumThumbnailAssetId: asset1.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset1.id, asset2.id]));

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset1.id] })).resolves.toEqual([
        { success: true, id: asset1.id },
      ]);

      expect(mocks.album.updateThumbnails).toHaveBeenCalled();
    });

    it('should reject removing assets from a smart album', async () => {
      const owner = UserFactory.create();
      const auth = AuthFactory.create(owner);
      const album = AlbumFactory.from().owner(owner).kind(AlbumKind.Smart).filter({}).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));

      await expect(sut.removeAssets(auth, album.id, { ids: [newUuid()] })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // // it('removes assets from shared album (shared with auth user)', async () => {
  // //   const albumEntity = _getOwnedSharedAlbum();
  // //   albumRepositoryMock.get.mockImplementation(() => Promise.resolve<AlbumEntity>(albumEntity));
  // //   albumRepositoryMock.removeAssets.mockImplementation(() => Promise.resolve<AlbumEntity>(albumEntity));

  // //   await expect(
  // //     sut.removeAssetsFromAlbum(
  // //       auth,
  // //       {
  // //         ids: ['1'],
  // //       },
  // //       albumEntity.id,
  // //     ),
  // //   ).resolves.toBeUndefined();
  // //   expect(albumRepositoryMock.removeAssets).toHaveBeenCalledTimes(1);
  // //   expect(albumRepositoryMock.removeAssets).toHaveBeenCalledWith(albumEntity, {
  // //     ids: ['1'],
  // //   });
  // // });

  // it('prevents removing assets from a not owned / shared album', async () => {
  //   const albumEntity = _getNotOwnedNotSharedAlbum();

  //   const albumResponse: AddAssetsResponseDto = {
  //     alreadyInAlbum: [],
  //     successfullyAdded: 1,
  //   };

  //   const albumId = albumEntity.id;

  //   albumRepositoryMock.get.mockImplementation(() => Promise.resolve<AlbumEntity>(albumEntity));
  //   albumRepositoryMock.addAssets.mockImplementation(() => Promise.resolve<AddAssetsResponseDto>(albumResponse));

  //   await expect(sut.removeAssets(auth, albumId, { ids: ['1'] })).rejects.toBeInstanceOf(ForbiddenException);
  // });

  describe('invalidateSmartAlbumsForAsset', () => {
    it('marks matching smart albums as invalidated', async () => {
      const ownerId = newUuid();
      const assetId = newUuid();
      const matchingAlbumId = newUuid();
      const nonMatchingAlbumId = newUuid();
      mocks.album.getSmartAlbumsForOwner.mockResolvedValue([
        { id: matchingAlbumId, filter: { isFavorite: true }, cachedThumbnailAssetId: null },
        { id: nonMatchingAlbumId, filter: { rating: 5 }, cachedThumbnailAssetId: null },
      ] as any);
      mocks.album.getSmartAlbumsWithCachedThumbnail.mockResolvedValue([]);
      // First album matches (returns 1 item), second doesn't (returns 0).
      mocks.search.searchMetadata
        .mockResolvedValueOnce({ items: [{ id: assetId }] as any, hasNextPage: false })
        .mockResolvedValueOnce({ items: [] as any, hasNextPage: false });

      await sut.invalidateSmartAlbumsForAsset(ownerId, assetId);

      expect(mocks.album.markCacheInvalidated).toHaveBeenCalledTimes(1);
      const [ids] = mocks.album.markCacheInvalidated.mock.calls[0];
      expect(ids).toEqual([matchingAlbumId]);
    });

    it('also invalidates smart albums whose cached thumbnail is the asset', async () => {
      const ownerId = newUuid();
      const assetId = newUuid();
      const thumbAlbumId = newUuid();
      mocks.album.getSmartAlbumsForOwner.mockResolvedValue([]);
      mocks.album.getSmartAlbumsWithCachedThumbnail.mockResolvedValue([thumbAlbumId]);

      await sut.invalidateSmartAlbumsForAsset(ownerId, assetId);

      expect(mocks.album.markCacheInvalidated).toHaveBeenCalledTimes(1);
      const [ids] = mocks.album.markCacheInvalidated.mock.calls[0];
      expect(ids).toEqual([thumbAlbumId]);
    });

    it('does nothing when no smart albums match', async () => {
      mocks.album.getSmartAlbumsForOwner.mockResolvedValue([]);
      mocks.album.getSmartAlbumsWithCachedThumbnail.mockResolvedValue([]);

      await sut.invalidateSmartAlbumsForAsset(newUuid(), newUuid());

      // mark gets called with an empty array; the repository method is a no-op in that case.
      expect(mocks.album.markCacheInvalidated).toHaveBeenCalledWith([], expect.any(Date));
    });
  });

  describe('invalidateSmartAlbumsForPersonMerge', () => {
    it('bumps cacheInvalidatedAt on smart albums that filter on either merged person id', async () => {
      const ownerId = newUuid();
      const sourceId = newUuid();
      const targetId = newUuid();
      const matchingAlbumId = newUuid();
      mocks.album.getSmartAlbumsForOwnerByPersonIds.mockResolvedValue([{ id: matchingAlbumId }]);

      await sut.invalidateSmartAlbumsForPersonMerge(ownerId, [sourceId, targetId]);

      expect(mocks.album.getSmartAlbumsForOwnerByPersonIds).toHaveBeenCalledWith(ownerId, [sourceId, targetId]);
      expect(mocks.album.markCacheInvalidated).toHaveBeenCalledWith([matchingAlbumId], expect.any(Date));
    });

    it('is a no-op when no smart albums reference the merged persons', async () => {
      mocks.album.getSmartAlbumsForOwnerByPersonIds.mockResolvedValue([]);

      await sut.invalidateSmartAlbumsForPersonMerge(newUuid(), [newUuid(), newUuid()]);

      expect(mocks.album.markCacheInvalidated).not.toHaveBeenCalled();
    });

    it('is a no-op when no person ids are supplied', async () => {
      await sut.invalidateSmartAlbumsForPersonMerge(newUuid(), []);

      expect(mocks.album.getSmartAlbumsForOwnerByPersonIds).not.toHaveBeenCalled();
      expect(mocks.album.markCacheInvalidated).not.toHaveBeenCalled();
    });
  });

  describe('invalidateAllSmartAlbumsByPersonFilter', () => {
    it('delegates to the repository to bump cache for all person-filtered smart albums', async () => {
      await sut.invalidateAllSmartAlbumsByPersonFilter();

      expect(mocks.album.markAllSmartAlbumsWithPersonFilterInvalidated).toHaveBeenCalledTimes(1);
      expect(mocks.album.markAllSmartAlbumsWithPersonFilterInvalidated).toHaveBeenCalledWith(expect.any(Date));
    });

    it('safe variant swallows repository errors and logs', async () => {
      mocks.album.markAllSmartAlbumsWithPersonFilterInvalidated.mockRejectedValueOnce(new Error('boom'));

      await expect(sut.invalidateAllSmartAlbumsByPersonFilterSafe()).resolves.toBeUndefined();
    });
  });

  describe('prunePersonIdsFromSmartAlbums', () => {
    it('delegates to the repository and is a no-op when no ids are supplied', async () => {
      await sut.prunePersonIdsFromSmartAlbums([]);
      expect(mocks.album.prunePersonIdsFromSmartAlbums).not.toHaveBeenCalled();
    });

    it('calls the repository with the deleted person ids', async () => {
      const ids = [newUuid(), newUuid()];
      mocks.album.prunePersonIdsFromSmartAlbums.mockResolvedValue([newUuid()]);

      await sut.prunePersonIdsFromSmartAlbums(ids);

      expect(mocks.album.prunePersonIdsFromSmartAlbums).toHaveBeenCalledWith(ids);
    });

    it('returns silently when no albums were affected', async () => {
      mocks.album.prunePersonIdsFromSmartAlbums.mockResolvedValue([]);
      await expect(sut.prunePersonIdsFromSmartAlbums([newUuid()])).resolves.toBeUndefined();
    });

    it('safe variant swallows repository errors', async () => {
      mocks.album.prunePersonIdsFromSmartAlbums.mockRejectedValueOnce(new Error('boom'));
      await expect(sut.prunePersonIdsFromSmartAlbumsSafe([newUuid()])).resolves.toBeUndefined();
    });

    it('safe variant is a no-op when no ids are supplied', async () => {
      await sut.prunePersonIdsFromSmartAlbumsSafe([]);
      expect(mocks.album.prunePersonIdsFromSmartAlbums).not.toHaveBeenCalled();
    });
  });

  describe('pruneTagIdsFromSmartAlbums', () => {
    it('delegates to the repository and is a no-op when no ids are supplied', async () => {
      await sut.pruneTagIdsFromSmartAlbums([]);
      expect(mocks.album.pruneTagIdsFromSmartAlbums).not.toHaveBeenCalled();
    });

    it('calls the repository with the deleted tag ids', async () => {
      const ids = [newUuid()];
      mocks.album.pruneTagIdsFromSmartAlbums.mockResolvedValue([newUuid()]);

      await sut.pruneTagIdsFromSmartAlbums(ids);

      expect(mocks.album.pruneTagIdsFromSmartAlbums).toHaveBeenCalledWith(ids);
    });

    it('safe variant swallows repository errors', async () => {
      mocks.album.pruneTagIdsFromSmartAlbums.mockRejectedValueOnce(new Error('boom'));
      await expect(sut.pruneTagIdsFromSmartAlbumsSafe([newUuid()])).resolves.toBeUndefined();
    });

    it('safe variant is a no-op when no ids are supplied', async () => {
      await sut.pruneTagIdsFromSmartAlbumsSafe([]);
      expect(mocks.album.pruneTagIdsFromSmartAlbums).not.toHaveBeenCalled();
    });
  });
});
